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
async function tool(name, args, check) {
  const t0 = Date.now();
  const r = await rpc("tools/call", { name, arguments: args });
  const t = text(r);
  const isError = Boolean(r.error || (r.result && r.result.isError));
  const row = { tool: name, ms: Date.now() - t0, isError, saw: isError ? t.replace(/\s+/g, " ").slice(0, 300) : check ? check(r, t) : t.split("\n").slice(0, 3).join(" | ").slice(0, 200) };
  results.push(row);
  return t;
}

await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "two-modes-probe", version: "0" } });
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
const list = await rpc("tools/list", {});
const names = list.result.tools.map((t) => t.name);

await tool("browser_navigate", { url: A + "/" }, (r, t) => (t.includes("probe a") ? "page title: probe a" : t.slice(0, 200)));
const snap = await tool("browser_snapshot", {}, (r, t) => t.split("\n").length + " lines");
const ref = (re) => (re.exec(snap) || [])[1];
const nameRef = ref(/textbox "Name"[^\n]*\[ref=(\w+)\]/);
const goRef = ref(/button "Greet"[^\n]*\[ref=(\w+)\]/);
await tool("browser_type", { element: "Name", target: nameRef, text: "MCP" }, () => `ref ${nameRef}`);
await tool("browser_click", { element: "Greet", target: goRef }, () => `ref ${goRef}`);
await tool("browser_snapshot", {}, (r, t) => (t.includes("Hello, MCP") ? "status shows: Hello, MCP" : "no greeting"));
await tool("browser_take_screenshot", {}, (r) => (r.result && r.result.content ? r.result.content.map((c) => c.type).join(",") : JSON.stringify(r.error)));
await tool("browser_tabs", { action: "list" }, (r, t) => t.split("\n").filter((l) => l.includes("localhost") || l.includes("about:")).join(" | ").slice(0, 200));
await tool("browser_tabs", { action: "new" }, (r, t) => t.split("\n").slice(0, 2).join(" | ").slice(0, 160));
await tool("browser_navigate", { url: B + "/" }, (r, t) => (t.match(/ERR_[A-Z_]+/) || [t.slice(0, 160)])[0]);
await tool("browser_close", {}, (r, t) => t.slice(0, 120));

fs.writeFileSync(OUT, JSON.stringify({ tools: names.length, results }, null, 2) + "\n");
console.log(`mcp: ${names.length} tools`);
for (const r of results) console.log(`${r.isError ? "ERR " : "ok  "} ${r.tool} (${r.ms} ms): ${r.saw}`);
child.kill();
if (stderr.trim()) fs.writeFileSync(OUT.replace(/\.json$/, ".stderr.txt"), stderr);
