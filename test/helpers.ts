// Test helpers: a fixture HTTP server on 127.0.0.1, the fixture site the fake Chrome shows, a
// private consumer (its own temp state folder and allowlist), and a runner for the real CLI.

import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PageSpec, Site } from "./fake-chrome.ts";
import type { BrowserOptions } from "../src/options.ts";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const BIN_JS = join(ROOT, "bin", "agent-browser.js");

/** More than one 8 MB chunk, so streamed reads are tested. */
export const BIN = Buffer.alloc(9 * 1024 * 1024 + 123).map((_, i) => (i * 31) & 0xff);

export type Fixture = { base: string; server: Server; close: () => Promise<void> };

export async function fixtureServer(): Promise<Fixture> {
  const server = createServer((req, res) => {
    if (req.url === "/file.bin") { res.setHeader("content-type", "application/octet-stream"); return res.end(BIN); }
    if (req.url === "/small.txt") { res.setHeader("content-type", "text/plain"); return res.end("small file\n"); }
    if (req.url === "/api/data") { res.setHeader("content-type", "application/json"); return res.end('{"ok":true}'); }
    if (req.url === "/api/echo") { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { res.setHeader("content-type", "text/plain"); res.end(b); }); return; }
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { base, server, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

/** The page every test opens: buttons, inputs, links (one off the allowlist), a download, API calls. */
export const MAIN_PAGE: PageSpec = {
  title: "t",
  text: "Fixture page",
  elements: [
    { tag: "button", id: "b", text: "Go", onclick: (p) => { p.title = "clicked"; } },
    { tag: "input", id: "i", attrs: { placeholder: "Name" } },
    { tag: "input", id: "f", attrs: { type: "file" } },
    { tag: "a", id: "dl", text: "Download", attrs: { href: "/file.bin", download: "out.bin" } },
    { tag: "button", id: "api", text: "Load", onclick: (p) => { void p.fetch("/api/data"); } },
    { tag: "button", id: "post", text: "Post", onclick: async (p) => {
      const r = await p.fetch("/api/echo", { method: "POST", body: JSON.stringify({ a: 1, token: "t0k" }) });
      p.title = await r.text();
    } },
    { tag: "div", id: "later", text: "" },
    { tag: "a", id: "away", text: "Away", attrs: { href: "https://elsewhere.invalid/" } },
    { tag: "a", id: "next", text: "Next", attrs: { href: "/next" } },
    { tag: "button", id: "hidden", text: "Hidden", hidden: true },
    { tag: "button", id: "below", text: "Below the fold", rect: [10, 2000, 120, 24] },
  ],
  onload: (p) => p.later(300, () => { p.select("#later")[0].text = "ready"; }),
};

export function site(base: string): Site {
  return (url) => {
    if (url.origin !== base) return undefined;
    if (url.pathname === "/") return MAIN_PAGE;
    // An OAuth-style redirect off the allowlist, right after the page loads.
    if (url.pathname === "/redirect") return { title: "redirecting", onload: (p) => p.later(0, () => p.fake.navigate(p, "https://login.elsewhere.invalid/oauth?code=SECRET-CODE")) };
    if (url.pathname === "/next") return { title: "next", text: "the next page", elements: [{ tag: "a", text: "Back", attrs: { href: "/" } }] };
    return { title: "404", text: "not found" };
  };
}

export type Consumer = { dir: string; stateDir: string; allowlist: string; options: (extra?: Partial<BrowserOptions>) => BrowserOptions; remove: () => void };

/** A consumer of its own: a short temp folder (socket paths stay under 104 bytes) and an allowlist file. */
export function consumer(allow: string[] = ["127.0.0.1"]): Consumer {
  const dir = mkdtempSync(join(tmpdir(), "ab-"));
  const stateDir = join(dir, "state"), allowlist = join(dir, "allow.json");
  writeFileSync(allowlist, JSON.stringify({ allow }));
  return {
    dir, stateDir, allowlist,
    options: (extra = {}) => ({ stateDir, allowlistFile: allowlist, noLaunch: true, log: () => {}, ...extra }),
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export type CliRun = { status: number | null; stdout: string; stderr: string; json: any };

/** Run the real CLI (bin/agent-browser.js) in a child process. */
export function cli(args: string[], opts: { input?: string; cwd?: string } = {}): Promise<CliRun> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [BIN_JS, ...args], { cwd: opts.cwd ?? ROOT, encoding: "utf8", maxBuffer: 64 << 20, timeout: 60_000 }, (error, stdout, stderr) => {
      let json: unknown;
      try { json = JSON.parse(stdout); } catch { json = undefined; }
      resolve({ status: error ? (typeof error.code === "number" ? error.code : null) : 0, stdout, stderr, json });
    });
    child.stdin?.end(opts.input ?? "");
  });
}

/** The global flags of one consumer for the CLI. */
export function flags(c: Consumer, endpoint: string, extra: string[] = []): string[] {
  return ["--state-dir", c.stateDir, "--allowlist", c.allowlist, "--endpoint", endpoint, "--no-launch", ...extra];
}
