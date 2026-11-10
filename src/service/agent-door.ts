// The agent door of `agent-browser service` (contract C12, "The command"; C11, the endpoint; board ab-v16.94.2, stage
// 1a). It is today's CDP endpoint with today's peer check: the relay's code (src/relay/endpoint.ts and peer.ts), which
// this file reuses with no change. The service takes the door's address from its arguments (--agent-door).
//
// The transport seam: this file is the only one that knows how the agent door listens (in stage 1a a Unix socket
// path, as today's endpoint): how the service takes the address from its arguments (agentDoorAddress), where the peer
// check's self-test runs (agentDoorPeerCheck), how the door listens (openAgentDoor) and how a client names it (C11's
// URL, agentDoorUrl). The door's request logic (the relay's admit and the model) and the rest of the service do not
// know the transport. In stage 1a no Chrome runs, so the bridge has no
// link: the model's link stays down, and each upgrade that passes the peer check gets the 503 of the link (C11).
// Stage 1b gives the bridge the native link.

import { resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { startRelay, type Relay } from "../relay/endpoint.ts";
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
 * Open the agent door at `address` with the gate of the service's peer check: the relay's endpoint, whose bridge goes
 * nowhere until stage 1b (no link line ever comes, so no bridge request is made).
 */
export async function openAgentDoor(o: { address: string; gate: PeerGate; log: (line: string) => void }): Promise<AgentDoor> {
  const input = new PassThrough();
  const output = new Writable({ write(_chunk, _enc, done) { done(); } });
  const relay: Relay = await startRelay({ socket: o.address, input, output, log: o.log, peerCheck: o.gate });
  let stopping: Promise<void> | undefined;
  return {
    address: o.address,
    url: (scope) => agentDoorUrl(o.address, scope),
    state: () => endpointState(o.gate),
    clients: () => relay.model.connectionCount,
    stop: () => stopping ??= (async () => { await relay.stop(); input.end(); })(),
  };
}
