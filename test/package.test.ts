// The package as consumers get it: the vetted dependencies only, the exports, an install under
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

// The vetted set (docs/supply-chain/ghost-cursor-1.4.2.md for ghost-cursor and what it brings;
// docs/supply-chain/playwright-mcp-0.0.83.md for the Playwright MCP of the service and its two packages;
// docs/supply-chain/defuddle-0.19.5.md for PageFetch's converter and what it brings, board ab-v16.102; turndown is no
// direct dependency since review-168 N5: defuddle's browser build bundles its own Turndown).
const LOCKED: Record<string, string> = {
  "node_modules/ws": "8.21.0",
  "node_modules/ghost-cursor": "1.4.2",
  "node_modules/bezier-js": "6.1.4",
  "node_modules/debug": "4.4.3",
  "node_modules/ms": "2.1.3",
  "node_modules/@types/bezier-js": "4.1.3",
  "node_modules/@playwright/mcp": "0.0.83",
  "node_modules/playwright": "1.64.0-alpha-1790635538000",
  "node_modules/playwright-core": "1.64.0-alpha-1790635538000",
  "node_modules/defuddle": "0.19.5",
  "node_modules/turndown": "7.2.4",
  "node_modules/@mixmark-io/domino": "2.2.0",
  "node_modules/commander": "12.1.0",
  "node_modules/mathml-to-latex": "1.8.0",
  "node_modules/@xmldom/xmldom": "0.9.12",
  "node_modules/temml": "0.13.5",
  "node_modules/linkedom": "0.18.13",
  "node_modules/boolbase": "2.0.0",
  "node_modules/css-select": "7.0.0",
  "node_modules/css-what": "8.0.0",
  "node_modules/cssom": "0.5.0",
  "node_modules/dom-serializer": "3.1.1",
  "node_modules/domelementtype": "3.0.0",
  "node_modules/domhandler": "6.0.1",
  "node_modules/domutils": "4.0.2",
  "node_modules/entities": "8.1.0",
  "node_modules/html-escaper": "3.0.3",
  "node_modules/htmlparser2": "10.1.0",
  "node_modules/htmlparser2/node_modules/dom-serializer": "2.0.0",
  "node_modules/htmlparser2/node_modules/dom-serializer/node_modules/entities": "4.5.0",
  "node_modules/htmlparser2/node_modules/domelementtype": "2.3.0",
  "node_modules/htmlparser2/node_modules/domhandler": "5.0.3",
  "node_modules/htmlparser2/node_modules/domutils": "3.2.2",
  "node_modules/htmlparser2/node_modules/entities": "7.0.1",
  "node_modules/nth-check": "3.0.1",
  "node_modules/uhyphen": "0.2.0",
};

test("the dependencies are ws, ghost-cursor, the Playwright MCP's three packages and PageFetch's defuddle, pinned exactly, and the lockfile holds only the vetted set", () => {
  assert.deepEqual(pkg.dependencies, { "@playwright/mcp": "0.0.83", defuddle: "0.19.5", "ghost-cursor": "1.4.2", playwright: "1.64.0-alpha-1790635538000", "playwright-core": "1.64.0-alpha-1790635538000", ws: "8.21.0" });
  for (const v of Object.values<string>(pkg.dependencies)) assert.doesNotMatch(v, /[\^~*<>=| ]/, `an exact pin: ${v}`);
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

test("the Playwright MCP's packages load only when an MCP session needs them: the library, the CLI's service and the MCP path's modules load no Playwright; @playwright/mcp's dependency is the pinned playwright-core", async () => {
  const { stdout } = await run(process.execPath, ["--input-type=module", "-e", `
    const { createRequire } = await import("node:module");
    const req = createRequire(${JSON.stringify(join(ROOT, "index.js"))});
    await import(${JSON.stringify(join(ROOT, "src", "index.ts"))});
    await import(${JSON.stringify(join(ROOT, "src", "service", "main.ts"))});
    const session = await import(${JSON.stringify(join(ROOT, "src", "service", "mcp", "session.ts"))});
    const before = Object.keys(req.cache).filter((k) => k.includes("playwright"));
    session.mcpEntry();
    const after = Object.keys(req.cache).filter((k) => k.includes("node_modules/playwright-core/"));
    console.log(JSON.stringify({ before, after: after.length }));`], { cwd: ROOT });
  const got = JSON.parse(stdout);
  assert.deepEqual(got.before, [], "no Playwright module at import");
  assert.ok(got.after > 0, "the MCP's entry loads the pinned playwright-core (the scan reads the cache)");
  const mcp = JSON.parse(readFileSync(join(ROOT, "node_modules", "@playwright", "mcp", "package.json"), "utf8"));
  assert.deepEqual(mcp.dependencies, { playwright: pkg.dependencies.playwright, "playwright-core": pkg.dependencies["playwright-core"] });
  const pw = JSON.parse(readFileSync(join(ROOT, "node_modules", "playwright", "package.json"), "utf8"));
  assert.deepEqual(pw.dependencies, { "playwright-core": pkg.dependencies["playwright-core"] });
  assert.equal(pw.optionalDependencies, undefined, "no optional package (no fsevents)");
  for (const p of ["@playwright/mcp", "playwright", "playwright-core"]) {
    const j = JSON.parse(readFileSync(join(ROOT, "node_modules", p, "package.json"), "utf8"));
    for (const k of ["preinstall", "install", "postinstall", "prepare"]) assert.equal(j.scripts?.[k], undefined, `${p} has no ${k} script`);
  }
});

test("PageFetch's converter never runs in the service's process: the service reads defuddle's browser build as text, and no module of the library, the CLI or the service imports defuddle, turndown or linkedom (board ab-v16.102)", async () => {
  const { stdout } = await run(process.execPath, ["--input-type=module", "-e", `
    const { createRequire } = await import("node:module");
    const req = createRequire(${JSON.stringify(join(ROOT, "index.js"))});
    await import(${JSON.stringify(join(ROOT, "src", "index.ts"))});
    await import(${JSON.stringify(join(ROOT, "src", "service", "main.ts"))});
    const fp = await import(${JSON.stringify(join(ROOT, "src", "service", "fetch", "fetch-page.ts"))});
    const text = fp.defuddleBundle();
    const loaded = Object.keys(req.cache).filter((k) => ["defuddle", "turndown", "linkedom", "@mixmark-io"].some((p) => k.includes("/node_modules/" + p + "/")));
    console.log(JSON.stringify({ loaded, size: text.length }));`], { cwd: ROOT });
  const got = JSON.parse(stdout);
  assert.deepEqual(got.loaded, [], "no module of the converter loads");
  assert.ok(got.size > 100_000, "the build's text");
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".ts") ? [join(d, e.name)] : []));
  for (const f of walk(join(ROOT, "src"))) {
    const s = readFileSync(f, "utf8");
    assert.doesNotMatch(s, /(?:from\s+|import\(\s*|require\(\s*)["'](?:defuddle|turndown|linkedom)(?:\/[^"']*)?["']/, `${f} imports no converter`);
  }
  const fetchPage = readFileSync(join(ROOT, "src", "service", "fetch", "fetch-page.ts"), "utf8");
  assert.match(fetchPage, /createRequire\(import\.meta\.url\)\.resolve\("defuddle\/full"\)/, "the build is resolved, then read as text");
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
      // A nested package comes with the link of its parent (board ab-v16.102: htmlparser2's own copies).
      if (dep.split("node_modules/").length > 2) continue;
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
    // The one stderr line, on every platform: this call opened the first connection, which a person approves in Chrome.
    // The display gate's notice (ab-v16.26) comes at a command that opens or attaches a page, never at tabs (review-45c).
    assert.match(tabs.stderr, /^agent-browser: no approved connection\. Opening a new one to [^\n]*\n$/, "no ExperimentalWarning, gate notice or other noise");
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
