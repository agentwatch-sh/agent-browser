// The MCP path as a part of `agent-browser service` (contracts C11, "The MCP path", and C12, `status`'s `mcp` and the
// hello's `mcp_token`; stage 1d of the self-contained agent browser, board ab-v16.94.5, part 2b). It holds the MCP port
// (port.ts: the listener and its admission), the transport behind it (transport.ts: the MCP sessions, the allow list,
// the workers) and the tickets of the MCP's own CDP connections (ticket.ts).
//
// Off by default (C11: stage 1d builds it off; it serves sessions from stage 3): the service makes this part only when
// systemd passes the socket of agent-browser-mcp.socket, or in `--test` mode with `--test-mcp-port` (main.ts). The
// service opens it before its control door (review-115 B1), so its state is fixed before the first hello. The part keeps
// the last set_sessions and gives it to the port at the open. While the port serves with its
// token check, the hello lists `mcp_token`, and `status`'s `mcp` gives the port's state, its address and the open MCP
// sessions of each scope (C12; `sessions`, board ab-v16.94.24). The states:
// `none` (no MCP port), `ready` (the port serves, at `127.0.0.1:<port>`), `closed` (the Mac with a test's
// `macMeasured: false`: the port closes each connection) and `failed` (the service could not take or open the port).
//
// The remote MCP path (stage 5 T4, board ab-v16.94.7.5; C11, "The remote MCP path (stage 5)"; remote.ts): with `carrier`
// (the service's carrier rule can run: its switch is on and its peer reader is ready) the part also serves the carrier's
// requests from the agent door through the same transport, and while the port serves the hello lists `remote_scopes`
// beside `mcp_token` (C12, Q5). Each set_sessions gives the remote items to the remote path too. On the Mac the end of a
// remote name whose case twin lives (nameEnded) ends that name's MCP sessions (N4 of T2's review), and removes no folder.

import type { Req } from "../control.ts";
import type { ServicePart } from "../part.ts";
import type { McpReadiness } from "./admission.ts";
import { readAllowList, type AllowList } from "./allow-list.ts";
import { McpPort, type McpPortOptions } from "./port.ts";
import { macPortClosed } from "./proc.ts";
import { TICKET_KEY, Tickets } from "./ticket.ts";
import { McpTransport, type McpTransportOptions } from "./transport.ts";
import { RemoteMcp } from "./remote.ts";
import { REMOTE_SCOPE } from "../../relay/scopes.ts";
import type { IncomingMessage, ServerResponse } from "node:http";

/** `status`'s `mcp` (C12). */
export type McpState = { state: "none" | "ready" | "closed" | "failed"; address: string | null };

export type McpPartOptions = {
  /** The port: a TCP port on 127.0.0.1 (`--test-mcp-port`), the fd of agent-browser-mcp.socket, or why the take failed. */
  listen: McpPortOptions["listen"] | { failed: string };
  /** The state folder: the scopes' folders are `<state>/mcp/<scope>/`, a remote scope's `<state>/mcp-remote/<box>/<session>/`. */
  stateFolder: string;
  /** The Mac (APFS ignores case): the transport's rule of the folders of case twins (McpTransportOptions). */
  foldCase?: boolean;
  /** The agent door has a carrier rule that can run (stage 5 T4): the part serves the remote MCP path and lists `remote_scopes`. */
  carrier?: boolean;
  log: (line: string) => void;
  /** Tests only: the list, the port's reader, uid and platform, and the transport's test seams. */
  list?: AllowList;
  port?: Partial<Pick<McpPortOptions, "reader" | "uid" | "platform" | "macMeasured" | "compare" | "headersMs" | "idleMs" | "remote">>;
  transport?: Partial<Pick<McpTransportOptions, "worker" | "perScope" | "perService" | "perRemote" | "answerMax">>;
  /** Tests only: the open waits for this (the order of the service's start). */
  openGate?: Promise<void>;
  /** Tests only: the open waits for this after the port opens, before the service opens its other doors (a request then). */
  afterOpen?: (part: McpPart) => Promise<void>;
};

export class McpPart implements ServicePart {
  readonly ops = {};
  readonly tickets = new Tickets();
  private readonly o: McpPartOptions;
  private port: McpPort | null = null;
  private transport: McpTransport | null = null;
  private remote: RemoteMcp | null = null;
  private failed = false;
  private last: Req | null = null;
  private stopping: Promise<void> | undefined;

  constructor(o: McpPartOptions) { this.o = o; }

  /**
   * Open the port, once the agent door runs: `url` gives the scope's CDP URL on the agent door, `readiness` what step 8
   * reads, `use` the service's start at a use (board ab-v16.94.11), and `act` the service's sign-in act while it has one
   * (the stored sign-ins' MCP tools, board ab-v16.97.5), and `fetch` the service's PageFetch while it has one (board
   * ab-v16.102), and `pay` the service's card payments while it has the payment act (board ab-sta.7, only with
   * `--card-pay`). A failure leaves the part `failed` (fail closed: no MCP port; the
   * socket unit keeps the port).
   */
  async open(o: { url: (scope: string) => string; readiness: (scope: string) => McpReadiness; use?: McpPortOptions["use"]; act?: McpTransportOptions["act"]; fetch?: McpTransportOptions["fetch"]; pay?: McpTransportOptions["pay"]; blanket?: McpTransportOptions["blanket"] }): Promise<void> {
    try {
      if (this.o.openGate) await this.o.openGate;
      const listen = this.o.listen;
      if ("failed" in listen) throw new Error(listen.failed);
      const list = this.o.list ?? readAllowList();
      const transport = new McpTransport({
        list, stateFolder: this.o.stateFolder, foldCase: this.o.foldCase, log: this.o.log, ...this.o.transport, act: o.act, fetch: o.fetch, pay: o.pay, blanket: o.blanket,
        ticketUrl: (scope) => `${o.url(scope)}?${TICKET_KEY}=${this.tickets.mint(scope)}`,
      });
      const port = await McpPort.open({ listen, handler: transport, readiness: o.readiness, use: o.use, log: this.o.log, ...this.o.port });
      this.transport = transport; this.port = port;
      // The remote MCP path (stage 5 T4): the same transport, with the same step 8 and start at a use.
      if (this.o.carrier) this.remote = new RemoteMcp({ handler: transport, readiness: o.readiness, use: o.use, log: this.o.log, ...(this.o.port?.compare ? { compare: this.o.port.compare } : {}) });
      if (this.last) this.setSessions(this.last);
      if (this.o.afterOpen) await this.o.afterOpen(this);
    } catch (e) {
      this.failed = true;
      this.o.log(`mcp: the MCP port cannot open, so the service serves no MCP: ${(e as Error).message}`);
    }
  }

  /** The MCP's use of the browser (board ab-v16.94.11): its tool calls that run, and the ms since the last one; an open MCP session is no use. */
  activity(): { calls: number; quietFor: number } { return this.transport?.activity() ?? { calls: 0, quietFor: Infinity }; }

  /** The port while it runs (the tests). */
  get mcpPort(): McpPort | null { return this.port; }
  get mcpTransport(): McpTransport | null { return this.transport; }

  state(): McpState {
    if (this.port === null) return { state: this.failed ? "failed" : "none", address: null };
    return { state: macPortClosed(this.o.port?.platform ?? process.platform, this.o.port?.macMeasured) ? "closed" : "ready", address: `127.0.0.1:${this.port.port}` };
  }

  /** The hello's `mcp_token` while the port serves with its token check (C12), and `remote_scopes` with the remote MCP path (Q5). */
  features(): readonly string[] { return this.state().state === "ready" ? ["mcp_token", ...(this.remote ? ["remote_scopes"] : [])] : []; }

  /** The remote MCP path serves (the hello lists `remote_scopes`). */
  get remoteReady(): boolean { return this.remote !== null && this.state().state === "ready"; }

  /** A request of the carrier from the agent door (stage 5 T4): checks 1 to 4 of the remote MCP path, then the transport. */
  remoteRequest(req: IncomingMessage, res: ServerResponse): void {
    if (this.remote) { this.remote.request(req, res); return; }
    // No remote path (the part did not open): the MCP path's 404, and the connection closes.
    req.resume();
    const body = "Not found. Connect an MCP client to /mcp/<scope>.";
    res.writeHead(404, { "Content-Type": "text/plain", "Content-Length": Buffer.byteLength(body), Connection: "close" }).end(body);
  }

  /** C12's `status.mcp`: the state, the address and the open MCP sessions of each scope (board ab-v16.94.24; `{}` with no port). */
  status(): Record<string, unknown> { return { mcp: { ...this.state(), sessions: (this.port && this.transport?.openSessions()) ?? {} } }; }

  setSessions(req: Req): void {
    this.last = req;
    this.port?.setSessions(req);
    // The remote items (stage 5 T4): a dropped item or a changed token ends that scope's MCP sessions.
    this.remote?.setSessions(req);
    // The folder of each scope that the snapshot does not name goes (C11; review-115 note 3), also of a remote scope (Q7).
    const named = new Set([...(req.sessions as { scope: string }[]), ...((req.remote ?? []) as { scope: string }[])].map((s) => s.scope));
    if (this.port) void this.transport?.keepScopes(named);
  }

  sessionEnded(scope: string): void {
    // A snapshot kept for the open drops the scope too (C12: the service drops a session's fingerprint with the session).
    if (this.last) this.last = { ...this.last, sessions: (this.last.sessions as { scope: string }[]).filter((s) => s.scope !== scope) };
    this.port?.sessionEnded(scope);
    // The scope's folder goes with its files once its worker stopped (C11; review-115 note 3).
    if (this.port) void this.transport?.dropScope(scope, "its session ended");
  }

  /**
   * On the Mac the end of a name whose case twin lives goes only here (C12; the service's endScope): the folders are the
   * twin's, so nothing is removed. A remote name's own MCP sessions end (N4 of T2's review): the next request of its old
   * token gets the remote path's 401 once the snapshot drops the item.
   */
  nameEnded(scope: string): void {
    if (REMOTE_SCOPE.test(scope)) this.transport?.endSessions(scope);
  }

  /** The scope's MCP sessions end, and its folder stays (board ab-4wh.3: the blanket scope's end while its session lives). */
  endScopeSessions(scope: string): void { this.transport?.endSessions(scope); }

  stop(): void { void this.close(); }

  /** Close the port and end every MCP session and worker. */
  close(): Promise<void> {
    return this.stopping ??= (async () => {
      await this.port?.stop();
      await this.transport?.stop();
    })();
  }
}
