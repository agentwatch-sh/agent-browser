// The package as consumers get it: ws as the only dependency, the exports, an install under
// node_modules (where Node refuses to strip types by itself), no consumer's paths, no CI workflow.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import * as lib from "../src/index.ts";
import { FakeChrome } from "./fake-chrome.ts";
import { ROOT, consumer } from "./helpers.ts";

const run = promisify(execFile);
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

// The vetted set (docs/supply-chain/ghost-cursor-1.4.2.md for ghost-cursor and what it brings).
const LOCKED: Record<string, string> = {
  "node_modules/ws": "8.21.0",
  "node_modules/ghost-cursor": "1.4.2",
  "node_modules/bezier-js": "6.1.4",
  "node_modules/debug": "4.4.3",
  "node_modules/ms": "2.1.3",
  "node_modules/@types/bezier-js": "4.1.3",
};

test("the dependencies are ws and ghost-cursor, pinned exactly, and the lockfile holds only the vetted set", () => {
  assert.deepEqual(pkg.dependencies, { "ghost-cursor": "1.4.2", ws: "8.21.0" });
  assert.equal(pkg.devDependencies, undefined);
  assert.equal(pkg.optionalDependencies, undefined);
  assert.equal(pkg.engines.node, ">=26");
  assert.equal(pkg.private, true, "never published to a registry");
  const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
  assert.deepEqual(Object.keys(lock.packages).sort(), ["", ...Object.keys(LOCKED)].sort());
  for (const [path, version] of Object.entries(LOCKED)) {
    assert.equal(lock.packages[path].version, version, path);
    assert.match(lock.packages[path].integrity, /^sha512-/, path);
    assert.equal(lock.packages[path].hasInstallScript, undefined, `${path} has no install script`);
  }
});

test("ghost-cursor loads without puppeteer, and only when a recording needs it", async () => {
  const { stdout } = await run(process.execPath, ["--input-type=module", "-e", `
    const { createRequire } = await import("node:module");
    const req = createRequire(${JSON.stringify(join(ROOT, "index.js"))});
    await import(${JSON.stringify(join(ROOT, "src", "index.ts"))});
    const before = Object.keys(req.cache).filter((k) => k.includes("ghost-cursor")).length;
    await import("ghost-cursor");
    const after = Object.keys(req.cache).map((k) => k.split("node_modules/")[1]).filter(Boolean);
    console.log(JSON.stringify({ before, after }));`], { cwd: ROOT });
  const { before, after } = JSON.parse(stdout);
  assert.equal(before, 0, "the library does not load ghost-cursor until a recording runs");
  assert.ok(after.some((m: string) => m.startsWith("ghost-cursor/")), "ghost-cursor loaded");
  assert.ok(!after.some((m: string) => m.includes("puppeteer")), `no puppeteer: ${after.join(" ")}`);
});

test("index.js re-exports every runtime export of src/index.ts", async () => {
  const entry = await import(join(ROOT, "index.js"));
  assert.deepEqual(Object.keys(entry).sort(), Object.keys(lib).sort());
});

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "__pycache__" || e.name === "tests" ? [] : files(p);
    return [p];
  });
}

test("nothing in the package names a consumer's path", () => {
  const shipped = [join(ROOT, "index.js"), join(ROOT, "loader.js"), ...files(join(ROOT, "bin")), ...files(join(ROOT, "src")), ...files(join(ROOT, "python", "agent_browser"))];
  const consumerPath = /\.vp\/|config\/sites\.json|vedlo\/vedlo|agentwatch-sh\/agentwatch|~\/\.agentwatch|\.local\/share\/agentwatch|VP_[A-Z_]+/;
  for (const f of shipped) {
    const hit = readFileSync(f, "utf8").match(consumerPath);
    assert.equal(hit, null, `${relative(ROOT, f)} names ${hit?.[0]}`);
  }
});

test("Chrome is never launched with a debugging port: the flag appears only in the code that refuses it", () => {
  for (const f of files(join(ROOT, "src"))) {
    const text = readFileSync(f, "utf8");
    const uses = text.split("\n").filter((l) => l.includes("--remote-debugging-port"));
    for (const line of uses) assert.match(line, /^\s*(\/\/|\*)|refus|never|NEVER/, `${relative(ROOT, f)}: ${line.trim()}`);
  }
});

test("no GitHub Actions workflow runs on a push or a pull request", () => {
  const dir = join(ROOT, ".github", "workflows");
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) assert.doesNotMatch(readFileSync(join(dir, f), "utf8"), /\b(push|pull_request)\b/, f);
});

test("installed under node_modules, the library, the CLI and its proxy child all load without a build step", async () => {
  const app = mkdtempSync(join(tmpdir(), "ab-app-"));
  const fake = await FakeChrome.start();
  const c = consumer();
  const installed = join(app, "node_modules", "agent-browser");
  try {
    mkdirSync(installed, { recursive: true });
    for (const f of ["package.json", "index.js", "loader.js", "bin", "src"]) cpSync(join(ROOT, f), join(installed, f), { recursive: true });
    for (const dep of Object.keys(LOCKED)) {
      mkdirSync(dirname(join(app, dep)), { recursive: true });
      symlinkSync(join(ROOT, dep), join(app, dep));
    }

    const imported = await run(process.execPath, ["--input-type=module", "-e",
      "const m = await import('agent-browser'); console.log(JSON.stringify([typeof m.AgentBrowser, typeof m.commands.tabs, m.COMMAND_SPECS.length]));"], { cwd: app });
    assert.deepEqual(JSON.parse(imported.stdout), ["function", "function", lib.COMMAND_SPECS.length]);
    assert.equal(imported.stderr, "", "no ExperimentalWarning or other noise");

    const bin = join(installed, "bin", "agent-browser.js");
    const tabs = await run(process.execPath, [bin, "tabs", "--state-dir", c.stateDir, "--allowlist", c.allowlist, "--endpoint", fake.ws, "--no-launch", "--json"], { cwd: app });
    assert.deepEqual(JSON.parse(tabs.stdout), { ok: true, command: "tabs", tabs: [], window: null });
    assert.equal(tabs.stderr, "");
    const proxy = JSON.parse(readFileSync(join(c.stateDir, "chrome-proxy.json"), "utf8"));
    const { stdout: command } = await run("ps", ["-ww", "-o", "command=", "-p", String(proxy.pid)]);
    assert.ok(command.includes(join("node_modules", "agent-browser", "bin", "agent-browser.js")), "the proxy runs from the installed copy");
  } finally {
    // The checkout's CLI stops the proxy that the installed copy started: the same consumer, another copy.
    const stop = await run(process.execPath, [join(ROOT, "bin", "agent-browser.js"), "stop", "--state-dir", c.stateDir, "--json"]).catch(() => null);
    assert.deepEqual(JSON.parse(stop?.stdout ?? "null"), { ok: true, command: "stop", stopped: true });
    await fake.close();
    c.remove();
    rmSync(app, { recursive: true, force: true });
  }
});
