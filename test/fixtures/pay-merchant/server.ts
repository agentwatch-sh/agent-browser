// The local test merchant of the card payment (the secure card checkout design, section 11; board ab-sta.5, the plan's
// Task 4, for the live check of its Task 6). One small loopback HTTP server that serves the static pages of this folder by
// the request's host, on 127.0.0.1 (Chrome resolves each *.localhost name to the loopback address):
//
// - shop.localhost: the shop (shop/): a cart, checkouts with order lines, a subtotal, tax, a total, a delivery name and
//   email, a pay button, and the confirmations with an order number. The variants of the design's section 11 are pages of
//   their own (checkout-<variant>.html).
// - pay.localhost: the test payment provider (pay/): card fields in a frame (autocomplete cc-number, cc-exp, cc-csc,
//   cc-name, postal-code) with a save-card box, and its API, POST /charge. The test list of provider origins holds it
//   only through the tests' option (src/service/pay/providers.ts).
// - bank.localhost: a bank's second step (3-D Secure) after the press; other.localhost: card fields in a frame that is no
//   provider's.
//
// No card number is in any page: the live check types a provider's published test number (test/pay-test-cards.ts). The
// API reads a charge's body and drops it: it never logs or keeps a value, and its answer holds no digit of the card.
//
// Run: node test/fixtures/pay-merchant/server.ts [--port <n>]   (it prints the port; 0, the default, takes a free one)

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
/** Each host and its folder. */
export const MERCHANT_HOSTS: Readonly<Record<string, string>> = { "shop.localhost": "shop", "pay.localhost": "pay", "bank.localhost": "bank", "other.localhost": "other" };
const TYPES: Record<string, string> = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8" };
const MAX_BODY = 64 * 1024;

/** The API's answer of a charge, by the variant of the frame that sends it: no value of the card. */
function charge(variant: string | null): Record<string, unknown> {
  if (variant === "decline") return { ok: false, error: "Your card was declined." };
  if (variant === "bank") return { ok: true, bank: true };
  return { ok: true };
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const host = String(req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
  const folder = MERCHANT_HOSTS[host];
  const url = new URL(req.url ?? "/", "http://x");
  if (!folder) return send(res, 404, TYPES.html, "no such host");
  if (req.method === "POST" && folder === "pay" && url.pathname === "/charge") {
    // The provider's API gets the card: that is the payment. The body is read and dropped.
    let size = 0;
    for await (const chunk of req) { size += (chunk as Buffer).length; if (size > MAX_BODY) return send(res, 413, TYPES.html, "too large"); }
    return send(res, 200, "application/json", JSON.stringify(charge(url.searchParams.get("variant"))));
  }
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, TYPES.html, "no such method");
  const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const m = /^([a-z0-9-]+)\.(html|js|css)$/.exec(name);
  if (!m) return send(res, 404, TYPES.html, "no such page");
  try { send(res, 200, TYPES[m[2]], await readFile(join(ROOT, folder, name))); }
  catch { send(res, 404, TYPES.html, "no such page"); }
}

/** Start the merchant on 127.0.0.1 (`port` 0: a free one). */
export async function startMerchant(o: { port?: number } = {}): Promise<{ port: number; server: Server; close: () => Promise<void> }> {
  const server = createServer((req, res) => { serve(req, res).catch(() => { if (!res.headersSent) send(res, 500, TYPES.html, "error"); else res.destroy(); }); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(o.port ?? 0, "127.0.0.1", resolve); });
  const port = (server.address() as { port: number }).port;
  return { port, server, close: () => new Promise<void>((r) => server.close(() => r())) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf("--port");
  const port = at > 0 ? Number(process.argv[at + 1]) : 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) { console.error("usage: node test/fixtures/pay-merchant/server.ts [--port <n>]"); process.exit(2); }
  const m = await startMerchant({ port });
  console.log(`the test merchant: http://shop.localhost:${m.port}/ and http://pay.localhost:${m.port}/ (127.0.0.1:${m.port})`);
}
