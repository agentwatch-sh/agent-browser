// An MCP-like server (board ab-v16.47 probe): a stdio child of the agent, as Claude Code starts the
// Playwright MCP. At each line on standard input it connects with playwright-core, as the MCP does at
// its first browser tool call, and writes the result to standard output. It ends with its input.
//   node mcp_like.mjs <socket path> <label>
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_CORE ?? "/usr/lib/node_modules/playwright/node_modules/playwright-core");
const [sock, label] = process.argv.slice(2);
for await (const _line of createInterface({ input: process.stdin })) {
  try {
    await pw.chromium.connectOverCDP(`ws+unix://${sock}:/devtools/browser/${label}`, { timeout: 5000 });
    process.stdout.write(`${label}: connected (not expected)\n`);
  } catch (e) {
    const body = /\{"scope".*?\}/.exec(String(e.message));
    process.stdout.write(`${label}: pid ${process.pid} ppid ${process.ppid}: ${body ? body[0] : String(e.message).split("\n")[0]}\n`);
  }
}
