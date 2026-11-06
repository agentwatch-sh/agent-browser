// The peer group's MCP client (board ab-v16.51): an agent-like process in a tmux pane that starts the Playwright MCP as
// its stdio child, as Claude Code does, with the endpoint as a plain argument (the URL holds no secret), and calls
// browser_navigate. It writes one JSON object to <out>: {ok, text} with its own pid and the MCP's pid.
//   node mcp-agent.mjs <@playwright/mcp cli.js> <endpoint URL> <page URL> <out> <MCP output folder>
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const [cli, endpoint, page, out, outDir] = process.argv.slice(2);
const child = spawn(process.execPath, [cli, "--cdp-endpoint", endpoint, "--output-dir", outDir], { stdio: ["pipe", "pipe", "pipe"] });
let buf = "", next = 1, stderr = "";
const waiting = new Map();
child.stderr.on("data", (d) => (stderr += d));
child.stdout.on("data", (d) => {
  buf += d;
  for (let i; (i = buf.indexOf("\n")) >= 0;) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.id !== undefined && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  }
});
const rpc = (method, params) => new Promise((resolve) => {
  const id = next++;
  waiting.set(id, resolve);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
});
const limit = (ms) => new Promise((r) => setTimeout(() => r({ error: { message: `no answer in ${ms} ms` } }), ms));
const me = { pid: process.pid, mcpPid: child.pid };
try {
  await Promise.race([rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "peer-live", version: "0" } }), limit(20_000)]);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const r = await Promise.race([rpc("tools/call", { name: "browser_navigate", arguments: { url: page } }), limit(30_000)]);
  const text = r.result?.content ? r.result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n") : JSON.stringify(r.error);
  const isError = Boolean(r.error || r.result?.isError);
  writeFileSync(out, JSON.stringify({ ok: !isError, text: text.replace(/\s+/g, " ").slice(0, 600), ...me }));
} catch (e) {
  writeFileSync(out, JSON.stringify({ ok: false, text: String(e?.message ?? e), stderr: stderr.slice(-400), ...me }));
}
child.kill();
process.exit(0);
