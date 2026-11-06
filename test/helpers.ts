// Test helpers: a fixture HTTP server on 127.0.0.1, the fixture site the fake Chrome shows, a
// private consumer (its own temp state folder and allowlist), a runner for the real CLI, and a stand-in endpoint for
// spawn tests of the agent-mode live suite.

import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

/**
 * The fixture's host name for the tests over agent mode's endpoint: the relay refuses a navigation off the scope's
 * list (C11, layer 1), and a list entry is a host name with two labels, never an IP address (C5). The server still
 * listens on 127.0.0.1, and the fake Chrome reaches the name there.
 */
export const FIXTURE_HOST = "fixture.localhost";

/** A fixture server on 127.0.0.1; `host` names it in its base URL. */
export async function fixtureServer(host = "127.0.0.1"): Promise<Fixture> {
  const server = createServer((req, res) => {
    if (req.url === "/file.bin") { res.setHeader("content-type", "application/octet-stream"); return res.end(BIN); }
    if (req.url === "/small.txt") { res.setHeader("content-type", "text/plain"); return res.end("small file\n"); }
    if (req.url === "/api/data") { res.setHeader("content-type", "application/json"); return res.end('{"ok":true}'); }
    if (req.url === "/api/echo") { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { res.setHeader("content-type", "text/plain"); res.end(b); }); return; }
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://${host}:${(server.address() as { port: number }).port}`;
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
    // An app's own cell editor that reads key events only (as the Google Sheets cell editor does), a plain field, and no field.
    if (url.pathname === "/editor") return { title: "editor", elements: [
      { tag: "div", id: "cell", attrs: { contenteditable: "true", "data-keys-only": "", "data-cells": "" } },
      { tag: "div", id: "notes", attrs: { contenteditable: "true" } },
      { tag: "div", id: "label", text: "not a field" },
      { tag: "div", id: "grid", attrs: { "data-scrolls": "" }, rect: [20, 200, 150, 100] },
    ] };
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
    // A just-stopped proxy may still be writing its socket/pid file as this runs; retry past the race.
    remove: () => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }),
  };
}

export type CliRun = { status: number | null; stdout: string; stderr: string; json: any };

/** Run the real CLI (bin/agent-browser.js) in a child process; `env` replaces its environment. */
export function cli(args: string[], opts: { input?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<CliRun> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [BIN_JS, ...args], { cwd: opts.cwd ?? ROOT, env: opts.env, encoding: "utf8", maxBuffer: 64 << 20, timeout: 60_000 }, (error, stdout, stderr) => {
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

export type SuiteStandIn = { dir: string; link: string; real: string; run: (env: NodeJS.ProcessEnv) => Promise<CliRun>; remove: () => Promise<void> };

/** The stand-in npm of suiteStandIn: it fails, or with STAND_IN_NPM=install it makes the two modules that the run loads. */
const STAND_IN_NPM = `#!/bin/sh
[ "$STAND_IN_NPM" = install ] || { echo "the stand-in npm fails: $*" >&2; exit 1; }
case "$1" in
  pack) echo agent-browser-0.0.0.tgz ;;
  install) mkdir -p node_modules/playwright-core node_modules/ws || exit 1
    echo 'module.exports = {};' > node_modules/playwright-core/index.js
    echo 'module.exports = {};' > node_modules/ws/index.js ;;
esac
`;

/**
 * A stand-in endpoint for spawn tests of the agent-mode live suite (test/live/agent-mode/run.ts) in its external mode:
 * a Unix socket of the test's own that answers every request with 404 (a ready endpoint; no agent browser is behind
 * it) and a link to it, a CONTROL whose answer says that the browser runs, and an npm that fails, so that the run
 * stops at its scratch install, before it starts or connects anything. With STAND_IN_NPM=install and CASES=none the
 * run passes with no group. `run` gives RELAY_SOCK the link.
 */
export async function suiteStandIn(): Promise<SuiteStandIn> {
  const dir = mkdtempSync(join(tmpdir(), "ab-suite-"));
  mkdirSync(join(dir, "real"));
  mkdirSync(join(dir, "bin"));
  const sock = join(dir, "real/relay.sock"), link = join(dir, "link.sock"), control = join(dir, "control");
  const server = createServer((_req, res) => { res.statusCode = 404; res.end(); });
  await new Promise<void>((r) => server.listen(sock, r));
  symlinkSync(sock, link);
  writeFileSync(control, `#!/bin/sh\necho '{"ok": true, "running": true, "receiver": true, "endpoint": {"state": "ready"}}'\n`, { mode: 0o755 });
  writeFileSync(join(dir, "bin/npm"), STAND_IN_NPM, { mode: 0o755 });
  return {
    dir, link, real: realpathSync(sock),
    run: (env) => new Promise((resolve) => {
      execFile(process.execPath, [join(ROOT, "test/live/agent-mode/run.ts")], {
        encoding: "utf8", timeout: 60_000,
        env: { PATH: `${join(dir, "bin")}:${process.env.PATH}`, HOME: process.env.HOME, RELAY_SOCK: link, CONTROL: control, ...env },
      }, (error, stdout, stderr) => resolve({ status: error ? (typeof error.code === "number" ? error.code : null) : 0, stdout, stderr, json: undefined }));
    }),
    remove: async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); rmSync(dir, { recursive: true, force: true }); },
  };
}
