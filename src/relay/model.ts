// The browser model of agent mode (the two-modes design, sections 4 and 8; contract C11 in chrome-extension's
// docs/protocol.md, the master). chrome.debugger refuses the browser-level CDP calls to an extension, so the model
// answers them itself with bridge ops (C10): the targets are the tabs of the connection's scope, a tab belongs to
// one connection at a time (all sessions of a tab share its one chrome.debugger attachment and its domain state),
// and every other page call goes to debugger.sendCommand after the refusals of policy.ts. It grew from the probe's
// relay.mjs (docs/superpowers/specs/2026-11-03-two-modes-probe/).
//
// Each scope has its own allowlist (part 2 of the per-scope build, board ab-v16.35; the per-scope design,
// docs/superpowers/specs/2026-11-04-per-scope-allowlist-design.md, section 8.4, and the orphan-tabs design,
// 2026-11-05-orphan-agent-tabs-design.md, section 8). The receiver keeps each tab's scope and blocks each tab by its
// own list; the relay names the scope of each tab that it opens, takes every other tab into a scope only when the
// receiver reports it (bridge.tabScope, and bridge.tabScopes at each link up), admits a connection only while its
// scope has a list, and refuses a client's navigation off that list (layer 1 of the guard). The receiver keeps the
// browser's last window for every close (C10, removals and the last window), so the relay sends its closes as they are.
//
// The agent display's pointer (board ab-v16.71; the agent pointer design,
// docs/superpowers/specs/2026-11-06-agent-pointer-move-design.md, section 3; C11 "The pointer at an activation"): with
// one window per page, when a page comes under the pointer, the relay has the daemon play a person-shaped path
// (daemon.movePointer, C10) from the last point of the page under the pointer to the last point of the page that comes
// forward, before its window comes forward; after an X record or a cover a client's next far pointer event gets a CDP catch-up
// path first. With an older daemon (`unknown op`) the paths stay off, and the relay is exactly as before.

import { randomBytes } from "node:crypto";
import { copyFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { BridgeError, RELAY_TIMER, type Bridge } from "./bridge.ts";
import { ACTIVATE_MAX_MS, CATCH_UP_MAX_UNANSWERED, clampRect, contentRect, GEO_EXPRESSION, geoOf, GEOMETRY_WAIT_MS, insideRect, monotonicMs, moveProblem, moveWait, near,
  notAfter, planPath, POINTER, toDisplay, toPage, usable, type Geo, type Move, type PathPoint, type Pt } from "./pointer.ts";
import { awaitsPromise, cdpError, contextsNamed, DEFAULT_CONTEXT, FOCUS_EMULATION, hideCookies, hidesCookies, isTimeout, offList, route, startsAction, TEXT, tooLargeAction, withForce } from "./policy.ts";
import { covers, parseRoots, parseScopes, SCOPE, type Root, type Roots, type ScopeSet } from "./scopes.ts";

/** The CDP permission names (as Playwright sends them) that chrome.contentSettings can grant, and their content setting. */
const PERMISSIONS: Record<string, string> = { geolocation: "location", notifications: "notifications", videoCapture: "camera",
  audioCapture: "microphone", clipboardReadWrite: "clipboard", clipboardSanitizedWrite: "clipboard" };
const CONTENT_TYPES = ["location", "notifications", "camera", "microphone", "clipboard", "automaticDownloads"];
/** Targets that the model never reports: so context.serviceWorkers() is empty. */
const HIDDEN_TYPES = new Set(["service_worker", "shared_worker", "browser"]);
/** How long Target.createTarget waits for its tab's tabs.onCreated, which brings the tab's hold (C10 does not order it before the answer). */
const CREATED_WAIT_MS = 2000;
/** How long a new tab that the relay did not create waits in the model for its bridge.tabScope (C11). */
export const TAB_SCOPE_WAIT_MS = 500;
/** The tries of bridge.info at a link up (review-58 note 7): a failed one (a timeout, say) is tried again, then the relay waits for the next link up. */
export const BRIDGE_INFO_TRIES = 3;
const BRIDGE_INFO_RETRY_MS = 500;
/** chrome.downloads danger values that wait for a person's confirmation (not measured; agent mode never confirms one). */
const SAFE_DANGER = new Set(["safe", "accepted", "allowlistedByPolicy", "deepScannedSafe", "asyncScanning", "asyncLocalPasswordScanning"]);

export const CLOSE = {
  browserClose: [1000, "Browser.close ends this connection; the agent browser keeps running"],
  scopeEnded: [1000, "The agentwatch session ended"],
  linkDown: [1011, "The agent browser's link went down"],
  stopped: [1001, "The agent browser stopped"],
  noList: [1008, "The allowlist has no list for this scope any more"],
  /** With the peer check: the root that admitted the connection is no longer one of its scope's roots (C11). */
  root: [1008, "The session of this scope has a new process: connect again."],
} as const;
export const NOT_READY = {
  link: "The agent browser is not ready: its extension is not connected.",
  allowlist: "The agent browser is not ready: its extension has not confirmed the allowlist.",
  old: "The agent browser is not ready: its extension is too old for agent mode.",
  noList: "The agent browser is not ready: the allowlist has no list for this scope.",
  roots: "The agent browser is not ready: the allowlist has session roots, but the relay was started without --peer-check.",
  /** The relay's self-test of its peer reader failed (C11, step 3). */
  cannotRead: "The agent browser is not ready: the relay cannot read the program of a connection.",
};
/** The receiver's answer to an op on a tab that its sweep took out of its scope (C10, the orphan set). */
const NOT_AN_AGENT_TAB = "not an agent tab";
/** The receiver's answer to tabs.create and windows.create of a scope with no list (C10); the relay gives it too. */
const NO_LIST_FOR_SCOPE = "no list for this scope";

/** A client connection as the model sees it: the endpoint gives it a WebSocket. */
export type Socket = { send(text: string): void; close(code: number, reason: string): void };

type Tab = {
  id: number; targetId: string | null; scope: string | null; opener: number | null; owner: Conn | null;
  sessions: Set<string>; attached: boolean; attaching: Promise<void> | null; held: boolean; claimed: boolean; autoPending: Promise<string | null> | null;
  /** The client's URL of a tab that Target.createTarget opened at about:blank, until the model navigates it. */
  navigateTo: string | null;
  /** Its tabs.onCreated came (with attached and held). */
  seen: boolean;
  /** While an input of the tab waits for its activation: the tab's later calls go to Chrome behind it, in order. */
  gate: Promise<void> | null;
  /** It came from the receiver's map at the link up (bridge.tabScopes, step 2): step 3 gives it its target id, or drops it. */
  fromMap: boolean;
  /** A new tab whose bridge.tabScope did not come in TAB_SCOPE_WAIT_MS: released and detached; a later one still puts it in its scope. */
  late: boolean;
  // ---- the pointer (ab-v16.71; the agent pointer design, section 3)
  /** Its window, when an event or a read named it. */
  windowId: number | null;
  /** It holds a CDP button: from a mousePressed until Chrome answered its mouseReleased. */
  pressed: boolean;
  /** The waits for the end of the hold. */
  released: (() => void)[];
  /** Its pointer input that went to Chrome and has no answer yet. */
  pointerSent: Set<Promise<unknown>>;
  /** A catch-up that runs in the page. */
  catchUp: Promise<void> | null;
  /** Another page came on top of this page: its next pointer event needs the same catch-up as an X record. */
  covered: boolean;
  /** Its catch-up moves without an answer (at most CATCH_UP_MAX_UNANSWERED, per tab). */
  unanswered: number;
  /** Its calls that wait in the activation chain (or run there). */
  chainSteps: number;
  /**
   * The context ids of the relay's isolated world in the tab: the id that its last Page.createIsolatedWorld returned,
   * and the ids of Runtime.executionContextCreated with its name. Each read makes the world again and keeps only the
   * new id: Chromium reuses context ids in a new renderer process, so an old id can name a page's context (review-68 B1).
   * A client's call that names one of them is refused (sendNow; board ab-v16.80); an id that Chrome gives to another
   * world (its Runtime.executionContextCreated, or the answer of a client's Page.createIsolatedWorld) leaves the set.
   */
  worldIds: Set<number>;
  /** A geometry read of the relay is in flight. */
  geoReading: boolean;
  /**
   * The last usable geometry of the relay's own reads (ab-lead's decision on point 1 of PR #68): a front page that is no
   * bridge tab (agent-browser's CLI ends its connection after each command) has no read, and its path uses this. It goes
   * at every window event that the relay sees: Browser.setWindowBounds, a viewport override, Page.frameResized.
   */
  geo: Geo | null;
  /** The drop events of the kept geometry so far: a read that started before one keeps and drops nothing. */
  geoDrops: number;
  /**
   * A client's device-metrics override is in force: from Emulation.setDeviceMetricsOverride or
   * Page.setDeviceMetricsOverride until Emulation.clearDeviceMetricsOverride or Page.clearDeviceMetricsOverride.
   */
  metrics: boolean;
};
/** A page's last point: client CSS px, and whether an X record of an activation step set it (the catch-up's condition). */
type LastPoint = { x: number; y: number; x11: boolean };
type StepKind = "input" | "bringToFront" | "activateTarget";
/** How step 5 ended: a path played (ok), at was T already, someone else moved the pointer, a failed path (the place unknown), a refusal, or no path. */
type Outcome = { kind: "ok"; end: Pt; points: number } | { kind: "atIsT"; T: Pt } | { kind: "moved"; end: Pt; points: number }
  | { kind: "failed"; text: string; points: number } | { kind: "refused"; text: string } | { kind: "none" };
/** Step 4's plan: the geometries, and the move, at equal to T, or why no path. */
type Plan = { gF: Geo | null; gT: Geo | null; move?: Move; Td?: Pt; atIsT?: boolean; why?: string };
const TIMEOUT = Symbol("timeout");
/** The input methods whose point is the page's last point (C11), and the touch input that makes it unknown. */
const POINTER_INPUT = new Set(["Input.dispatchMouseEvent", "Input.dispatchDragEvent"]);
const TOUCH_INPUT = new Set(["Input.dispatchTouchEvent", "Input.emulateTouchFromMouseEvent", "Input.synthesizeTapGesture"]);
/** A client's calls on a page's own session that change its viewport: the page's cached geometry goes. */
const VIEWPORT_CALLS = new Set(["Emulation.setDeviceMetricsOverride", "Emulation.clearDeviceMetricsOverride", "Emulation.setVisibleSize", "Emulation.setPageScaleFactor",
  "Emulation.setScrollbarsHidden", "Page.setDeviceMetricsOverride", "Page.clearDeviceMetricsOverride"]);
/** How long `no display` turns the paths off (C11). */
const NO_DISPLAY_OFF_MS = 60_000;
/** A relay log line of the pointer names each text at most once in this time (C10's log rule). */
const NOTICE_MS = 5 * 60_000;
/** The texts of a failed path: the place is unknown, and both pages saw a part of it (finding F: every not now). */
const FAILED_PATH = new Set(["no display", "not now", "disconnected", RELAY_TIMER]);
type Session = { tabId: number; parent?: string; auto: boolean };
type Download = { conn: Conn; url: string; name: string; item?: number };

export class Conn {
  readonly id: number;
  readonly scope: string;
  readonly socket: Socket;
  /** With the peer check: the root (pid, start) that admitted the connection, by the walk or by its cgroup; else null. */
  readonly root: Root | null;
  readonly sessions = new Map<string, Session>();
  readonly browserSessions = new Set<string>();
  autoAttach = false;
  waitOnStart = false;
  autoParent: string | undefined;
  discover = false;
  download: { behavior: string; path?: string; events: boolean } | null = null;
  grants: { type: string; pattern: string }[] = [];
  constructor(id: number, scope: string, socket: Socket, root: Root | null = null) { this.id = id; this.scope = scope; this.socket = socket; this.root = root; }
  send(msg: object): void { this.socket.send(JSON.stringify(msg)); }
  event(sessionId: string | undefined, method: string, params: object): void { this.send(sessionId ? { method, params, sessionId } : { method, params }); }
}

type Handler = (c: Conn, p: any, sessionId: string | undefined, tab: Tab | undefined) => Promise<object>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const newSessionId = () => randomBytes(16).toString("hex").toUpperCase();

export class Model {
  private readonly bridge: Bridge;
  private readonly log: (line: string) => void;
  private readonly tabs = new Map<number, Tab>();
  /** Chrome's child sessions (frames and workers of a tab) -> the tab. */
  private readonly children = new Map<string, number>();
  /** The child sessions of targets that the model never reports (service workers) -> the tab: their events go to nobody. */
  private readonly hidden = new Map<string, number>();
  private readonly conns = new Set<Conn>();
  private readonly downloads = new Map<string, Download>();
  /** Target.createTarget calls in flight: a new tab waits for them, so that only its creator takes a tab that it opened. */
  private readonly creating = new Set<Promise<unknown>>();
  private readonly seenWaiters = new Map<number, () => void>();
  /** The bridge.tabScope of a tab that the model does not know yet: it comes before the tab's tabs.onCreated or tabs.onReplaced. */
  private readonly keptScopes = new Map<number, string>();
  /** A new tab that waits for its bridge.tabScope (TAB_SCOPE_WAIT_MS), by tab. */
  private readonly scopeWaiters = new Map<number, (scope: string | null) => void>();
  private nextConn = 1;
  private link = 0; // the generation of the link: an answer from before a link change changes nothing
  private linkUp = false;
  private info: { bridge: number; userAgent?: string; fullVersion?: string; version?: string } | null = null;
  private tooOld = false;
  /** The last allowlist line since the link came up: the lists of the set_scopes that the receiver confirmed. */
  private allowlist: ScopeSet | null = null;
  /** The last line since the link came up whose `scopes` and `lists` are objects: the reference for a tab that joins a scope from a bridge answer. */
  private lastApplied: ScopeSet | null = null;
  /**
   * The last allowlist line had a `roots` field, and this relay runs without the peer check (C11, the scope's session):
   * it applies no list of that line, as if no line had come, and answers each upgrade with the roots 503, until a line
   * without `roots` comes. So a daemon and a relay that disagree fail closed. The peer check is board ab-v16.51.
   */
  private rootsLine = false;
  /**
   * The relay runs with --peer-check (C11, the scope's session): a line's `roots` apply (parseRoots), a scope that the
   * line does not name has no list whatever `default` says, and at each line a connection whose root left its scope's
   * roots closes (1008). `onRoots` gives the peer check each line's roots (the defensive root rules read them then).
   */
  readonly peerCheck: boolean;
  private readonly onRoots: ((roots: Roots) => void) | undefined;
  /** The roots of the last allowlist line that apply, by scope (with the peer check). */
  private roots: Roots = new Map();
  /**
   * The scopes of an end_scope that no later line named again (ab-lead's decision for PR #58; the C11 sentence comes
   * with board ab-v16.55): their new connections get the no-list 503, also over a link change. So no process of an
   * ended session connects again in the moment before the daemon's next line drops its scope, also with a default
   * list. A later session of the same name comes only after a line that names its scope (C4, rule 2).
   */
  private readonly ended = new Set<string>();
  private cleared = false;
  private settings: Promise<unknown> = Promise.resolve();
  /** How long a finished download may take to show up complete in chrome.downloads. */
  private readonly downloadWaitMs: number;
  /**
   * One window per page, on Linux only (the anti-detect design, docs/research/2026-11-05-anti-detect-drive.md, "The
   * answer" steps 1, 2 and 5): every Target.createTarget opens a window that does not take the focus, the model
   * answers a client's focus emulation itself, and before an input that starts an action the page's window comes
   * forward. On the Mac pages stay tabs, as before (board task ab-v16.27 measures the Mac first).
   */
  readonly windowPerPage: boolean;
  /** The activations of every tab, in order: each one and its input reach the bridge before the next activation reads a window. */
  private activations: Promise<void> = Promise.resolve();
  // ---- the pointer (ab-v16.71)
  /** The paths: on (the probe answered), off (an older daemon, a wrong display; no display for 60 s), or unknown. */
  private paths: "on" | "off" | "unknown" = "unknown";
  private offUntil = 0;
  private probing: Promise<void> | null = null;
  /** The X pointer's place, from the daemon's last answer (null: unknown), the display's size and the live view's `views`. */
  private at: Pt | null = null;
  private display: { width: number; height: number } | null = null;
  private views = 0;
  /** The front page: the page under the pointer (null: unknown), and its window. */
  private front: Tab | null = null;
  private frontWindow: number | null = null;
  /** Each page's last point, by target id: kept over a link change for the targets that step 3 lists again. */
  private readonly points = new Map<string, LastPoint>();
  /** When a log line of the pointer last named each text (C10's log rule: each text at most once in 5 minutes). */
  private readonly notices = new Map<string, number>();
  /** The catch-ups that stopped at CATCH_UP_MAX_UNANSWERED (review-63e note D: counted and logged). */
  private catchUpStops = 0;
  /** The name of the relay's isolated world: no page script sees it. */
  private readonly worldName = `agentwatch-relay-${randomBytes(4).toString("hex")}`;
  /** A log line for each step and catch-up (times and counts, never a point): AGENT_BROWSER_POINTER_LOG=1 (the live check). */
  private readonly pointerLog: boolean;
  private readonly random: () => number;

  constructor(bridge: Bridge, log: (line: string) => void, opts: { downloadWaitMs?: number; windowPerPage?: boolean; peerCheck?: boolean; onRoots?: (roots: Roots) => void;
    pointerLog?: boolean; random?: () => number } = {}) {
    this.bridge = bridge; this.log = log; this.downloadWaitMs = opts.downloadWaitMs ?? 5000;
    this.windowPerPage = opts.windowPerPage ?? process.platform === "linux";
    this.peerCheck = opts.peerCheck ?? false;
    this.onRoots = opts.onRoots;
    this.pointerLog = opts.pointerLog ?? process.env.AGENT_BROWSER_POINTER_LOG === "1";
    this.random = opts.random ?? Math.random;
  }

  /** What the relay keeps of the pointer (for the tests and the live check; no client sees it). */
  pointerState() {
    return { paths: this.paths, offFor60s: this.paths === "off" && this.offUntil > 0, at: this.at, display: this.display, views: this.views,
      front: this.front?.id ?? null, points: Object.fromEntries(this.points), pressed: [...this.tabs.values()].filter((t) => t.pressed).map((t) => t.id),
      catchUpStops: this.catchUpStops, releaseWaits: [...this.tabs.values()].reduce((n, t) => n + t.released.length, 0),
      kept: Object.fromEntries([...this.tabs.values()].filter((t) => t.geo).map((t) => [t.id, t.geo!])) as Record<number, Geo> };
  }

  /** Why a new connection is refused (C11's 503 texts), or null when the endpoint is ready. */
  notReady(): string | null {
    if (!this.linkUp) return NOT_READY.link;
    if (this.tooOld) return NOT_READY.old;
    if (!this.allowlist && !this.rootsLine) return NOT_READY.allowlist;
    if (!this.info) return NOT_READY.link;
    return this.rootsLine ? NOT_READY.roots : null;
  }

  /** Why a connection of `scope` is refused (C11, the order of the checks without the peer check), or null to admit it. */
  refuse(scope: string): string | null {
    // A scope whose list is empty is admitted: it can open about:blank only.
    return this.notReady() ?? (this.noList(scope) ? NOT_READY.noList : null);
  }

  /** With the peer check, step 5: the last allowlist line names the scope (in `scopes`, also with null). */
  named(scope: string): boolean {
    return this.allowlist?.scopes.has(scope) ?? false;
  }

  /**
   * The scope has no list (the no-list 503; with the peer check, step 7): the last line gives it none, or an end_scope
   * ended it and no later line named it again. With the peer check an ended scope that the line still names counts as
   * a named scope with no list, so the session check (step 6) comes first.
   */
  noList(scope: string): boolean {
    return this.ended.has(scope) || this.allowlist?.listOf(scope) == null;
  }

  /**
   * A tab must not join `scope` (review-58 B1): the scope is ended, or the last applied line gives it no list. A bridge
   * answer and a line can come in one read of the relay's standard input; then the line applies before the code
   * after the answer's await runs, so the code checks again before it gives a tab the scope of that answer.
   */
  private noListFor(scope: string): boolean {
    return this.ended.has(scope) || (this.lastApplied !== null && this.lastApplied.listOf(scope) === null);
  }

  /** The entries of a scope's list in the last allowlist line, or null for a scope with no list. */
  private entriesOf(scope: string): readonly string[] | null {
    return this.allowlist?.entriesOf(scope) ?? null;
  }

  // ------------------------------------------------------------------ the daemon's lines

  /** A line from the daemon other than a res: a receiver event, a link change, an allowlist or the end of a scope. */
  onDaemon(msg: any): void {
    if (msg.t === "ev") this.onEvent(msg);
    else if (msg.t === "link" && msg.up) void this.onLinkUp();
    else if (msg.t === "link") this.onLinkDown();
    else if (msg.t === "allowlist") this.onAllowlist(msg);
    else if (msg.t === "end_scope") void this.endScope(String(msg.scope));
  }

  /**
   * C10's allowlist line: the object of the set_scopes that the receiver confirmed, by C4's rules (scopes.ts). An old
   * daemon's line ({"domains": [...]}) gives every scope no list: the endpoint admits no connection (no backward
   * compatibility; C4, the rollout).
   */
  private onAllowlist(msg: unknown): void {
    if (!this.peerCheck && msg && typeof msg === "object" && Object.hasOwn(msg, "roots")) {
      // C11: a relay without --peer-check applies no list of a line with roots (any value), as if no line had come: every
      // open connection closes (1008), and each upgrade gets the roots 503, until a line without roots comes.
      if (!this.rootsLine) this.log("relay: the allowlist line has session roots, but the relay was started without --peer-check: it admits no connection");
      this.rootsLine = true;
      this.allowlist = null;
      for (const c of [...this.conns]) { c.socket.close(...CLOSE.noList); void this.close(c); }
      return;
    }
    this.rootsLine = false;
    const set = parseScopes(msg, { namedOnly: this.peerCheck });
    if (this.peerCheck) {
      // The roots apply before any check of this line: the defensive root rules read every root now (C11).
      this.roots = parseRoots(msg);
      this.onRoots?.(this.roots);
    }
    this.allowlist = set;
    if (set.applied) this.lastApplied = set;
    if (set.refused) this.log(`relay: the allowlist line has ${set.refused} refused item(s)`);
    // A line that names an ended scope again ends its refusal (a later session of that name, after C4's rule 2).
    for (const scope of [...this.ended]) if (set.scopes.has(scope)) this.ended.delete(scope);
    // C11: every connection of a scope that has no list any more closes; its tabs are detached and freed. With the peer
    // check, a connection whose scope keeps a list closes too when the root that admitted it (pid and start) is no
    // longer one of the scope's roots that apply (a respawned pane), also at a line with no roots field. A root that
    // another scope names too stays: the check runs once, at the upgrade.
    for (const c of [...this.conns]) {
      if (set.listOf(c.scope) === null) { c.socket.close(...CLOSE.noList); void this.close(c); continue; }
      const root = c.root;
      if (!this.peerCheck || root === null) continue;
      if ((this.roots.get(c.scope) ?? []).some((r) => r.pid === root.pid && r.start === root.start)) continue;
      c.socket.close(...CLOSE.root);
      void this.close(c);
    }
    // C11: at a line whose scopes and lists are objects, the model drops each tab of a scope that the line gives no
    // list. The receiver's sweep closed it, or took it out of its scope into its orphan set (C5), so a later session
    // of the same name never sees it. A tab that still waits for its bridge.tabScope has no scope yet, and it stays.
    if (set.applied) {
      for (const tab of [...this.tabs.values()]) if (tab.scope !== null && set.listOf(tab.scope) === null) this.drop(tab);
      for (const [id, scope] of this.keptScopes) if (set.listOf(scope) === null) this.keptScopes.delete(id);
    }
    // Content settings act on the whole profile: the grants that each connection's own list still covers, and
    // automatic downloads for every entry of every list.
    void this.queueSettings(() => this.rebuild(CONTENT_TYPES));
  }

  /**
   * C10, the steps of the link up, at each link up and so at each relay start (the daemon writes the link-up line to
   * each relay that starts while the link is up), before the relay admits a connection: (1) bridge.info; (2)
   * bridge.tabScopes, whose entries join the model at once; (3) debugger.getTargets, which gives those entries their
   * target ids and drops the ones whose tab is gone; (4) the detach of every tab that Chrome reports attached.
   */
  private async onLinkUp(): Promise<void> {
    // A new receiver detached every tab at its link up (C10): no session of an earlier link is alive.
    this.closeAll(CLOSE.linkDown);
    this.reset();
    const link = ++this.link;
    this.linkUp = true;
    // The pointer's probe (C11) goes right after the first bridge.info: the paths are unknown until its first answer.
    this.paths = "unknown"; this.offUntil = 0;
    // At the first link up no grant of an earlier run may stay: content settings stay after a restart.
    if (!this.cleared) {
      this.cleared = true;
      void this.queueSettings(async () => { for (const t of CONTENT_TYPES) await this.bridge.call("contentSettings.clear", [t]); });
    }
    let info: any;
    for (let tryNo = 1; ; tryNo++) {
      try {
        const call = this.bridge.call("bridge.info");
        if (tryNo === 1) this.probe();
        info = await call;
        break;
      } catch (e) {
        const why = (e as Error).message;
        if (link !== this.link) return;
        if (why === "unknown op") { this.tooOld = true; return; }
        // review-58 note 7: a failed bridge.info (its 30 s deadline, say) is tried again a few times; else the relay
        // would stay "not connected" until the next link up. A link change ends the tries (the generation above).
        if (tryNo >= BRIDGE_INFO_TRIES) { this.log(`relay: bridge.info failed (try ${tryNo} of ${BRIDGE_INFO_TRIES}): ${why}; the relay gives up until the next link up`); return; }
        this.log(`relay: bridge.info failed (try ${tryNo} of ${BRIDGE_INFO_TRIES}): ${why}; it tries again`);
        await sleep(BRIDGE_INFO_RETRY_MS);
        if (link !== this.link) return;
      }
    }
    if (link !== this.link) return;
    if (!(info && info.bridge >= 1)) { this.tooOld = true; return; }
    const fromMap = await this.readMap(link);
    if (link !== this.link) return;
    await this.targetsAndDetach(link, fromMap);
    // Ready only now (with the allowlist line): no connection meets a tab that still carries an earlier client's
    // state, and each scope's tabs from before the link up are in the model.
    if (link === this.link) this.info = info;
  }

  /**
   * Step 2: the receiver keeps its tab-to-scope map over a link drop and a relay restart (C10, each tab's scope), so
   * the model takes those tabs back into their scopes: free (no owner), not attached, not held, no target id yet. A
   * client of the scope that connects again sees them. The entries join at once, and each later event applies on top
   * (a tabs.onRemoved drops one, a bridge.tabScope adds one): the receiver sends its events in order, so an event
   * before the answer is in it already. A failed or late bridge.tabScopes is logged, and the relay goes on with no
   * tab of an earlier link. Returns the tabs that it added.
   */
  private async readMap(link: number): Promise<Set<number>> {
    const added = new Set<number>();
    let entries: unknown;
    try { entries = await this.bridge.call("bridge.tabScopes"); } catch (e) {
      this.log(`relay: bridge.tabScopes at the link up failed: ${(e as Error).message}`);
      return added;
    }
    if (link !== this.link || !Array.isArray(entries)) return added;
    for (const e of entries) {
      const id = e?.tabId, scope = e?.scope;
      if (!Number.isInteger(id) || id < 0 || typeof scope !== "string" || !SCOPE.test(scope) || this.tabs.has(id)) continue;
      // A line in the same read as the answer can have dropped the scope (review-58 B1): the tab stays out of it.
      if (this.noListFor(scope)) continue;
      const tab = this.tabOf(id);
      tab.scope = scope; tab.fromMap = true;
      this.keptScopes.delete(id);
      added.add(id);
    }
    if (added.size) this.log(`relay: ${added.size} tab(s) of the receiver's map at the link up`);
    return added;
  }

  /**
   * Steps 3 and 4. Step 3 changes only the model, and only the entries of step 2: an entry of a later bridge.tabScope
   * gets its target id as a popup's does. Step 4: a relay that starts with no link change (the daemon restarts a relay
   * that ended) finds the tabs of the relay before it still attached, with their clients' domain state: measured
   * (board ab-v16.39), the old client's Fetch pattern still paused a page's request, and its user-agent override
   * stayed. After a link change the receiver has already detached its bridge tabs, so each detach answers null. The
   * errors are ignored (the restore tab of a running import answers `not an agent tab`); a failed
   * debugger.getTargets is logged, and the relay goes on.
   */
  private async targetsAndDetach(link: number, fromMap: Set<number>): Promise<void> {
    let targets: unknown;
    try { targets = await this.bridge.call("debugger.getTargets"); } catch (e) {
      this.log(`relay: debugger.getTargets at the link up failed: ${(e as Error).message}`);
      return;
    }
    if (link !== this.link || !Array.isArray(targets)) { this.points.clear(); return; }
    const ids = new Map<number, string>(), attached = new Set<number>();
    for (const t of targets) {
      if (!Number.isInteger(t?.tabId) || t.tabId < 0) continue;
      if (typeof t.id === "string" && t.id) ids.set(t.tabId, t.id);
      if (t.attached === true) attached.add(t.tabId);
    }
    // The pages' last points stay for the targets that this step lists again (a Chrome restart gives new target ids).
    const listed = new Set(ids.values());
    for (const id of [...this.points.keys()]) if (!listed.has(id)) this.points.delete(id);
    let gone = 0;
    for (const id of fromMap) {
      const tab = this.tabs.get(id);
      if (!tab?.fromMap) continue;
      const targetId = ids.get(id);
      if (targetId) tab.targetId ??= targetId;
      else { this.removed(id); gone++; } // the tab closed (the receiver's map drops it at its own tabs.onRemoved)
    }
    if (gone) this.log(`relay: ${gone} tab(s) of the receiver's map are gone`);
    for (const id of attached) { const tab = this.tabs.get(id); if (tab) { tab.attached = false; tab.held = false; } }
    await Promise.all([...attached].map((id) => this.bridge.call("debugger.detach", [id]).catch(() => {})));
    if (attached.size) this.log(`relay: detached ${attached.size} tab(s) at the link up`);
  }

  private onLinkDown(): void {
    this.link++;
    this.closeAll(CLOSE.linkDown);
    this.reset();
    this.bridge.dropAll();
  }

  private reset(): void {
    for (const tab of this.tabs.values()) this.endHold(tab);
    this.front = null; this.frontWindow = null; this.at = null;
    this.paths = "unknown"; this.offUntil = 0;
    this.tabs.clear(); this.children.clear(); this.hidden.clear(); this.downloads.clear(); this.keptScopes.clear();
    for (const done of [...this.scopeWaiters.values()]) done(null);
    this.linkUp = false; this.info = null; this.tooOld = false; this.allowlist = null; this.lastApplied = null; this.rootsLine = false;
    // The relay drops its line at each link change (C10), and its roots with it.
    if (this.peerCheck && this.roots.size) { this.roots = new Map(); this.onRoots?.(this.roots); }
  }

  private closeAll([code, reason]: readonly [number, string]): void {
    const all = [...this.conns];
    this.conns.clear();
    for (const c of all) c.socket.close(code, reason);
  }

  /** The relay stops: every connection closes. */
  stop(): void {
    // Best effort: the daemon may stop reading at the same time. Stage 4 (the daemon) must turn the eager attach off
    // itself when a relay ends without a link change, else a new relay finds it on.
    if (this.linkUp && this.conns.size) this.bridge.call("bridge.attachNew", [false]).catch(() => {});
    this.closeAll(CLOSE.stopped);
  }

  /**
   * C10's end_scope: the scope's connections close (1000) and its tabs are removed. The receiver keeps the browser's
   * last window for every close (its removal queue and window rule, C10), so the relay sends each tabs.remove as it
   * is, with no query, window or queue of its own (board ab-v16.41, chrome-extension PR #17). A late end_scope, after
   * the receiver's sweep took a tab out of its scope (the orphan set, C5), gets `not an agent tab` (board ab-v16.48):
   * that removal is done for the relay, which drops the tab from its model and logs no error; the receiver's next
   * sweep item closes the tab. The receiver's sweep is the guarantee, end_scope the fast path (C4). From the
   * end_scope on, a new connection of the scope gets the no-list 503 until a later line names the scope again (`ended`).
   */
  private async endScope(scope: string): Promise<void> {
    if (!SCOPE.test(scope)) return; // no scope can have that name (C11's 404)
    this.ended.add(scope);
    for (const c of [...this.conns]) if (c.scope === scope) { c.socket.close(...CLOSE.scopeEnded); await this.close(c); }
    const tabs = [...this.tabs.values()].filter((t) => t.scope === scope);
    await Promise.all(tabs.map((tab) => this.bridge.call("tabs.remove", [tab.id]).then(() => {}, (e) => {
      if ((e as Error).message === NOT_AN_AGENT_TAB) { if (this.tabs.get(tab.id) === tab) this.drop(tab); }
      else this.log(`relay: end_scope kept tab ${tab.id}: ${(e as Error).message}`);
    })));
  }

  /** The tab leaves the model (its scope has no list any more, or the receiver took it out of its scope): its sessions end, and it carries no debugger. */
  private drop(tab: Tab): void {
    const attached = tab.attached || !!tab.attaching;
    this.removed(tab.id);
    tab.attached = false; tab.held = false;
    if (attached) this.bridge.call("debugger.detach", [tab.id]).catch(() => {});
  }

  // ------------------------------------------------------------------ connections

  open(scope: string, socket: Socket, root: Root | null = null): Conn {
    const c = new Conn(this.nextConn++, scope, socket, root);
    this.conns.add(c);
    // The receiver attaches and holds each new tab while a connection is open: popups wait for their owner.
    if (this.conns.size === 1) this.bridge.call("bridge.attachNew", [true]).catch((e) => this.log(`relay: bridge.attachNew failed: ${e.message}`));
    return c;
  }

  /** The connection left: its tabs are detached (no domain state stays behind) and free for the scope's next connection. */
  async close(c: Conn): Promise<void> {
    if (!this.conns.delete(c)) return;
    // A hold of a CDP button ends when the client's connection closes (C11).
    for (const tab of this.tabs.values()) if (tab.owner === c) this.endHold(tab);
    for (const sid of [...c.sessions.keys()]) await this.endSession(c, sid, false);
    for (const tab of this.tabs.values()) if (tab.owner === c) tab.owner = null;
    if (c.grants.length) {
      const types = new Set(c.grants.map((g) => g.type));
      c.grants = [];
      void this.queueSettings(() => this.rebuild(types));
    }
    if (!this.conns.size && this.linkUp) this.bridge.call("bridge.attachNew", [false]).catch(() => {});
  }

  /** One CDP message of a client. A call for Chrome goes to the bridge with no await before it, so Chrome gets the calls in order. */
  async onMessage(c: Conn, msg: any): Promise<void> {
    // A connection that the model closed (end_scope, a line without its list, a link change) can still send until its
    // close handshake ends (up to 30 s): none of that reaches the bridge, and it gets no answer (review-58 note 1).
    if (!this.conns.has(c)) return;
    const { id, method, sessionId } = msg ?? {};
    const params = msg?.params ?? {};
    const answer = (body: object) => { if (this.conns.has(c)) c.send(sessionId ? { id, sessionId, ...body } : { id, ...body }); };
    const fail = (message: string, code = -32000) => answer({ error: { code, message } });
    if (typeof method !== "string") return fail("Message must have string 'method' property", -32600);
    let tab: Tab | undefined, child: string | undefined, onPage = false;
    if (sessionId !== undefined && !c.browserSessions.has(sessionId)) {
      const own = c.sessions.get(sessionId);
      const childTab = this.children.get(sessionId);
      if (own) tab = this.tabs.get(own.tabId);
      else if (childTab !== undefined && this.tabs.get(childTab)?.owner === c) { tab = this.tabs.get(childTab); child = sessionId; }
      if (!tab) return fail(TEXT.noSession);
      onPage = true;
    }
    const to = route(method, params, onPage, { child: !!tab && this.children.get(params.sessionId) === tab.id, windowPerPage: this.windowPerPage });
    if (typeof to === "object") return fail(to.refused);
    // Layer 1 of the guard (C11; the per-scope design, section 6): a navigation of the tab's main frame, or a new tab's
    // URL, off the connection's scope's list never reaches Chrome, so it never reaches a service worker of a site off
    // that list.
    const off = offList(method, params, this.entriesOf(c.scope), tab && !child ? tab.targetId : undefined);
    if (off !== null) return fail(TEXT.notAllowed(off));
    if (to === "chrome") return this.forward(tab!, child, method, params, answer);
    try {
      const result = await this.handlers[method](c, params, sessionId, tab);
      answer({ result });
    } catch (e) {
      const err = cdpError(method, e);
      fail(err.message, err.code);
    }
  }

  private forward(tab: Tab, child: string | undefined, method: string, params: any, answer: (body: object) => void): void {
    // A client's Page.close goes to Chrome as any page call: the receiver runs it in its removal queue, with its window
    // rule, so it never closes the browser's last window (C10, C11; board ab-v16.41). On a child session (a frame or a
    // worker) Chrome refuses it, with no window rule.
    const send = () => this.send(tab, child, method, params, answer);
    // With the paths on, a client's Page.bringToFront goes through the activation step too, and answers after it (C11).
    const bring = this.windowPerPage && method === "Page.bringToFront" && !child && this.pathsOn();
    if (this.windowPerPage && (bring || startsAction(method, params))) {
      // The tab's earlier calls and every earlier activation first; the input goes right behind its own activation.
      void this.chainStep(tab, bring ? "bringToFront" : "input", bring ? () => this.sendNow(tab, child, method, params, answer) : send)
        .catch((e) => this.log(`relay: an input of tab ${tab.id} failed: ${(e as Error).message}`));
    } else if (tab.gate) this.behind(tab, tab.gate.then(send).catch((e) => this.log(`relay: a call of tab ${tab.id} failed: ${(e as Error).message}`)));
    else {
      // A catch-up (C11) is a step of the tab's gate: the tab's later calls wait behind it.
      const run = send();
      if (run) this.behind(tab, run.catch((e) => this.log(`relay: a call of tab ${tab.id} failed: ${(e as Error).message}`)));
    }
  }

  /** The tab's next calls wait for `step`; the last one clears the gate. */
  private behind(tab: Tab, step: Promise<void>): void {
    tab.gate = step;
    void step.then(() => { if (tab.gate === step) tab.gate = null; });
  }

  /**
   * One step of the activation chain (one step at a time for all connections): behind every earlier activation and the
   * tab's earlier calls. `after` goes right behind the activation, inside the step: the input that needed it (with its
   * catch-up), or for Page.bringToFront the client's own call, which is the step's raise (step 7). The tab's later calls
   * wait behind the step. A Target.activateTarget gets the error of its tabs.update.
   */
  private chainStep(tab: Tab, kind: StepKind, after?: () => unknown): Promise<void> {
    const before = tab.gate ? Promise.all([this.activations, tab.gate]) : this.activations;
    tab.chainSteps++;
    const run = before.then(async () => {
      try {
        if (kind === "bringToFront") await this.activate(tab, kind, after as () => Promise<unknown>);
        else { await this.activate(tab, kind); if (after) await after(); }
      } finally { tab.chainSteps--; }
    });
    const settled = run.then(() => {}, () => {});
    this.activations = settled;
    this.behind(tab, settled);
    return run;
  }

  /**
   * A client's window change (Browser.setWindowBounds) with the paths on: in the activation chain, so behind the step
   * that runs (its path plays at the window's old place), and behind the catch-ups that run in the window's pages
   * (review-68 B3). The client gets the error of its windows.update.
   */
  private afterSteps(tabIds: number[], change: () => Promise<void>): Promise<void> {
    const run = this.activations.then(async () => {
      for (const id of tabIds) { const t = this.tabs.get(id); if (t?.catchUp) await t.catchUp.catch(() => {}); }
      await change();
    });
    this.activations = run.then(() => {}, () => {});
    return run;
  }

  /**
   * Bring the page forward for an input that starts an action, as a person does (with the paths off: today's way,
   * activateToday), or run the activation step of the pointer design (with the paths on: step()).
   */
  private async activate(tab: Tab, kind: StepKind, bring?: () => Promise<unknown>): Promise<void> {
    if (this.pathsOn()) return this.step(tab, kind, bring);
    if (kind === "input") return this.activateToday(tab);
    // A Page.bringToFront or a Target.activateTarget that the chain took while the paths were on: as with the paths off.
    if (kind === "bringToFront") { void bring!().catch(() => {}); return; }
    await this.bridge.call("tabs.update", [tab.id, { active: true }]);
  }

  /**
   * Today's activation: a tab switch when another tab of its window is in front (a popup tab that the site opened
   * there; the relay never moves a tab between windows), and the focus for its window (chrome.windows.update:
   * Target.activateTarget only selects the tab, and on Linux a key into a window that is not focused gives its page the
   * focus while another page keeps it). An error or a bridge op that does not answer in ACTIVATE_MAX_MS is logged, and
   * the input goes on. An activation that gave up changes no tab and no window when its read answers later: by then
   * another page can have the focus for its own input.
   */
  private async activateToday(tab: Tab): Promise<void> {
    let gaveUp = false;
    const work = (async () => {
      const t = await this.bridge.call("tabs.get", [tab.id]);
      if (!t.active && !gaveUp) await this.bridge.call("tabs.update", [tab.id, { active: true }]);
      const w = await this.bridge.call("windows.get", [t.windowId]);
      if (!w.focused && !gaveUp) await this.bridge.call("windows.update", [t.windowId, { focused: true }]);
    })().catch((e) => this.log(`relay: the activation of tab ${tab.id} failed: ${(e as Error).message}`));
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<void>((r) => {
      timer = setTimeout(() => { gaveUp = true; this.log(`relay: the activation of tab ${tab.id} took more than ${ACTIVATE_MAX_MS} ms; the input goes on`); r(); }, ACTIVATE_MAX_MS);
    });
    await Promise.race([work, late]).finally(() => clearTimeout(timer));
  }

  /**
   * A client's call leaves the tab's gate: a pointer event first gets its catch-up when it needs one (C11, decided now,
   * against the page's point at this time). Returns the catch-up and the call behind it, or undefined when the call went.
   */
  private send(tab: Tab, child: string | undefined, method: string, params: any, answer: (body: object) => void): Promise<void> | undefined {
    const cu = child ? null : this.catchUpOf(tab, method, params);
    if (!cu) { void this.sendNow(tab, child, method, params, answer).catch(() => {}); return undefined; }
    const run = this.catchUp(tab, cu.from, cu.to, cu.move).then(() => { void this.sendNow(tab, child, method, params, answer).catch(() => {}); });
    tab.catchUp = run;
    void run.then(() => { if (tab.catchUp === run) tab.catchUp = null; });
    return run;
  }

  /** Send one client call to Chrome now; its answer goes to the client. Returns the bridge call. */
  private sendNow(tab: Tab, child: string | undefined, method: string, params: any, answer: (body: object) => void): Promise<unknown> {
    // A call into the relay's own isolated world (board ab-v16.80; review-68c note 3): it could change what the
    // geometry read sees there (screenX: the clamp box). Checked here, as the call goes to Chrome, not when it came: a
    // call that waited behind an activation step can name the world that the step's read made. The tab's own session
    // only: a child session (a frame of another renderer, a worker) numbers its contexts on its own. Not
    // Runtime.runIfWaitingForDebugger: it runs no code in a context, and its release of a held tab must go (review-72 note 6).
    if (!child && tab.worldIds.size && method !== "Runtime.runIfWaitingForDebugger" && contextsNamed(params).some((id) => tab.worldIds.has(id))) {
      answer({ error: { code: -32000, message: TEXT.relayWorld(method) } });
      return Promise.resolve();
    }
    const target = child ? { tabId: tab.id, sessionId: child } : { tabId: tab.id };
    const call = this.bridge.call("debugger.sendCommand", [target, method, withForce(method, params)]);
    this.tracked(tab, child, method, params, call);
    call.then((result) => {
      // The client's own world: the id that Chrome gave it names no world of the relay's now (an old id of the relay's
      // world from another renderer process, review-68 B1).
      if (method === "Page.createIsolatedWorld" && !child) tab.worldIds.delete((result as any)?.executionContextId);
      let r = hidesCookies(method) ? hideCookies(result) : result;
      if (r?.targetInfo) r = { ...r, targetInfo: { ...r.targetInfo, browserContextId: DEFAULT_CONTEXT } };
      answer({ result: r ?? {} });
    }, (e) => {
      answer({ error: cdpError(method, e) });
      // A command that does not wait for a promise and timed out still runs in Chrome: a detach ends it (C10).
      if (isTimeout(e) && !awaitsPromise(method, params)) void this.reattach(tab);
    });
    // The client's page is set up when it sends Runtime.runIfWaitingForDebugger, as with Chrome's own
    // waitForDebuggerOnStart: the receiver lets the held first request go, and a new tab gets its URL. Both come
    // behind the client's setup calls (one tab, in order). Not after this command's answer: measured live
    // (2026-11-04), Chrome answers no command of a tab whose first request the hold keeps, until the hold ends.
    if (method === "Runtime.runIfWaitingForDebugger" && !child) {
      if (tab.held) this.release(tab);
      if (tab.navigateTo) void this.navigate(tab);
    }
    return call;
  }

  // ------------------------------------------------------------------ the pointer (ab-v16.71; the agent pointer design, section 3)

  /** A log line at most once in 5 minutes for one key (C10's log rule for the relay). */
  private notice(key: string, line: string): void {
    const at = this.notices.get(key);
    if (at !== undefined && Date.now() - at < NOTICE_MS) return;
    this.notices.set(key, Date.now());
    this.log(line);
  }

  /** The paths are on (with one window per page only). Off for no display ends after 60 s; unknown paths get a probe, and the step that asks goes on with no path. */
  private pathsOn(): boolean {
    if (!this.windowPerPage) return false;
    if (this.paths === "off" && this.offUntil && Date.now() >= this.offUntil) { this.paths = "unknown"; this.offUntil = 0; }
    if (this.paths === "unknown") this.probe();
    return this.paths === "on";
  }

  private probeLink = -1;
  /** The probe (C11): daemon.pointerAt at each link up, and at a step that needs the paths while they are unknown. An answer turns them on. */
  private probe(): void {
    if (!this.windowPerPage || (this.probing && this.probeLink === this.link)) return;
    const link = this.link;
    this.probeLink = link;
    const run: Promise<void> = this.bridge.call("daemon.pointerAt").then((d) => {
      if (link !== this.link || !this.readAnswer(d) || this.paths === "on") return;
      // Each time the paths turn on, the front page is unknown: while they were off or unknown, raises went as today.
      this.paths = "on"; this.offUntil = 0; this.front = null; this.frontWindow = null;
      this.log(`relay: the pointer paths are on (the display is ${this.display!.width} x ${this.display!.height})`);
    }, (e) => { if (link === this.link) this.pointerError((e as Error).message); });
    const guarded: Promise<void> = run.finally(() => { if (this.probing === guarded) this.probing = null; });
    this.probing = guarded;
  }

  /** A daemon.pointerAt answer: at, the display's size and views; false when it is not one. */
  private readAnswer(d: any): boolean {
    const int = (v: unknown) => typeof v === "number" && Number.isInteger(v);
    if (!d || !int(d.x) || !int(d.y) || !int(d.width) || !int(d.height) || !int(d.views) || d.width < 1 || d.height < 1) {
      this.notice("bad answer", "relay: daemon.pointerAt gave no position; the pointer's place is unknown");
      return false;
    }
    this.at = { x: d.x, y: d.y }; this.display = { width: d.width, height: d.height }; this.views = d.views;
    return true;
  }

  /**
   * A daemon op's error (C11): `unknown op`, `wrong display` and `not connected` (an older daemon) turn the paths off
   * until the next link up, `no display` for 60 s; `busy`, `too many moves`, `disconnected` and the relay's timer
   * change no state. Each text is logged at most once in 5 minutes.
   */
  private pointerError(text: string): void {
    if (text === "unknown op" || text === "wrong display" || text === "not connected") { this.paths = "off"; this.offUntil = 0; }
    else if (text === "no display") { this.paths = "off"; this.offUntil = Date.now() + NO_DISPLAY_OFF_MS; this.at = null; }
    this.notice(`text ${text}`, `relay: the daemon's pointer op: ${text}${this.paths === "off" ? `; the pointer paths are off${this.offUntil ? " for 60 s" : " until the next link up"}` : ""}`);
  }

  /** daemon.pointerAt for the step: the pointer's place, or null (unknown). */
  private async readPointer(): Promise<Pt | null> {
    try {
      const d = await this.bridge.call("daemon.pointerAt");
      return this.readAnswer(d) ? this.at : (this.at = null);
    } catch (e) { this.at = null; this.pointerError((e as Error).message); return null; }
  }

  private pointOf(tab: Tab): LastPoint | null { return tab.targetId ? this.points.get(tab.targetId) ?? null : null; }
  private setPoint(tab: Tab, p: LastPoint | null): void {
    if (!tab.targetId) return;
    if (p) this.points.set(tab.targetId, p); else this.points.delete(tab.targetId);
  }

  /** The hold of a CDP button ends; a step that waits for it goes on. */
  private endHold(tab: Tab): void {
    tab.pressed = false;
    for (const done of tab.released.splice(0)) done();
  }

  /** The tab carries no debugger now: its hold ends, a client's device-metrics override is gone, and the relay's world needs making again. */
  private detached(tab: Tab): void {
    this.endHold(tab);
    tab.metrics = false;
  }

  /** A new tab that opens a window, or that becomes the active tab of the front page's window, is the front page: it comes on top (C11). */
  private newTabOnTop(tab: Tab, windowId: number, active: boolean): void {
    const ownWindow = ![...this.tabs.values()].some((t) => t !== tab && t.windowId === windowId);
    tab.windowId = windowId;
    if (this.paths !== "on" || !active) return;
    if (ownWindow || windowId === this.frontWindow) {
      if (this.front && this.front !== tab) this.front.covered = true;
      this.front = tab; this.frontWindow = windowId;
    }
  }

  /**
   * The bookkeeping of a client's call when it is sent to Chrome (C11): a pointer event on the tab's own session sets
   * the page's last point (a wheel more than 2 px from it makes it unknown), a child session's pointer input and touch
   * input make it unknown; a press holds a button until Chrome answered its release; the pointer input in flight; a
   * device-metrics override.
   */
  private tracked(tab: Tab, child: string | undefined, method: string, params: any, call: Promise<unknown>): void {
    if (!this.windowPerPage) return;
    const p = params ?? {};
    // A device-metrics override is in force from its set until its clear; Page's old pair acts as Emulation's (round 4).
    if (!child && (method === "Emulation.setDeviceMetricsOverride" || method === "Page.setDeviceMetricsOverride")) tab.metrics = true;
    if (!child && (method === "Emulation.clearDeviceMetricsOverride" || method === "Page.clearDeviceMetricsOverride")) tab.metrics = false;
    if (!child && VIEWPORT_CALLS.has(method)) this.dropGeo(tab);
    if (TOUCH_INPUT.has(method)) { this.setPoint(tab, null); return; }
    if (!POINTER_INPUT.has(method)) return;
    tab.covered = false;
    // A held button counts on any session of the page, a frame's too (review-68 B2): mousePressed until Chrome answered its mouseReleased.
    if (method === "Input.dispatchMouseEvent" && p.type === "mousePressed") tab.pressed = true;
    if (method === "Input.dispatchMouseEvent" && p.type === "mouseReleased") { const end = () => this.endHold(tab); call.then(end, end); }
    if (child) { this.setPoint(tab, null); return; }
    tab.pointerSent.add(call);
    const done = () => { tab.pointerSent.delete(call); };
    call.then(done, done);
    if (typeof p.x === "number" && typeof p.y === "number" && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      const cur = this.pointOf(tab);
      if (method === "Input.dispatchMouseEvent" && p.type === "mouseWheel") this.setPoint(tab, cur && near(cur, p, POINTER.POINTER_NEAR_PX) ? { x: cur.x, y: cur.y, x11: false } : null);
      else this.setPoint(tab, { x: p.x, y: p.y, x11: false });
    }
  }

  /** The relay's world's events (its context, its scripts): no client sees them. True when the relay drops the event. */
  private worldEvent(tab: Tab, method: string, params: any): boolean {
    if (method === "Runtime.executionContextCreated" && params?.context?.name === this.worldName) { tab.worldIds.add(params.context.id); return true; }
    // Another world with an id of the set: an old id of the relay's world, which Chromium gave to that world (board ab-v16.80).
    if (method === "Runtime.executionContextCreated") tab.worldIds.delete(params?.context?.id);
    const id = params?.executionContextId;
    if (method === "Runtime.executionContextDestroyed" && tab.worldIds.has(id)) { tab.worldIds.delete(id); return true; }
    if ((method === "Debugger.scriptParsed" || method === "Debugger.scriptFailedToParse") && tab.worldIds.has(id)) return true;
    // A new document of the main frame: its old contexts are gone, also with Runtime off (no
    // Runtime.executionContextsCleared then; review-72 note 1).
    if (method === "Runtime.executionContextsCleared" || (method === "Page.frameNavigated" && !params?.frame?.parentId)) tab.worldIds.clear();
    // A window event that the relay sees: the page's cached geometry goes.
    if (method === "Page.frameResized") this.dropGeo(tab);
    return false;
  }

  /**
   * The geometry read (section 3): one Runtime.evaluate in the relay's own isolated world, only for a bridge tab, one in
   * flight per tab, with no enable and with C10's default wait. Each read first sends Page.createIsolatedWorld on the
   * main frame and evaluates in the id that it returns (review-68 B1: after a cross-site navigation Chromium can give an
   * old id to a page's own world, and the relay sees no context event while no client has Runtime on); when the evaluate
   * names an unknown context (a navigation between the two calls), once more. The relay waits GEOMETRY_WAIT_MS and drops
   * a late answer, which then changes no kept geometry. The relay keeps a read (within the wait, and with no drop event
   * since it started) only when it is usable as a front page's geometry (usable(), no device-metrics
   * override, not minimized, not hidden); any other read, a failed one too, drops the kept one (review-68 N2). A catch-up's
   * own read (`keep` false: the relay does not know its window's state) changes no kept geometry. For a tab that is no
   * bridge tab: the kept geometry, or none. null: no read, or none in time.
   */
  private async geometry(tab: Tab, o: { minimized?: boolean; keep?: boolean } = {}): Promise<Geo | null> {
    if (!tab.targetId || this.tabs.get(tab.id) !== tab) return null;
    // No read of a tab that is no bridge tab (no attach of the relay's own): its last usable geometry, or none.
    if (!tab.attached) return tab.geo;
    if (tab.geoReading) return null;
    tab.geoReading = true;
    const target = { tabId: tab.id }, drops = tab.geoDrops;
    const read = (async () => {
      for (let tryNo = 0; tryNo < 2; tryNo++) {
        const w = await this.bridge.call("debugger.sendCommand", [target, "Page.createIsolatedWorld", { frameId: tab.targetId, worldName: this.worldName, grantUniversalAccess: false }]);
        if (!Number.isInteger(w?.executionContextId)) return null;
        const id = w.executionContextId as number;
        tab.worldIds = new Set([id]);
        try {
          // disableBreaks: the client and the relay share the tab's debugger session, so a client's breakpoint (its
          // condition, a logpoint), instrumentation breakpoint or pause would run its code in the relay's world before
          // the read (review-72 B1).
          const r = await this.bridge.call("debugger.sendCommand", [target, "Runtime.evaluate", { expression: GEO_EXPRESSION, contextId: id, returnByValue: true, disableBreaks: true }]);
          return geoOf(r?.result?.value);
        } catch (e) {
          // A navigation between the two calls took the world: an evaluate that names an unknown context. Once more.
          if (!/context/i.test((e as Error).message)) throw e;
        }
      }
      return null;
    })().catch(() => null).finally(() => { tab.geoReading = false; });
    const r = await this.within(GEOMETRY_WAIT_MS, read);
    if (r === TIMEOUT) return null; // a late answer changes nothing (it is dropped)
    // The read keeps or drops the kept geometry only when no drop event came after it started (round 3 of PR #68).
    if (o.keep !== false && drops === tab.geoDrops) tab.geo = r && this.usableFor(r, tab, { minimized: o.minimized, front: true }) ? r : null;
    return r;
  }

  /** A drop event of the kept geometry (a window event that the relay sees): it goes, and a read in flight keeps nothing. */
  private dropGeo(tab: Tab): void {
    tab.geo = null;
    tab.geoDrops++;
  }

  /** The geometry gives the window's real viewport (section 3): no device-metrics override, not minimized; the front page not hidden. */
  private usableFor(g: Geo | null, tab: Tab, o: { minimized?: boolean; front?: boolean } = {}): g is Geo {
    return usable(g, this.display) && !tab.metrics && !o.minimized && !(o.front && g.vis === "hidden");
  }

  /** Why a geometry is not usable, for the step's log line (sizes and ratios only, never a point). */
  private unusable(g: Geo | null, tab: Tab, o: { minimized?: boolean; front?: boolean } = {}): string {
    if (!g) return tab.geoReading ? "a read in flight" : tab.attached ? "no read" : "no bridge tab, and no cached geometry";
    if (tab.metrics) return "a device-metrics override";
    if (o.minimized) return "minimized";
    if (o.front && g.vis === "hidden") return "hidden";
    if (g.dpr !== 1 || g.scale !== 1) return `ratio ${g.dpr}, scale ${g.scale}`;
    if (!this.display || g.sw !== this.display.width || g.sh !== this.display.height) return `screen ${g.sw} x ${g.sh}`;
    return `viewport ${g.iw} x ${g.ih}`;
  }

  /** A display point recorded as a page's last point (an X record), or unknown when it is outside its viewport. */
  private mark(tab: Tab, g: Geo | null, d: Pt): void {
    const p = this.usableFor(g, tab) ? toPage(g, d) : null;
    this.setPoint(tab, p ? { x: p.x, y: p.y, x11: true } : null);
  }

  private async within<T>(ms: number, p: Promise<T>): Promise<T | typeof TIMEOUT> {
    let timer: NodeJS.Timeout | undefined;
    try { return await Promise.race([p, new Promise<typeof TIMEOUT>((r) => { timer = setTimeout(() => r(TIMEOUT), Math.max(0, ms)); })]); }
    finally { clearTimeout(timer); }
  }

  /**
   * The activation step with the paths on (section 3; C11): (1) read the tab and its window; (2) decide by the front
   * page; (3) wait and hold, only when a path can play; (4) plan; (5) play; (6) record; (7) bring the page forward,
   * then open the front page's gate. Each part has its limit; the input goes after the step (the chain).
   */
  private async step(tab: Tab, kind: StepKind, bring?: () => Promise<unknown>): Promise<void> {
    const t0 = Date.now();
    // Steps 1 and 2.
    let read: { t: any; w: any } | typeof TIMEOUT;
    try {
      read = await this.within(ACTIVATE_MAX_MS, (async () => {
        const t = await this.bridge.call("tabs.get", [tab.id]);
        return { t, w: await this.bridge.call("windows.get", [t.windowId]) };
      })());
    } catch (e) { read = TIMEOUT; this.log(`relay: the activation of tab ${tab.id} failed: ${(e as Error).message}`); }
    if (read === TIMEOUT) {
      if (Date.now() - t0 >= ACTIVATE_MAX_MS) this.log(`relay: the activation of tab ${tab.id} took more than ${ACTIVATE_MAX_MS} ms; the input goes on`);
      this.front = null; this.frontWindow = null;
      // The client's own call still goes, as with the paths off.
      if (kind === "bringToFront") void bring!().catch(() => {});
      // Step 7's one ACTIVATE_MAX_MS (review-68 N3): a receiver that does not answer holds the chain no longer.
      if (kind === "activateTarget" && await this.within(ACTIVATE_MAX_MS, this.bridge.call("tabs.update", [tab.id, { active: true }])) === TIMEOUT)
        this.log(`relay: the activation of tab ${tab.id} took more than ${ACTIVATE_MAX_MS} ms; the input goes on`);
      return;
    }
    const { t, w } = read;
    if (Number.isInteger(t.windowId)) tab.windowId = t.windowId;
    const front = this.front && this.tabs.get(this.front.id) === this.front ? this.front : null;
    const comes = !!front && (kind === "activateTarget" ? !t.active && t.windowId === this.frontWindow : front !== tab);
    // With the front page unknown, today's focus rule decides, with no path. A page becomes the front page (and gets a
    // record) only by a raise that the relay sends: windows.update for an input, the client's Page.bringToFront. A
    // window that has the focus can lie under a newer window (review-68 N1), and a tab switch raises no window.
    const raises = front ? comes : kind === "input" ? !w.focused : kind === "bringToFront";
    // A path can play when a page comes under the pointer and both last points are known; S and T are read again after step 3.
    const canPlay = comes && !!this.pointOf(front!) && !!this.pointOf(tab);
    let release: (() => void) | null = null, why = !front ? "the front page is unknown" : !canPlay ? "a last point is unknown" : "";
    let outcome: Outcome = { kind: "none" };
    let gF: Geo | null = null, gT: Geo | null = null, played = 0;
    try {
      if (canPlay) {
        // Step 3.
        const held = await this.waitAndHold(front!, tab);
        release = held.release;
        why = held.why ?? "";
        // S and T after the waits: Chrome's points (a catch-up or the pointer input in flight can have moved them).
        const S = this.pointOf(front!), T = this.pointOf(tab);
        if (held.ok && (!S || !T)) why = "a last point is unknown";
        if (held.ok && S && T) {
          // Step 4.
          let plan: Plan | typeof TIMEOUT;
          try { plan = await this.within(POINTER.POINTER_READ_WAIT_MS, this.plan(front!, tab, S, T, w)); } catch { plan = TIMEOUT; }
          if (plan === TIMEOUT) why = "the reads of step 4 took too long";
          else {
            gF = plan.gF; gT = plan.gT;
            if (plan.atIsT) outcome = { kind: "atIsT", T };
            else if (!plan.move) why = plan.why ?? "no plan";
            else {
              // Step 5.
              const p0 = Date.now();
              outcome = await this.play(plan.move, plan.Td!);
              played = Date.now() - p0;
              if (outcome.kind === "refused") why = `the daemon answered ${outcome.text}`;
            }
          }
        }
      }
      // Step 6: the X records.
      if (comes || (!front && raises)) await this.record(tab, front, outcome, gF, gT, w?.state === "minimized");
      // Step 7.
      // Chrome resets movement on the covered page's next event even when no X path changed its client point.
      // Mark before the raise: a failed or timed-out answer can still have raised the window.
      if (comes) front!.covered = true;
      const raised = await this.raise(tab, kind, t, w, comes, bring);
      if (raised && (comes || (!front && raises))) { this.front = tab; this.frontWindow = tab.windowId; }
      else if (!raised) { this.front = null; this.frontWindow = null; }
    } finally {
      release?.();
    }
    if (this.pointerLog) {
      const what = outcome.kind === "ok" || outcome.kind === "moved" || outcome.kind === "failed" ? `a path of ${outcome.points} points, ${outcome.kind === "ok" ? "ok" : outcome.kind === "moved" ? "pointer moved" : outcome.text} in ${played} ms`
        : outcome.kind === "atIsT" ? "no path needed (at is T)" : comes ? `no path (${why || outcome.kind})` : front ? "no page comes under the pointer" : "no path (the front page is unknown)";
      this.log(`relay: step ${kind} of tab ${tab.id}: ${what}; ${Date.now() - t0} ms`);
    }
  }

  /**
   * Step 3, within one ACTIVATE_MAX_MS: when the front page holds a button, wait for its release (no path when its tab's
   * next call waits in the activation chain, also when that comes during the wait: its release would wait behind this
   * step), wait for a catch-up that runs in it, chain its gate on its old gate (its later calls wait behind the step),
   * then wait for both pages' pointer input in flight.
   */
  private async waitAndHold(front: Tab, tab: Tab): Promise<{ ok: boolean; why?: string; release: (() => void) | null }> {
    const end = Date.now() + ACTIVATE_MAX_MS;
    const gated = () => front.chainSteps > 0;
    for (;;) {
      if (front.pressed && gated()) return { ok: false, why: "the front page holds a button and its next call waits in the activation chain", release: null };
      if (Date.now() >= end) return { ok: false, why: "step 3 reached its limit", release: null };
      if (front.pressed) {
        // One wait on the page at a time (review-68 N4): a wait that ends by its time takes itself out.
        await new Promise<void>((r) => {
          const done = () => { clearTimeout(timer); const i = front.released.indexOf(done); if (i >= 0) front.released.splice(i, 1); r(); };
          const timer = setTimeout(done, Math.min(25, end - Date.now()));
          front.released.push(done);
        });
        continue;
      }
      if (front.catchUp) {
        try { if (await this.within(Math.min(25, end - Date.now()), front.catchUp) === TIMEOUT) continue; } catch { /* its end */ }
        continue;
      }
      break;
    }
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const old = front.gate;
    this.behind(front, old ? Promise.all([old, held]).then(() => {}) : held);
    const inFlight = [...front.pointerSent, ...tab.pointerSent];
    if (inFlight.length && await this.within(end - Date.now(), Promise.allSettled(inFlight)) === TIMEOUT) return { ok: false, why: "pointer input in flight has no answer", release };
    return { ok: true, release };
  }

  /** Step 4: both geometries, `at` when it is unknown, the mapping, the checks, and the path from S to T. */
  private async plan(front: Tab, tab: Tab, S: Pt, T: Pt, w: any): Promise<Plan> {
    const [gF, gT] = await Promise.all([this.geometry(front), this.geometry(tab, { minimized: w?.state === "minimized" })]);
    const base = { gF, gT };
    if (!this.usableFor(gF, front, { front: true })) return { ...base, why: `the front page's geometry is not usable (${this.unusable(gF, front, { front: true })})` };
    if (!this.usableFor(gT, tab, { minimized: w?.state === "minimized" })) return { ...base, why: `the entering page's geometry is not usable (${this.unusable(gT, tab, { minimized: w?.state === "minimized" })})` };
    if (!this.at) await this.readPointer();
    if (!this.at || !this.display) return { ...base, why: "the pointer's place is unknown" };
    const rect = clampRect(gF), Sd = toDisplay(gF, S), Td = toDisplay(gT, T);
    if (!insideRect(rect, Sd) || !insideRect(rect, Td)) return { ...base, why: "S or T is outside the front page's content box" };
    // Build point 2: with at already at T no op runs, so once the live view exists (views above 0) the pointer is read first.
    if (this.at.x === Td.x && this.at.y === Td.y && this.views > 0) await this.readPointer();
    if (!this.at) return { ...base, why: "the pointer's place is unknown" };
    if (this.at.x === Td.x && this.at.y === Td.y) return { ...base, atIsT: true, Td };
    const path = await planPath(Sd, Td, { clamp: rect, random: this.random });
    if (!path) return { ...base, why: "the path does not fit the limits" };
    const move: Move = { at: this.at, from: Sd, path, width: this.display.width, height: this.display.height, notAfter: notAfter(), views: this.views };
    if (moveProblem([move], monotonicMs()) !== null) return { ...base, why: "the move does not pass C10's checks" };
    return { ...base, move, Td };
  }

  /** Step 5: daemon.movePointer, waited at most its wait (the bridge's timer of the relay). */
  private async play(move: Move, Td: Pt): Promise<Outcome> {
    const points = move.path.length;
    const pos = (d: any) => (d && Number.isInteger(d.x) && Number.isInteger(d.y) ? { x: d.x as number, y: d.y as number } : null);
    try {
      const d = await this.bridge.call("daemon.movePointer", [move], { wait: moveWait(move.path) });
      const end = pos(d);
      if (!end) { this.at = null; return { kind: "failed", text: "no position", points }; }
      this.at = end;
      if (Number.isInteger(d.views)) this.views = d.views;
      if (end.x !== Td.x || end.y !== Td.y) this.notice("end", `relay: a path ended ${Math.round(Math.hypot(end.x - Td.x, end.y - Td.y))} px from its target`);
      return { kind: "ok", end, points };
    } catch (e) {
      const text = (e as Error).message, data = e instanceof BridgeError ? e.data as any : undefined;
      const end = text === "pointer moved" ? pos(data) : null;
      if (end) {
        this.at = end;
        if (Number.isInteger(data.views)) this.views = data.views;
        this.notice("text pointer moved", "relay: the daemon's pointer op: pointer moved");
        return { kind: "moved", end, points };
      }
      this.pointerError(text);
      if (FAILED_PATH.has(text)) { this.at = null; return { kind: "failed", text, points }; }
      return { kind: "refused", text };
    }
  }

  /**
   * Step 6, the X records: on ok the answered position is both pages' last point; with at at T, T; on pointer moved the
   * position is at and the entering page's point, and the front page's is unknown. After a failed path (finding F:
   * every not now), and in each other step that brings a page under the pointer with no path, a read of the pointer
   * gives at and the entering page's point, and after a failed path the front page's too; a failed read leaves them unknown.
   */
  private async record(tab: Tab, front: Tab | null, o: Outcome, gF: Geo | null, gT: Geo | null, minimized = false): Promise<void> {
    if (o.kind === "ok") { if (front) this.mark(front, gF, o.end); this.mark(tab, gT, o.end); return; }
    if (o.kind === "atIsT") { this.setPoint(tab, { x: o.T.x, y: o.T.y, x11: true }); return; }
    if (o.kind === "moved") { this.mark(tab, gT, o.end); if (front) this.setPoint(front, null); return; }
    const failed = o.kind === "failed";
    const work = (async () => {
      const p = await this.readPointer();
      if (!p) { this.setPoint(tab, null); if (failed && front) this.setPoint(front, null); return; }
      const [ft, tt] = await Promise.all([failed && front ? (gF ? Promise.resolve(gF) : this.geometry(front)) : Promise.resolve(null), gT ? Promise.resolve(gT) : this.geometry(tab, { minimized })]);
      this.mark(tab, tt, p);
      if (failed && front) this.mark(front, ft, p);
    })();
    try {
      if (await this.within(POINTER.POINTER_READ_WAIT_MS, work) === TIMEOUT) { this.setPoint(tab, null); if (failed && front) this.setPoint(front, null); }
    } catch { this.setPoint(tab, null); }
  }

  /**
   * Step 7, within ACTIVATE_MAX_MS: tabs.update and windows.update (with focused true also to a focused window when the
   * page comes under the pointer), the client's own Page.bringToFront, or the tabs.update of Target.activateTarget.
   * After the limit, no tabs.update and no windows.update. False when the raise reached its limit or failed.
   */
  private async raise(tab: Tab, kind: StepKind, t: any, w: any, comes: boolean, bring?: () => Promise<unknown>): Promise<boolean> {
    let gaveUp = false, error: unknown;
    const work = (async () => {
      if (kind === "bringToFront") { await bring!(); return; }
      if (kind === "activateTarget") { await this.bridge.call("tabs.update", [tab.id, { active: true }]); return; }
      if (!t.active && !gaveUp) await this.bridge.call("tabs.update", [tab.id, { active: true }]);
      if ((comes || !w.focused) && !gaveUp) await this.bridge.call("windows.update", [t.windowId, { focused: true }]);
    })().catch((e) => { error = e; });
    const r = await this.within(ACTIVATE_MAX_MS, work);
    if (r === TIMEOUT) { gaveUp = true; this.log(`relay: the activation of tab ${tab.id} took more than ${ACTIVATE_MAX_MS} ms; the input goes on`); return false; }
    if (error === undefined) return true;
    if (kind === "activateTarget") throw error;
    if (kind === "input") this.log(`relay: the activation of tab ${tab.id} failed: ${(error as Error).message}`);
    return false;
  }

  /**
   * The catch-up of a client's pointer event (C11), decided when the event leaves the tab's gate, against the page's
   * point at that time: after an X record or cover, a move more than 50 px from it, or a press or wheel more than 2 px from it;
   * never while the page holds a button, and none while the tab has catch-up moves without an answer.
   */
  private catchUpOf(tab: Tab, method: string, params: any): { from: Pt; to: Pt; move: boolean } | null {
    if (!this.windowPerPage || this.paths !== "on" || !POINTER_INPUT.has(method) || this.tabs.get(tab.id) !== tab) return null;
    const pt = this.pointOf(tab), p = params ?? {};
    if (!pt || (!pt.x11 && !tab.covered) || typeof p.x !== "number" || typeof p.y !== "number" || tab.pressed || tab.unanswered > 0) return null;
    const type = String(p.type);
    const move = type === "mouseMoved" || type === "dragEnter" || type === "dragOver";
    if (!move && type !== "mousePressed" && type !== "mouseWheel" && type !== "drop") return null;
    return near(pt, p, move ? POINTER.POINTER_STEP_MAX_PX : POINTER.POINTER_NEAR_PX) ? null : { from: { x: pt.x, y: pt.y }, to: { x: p.x, y: p.y }, move };
  }

  /**
   * The catch-up: CDP mouseMoved events (no button) along a path of the same generator from the recorded point to the
   * event's point, with C10's path limits (else none). For a move, the client's move is the path's last step; for another
   * event, the path ends with a move at its point. When a move is due while CATCH_UP_MAX_UNANSWERED of the tab's moves
   * have no answer (a page with an open dialog answers none), it stops (counted and logged: review-63e note D).
   */
  private async catchUp(tab: Tab, from: Pt, to: Pt, move: boolean): Promise<void> {
    const t0 = Date.now();
    // The page's content box (its last usable geometry, else a read now): no catch-up move over a scrollbar.
    let g: Geo | null = tab.geo;
    if (!g) try { g = await this.geometry(tab, { keep: false }); } catch { g = null; }
    const clamp = usable(g, this.display) ? contentRect(g) : null;
    let path: PathPoint[] | null = null;
    try { path = await planPath(from, to, { random: this.random, clamp, keepEnd: true }); } catch { path = null; }
    if (!path) { this.notice("catch-up limits", "relay: a catch-up does not fit the path's limits; the event goes as it is"); return; }
    const moves = move ? path.slice(0, -1) : path;
    let t = 0, sent = 0;
    for (const p of moves) {
      t += p.dt;
      await sleep(t0 + t - Date.now());
      if (this.tabs.get(tab.id) !== tab || !tab.attached) return;
      if (tab.unanswered >= CATCH_UP_MAX_UNANSWERED) {
        this.catchUpStops++;
        this.log(`relay: a catch-up in tab ${tab.id} stopped at ${CATCH_UP_MAX_UNANSWERED} unanswered moves after ${sent} moves (${this.catchUpStops} since the relay's start)`);
        return;
      }
      tab.unanswered++;
      const params = { type: "mouseMoved", x: p.x, y: p.y, button: "none", buttons: 0 };
      const call = this.bridge.call("debugger.sendCommand", [{ tabId: tab.id }, "Input.dispatchMouseEvent", params]);
      const done = () => { tab.unanswered--; };
      call.then(done, done);
      this.tracked(tab, undefined, "Input.dispatchMouseEvent", params, call);
      sent++;
    }
    if (move) await sleep(t0 + t + path[path.length - 1].dt - Date.now());
    if (this.pointerLog) this.log(`relay: catch-up in tab ${tab.id}: ${sent} moves in ${Date.now() - t0} ms`);
  }

  // ------------------------------------------------------------------ tabs and sessions

  private tabOf(id: number): Tab {
    let tab = this.tabs.get(id);
    if (!tab) this.tabs.set(id, (tab = { id, targetId: null, scope: null, opener: null, owner: null, sessions: new Set(), attached: false, attaching: null, held: false, claimed: false, autoPending: null, navigateTo: null, seen: false, gate: null, fromMap: false, late: false,
      windowId: null, pressed: false, released: [], pointerSent: new Set(), catchUp: null, covered: false, unanswered: 0, chainSteps: 0, worldIds: new Set(), geoReading: false, metrics: false, geo: null, geoDrops: 0 }));
    return tab;
  }

  private byTarget(targetId: unknown): Tab | undefined {
    for (const t of this.tabs.values()) if (t.targetId === targetId) return t;
    return undefined;
  }

  /** A tab of the connection's scope by its target id; another scope's tab answers as no tab, so a connection cannot tell them apart. */
  private scoped(c: Conn, targetId: unknown): Tab {
    const tab = this.byTarget(targetId);
    if (!tab || tab.scope !== c.scope) throw new Error(TEXT.noTarget);
    return tab;
  }

  private scopeTabs(scope: string): Tab[] {
    return [...this.tabs.values()].filter((t) => t.scope === scope && t.targetId);
  }

  private async targetIdOf(tabId: number): Promise<string> {
    for (let i = 0; i < 40; i++) {
      const hit = (await this.bridge.call<any[]>("debugger.getTargets")).find((t) => t.tabId === tabId);
      if (hit) return hit.id;
      await sleep(50);
    }
    throw new Error(TEXT.noTarget);
  }

  private infoOf(tab: Tab, t: any): object {
    const opener = tab.opener !== null ? this.tabs.get(tab.opener)?.targetId : undefined;
    return { targetId: tab.targetId, type: "page", title: t?.title ?? "", url: t?.pendingUrl || t?.url || "", attached: !!tab.owner,
      canAccessOpener: false, browserContextId: DEFAULT_CONTEXT, ...(opener ? { openerId: opener } : {}) };
  }

  private async targetInfo(tab: Tab): Promise<object> {
    return this.infoOf(tab, await this.bridge.call("tabs.get", [tab.id]).catch(() => null));
  }

  /** One chrome.debugger attach per tab, also when two callers ask at once. */
  private ensureAttached(tab: Tab): Promise<void> {
    if (tab.attached) return Promise.resolve();
    tab.attaching ??= this.bridge.call("debugger.attach", [tab.id]).then(() => { tab.attached = true; }, (e) => {
      // An attach that timed out can still end later: a detach makes sure it leaves nothing (C10).
      if (isTimeout(e)) void this.bridge.call("debugger.detach", [tab.id]).catch(() => {});
      throw e;
    }).finally(() => { tab.attaching = null; });
    return tab.attaching;
  }

  /** The client's URL of a tab that Target.createTarget opened at about:blank (C10), after the hold. */
  private async navigate(tab: Tab): Promise<void> {
    const url = tab.navigateTo;
    tab.navigateTo = null;
    if (!url) return;
    // A line can change the scope's list during the hold (review-58 note 5): layer 1 judges the URL again by the last line.
    const off = offList("Page.navigate", { url }, tab.scope === null || this.ended.has(tab.scope) ? null : this.entriesOf(tab.scope), null);
    if (off !== null) { this.log(`relay: new tab ${tab.id} is not navigated: ${TEXT.notAllowed(off)}`); return; }
    try {
      await this.ensureAttached(tab);
      await this.bridge.call("debugger.sendCommand", [{ tabId: tab.id }, "Page.navigate", { url }]);
    } catch (e) { this.log(`relay: the navigation of new tab ${tab.id} failed: ${(e as Error).message}`); }
  }

  private release(tab: Tab): void {
    tab.held = false;
    this.bridge.call("bridge.release", [tab.id]).catch(() => {});
  }

  private forgetChildren(tab: Tab): void {
    for (const map of [this.children, this.hidden]) for (const [sid, t] of map) if (t === tab.id) map.delete(sid);
  }

  /** `c` left while a call for `tab` waited: it keeps no session and no ownership, and a tab with no session carries no debugger. */
  private async abandon(c: Conn, tab: Tab): Promise<never> {
    if (tab.owner === c) tab.owner = null;
    if (!tab.owner && !tab.sessions.size) await this.leave(tab, false);
    throw new Error("The connection closed");
  }

  /**
   * The last session of a tab went, and the tab carries no debugger. When the client only detached (its connection is
   * open), a pending URL of its Target.createTarget still comes, as with a direct create. When its connection left
   * (it closed, or the model closed it: end_scope, a line without its list), no navigation comes (review-58 note 1):
   * the tab stays at about:blank, free for the scope.
   */
  private async leave(tab: Tab, navigate: boolean): Promise<void> {
    if (tab.navigateTo) {
      if (navigate) {
        if (tab.held) this.release(tab);
        await this.navigate(tab);
      } else tab.navigateTo = null;
    }
    await this.detach(tab);
  }

  /** The tab's tabs.onCreated, which brings its hold: the real receiver sends it after its eager attach, after the tabs.create answer. */
  private seenEvent(tab: Tab): Promise<void> {
    if (tab.seen) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.seenWaiters.delete(tab.id); resolve(); }, CREATED_WAIT_MS);
      this.seenWaiters.set(tab.id, () => { clearTimeout(timer); this.seenWaiters.delete(tab.id); resolve(); });
    });
  }

  private async detach(tab: Tab): Promise<void> {
    this.forgetChildren(tab);
    tab.held = false;
    if (!tab.attached) return;
    tab.attached = false;
    this.detached(tab);
    await this.bridge.call("debugger.detach", [tab.id]).catch(() => {});
  }

  /** A new session of `c` on `tab`. `parent` is the session that gets Target.attachedToTarget: the root (undefined) or another session. */
  private async newSession(c: Conn, tab: Tab, parent: string | undefined, waiting: boolean, auto: boolean): Promise<string> {
    if (!this.conns.has(c)) return this.abandon(c, tab);
    if (tab.owner && tab.owner !== c) throw new Error(TEXT.inUse);
    tab.owner = c;
    try { await this.ensureAttached(tab); } catch (e) {
      if (!tab.sessions.size) tab.owner = null;
      throw e;
    }
    const sessionId = newSessionId();
    const info = await this.targetInfo(tab);
    // The connection can leave during either wait: then it gets no session.
    if (!this.conns.has(c)) return this.abandon(c, tab);
    tab.sessions.add(sessionId);
    c.sessions.set(sessionId, { tabId: tab.id, parent, auto });
    c.event(parent, "Target.attachedToTarget", { sessionId, targetInfo: { ...info, attached: true }, waitingForDebugger: waiting });
    // A client that does not wait (no waitForDebuggerOnStart) gets the tab running at once.
    if (!waiting && tab.held) this.release(tab);
    return sessionId;
  }

  /** The auto-attach session: one per connection and tab, also when Target.createTarget and tabs.onCreated both ask for it. */
  private autoAttach(c: Conn, tab: Tab, waiting = false): Promise<string | null> {
    if (tab.owner && tab.owner !== c) return Promise.resolve(null);
    for (const sid of tab.sessions) if (c.sessions.get(sid)?.auto) return Promise.resolve(sid);
    tab.autoPending ??= this.newSession(c, tab, c.autoParent, waiting, true).finally(() => { tab.autoPending = null; });
    return tab.autoPending;
  }

  /** End the sessions of a tab that Chrome detached or closed: each gets Target.detachedFromTarget on its parent session. */
  private dropSessions(tab: Tab): void {
    const owner = tab.owner;
    for (const sid of tab.sessions) {
      const s = owner?.sessions.get(sid);
      owner?.sessions.delete(sid);
      owner?.event(s?.parent, "Target.detachedFromTarget", { sessionId: sid, targetId: tab.targetId });
    }
    tab.sessions.clear();
    tab.navigateTo = null;
    this.forgetChildren(tab);
  }

  private async endSession(c: Conn, sid: string, notify = true): Promise<void> {
    const s = c.sessions.get(sid);
    if (!s) return;
    c.sessions.delete(sid);
    const tab = this.tabs.get(s.tabId);
    if (!tab) return;
    tab.sessions.delete(sid);
    if (notify) c.event(s.parent, "Target.detachedFromTarget", { sessionId: sid, targetId: tab.targetId });
    if (!tab.sessions.size) { tab.owner = null; await this.leave(tab, this.conns.has(c)); }
  }

  /** After a timeout (C10): detach the tab, which ends the command in Chrome; it keeps its scope and owner, and an auto-attach owner gets it again. */
  private async reattach(tab: Tab): Promise<void> {
    const owner = tab.owner;
    this.log(`relay: tab ${tab.id} detached after a timeout`);
    this.endHold(tab);
    this.dropSessions(tab);
    await this.detach(tab);
    if (owner && owner.autoAttach && this.conns.has(owner)) await this.autoAttach(owner, tab).catch((e) => this.log(`relay: attach of tab ${tab.id} failed: ${e.message}`));
    else tab.owner = null;
  }

  /** A new tab of the scope: discover clients hear of it, and the owner of its opener (else the first auto-attach client of the scope) takes it. */
  private async announce(tab: Tab): Promise<void> {
    const scoped = [...this.conns].filter((c) => c.scope === tab.scope);
    for (const c of scoped) if (c.discover) c.event(undefined, "Target.targetCreated", { targetInfo: await this.targetInfo(tab) });
    const heir = tab.owner ?? (tab.opener !== null ? this.tabs.get(tab.opener)?.owner ?? null : null);
    if (heir) tab.owner = heir;
    for (const c of heir ? [heir] : scoped) {
      if (!c.autoAttach || (tab.owner && tab.owner !== c)) continue;
      if (await this.autoAttach(c, tab, c.waitOnStart && tab.held).catch((e) => this.log(`relay: attach of tab ${tab.id} failed: ${e.message}`))) break;
    }
  }

  // ------------------------------------------------------------------ the receiver's events

  private onEvent(ev: any): void {
    switch (ev.ev) {
      case "debugger.onEvent": return this.onCdpEvent(ev.source ?? {}, String(ev.method), ev.params ?? {});
      case "debugger.onDetach": {
        const tab = this.tabs.get(ev.source?.tabId);
        if (!tab) return;
        this.log(`relay: Chrome detached tab ${tab.id}`);
        tab.attached = false; tab.held = false;
        this.detached(tab);
        this.dropSessions(tab);
        tab.owner = null;
        return;
      }
      case "tabs.onCreated": void this.onCreated(ev).catch((e) => this.log(`relay: new tab ${ev.tab?.id}: ${e.message}`)); return;
      case "tabs.onUpdated": {
        const tab = this.tabs.get(ev.tabId);
        if (!tab?.scope || !tab.targetId) return;
        for (const c of this.conns) if (c.discover && c.scope === tab.scope) c.event(undefined, "Target.targetInfoChanged", { targetInfo: this.infoOf(tab, ev.tab) });
        return;
      }
      case "bridge.tabScope": return this.onTabScope(ev.tabId, ev.scope);
      case "tabs.onRemoved":
        // A popup that closes while the receiver holds its tabs.onCreated gets none: its kept bridge.tabScope goes (C11).
        this.keptScopes.delete(ev.tabId);
        this.scopeWaiters.get(ev.tabId)?.(null);
        return this.removed(ev.tabId);
      case "tabs.onReplaced": {
        // The receiver sends the added tab's bridge.tabScope right before this event (C10): the added tab's scope comes
        // from it, never from the removed tab. The added tab keeps the removed tab's owner and opener in that scope.
        const old = this.tabs.get(ev.removedTabId);
        const scope = this.keptScopes.get(ev.addedTabId) ?? this.tabs.get(ev.addedTabId)?.scope ?? null;
        this.keptScopes.delete(ev.addedTabId);
        const same = !!old && old.scope !== null && old.scope === scope;
        const owner = same && old!.owner && this.conns.has(old!.owner) ? old!.owner : null;
        const opener = same ? old!.opener : null;
        if (old) this.removed(old.id);
        if (!scope || !Number.isInteger(ev.addedTabId)) return;
        const tab = this.tabOf(ev.addedTabId);
        tab.scope = scope; tab.owner = owner; tab.opener = opener; tab.claimed = true;
        void this.targetIdOf(tab.id).then((t) => { if (this.tabs.get(tab.id) !== tab) return; tab.targetId = t; return this.announce(tab); }).catch(() => {});
        return;
      }
      case "downloads.onCreated": return this.onDownloadItem(ev.item ?? {});
      case "downloads.onChanged": return this.onDownloadChange(ev.delta ?? {});
      case "bridge.tooLarge": {
        // Too large for the link: the client gets nothing, and the page never waits for an answer that cannot come.
        this.log(`relay: event too large: ${ev.of} ${ev.method ?? ""} tab ${ev.tabId}`);
        const action = tooLargeAction(ev);
        const target = ev.sessionId ? { tabId: ev.tabId, sessionId: ev.sessionId } : { tabId: ev.tabId };
        if (action) this.bridge.call("debugger.sendCommand", [target, ...action]).catch(() => {});
        return;
      }
      // webNavigation.* and the rest need no action. A log line names an op, a method, a tab, a size or a time, never an event's params.
    }
  }

  private onCdpEvent(source: { tabId?: number; sessionId?: string }, method: string, params: any): void {
    const tab = this.tabs.get(source.tabId!);
    // The relay's own isolated world (its geometry read): no client sees its context or its scripts.
    if (tab && !source.sessionId && this.worldEvent(tab, method, params)) return;
    const owner = tab?.owner;
    if (!tab || !owner || (source.sessionId && this.hidden.has(source.sessionId))) return;
    if (method === "Target.attachedToTarget" || method === "Target.targetCreated" || method === "Target.targetInfoChanged") {
      if (HIDDEN_TYPES.has(params.targetInfo?.type)) {
        if (method === "Target.attachedToTarget") this.hide(tab, source, params);
        return;
      }
      if (method === "Target.attachedToTarget") this.children.set(params.sessionId, tab.id);
    }
    if (method === "Target.detachedFromTarget" && this.hidden.delete(params.sessionId)) return;
    if (method === "Target.detachedFromTarget") this.children.delete(params.sessionId);
    if (method === "Page.downloadWillBegin" || method === "Page.downloadProgress") this.onDownload(owner, method, params);
    let p = hidesCookies(method) ? hideCookies(params) : params;
    if (p.targetInfo) p = { ...p, targetInfo: { ...p.targetInfo, browserContextId: DEFAULT_CONTEXT } };
    // An event of a child session (a frame or a worker) goes to the owner once; an event of the tab to each of its sessions.
    if (source.sessionId) owner.event(source.sessionId, method, p);
    else for (const sid of tab.sessions) owner.event(sid, method, p);
  }

  /**
   * A target that the model never reports, which Chrome attached through a page's auto-attach (a service worker of the
   * page: Playwright sets waitForDebuggerOnStart on each page). It must not stay paused or attached: the model lets it
   * run, detaches it from its parent session, and drops its events.
   */
  private hide(tab: Tab, source: { sessionId?: string }, p: any): void {
    this.hidden.set(p.sessionId, tab.id);
    const parent = source.sessionId ? { tabId: tab.id, sessionId: source.sessionId } : { tabId: tab.id };
    if (p.waitingForDebugger) this.bridge.call("debugger.sendCommand", [{ tabId: tab.id, sessionId: p.sessionId }, "Runtime.runIfWaitingForDebugger", {}]).catch(() => {});
    this.bridge.call("debugger.sendCommand", [parent, "Target.detachFromTarget", { sessionId: p.sessionId }]).catch(() => {});
  }

  /**
   * A new tab that the relay did not create (a popup, the receiver's about:blank tab of its window rule, the
   * operator's tab). It joins a scope only by the receiver's bridge.tabScope (C10, C11): the receiver enforces each
   * tab's list, so the relay never computes a tab's scope itself. For a popup the event comes before its tabs.onCreated
   * in practice (keptScopes); else the model keeps the tab with no scope, attached and held as the receiver reported
   * it, for up to TAB_SCOPE_WAIT_MS. With no scope then, it is released and detached, as a tab of no scope; a later
   * bridge.tabScope still puts it in its scope, as a free tab (onTabScope).
   */
  private async onCreated(ev: any): Promise<void> {
    const link = this.link;
    if (!Number.isInteger(ev.tab?.id)) return;
    const tab = this.tabOf(ev.tab.id);
    tab.attached = !!ev.attached; tab.held = !!ev.held; tab.seen = true;
    if (Number.isInteger(ev.tab.windowId)) this.newTabOnTop(tab, ev.tab.windowId, ev.tab.active === true);
    this.seenWaiters.get(tab.id)?.();
    if (this.creating.size) await Promise.allSettled([...this.creating]);
    if (tab.claimed || link !== this.link || this.tabs.get(tab.id) !== tab) return;
    tab.claimed = true;
    const kept = this.keptScopes.get(tab.id);
    this.keptScopes.delete(tab.id);
    tab.scope ??= kept ?? await this.scopeWait(tab);
    if (link !== this.link || this.tabs.get(tab.id) !== tab) return;
    if (!tab.scope) {
      tab.late = true;
      if (tab.attached) { this.release(tab); await this.detach(tab); }
      return;
    }
    // The owner: the owner of its opener, for an opener in the same scope. The opener comes from Chrome's own target
    // info: chrome.tabs' openerTabId named the active tab instead of the tab that called window.open (measured).
    if (tab.attached) {
      const info = await this.bridge.call("debugger.sendCommand", [{ tabId: tab.id }, "Target.getTargetInfo", {}]).then((r) => r?.targetInfo, () => null);
      const opener = info?.openerId ? this.byTarget(info.openerId) : undefined;
      if (info?.targetId) tab.targetId ??= info.targetId;
      if (opener && opener !== tab && opener.scope === tab.scope) tab.opener = opener.id;
    }
    tab.targetId ??= await this.targetIdOf(tab.id);
    if (this.tabs.get(tab.id) !== tab) return;
    await this.announce(tab);
    // Nobody took it: it carries no debugger until a connection attaches.
    if (!tab.sessions.size && tab.attached) { this.release(tab); await this.detach(tab); }
  }

  /** Up to TAB_SCOPE_WAIT_MS for the tab's bridge.tabScope: its scope, or null. */
  private scopeWait(tab: Tab): Promise<string | null> {
    return new Promise((resolve) => {
      const done = (scope: string | null) => { clearTimeout(timer); if (this.scopeWaiters.get(tab.id) === done) this.scopeWaiters.delete(tab.id); resolve(scope); };
      const timer = setTimeout(() => done(null), TAB_SCOPE_WAIT_MS);
      this.scopeWaiters.set(tab.id, done);
    });
  }

  /**
   * C10's bridge.tabScope: the receiver gave a tab a scope itself (a popup takes its opener's, a replaced tab its old
   * one). The relay never puts a tab in a scope that the receiver did not report.
   */
  private onTabScope(tabId: unknown, scope: unknown): void {
    if (!Number.isInteger(tabId) || (tabId as number) < 0 || typeof scope !== "string" || !SCOPE.test(scope)) return;
    const id = tabId as number;
    const tab = this.tabs.get(id);
    // Before the tab's tabs.onCreated or tabs.onReplaced: kept for it, until its tabs.onRemoved.
    if (!tab) { this.keptScopes.set(id, scope); return; }
    if (tab.scope !== null) {
      // The receiver changes no tab's scope (a replaced tab has a new id), so this names the scope that the tab has.
      if (tab.scope !== scope) this.log(`relay: bridge.tabScope of tab ${id} names another scope than the model's; the tab keeps its scope`);
      return;
    }
    tab.scope = scope;
    const waiter = this.scopeWaiters.get(id);
    if (waiter) { waiter(scope); return; }
    if (tab.late) void this.joinLate(tab).catch((e) => this.log(`relay: tab ${id}: ${(e as Error).message}`));
  }

  /** A tab whose bridge.tabScope came after TAB_SCOPE_WAIT_MS joins its scope as a free tab (it was detached at the end of the wait). */
  private async joinLate(tab: Tab): Promise<void> {
    tab.late = false;
    tab.targetId ??= await this.targetIdOf(tab.id);
    if (this.tabs.get(tab.id) !== tab) return;
    await this.announce(tab);
  }

  private removed(tabId: number): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    // Its point goes, its hold ends, and the front page is unknown when it was this page (C11).
    this.endHold(tab);
    if (tab.targetId) this.points.delete(tab.targetId);
    if (this.front === tab) { this.front = null; this.frontWindow = null; }
    this.dropSessions(tab);
    this.tabs.delete(tabId);
    if (tab.targetId) for (const c of this.conns) if (c.discover && c.scope === tab.scope) c.event(undefined, "Target.targetDestroyed", { targetId: tab.targetId });
  }

  // ------------------------------------------------------------------ downloads (the design, section 4.5)

  // Browser.setDownloadBehavior is refused to an extension, so Chrome saves each download in its own folder. The
  // model turns the tab's Page.download* events into the Browser.download* events that the client expects, and
  // copies the finished file to the client's download folder.
  private onDownload(c: Conn, method: string, p: any): void {
    if (method === "Page.downloadWillBegin") {
      this.downloads.set(p.guid, { conn: c, url: p.url, name: p.suggestedFilename || p.guid });
      if (c.download?.events) c.event(undefined, "Browser.downloadWillBegin", p);
      return;
    }
    const d = this.downloads.get(p.guid);
    if (!d) return;
    if (p.state === "completed") { void this.finish(p.guid, d, p); return; }
    if (p.state === "canceled") this.downloads.delete(p.guid);
    if (d.conn.download?.events) d.conn.event(undefined, "Browser.downloadProgress", p);
  }

  /** A finished download: the client hears "completed" only when its file is in its folder, else "canceled". */
  private async finish(guid: string, d: Download, p: any): Promise<void> {
    const behavior = d.conn.download?.behavior, dir = d.conn.download?.path;
    let done = !(dir && (behavior === "allowAndName" || behavior === "allow"));
    try {
      for (const end = Date.now() + this.downloadWaitMs; !done && Date.now() < end; await sleep(100)) {
        const query = d.item !== undefined ? { id: d.item } : { url: d.url, orderBy: ["-startTime"], limit: 1 };
        const [item] = await this.bridge.call<any[]>("downloads.search", [query]);
        if (item?.state === "complete" && item.filename) {
          // allowAndName: Playwright and agent-browser read <downloadPath>/<guid>.
          await copyFile(item.filename, join(dir!, basename(behavior === "allowAndName" ? guid : d.name)));
          done = true;
        }
      }
    } catch (e) { this.log(`relay: download copy failed (${(e as NodeJS.ErrnoException).code ?? "error"})`); }
    if (!done) this.log("relay: a download did not reach the client's folder; it is reported as canceled");
    this.downloads.delete(guid);
    if (d.conn.download?.events) d.conn.event(undefined, "Browser.downloadProgress", done ? p : { ...p, state: "canceled" });
  }

  private onDownloadItem(item: any): void {
    for (const d of this.downloads.values()) {
      if (d.item !== undefined || d.url !== item.url) continue;
      d.item = item.id;
      if (d.conn.download?.behavior === "deny") this.bridge.call("downloads.cancel", [item.id]).catch(() => {});
      return;
    }
  }

  /** A download that Chrome marks as dangerous waits for a person; agent mode cancels it and reports it canceled, so download.path() does not wait. */
  private onDownloadChange(delta: any): void {
    const danger = delta.danger?.current;
    if (!danger || SAFE_DANGER.has(danger)) return;
    for (const [guid, d] of this.downloads) {
      if (d.item !== delta.id) continue;
      this.downloads.delete(guid);
      this.bridge.call("downloads.cancel", [delta.id]).catch(() => {});
      if (d.conn.download?.events) d.conn.event(undefined, "Browser.downloadProgress", { guid, totalBytes: 0, receivedBytes: 0, state: "canceled" });
    }
  }

  // ------------------------------------------------------------------ permissions and content settings

  /** The connection's scope's list covers the host (C11: a grant reaches no host off its own scope's list). */
  private coveredFor(c: Conn, host: string): boolean {
    return covers(this.entriesOf(c.scope) ?? [], host);
  }

  private queueSettings(step: () => Promise<unknown>): Promise<unknown> {
    const run = this.settings.then(step);
    this.settings = run.catch((e) => this.log(`relay: content settings failed: ${e.message}`));
    return run;
  }

  /**
   * Set each content-setting type again: the grants of the open connections that their own scope's list still covers,
   * and automatic downloads for each entry of every list (C11). A content setting acts on the whole profile, so a grant
   * of one scope applies to another scope's tab on the same host, when that scope's list holds the host too.
   */
  private async rebuild(types: Iterable<string>): Promise<void> {
    for (const type of types) {
      await this.bridge.call("contentSettings.clear", [type]);
      const patterns = new Set<string>();
      if (type === "automaticDownloads") for (const d of this.allowlist?.union() ?? []) patterns.add(`*://*.${d}/*`);
      for (const c of this.conns) for (const g of c.grants) if (g.type === type && this.coveredFor(c, /^[^:]+:\/\/(?:\*\.)?([^:/]+)/.exec(g.pattern)?.[1] ?? "")) patterns.add(g.pattern);
      for (const primaryPattern of patterns) await this.bridge.call("contentSettings.set", [type, { primaryPattern, setting: "allow" }]);
    }
  }

  /** A window call acts only on a window that holds a tab of the connection's scope. */
  private async windowInScope(c: Conn, windowId: unknown, tabIds: number[] = []): Promise<any> {
    if (typeof windowId !== "number") throw new Error(TEXT.noWindow);
    const inWindow = await this.bridge.call<any[]>("tabs.query", [{ windowId }]);
    if (!inWindow.some((t) => this.tabs.get(t.id)?.scope === c.scope)) throw new Error(TEXT.noWindow);
    tabIds.push(...inWindow.map((t) => t.id));
    return this.bridge.call("windows.get", [windowId]);
  }

  // ------------------------------------------------------------------ the model's calls

  private readonly handlers: Record<string, Handler> = {
    "Browser.getVersion": async () => {
      const ua = this.info?.userAgent ?? "";
      const version = this.info?.fullVersion || /Chrome\/([\d.]+)/.exec(ua)?.[1] || "";
      return { protocolVersion: "1.3", product: `Chrome/${version}`, revision: "", userAgent: ua, jsVersion: "" };
    },
    "Browser.close": async (c) => {
      // A client never ends the shared agent browser: Browser.close ends this connection only, after its answer.
      setTimeout(() => { c.socket.close(...CLOSE.browserClose); }, 0);
      return {};
    },
    "Browser.setDownloadBehavior": async (c, p) => {
      c.download = { behavior: String(p.behavior), path: p.downloadPath, events: !!p.eventsEnabled };
      return {};
    },
    "Browser.cancelDownload": async (c, p) => {
      const d = this.downloads.get(p.guid);
      if (!d || d.conn !== c) return {};
      const ids = d.item !== undefined ? [d.item] : (await this.bridge.call<any[]>("downloads.search", [{ url: d.url, state: "in_progress" }])).map((i) => i.id);
      for (const id of ids) await this.bridge.call("downloads.cancel", [id]).catch(() => {});
      return {};
    },
    "Browser.grantPermissions": async (c, p) => {
      let patterns: string[];
      if (p.origin) {
        let u: URL;
        try { u = new URL(String(p.origin)); } catch { throw new Error(TEXT.notAllowed(String(p.origin))); }
        if (!this.coveredFor(c, u.hostname)) throw new Error(TEXT.notAllowed(u.hostname));
        patterns = [`${u.protocol}//${u.host}/*`];
      } else patterns = (this.entriesOf(c.scope) ?? []).map((d) => `*://*.${d}/*`); // no origin: the scope's list
      const names: string[] = Array.isArray(p.permissions) ? p.permissions.map(String) : [];
      for (const name of names) if (!PERMISSIONS[name]) throw new Error(TEXT.permission(name));
      await this.queueSettings(async () => {
        for (const name of names) for (const pattern of patterns) {
          await this.bridge.call("contentSettings.set", [PERMISSIONS[name], { primaryPattern: pattern, setting: "allow" }]);
          c.grants.push({ type: PERMISSIONS[name], pattern });
        }
      });
      return {};
    },
    "Browser.resetPermissions": async (c) => {
      const types = new Set(c.grants.map((g) => g.type));
      c.grants = [];
      await this.queueSettings(() => this.rebuild(types));
      return {};
    },
    "Browser.getWindowForTarget": async (c, p, _sid, page) => {
      const tab = p.targetId ? this.scoped(c, p.targetId) : page;
      if (!tab) throw new Error(TEXT.noTarget);
      const t = await this.bridge.call("tabs.get", [tab.id]);
      const w = await this.bridge.call("windows.get", [t.windowId]);
      return { windowId: t.windowId, bounds: { left: w.left, top: w.top, width: w.width, height: w.height, windowState: w.state } };
    },
    "Browser.getWindowBounds": async (c, p) => {
      const w = await this.windowInScope(c, p.windowId);
      return { bounds: { left: w.left, top: w.top, width: w.width, height: w.height, windowState: w.state } };
    },
    "Browser.setWindowBounds": async (c, p) => {
      const tabIds: number[] = [];
      await this.windowInScope(c, p.windowId, tabIds);
      const b = p.bounds ?? {}, update: Record<string, unknown> = {};
      for (const k of ["left", "top", "width", "height"]) if (b[k] !== undefined) update[k] = b[k];
      if (b.windowState) update.state = b.windowState;
      const change = async () => {
        // Any client's window change can change which window is on top (a "normal" state brings a minimized one up):
        // the front page is unknown (C11). It can move or resize a window: no kept geometry stays.
        this.front = null; this.frontWindow = null;
        for (const t of this.tabs.values()) this.dropGeo(t);
        if (Object.keys(update).length) await this.bridge.call("windows.update", [p.windowId, update]);
      };
      // With the paths on, the window moves only after the activation step that runs (a path that plays) and after the
      // catch-ups of its pages (review-68 B3).
      if (this.windowPerPage && this.paths === "on") await this.afterSteps(tabIds, change);
      else await change();
      return {};
    },
    "Target.setAutoAttach": async (c, p, sid) => {
      c.autoAttach = !!p.autoAttach; c.waitOnStart = !!p.waitForDebuggerOnStart; c.autoParent = sid;
      if (c.autoAttach) for (const tab of this.scopeTabs(c.scope)) await this.autoAttach(c, tab).catch((e) => this.log(`relay: attach of tab ${tab.id} failed: ${e.message}`));
      return {};
    },
    "Target.setDiscoverTargets": async (c, p) => {
      c.discover = !!p.discover;
      if (c.discover) for (const tab of this.scopeTabs(c.scope)) c.event(undefined, "Target.targetCreated", { targetInfo: await this.targetInfo(tab) });
      return {};
    },
    "Target.getTargets": async (c) => {
      const targetInfos = [];
      for (const tab of this.scopeTabs(c.scope)) targetInfos.push(await this.targetInfo(tab));
      return { targetInfos };
    },
    "Target.getTargetInfo": async (c, p) => {
      if (p.targetId) return { targetInfo: await this.targetInfo(this.scoped(c, p.targetId)) };
      return { targetInfo: { targetId: "agentwatch-browser", type: "browser", title: "", url: "", attached: true, canAccessOpener: false } };
    },
    "Target.getBrowserContexts": async () => ({ browserContextIds: [] }),
    "Target.createTarget": async (c, p) => {
      if (p.browserContextId && p.browserContextId !== DEFAULT_CONTEXT) throw new Error(TEXT.noContext);
      // C10: Chrome starts the first request of a tabs.create URL before the receiver can hold the tab. So the tab opens
      // at about:blank and gets the client's URL after the hold, as Playwright's newPage and goto do. With one window
      // per page (Linux) every page opens in a window of its own that takes no focus (C10's newWindow), also when the
      // client asks for a tab or a background tab: a background tab's page is hidden and draws nothing.
      const url = p.url && p.url !== "about:blank" ? String(p.url) : null;
      const flight = (async () => {
        // The scope is the second arg (C10): the receiver puts the tab under the scope's list before it answers, or
        // answers `no list for this scope` (the client gets it as -32000, C11) and opens no tab.
        const created = this.windowPerPage || p.newWindow ? (await this.bridge.call("windows.create", [{ url: "about:blank", focused: false }, c.scope])).tabs[0]
          : await this.bridge.call("tabs.create", [{ url: "about:blank", active: !p.background }, c.scope]);
        // A line (or an end_scope) in the same read as the answer can have dropped the scope (review-58 B1): then the
        // tab never joins it. It is a tab of no scope for the model (its tabs.onCreated waits, then releases and
        // detaches it), and the receiver's sweep closes it.
        if (this.noListFor(c.scope)) throw new Error(NO_LIST_FOR_SCOPE);
        const tab = this.tabOf(created.id);
        if (Number.isInteger(created.windowId)) this.newTabOnTop(tab, created.windowId, true);
        // The tab joins the scope also when its creator left meanwhile; then it is free for the scope.
        tab.scope = c.scope; tab.claimed = true; tab.navigateTo = url;
        if (this.conns.has(c)) tab.owner = c;
        await this.seenEvent(tab);
        tab.targetId ??= await this.targetIdOf(tab.id);
        return tab;
      })();
      this.creating.add(flight);
      let tab: Tab;
      try { tab = await flight; } finally { this.creating.delete(flight); }
      if (!this.conns.has(c)) return this.abandon(c, tab);
      for (const o of this.conns) if (o.discover && o.scope === c.scope) o.event(undefined, "Target.targetCreated", { targetInfo: await this.targetInfo(tab) });
      if (!this.conns.has(c)) return this.abandon(c, tab);
      // The creator owns the new tab; Playwright expects Target.attachedToTarget before this answer. A client that waits
      // for the target gets the URL after its runIfWaitingForDebugger (forward), any other client at once.
      if (c.autoAttach) {
        const waiting = c.waitOnStart && tab.held;
        await this.autoAttach(c, tab, waiting);
        if (!waiting) void this.navigate(tab);
      } else {
        if (tab.held) this.release(tab);
        await this.navigate(tab);
        if (tab.attached && !tab.sessions.size) await this.detach(tab);
      }
      return { targetId: tab.targetId };
    },
    "Target.closeTarget": async (c, p) => {
      // The receiver's close (C10: Target.closeTarget through chrome.debugger, no beforeunload), in its removal queue,
      // with its window rule; the client gets the receiver's answer, an error of the window rule too.
      await this.bridge.call("tabs.remove", [this.scoped(c, p.targetId).id]);
      return { success: true };
    },
    "Target.activateTarget": async (c, p) => {
      const tab = this.scoped(c, p.targetId);
      // With the paths on it goes through the activation step: behind the chain and its tab's gate, and it answers after the step (C11).
      if (this.windowPerPage && this.pathsOn()) await this.chainStep(tab, "activateTarget");
      else await this.bridge.call("tabs.update", [tab.id, { active: true }]);
      return {};
    },
    "Target.attachToTarget": async (c, p, sid) => ({ sessionId: await this.newSession(c, this.scoped(c, p.targetId), sid, false, false) }),
    "Target.detachFromTarget": async (c, p) => {
      if (!c.sessions.has(p.sessionId)) throw new Error(TEXT.noSession);
      await this.endSession(c, p.sessionId);
      return {};
    },
    "Target.attachToBrowserTarget": async (c) => {
      const sessionId = newSessionId();
      c.browserSessions.add(sessionId);
      return { sessionId };
    },
    // On a page session with one window per page only (route): the page draws in its window, so focus emulation
    // would only make it report the focus while another page has it.
    [FOCUS_EMULATION]: async () => ({}),
  };
}
