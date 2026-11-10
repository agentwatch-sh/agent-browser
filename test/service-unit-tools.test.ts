// Google Chrome stable in the service's tools folder (the self-contained design, section 5.1, the row "Google Chrome
// stable"; board ab-v16.94.3): the signed index (gpgv against the pinned key), the Packages file and the .deb by their
// SHA-256 and size, the unpack of opt/google/chrome/ only, the version check, no downgrade, the lock and the prune. The
// tests use a local stand-in for Google's repository (test/chrome-fixture.ts) with a test key in a temp GNUPGHOME and the
// box's real gpgv and xz; nothing is downloaded. One test checks that Google's index URL and the pinned key are the
// defaults.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChromeTar, memberParts, ToolsError, looseRealpath } from "../src/service/unit/deb.ts";
import { checkClearsigned, dearmor, entryOk, fetchFor, flockLocker, folderFetch, GOOGLE_SOURCE, GoogleChromeTools, httpsFetch, KEY_FILE, parseInreleaseSha256, parsePackages, primaryFingerprint, UNKNOWN_KEY, verifyInrelease, type Run } from "../src/service/unit/google-chrome.ts";
import { newer, pickVersion, versionKey } from "../src/service/unit/versions.ts";
import { makeChromeRepo, tarOf } from "./chrome-fixture.ts";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

test("the defaults are Google's signed index and the pinned key: the repository URL, the suite, the package, the Origin, and the key file next to the code, whose primary fingerprint is the pinned one", () => {
  assert.equal(GOOGLE_SOURCE.repo, "https://dl.google.com/linux/chrome/deb");
  assert.deepEqual([GOOGLE_SOURCE.suite, GOOGLE_SOURCE.package, GOOGLE_SOURCE.arch, GOOGLE_SOURCE.origin], ["stable", "google-chrome-stable", "amd64", "Google LLC"]);
  assert.deepEqual([...GOOGLE_SOURCE.fingerprints], ["EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796"]);
  assert.equal(GOOGLE_SOURCE.keyFile, KEY_FILE);
  assert.ok(KEY_FILE.endsWith("src/service/unit/google-linux-signing-key.asc"));
  const key = dearmor(readFileSync(KEY_FILE, "ascii"));
  assert.equal(primaryFingerprint(key), "EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796", "the key file holds the pinned primary key");
  assert.equal(sha(readFileSync(KEY_FILE)), "54dea5f6c2a26091578cf52a999cebc6b64df478d37ad4dce96376b711e3b27c", "the copy of agentwatch's tools/keys/google-linux-signing-key.asc");
  const t = new GoogleChromeTools({ tools: "/nonexistent-tools" });
  assert.equal(t.source, GOOGLE_SOURCE, "a tools folder with no source reads Google's index");
  assert.equal(fetchFor(GOOGLE_SOURCE), httpsFetch, "with the https fetch");
  assert.equal(Object.isFrozen(GOOGLE_SOURCE), true);
});

test("versions: a.b.c.d-r of ASCII digits only, ordered by their numbers", () => {
  assert.deepEqual(versionKey("157.0.7000.1-1"), [157n, 0n, 7000n, 1n, 1n]);
  for (const bad of ["157.0.7000.1", "157.0.7000.1-1a", "١٥٧.0.7000.1-1", "157.0.7000.1-1 ", "1.2.3.4-" + "9".repeat(20)]) assert.equal(versionKey(bad), null, bad);
  assert.equal(newer("157.0.7000.10-1", "157.0.7000.9-1"), true);
  assert.equal(newer("157.0.7000.9-2", "157.0.7000.9-1"), true);
  assert.equal(newer("x", "157.0.7000.9-1"), false);
  assert.equal(pickVersion(["157.0.1.1-1", "158.0.1.1-1", "159.0.1.1-1", "junk"], new Set(["159.0.1.1-1"])), "158.0.1.1-1");
  assert.equal(pickVersion(["157.0.1.1-1", "158.0.1.1-1"], new Set(), "157.5.0.0-1"), "157.0.1.1-1");
});

test("the index texts: the SHA256 section of the verified text, the newest google-chrome-stable of a Packages text, and a malformed entry is skipped", () => {
  const rel = `Origin: Google LLC\nSuite: stable\nMD5Sum:\n ${"b".repeat(32)} 10 main/binary-amd64/Packages\nSHA256:\n ${"A".repeat(64)} 123 main/binary-amd64/Packages\n ${"c".repeat(64)} ²3 main/binary-amd64/Packages.gz\n bad line\n`;
  assert.deepEqual([...parseInreleaseSha256(rel)], [["main/binary-amd64/Packages", ["a".repeat(64), 123]]]);
  const entry = (v: string, extra = "") => `Package: google-chrome-stable\nVersion: ${v}\nArchitecture: amd64\nFilename: pool/main/g/google-chrome-stable/google-chrome-stable_${v}_amd64.deb\nSize: 100\nSHA256: ${"d".repeat(64)}\n${extra}\n`;
  const text = entry("157.0.7000.1-1") + entry("158.0.7100.1-1") + entry("159.0.7200.1-1", "Architecture: arm64\n").replace("Architecture: amd64\n", "") + entry("160.0.1.1-1").replace("Size: 100", "Size: ١٠٠") + entry("161.0.1.1-1").replace("pool/", "../pool/") + `Package: google-chrome-beta\nVersion: 170.0.0.1-1\nFilename: x.deb\nSize: 1\nSHA256: ${"e".repeat(64)}\n`;
  assert.equal(parsePackages(text)!.version, "158.0.7100.1-1");
  assert.equal(entryOk({ version: "1.2.3.4-1", filename: "a/../b.deb", sha256: "f".repeat(64), size: 1 }), false);
});

test("the index must be one clear-signed message", () => {
  const ok = "-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\ntext\n-----BEGIN PGP SIGNATURE-----\n\nabc\n-----END PGP SIGNATURE-----\n";
  checkClearsigned(Buffer.from(ok));
  for (const bad of ["junk\n" + ok, ok + "more\n", ok + ok, ok.replace("-----BEGIN PGP SIGNATURE-----", "")]) assert.throws(() => checkClearsigned(Buffer.from(bad)), /not one clear-signed message/);
});

test("verify: only exit 0, a GOODSIG, no bad status and a VALIDSIG whose last field is a pinned primary fingerprint pass; NO_PUBKEY names the unknown key; gpgv runs with its own new home and never the user's", async () => {
  const dir = tmp("ab-gpgv-");
  try {
    const signed = join(dir, "InRelease"), out = join(dir, "out");
    writeFileSync(signed, "-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\nx\n-----BEGIN PGP SIGNATURE-----\n\nabc\n-----END PGP SIGNATURE-----\n");
    const pinned = "AAAA1BFD4F042F6DDDCCEC917721F63BD38B4796";
    const source = { ...GOOGLE_SOURCE, fingerprints: [pinned] };
    const valid = (fpr: string) => `[GNUPG:] VALIDSIG 1111 2026-11-10 1 0 4 0 22 8 01 ${fpr}`;
    const cases: [string, number, string | RegExp | null][] = [
      [`[GNUPG:] GOODSIG 1 x\n${valid(pinned)}\n`, 0, null],
      [`[GNUPG:] GOODSIG 1 x\n${valid("BBBB" + pinned.slice(4))}\n`, 0, /not signed by a pinned Google key/],
      [`[GNUPG:] NO_PUBKEY 1\n`, 2, UNKNOWN_KEY],
      [`[GNUPG:] GOODSIG 1 x\n[GNUPG:] EXPKEYSIG 1 x\n${valid(pinned)}\n`, 0, /\(EXPKEYSIG\)/],
      [`[GNUPG:] GOODSIG 1 x\n${valid(pinned)}\n`, 1, /gpgv exit status 1/],
      [`${valid(pinned)}\n`, 0, /no good signature/],
    ];
    for (const [stdout, code, want] of cases) {
      let seen: { argv: string[]; env: Record<string, string> } | null = null;
      const run: Run = async (argv, env) => { seen = { argv, env }; writeFileSync(out, "Origin: Google LLC\nSuite: stable\n"); return { code, stdout, stderr: "" }; };
      const p = verifyInrelease(signed, join(dir, "keyring"), out, { run, gpgv: "/usr/bin/gpgv", source });
      if (want === null) assert.match(await p, /Origin: Google LLC/);
      else await assert.rejects(p, (e: Error) => e instanceof ToolsError && (typeof want === "string" ? e.message === want : want.test(e.message)));
      const s = seen as unknown as { argv: string[]; env: Record<string, string> };
      assert.equal(s.argv[1], "--homedir");
      assert.equal(s.env.GNUPGHOME, s.argv[2], "GNUPGHOME is the new home");
      assert.ok(s.argv[2].startsWith(dir), "in the work folder, not ~/.gnupg");
      assert.equal(existsSync(s.argv[2]), false, "the home goes after the check");
    }
    const wrongOrigin: Run = async () => { writeFileSync(out, "Origin: Evil\nSuite: stable\n"); return { code: 0, stdout: `[GNUPG:] GOODSIG 1 x\n${valid(pinned)}\n`, stderr: "" }; };
    await assert.rejects(verifyInrelease(signed, join(dir, "k"), out, { run: wrongOrigin, gpgv: "gpgv", source }), /the wrong Origin/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the signed index of the local stand-in, with the box's real gpgv: the newest entry; an index of another key (not pinned) and a Packages file that does not match its signed hash are refused", { timeout: 60_000 }, async () => {
  const repo = makeChromeRepo();
  const other = makeChromeRepo({ version: "159.0.7200.1-1" });
  const tools = tmp("ab-tools-");
  try {
    const t = new GoogleChromeTools({ tools, source: repo.source });
    const e = await t.latestEntry();
    assert.equal(e.version, repo.version);
    assert.equal(e.filename, `pool/main/g/google-chrome-stable/google-chrome-stable_${repo.version}_amd64.deb`);
    // The other repository's index, checked against this repository's key: gpgv has no key for it.
    const wrongKey = new GoogleChromeTools({ tools, source: { ...other.source, keyFile: repo.keyFile, fingerprints: [repo.fingerprint] } });
    await assert.rejects(wrongKey.latestEntry(), (x: Error) => x.message === UNKNOWN_KEY);
    // Its own key, but a fingerprint that is not pinned.
    const notPinned = new GoogleChromeTools({ tools, source: { ...other.source, fingerprints: [repo.fingerprint] } });
    await assert.rejects(notPinned.latestEntry(), /not signed by a pinned Google key/);
    // A Packages file changed after the signature.
    const pk = join(repo.repo, "dists", "stable", "main", "binary-amd64", "Packages");
    writeFileSync(pk, readFileSync(pk, "utf8").replace("Description: The web browser", "Description: The web BROWSER"));
    await assert.rejects(t.latestEntry(), /Google's Chrome package list failed its SHA-256 check/);
    assert.deepEqual(readdirSync(join(tools, "google-chrome")), [], "no work folder stays");
  } finally { repo.close(); other.close(); rmSync(tools, { recursive: true, force: true }); }
});

test("an index that lists only Packages.gz is read through its gzip; a test source is a local folder and its fetch never leaves it; the https fetch takes https only", { timeout: 60_000 }, async () => {
  const repo = makeChromeRepo({ gz: true });
  const tools = tmp("ab-tools-");
  try {
    assert.equal((await new GoogleChromeTools({ tools, source: repo.source }).latestEntry()).version, repo.version);
    await assert.rejects(folderFetch(repo.repo)("/etc/passwd", join(tools, "x"), 1000, 100), /outside its folder/);
    await assert.rejects(folderFetch(repo.repo)(`${repo.repo}/dists/stable/InRelease`, join(tools, "x"), 1000, 10), /more than the 10 bytes/);
    await assert.rejects(httpsFetch("http://dl.google.com/linux/chrome/deb/dists/stable/InRelease", join(tools, "x"), 1000, 10), /must use https/);
  } finally { repo.close(); rmSync(tools, { recursive: true, force: true }); }
});

test("the install: the .deb by its SHA-256 and size, only opt/google/chrome/ unpacked (mode & 0o755, its link inside), no maintainer script, the version check, then the move to <tools>/google-chrome/<version>; no downgrade and no second copy", { timeout: 60_000 }, async () => {
  const repo = makeChromeRepo();
  const tools = tmp("ab-tools-");
  try {
    const t = new GoogleChromeTools({ tools, source: repo.source });
    const copy = await t.ensure();
    assert.equal(copy.version, repo.version);
    assert.equal(copy.root, join(tools, "google-chrome", repo.version));
    assert.deepEqual(readdirSync(join(tools, "google-chrome")), [repo.version], "no work folder, no .deb left");
    assert.deepEqual(readdirSync(copy.root), ["opt"], "only opt/google/chrome");
    const chromeDir = join(copy.root, "opt", "google", "chrome");
    assert.deepEqual(readdirSync(chromeDir).sort(), ["chrome", "google-chrome", "resources.pak"]);
    assert.equal(statSync(join(chromeDir, "resources.pak")).mode & 0o7777, 0o755, "no setuid bit");
    assert.equal(readlinkSync(join(chromeDir, "google-chrome")), "chrome");
    assert.equal(existsSync(join(repo.dir, "postinst-ran")), false, "no maintainer script ran");
    assert.equal(t.newest()!.version, repo.version);
    assert.equal(lstatSync(join(tools, ".google-chrome.lock")).isFile(), true, "the install's own lock");
    const again = await t.ensure();
    assert.equal(again.version, repo.version);
    assert.deepEqual(readdirSync(join(tools, "google-chrome")), [repo.version], "no second copy");
    const older = makeChromeRepo({ version: "150.0.1.1-1" });
    try {
      const t2 = new GoogleChromeTools({ tools, source: older.source });
      assert.equal((await t2.ensure()).version, repo.version, "never a downgrade");
    } finally { older.close(); }
  } finally { repo.close(); rmSync(tools, { recursive: true, force: true }); }
});

test("a .deb that does not match its entry, a binary that does not answer its version, a malformed entry, too little disk space and root are refused, and leave no copy", { timeout: 60_000 }, async () => {
  const repo = makeChromeRepo();
  const tools = tmp("ab-tools-");
  try {
    const t = new GoogleChromeTools({ tools, source: repo.source });
    const e = await t.latestEntry();
    await assert.rejects(t.ensure({ ...e, sha256: "0".repeat(64) }), /the Google Chrome package failed its SHA-256 check/);
    await assert.rejects(t.ensure({ ...e, size: e.size + 1 }), /could not be downloaded|failed its size check/);
    await assert.rejects(t.ensure({ ...e, filename: "../x.deb" }), /the Google Chrome entry is malformed/);
    await assert.rejects(new GoogleChromeTools({ tools, source: repo.source, freeBytes: () => 1 }).ensure(e), /not enough free disk space/);
    await assert.rejects(new GoogleChromeTools({ tools, source: repo.source, uid: 0 }).ensure(e), /never written as root/);
    assert.deepEqual(readdirSync(join(tools, "google-chrome")), []);
    const liar = makeChromeRepo({ chrome: "#!/bin/sh\necho 'Chromium 1.2.3.4'\n" });
    const broken = makeChromeRepo({ chrome: "#!/bin/sh\necho 'cannot open shared object file' >&2\nexit 127\n" });
    try {
      await assert.rejects(new GoogleChromeTools({ tools, source: liar.source }).ensure(), /the unpacked binary reports 'Chromium 1.2.3.4', not Google Chrome 158.0.7100.1/);
      await assert.rejects(new GoogleChromeTools({ tools, source: broken.source }).ensure(), /Google Chrome does not run on this box: cannot open shared object file/);
    } finally { liar.close(); broken.close(); }
    assert.deepEqual(readdirSync(join(tools, "google-chrome")), [], "no copy and no leftover");
  } finally { repo.close(); rmSync(tools, { recursive: true, force: true }); }
});

test("the tar rules: an absolute name, '..', a hard link, a FIFO, a device, a member under a link, a name given twice and a link that leaves the copy are refused; members outside opt/google/chrome are never written", () => {
  const dest = tmp("ab-tar-");
  const run = (members: Parameters<typeof tarOf>[0]) => {
    const d = mkdtempSync(join(dest, "c-"));
    const t = new ChromeTar(d);
    t.push(tarOf(members)); t.end();
    return { d, t };
  };
  try {
    const base: Parameters<typeof tarOf>[0] = [[{ name: "./opt/", type: "5" }], [{ name: "./opt/google/", type: "5" }], [{ name: "./opt/google/chrome/", type: "5" }]];
    const { d } = run([...base, [{ name: "./opt/google/chrome/chrome", mode: 0o4755 }, Buffer.from("bin")], [{ name: "./etc/cron.daily/x" }, Buffer.from("no")], [{ name: "x", prefix: "./opt/google/chrome" }, Buffer.from("prefixed")]]);
    assert.deepEqual(readdirSync(join(d, "opt", "google", "chrome")).sort(), ["chrome", "x"]);
    assert.equal(existsSync(join(d, "etc")), false);
    assert.equal(statSync(join(d, "opt", "google", "chrome", "chrome")).mode & 0o7777, 0o755);
    const refused: [string, Parameters<typeof tarOf>[0], RegExp][] = [
      ["absolute", [[{ name: "/opt/google/chrome/x" }]], /absolute name/],
      ["dot dot", [[{ name: "opt/google/chrome/../../../etc/x" }]], /leaves its folder \('\.\.'\)/],
      ["hard link", [...base, [{ name: "opt/google/chrome/h", type: "1", linkname: "opt/google/chrome/chrome" }]], /a hard link/],
      ["fifo", [...base, [{ name: "opt/google/chrome/f", type: "6" }]], /a FIFO/],
      ["device", [...base, [{ name: "opt/google/chrome/d", type: "3" }]], /a device/],
      ["link out", [...base, [{ name: "opt/google/chrome/l", type: "2", linkname: "../../../../etc" }]], /symbolic link that leaves its folder/],
      ["absolute link", [...base, [{ name: "opt/google/chrome/l", type: "2", linkname: "/etc" }]], /symbolic link that leaves its folder/],
      ["under a link", [...base, [{ name: "opt/google/chrome/l", type: "2", linkname: "." }], [{ name: "opt/google/chrome/l/x" }, Buffer.from("x")]], /writes through a symbolic link/],
      ["twice", [...base, [{ name: "opt/google/chrome/a" }, Buffer.from("1")], [{ name: "opt/google/chrome/a" }, Buffer.from("2")]], /names a member twice/],
      ["no folder", [[{ name: "opt/google/chrome" }, Buffer.from("file")]], /no opt\/google\/chrome folder/],
    ];
    for (const [what, members, re] of refused) assert.throws(() => run(members), (e: Error) => e instanceof ToolsError && re.test(e.message), what);
    assert.deepEqual(memberParts("./opt//google/./chrome/"), ["opt", "google", "chrome"]);
    const l = join(dest, "dangling");
    symlinkSync("../../../nowhere/at/all", l);
    assert.equal(looseRealpath(l).startsWith(dest), false, "a dangling link resolves where it points");
  } finally { rmSync(dest, { recursive: true, force: true }); }
});

test("the lock: an install holds <tools>/.google-chrome.lock (flock, as agentwatch's install); a prune skips the folder while it is held", async () => {
  const tools = tmp("ab-lock-");
  try {
    const release = await flockLocker(join(tools, ".google-chrome.lock"), true);
    assert.ok(release);
    assert.equal(await flockLocker(join(tools, ".google-chrome.lock"), false), null, "held");
    mkdirSync(join(tools, "google-chrome", "157.0.1.1-1", "opt", "google", "chrome"), { recursive: true });
    writeFileSync(join(tools, "google-chrome", "157.0.1.1-1", "opt", "google", "chrome", "chrome"), "");
    writeFileSync(join(tools, "google-chrome", ".157.0.1.2-1.abc.deb"), "");
    const t = new GoogleChromeTools({ tools });
    assert.deepEqual(await t.prune(new Set()), [], "the prune waits for the install");
    release!();
    const again = await flockLocker(join(tools, ".google-chrome.lock"), false);
    assert.ok(again, "free after the release");
    again!();
  } finally { rmSync(tools, { recursive: true, force: true }); }
});

test("the prune: it keeps the copies of `keep`, the newest copy and each copy that a process runs; removes the others and what a cut install left; removes no copy when /proc cannot be read; never goes through a link", async () => {
  const tools = tmp("ab-prune-");
  try {
    const root = join(tools, "google-chrome");
    const copy = (v: string) => { mkdirSync(join(root, v, "opt", "google", "chrome"), { recursive: true }); writeFileSync(join(root, v, "opt", "google", "chrome", "chrome"), ""); };
    for (const v of ["155.0.1.1-1", "156.0.1.1-1", "157.0.1.1-1", "158.0.1.1-1"]) copy(v);
    mkdirSync(join(root, ".158.0.1.1-1.abcdef.tmp")); mkdirSync(join(root, ".index.abcdef.tmp")); writeFileSync(join(root, ".159.0.1.1-1.abcdef.deb"), "");
    writeFileSync(join(root, "notes.txt"), "keep");
    const outside = tmp("ab-outside-");
    copy("x"); rmSync(join(root, "x"), { recursive: true });
    symlinkSync(outside, join(root, "154.0.1.1-1"));
    // A fake /proc: one process runs the 156 copy.
    const proc = join(tools, "proc");
    mkdirSync(join(proc, "4242"), { recursive: true });
    symlinkSync(join(root, "156.0.1.1-1", "opt", "google", "chrome", "chrome"), join(proc, "4242", "exe"));
    writeFileSync(join(proc, "4242", "cmdline"), "chrome\0");
    const noProc = new GoogleChromeTools({ tools, procRoot: join(tools, "no-proc") });
    const removedNone = await noProc.prune(new Set());
    assert.deepEqual(removedNone.map((p) => p.slice(root.length + 1)).sort(), [".159.0.1.1-1.abcdef.deb"], "no /proc: only the .deb goes");
    const t = new GoogleChromeTools({ tools, procRoot: proc });
    const removed = (await t.prune(new Set(["155.0.1.1-1"]))).map((p) => p.slice(root.length + 1)).sort();
    assert.deepEqual(removed, [".158.0.1.1-1.abcdef.tmp", ".index.abcdef.tmp", "157.0.1.1-1"]);
    assert.deepEqual(readdirSync(root).sort(), ["154.0.1.1-1", "155.0.1.1-1", "156.0.1.1-1", "158.0.1.1-1", "notes.txt"]);
    assert.ok(existsSync(outside), "never through a link");
    rmSync(outside, { recursive: true, force: true });
  } finally { rmSync(tools, { recursive: true, force: true }); }
});

test("unsupported: not Linux, not x86_64, no gpgv or no xz names the reason", () => {
  const w = (o: object) => new GoogleChromeTools({ tools: "/t", which: (n) => `/usr/bin/${n}`, ...o }).unsupported();
  assert.equal(w({ platform: "linux", arch: "x64" }), null);
  assert.match(w({ platform: "darwin", arch: "x64" })!, /needs Linux/);
  assert.match(w({ platform: "linux", arch: "arm64" })!, /needs an x86_64 box/);
  assert.match(new GoogleChromeTools({ tools: "/t", platform: "linux", arch: "x64", which: (n) => (n === "gpgv" ? null : "/x") }).unsupported()!, /gpgv is not installed/);
  assert.match(new GoogleChromeTools({ tools: "/t", platform: "linux", arch: "x64", which: (n) => (n === "xz" ? null : "/x") }).unsupported()!, /xz is not installed/);
});
