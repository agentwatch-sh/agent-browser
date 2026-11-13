// The agent door of `agent-browser service` (contract C12, "The command"; C11, the endpoint; board ab-v16.94.2, stage
// 1a). It is today's CDP endpoint with today's peer check: the relay's code (src/relay/endpoint.ts and peer.ts), which
// this file reuses with no change. The service takes the door's address from its arguments (--agent-door).
//
// The transport seam: this file is the only one that knows how the agent door listens (in stage 1a a Unix socket
// path, as today's endpoint): how the service takes the address from its arguments (agentDoorAddress), where the peer
// check's self-test runs (agentDoorPeerCheck), how the door listens (openAgentDoor) and how a client names it (C11's
// URL, agentDoorUrl). The door's request logic (the relay's admit and the model) and the rest of the service do not
// know the transport. With no bridge (stage 1a) the model's link stays down, and each upgrade that passes the peer
// check gets the 503 of the link (C11). Stage 1b part 2 (board ab-v16.94.9) gives the model the native link: its
// bridge is the service's carrier (link/carrier.ts), as calls inside the process.

import { resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { startRelay, type Relay, type RelayTickets, type RelayTraffic, type RelayTransport, type RelayUse } from "../relay/endpoint.ts";
import { selfTest, type PeerGate } from "../relay/peer.ts";

export type EndpointState = { form: string } | { form: null; reason: string };

export type AgentDoor = {
  readonly address: string;
  /** The URL that a client of `scope` connects to (C11), for the control door's `endpoint`. */
  url(scope: string): string;
  /** The peer check's form, or why it cannot run (C12's `endpoint` of `status` and of the `ready` event). */
  state(): EndpointState;
  /** The client connections that are open now. */
  clients(): number;
  /** The agents' traffic (board ab-v16.94.11): the agents' open connections, the client messages that run, the quiet time. */
  traffic(): RelayTraffic;
  stop(): Promise<void>;
};

/** The agent door's address from --agent-door: in stage 1a a Unix socket path, from the current folder. */
export const agentDoorAddress = (raw: string) => resolve(raw);

/** The peer check's self-test of the relay, which runs next to the agent door's socket (C11). */
export const agentDoorPeerCheck = (address: string) => selfTest(address);

/** C11's endpoint URL of a scope for a Unix socket path. */
export const agentDoorUrl = (address: string, scope: string) => `ws+unix://${address}:/devtools/browser/${scope}`;

/** The peer check's state for C12, from the relay's gate. */
export const endpointState = (gate: PeerGate): EndpointState => (gate.form !== null ? { form: gate.form } : { form: null, reason: gate.failed ?? "unknown" });

/**
 * Open the agent door at `address` with the gate of the service's peer check: the relay's endpoint and its model. With
 * `bridge` (the carrier) the model's bridge is the native link; with none it goes nowhere (no link line ever comes, so
 * no bridge request is made). With `tickets` (the MCP of stage 1d part 2b) the service's own pid connects only with a
 * one-time ticket (C11, the MCP inside the service). With `use` (board ab-v16.94.11) an upgrade that finds the browser
 * down waits for the service's start at a use.
 */
export async function openAgentDoor(o: { address: string; gate: PeerGate; log: (line: string) => void; bridge?: RelayTransport; tickets?: RelayTickets; use?: RelayUse; mergeGuardHosts?: readonly string[] }): Promise<AgentDoor & { relay: Relay }> {
  const input = new PassThrough();
  const output = new Writable({ write(_chunk, _enc, done) { done(); } });
  const relay: Relay = await startRelay({ socket: o.address, input, output, log: o.log, peerCheck: o.gate, transport: o.bridge, tickets: o.tickets, use: o.use,
    ...(o.mergeGuardHosts ? { mergeGuardHosts: o.mergeGuardHosts } : {}) });
  let stopping: Promise<void> | undefined;
  return {
    relay,
    address: o.address,
    url: (scope) => agentDoorUrl(o.address, scope),
    state: () => endpointState(o.gate),
    clients: () => relay.model.connectionCount,
    traffic: () => relay.traffic(),
    stop: () => stopping ??= (async () => { await relay.stop(); input.end(); })(),
  };
}
