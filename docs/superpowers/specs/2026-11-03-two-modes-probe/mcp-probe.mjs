// Probe only: the Playwright MCP (stdio) drives the agent Chrome through the
// extension. The endpoint goes in PLAYWRIGHT_MCP_CDP_ENDPOINT, not in argv.
// The MCP server is unchanged; this script plays the MCP client.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const OUT = process.env.OUT;
const A = "http://a.localhost:8781";
const B = "http://b.localhost:8781";
const cli = path.join(process.env.PW_DIR, "node_modules/@playwright/mcp/cli.js");
const child = spawn(process.execPath, [cli, "--output-dir", process.env.MCP_OUT_DIR], {
  env: { ...process.env, PLAYWRIGHT_MCP_CDP_ENDPOINT: process.env.ENDPOINT },
  stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (d) => (stderr += d));

let buf = "";
let nextId = 1;
const waiting = new Map();
child.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.id !== undefined && waiting.has(m.id)) {
      waiting.get(m.id)(m);
      waiting.delete(m.id);
    }
  }
});
const rpc = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
const text = (r) => (r.result && r.result.content ? r.result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n") : JSON.stringify(r.error));
const results = [];
// Each call passes only when want(text, result) holds, or, with refused, only
// when it fails with that text (a refusal that the design wants). A call that
// gets no answer in 20 s fails.
async function tool(name, args, { saw, want, refused } = {}) {
  const t0 = Date.now();
  let timer;
  const limit = new Promise((resolve) => (timer = setTimeout(() => resolve({ error: { message: "probe timeout: no answer in 20 s" } }), 20000)));
  const r = await Promise.race([rpc("tools/call", { name, arguments: args }), limit]).finally(() => clearTimeout(timer));
  const t = text(r);
  const isError = Boolean(r.error || (r.result && r.result.isError));
  const ok = refused ? isError && refused.test(t) : !isError && (!want || want(t, r));
  const row = { tool: name, ms: Date.now() - t0, isError, ok, ...(refused ? { expect: "refused" } : {}), saw: isError ? t.replace(/\s+/g, " ").slice(0, 300) : saw ? saw(t, r) : t.split("\n").slice(0, 3).join(" | ").slice(0, 200) };
  results.push(row);
  return t;
}
// The site's newest page report (the page's own counts), from the site log.
async function lastReport() {
  await new Promise((r) => setTimeout(r, 400));
  const rows = fs.readFileSync(process.env.SITE_LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return rows.filter((x) => x.t === "report" && x.kind === "click").pop();
}

await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "two-modes-probe", version: "0" } });
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
const list = await rpc("tools/list", {});
const names = list.result.tools.map((t) => t.name);

await tool("browser_navigate", { url: A + "/" }, { saw: () => "page title: probe a", want: (t) => t.includes("probe a") });
const snap = await tool("browser_snapshot", {}, { saw: (t) => t.split("\n").length + " lines", want: (t) => t.includes('button "Greet"') });
const ref = (re) => (re.exec(snap) || [])[1];
const nameRef = ref(/textbox "Name"[^\n]*\[ref=(\w+)\]/);
const goRef = ref(/button "Greet"[^\n]*\[ref=(\w+)\]/);
const reportRef = ref(/button "Report"[^\n]*\[ref=(\w+)\]/);
await tool("browser_type", { element: "Name", target: nameRef, text: "MCP" }, { saw: () => `ref ${nameRef}` });
await tool("browser_click", { element: "Greet", target: goRef }, { saw: () => `ref ${goRef}` });
await tool("browser_snapshot", {}, { saw: (t) => (t.includes("Hello, MCP") ? "status shows: Hello, MCP" : "no greeting"), want: (t) => t.includes("Hello, MCP") });
// What the site sees of the MCP's typing: browser_type fills the field (input
// events, no key events) unless slowly is set. #report sends the page's counts.
await tool("browser_click", { element: "Report", target: reportRef }, { saw: () => "report after browser_type (fill)" });
const fillReport = await lastReport();
results.push({ tool: "(site) key events after browser_type", ms: 0, ok: fillReport.keydowns === 0 && fillReport.inputs >= 1, saw: `keydown ${fillReport.keydowns}, input ${fillReport.inputs}` });
await tool("browser_type", { element: "Name", target: nameRef, text: "slow", slowly: true }, { saw: () => "browser_type slowly" });
await tool("browser_click", { element: "Report", target: reportRef }, { saw: () => "report after browser_type slowly" });
const slowReport = await lastReport();
results.push({ tool: "(site) key events after browser_type slowly", ms: 0, ok: slowReport.keydowns >= 4, saw: `keydown ${slowReport.keydowns}, input ${slowReport.inputs}` });
await tool("browser_take_screenshot", {}, { saw: (t, r) => r.result.content.map((c) => c.type).join(","), want: (t, r) => r.result.content.some((c) => c.type === "image") });
await tool("browser_tabs", { action: "list" }, { saw: (t) => t.split("\n").filter((l) => l.includes("localhost") || l.includes("about:")).join(" | ").slice(0, 200), want: (t) => t.includes("a.localhost") });
await tool("browser_tabs", { action: "new" }, { saw: (t) => t.split("\n").slice(0, 2).join(" | ").slice(0, 160) });
await tool("browser_navigate", { url: B + "/" }, { refused: /ERR_BLOCKED_BY_CLIENT/ });
await tool("browser_close", {}, { saw: (t) => t.slice(0, 120) });

fs.writeFileSync(OUT, JSON.stringify({ tools: names.length, results }, null, 2) + "\n");
console.log(`mcp: ${names.length} tools`);
for (const r of results) console.log(`${r.ok ? "ok  " : "ERR "} ${r.tool}${r.expect ? " [refusal expected]" : ""} (${r.ms} ms): ${r.saw}`);
child.kill();
// The MCP's own log goes to the run's scratch folder, never into the repo.
if (stderr.trim()) fs.writeFileSync(path.join(process.env.MCP_OUT_DIR, "mcp.stderr.txt"), stderr);
