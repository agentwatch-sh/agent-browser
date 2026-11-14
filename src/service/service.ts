// `agent-browser service`, stage 1a of the self-contained agent browser (the design
// docs/superpowers/specs/2026-11-09-self-contained-agent-browser-design.md, sections 5, 7.1 and 13.1; contract C12,
// docs/contracts/C12.md; board ab-v16.94.2). One process with two doors: the agent door (today's CDP endpoint with
// today's peer check, agent-door.ts) and the control door (control.sock, control.ts, with the admission of
// admission.ts). Off by default: nothing starts it before stage 2, and no install step of this repository writes a unit
// for it. Stage 1a has no Chrome, no list and no MCP: it has the ops config, set_sessions, session_ended, status and
// endpoint, and it answers each other op of C12 `unsupported` until the stage that adds it (C12, "The ops of stage 1a").
// Each later stage adds a part with its ops (part.ts): stage 1c (board ab-v16.94.4) the lists, the scopes, the prompts
// and the sign-ins (stage1c.ts); stage 1b part 1 (board ab-v16.94.3) the Chrome unit and its owner rule with the ops
// start and stop (unit/part.ts); stage 1b part 2 (board ab-v16.94.9) the native link (link/), the agent package
// (package/) and the model in this process, the X pointer, and the op sender. The connection tokens (board
// ab-v16.94.5, part 1; the token design, board ab-v16.94.10): the door's shape step takes set_sessions' mcp_token (control.ts), the service keeps
// each session's fingerprint in memory only, and status says whether a session has one; the hello gets the feature
// mcp_token with the token check of the MCP path (stage 1d). The MCP path (board ab-v16.94.5, part 2b; mcp/part.ts): off by
// default; with `mcp` (the socket of agent-browser-mcp.socket, or --test's --test-mcp-port) the service opens the MCP port
// before the control door (so the hello's features are fixed before the first hello), the agent door takes the MCP's
// one-time tickets, and status gives the port's state.

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NOT_READY } from "../relay/model.ts";
import { PEER_UNREAD, PeerGate, RootState, sessionRefusal, type Peer } from "../relay/peer.ts";
import { agentDoorPeerCheck, agentDoorUrl, endpointState, openAgentDoor, type AgentDoor, type EndpointState } from "./agent-door.ts";
import { daemonAdmission, loadPidfdOpen, systemdMainPid } from "./admission.ts";
import { ControlDoor, ERR, serviceHello, type Answer, type Handler, type Req } from "./control.ts";
import { Carrier } from "./link/carrier.ts";
import { McpPart, type McpPartOptions } from "./mcp/part.ts";
import { LinkReceiverPort, NativeLink, type LinkPeerCheck } from "./link/link.ts";
import { shimArgv, writeHostFiles } from "./link/manifest.ts";
import { endOldHosts, loadPidfds, type Pidfds } from "./link/old-host.ts";
import { linkPeerCheck } from "./link/peer.ts";
import { PointerOps, xWorld } from "./link/pointer-ops.ts";
import { pinnedLastFile, prepareAgentPackage } from "./package/crx.ts";
import { RECEIVER_ID } from "./package/pins.ts";
import { senderData, type SenderData } from "./package/sender.ts";
import type { ServicePart } from "./part.ts";
import type { ReceiverPort } from "./receiver.ts";
import { SignInsPart } from "./signins/part.ts";
import { SignInAct } from "./signins/act.ts";
import { xScreen } from "./signins/screen.ts";
import type { SignInStoreOptions } from "./signins/store.ts";
import { Stage1c } from "./stage1c.ts";
import { NOT_CONNECTED_TEXT } from "./signin/send-text.ts";
import { XClipboard } from "./unit/clipboard.ts";
import { ScopeFiles } from "../relay/scope-files.ts";
import { realDisplayFs } from "./unit/display.ts";
import { GoogleChromeTools, which, type ChromeTools } from "./unit/google-chrome.ts";
import { Owner, type UnitStateReader } from "./unit/owner.ts";
import { UnitPart, type UnitPartOptions } from "./unit/part.ts";
import type { UnitPaths } from "./unit/paths.ts";
import { Procs } from "./unit/procs.ts";
import type { UnitDeps } from "./unit/unit.ts";

export { serviceHello };

/** The ops of stage 1a (C12, "The ops of stage 1a"). */
export const STAGE_1A_OPS = ["config", "set_sessions", "session_ended", "status", "endpoint"] as const;
/**
 * Each op of C12 that no part of this service has yet, and the stage that adds it; until then it gets `unsupported`. Stage
 * 1e part 1 (board ab-v16.97.2) added the last ones, the stored sign-ins (signins/part.ts, with the feature sign_ins).
 */
export const LATER_OPS: Readonly<Record<string, string>> = {};
/** The op of stage 1b part 2 (C12, "The ops of stage 1b part 2"): the sender package. */
export const STAGE_1B2_OPS = ["sender"] as const;

/** The part of `sender` (C1, C9): the sender's ID, its version and the zip of the pinned commit's operator/ folder, made once. */
export function senderPart(make: () => SenderData = senderData): ServicePart {
  let made: SenderData | null = null;
  return {
    ops: {
      sender: () => {
        try { made ??= make(); } catch (e) { return { error: `the sender package cannot be read: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}` }; }
        return { data: { id: made.id, version: made.version, package: { ...made.package } } };
      },
    },
  };
}
/** The texts of stage 1a's one state, `off` (I2: the agent's text names no stop and no start). */
export const STAGE_1A_TEXTS = {
  agent_text: "The agent browser is not running.",
  operator_text: "The agent browser is not running: this agent-browser service has no Chrome yet (stage 1a of the self-contained agent browser).",
} as const;
/** At most this many ended scopes are kept in memory (the oldest goes first). */
const ENDED_MAX = 4096;

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const HEX40 = /^[0-9a-f]{40}$/;

/**
 * The commit that this checkout runs, for the hello (C12: for the daemon's pin check only, never for trust): the name of
 * a folder that is a 40-hex commit (agentwatch installs each pin at tools/agent-browser/<commit>, with no .git), else the
 * HEAD of a git checkout or worktree (read from its files, with no git process), else null.
 */
export function commitOf(root: string): string | null {
  const name = basename(resolve(root));
  if (HEX40.test(name)) return name;
  try {
    let gitdir = join(root, ".git");
    if (statSync(gitdir).isFile()) {
      const m = /^gitdir: (.+)$/m.exec(readFileSync(gitdir, "utf8"));
      if (!m) return null;
      gitdir = resolve(root, m[1].trim());
    }
    const head = readFileSync(join(gitdir, "HEAD"), "utf8").trim();
    if (HEX40.test(head)) return head;
    const ref = /^ref: (refs\/[A-Za-z0-9._/-]+)$/.exec(head)?.[1];
    if (!ref || ref.includes("..")) return null;
    let common = gitdir;
    try { common = resolve(gitdir, readFileSync(join(gitdir, "commondir"), "utf8").trim()); } catch {}
    for (const dir of [gitdir, common]) {
      try { const c = readFileSync(join(dir, ref), "utf8").trim(); if (HEX40.test(c)) return c; } catch {}
    }
    for (const line of readFileSync(join(common, "packed-refs"), "utf8").split("\n")) {
      const [sha, refName] = line.trim().split(" ");
      if (refName === ref && HEX40.test(sha)) return sha;
    }
  } catch {}
  return null;
}

/** This package's version (package.json) and the commit that it runs. */
export function packageInfo(): { version: string; commit: string | null } {
  return { version: JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version, commit: commitOf(ROOT) };
}

/** The default path of control.sock (C12, the door): $XDG_RUNTIME_DIR/agent-browser/ on Linux, ~/.cache/agent-browser/run/ on the Mac; null with no run folder. */
export function defaultControlDoor(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string | null {
  if (platform === "darwin") return join(home, ".cache", "agent-browser", "run", "control.sock");
  const run = env.XDG_RUNTIME_DIR;
  return run && isAbsolute(run) ? join(run, "agent-browser", "control.sock") : null;
}

/** A session of the last set_sessions; `mcp_token` is the fingerprint of its connection token, or null (C12, the token design: in memory only). */
type Session = { scope: string; repo: string | null; roots: { pid: number; start: number }[]; cgroup: string | null; lifetime_id: string | null; mcp_token: string | null };

/** The ops of stage 1a, with the service's state in memory. */
export class Stage1a implements Handler {
  private readonly helloOverride: Record<string, unknown> | undefined;
  private readonly pkg: { version: string; commit: string | null };
  private readonly agentDoor: { url(scope: string): string; state(): EndpointState };
  /** agentwatch's browser.* keys of the last `config` (stage 1a keeps them: no Chrome uses them yet). */
  config: Record<string, unknown> | null = null;
  private sessions: Session[] = [];
  /** The ended scopes, in memory only (stage 1c's part keeps the file of ended scopes and launch_check). */
  readonly ended = new Set<string>();

  /** The parts of the later stages, each with its ops (stage 1c's lists, scopes, prompts and sign-ins). */
  private readonly parts: readonly ServicePart[];

  constructor(o: { agentDoor: { url(scope: string): string; state(): EndpointState }; hello?: Record<string, unknown>; parts?: readonly ServicePart[] }) {
    this.agentDoor = o.agentDoor;
    this.pkg = packageInfo();
    this.helloOverride = o.hello;
    this.parts = o.parts ?? [];
  }

  /** The hello (C12), read at each connection: each part's features now (the MCP path's `mcp_token` while its port runs). */
  get hello(): Record<string, unknown> {
    return this.helloOverride ?? serviceHello(this.pkg.version, this.pkg.commit, this.parts.flatMap((p) => p.features?.() ?? []));
  }

  private partOf(op: string): ServicePart | undefined { return this.parts.find((p) => Object.hasOwn(p.ops, op)); }

  has(op: string): boolean { return (STAGE_1A_OPS as readonly string[]).includes(op) || this.partOf(op) !== undefined; }

  attach(emit: (ev: Record<string, unknown>) => void): void { for (const p of this.parts) p.attach?.(emit); }

  stopParts(): void { for (const p of this.parts) p.stop?.(); }

  /** A complete set_sessions came (the fail-closed watch's sessions_unread). */
  get sessionsComplete(): boolean { return this.sessionsRead; }
  private sessionsRead = false;

  endpointState(): EndpointState { return this.agentDoor.state(); }

  /** The repo of the scope's session in the last set_sessions, or null (C12's `sign_in` event; the sign-in act's log line). */
  repoOf(scope: string): string | null { return this.sessions.find((s) => s.scope === scope)?.repo ?? null; }

  /** A scope of a session of the last set_sessions (none that ended since): only such a scope's use starts Chrome (board ab-v16.94.11). */
  liveScope(scope: string): boolean { return this.sessions.some((s) => s.scope === scope); }

  /**
   * The roots of the sessions of the last set_sessions, by scope: the session check before a start at a use (board
   * ab-v16.94.11). A scope that two sessions share keeps the roots of both.
   */
  roots(): Map<string, { pid: number; start: number }[]> {
    const out = new Map<string, { pid: number; start: number }[]>();
    for (const s of this.sessions) out.set(s.scope, [...(out.get(s.scope) ?? []), ...s.roots.map((r) => ({ ...r }))]);
    return out;
  }

  status(): Record<string, unknown> {
    const data: Record<string, unknown> = {
      state: "off", ...STAGE_1A_TEXTS,
      chrome_kind: null, chrome_version: null, chrome_pid: null, extension_version: null, update: null,
      endpoint: this.agentDoor.state(), mcp: { state: "none", address: null },
      sessions: this.sessions.map((s) => ({ scope: s.scope, repo: s.repo, list: null, mcp_token: s.mcp_token !== null })), lists: [], last_stop: null, prompts: [],
    };
    // Each part gives its keys (the Chrome unit's part gives the state and its two texts), then its sentences for the
    // two texts (I2: no agent's text names a stop or a start).
    for (const p of this.parts) Object.assign(data, p.status?.());
    const agent = [data.agent_text as string], operator = [data.operator_text as string];
    for (const p of this.parts) {
      const n = p.notes?.();
      if (n) { agent.push(...n.agent); operator.push(...n.operator); }
    }
    return { ...data, agent_text: agent.join(" "), operator_text: operator.join(" ") };
  }

  handle(req: Req): Answer | Promise<Answer> {
    switch (req.op) {
      case "config": {
        const { t, id, op, by, ...keys } = req;
        this.config = keys;
        for (const p of this.parts) p.onConfig?.(keys);
        return { data: {} };
      }
      case "set_sessions":
        this.sessions = (req.sessions as Session[]).map((s) => ({ scope: s.scope, repo: s.repo, roots: s.roots.map((r) => ({ pid: r.pid, start: r.start })), cgroup: s.cgroup, lifetime_id: s.lifetime_id, mcp_token: s.mcp_token ?? null }));
        this.sessionsRead = true;
        for (const p of this.parts) p.setSessions?.(req);
        return { data: {} };
      case "session_ended": {
        const scope = req.scope as string;
        this.sessions = this.sessions.filter((s) => s.scope !== scope);
        this.ended.delete(scope);
        this.ended.add(scope);
        if (this.ended.size > ENDED_MAX) this.ended.delete(this.ended.values().next().value!);
        for (const p of this.parts) p.sessionEnded?.(scope);
        return { data: {} };
      }
      case "status": return { data: this.status() };
      case "endpoint":
        // A scope that the service does not have (no session of the last set_sessions, or it ended): no URL (C12).
        if (!this.sessions.some((s) => s.scope === req.scope)) return { error: ERR.noSession };
        return { data: { url: this.agentDoor.url(req.scope as string) } };
      default: {
        const part = this.partOf(req.op);
        return part ? part.ops[req.op](req) : { error: ERR.unsupported };
      }
    }
  }
}

export type ServiceOptions = {
  /** The agent door's address (--agent-door): in stage 1a a Unix socket path. */
  agentDoor: string;
  /** The path of control.sock (--control-door). */
  controlDoor: string;
  /** agentwatch's unit, whose MainPID rule 1 reads (--daemon-unit; default agentwatch.service). */
  daemonUnit?: string;
  /** The file of the daemon's expected command (--daemon-command). */
  daemonCommand: string;
  log: (line: string) => void;
  /** Tests only: the MainPID in place of the user's systemd. */
  mainPid?: () => Promise<number | null>;
  /**
   * Stage 1c's folders (--lists-folder and --state-folder; agentwatch's unit gives them, with no default): with them the
   * service has the lists, the scopes, the prompts and the sign-ins. `receiver`: the receiver port (stage 1b part 2
   * gives the native link's; with none, NO_RECEIVER).
   */
  lists?: { listsFolder: string; stateFolder: string; receiver?: ReceiverPort };
  /** The Chrome unit (stage 1b part 1): its folders, the owner rule's reader and the test seams. Without it, no Chrome. */
  unit?: UnitOptions;
  /**
   * The native link (stage 1b part 2), with the unit and the lists: the link socket's path (link.sock in the run folder),
   * and the test seams (the pidfd calls; the shim's Node and bin; no X pointer).
   */
  link?: { socket: string; pidfds?: Pidfds | { failed: string }; shim?: { node?: string; bin?: string }; xdotool?: string | null; agentPackage?: string; peer?: LinkPeerCheck };
  /**
   * The MCP path (stage 1d part 2b), with the lists (its state folder): the MCP port's socket (the fd of
   * agent-browser-mcp.socket, or --test's port on 127.0.0.1) and the test seams. Without it, no MCP port (C11: off by default).
   */
  mcp?: { listen: McpPartOptions["listen"] } & Partial<Omit<McpPartOptions, "listen" | "stateFolder" | "log">>;
  /**
   * The stored sign-ins (stage 1e part 1; C12, "The stored sign-ins"), with the lists (their state folder): the protections
   * of the service's memory (the command's non-dumpable start, protect.ts) and the test seams. Without it, the eight ops
   * get `unsupported` and the hello has no feature sign_ins (the Mac until stage 4).
   */
  signIns?: Omit<SignInStoreOptions, "stateFolder" | "log">;
  /**
   * The merge guard (board ab-v16.99; C11, the merge guard): its hosts are GitHub's; only `--test` adds a stand-in host
   * (`--test-merge-guard-host`, a *.localhost host), so a test page can never mark or unmark a real host.
   */
  mergeGuard?: { testHosts: readonly string[] };
};
/** The Chrome unit of stage 1b part 1 (src/service/unit/): its folders, the reader of the service's own unit state, and the test seams. */
export type UnitOptions = {
  paths: UnitPaths;
  /** The owner rule's reader (systemd, or `--test`'s). */
  owner: UnitStateReader;
  tools?: ChromeTools;
  procs?: Procs;
  /** Tests and `--test`: the part's other options; `unit` adds to the unit's real displays, processes and programs. */
  part?: Partial<Omit<UnitPartOptions, "unit">> & { unit?: Partial<UnitDeps> };
};
/** `lost` resolves with the reason when the owner rule says that the service no longer owns: the service then stops. */
export type Service = { control: ControlDoor; agent: AgentDoor; state: Stage1a; part: UnitPart | null; link: NativeLink | null; carrier: Carrier | null; mcp: McpPart | null; lost: Promise<string>; stop: () => Promise<void> };

/** The service does not own the Chrome unit at its start (the design, section 13.2): it exits, and the daemon owns. */
export class NotOwnerAtStart extends Error {}

/**
 * Start the service: the peer check's self-test (the relay's, next to the agent door), the control door with its
 * admission, then the agent door with the same peer reader. A self-test that fails makes both doors fail closed.
 */
export async function startService(o: ServiceOptions): Promise<Service> {
  const t = await agentDoorPeerCheck(o.agentDoor);
  o.log("failed" in t ? `service: the peer check cannot run: ${t.failed}` : `service: the peer check runs (${t.reader.form})`);
  const gate = "failed" in t ? new PeerGate({ failed: t.failed }) : new PeerGate({ reader: t.reader });
  const pidfd = await loadPidfdOpen();
  let agent: AgentDoor | null = null;
  let clipboard: XClipboard | null = null;
  // The Chrome unit (stage 1b part 1) and its owner rule: built now, begun only after the owner rule said yes.
  const owner = o.unit ? new Owner(o.unit.owner, o.log) : null;
  let state!: Stage1a;
  const procs = o.unit?.procs ?? new Procs();
  // The native link, the carrier and the X pointer (stage 1b part 2): with the unit and the lists only.
  const L = o.unit && o.lists && o.link ? o.link : null;
  let part: UnitPart | null = null;
  let stage1c: Stage1c | null = null;
  // The X pointer of C10's daemon ops: the unit's own Xvfb only, while the unit runs.
  const world = L ? xWorld({
    display: () => { const d = part?.unit.xDisplay(); return d && d.size ? { display: `:${d.display}`, xauth: d.xauth, size: { width: d.size[0], height: d.size[1] } } : null; },
    xdotool: L.xdotool !== undefined ? L.xdotool : which("xdotool"),
  }) : null;
  const ops = world ? new PointerOps(world) : null;
  const carrier = L ? new Carrier({
    send: (p) => link!.sendBridge(p), log: o.log, blocked: (b) => port!.blocked(b),
    pointer: ops && world ? { answer: (r) => ops.answer(r), pending: (id) => ops.pending(id), busy: () => ops.working(), kill: (k) => world.kill(k) } : undefined,
  }) : null;
  const link: NativeLink | null = L && o.unit ? new NativeLink({
    path: L.socket, log: o.log, carrier: carrier!,
    peer: L.peer ?? linkPeerCheck({ reader: "failed" in t ? { failed: t.failed } : t.reader, chrome: () => part?.unit.chromeId() ?? null, profile: o.unit.paths.profile, cmdline: (pid) => procs.cmdline(pid) }),
  }) : null;
  const port: LinkReceiverPort | null = link ? new LinkReceiverPort(link, carrier) : null;
  const pidfds = L ? (L.pidfds ?? await loadPidfds()) : null;
  part = o.unit && owner ? new UnitPart({
    paths: o.unit.paths, procs, owner, log: o.log,
    tools: o.unit.tools ?? new GoogleChromeTools({ tools: o.unit.paths.tools, log: o.log }),
    endpoint: () => endpointState(gate), sessionsComplete: () => state.sessionsComplete,
    activity: link && carrier ? {
      inFlight: () => carrier.inFlight(), idleFor: () => carrier.idleFor(), importing: () => link.importing(), sinceSend: () => link.sinceSend(),
      clients: () => (agent?.clients() ?? 0) > 0 || carrier.clients(),
    } : { clients: () => (agent?.clients() ?? 0) > 0 },
    // The use signal of the start and the stop by use (board ab-v16.94.11): only an agent's real activity. An agent's open
    // client connection of the agent door, a client message that the model handles (of any connection, the MCP's own
    // among them), a send that runs, an MCP tool call that runs; and the time since the last of these. An MCP's own
    // connection and an open MCP session count only by their traffic; nothing of the service's own (the model's bridge
    // calls, the lists' pushes, a tab's events) counts.
    use: {
      now: () => {
        const n: string[] = [];
        const t = agent?.traffic();
        if (t && t.agents > 0) n.push("client");
        if (t && t.busy > 0) n.push("request");
        if (link?.importing()) n.push("send");
        if (mcp && mcp.activity().calls > 0) n.push("mcp");
        return n;
      },
      quietFor: () => Math.min(agent?.traffic().quietFor ?? Infinity, link?.sinceSend() ?? Infinity, mcp?.activity().quietFor ?? Infinity),
    },
    ...(link ? {
      link: { ready: () => link.ready(), confirmed: () => stage1c?.listsConfirmed() ?? false, busy: () => link.busy(), scopesReady: () => link.scopesReady() },
      extensionVersion: () => link.version() ?? part?.unit.stagedPackage() ?? null,
      onReady: () => { const c = part?.unit.chromeId(); if (c && pidfds) endOldHosts({ procs, chrome: c, receiverId: RECEIVER_ID, own: shimArgv(L!.shim), pidfds, log: o.log }); },
      beforeStop: () => world?.kill("unitStop"),
    } : {}),
    ...o.unit.part,
    unit: {
      displayFs: realDisplayFs(() => procs.netUnix()), which: (n) => which(n),
      ...(L ? { prepare: { run: (copy) => prepareAgentPackage(copy, o.unit!.paths.tools, o.unit!.paths.chromes, L.agentPackage), lastFile: (copy) => pinnedLastFile(copy, o.unit!.paths.tools) } } : {}),
      ...o.unit.part?.unit,
    },
  }) : null;
  // The start at a use (board ab-v16.94.11): only a scope of a live session, and only while agent control is on.
  const model = () => (agent as (AgentDoor & { relay?: { model: { notReady(): string | null; sitesOf(scope: string): number | null; named(scope: string): boolean } } }) | null)?.relay?.model ?? null;
  // A request waits until the model is ready and its line names the scope: a launch after the service's start, or a
  // name that ended while Chrome was off, is named only after a push and its confirm (C4's restart gate and rule 2).
  const modelReady = (scope: string) => () => { const m = model(); return m !== null && m.notReady() === null && m.named(scope); };
  const mayWake = (scope: string) => !!part && state.liveScope(scope) && state.config?.control !== false;
  const peerReader = "failed" in t ? null : t.reader;
  // The checks that the service makes while Chrome is down, before a start at a use (C11's steps 5 to 7 from its own
  // snapshot, in their order): a scope that no confirm can name (a scope that two live sessions share), the session check
  // with the roots of the scope's sessions in set_sessions (the MCP's own pid only with a live ticket of the scope), a
  // scope with no list. Their answer comes at once, with no wait. A live session's scope that the next object leaves out
  // only for the restart gate or for rule 2 passes step 5: only a push and its confirm, which need Chrome, name it.
  const doorRefusal = (scope: string, peer: Peer | null, ticket: string | null): [number, string] | null => {
    const v = stage1c?.useView(scope);
    if (!v || !v.nameable) return [503, NOT_READY.noList];
    if (peer === null || peerReader === null) return [403, PEER_UNREAD];
    if (mcp && peer.pid === process.pid) {
      if (ticket === null || !mcp.tickets.alive(ticket, scope)) return [403, sessionRefusal(peer.pid)];
    } else if (RootState.read(peerReader, state.roots()).check(peerReader, scope, peer) === null) return [403, sessionRefusal(peer.pid)];
    return v.list === null ? [503, NOT_READY.noList] : null;
  };
  const doorWake = async (scope: string, peer: Peer | null, ticket: string | null): Promise<[number, string] | null> => {
    if (!mayWake(scope)) return null;
    const refused = doorRefusal(scope, peer, ticket);
    if (refused) return refused;
    const why = await part!.wake(modelReady(scope));
    return why === null ? null : [503, why];
  };
  // The MCP path's step 8 while Chrome is down (its steps 1 to 7 made the walk and the token check): a scope with no
  // list, or a list with no site, gets the no-list 503 at once; else a request that needs no browser passes with no
  // start, and only a tool call starts Chrome and waits (review-120b O1).
  const mcpRefusal = (scope: string): string | null => {
    if (!mayWake(scope)) return null;
    const v = stage1c?.useView(scope);
    return !v || !v.nameable || v.list === null || v.sites === 0 ? NOT_READY.noList : null;
  };
  const mcpWake = async (scope: string): Promise<string | null> => {
    if (!mayWake(scope)) return null;
    return mcpRefusal(scope) ?? part!.wake(modelReady(scope));
  };
  // A send in the hold-off after a fail-closed stop gets that moment's answer at once (its extension is not connected),
  // not a wait for a receiver that cannot come (review-120b's note).
  if (o.lists) stage1c = new Stage1c({ ...o.lists, ...(port ? { receiver: port } : {}), log: o.log, ...(part && port ? { wake: () => (part!.failClosedHold() ? Promise.resolve(NOT_CONNECTED_TEXT) : part!.wake(() => port.isUp())) } : {}) });
  // The MCP path (stage 1d part 2b): only with its socket, and with the state folder of the lists.
  const mcp = o.mcp && o.lists ? new McpPart({ ...o.mcp, stateFolder: o.lists.stateFolder, log: o.log }) : null;
  // The stored sign-ins (stage 1e part 1): only with their protections, and with the state folder of the lists.
  const signIns = o.signIns && o.lists ? new SignInsPart({ ...o.signIns, stateFolder: o.lists.stateFolder, log: o.log }) : null;
  const parts: ServicePart[] = [...(stage1c ? [stage1c] : []), ...(part ? [part] : []), ...(mcp ? [mcp] : []), senderPart(), ...(signIns ? [signIns] : [])];
  state = new Stage1a({ agentDoor: { url: (scope) => agentDoorUrl(o.agentDoor, scope), state: () => endpointState(gate) }, parts });
  const unit = o.daemonUnit ?? "agentwatch.service";
  // The MCP path opens before the control door (review-115 B1), so its state, and with it the hello's features, is fixed
  // before the first hello (C12). Its MCP connects back to the agent door with a ticket; until the agent door opens, step
  // 8 gives the model's not-ready text of a link that is down. A failed open leaves the state failed (no mcp_token).
  // The sign-in act, once the service makes it (below): the MCP's own tools of the stored sign-ins run through it.
  let act: SignInAct | null = null;
  if (mcp) {
    await mcp.open({
      url: (scope) => agentDoorUrl(o.agentDoor, scope),
      act: () => act,
      readiness: (scope) => {
        const m = model();
        // A stop by use that runs counts as a link that is down (board ab-v16.94.11): the request waits, then starts Chrome.
        return { controlOff: state.config?.control === false, notReady: m ? m.notReady() ?? (part?.idleStopping ? NOT_READY.link : null) : NOT_READY.link, sites: m ? m.sitesOf(scope) : null };
      },
      ...(part ? { use: { refusal: mcpRefusal, wake: mcpWake } } : {}),
    });
  }
  // The control door opens next, before the agent door and before any Chrome start (the design's build note 8).
  let control: ControlDoor;
  try {
    control = await ControlDoor.open({
      path: o.controlDoor, handler: state, log: o.log,
      admit: daemonAdmission({ reader: "failed" in t ? { failed: t.failed } : t.reader, pidfd, mainPid: o.mainPid ?? (() => systemdMainPid(unit)), commandFile: o.daemonCommand }),
    });
  } catch (e) { await mcp?.close(); throw e; }
  // The owner rule at the start: a service runs only to own (the design, section 13.2). The agent door is an owner part.
  if (owner && !(await owner.check("the service's start"))) {
    state.stopParts();
    await control.stop();
    throw new NotOwnerAtStart(`the service does not own the Chrome unit, so it exits: ${await owner.lost}`);
  }
  try {
    // The owner parts of the native link (the design, section 13.2): the host manifest with the service's shim, then the link socket.
    if (link && o.unit) {
      if (Buffer.byteLength(L!.socket) > 103) throw new Error(`the link socket's path is longer than 103 bytes: ${L!.socket}`);
      writeHostFiles({ state: o.unit.paths.state, profile: o.unit.paths.profile, socket: L!.socket, ...L!.shim });
      await link.start();
    }
    const opened = await openAgentDoor({ address: o.agentDoor, gate, log: o.log, bridge: carrier ? { send: (line, msg) => carrier.fromModel(line, msg), bind: (to) => carrier.bind(to) } : undefined, tickets: mcp?.tickets,
      ...(part ? { use: { stopping: () => part!.idleStopping, wake: doorWake } } : {}), ...(o.mergeGuard ? { mergeGuardHosts: o.mergeGuard.testHosts } : {}) });
    agent = opened;
    // The input stage's paste (board ab-t30.19; C11, the paste): the X selection owner of the unit's own Xvfb only, and only
    // while the unit runs (xDisplay: the display that the unit started, with its own X authority file).
    if (part && process.platform === "linux") {
      const unit = part;
      clipboard = new XClipboard({ display: () => { const d = unit.unit.xDisplay(); return d ? { display: d.display, xauth: d.xauth } : null; }, log: o.log });
      opened.relay.model.setClipboard(clipboard);
    }
    // The input stage's files (board ab-t30.12.2; C11, files): each scope's own folder under the state folder's scope-files,
    // which this start removes with every file of an earlier run. Only with the stage on; with it off the start removes the
    // folder and makes none (review-135b N4).
    if (o.unit && opened.relay.model.stageOn) opened.relay.model.setFiles(await ScopeFiles.open(o.unit.paths.state));
    else if (o.unit) await ScopeFiles.clear(o.unit.paths.state);
    // The sign-in act (stage 1e part 2, board ab-v16.97.4): with the stored sign-ins, the native link, the lists and the
    // Chrome unit. The model then answers AgentBrowser.signIn and signIns, and the MCP path serves browser_sign_in and
    // browser_sign_ins for a local admission (board ab-v16.97.5); without them the model refuses both methods, and the MCP
    // path lists neither tool (C11).
    if (signIns && link && port && stage1c && part) {
      const model = opened.relay.model, lists = stage1c;
      model.setSignIns(act = new SignInAct({
        model: model.actPort(),
        receiver: { features: () => port.features(), request: (op, body, ms) => port.act(op, body, ms) },
        store: signIns.store,
        screen: xScreen({
          display: () => { const d = part?.unit.xDisplay(); return d && d.size ? { display: `:${d.display}`, xauth: d.xauth, size: { width: d.size[0], height: d.size[1] } } : null; },
          xdotool: L!.xdotool !== undefined ? L!.xdotool : which("xdotool"),
        }),
        move: { move: (payload) => lists.moveSignIn(payload) },
        emit: (ev) => signIns.emitEvent(ev),
        log: o.log,
        repoOf: (scope) => state.repoOf(scope),
      }));
    }
  } catch (e) { state.stopParts(); await control.stop(); await link?.stop(); throw e; }
  const door = agent;
  // C10: the carrier's deadlines, each second.
  const expire = carrier ? setInterval(() => carrier.expire(), 1000) : null;
  expire?.unref();
  if (part) await part.begin();
  o.log(`service: ready (pid ${process.pid}; ${part ? `the Chrome unit runs${link ? ", with the native link" : ""}` : "stage 1a: no Chrome"})`);
  let stopping: Promise<void> | undefined;
  return {
    control, agent: door, state, part, link, carrier, mcp, lost: owner ? owner.lost : new Promise<string>(() => {}),
    stop: () => stopping ??= (async () => {
      state.stopParts();
      await mcp?.close();
      if (expire) clearInterval(expire);
      await part?.stop();
      await control.stop();
      // The model's last bridge.attachNew [false] goes to the receiver before the link closes (C10).
      await door.stop();
      clipboard?.close();
      await link?.flush(500);
      carrier?.stop();
      await link?.stop();
      o.log("service: stopped");
    })(),
  };
}
