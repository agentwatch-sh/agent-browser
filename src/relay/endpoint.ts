// `agent-browser relay --socket <path>`: agent mode's CDP endpoint (contract C11 in chrome-extension's
// docs/protocol.md, the master). The agentwatch daemon starts it with the agent Chrome's unit. Its standard input
// and output carry the bridge (C10), one JSON object per line; its standard error is the log. Clients connect to
// ws+unix://<socket>:/devtools/browser/<scope>. When standard input ends, the relay closes every connection, removes
// its socket and ends. It is the only way to drive the agent browser (board ab-v16.9.3: the CDP proxy is gone). With --peer-check
// (peer.ts; board ab-v16.51) the relay admits a connection only from a process of its scope's agentwatch session.

import { createServer, STATUS_CODES, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { chmodSync, rmSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import type { Duplex, Readable, Writable } from "node:stream";
import { WebSocketServer } from "ws";
import { socketAlive } from "../cdp.ts";
import { Bridge, MAX_REQUEST, type BridgeRequest } from "./bridge.ts";
import { Model, NOT_READY } from "./model.ts";
import { PEER_UNREAD, PeerGate, sessionRefusal, startPeerCheck, type Peer } from "./peer.ts";
import { REMOTE_SCOPE, SCOPE, type Root, type Roots } from "./scopes.ts";
import type { StageClipboard, StageFiles } from "./stage.ts";
import { ticketOf } from "../service/mcp/ticket.ts";

export { SCOPE };
export const NOT_FOUND = "Not found. Connect a CDP client to /devtools/browser/<scope>.";
export const FROM_PAGE = "A web page cannot connect to the agent browser.";
/** C11's 403 of a remote scope (stage 5 T2, board ab-v16.94.7.3): no CDP path but the MCP's own ticket connection. */
export const REMOTE_ONLY_MCP = "A session of another box reaches this agent browser only through its MCP.";

/**
 * `windowPerPage`: one window per page (the model's default: Linux only). `peerCheck`: true runs the peer check with
 * its self-test (--peer-check); the tests give a gate of their own, with a fake reader.
 */
export type RelayOptions = { socket: string; input: Readable; output: Writable; log: (line: string) => void; maxRequest?: number; downloadWaitMs?: number; windowPerPage?: boolean; peerCheck?: boolean | PeerGate;
  /** The input stage's build switch (stage.ts): the tests' option; with none, the switch (on since board ab-t30.24). */
  stage?: boolean;
  /** The model's random source (the tests: a seeded one, so that the stage's draws are the same in each run). */
  random?: () => number;
  /** The clipboard of the stage's paste (board ab-t30.19): the service's own display's owner, or the live rows' door (cli.ts). */
  clipboard?: StageClipboard | null;
  /** The scopes' folders of the stage's files (board ab-t30.12.2): the live rows' door (cli.ts); the service sets its own later. */
  files?: StageFiles | null;
  /**
   * The service's in-process bridge (stage 1b part 2 of the self-contained agent browser, board ab-v16.94.9): with it the
   * relay's model sends its requests to `transport.send` and takes the answers and the daemon's lines from the handlers
   * that `transport.bind` gets, in place of the standard output and input lines; `input` and `output` are then unused.
   */
  transport?: RelayTransport;
  /**
   * The service's MCP tickets (stage 1d part 2b of the self-contained agent browser, board ab-v16.94.5): a connection
   * from the service's own pid (`pid`) is admitted only with a live one-time ticket of its scope in the query, in place
   * of the walk (C11, the MCP inside the service); a ticket from any other pid admits nothing.
   */
  tickets?: RelayTickets;
  /**
   * The service's start at a use (board ab-v16.94.11): an upgrade that step 4 refuses because the link is down or the
   * allowlist is not confirmed yet goes to `wake(scope, peer, ticket)`. The service first runs the checks that it can make
   * while Chrome is down (steps 5 to 7 from its own snapshot) and gives their answer at once; only an upgrade that would
   * pass every check but the link waits while the service starts Chrome; then the checks run again. While `stopping()`
   * (the service stops Chrome for lack of use, or a start of Chrome runs with its move of the agent extension: board
   * ab-v16.81), step 4 counts the link as down.
   */
  use?: RelayUse;
  /**
   * The merge guard's hosts beside GitHub's (board ab-v16.99; C11, the merge guard): only the service's --test gives one, a
   * *.localhost stand-in of GitHub for the live check. The relay of the old path never has one.
   */
  mergeGuardHosts?: readonly string[];
  /**
   * The carrier of the remote MCP path (stage 5 T4, board ab-v16.94.7.5; C11, the remote MCP path): only the service's,
   * and only with its switch on. With it the carrier rule runs at each accept; a plain request of a peer that the rule
   * admits goes to `request` (the remote admission), and its upgrade gets the 403. Every other peer is as without it.
   */
  carrier?: RelayCarrier;
  /**
   * The blanket Chrome (board ab-4wh.3): the service's second agent Chrome, with its own empty profile, for the one local
   * scope with the operator's blanket approval. The relay then has a second model on its own bridge (`transport`: the
   * blanket link's carrier), whose lines may give that scope "*" (scopes.ts). `scope()` names the blanket scope now, or
   * null: an upgrade of that scope reaches only the second model (its connections see only the blanket Chrome's tabs),
   * and no other scope ever reaches it. The peer check's roots are the two models' lines together, each model's for its
   * own scopes only (the main line never names the blanket scope; the blanket line names only it).
   */
  blanket?: { transport: RelayTransport; scope: () => string | null; addressCheck?: (host: string) => Promise<string | null> } };
/** The carrier rule's verdict of a peer: the carrier (its pid), or why it is none. */
export type CarrierVerdict = { ok: true; pid: number } | { ok: false; reason: string };
/** The hook of the carrier's plain requests (src/service/mcp/remote.ts) and the carrier rule (src/service/admission.ts). */
export type RelayCarrier = {
  rule(socket: Socket): Promise<CarrierVerdict>;
  request(req: IncomingMessage, res: ServerResponse): void;
  /** A plain request on the MCP path (`/mcp` or below) of a peer that is no carrier: the rule's reason, for the log. */
  notCarrier?(reason: string): void;
};
/**
 * The service's start at a use: see RelayOptions.use. `wake` answers null (check again) or the answer to give at once
 * (the service's 403 or 503: the checks it made, or a start that failed).
 */
export type RelayUse = { stopping(): boolean; wake(scope: string, peer: Peer | null, ticket: string | null): Promise<[number, string] | null> };
/** The agents' traffic on the endpoint (board ab-v16.94.11): see Relay.traffic. */
export type RelayTraffic = { agents: number; busy: number; quietFor: number };
/**
 * The blanket scope's texts of step 4 (C11, the blanket profile; board ab-4wh): its model's link is the blanket link. The
 * service's start at a use gives `old` for a blanket receiver whose hello has no feature `blanket`.
 */
export const BLANKET_NOT_READY = {
  link: "The agent browser is not ready: the blanket profile's extension is not connected.",
  old: "The agent browser is not ready: the blanket profile's extension is too old for the blanket profile.",
} as const;
/** The texts of step 4 for which an upgrade waits for the service's start at a use. */
const WAKES: ReadonlySet<string> = new Set([NOT_READY.link, NOT_READY.allowlist, BLANKET_NOT_READY.link]);
/** Step 4's text of a scope's model: the blanket model's link or line that is not there names the blanket profile's extension. */
const stepFour = (model: Model, why: string): string => (model.blanket && (why === NOT_READY.link || why === NOT_READY.allowlist) ? BLANKET_NOT_READY.link : why);
/** The ticket check of the service's MCP connections (src/service/mcp/ticket.ts). */
export type RelayTickets = { readonly pid: number; take(ticket: string, scope: string, peerPid: number): boolean };
/** The calls between the model and the service's carrier: the same messages as the stdio lines of C10, as objects. */
export type RelayTransport = {
  send(line: string, msg: BridgeRequest): void;
  bind(to: { answer(msg: { id?: unknown; ok?: unknown; data?: unknown; error?: unknown }): void; daemon(msg: unknown): void }): void;
};
/**
 * `traffic()` (board ab-v16.94.11): `agents`, the open connections that the walk admitted (an MCP's own ticket connection
 * is none); `busy`, the messages of those connections that the model handles now; `quietFor`, the ms since the last such
 * message came or ended (Infinity before one). Nothing of the model's own (its bridge calls, a tab's events) and nothing
 * of an MCP's own connection counts (review-120b O2).
 */
export type Relay = { model: Model; closed: Promise<void>; stop: () => Promise<void>; peer: PeerGate | null; traffic: () => RelayTraffic;
  /** The blanket Chrome's model (RelayOptions.blanket), or null. */
  blanketModel: Model | null };

/**
 * The answer to a request that gets no connection, or the request's scope (and with the peer check the root that
 * admits it), in C11's order of the checks: (1) the Origin's 403; (2) the 404; (3) with the peer check, the 503 of a
 * failed self-test, else the peer's 403 of a peer that the relay could not read at the accept; (4) the "not ready"
 * 503s; with the peer check (5) the no-list 503 of a scope that the last line does not name, (6) the session check's
 * 403, (7) the no-list 503 of a named scope with no list; without it, the no-list 503 of a scope that the last line
 * gives no list. A browser's WebSocket always carries an Origin header. With `tickets` (the service), a connection from
 * the service's own pid passes step 6 only with a live ticket of its scope (C11, the MCP inside the service), and no
 * root admits it; each ticket in a request is gone after this check. A remote scope, `<box>/<session>` (stage 5 T2,
 * board ab-v16.94.7.3), has no CDP path: only the service's own pid with a live ticket of that scope (the MCP's browser
 * inside the service) passes; every other peer gets REMOTE_ONLY_MCP right after step 3 (with no peer check after step
 * 2; a relay with no tickets has no own pid), and the own pid with no such ticket gets it at step 6. A remote scope is
 * its own scope: a local scope with its box part's name never matches it.
 */
function admit(req: IncomingMessage, modelOf: (scope: string) => Model, gate: PeerGate | null, tickets?: RelayTickets, use?: RelayUse, carrier?: number): { scope: string; root: Root | null; own?: true; model: Model } | [number, string] | [number, string, string] {
  if (req.headers.origin !== undefined) return [403, FROM_PAGE];
  const m = /^\/devtools\/browser\/(.*)$/.exec(new URL(req.url ?? "/", "http://relay").pathname);
  if (req.method !== "GET" || !m || !(SCOPE.test(m[1]) || REMOTE_SCOPE.test(m[1]))) return [404, NOT_FOUND];
  const scope = m[1];
  // The model of the scope (board ab-4wh.3): the blanket scope's is the blanket Chrome's, each other scope's the main one.
  const model = modelOf(scope);
  const remote = REMOTE_SCOPE.test(scope);
  // The carrier (stage 5 T4; C11, the remote MCP path) gets no CDP path: T2's 403 for a remote scope, the session's 403 for a local one.
  if (carrier !== undefined) return [403, remote ? REMOTE_ONLY_MCP : sessionRefusal(carrier)];
  if (remote && !gate) return [403, REMOTE_ONLY_MCP];
  // Step 4, with the scope for the service's start at a use (a stop by use that runs counts as a link that is down).
  const notReady = () => model.notReady() ?? (use?.stopping() ? NOT_READY.link : null);
  if (!gate) {
    const why = notReady();
    if (why) return [503, stepFour(model, why), scope];
    return model.noList(scope) ? [503, NOT_READY.noList] : { scope, root: null, model };
  }
  if (gate.failed !== null) return [503, NOT_READY.cannotRead];
  const peer = gate.peerOf(req.socket);
  if (!peer) return [403, PEER_UNREAD];
  if (remote && (!tickets || peer.pid !== tickets.pid)) return [403, REMOTE_ONLY_MCP];
  const why = notReady();
  if (why) return [503, stepFour(model, why), scope];
  if (!model.named(scope)) return [503, NOT_READY.noList];
  if (tickets) {
    const ticket = ticketOf(req.url ?? "");
    const ticketOk = ticket !== null && tickets.take(ticket, scope, peer.pid);
    if (peer.pid === tickets.pid) {
      if (!ticketOk) return [403, remote ? REMOTE_ONLY_MCP : sessionRefusal(peer.pid)];
      return model.noList(scope) ? [503, NOT_READY.noList] : { scope, root: null, own: true, model };
    }
  }
  const root = gate.check(scope, peer);
  if (!root) return [403, sessionRefusal(peer.pid)];
  return model.noList(scope) ? [503, NOT_READY.noList] : { scope, root, model };
}

export async function startRelay(o: RelayOptions): Promise<Relay> {
  if (Buffer.byteLength(o.socket) > 103) throw new Error(`the socket path is longer than 103 bytes: ${o.socket}`);
  if (await socketAlive(o.socket)) throw new Error(`a relay already serves ${o.socket}`);
  rmSync(o.socket, { force: true });
  // The peer check's self-test runs before the endpoint socket listens (C11). A failed one fails closed: the relay
  // still serves, and each upgrade gets the 503 of step 3.
  const gate = o.peerCheck instanceof PeerGate ? o.peerCheck : o.peerCheck ? await startPeerCheck(o.socket, o.log) : null;
  const bridge = new Bridge(o.transport ? (line, msg) => o.transport!.send(line, msg) : (line) => { o.output.write(`${line}\n`); }, { maxRequest: o.maxRequest });
  // The blanket Chrome's model (board ab-4wh.3): each model's line gives the roots of its own scopes only, and the gate
  // holds both. Without the blanket Chrome the gate takes the main line's roots as they are.
  const blanket = o.blanket;
  let mainRoots: Roots = new Map(), blanketRoots: Roots = new Map();
  const onRoots = (roots: Roots, own: boolean) => {
    if (!blanket) { gate?.setRoots(roots); return; }
    const b = blanket.scope();
    if (own) blanketRoots = new Map([...roots].filter(([scope]) => scope === b));
    else mainRoots = new Map([...roots].filter(([scope]) => scope !== b));
    gate?.setRoots(new Map([...mainRoots, ...blanketRoots]));
  };
  const modelOpts = { downloadWaitMs: o.downloadWaitMs, windowPerPage: o.windowPerPage, peerCheck: gate !== null, remoteScopes: o.tickets !== undefined,
    ...(o.stage !== undefined ? { stage: o.stage } : {}), ...(o.random ? { random: o.random } : {}), ...(o.clipboard ? { clipboard: o.clipboard } : {}),
    ...(o.files ? { files: o.files } : {}), ...(o.mergeGuardHosts ? { mergeGuardHosts: o.mergeGuardHosts } : {}) };
  const model = new Model(bridge, o.log, { ...modelOpts, onRoots: (roots) => onRoots(roots, false) });
  const blanketBridge = blanket ? new Bridge((line, msg) => blanket.transport.send(line, msg), { maxRequest: o.maxRequest }) : null;
  // A remote scope is never a blanket scope (C12: "blanket" of a remote item is ignored), so the blanket model has none.
  const blanketModel = blanket && blanketBridge ? new Model(blanketBridge, (line) => o.log(`blanket: ${line}`), { ...modelOpts, remoteScopes: false, blanket: true, onRoots: (roots) => onRoots(roots, true), inputLock: model.stageLock,
    ...(blanket.addressCheck ? { addressCheck: blanket.addressCheck } : {}) }) : null;
  const modelOf = (scope: string): Model => (blanketModel && scope === blanket!.scope() ? blanketModel : model);
  const maxPayload = o.maxRequest ?? MAX_REQUEST;

  const plain = (req: IncomingMessage, res: ServerResponse) => {
    // Only the WebSocket upgrade gets a connection.
    const a = admit(req, modelOf, gate, o.tickets, o.use);
    const [status, body] = Array.isArray(a) ? a : [404, NOT_FOUND];
    res.writeHead(status, { "Content-Type": "text/plain" }).end(body);
  };
  // The carrier rule's verdict of each connection, read at its accept (stage 5 T4): only with the carrier's switch on.
  const carrier = o.carrier;
  const verdicts = new WeakMap<object, Promise<CarrierVerdict>>();
  const verdictOf = (socket: object): Promise<CarrierVerdict> => verdicts.get(socket) ?? Promise.resolve({ ok: false, reason: "no carrier rule ran for this connection" });
  // With the carrier, a request with no Host header gets the remote path's 403 (or the endpoint's 404), not Node's 400.
  const http = createServer(carrier ? { requireHostHeader: false } : {}, (req, res) => {
    if (!carrier) { plain(req, res); return; }
    void verdictOf(req.socket).then((v) => {
      if (v.ok) { carrier.request(req, res); return; }
      if (/^\/mcp(\/|\?|$)/.test(req.url ?? "")) carrier.notCarrier?.(v.reason);
      plain(req, res);
    });
  });
  // A longer client message closes its connection with 1009.
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload });
  // The peer read, at each accept, before the relay reads the request (C11, step 3).
  if (gate) http.on("connection", (socket) => gate.accept(socket));
  // The carrier rule, at each accept, before the relay reads the request: a rule that throws admits no carrier.
  if (carrier) http.on("connection", (socket: Socket) => { verdicts.set(socket, carrier.rule(socket).catch((e) => ({ ok: false as const, reason: `the carrier rule failed (${(e as Error).message})` }))); });
  let ended = false;
  // The agents' traffic (board ab-v16.94.11): see Relay.traffic.
  let agents = 0, busy = 0, lastMessage: number | null = null;
  const now = () => performance.now();
  /** The upgrades that wait for the service's start at a use: the relay's stop ends them. */
  const waiting = new Set<{ destroy(): void }>();
  http.on("upgrade", (req, socket, head) => {
    if (!carrier) { upgraded(req, socket, head); return; }
    // The carrier's upgrade gets the 403 (stage 5 T4): the carrier rule's verdict first.
    socket.on("error", () => {});
    waiting.add(socket);
    void verdictOf(req.socket).then((v) => { waiting.delete(socket); upgraded(req, socket, head, v.ok ? v.pid : undefined); });
  });
  function upgraded(req: IncomingMessage, socket: Duplex, head: Buffer, carrierPid?: number): void {
    const a = admit(req, modelOf, gate, o.tickets, o.use, carrierPid);
    // The service's start at a use (board ab-v16.94.11): the service's own checks answer at once; an upgrade that passes
    // them waits, then the checks run again.
    if (o.use && Array.isArray(a) && a.length === 3 && WAKES.has(a[1])) {
      const again = () => admit(req, modelOf, gate, o.tickets, o.use);
      // Node's server takes its error handler off an upgraded socket: a client's reset during the wait must not throw.
      socket.on("error", () => {});
      waiting.add(socket);
      void o.use.wake(a[2], gate?.peerOf(req.socket) ?? null, ticketOf(req.url ?? "")).then((r) => upgrade(r ?? again()), () => upgrade(again()));
      return;
    }
    upgrade(a);
    function upgrade(a: ReturnType<typeof admit>): void {
      // The check runs once, at the upgrade: the peer's pidfd closes now, in every path.
      waiting.delete(socket);
      gate?.release(socket);
      if (ended || socket.destroyed) { socket.destroy(); return; }
      if (Array.isArray(a)) {
        const [status, body] = a;
        socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        // Local (C11, the sign-in act's check 1): the agent door is a Unix socket of this user, admitted by its checks above; a
        // connection with the MCP's ticket has its MCP session's admission, which is local (the MCP port's uid check, walk
        // and token). A remote scope's connection (stage 5 T2) is the MCP's own for a session of another box: remote.
        // The model that admitted it (board ab-4wh.3: the blanket scope's is the blanket Chrome's).
        const model = a.model;
        const conn = model.open(a.scope, { send: (text) => { if (ws.readyState === ws.OPEN) ws.send(text); }, close: (code, reason) => ws.close(code, reason) }, a.root, REMOTE_SCOPE.test(a.scope) ? "remote" : "local");
        // An agent's connection counts by being open and by its messages; an MCP's own ticket connection not at all (its
        // tool calls count on the MCP path; its Playwright sends commands of its own, for example at a child target).
        const agent = !a.own;
        if (agent) agents++;
        ws.once("close", () => { if (agent) agents--; });
        ws.on("message", (data) => {
          let msg: unknown;
          try { msg = JSON.parse(String(data)); } catch { o.log(`relay: a message of ${String(data).length} bytes is not JSON`); return; }
          if (!agent) { void model.onMessage(conn, msg); return; }
          busy++;
          lastMessage = now();
          void model.onMessage(conn, msg).finally(() => { busy--; lastMessage = now(); });
        });
        // A message above MAX_REQUEST: ws closes the connection with 1009 and reports it here.
        ws.on("error", (e) => o.log(`relay: connection ${conn.id}: ${e.message}`));
        ws.on("close", () => { void model.close(conn); });
      });
    }
  }

  // The socket is created private: no moment exists in which another user could connect to it.
  const umask = process.umask(0o077);
  try { await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(o.socket, resolve); }); }
  finally { process.umask(umask); }
  chmodSync(o.socket, 0o600);
  const inode = statSync(o.socket).ino;

  const traffic = (): RelayTraffic => ({ agents, busy, quietFor: lastMessage === null ? Infinity : now() - lastMessage });
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    ended = true;
    // An upgrade that waits gets no answer: its socket closes, so the server's close does not wait for it.
    for (const w of waiting) w.destroy();
    waiting.clear();
    model.stop();
    blanketModel?.stop();
    await new Promise<void>((r) => { wss.close(() => r()); });
    http.closeAllConnections();
    await new Promise<void>((r) => http.close(() => r()));
    // Remove the socket only while it is still this relay's.
    if (statSync(o.socket, { throwIfNoEntry: false })?.ino === inode) rmSync(o.socket, { force: true });
    o.log("relay: stopped");
  })();

  // The blanket Chrome's bridge is always the service's carrier (board ab-4wh.3).
  if (blanket && blanketBridge && blanketModel) blanket.transport.bind({ answer: (msg) => blanketBridge.answer(msg), daemon: (msg) => { if (msg && typeof msg === "object") blanketModel.onDaemon(msg); } });
  if (o.transport) {
    // In the service: the carrier calls the model directly; the relay ends at its stop.
    o.transport.bind({ answer: (msg) => bridge.answer(msg), daemon: (msg) => { if (msg && typeof msg === "object") model.onDaemon(msg); } });
    o.log(`relay: ready on ${o.socket} (pid ${process.pid}; ${model.windowPerPage ? "one window per page" : "pages in tabs"}; the bridge in this process)`);
    let ended!: () => void;
    const closed = new Promise<void>((resolve) => { ended = resolve; });
    return { model, blanketModel, closed, stop: () => stop().then(() => ended()), peer: gate, traffic };
  }
  const lines = createInterface({ input: o.input, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let msg: any;
    try { msg = JSON.parse(line); } catch { o.log(`relay: a line of ${line.length} bytes from the daemon is not JSON`); return; }
    if (msg?.t === "res") bridge.answer(msg);
    else if (msg && typeof msg === "object") model.onDaemon(msg);
  });
  const closed = new Promise<void>((resolve) => { lines.once("close", () => { void stop().then(resolve); }); });
  o.log(`relay: ready on ${o.socket} (pid ${process.pid}; ${model.windowPerPage ? "one window per page" : "pages in tabs"})`);
  return { model, blanketModel, closed, stop, peer: gate, traffic };
}
