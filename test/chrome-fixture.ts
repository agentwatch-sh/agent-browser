// A local stand-in for Google's signed Chrome repository (board ab-v16.94.3): a test key made in a temp GNUPGHOME, an
// InRelease that it clear-signs, a Packages file and a .deb with a data.tar.xz under opt/google/chrome/. The tests and
// the live check point the service at it through a test-only source (a local folder, never a URL): nothing is
// downloaded from Google or from anywhere else. close() ends the temp GNUPGHOME's gpg-agent and removes the folder.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import type { ChromeSource } from "../src/service/unit/google-chrome.ts";
import { GOOGLE_SOURCE } from "../src/service/unit/google-chrome.ts";

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** One ar member header (60 bytes) and its data, padded to an even size. */
function arMember(name: string, data: Buffer): Buffer {
  const h = `${name}/`.padEnd(16) + "0".padEnd(12) + "0".padEnd(6) + "0".padEnd(6) + "100644".padEnd(8) + String(data.length).padEnd(10) + "`\n";
  return Buffer.concat([Buffer.from(h, "latin1"), data, data.length & 1 ? Buffer.from("\n") : Buffer.alloc(0)]);
}
export const arArchive = (members: [string, Buffer][]) => Buffer.concat([Buffer.from("!<arch>\n"), ...members.map(([n, d]) => arMember(n, d))]);

/** One ustar header for a crafted member (the tests of the tar rules). */
export function tarHeader(o: { name: string; type?: string; size?: number; mode?: number; linkname?: string; prefix?: string }): Buffer {
  const h = Buffer.alloc(512);
  h.write(o.name, 0, 100, "utf8");
  h.write((o.mode ?? 0o644).toString(8).padStart(7, "0") + "\0", 100, "latin1");
  h.write("0000000\0", 108, "latin1"); h.write("0000000\0", 116, "latin1");
  h.write((o.size ?? 0).toString(8).padStart(11, "0") + "\0", 124, "latin1");
  h.write("00000000000\0", 136, "latin1");
  h.write("        ", 148, "latin1");
  h.write(o.type ?? "0", 156, "latin1");
  if (o.linkname) h.write(o.linkname, 157, 100, "utf8");
  h.write("ustar\0", 257, "latin1"); h.write("00", 263, "latin1");
  if (o.prefix) h.write(o.prefix, 345, 155, "utf8");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
  return h;
}
/** A tar of crafted members: [header options, data]. */
export function tarOf(members: [Parameters<typeof tarHeader>[0], Buffer?][]): Buffer {
  const parts: Buffer[] = [];
  for (const [o, data] of members) {
    const d = data ?? Buffer.alloc(0);
    parts.push(tarHeader({ ...o, size: o.size ?? d.length }), d, Buffer.alloc((512 - (d.length % 512)) % 512));
  }
  return Buffer.concat([...parts, Buffer.alloc(1024)]);
}

export type ChromeRepo = {
  dir: string;
  /** The repository folder (dists/ and pool/). */
  repo: string;
  keyFile: string;
  fingerprint: string;
  source: ChromeSource;
  version: string;
  /** The .deb's path in the pool, its SHA-256 and size. */
  deb: string;
  close: () => void;
  /** Sign `text` as an InRelease with this repo's key. */
  sign: (text: string) => Buffer;
};

/**
 * Make the repository in a temp folder. `chrome`: the text of opt/google/chrome/chrome (a script that answers
 * --version); `version`: the package's version; `gz`: list Packages.gz in place of Packages.
 */
export function makeChromeRepo(o: { version?: string; chrome?: string; gz?: boolean; origin?: string; extraPackages?: string } = {}): ChromeRepo {
  const version = o.version ?? "158.0.7100.1-1";
  const dir = mkdtempSync(join(tmpdir(), "ab-chrome-repo-"));
  const home = join(dir, "gnupg");
  mkdirSync(home, { mode: 0o700 });
  const env = { ...process.env, GNUPGHOME: home, LC_ALL: "C" };
  const gpg = (args: string[], input?: string) => execFileSync("gpg", ["--homedir", home, "--batch", "--no-tty", "--pinentry-mode", "loopback", "--passphrase", "", ...args], { env, input, stdio: ["pipe", "pipe", "pipe"] });
  const close = () => {
    try { execFileSync("gpgconf", ["--homedir", home, "--kill", "all"], { env, stdio: "ignore" }); } catch {}
    try { execFileSync("gpgconf", ["--homedir", home, "--remove-socketdir"], { env, stdio: "ignore" }); } catch {}
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    gpg(["--quick-gen-key", "agent-browser test key <test@example.invalid>", "ed25519", "sign", "never"]);
    const fingerprint = /^fpr:+([0-9A-F]{40}):/m.exec(gpg(["--with-colons", "--list-keys"]).toString())![1];
    const keyFile = join(dir, "test-key.asc");
    writeFileSync(keyFile, gpg(["--armor", "--export", fingerprint]));
    const sign = (text: string) => {
      const p = join(dir, "Release.tmp");
      writeFileSync(p, text);
      const out = gpg(["--digest-algo", "SHA256", "--local-user", fingerprint, "--clearsign", "--output", "-", p]);
      rmSync(p);
      return out;
    };
    // The package: data.tar.xz with opt/google/chrome/ and members outside it; a control part with a postinst.
    const root = join(dir, "root");
    const chromeDir = join(root, "opt", "google", "chrome");
    mkdirSync(chromeDir, { recursive: true });
    writeFileSync(join(chromeDir, "chrome"), o.chrome ?? `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Google Chrome ${version.split("-")[0]} "; exit 0; fi\nexit 0\n`);
    chmodSync(join(chromeDir, "chrome"), 0o755);
    writeFileSync(join(chromeDir, "resources.pak"), "pak");
    chmodSync(join(chromeDir, "resources.pak"), 0o4755); // a setuid bit never survives (mode & 0o755)
    symlinkSync("chrome", join(chromeDir, "google-chrome"));
    mkdirSync(join(root, "usr", "share", "doc", "google-chrome-stable"), { recursive: true });
    writeFileSync(join(root, "usr", "share", "doc", "google-chrome-stable", "copyright"), "outside");
    const marker = join(dir, "postinst-ran");
    const control = join(dir, "control");
    mkdirSync(control);
    writeFileSync(join(control, "control"), `Package: google-chrome-stable\nVersion: ${version}\nArchitecture: amd64\n`);
    writeFileSync(join(control, "postinst"), `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(join(control, "postinst"), 0o755);
    execFileSync("tar", ["--format=gnu", "--owner=0", "--group=0", "-cf", join(dir, "data.tar"), "-C", root, "./opt", "./usr"]);
    execFileSync("tar", ["--format=gnu", "-cf", join(dir, "control.tar"), "-C", control, "./control", "./postinst"]);
    const xz = (p: string) => execFileSync("xz", ["-c", "-T1", p]);
    const debBytes = arArchive([["debian-binary", Buffer.from("2.0\n")], ["control.tar.xz", xz(join(dir, "control.tar"))], ["data.tar.xz", xz(join(dir, "data.tar"))]]);
    const repo = join(dir, "repo");
    const filename = `pool/main/g/google-chrome-stable/google-chrome-stable_${version}_amd64.deb`;
    const deb = join(repo, filename);
    mkdirSync(dirname(deb), { recursive: true });
    writeFileSync(deb, debBytes);
    const packages = `Package: google-chrome-stable\nVersion: ${version}\nArchitecture: amd64\nFilename: ${filename}\nSize: ${debBytes.length}\nSHA256: ${sha256(debBytes)}\nDescription: The web browser from Google\n continuation line\n\n${o.extraPackages ?? ""}`;
    const bin = join(repo, "dists", "stable", "main", "binary-amd64");
    mkdirSync(bin, { recursive: true });
    const listed = o.gz ? gzipSync(Buffer.from(packages)) : Buffer.from(packages);
    writeFileSync(join(bin, o.gz ? "Packages.gz" : "Packages"), listed);
    const release = `Origin: ${o.origin ?? "Google LLC"}\nLabel: Google\nSuite: stable\nCodename: stable\nArchitectures: amd64\nComponents: main\nSHA256:\n ${sha256(listed)} ${listed.length} main/binary-amd64/${o.gz ? "Packages.gz" : "Packages"}\n`;
    writeFileSync(join(repo, "dists", "stable", "InRelease"), sign(release));
    rmSync(root, { recursive: true }); rmSync(control, { recursive: true });
    rmSync(join(dir, "data.tar")); rmSync(join(dir, "control.tar"));
    return { dir, repo, keyFile, fingerprint, version, deb, close, sign, source: { ...GOOGLE_SOURCE, repo, keyFile, fingerprints: [fingerprint] } };
  } catch (e) { close(); throw e; }
}

/** The bytes of a file. */
export const bytes = (p: string) => readFileSync(p);
