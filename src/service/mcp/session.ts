// One Playwright MCP server object for one MCP session (contract C11, "The MCP inside the service"; stage 1d of the
// self-contained agent browser, board ab-v16.94.5, part 2b). The scope's worker (worker.ts) makes one for each MCP
// session, and npm test makes one with no browser (the allow list's test, the launch test). This file runs in the worker
// thread: it never imports the service's other parts.
//
// The server object comes from `createConnection` of the pinned `@playwright/mcp` package's public entry, with the fixed
// configuration of C11 (mcpConfig) and a context getter: the getter connects the MCP's Playwright back to the agent
// door's CDP path with the session's scope and a one-time ticket (connect, from the worker), and gives the MCP the
// default context. With a context getter `createConnection` never launches, downloads or binds a browser: its other path
// (`browser.cdpEndpoint` in the configuration) would start a pipe server for the browser in the temp folder and write a
// server registry entry, which another program of the user could use to reach the browser around the agent door.
//
// The transport here is a small one of the MCP SDK's shape (start, send, close): the client's messages come in through
// deliver(), and the server's answers go out through `answer`. The JSON-only transport of the service (transport.ts) can
// carry no request of the server to the client, so this file answers them: `roots/list` with the scope's folder (so the
// MCP's own file guardrail and its relative names use that folder), and any other request with "Method not found". A
// server notification has no stream to go to, and it is dropped.

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
export async function openMcpServer(o: { list: AllowList; folder: string; context: () => Promise<unknown>; answer: (m: Message) => void; trace?: (request: Message, reply: Message) => void }): Promise<McpServerSession> {
  const server = await mcpEntry().createConnection(mcpConfig(o.list, o.folder), o.context);
  const roots = [{ uri: pathToFileURL(o.folder).href, name: "agent-browser" }];
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
        return; // a notification: no stream
      }
      o.answer(m);
    },
    close: async () => { t.onclose?.(); },
  };
  await server.connect(t);
  return {
    deliver(m) {
      if (m.method === "initialize" && m.params !== null && typeof m.params === "object") m = { ...m, params: { ...(m.params as Message), capabilities: SERVER_SIDE_CAPABILITIES } };
      t.onmessage?.(m);
    },
    close: () => server.close(),
  };
}
