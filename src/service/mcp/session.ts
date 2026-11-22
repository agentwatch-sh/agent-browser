// One Playwright MCP server object for one MCP session (contract C11, "The MCP inside the service"; stage 1d of the
// self-contained agent browser, board ab-v16.94.5, part 2b). The scope's worker (worker.ts) makes one for each MCP
// session, and npm test makes one with no browser (the allow list's test, the launch test). This file runs in the worker
// thread, and transport.ts also loads it on the service's main thread for mcpTakesCancel (board ab-v16.94.20,
// review-146 note 5): so it never imports the service's other parts, and its load does nothing (the pinned package
// loads only in mcpEntry, at a server object's open).
//
// The server object comes from `createConnection` of the pinned `@playwright/mcp` package's public entry, with the fixed
// configuration of C11 (mcpConfig) and a context getter: the getter connects the MCP's Playwright back to the agent
// door's CDP path with the session's scope and a one-time ticket (connect, from the worker), and gives the MCP the
// default context. With a context getter `createConnection` never launches, downloads or binds a browser: its other path
// (`browser.cdpEndpoint` in the configuration) would start a pipe server for the browser in the temp folder and write a
// server registry entry, which another program of the user could use to reach the browser around the agent door.
//
// The transport here is a small one of the MCP SDK's shape (start, send, close): the client's messages come in through
// deliver(), and the server's answers go out through `answer`. The transport of the service (transport.ts) carries only
// the server's answers to the client, never a request of the server, so this file answers them: `roots/list` with the
// scope's folder (so the MCP's own file guardrail and its relative names use that folder), and any other request with
// "Method not found". A server notification is dropped.
//
// browser_close (board ab-v16.94.16, F1): with a context getter, the pinned MCP's browser_close disposes its browser
// backend and closes no connection, and it makes a new backend (and calls the getter again) only after the browser's
// `disconnected`. So after the MCP's answer to a browser_close call, and before that answer goes out, `closeBrowser`
// closes the session's browser connection (worker.ts): the MCP then connects again at its next tool that needs the browser.
// Board ab-v16.94.18 (review-143 notes 1 and 2): the MCP's SDK drops the answer of a request whose cancel it took, and
// the pinned browser_close disposes the backend all the same; so a cancel of the browser_close that runs never reaches
// the MCP: the call runs to its answer, `closeBrowser` runs, and the answer goes nowhere (the client cancelled it). And
// a request that came after a browser_close waits here until `closeBrowser` has ended, so that no call reaches the
// disposed backend; the MCP gets the held requests then, in their order. A cancel of a held request removes it.

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { AllowList } from "./allow-list.ts";

/** A JSON-RPC message as the transport carries it. */
export type Message = Record<string, unknown>;

/** The fixed configuration of C11 for `createConnection`. The CDP endpoint and the default context come through the context getter. */
export function mcpConfig(list: AllowList, folder: string): Record<string, unknown> {
  return {
    browser: { browserName: "chromium", isolated: false, launchOptions: {}, contextOptions: {} },
    // The capabilities named explicitly (the list's), never the MCP's default set.
    capabilities: [...list.capabilities],
    allowUnrestrictedFileAccess: false,
    outputDir: folder,
    timeouts: { action: 30_000 },
    // No tool of a page's own (WebMCP): its listing runs page code, and a page's tool is in no allow list.
    webmcp: false,
    saveSession: false,
  };
}

/**
 * A cancel's params that the pinned SDK acts on (review-121 note 2): params of its schema (a `requestId` that is an id,
 * a `reason` that is a string when there is one) with a `requestId` that is not falsy. It ignores any other cancel and
 * answers the call.
 */
export function mcpTakesCancel(p: unknown): boolean {
  if (p === null || typeof p !== "object" || Array.isArray(p)) return false;
  const { requestId: id, reason } = p as Message;
  return (typeof id === "string" || Number.isSafeInteger(id)) && id !== 0 && id !== "" && (!Object.hasOwn(p, "reason") || typeof reason === "string");
}

/** The client capabilities that the MCP server sees: roots only, which this file answers (C11). */
export const SERVER_SIDE_CAPABILITIES = Object.freeze({ roots: {} });

type Transport = {
  onmessage?: (m: Message) => void;
  onclose?: () => void;
  onerror?: (e: Error) => void;
  start(): Promise<void>;
  send(m: Message): Promise<void>;
  close(): Promise<void>;
};

export type McpServerSession = {
  /** A client message for the server (an `initialize` gets the server-side capabilities). */
  deliver(m: Message): void;
  /** Close the server object; its browser connection closes with it (the getter's `closeBrowser`). */
  close(): Promise<void>;
};

/** The pinned package's public entry (CommonJS), loaded on first use only: no other command loads Playwright. */
let entry: { createConnection: (config: Record<string, unknown>, getter?: () => Promise<unknown>) => Promise<{ connect(t: Transport): Promise<void>; close(): Promise<void> }> } | null = null;
export function mcpEntry(): NonNullable<typeof entry> {
  return (entry ??= createRequire(import.meta.url)("@playwright/mcp"));
}

/**
 * One MCP server object: `answer` gets each answer of the server to a client request; `context` gives the default
 * context of the session's browser connection (the ticket's), and runs only at the first tool that needs the browser.
 */
export async function openMcpServer(o: { list: AllowList; folder: string; context: () => Promise<unknown>; answer: (m: Message) => void; closeBrowser?: () => Promise<void>; trace?: (request: Message, reply: Message) => void }): Promise<McpServerSession> {
  const server = await mcpEntry().createConnection(mcpConfig(o.list, o.folder), o.context);
  const roots = [{ uri: pathToFileURL(o.folder).href, name: "agent-browser" }];
  /**
   * The browser_close call that runs (its id in JSON), from its delivery until `closeBrowser` has ended after the MCP's
   * answer; `cancelled` once its client cancelled it. Meanwhile each later message of the client waits in `held`.
   */
  let closing: { key: string; cancelled: boolean } | null = null;
  let held: Message[] = [];
  const t: Transport = {
    start: async () => {},
    send: async (m) => {
      if (typeof m.method === "string") {
        // A request of the server to the client: answered here, after the server has its handler for the answer.
        if (m.id !== undefined) {
          const reply: Message = m.method === "roots/list" ? { jsonrpc: "2.0", id: m.id, result: { roots } } : { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } };
          o.trace?.(m, reply);
          setImmediate(() => t.onmessage?.(reply));
        }
        return; // a notification: dropped
      }
      const c = closing;
      if (c === null || JSON.stringify(m.id) !== c.key) { o.answer(m); return; }
      await o.closeBrowser?.().catch(() => {});
      closing = null;
      if (!c.cancelled) o.answer(m);
      while (closing === null && held.length > 0) take(held.shift()!);
    },
    close: async () => { t.onclose?.(); },
  };
  /** One client message: to the MCP, or to `held` while a browser_close runs. */
  const take = (m: Message): void => {
    if (m.method === "notifications/cancelled" && mcpTakesCancel(m.params)) {
      const key = JSON.stringify((m.params as Message).requestId);
      // A held request that its client cancelled never reaches the MCP (the transport has freed its id).
      const i = held.findIndex((x) => x.id !== undefined && JSON.stringify(x.id) === key);
      if (i >= 0) { held.splice(i, 1); return; }
      // The browser_close that runs keeps running to its answer, which then goes nowhere.
      if (closing?.key === key) { closing.cancelled = true; return; }
    } else if (closing !== null && m.method !== "notifications/cancelled") { held.push(m); return; }
    if (m.method === "tools/call" && m.id !== undefined && (m.params as Message | undefined)?.name === "browser_close") closing = { key: JSON.stringify(m.id), cancelled: false };
    t.onmessage?.(m);
  };
  await server.connect(t);
  return {
    deliver(m) {
      if (m.method === "initialize" && m.params !== null && typeof m.params === "object") m = { ...m, params: { ...(m.params as Message), capabilities: SERVER_SIDE_CAPABILITIES } };
      take(m);
    },
    close: () => { held = []; return server.close(); },
  };
}
