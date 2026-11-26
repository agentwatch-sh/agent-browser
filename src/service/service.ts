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
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NOT_READY } from "../relay/model.ts";
import { NO_SCOPE, PEER_UNREAD, PeerGate, RootState, sessionRefusal, type Peer, type PeerReader } from "../relay/peer.ts";
import { agentDoorPeerCheck, agentDoorUrl, endpointState, openAgentDoor, type AgentDoor, type EndpointState } from "./agent-door.ts";
import type { Relay } from "../relay/endpoint.ts";
import { carrierAdmission, daemonAdmission, loadPidfdOpen, systemdMainPid } from "./admission.ts";
import { launchdMainPid, loadMacLib, MAC_DAEMON_LABEL, macTcpReader, MacProcs } from "./mac.ts";
import { appVersion, chromeVersions, GiveBackWatcher, macStart } from "./unit/mac-chrome.ts";
import { CONTEXT_ROOTS_FEATURE, ControlDoor, ERR, serviceHello, type Answer, type Handler, type Req } from "./control.ts";
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
import { SignInsPart, type CardPayOptions } from "./signins/part.ts";
import { SignInAct } from "./signins/act.ts";
import { PayPrepare } from "./pay/act.ts";
import { PayAct } from "./pay/pay-act.ts";
import { PAY_TEXT } from "./pay/texts.ts";
import { payWorld, type PayWorldPort } from "./pay/world.ts";
import { WindowLock } from "./fetch/lock.ts";
import { PageFetch, type PageFetchOptions } from "./fetch/page-fetch.ts";
import { xScreen } from "./signins/screen.ts";
import type { SignInStoreOptions } from "./signins/store.ts";
import { Stage1c } from "./stage1c.ts";
import { blanketPaths, BlanketChrome, type BlanketChromeDeps } from "./blanket/chrome.ts";
import { AddressProxy, type AddressProxyOptions } from "./blanket/proxy.ts";
import { BlanketPart, type BlanketPartOptions } from "./blanket/part.ts";
import { boxNames } from "./blanket/box-names.ts";
import { checkHost, systemResolve } from "./fetch/address.ts";
import { BLANKET_NOT_READY } from "../relay/endpoint.ts";
import { NOT_CONNECTED_TEXT } from "./signin/send-text.ts";
import { XClipboard } from "./unit/clipboard.ts";
import { ScopeFiles, StateFolder } from "../relay/scope-files.ts";
import { ChromeDownloads } from "../relay/chrome-downloads.ts";
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
/**
 * The service's parts, in their order (startService). On the Mac (`darwin`) the end of a name that goes to no part
 * reaches the stage's files too (nameEnded): the name leaves their record of the scopes that wrote (board ab-v16.94.28,
 * review-162 N1). That part has no op of its own, so each op that no part has still gets `unsupported` (review-164 B1).
 * `files`: the stage's files, once the agent door opens. The tests give `darwin` (the service: process.platform).
 */
export function serviceParts(o: { stage1c: Stage1c | null; part: UnitPart | null; mcp: McpPart | null; signIns: SignInsPart | null; darwin: boolean; files: () => ScopeFiles | null; blanket?: BlanketPart | null }): ServicePart[] {
  const filesPart: ServicePart = { ops: {}, nameEnded: (scope) => o.files()?.nameEnded(scope) };
  // The blanket part first (board ab-4wh.3): its choice of the blanket scope comes before stage 1c's object, which leaves it out.
  return [...(o.blanket ? [o.blanket] : []), ...(o.stage1c ? [o.stage1c] : []), ...(o.part ? [o.part] : []), ...(o.mcp ? [o.mcp] : []), senderPart(), ...(o.signIns ? [o.signIns] : []), ...(o.darwin ? [filesPart] : [])];
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

/**
 * The names of a snapshot that the Mac's service drops (C12, set_sessions; board ab-v16.94.25): APFS ignores case, so two
 * scopes whose names differ only in case would share their folders (`<state>/mcp/<scope>/`, `<state>/scope-files/<scope>/`,
 * `<state>/session-lists/<scope>/`). Of the names that are the same in lower case (the names of sessions follow the scope
 * pattern, which is ASCII, so no two differ only in Unicode normalization; a remote item makes no folder before stage 5),
 * the one that the service already has (`had`) stays and each other is dropped; when it has none of them, each is
 * dropped. The map gives each dropped name the other names of its group.
 */
export function caseClashes(names: Iterable<string>, had: ReadonlySet<string>): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const n of new Set(names)) groups.set(n.toLowerCase(), [...(groups.get(n.toLowerCase()) ?? []), n]);
  const drop = new Map<string, string[]>();
  for (const group of groups.values()) {
    const stays = group.length > 1 ? group.filter((n) => had.has(n)) : group;
    for (const n of group) if (stays.length !== 1 || n !== stays[0]) drop.set(n, group.filter((m) => m !== n));
  }
  return drop;
}
/** The operator's sentence of the status for a dropped name (caseClashes). */
export const caseClashText = (scope: string, others: readonly string[]) => `The scope ${scope} has no agent browser: on this Mac its name and ${others.join(" and ")} differ only in case, so they would share one folder.`;

/**
 * The remote items of a snapshot that the Mac's service drops for their box part (C12, set_sessions; stage 5 T2, board
 * ab-v16.94.7.3): two boxes whose names differ only in case are one box on APFS, and C12's limit of 64 items of one `box`
 * would count them as two. caseClashes' rule, on the box names: of such boxes the one that the service already has
 * (`had`: the boxes of its remote items) stays, and each item of each other box is dropped; when it has none, each item
 * of each is dropped. The map gives each dropped scope the other boxes of its group.
 */
export function boxClashes(remote: readonly { scope: string; box: string }[], had: ReadonlySet<string>): Map<string, { box: string; others: string[] }> {
  const boxes = caseClashes(remote.map((x) => x.box), had);
  const out = new Map<string, { box: string; others: string[] }>();
  for (const x of remote) { const others = boxes.get(x.box); if (others) out.set(x.scope, { box: x.box, others }); }
  return out;
}
/** The operator's sentence of the status for a remote item that boxClashes dropped. */
export const boxClashText = (scope: string, box: string, others: readonly string[]) => `The scope ${scope} has no agent browser: on this Mac its box ${box} and ${others.join(" and ")} differ only in case, so they would share one folder.`;

/** A session of the last set_sessions; `mcp_token` is the fingerprint of its connection token, or null (C12, the token design: in memory only). */
type Session = { scope: string; repo: string | null; roots: { pid: number; start: number }[]; cgroup: string | null; lifetime_id: string | null; mcp_token: string | null };
/** A remote item of the last set_sessions (stage 5; board ab-v16.94.7.1): `<box>/<session>`, its box, its list and its fingerprint (in memory only). */
type Remote = { scope: string; box: string; list: string; mcp_token: string | null };

/** The ops of stage 1a, with the service's state in memory. */
export class Stage1a implements Handler {
  private readonly helloOverride: Record<string, unknown> | undefined;
  private readonly pkg: { version: string; commit: string | null };
  private readonly agentDoor: { url(scope: string): string; state(): EndpointState };
  /** agentwatch's browser.* keys of the last `config` (stage 1a keeps them: no Chrome uses them yet). */
  config: Record<string, unknown> | null = null;
  private sessions: Session[] = [];
  /** The `remote` items of the last set_sessions. */
  private remote: Remote[] = [];
  /** On the Mac: the names that the last set_sessions dropped, each with the operator's sentence (caseClashes, boxClashes). */
  private clashes = new Map<string, string>();
  private readonly foldCase: boolean;
  private readonly log: (line: string) => void;
  /** The ended scopes, in memory only (stage 1c's part keeps the file of ended scopes and launch_check). */
  readonly ended = new Set<string>();
  /**
   * The roots of each local session that ended since the last set_sessions (board ab-4wh.11): the relay's gate keeps
   * them as roots that refuse (contextRoots) until the next set_sessions, which names the live sessions again.
   */
  private endedRoots = new Map<string, { pid: number; start: number }[]>();
  /**
   * The roots of no scope of the last set_sessions (board ab-4wh.12; C12, `context_roots`): its `context_roots` (only
   * with the hello's feature) and, on the Mac, the roots of each session whose name it drops for a case twin. The
   * relay's gate keeps them as roots that refuse (contextRoots, under NO_SCOPE); each set_sessions replaces them.
   */
  private noScope: { pid: number; start: number }[] = [];
  /** The hello's feature context_roots (the service, startService): the state takes the field's roots. */
  private readonly takesContextRoots: boolean;
  /** After each set_sessions and session_ended: the relay's gate reads contextRoots again (board ab-4wh.10). */
  private readonly sessionsChanged: () => void;

  /** The parts of the later stages, each with its ops (stage 1c's lists, scopes, prompts and sign-ins). */
  private readonly parts: readonly ServicePart[];

  /**
   * `foldCase`: the Mac's rule of the names that differ only in case (caseClashes); `log`: the service's log;
   * `contextRoots`: the hello lists the feature context_roots, and the state takes the field (board ab-4wh.12).
   */
  constructor(o: { agentDoor: { url(scope: string): string; state(): EndpointState }; hello?: Record<string, unknown>; parts?: readonly ServicePart[]; foldCase?: boolean; log?: (line: string) => void; sessionsChanged?: () => void; contextRoots?: boolean }) {
    this.agentDoor = o.agentDoor;
    this.sessionsChanged = o.sessionsChanged ?? (() => {});
    this.takesContextRoots = o.contextRoots ?? false;
    this.foldCase = o.foldCase ?? false;
    this.log = o.log ?? (() => {});
    this.pkg = packageInfo();
    this.helloOverride = o.hello;
    this.parts = o.parts ?? [];
  }

  /** The hello (C12), read at each connection: each part's features now (the MCP path's `mcp_token` while its port runs). */
  get hello(): Record<string, unknown> {
    return this.helloOverride ?? serviceHello(this.pkg.version, this.pkg.commit, [...this.parts.flatMap((p) => p.features?.() ?? []), ...(this.takesContextRoots ? [CONTEXT_ROOTS_FEATURE] : [])]);
  }

  private partOf(op: string): ServicePart | undefined { return this.parts.find((p) => Object.hasOwn(p.ops, op)); }

  has(op: string): boolean { return (STAGE_1A_OPS as readonly string[]).includes(op) || this.partOf(op) !== undefined; }

  attach(emit: (ev: Record<string, unknown>) => void): void { for (const p of this.parts) p.attach?.(emit); }

  onHello(): void { for (const p of this.parts) p.onHello?.(); }

  stopParts(): void { for (const p of this.parts) p.stop?.(); }

  /** A complete set_sessions came (the fail-closed watch's sessions_unread). */
  get sessionsComplete(): boolean { return this.sessionsRead; }
  private sessionsRead = false;

  endpointState(): EndpointState { return this.agentDoor.state(); }

  /** The repo of the scope's session in the last set_sessions, or null (C12's `sign_in` event; the sign-in act's log line). */
  repoOf(scope: string): string | null { return this.sessions.find((s) => s.scope === scope)?.repo ?? null; }

  /**
   * A scope of a session of the last set_sessions (none that ended since), or of a remote item of it (stage 5 T4: the remote
   * MCP path's tool call): only such a scope's use starts Chrome (board ab-v16.94.11).
   */
  liveScope(scope: string): boolean { return this.sessions.some((s) => s.scope === scope) || this.remote.some((x) => x.scope === scope); }

  /**
   * The roots of the sessions of the last set_sessions, by scope: the session check before a start at a use (board
   * ab-v16.94.11). A scope that two sessions share keeps the roots of both.
   */
  roots(): Map<string, { pid: number; start: number }[]> {
    const out = new Map<string, { pid: number; start: number }[]>();
    for (const s of this.sessions) out.set(s.scope, [...(out.get(s.scope) ?? []), ...s.roots.map((r) => ({ ...r }))]);
    return out;
  }

  /**
   * The relay's gate's roots that admit nothing (boards ab-4wh.9 to ab-4wh.12; C11, the peer check): roots(), the roots
   * of each session that ended since the last set_sessions, and the roots of no scope of the last set_sessions (under
   * NO_SCOPE). A root whose process has exited changes no answer.
   */
  contextRoots(): Map<string, { pid: number; start: number }[]> {
    const out = this.roots();
    for (const [scope, list] of this.endedRoots) out.set(scope, [...(out.get(scope) ?? []), ...list.map((r) => ({ ...r }))]);
    if (this.noScope.length > 0) out.set(NO_SCOPE, this.noScope.map((r) => ({ ...r })));
    return out;
  }

  private changed(): void { try { this.sessionsChanged(); } catch (e) { this.log(`service: the gate's roots could not be read again (${(e as Error).message})`); } }

  status(): Record<string, unknown> {
    const data: Record<string, unknown> = {
      state: "off", ...STAGE_1A_TEXTS,
      chrome_kind: null, chrome_version: null, chrome_pid: null, extension_version: null, update: null,
      endpoint: this.agentDoor.state(), mcp: { state: "none", address: null, sessions: {} },
      sessions: this.sessions.map((s) => ({ scope: s.scope, repo: s.repo, list: null, mcp_token: s.mcp_token !== null })), lists: [], last_stop: null, prompts: [],
    };
    // Each remote item, with mcp_token true (the shape step takes no remote item with null): status never gives the
    // fingerprint. Only with the hello's remote_scopes (C12's feature rule; stage 5 T4).
    if ((this.hello.features as string[] | undefined)?.includes("remote_scopes")) data.remote = this.remote.map((x) => ({ scope: x.scope, box: x.box, list: x.list, mcp_token: x.mcp_token !== null }));
    // Each part gives its keys (the Chrome unit's part gives the state and its two texts), then its sentences for the
    // two texts (I2: no agent's text names a stop or a start).
    for (const p of this.parts) Object.assign(data, p.status?.());
    for (const p of this.parts) if (p.statusSessions && Array.isArray(data.sessions)) data.sessions = p.statusSessions(data.sessions as Record<string, unknown>[]);
    const agent = [data.agent_text as string], operator = [data.operator_text as string];
    for (const p of this.parts) {
      const n = p.notes?.();
      if (n) { agent.push(...n.agent); operator.push(...n.operator); }
    }
    for (const sentence of this.clashes.values()) operator.push(sentence);
    return { ...data, agent_text: agent.join(" "), operator_text: operator.join(" ") };
  }

  /**
   * The end of a scope: C12's session_ended, and the drop of a remote item by set_sessions (stage 5 T2, Q7). On the Mac
   * the end of a name that the service does not have, with the lower-case form of a name that it has, goes to no part
   * (C12; review-159 B1): on APFS its folders are the live scope's, and the parts remove by name. The parts still record
   * the end (nameEnded): the file of ended scopes gets the name (board ab-v16.94.26).
   */
  private endScope(scope: string, op: "session_ended" | "set_sessions"): void {
    const live = [...this.sessions.map((s) => s.scope), ...this.remote.map((x) => x.scope)];
    const theirs = this.foldCase && !live.includes(scope) ? live.filter((n) => n.toLowerCase() === scope.toLowerCase()) : [];
    for (const s of this.sessions) if (s.scope === scope) this.endedRoots.set(scope, [...(this.endedRoots.get(scope) ?? []), ...s.roots.map((r) => ({ ...r }))]);
    this.sessions = this.sessions.filter((s) => s.scope !== scope);
    this.clashes.delete(scope);
    this.ended.delete(scope);
    this.ended.add(scope);
    if (this.ended.size > ENDED_MAX) this.ended.delete(this.ended.values().next().value!);
    if (theirs.length > 0) {
      this.log(`service: ${op}: the end of the scope ${scope} goes to no part: on the Mac its name and ${theirs.join(" and ")} differ only in case, so its folders are theirs`);
      this.eachPart((p) => p.nameEnded?.(scope));
      return;
    }
    this.eachPart((p) => p.sessionEnded?.(scope));
  }

  /**
   * One hook of every part, in order (the review of ab-4wh.13, m3): a part that throws stops no later part, so each part,
   * also the MCP part's port and its walk, reads a set_sessions or a session_ended on the same terms as the relay's gate
   * (handle's finally): the state's sessions changed before the parts ran. The first error comes again after the last part.
   */
  private eachPart(hook: (p: ServicePart) => void): void {
    let failed: { error: unknown } | null = null;
    for (const p of this.parts) {
      try { hook(p); } catch (error) { failed ??= { error }; }
    }
    if (failed) throw failed.error;
  }

  handle(req: Req): Answer | Promise<Answer> {
    if (req.op !== "set_sessions" && req.op !== "session_ended") return this.op(req);
    // After each set_sessions and session_ended the relay's gate reads the roots again (board ab-4wh.10), also when a
    // part throws (the review of ab-4wh.10, m4): the state's sessions changed before the parts ran.
    try { return this.op(req); } finally { this.changed(); }
  }

  private op(req: Req): Answer | Promise<Answer> {
    switch (req.op) {
      case "config": {
        const { t, id, op, by, ...keys } = req;
        this.config = keys;
        for (const p of this.parts) p.onConfig?.(keys);
        return { data: {} };
      }
      case "set_sessions": {
        // On the Mac a name that differs from another only in case gets no scope (C12; board ab-v16.94.25), and neither
        // does a remote item whose box differs from another box only in case (stage 5 T2): the service and its parts keep
        // the snapshot without it.
        const remote = (req.remote ?? []) as Remote[];
        const had = new Set([...this.sessions.map((s) => s.scope), ...this.remote.map((x) => x.scope)]);
        this.clashes = new Map();
        if (this.foldCase) {
          for (const [scope, others] of caseClashes([...(req.sessions as Session[]), ...remote].map((s) => s.scope), had)) {
            this.log(`service: set_sessions: the scope ${scope} gets no browser: on the Mac its name and ${others.join(" and ")} differ only in case, so they would share one folder`);
            this.clashes.set(scope, caseClashText(scope, others));
          }
          // The box rule runs on the items that the name rule keeps.
          for (const [scope, { box, others }] of boxClashes(remote.filter((x) => !this.clashes.has(x.scope)), new Set(this.remote.map((x) => x.box)))) {
            this.log(`service: set_sessions: the scope ${scope} gets no browser: on the Mac its box ${box} and ${others.join(" and ")} differ only in case, so they would share one folder`);
            this.clashes.set(scope, boxClashText(scope, box, others));
          }
        }
        const kept = this.clashes.size === 0 ? req : { ...req, sessions: (req.sessions as Session[]).filter((s) => !this.clashes.has(s.scope)), remote: remote.filter((x) => !this.clashes.has(x.scope)) };
        const before = this.remote.map((x) => x.scope);
        // The roots of the sessions that ended refuse until now (board ab-4wh.11): this snapshot names the live ones.
        this.endedRoots = new Map();
        // The roots of no scope (board ab-4wh.12): the snapshot's context_roots (with the feature; the door checked their
        // shape), and the roots of each session that the Mac's rule above drops, which still refuse.
        const unnamed = [...(this.takesContextRoots && Array.isArray(req.context_roots) ? req.context_roots as Session["roots"] : []),
          ...(req.sessions as Session[]).filter((s) => this.clashes.has(s.scope)).flatMap((s) => s.roots)];
        this.noScope = unnamed.map((r) => ({ pid: r.pid, start: r.start }));
        this.sessions = (kept.sessions as Session[]).map((s) => ({ scope: s.scope, repo: s.repo, roots: s.roots.map((r) => ({ pid: r.pid, start: r.start })), cgroup: s.cgroup, lifetime_id: s.lifetime_id, mcp_token: s.mcp_token ?? null }));
        this.remote = ((kept.remote ?? []) as Remote[]).map((x) => ({ scope: x.scope, box: x.box, list: x.list, mcp_token: x.mcp_token ?? null }));
        this.sessionsRead = true;
        // A remote item that the snapshot drops ends its scope as session_ended ends a local one (stage 5 T2, Q7), before
        // the parts get the snapshot: the file of ended scopes first, then end_scope, and the next object leaves it out.
        const now = new Set(this.remote.map((x) => x.scope));
        // An end or a part that throws stops no other part (the review of ab-4wh.13, m3): the first error comes at the end.
        let failed: { error: unknown } | null = null;
        for (const scope of before) if (!now.has(scope)) { try { this.endScope(scope, "set_sessions"); } catch (error) { failed ??= { error }; } }
        try { this.eachPart((p) => p.setSessions?.(kept)); } catch (error) { failed ??= { error }; }
        if (failed) throw failed.error;
        return { data: {} };
      }
      case "session_ended":
        this.endScope(req.scope as string, "session_ended");
        return { data: {} };
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
  mcp?: { listen: McpPartOptions["listen"] } & Partial<Omit<McpPartOptions, "listen" | "stateFolder" | "log" | "context">>;
  /**
   * The stored sign-ins (stage 1e part 1; C12, "The stored sign-ins"), with the lists (their state folder): the protections
   * of the service's memory (the command's non-dumpable start, protect.ts) and the test seams. Without it, the eight ops
   * get `unsupported` and the hello has no feature sign_ins (the Mac until stage 4).
   */
  signIns?: Omit<SignInStoreOptions, "stateFolder" | "log">;
  /**
   * Tests only: the card payments (C12, "The card payments"; board ab-sta.5), with the stored sign-ins and the tests' own
   * facts, preparation and act: the ops `card_seal` and `pay_approve`, the payment's events and the hello's feature
   * `card_pay`. main.ts never gives it.
   */
  cardPay?: CardPayOptions;
  /**
   * The card payment (C11, the card payment; C12, the card payments; board ab-sta.7): `--card-pay`, off by default
   * (agentwatch does not pass it). With the stored sign-ins it gives the feature `card_pay`, the real payment requests
   * (pay/request.ts) with the real preparation (pay/act.ts, with the one private window's lock) and act (pay/pay-act.ts)
   * once the native link, the lists and the Chrome unit run, and the MCP path's browser_pay and browser_pay_status.
   * `providerOrigins` and `providerApis`: tests only (the test merchant's provider: its frame origin and its API origin):
   * main.ts gives them only from `--test-provider-origin` and `--test-provider-api` in `--test` mode (*.localhost origins;
   * board ab-sta.8).
   */
  payAct?: { providerOrigins?: readonly string[]; providerApis?: readonly string[] };
  /**
   * The merge guard (board ab-v16.99; C11, the merge guard): its hosts are GitHub's; only `--test` adds a stand-in host
   * (`--test-merge-guard-host`, a *.localhost host), so a test page can never mark or unmark a real host.
   */
  mergeGuard?: { testHosts: readonly string[] };
  /**
   * Tests only (the MCP live check's PageFetch rows, test/live/mcp-live/fetch-service.ts): PageFetch's `admit`, the one
   * local test name that passes the address rule. No CLI flag sets it.
   */
  pageFetch?: Pick<PageFetchOptions, "admit">;
  /** The input stage (C11, the build switch): the tests' option of the relay's model; else the build switch. */
  stage?: boolean;
  /**
   * The carrier's switch (stage 5 T4, board ab-v16.94.7.5; C11, the remote MCP path; C12, `--gateway-label` and
   * `--gateway-command`): the pid of the gateway's job at each accept (the Mac: launchctl's; `--test`: the harness's fake
   * gateway, `--test-gateway-pid`) and the file of the gateway's command. Without it (the default) the agent door has no
   * carrier and the hello has no `remote_scopes`. With the MCP path only.
   */
  gateway?: { mainPid: () => Promise<number | null>; commandFile: string };
  /**
   * The blanket profile (board ab-4wh.3; C12, the blanket profile): on Linux with the unit, the lists and the native link,
   * unless `off`. Tests only: the blanket Chrome's and the part's seams, and the address proxy's (board ab-4wh.6: the
   * blanket live check's resolver and its local stand-in of a public host; no CLI flag sets them).
   */
  blanket?: { off?: boolean; chrome?: Partial<Omit<BlanketChromeDeps, "paths">>; part?: Partial<Omit<BlanketPartOptions, "chrome" | "port" | "model" | "removeCopy">>; addressCheck?: (host: string) => Promise<string | null>; peerReader?: PeerReader; proxy?: Partial<Omit<AddressProxyOptions, "log">> };
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
export type Service = { control: ControlDoor; agent: AgentDoor & { relay: Relay }; state: Stage1a; part: UnitPart | null; link: NativeLink | null; carrier: Carrier | null; mcp: McpPart | null; lost: Promise<string>; stop: () => Promise<void>;
  /** The blanket profile (board ab-4wh.3): its part, Chrome and link, or null. */
  blanket?: { part: BlanketPart; chrome: BlanketChrome; link: NativeLink; carrier: Carrier } | null };

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
  // The Mac (board ab-v16.94.6): libSystem's reads of processes and sockets (mac.ts), for the unit, the control door's
  // admission, the link's peer check and the MCP port's reader. A load that fails leaves each of them failed closed.
  const darwin = process.platform === "darwin";
  const macLib = darwin ? await loadMacLib() : null;
  const macProcs = macLib && !("failed" in macLib) ? new MacProcs(macLib) : null;
  if (macLib && "failed" in macLib) o.log(`service: the Mac's process reads cannot run: ${macLib.failed}`);
  let agent: (AgentDoor & { relay: Relay }) | null = null;
  let clipboard: XClipboard | null = null;
  // The Chrome unit (stage 1b part 1) and its owner rule: built now, begun only after the owner rule said yes.
  const owner = o.unit ? new Owner(o.unit.owner, o.log) : null;
  let state!: Stage1a;
  const procs = o.unit?.procs ?? macProcs ?? new Procs();
  // The native link, the carrier and the X pointer (stage 1b part 2): with the unit and the lists only.
  const L = o.unit && o.lists && o.link ? o.link : null;
  let part: UnitPart | null = null;
  let stage1c: Stage1c | null = null;
  // The X pointer of C10's daemon ops: the unit's own Xvfb only, while the unit runs (none on the Mac).
  const world = L && !darwin ? xWorld({
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
  // The blanket profile (board ab-4wh.3; C12, the blanket profile): a second Chrome on its own empty folder, its own link
  // (link-blanket.sock) whose peer check admits only the blanket Chrome's shim, its own carrier (with no X pointer: the
  // input goes through CDP, so no X event of the blanket scope can reach a window of the main Chrome) and its own port.
  // Linux only (the Mac later).
  const B = L && o.unit && !darwin && process.platform === "linux" && !o.blanket?.off ? blanketPaths(o.unit.paths.state, L.socket) : null;
  let blanketPart: BlanketPart | null = null;
  const blanketChrome = B ? new BlanketChrome({
    paths: B, procs, log: o.log,
    launch: (extra) => part?.unit.blanketLaunch(B.profile, B.home, extra) ?? null,
    // The address proxy (board ab-4wh.6): the blanket Chrome reaches the network only through it.
    proxy: new AddressProxy({ log: o.log, ...o.blanket?.proxy }),
    hostFiles: () => { writeHostFiles({ state: o.unit!.paths.state, profile: B.profile, socket: B.socket, wrapper: B.wrapper, ...L!.shim }); },
    ...o.blanket?.chrome,
  }) : null;
  const blanketCarrier = B ? new Carrier({ send: (p) => blanketLink!.sendBridge(p), log: (l) => o.log(`blanket: ${l}`) }) : null;
  const blanketLink: NativeLink | null = B && blanketChrome && blanketCarrier ? new NativeLink({
    path: B.socket, log: (l) => o.log(`blanket: ${l}`), carrier: blanketCarrier,
    // The blanket link's own check, always: the blanket Chrome's pid, start time and profile (never the main link's seam).
    // `peerReader`: tests only, a reader of a fake world in place of the relay's.
    peer: linkPeerCheck({ reader: o.blanket?.peerReader ?? ("failed" in t ? { failed: t.failed } : t.reader), chrome: () => blanketChrome.chromeId(), profile: B.profile, cmdline: (pid) => procs.cmdline(pid) }),
  }) : null;
  const blanketPort: LinkReceiverPort | null = blanketLink ? new LinkReceiverPort(blanketLink, blanketCarrier) : null;
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
      link: { ready: () => link.ready(), confirmed: () => stage1c?.listsConfirmed() ?? false, busy: () => link.busy(), scopesReady: () => link.scopesReady(), hellos: () => link.hellos(), version: () => link.version() },
      extensionVersion: () => link.version() ?? part?.unit.stagedPackage() ?? null,
      onReady: () => { const c = part?.unit.chromeId(); if (c && pidfds) endOldHosts({ procs, chrome: c, receiverId: RECEIVER_ID, own: shimArgv(L!.shim), pidfds, log: o.log }); },
      // The blanket Chrome runs on the unit's Xvfb: each stop of the unit stops it too (board ab-4wh.3).
      beforeStop: (why) => { world?.kill("unitStop"); blanketPart?.stopFor(why); },
      linkDown: () => link.dropConnection(),
    } : {}),
    // The Mac: the give-back watcher of the running agent Chrome, and the versions of the agent's and the operator's Chrome.
    ...(darwin ? {
      mac: {
        watcher: new GiveBackWatcher({ bundle: () => part?.unit.macApp()?.bundle ?? null, state: o.unit.paths.state, log: o.log }),
        versions: (app, pid) => chromeVersions(procs, app, pid, o.unit!.paths.profile),
        disk: (app) => appVersion(app.bundle),
      },
    } : {}),
    ...o.unit.part,
    unit: {
      displayFs: realDisplayFs(() => procs.netUnix()), which: (n) => which(n),
      // The Mac: the operator's Google Chrome.app through `open -n -g`, with no staged CRX: the unit writes the agent
      // package's folder in the state folder, and the operator loads it unpacked once (board ab-v16.94.19).
      ...(darwin ? { mac: macStart({ state: o.unit.paths.state, crx: L?.agentPackage }) }
        : L ? { prepare: { run: (copy) => prepareAgentPackage(copy, o.unit!.paths.tools, o.unit!.paths.chromes, L.agentPackage), lastFile: (copy) => pinnedLastFile(copy, o.unit!.paths.tools) } } : {}),
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
  // with the roots of the scope's sessions in set_sessions (the MCP's own pid only with a live ticket of the scope; the
  // roots of a session that ended since refuse, as at the relay's gate: board ab-4wh.11), a scope with no list. Their
  // answer comes at once, with no wait. A live session's scope that the next object leaves out only for the restart gate
  // or for rule 2 passes step 5: only a push and its confirm, which need Chrome, name it.
  const doorRefusal = (scope: string, peer: Peer | null, ticket: string | null): [number, string] | null => {
    const v = stage1c?.useView(scope);
    if (!v || !v.nameable) return [503, NOT_READY.noList];
    if (peer === null || peerReader === null) return [403, PEER_UNREAD];
    if (mcp && peer.pid === process.pid) {
      if (ticket === null || !mcp.tickets.alive(ticket, scope)) return [403, sessionRefusal(peer.pid)];
    } else if (RootState.read(peerReader, state.roots(), state.contextRoots()).check(peerReader, scope, peer) === null) return [403, sessionRefusal(peer.pid)];
    return v.list === null ? [503, NOT_READY.noList] : null;
  };
  // The blanket scope's checks while its Chrome is down (board ab-4wh.3): the session check as for any scope, and no list
  // check (its list is "*", on the blanket link only); then its start at a use.
  // The session check reads the roots of EVERY session of the last set_sessions (board ab-4wh.7, N1), with C11's rules
  // that compare the scopes: a process of a nested session (its root under the blanket root) meets that session's root
  // first, and a root that two scopes name counts for neither; the roots of a session that ended since refuse (board
  // ab-4wh.11). This check runs at a wake only (before a start at a use); every other upgrade meets the relay's gate,
  // which holds the same roots of every session at all times (boards ab-4wh.9 and ab-4wh.10: the agent door's
  // `sessions`, below). The blanket scope's own roots are its blanket item's: a launch name that two live sessions have
  // gets no blanket Chrome (blanket/part.ts, I1), so `state.roots()` gives the holder one item's roots.
  const blanketDoorRefusal = (scope: string, peer: Peer | null, ticket: string | null): [number, string] | null => {
    if (peer === null || peerReader === null) return [403, PEER_UNREAD];
    if (mcp && peer.pid === process.pid) {
      if (ticket === null || !mcp.tickets.alive(ticket, scope)) return [403, sessionRefusal(peer.pid)];
    } else if (RootState.read(peerReader, state.roots(), state.contextRoots()).check(peerReader, scope, peer) === null) return [403, sessionRefusal(peer.pid)];
    return null;
  };
  const doorWake = async (scope: string, peer: Peer | null, ticket: string | null): Promise<[number, string] | null> => {
    if (!mayWake(scope)) return null;
    if (isBlanket(scope)) {
      const refused = blanketDoorRefusal(scope, peer, ticket);
      if (refused) return refused;
      const why = await blanketPart!.wake(scope, unitForBlanket);
      return why === null ? null : [503, why];
    }
    const refused = doorRefusal(scope, peer, ticket);
    if (refused) return refused;
    const why = await part!.wake(modelReady(scope));
    return why === null ? null : [503, why];
  };
  // The MCP path's step 8 while Chrome is down (its steps 1 to 7 made the walk and the token check): a scope that no
  // confirm can name gets the no-list 503 at once; else a request that needs no browser passes with no start, and only a
  // tool call starts Chrome and waits (review-120b O1). A scope with no list, or with a list that has no site, is no
  // exception: each tool call of it starts Chrome, and its browser tools keep the list at the agent door (board
  // ab-v16.104; the PageFetch design, section 5.13).
  const mcpRefusal = (scope: string): string | null => {
    if (!mayWake(scope) || isBlanket(scope)) return null;
    const v = stage1c?.useView(scope);
    return !v || !v.nameable ? NOT_READY.noList : null;
  };
  const mcpWake = async (scope: string): Promise<string | null> => {
    if (!mayWake(scope)) return null;
    if (isBlanket(scope)) return blanketPart!.wake(scope, unitForBlanket);
    return mcpRefusal(scope) ?? part!.wake(modelReady(scope));
  };
  // A send in the hold-off after a fail-closed stop gets that moment's answer at once (its extension is not connected),
  // not a wait for a receiver that cannot come (review-120b's note).
  // At its limit while a start of Chrome still runs, a send gets the `starting` text, never the first Chrome's receiver
  // (board ab-v16.81).
  // A send whose wait for the receiver ends with none names a receiver that Chrome turned off in the agent profile (board
  // ab-v16.116): the unit part reads the profile.
  if (o.lists) stage1c = new Stage1c({ ...o.lists, ...(port ? { receiver: port } : {}), log: o.log, ...(part && port ? { wake: () => (part!.failClosedHold() ? Promise.resolve(NOT_CONNECTED_TEXT) : part!.wake(() => port.isUp(), { send: true })) } : {}),
    ...(part ? { receiverOff: () => part!.receiverOffText() } : {}), blanketScope: () => blanketPart?.holder() ?? null });
  const blanketModel = () => (agent as (AgentDoor & { relay: Relay }) | null)?.relay.blanketModel ?? null;
  if (blanketChrome && blanketPort && stage1c) {
    const lists = stage1c;
    // The box's own names, read once: the "*" scope may not open them (C4's `exclude`).
    const names = boxNames();
    blanketPart = new BlanketPart({ chrome: blanketChrome, port: blanketPort, model: blanketModel, removeCopy: (scope) => lists.removeCopy(scope), log: o.log, exclude: () => names,
      // The stop by use by the main Chrome's rule: an agent's open connection, or the traffic of any connection (an MCP's
      // own ticket connection counts only by its traffic).
      ...(part ? { idle: { ms: () => part!.idleStopMs, use: () => { const u = (agent as (AgentDoor & { relay: Relay }) | null)?.relay.blanketTraffic(); return { inUse: !!u && (u.agents > 0 || u.busy > 0), quietFor: u?.quietFor ?? Infinity }; } } } : {}),
      endMcp: (scope) => mcp?.endScopeSessions(scope), ...o.blanket?.part });
  }
  /** The blanket scope of a use (board ab-4wh.3): the scope that has the blanket Chrome now. */
  const isBlanket = (scope: string) => blanketPart !== null && blanketPart.holder() === scope;
  // The unit's start for a use of the blanket scope: the blanket Chrome needs the unit's Xvfb (today's cut: the unit
  // starts its main Chrome with it), so the use waits until the unit runs.
  const unitForBlanket = () => part!.wake(() => part!.unit.running());
  // The MCP path (stage 1d part 2b): only with its socket, and with the state folder of the lists.
  // On the Mac the port's reader is libproc's (mac.ts), which the Mac check measured (board ab-v16.94.32).
  const mcpPort = macProcs ? { reader: macTcpReader(macProcs), ...o.mcp?.port } : o.mcp?.port;
  // The carrier rule (stage 5 T4; C11, the remote MCP path): only with the switch and the MCP path, and only while it can
  // run: the peer reader, and on Linux pidfd_open and a kernel with SO_PEERPIDFD, on the Mac its process reads. Else the
  // agent door has no carrier (fail closed), and the hello has no remote_scopes.
  const carrierWhyNot = !o.gateway ? null : !o.mcp || !o.lists ? "the service has no MCP path" : "failed" in t ? `the peer check cannot run (${t.failed})`
    : darwin ? (macProcs === null ? "the Mac's process reads cannot run" : t.reader.form !== "mac" ? "the peer reader is not the Mac's" : null)
    : process.platform !== "linux" ? `the carrier rule is not built for ${process.platform}`
    : "failed" in pidfd ? `pidfd_open cannot run (${pidfd.failed})` : t.reader.form !== "pidfd" ? "this kernel gives no pidfd of a peer (SO_PEERPIDFD)" : null;
  if (o.gateway && carrierWhyNot !== null) o.log(`service: the agent door has no carrier: ${carrierWhyNot}`);
  const carrierRule = o.gateway && carrierWhyNot === null && !("failed" in t) ? carrierAdmission({
    reader: t.reader, pidfd, mainPid: o.gateway.mainPid, commandFile: o.gateway.commandFile,
    ...(macProcs ? { mac: { argv: (pid: number) => macProcs.procArgs(pid)?.argv ?? null, exe: (pid: number) => macProcs.exeBytes(pid) } } : {}),
  }) : null;
  // The MCP port's walk reads the relay's gate's roots that admit nothing (board ab-4wh.13; C11, the service's sessions):
  // the one source, the state's contextRoots, so an ended session's roots and the roots of no scope refuse there too.
  const mcp = o.mcp && o.lists ? new McpPart({ ...o.mcp, ...(mcpPort ? { port: mcpPort } : {}), stateFolder: o.lists.stateFolder, foldCase: darwin, log: o.log, context: () => state.contextRoots(), ...(carrierRule ? { carrier: true } : {}) }) : null;
  // The card payment (board ab-sta.7; --card-pay): the payment requests now, with the model's facts, the preparation and the
  // act that the service makes once the agent door's model, the native link and the Chrome unit run (below). Until then a
  // request has no window (C11's text), and the MCP path serves neither payment tool.
  let payPrep: PayPrepare | null = null, payActor: PayAct | null = null, payPort: PayWorldPort | null = null;
  const payExtra = o.payAct?.providerOrigins ? { providerOrigins: o.payAct.providerOrigins } : {};
  // The test provider's API origins (board ab-sta.8): the preparation's act rules and the act's guard take them.
  const payApis = o.payAct?.providerApis ? { providerApis: o.payAct.providerApis } : {};
  const cardPay: CardPayOptions | undefined = o.cardPay ?? (o.payAct && o.signIns && o.lists ? {
    // The model's readiness as it is: null (ready) stays null; only a service with no model yet has the link's text
    // (board ab-sta.8: `notReady() ?? <the link's text>` turned each ready answer into a refusal).
    world: payWorld({ notReady: () => (payPort ? payPort.notReady() : NOT_READY.link), entries: (scope) => payPort?.entries(scope) ?? null, tabs: (scope) => payPort?.tabs(scope) ?? Promise.resolve([]) }),
    prepare: (req, card, signal) => payPrep ? payPrep.prepare(req, card, signal) : Promise.resolve({ stop: PAY_TEXT.noWindow }),
    act: (ctx) => payActor ? payActor.act(ctx) : Promise.resolve({ state: "stopped" as const, text: PAY_TEXT.noWindow }),
    repoOf: (scope) => state.repoOf(scope),
    ...payExtra,
  } : undefined);
  // The stored sign-ins (stage 1e part 1): only with their protections, and with the state folder of the lists.
  const signIns = o.signIns && o.lists ? new SignInsPart({ ...o.signIns, stateFolder: o.lists.stateFolder, log: o.log, ...(cardPay ? { cardPay } : {}) }) : null;
  // The stage's files, once the agent door opens (below).
  let scopeFiles: ScopeFiles | null = null;
  const parts = serviceParts({ stage1c, part, mcp, signIns, darwin, files: () => scopeFiles, blanket: blanketPart });
  // The hello's feature context_roots (board ab-4wh.12): the relay's gate takes the roots of no scope of each set_sessions.
  state = new Stage1a({ agentDoor: { url: (scope) => agentDoorUrl(o.agentDoor, scope), state: () => endpointState(gate) }, parts, foldCase: darwin, log: o.log, contextRoots: true,
    // After each set_sessions and session_ended, with the blanket scope of now: the relay's gate reads every session's
    // roots again (boards ab-4wh.9 and ab-4wh.10), on every service, with or without the blanket Chrome.
    sessionsChanged: () => (agent as (AgentDoor & { relay: Relay }) | null)?.relay.sessionsChanged() });
  const unit = o.daemonUnit ?? (darwin ? MAC_DAEMON_LABEL : "agentwatch.service");
  // The MCP path opens before the control door (review-115 B1), so its state, and with it the hello's features, is fixed
  // before the first hello (C12). Its MCP connects back to the agent door with a ticket; until the agent door opens, step
  // 8 gives the model's not-ready text of a link that is down. A failed open leaves the state failed (no mcp_token).
  // The sign-in act, once the service makes it (below): the MCP's own tools of the stored sign-ins run through it.
  let act: SignInAct | null = null;
  // PageFetch, once the service makes it (below; board ab-v16.102): the MCP's own tool PageFetch runs through it. The one
  // private window of the agent Chrome has one lock, which the act and PageFetch share (C11).
  let pageFetch: PageFetch | null = null;
  const windowLock = new WindowLock();
  if (mcp) {
    await mcp.open({
      url: (scope) => agentDoorUrl(o.agentDoor, scope),
      act: () => act,
      fetch: () => pageFetch,
      // The payment tools (C11, the card payment): only while the service has the payment act (--card-pay).
      pay: () => (payActor && signIns?.pay ? signIns.pay : null),
      // The blanket scope (board ab-4wh.3): no service tool but the press and hold, and step 8 reads the blanket model.
      blanket: isBlanket,
      // The press and hold (C11, browser_press_hold; board ab-t30.34): the scope's model (the blanket model for the blanket
      // scope) while its input stage runs.
      hold: (scope) => {
        const relay = (agent as (AgentDoor & { relay?: Relay }) | null)?.relay;
        const m = isBlanket(scope) ? relay?.blanketModel ?? null : relay?.model ?? null;
        return m !== null && m.stageOn ? m : null;
      },
      readiness: (scope) => {
        if (isBlanket(scope)) {
          const b = blanketModel();
          const down = !b || b.notReady() !== null || !blanketPart!.ready(scope);
          return { controlOff: state.config?.control === false, notReady: down ? BLANKET_NOT_READY.link : null, sites: b ? b.sitesOf(scope) : null };
        }
        const m = model();
        // A stop by use that runs counts as a link that is down (board ab-v16.94.11): the request waits, then starts Chrome.
        // So does a start that runs, with its move of the agent extension (board ab-v16.81): the request waits.
        return { controlOff: state.config?.control === false, notReady: m ? m.notReady() ?? (part?.idleStopping || part?.startHolds ? NOT_READY.link : null) : NOT_READY.link, sites: m ? m.sitesOf(scope) : null };
      },
      ...(part ? { use: { refusal: mcpRefusal, wake: mcpWake } } : {}),
    });
  }
  // The control door opens next, before the agent door and before any Chrome start (the design's build note 8).
  let control: ControlDoor;
  try {
    control = await ControlDoor.open({
      path: o.controlDoor, handler: state, log: o.log,
      admit: daemonAdmission({
        reader: "failed" in t ? { failed: t.failed } : t.reader, pidfd, mainPid: o.mainPid ?? (darwin ? launchdMainPid(unit) : () => systemdMainPid(unit)), commandFile: o.daemonCommand,
        ...(macLib ? { mac: macProcs ? { argv: (pid: number) => macProcs.procArgs(pid)?.argv ?? null, exe: (pid: number) => macProcs.exeBytes(pid) } : { failed: (macLib as { failed: string }).failed } } : {}),
      }),
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
    // The blanket profile (board ab-4wh.3): the service's start stops each Chrome on the blanket profile and deletes the
    // blanket folder (no adoption: a crash leaves nothing for this run), then the blanket link listens.
    if (blanketChrome && blanketLink) {
      await blanketChrome.sweep();
      await blanketLink.start();
    }
    // The carrier of the remote MCP path (stage 5 T4): only while the MCP part serves it (the hello lists remote_scopes).
    const gatewayCarrier = carrierRule && mcp?.remoteReady ? {
      rule: carrierRule, request: (req: IncomingMessage, res: ServerResponse) => mcp.remoteRequest(req, res),
      notCarrier: (reason: string) => o.log(`service: a request on the agent door's MCP path from a peer that is no carrier gets the 404: ${reason}`),
    } : undefined;
    if (carrierRule && !gatewayCarrier) o.log("service: the agent door has no carrier: the MCP path does not serve");
    if (gatewayCarrier) o.log("service: the agent door has the carrier rule of the remote MCP path");
    // The blanket model's address rule with DNS (PageFetch's rule, fetch/address.ts): a navigation's host whose address is
    // private or loopback is refused before the bridge (board ab-4wh.3).
    const addressCheck = o.blanket?.addressCheck ?? (async (host: string) => { const r = await checkHost(host, systemResolve); return r.ok ? null : r.why; });
    const blanketDoor = blanketPart && blanketCarrier ? { transport: { send: (line: string, msg: Parameters<Carrier["fromModel"]>[1]) => blanketCarrier.fromModel(line, msg), bind: (to: Parameters<Carrier["bind"]>[0]) => blanketCarrier.bind(to) }, scope: () => blanketPart!.holder(), addressCheck } : undefined;
    // `sessions` (boards ab-4wh.9 to ab-4wh.11): the roots of every local session of the last set_sessions and of each
    // session that ended since; the relay's gate walks and compares the scopes with them at all times, on every service,
    // and each model's line still admits only its own scopes.
    const opened = await openAgentDoor({ address: o.agentDoor, gate, log: o.log, bridge: carrier ? { send: (line, msg) => carrier.fromModel(line, msg), bind: (to) => carrier.bind(to) } : undefined, tickets: mcp?.tickets, ...(blanketDoor ? { blanket: blanketDoor } : {}), sessions: () => state.contextRoots(),
      ...(part ? { use: { stopping: () => part!.idleStopping || part!.startHolds, wake: doorWake } } : {}), ...(o.mergeGuard ? { mergeGuardHosts: o.mergeGuard.testHosts } : {}),
      ...(o.stage !== undefined ? { stage: o.stage } : {}), ...(gatewayCarrier ? { carrier: gatewayCarrier } : {}) });
    agent = opened;
    // The gate reads every session's roots again (board ab-4wh.9, the review's I1): a set_sessions or session_ended that
    // came while the agent door opened (the relay read the roots once, before its listen) found no relay for the state's
    // `sessionsChanged` hook. No connection is handled before this call: from the listen's callback to here only promise
    // continuations run (startRelay's return, openAgentDoor's return, this await), no I/O callback, so no accept and no
    // upgrade.
    opened.relay.sessionsChanged();
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
    // The state folder (board ab-t30.27; C11, files): the receiver has access to local files, so the model refuses a client's
    // file path of the agent profile, of the stage's files, or of a folder that holds the state folder.
    if (o.unit) opened.relay.model.setStateFolder(new StateFolder(o.unit.paths.state));
    // Chrome's own copy of a remote scope's download (board ab-v16.94.7.8; C11, the remote scope's folder): the model removes
    // it from the agent profile's downloads folder, through its guard, at the end of its handling of the download.
    if (o.unit) opened.relay.model.setChromeDownloads(new ChromeDownloads(o.unit.paths.downloads));
    // On the Mac a case twin's first write waits for the removal of the other's folder (board ab-v16.94.26).
    if (o.unit && opened.relay.model.stageOn) opened.relay.model.setFiles(scopeFiles = await ScopeFiles.open(o.unit.paths.state, darwin));
    else if (o.unit) await ScopeFiles.clear(o.unit.paths.state);
    // The blanket model (board ab-4wh.3): the same guards of the state folder and the stage's files, the same clipboard
    // (one display), and Chrome's own downloads in the blanket folder's HOME. No sign-in act, no payment, no PageFetch.
    const bm = opened.relay.blanketModel;
    if (bm && B) {
      if (o.unit) bm.setStateFolder(new StateFolder(o.unit.paths.state));
      bm.setChromeDownloads(new ChromeDownloads(B.downloads));
      if (scopeFiles && bm.stageOn) bm.setFiles(scopeFiles);
      if (clipboard) bm.setClipboard(clipboard);
    }
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
        lock: windowLock,
      }));
    }
    // The payment act (board ab-sta.7; --card-pay): with the stored sign-ins' payment requests, the native link, the lists
    // and the Chrome unit, as the sign-in act. The preparation holds the one private window (the lock of the sign-in act
    // and PageFetch); the receiver's channel main takes the pay act's requests (C4).
    if (o.payAct && signIns?.pay && link && port && stage1c && part) {
      const ap = opened.relay.model.actPort();
      const receiver = { features: () => port.features(), request: (op: "act_rules" | "pay_cookies_copy" | "pay_merchant_block" | "act_end", body: Record<string, unknown>, ms: number) => port.act(op, body, ms) };
      const screen = xScreen({
        display: () => { const d = part?.unit.xDisplay(); return d && d.size ? { display: `:${d.display}`, xauth: d.xauth, size: { width: d.size[0], height: d.size[1] } } : null; },
        xdotool: L!.xdotool !== undefined ? L!.xdotool : which("xdotool"),
      });
      payPort = ap;
      payPrep = new PayPrepare({ model: ap, receiver, screen, lock: windowLock, log: o.log, ...payExtra, ...payApis });
      payActor = new PayAct({ model: ap, log: o.log, ...payExtra });
    }
    // PageFetch (board ab-v16.102; C11, PageFetch): with the native link and the Chrome unit, on Linux (the Mac follows
    // with the Mac service), on its own: not through the stored sign-ins part. Its window stays off the screen at the X
    // level, as the act's window. Without it the MCP path lists no PageFetch, and a call gets the allow list's -32601.
    if (link && port && part && process.platform === "linux") {
      const unit = part;
      pageFetch = new PageFetch({
        model: opened.relay.model.actPort(),
        receiver: { features: () => port.features(), request: (_op, body, ms) => port.fetchEnd(body, ms) },
        lock: windowLock,
        screen: xScreen({
          display: () => { const d = unit.unit.xDisplay(); return d && d.size ? { display: `:${d.display}`, xauth: d.xauth, size: { width: d.size[0], height: d.size[1] } } : null; },
          xdotool: L!.xdotool !== undefined ? L!.xdotool : which("xdotool"),
        }),
        log: o.log,
        ...(o.pageFetch?.admit ? { admit: o.pageFetch.admit } : {}),
      });
    }
  } catch (e) { state.stopParts(); await control.stop(); await link?.stop(); await blanketLink?.stop(); throw e; }
  const door = agent;
  // C10: the carrier's deadlines, each second.
  const expire = carrier ? setInterval(() => { carrier.expire(); blanketCarrier?.expire(); }, 1000) : null;
  expire?.unref();
  if (part) await part.begin();
  o.log(`service: ready (pid ${process.pid}; ${part ? `the Chrome unit runs${link ? ", with the native link" : ""}` : "stage 1a: no Chrome"})`);
  let stopping: Promise<void> | undefined;
  return {
    control, agent: door, state, part, link, carrier, mcp, lost: owner ? owner.lost : new Promise<string>(() => {}),
    blanket: blanketPart && blanketChrome && blanketLink && blanketCarrier ? { part: blanketPart, chrome: blanketChrome, link: blanketLink, carrier: blanketCarrier } : null,
    stop: () => stopping ??= (async () => {
      state.stopParts();
      // The blanket Chrome is no one's after the service: it stops, and <state>/blanket goes (C12; board ab-4wh.3).
      await blanketPart?.shutdown();
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
      blanketCarrier?.stop();
      await blanketLink?.stop();
      o.log("service: stopped");
    })(),
  };
}
