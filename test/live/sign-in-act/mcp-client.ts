// A real MCP client for the live check of the stored sign-ins' MCP tools (board ab-v16.97.5; test/live/sign-in-act/
// check.ts, step 7b): the MCP SDK's own Client and StreamableHTTPClientTransport, from the pinned playwright-core's
// bundle (no package of its own). The check starts it as a child, so the MCP port's walk reads this process: a child of
// the check is under the check's root (the local scope), and a child that the check names as a root of its own is that
// scope's (the remote stand-in). It reads one line on its standard input, {"url","token","calls":[{"name","arguments"}]},
// with a test token of the check (never a real one); then it connects with the token, lists the tools and calls each tool
// in order. It prints one JSON line: {"tools":[<names>],"results":[<each tool result>]}, or {"error":"<text>"}.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const sdk = createRequire(import.meta.url)(fileURLToPath(new URL("../../../node_modules/playwright-core/lib/utilsBundle.js", import.meta.url)));
const out = (o: object) => new Promise<void>((r) => process.stdout.write(JSON.stringify(o) + "\n", () => r()));

let line = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) { line += chunk; if (line.includes("\n")) break; }
const job = JSON.parse(line.split("\n")[0]) as { url: string; token: string; calls: { name: string; arguments: Record<string, unknown> }[] };
const client = new sdk.Client({ name: "live-check", version: "0" });
let code = 0;
try {
  await client.connect(new sdk.StreamableHTTPClientTransport(new URL(job.url), { requestInit: { headers: { Authorization: `Bearer ${job.token}` } } }));
  const tools = ((await client.listTools()).tools as { name: string }[]).map((t) => t.name);
  const results: unknown[] = [];
  // The act's longest run (C11: check 7's wait, the page's load and the outcome, the receiver's waits) and a margin.
  for (const c of job.calls) results.push(await client.callTool({ name: c.name, arguments: c.arguments }, undefined, { timeout: 240_000 }));
  await out({ tools, results });
} catch (e) {
  code = 1;
  await out({ error: (e as Error).message });
} finally {
  await client.close().catch(() => {});
}
process.exit(code);
