// The browser model of agent mode (the two-modes design, sections 4 and 8; contract C11 in chrome-extension's
// docs/protocol.md, the master). chrome.debugger refuses the browser-level CDP calls to an extension, so the model
// answers them itself with bridge ops (C10): the targets are the tabs of the connection's scope, a tab belongs to
// one connection at a time (all sessions of a tab share its one chrome.debugger attachment and its domain state),
// and every other page call goes to debugger.sendCommand after the refusals of policy.ts. It grew from the probe's
// relay.mjs (docs/superpowers/specs/2026-11-03-two-modes-probe/).

import { randomBytes } from "node:crypto";
import { copyFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Bridge } from "./bridge.ts";
import { awaitsPromise, cdpError, DEFAULT_CONTEXT, hideCookies, hidesCookies, isTimeout, route, TEXT, tooLargeAction, withForce } from "./policy.ts";

/** The CDP permission names (as Playwright sends them) that chrome.contentSettings can grant, and their content setting. */
const PERMISSIONS: Record<string, string> = { geolocation: "location", notifications: "notifications", videoCapture: "camera",
  audioCapture: "microphone", clipboardReadWrite: "clipboard", clipboardSanitizedWrite: "clipboard" };
const CONTENT_TYPES = ["location", "notifications", "camera", "microphone", "clipboard", "automaticDownloads"];
/** Targets that the model never reports: so context.serviceWorkers() is empty. */
const HIDDEN_TYPES = new Set(["service_worker", "shared_worker", "browser"]);
/** chrome.downloads danger values that wait for a person's confirmation (not measured; agent mode never confirms one). */
/** How long Target.createTarget waits for its tab's tabs.onCreated, which brings the tab's hold (C10 does not order it before the answer). */
const CREATED_WAIT_MS = 2000;
const SAFE_DANGER = new Set(["safe", "accepted", "allowlistedByPolicy", "deepScannedSafe", "asyncScanning", "asyncLocalPasswordScanning"]);

export const CLOSE = {
  browserClose: [1000, "Browser.close ends this connection; the agent browser keeps running"],
  scopeEnded: [1000, "The agentwatch session ended"],
  linkDown: [1011, "The agent browser's link went down"],
  stopped: [1001, "The agent browser stopped"],
} as const;
export const NOT_READY = {
  link: "The agent browser is not ready: its extension is not connected.",
  allowlist: "The agent browser is not ready: its extension has not confirmed the allowlist.",
  old: "The agent browser is not ready: its extension is too old for agent mode.",
};

/** A client connection as the model sees it: the endpoint gives it a WebSocket. */
export type Socket = { send(text: string): void; close(code: number, reason: string): void };

type Tab = {
  id: number; targetId: string | null; scope: string | null; opener: number | null; owner: Conn | null;
  sessions: Set<string>; attached: boolean; attaching: Promise<void> | null; held: boolean; claimed: boolean; autoPending: Promise<string | null> | null;
  /** The client's URL of a tab that Target.createTarget opened at about:blank, until the model navigates it. */
  navigateTo: string | null;
  /** Its tabs.onCreated came (with attached and held). */
  seen: boolean;
};
type Session = { tabId: number; parent?: string; auto: boolean };
type Download = { conn: Conn; url: string; name: string; item?: number };

export class Conn {
  readonly id: number;
  readonly scope: string;
  readonly socket: Socket;
  readonly sessions = new Map<string, Session>();
  readonly browserSessions = new Set<string>();
  autoAttach = false;
  waitOnStart = false;
  autoParent: string | undefined;
  discover = false;
  download: { behavior: string; path?: string; events: boolean } | null = null;
  grants: { type: string; pattern: string }[] = [];
  constructor(id: number, scope: string, socket: Socket) { this.id = id; this.scope = scope; this.socket = socket; }
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
  private nextConn = 1;
  private link = 0; // the generation of the link: an answer from before a link change changes nothing
  private linkUp = false;
  private info: { bridge: number; userAgent?: string; fullVersion?: string; version?: string } | null = null;
  private tooOld = false;
  private allowlist: string[] | null = null;
  private cleared = false;
  private settings: Promise<unknown> = Promise.resolve();
  /** How long a finished download may take to show up complete in chrome.downloads. */
  private readonly downloadWaitMs: number;

  constructor(bridge: Bridge, log: (line: string) => void, opts: { downloadWaitMs?: number } = {}) {
    this.bridge = bridge; this.log = log; this.downloadWaitMs = opts.downloadWaitMs ?? 5000;
  }

  /** Why a new connection is refused (C11's 503 texts), or null when the endpoint is ready. */
  notReady(): string | null {
    if (!this.linkUp) return NOT_READY.link;
    if (this.tooOld) return NOT_READY.old;
    if (!this.allowlist) return NOT_READY.allowlist;
    return this.info ? null : NOT_READY.link;
  }

  // ------------------------------------------------------------------ the daemon's lines

  /** A line from the daemon other than a res: a receiver event, a link change, an allowlist or the end of a scope. */
  onDaemon(msg: any): void {
    if (msg.t === "ev") this.onEvent(msg);
    else if (msg.t === "link" && msg.up) void this.onLinkUp();
    else if (msg.t === "link") this.onLinkDown();
    else if (msg.t === "allowlist" && Array.isArray(msg.domains)) {
      this.allowlist = msg.domains.map(String);
      // Content settings act on the whole profile: the grants that the new list still covers, and automatic downloads for its domains.
      void this.queueSettings(() => this.rebuild(CONTENT_TYPES));
    } else if (msg.t === "end_scope") void this.endScope(String(msg.scope));
  }

  private async onLinkUp(): Promise<void> {
    // A new receiver detached every tab at its link up (C10): no session of an earlier link is alive.
    this.closeAll(CLOSE.linkDown);
    this.reset();
    const link = ++this.link;
    this.linkUp = true;
    // At the first link up no grant of an earlier run may stay: content settings stay after a restart.
    if (!this.cleared) {
      this.cleared = true;
      void this.queueSettings(async () => { for (const t of CONTENT_TYPES) await this.bridge.call("contentSettings.clear", [t]); });
    }
    try {
      const info = await this.bridge.call("bridge.info");
      if (link !== this.link) return;
      if (info && info.bridge >= 1) this.info = info; else this.tooOld = true;
    } catch (e) {
      if (link === this.link && (e as Error).message === "unknown op") this.tooOld = true;
      else this.log(`relay: bridge.info failed: ${(e as Error).message}`);
    }
  }

  private onLinkDown(): void {
    this.link++;
    this.closeAll(CLOSE.linkDown);
    this.reset();
    this.bridge.dropAll();
  }

  private reset(): void {
    this.tabs.clear(); this.children.clear(); this.hidden.clear(); this.downloads.clear();
    this.linkUp = false; this.info = null; this.tooOld = false; this.allowlist = null;
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

  private async endScope(scope: string): Promise<void> {
    for (const c of [...this.conns]) if (c.scope === scope) { c.socket.close(...CLOSE.scopeEnded); await this.close(c); }
    for (const tab of [...this.tabs.values()]) if (tab.scope === scope) await this.bridge.call("tabs.remove", [tab.id]).catch(() => {});
  }

  // ------------------------------------------------------------------ connections

  open(scope: string, socket: Socket): Conn {
    const c = new Conn(this.nextConn++, scope, socket);
    this.conns.add(c);
    // The receiver attaches and holds each new tab while a connection is open: popups wait for their owner.
    if (this.conns.size === 1) this.bridge.call("bridge.attachNew", [true]).catch((e) => this.log(`relay: bridge.attachNew failed: ${e.message}`));
    return c;
  }

  /** The connection left: its tabs are detached (no domain state stays behind) and free for the scope's next connection. */
  async close(c: Conn): Promise<void> {
    if (!this.conns.delete(c)) return;
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
    const to = route(method, params, onPage, !!tab && this.children.get(params.sessionId) === tab.id);
    if (typeof to === "object") return fail(to.refused);
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
    const target = child ? { tabId: tab.id, sessionId: child } : { tabId: tab.id };
    this.bridge.call("debugger.sendCommand", [target, method, withForce(method, params)]).then((result) => {
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
  }

  // ------------------------------------------------------------------ tabs and sessions

  private tabOf(id: number): Tab {
    let tab = this.tabs.get(id);
    if (!tab) this.tabs.set(id, (tab = { id, targetId: null, scope: null, opener: null, owner: null, sessions: new Set(), attached: false, attaching: null, held: false, claimed: false, autoPending: null, navigateTo: null, seen: false }));
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
    if (!tab.owner && !tab.sessions.size) await this.leave(tab);
    throw new Error("The connection closed");
  }

  /** The last session of a tab went: a pending client URL still comes, as with a direct create, then the tab carries no debugger. */
  private async leave(tab: Tab): Promise<void> {
    if (tab.navigateTo) {
      if (tab.held) this.release(tab);
      await this.navigate(tab);
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
    if (!tab.sessions.size) { tab.owner = null; await this.leave(tab); }
  }

  /** After a timeout (C10): detach the tab, which ends the command in Chrome; it keeps its scope and owner, and an auto-attach owner gets it again. */
  private async reattach(tab: Tab): Promise<void> {
    const owner = tab.owner;
    this.log(`relay: tab ${tab.id} detached after a timeout`);
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
      case "tabs.onRemoved": return this.removed(ev.tabId);
      case "tabs.onReplaced": {
        const old = this.tabs.get(ev.removedTabId);
        if (!old?.scope) return;
        const owner = old.owner && this.conns.has(old.owner) ? old.owner : null;
        this.removed(old.id);
        // The new tab takes the old one's place: its scope, its owner and its opener.
        const tab = this.tabOf(ev.addedTabId);
        tab.scope = old.scope; tab.owner = owner; tab.opener = old.opener; tab.claimed = true;
        void this.targetIdOf(tab.id).then((t) => { tab.targetId = t; return this.announce(tab); }).catch(() => {});
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

  private async onCreated(ev: any): Promise<void> {
    const link = this.link;
    const tab = this.tabOf(ev.tab.id);
    tab.attached = !!ev.attached; tab.held = !!ev.held; tab.seen = true;
    this.seenWaiters.get(tab.id)?.();
    if (this.creating.size) await Promise.allSettled([...this.creating]);
    if (tab.claimed || link !== this.link) return;
    // The opener comes from Chrome's own target info: chrome.tabs' openerTabId named the active tab instead of the
    // tab that called window.open (measured). A tab with no opener in a scope is in no scope: no connection sees it.
    if (tab.attached) {
      const info = await this.bridge.call("debugger.sendCommand", [{ tabId: tab.id }, "Target.getTargetInfo", {}]).then((r) => r?.targetInfo, () => null);
      const opener = info?.openerId ? this.byTarget(info.openerId) : undefined;
      if (info?.targetId) tab.targetId = info.targetId;
      if (opener?.scope) { tab.opener = opener.id; tab.scope = opener.scope; }
    }
    if (!tab.scope) {
      this.tabs.delete(tab.id);
      if (tab.attached) { this.release(tab); await this.detach(tab); }
      return;
    }
    tab.targetId ??= await this.targetIdOf(tab.id);
    await this.announce(tab);
    // Nobody took it: it carries no debugger until a connection attaches.
    if (!tab.sessions.size && tab.attached) { this.release(tab); await this.detach(tab); }
  }

  private removed(tabId: number): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
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

  private covers(host: string): boolean {
    return (this.allowlist ?? []).some((d) => host === d || host.endsWith(`.${d}`));
  }

  private queueSettings(step: () => Promise<unknown>): Promise<unknown> {
    const run = this.settings.then(step);
    this.settings = run.catch((e) => this.log(`relay: content settings failed: ${e.message}`));
    return run;
  }

  /** Set each content-setting type again from the grants of the open connections that the list covers (and automatic downloads for its domains). */
  private async rebuild(types: Iterable<string>): Promise<void> {
    for (const type of types) {
      await this.bridge.call("contentSettings.clear", [type]);
      const patterns = new Set<string>();
      if (type === "automaticDownloads") for (const d of this.allowlist ?? []) patterns.add(`*://*.${d}/*`);
      for (const c of this.conns) for (const g of c.grants) if (g.type === type && this.covers(/^[^:]+:\/\/(?:\*\.)?([^:/]+)/.exec(g.pattern)?.[1] ?? "")) patterns.add(g.pattern);
      for (const primaryPattern of patterns) await this.bridge.call("contentSettings.set", [type, { primaryPattern, setting: "allow" }]);
    }
  }

  /** A window call acts only on a window that holds a tab of the connection's scope. */
  private async windowInScope(c: Conn, windowId: unknown): Promise<any> {
    if (typeof windowId !== "number") throw new Error(TEXT.noWindow);
    const inWindow = await this.bridge.call<any[]>("tabs.query", [{ windowId }]);
    if (!inWindow.some((t) => this.tabs.get(t.id)?.scope === c.scope)) throw new Error(TEXT.noWindow);
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
        if (!this.covers(u.hostname)) throw new Error(TEXT.notAllowed(u.hostname));
        patterns = [`${u.protocol}//${u.host}/*`];
      } else patterns = (this.allowlist ?? []).map((d) => `*://*.${d}/*`); // no origin: the allowlisted domains
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
      await this.windowInScope(c, p.windowId);
      const b = p.bounds ?? {}, update: Record<string, unknown> = {};
      for (const k of ["left", "top", "width", "height"]) if (b[k] !== undefined) update[k] = b[k];
      if (b.windowState) update.state = b.windowState;
      if (Object.keys(update).length) await this.bridge.call("windows.update", [p.windowId, update]);
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
      // at about:blank and gets the client's URL after the hold, as Playwright's newPage and goto do.
      const url = p.url && p.url !== "about:blank" ? String(p.url) : null;
      const flight = (async () => {
        const created = p.newWindow ? (await this.bridge.call("windows.create", [{ url: "about:blank", focused: false }])).tabs[0]
          : await this.bridge.call("tabs.create", [{ url: "about:blank", active: !p.background }]);
        const tab = this.tabOf(created.id);
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
      await this.bridge.call("tabs.remove", [this.scoped(c, p.targetId).id]);
      return { success: true };
    },
    "Target.activateTarget": async (c, p) => {
      await this.bridge.call("tabs.update", [this.scoped(c, p.targetId).id, { active: true }]);
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
  };
}
