// The MCP path as a part of `agent-browser service` (contracts C11, "The MCP path", and C12, `status`'s `mcp` and the
// hello's `mcp_token`; stage 1d of the self-contained agent browser, board ab-v16.94.5, part 2b). It holds the MCP port
// (port.ts: the listener and its admission), the transport behind it (transport.ts: the MCP sessions, the allow list,
// the workers) and the tickets of the MCP's own CDP connections (ticket.ts).
//
// Off by default (C11: stage 1d builds it off; it serves sessions from stage 3): the service makes this part only when
// systemd passes the socket of agent-browser-mcp.socket, or in `--test` mode with `--test-mcp-port` (main.ts). The
// service opens it before its control door (review-115 B1), so its state is fixed before the first hello. The part keeps
// the last set_sessions and gives it to the port at the open. While the port serves with its
// token check, the hello lists `mcp_token`, and `status`'s `mcp` gives the port's state and address (C12):
// `none` (no MCP port), `ready` (the port serves, at `127.0.0.1:<port>`), `closed` (the Mac: the port closes each
// connection until its TCP peer reader exists) and `failed` (the service could not take or open the port).

import type { Req } from "../control.ts";
import type { ServicePart } from "../part.ts";
import type { McpReadiness } from "./admission.ts";
import { readAllowList, type AllowList } from "./allow-list.ts";
import { McpPort, type McpPortOptions } from "./port.ts";
import { TICKET_KEY, Tickets } from "./ticket.ts";
import { McpTransport, type McpTransportOptions } from "./transport.ts";

/** `status`'s `mcp` (C12). */
export type McpState = { state: "none" | "ready" | "closed" | "failed"; address: string | null };

export type McpPartOptions = {
  /** The port: a TCP port on 127.0.0.1 (`--test-mcp-port`), the fd of agent-browser-mcp.socket, or why the take failed. */
  listen: McpPortOptions["listen"] | { failed: string };
  /** The state folder: the scopes' folders are `<state>/mcp/<scope>/`. */
  stateFolder: string;
  log: (line: string) => void;
  /** Tests only: the list, the port's reader, uid and platform, and the transport's test seams. */
  list?: AllowList;
  port?: Partial<Pick<McpPortOptions, "reader" | "uid" | "platform" | "compare" | "headersMs" | "idleMs">>;
  transport?: Partial<Pick<McpTransportOptions, "worker" | "perScope" | "perService">>;
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
  private failed = false;
  private last: Req | null = null;
  private stopping: Promise<void> | undefined;

  constructor(o: McpPartOptions) { this.o = o; }

  /**
   * Open the port, once the agent door runs: `url` gives the scope's CDP URL on the agent door, `readiness` what step 8
   * reads, and `use` the service's start at a use (board ab-v16.94.11). A failure leaves the part `failed` (fail closed:
   * no MCP port; the socket unit keeps the port).
   */
  async open(o: { url: (scope: string) => string; readiness: (scope: string) => McpReadiness; use?: McpPortOptions["use"] }): Promise<void> {
    try {
      if (this.o.openGate) await this.o.openGate;
      const listen = this.o.listen;
      if ("failed" in listen) throw new Error(listen.failed);
      const list = this.o.list ?? readAllowList();
      const transport = new McpTransport({
        list, stateFolder: this.o.stateFolder, log: this.o.log, ...this.o.transport,
        ticketUrl: (scope) => `${o.url(scope)}?${TICKET_KEY}=${this.tickets.mint(scope)}`,
      });
      const port = await McpPort.open({ listen, handler: transport, readiness: o.readiness, use: o.use, log: this.o.log, ...this.o.port });
      this.transport = transport; this.port = port;
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
    return { state: (this.o.port?.platform ?? process.platform) === "darwin" ? "closed" : "ready", address: `127.0.0.1:${this.port.port}` };
  }

  /** The hello's `mcp_token` while the port serves with its token check (C12). */
  features(): readonly string[] { return this.state().state === "ready" ? ["mcp_token"] : []; }

  status(): Record<string, unknown> { return { mcp: this.state() }; }

  setSessions(req: Req): void {
    this.last = req;
    this.port?.setSessions(req);
    // The folder of each scope that the snapshot does not name goes (C11; review-115 note 3).
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

  stop(): void { void this.close(); }

  /** Close the port and end every MCP session and worker. */
  close(): Promise<void> {
    return this.stopping ??= (async () => {
      await this.port?.stop();
      await this.transport?.stop();
    })();
  }
}
