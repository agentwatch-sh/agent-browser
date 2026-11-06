// The peer group's Playwright script (board ab-v16.51), as an agent's Bash tool command in a tmux pane: it connects
// over CDP to the endpoint of a scope, opens a page of the scope's list, reads its title, and writes one JSON object
// to <out>: {ok, title} or {ok: false, error}, with its pid and parent.
//   node pw.mjs <playwright-core> <endpoint URL> <page URL> <out>
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const [pwModule, endpoint, page, out] = process.argv.slice(2);
const pw = createRequire(import.meta.url)(pwModule);
const me = { pid: process.pid, ppid: process.ppid };
try {
  const browser = await pw.chromium.connectOverCDP(endpoint, { timeout: 15_000 });
  const p = await browser.contexts()[0].newPage();
  await p.goto(page);
  const title = await p.title();
  await p.close();
  await browser.close();
  writeFileSync(out, JSON.stringify({ ok: true, title, ...me }));
} catch (e) {
  writeFileSync(out, JSON.stringify({ ok: false, error: String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 1500), ...me }));
}
process.exit(0);
