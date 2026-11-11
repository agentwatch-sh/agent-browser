// The MCP code of one scope, in one worker thread of the service (contract C11, "The MCP inside the service"; stage 1d of
// the self-contained agent browser, board ab-v16.94.5, part 2b). The service starts it with a heap limit (workers.ts:
// resourceLimits, first value 512 MiB), with an environment of its own (so no DEBUG or PLAYWRIGHT_* variable of the
// service's environment reaches Playwright's code), and with its standard output and error kept from the service's log.
// It holds one Playwright MCP server object for each MCP session of its scope (session.ts), and it takes only the
// messages that the transport let through the allow list.
//
// The MCP's Playwright connects back to the agent door at the first tool that needs the browser: the worker asks the
// service for a one-time ticket of its scope (it gets the endpoint's URL with the ticket in its query), and it connects
// over CDP with `noDefaults`, as the Playwright MCP does. At a session's close its browser connection closes too (the
// model ends that connection only: C11's Browser.close).

import { createRequire } from "node:module";
import { getHeapStatistics } from "node:v8";
import { parentPort, workerData } from "node:worker_threads";
import type { AllowList } from "./allow-list.ts";
import { openMcpServer, type McpServerSession, type Message } from "./session.ts";

/** The messages from the service to the worker. */
export type ToWorker =
  | { t: "open"; sid: string }
  | { t: "msg"; sid: string; msg: Message }
  | { t: "close"; sid: string }
  | { t: "ticket"; n: number; url: string | null }
  | { t: "heap" };
/** The messages from the worker to the service. */
export type FromWorker =
  | { t: "opened"; sid: string; error?: string }
  | { t: "answer"; sid: string; msg: Message }
  | { t: "closed"; sid: string }
  | { t: "ticket"; n: number }
  | { t: "heap"; used: number; total: number; limit: number };

/** The context getter's connection: its default context and its close. */
type Browser = { contexts(): unknown[]; close(): Promise<void> };
type Chromium = { connectOverCDP(url: string, o: Record<string, unknown>): Promise<Browser> };

const { list, folder } = workerData as { list: AllowList; folder: string };
const port = parentPort!;
const send = (m: FromWorker) => port.postMessage(m);
const sessions = new Map<string, Promise<McpServerSession | null>>();
const browsers = new Map<string, Browser>();
const asks = new Map<number, (url: string | null) => void>();
let asked = 0;

/** A one-time ticket's URL from the service, or null when the service has none for this scope now. */
const ticketUrl = () => new Promise<string | null>((resolve) => { const n = ++asked; asks.set(n, resolve); send({ t: "ticket", n }); });

/** The context getter of one MCP session: the ticket's CDP connection, and its default context. */
async function context(sid: string): Promise<unknown> {
  const url = await ticketUrl();
  if (url === null || !sessions.has(sid)) throw new Error("This MCP session has ended.");
  const { chromium } = createRequire(import.meta.url)("playwright-core") as { chromium: Chromium };
  const browser = await chromium.connectOverCDP(url, { noDefaults: true, timeout: 30_000, artifactsDir: folder });
  if (!sessions.has(sid)) { await browser.close().catch(() => {}); throw new Error("This MCP session has ended."); }
  const old = browsers.get(sid);
  browsers.set(sid, browser);
  if (old) void old.close().catch(() => {});
  return browser.contexts()[0];
}

async function close(sid: string): Promise<void> {
  const s = sessions.get(sid);
  sessions.delete(sid);
  const b = browsers.get(sid);
  browsers.delete(sid);
  try { await (await s)?.close(); } catch {}
  try { await b?.close(); } catch {}
  send({ t: "closed", sid });
}

port.on("message", (m: ToWorker) => {
  switch (m.t) {
    case "open": {
      const s = openMcpServer({ list, folder, context: () => context(m.sid), answer: (msg) => send({ t: "answer", sid: m.sid, msg }) })
        .then((x) => { send({ t: "opened", sid: m.sid }); return x; })
        .catch((e) => { sessions.delete(m.sid); send({ t: "opened", sid: m.sid, error: String((e as Error)?.message ?? e).slice(0, 200) }); return null; });
      sessions.set(m.sid, s);
      return;
    }
    case "msg": void sessions.get(m.sid)?.then((s) => s?.deliver(m.msg)); return;
    case "close": void close(m.sid); return;
    case "ticket": { const r = asks.get(m.n); asks.delete(m.n); r?.(m.url); return; }
    case "heap": { const h = getHeapStatistics(); send({ t: "heap", used: h.used_heap_size, total: h.total_heap_size, limit: h.heap_size_limit }); return; }
  }
});
