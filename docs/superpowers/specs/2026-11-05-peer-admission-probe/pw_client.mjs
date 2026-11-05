// A Playwright client (board ab-v16.47 probe): connectOverCDP to the probe endpoint, which answers 503.
//   node pw_client.mjs <socket path> <label>
// PLAYWRIGHT_CORE names playwright-core's folder (default: the global playwright's copy).
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_CORE ?? "/usr/lib/node_modules/playwright/node_modules/playwright-core");
const [sock, label] = process.argv.slice(2);
try {
  await pw.chromium.connectOverCDP(`ws+unix://${sock}:/devtools/browser/${label}`, { timeout: 5000 });
  console.log(`${label}: pid ${process.pid} ppid ${process.ppid}: connected (not expected)`);
} catch (e) {
  const body = /\{"scope".*?\}/.exec(String(e.message));
  console.log(`${label}: pid ${process.pid} ppid ${process.ppid}: ${body ? body[0] : String(e.message).split("\n")[0]}`);
}
