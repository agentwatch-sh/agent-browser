// A fake agent-mode extension behind a fake daemon, for the relay's tests. It reads the relay's bridge requests
// (contract C10) from the relay's standard output, answers them as the receiver would from a few tabs, and writes
// the receiver's events and the daemon's lines to the relay's standard input. It records every request, so a test
// can prove which calls reached "Chrome" and which never did. It starts no browser. Like the receiver of the
// per-scope build (chrome-extension 0.3.x), it keeps each tab's scope: the scope arg of tabs.create and windows.create,
// and for a popup its opener's, which it reports with bridge.tabScope before the popup's tabs.onCreated.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import WebSocket from "ws";
import { CDPConnection } from "../src/cdp.ts";
import { startRelay, type Relay, type RelayUse } from "../src/relay/endpoint.ts";
import type { PeerGate } from "../src/relay/peer.ts";
import type { FakeChrome, FakePage } from "./fake-chrome.ts";

export type FakeTab = { id: number; windowId: number; url: string; title: string; targetId: string; openerId?: string; active: boolean };
/** A page's geometry as the relay's read gives it (src/relay/pointer.ts, Geo). */
export type FakeGeo = { sx: number; sy: number; ow: number; oh: number; iw: number; ih: number; cw: number; ch: number; dpr: number; scale: number; sw: number; sh: number; vis: string };
/**
 * Each window at 0,0 on a 1280 x 900 display, its viewport 1280 x 809 from y 91 (Chrome's own frame on a display with no
 * window manager), with no scrollbar (the content box `cw` x `ch` is the viewport).
 */
export const GEO: FakeGeo = { sx: 0, sy: 0, ow: 1280, oh: 900, iw: 1280, ih: 809, cw: 1280, ch: 809, dpr: 1, scale: 1, sw: 1280, sh: 900, vis: "visible" };
/** A test's answer: a value is the data, { error } a bridge error text, undefined the default answer. */
type Override = (req: { op: string; args: any[] }) => any;

export const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/1.0.0.0 Safari/537.36";
/** An allowlist line (C10) whose default list, `entries`, every scope gets. */
export const lineOf = (entries: string[]) => ({ t: "allowlist", lists: { a: entries }, scopes: {}, default: "a" });
/** The allowlist line of the tests that need no list of their own: every scope gets the default list, ["a.example"]. */
export const LINE = lineOf(["a.example"]);

export class FakeReceiver {
  readonly input = new PassThrough();
  readonly output = new PassThrough();
  readonly requests: { op: string; args: any[]; id: string; wait: number }[] = [];
  /**
   * The daemon's own ops (C10, the daemon's own ops; board ab-v16.71): they never reach the receiver, so they are not in
   * `requests`. `daemon` answers them: a value is the data, { error, data? } an error, undefined no answer (the relay's
   * timer ends the wait). The default is a daemon from before those ops, whose receiver answers `unknown op`.
   */
  readonly daemonRequests: { op: string; args: any[]; id: string; wait: number }[] = [];
  daemon: (req: { op: string; args: any[] }) => any = () => ({ error: "unknown op" });
  /** The geometry that a read in the relay's isolated world gives, by tab. */
  geometry: (tabId: number) => FakeGeo = () => GEO;
  /** The isolated worlds that Page.createIsolatedWorld made: context id -> tab. */
  readonly worlds = new Map<number, number>();
  /**
   * Context ids that name a page's own world now (Chromium reuses ids in a new renderer process after a cross-site
   * navigation): an evaluate with such an id runs in the page's world and gets the page's own values.
   */
  readonly pageWorlds = new Map<number, FakeGeo>();
  private nextContext = 100;
  private namedWorlds = new Map<string, number>();
  readonly tabs = new Map<number, FakeTab>();
  readonly attached = new Set<number>();
  /** The receiver's tab-to-scope map (C10, each tab's scope): bridge.tabScopes answers it. */
  readonly scopes = new Map<number, string>();
  readonly downloads: any[] = [];
  attachNew = false;
  /** The window that has the focus (chrome.windows' focused): window 1, the operator's, at the start. */
  focusedWindow = 1;
  /** New windows from 10 on: the endpoint vectors name window 2 as one that holds no tab of the scope. */
  private nextWindow = 10;
  /** Above 0: tabs.create and windows.create in the real receiver's order (chrome-extension agent/attach.js): the answer
   *  first, tabs.onCreated this many ms later, after the eager attach; a debugger.attach of that tab waits for the event. */
  lateCreatedMs = 0;
  private readonly lateCreated = new Map<number, Promise<void>>();
  private nextTab = 7;
  /** A test's answer to a CDP command, or to any op. */
  command: (target: any, method: string, params: any) => any = () => undefined;
  op: Override = () => undefined;
  info: unknown = { bridge: 1, version: "0.2.0", id: "abcdefghijklmnopabcdefghijklmnop", userAgent: UA, fullVersion: "1.0.0.0" };

  constructor() {
    createInterface({ input: this.output }).on("line", (line) => { void this.handle(JSON.parse(line)); });
  }

  line(msg: object): void { if (!this.input.writableEnded) this.input.write(`${JSON.stringify(msg)}\n`); }
  emit(ev: string, fields: object): void { this.line({ t: "ev", ch: "bridge", ev, ...fields }); }
  sent(op: string, method?: string) { return this.requests.filter((r) => r.op === op && (method === undefined || r.args[1] === method)); }

  /**
   * A new tab, announced as the receiver does: with the eager attach on, it is attached and held. It is the active tab
   * of its window. A popup of a tab of a scope takes that scope, and the receiver reports it with bridge.tabScope before
   * the popup's tabs.onCreated (`scope` names another one, or null for none). `own`: a tab of tabs.create or
   * windows.create, whose scope the relay named, so no bridge.tabScope comes for it.
   */
  newTab(url: string, opener?: FakeTab, windowId = 1, late = 0, scope?: string | null, own = false): FakeTab {
    const tab = { id: this.nextTab++, windowId, url, title: "", targetId: `T${this.nextTab - 1}`, active: true, ...(opener ? { openerId: opener.targetId } : {}) };
    for (const t of this.tabs.values()) if (t.windowId === windowId) t.active = false;
    this.tabs.set(tab.id, tab);
    const inherited = scope === undefined ? (opener ? this.scopes.get(opener.id) : undefined) : scope ?? undefined;
    if (inherited) { this.scopes.set(tab.id, inherited); if (!own) this.emit("bridge.tabScope", { tabId: tab.id, scope: inherited }); }
    const announce = () => {
      if (this.attachNew) this.attached.add(tab.id);
      this.emit("tabs.onCreated", { tab: this.chromeTab(tab), attached: this.attachNew, held: this.attachNew });
    };
    if (late) this.lateCreated.set(tab.id, new Promise((r) => setTimeout(() => { announce(); r(); }, late)));
    else announce();
    return tab;
  }

  /** Chrome swaps a tab for another one (a prerendered page): the new tab keeps the old one's opener, and its scope (bridge.tabScope right before tabs.onReplaced). */
  replace(old: FakeTab): FakeTab {
    const tab = { ...old, id: this.nextTab++, targetId: `T${this.nextTab - 1}` };
    this.tabs.delete(old.id); this.attached.delete(old.id); this.tabs.set(tab.id, tab);
    const scope = this.scopes.get(old.id);
    this.scopes.delete(old.id);
    if (scope) { this.scopes.set(tab.id, scope); this.emit("bridge.tabScope", { tabId: tab.id, scope }); }
    this.emit("tabs.onReplaced", { addedTabId: tab.id, removedTabId: old.id });
    return tab;
  }

  chromeTab(t: FakeTab) { return { id: t.id, windowId: t.windowId, index: 0, active: t.active, url: t.url, title: t.title, status: "complete" }; }

  private async handle(req: { id: string; op: string; args: any[]; wait: number }): Promise<void> {
    if (req.op.startsWith("daemon.")) {
      this.daemonRequests.push(req);
      const r = await this.daemon({ op: req.op, args: req.args });
      if (r === undefined) return;
      if (r && typeof r === "object" && typeof r.error === "string") return this.line({ t: "res", ch: "bridge", id: req.id, ok: false, error: r.error, ...(r.data ? { data: r.data } : {}) });
      return this.line({ t: "res", ch: "bridge", id: req.id, ok: true, data: r });
    }
    this.requests.push(req);
    let data: any;
    try { data = await this.answer(req.op, req.args); } catch (e) { return this.line({ t: "res", ch: "bridge", id: req.id, ok: false, error: (e as Error).message }); }
    if (data && typeof data === "object" && typeof data.error === "string") return this.line({ t: "res", ch: "bridge", id: req.id, ok: false, error: data.error });
    this.line({ t: "res", ch: "bridge", id: req.id, ok: true, data: data ?? null });
  }

  private async answer(op: string, args: any[]): Promise<any> {
    const custom = await this.op({ op, args });
    if (custom !== undefined) return custom;
    const tab = (id: number) => { const t = this.tabs.get(id); if (!t) throw new Error(`No tab with id: ${id}.`); return t; };
    switch (op) {
      case "bridge.info": return this.info;
      case "bridge.tabScopes": return [...this.scopes].filter(([id]) => this.tabs.has(id)).map(([tabId, scope]) => ({ tabId, scope }));
      case "bridge.attachNew": this.attachNew = args[0]; return null;
      case "debugger.attach": { tab(args[0]); await this.lateCreated.get(args[0]); const already = this.attached.has(args[0]); this.attached.add(args[0]); return { already }; }
      case "debugger.detach": this.attached.delete(args[0]); return null;
      case "debugger.getTargets": return [...this.tabs.values()].map((t) => ({ id: t.targetId, tabId: t.id, type: "page", title: t.title, url: t.url, attached: this.attached.has(t.id) }));
      case "debugger.sendCommand": {
        const [target, method, params] = args;
        if (!this.attached.has(target.tabId)) return { error: "not attached" };
        const r = await this.command(target, method, params);
        if (r !== undefined) return r;
        const t = tab(target.tabId);
        // The relay's geometry read (pointer.ts): its own isolated world on the main frame, then one evaluate in it.
        if (method === "Page.createIsolatedWorld" && !target.sessionId) {
          const key = JSON.stringify([t.id, params.frameId, params.worldName]);
          const old = this.namedWorlds.get(key);
          const id = old !== undefined && this.worlds.has(old) && !this.pageWorlds.has(old) ? old : this.nextContext++;
          this.namedWorlds.set(key, id);
          this.worlds.set(id, t.id);
          return { executionContextId: id };
        }
        if (method === "Runtime.evaluate" && params?.contextId !== undefined) {
          const reused = this.pageWorlds.get(params.contextId);
          if (reused) return { result: { type: "object", value: reused } };
          if (this.worlds.get(params.contextId) !== t.id) return { error: JSON.stringify({ code: -32000, message: "Cannot find context with specified id" }) };
          return { result: { type: "object", value: this.geometry(t.id) } };
        }
        if (method === "Target.getTargetInfo") return { targetInfo: { targetId: t.targetId, type: "page", title: t.title, url: t.url, attached: true, browserContextId: "C1D2", ...(t.openerId ? { openerId: t.openerId } : {}) } };
        return {};
      }
      case "tabs.create": return this.chromeTab(this.newTab(args[0].url, undefined, 1, this.lateCreatedMs, args[1] ?? null, true));
      case "windows.create": {
        const id = this.nextWindow++, t = this.newTab(args[0].url, undefined, id, this.lateCreatedMs, args[1] ?? null, true);
        if (args[0].focused !== false) this.focusedWindow = id;
        return { id, state: "normal", focused: this.focusedWindow === id, tabs: [this.chromeTab(t)] };
      }
      case "tabs.get": return this.chromeTab(tab(args[0]));
      case "tabs.query": return [...this.tabs.values()].filter((t) => args[0].windowId === undefined || t.windowId === args[0].windowId).map((t) => this.chromeTab(t));
      case "tabs.update": {
        const t = tab(args[0]);
        if (args[1]?.active) for (const o of this.tabs.values()) if (o.windowId === t.windowId) o.active = o === t;
        return this.chromeTab(t);
      }
      case "tabs.remove": tab(args[0]); this.tabs.delete(args[0]); this.scopes.delete(args[0]); this.emit("tabs.onRemoved", { tabId: args[0], removeInfo: { windowId: 1, isWindowClosing: false } }); return null;
      case "windows.get": return { id: args[0], left: 0, top: 0, width: 1280, height: 800, state: "normal", type: "normal", focused: this.focusedWindow === args[0] };
      case "windows.update": if (args[1]?.focused) this.focusedWindow = args[0]; return { id: args[0], state: "normal", focused: this.focusedWindow === args[0] };
      case "downloads.search": return this.downloads.filter((d) => (args[0].id === undefined || d.id === args[0].id) && (args[0].url === undefined || d.url === args[0].url));
      default: return null; // tabs.update, downloads.cancel, contentSettings.*, bridge.release
    }
  }
}

export type Harness = { fake: FakeReceiver; relay: Relay; socket: string; logs: string[]; url: (scope: string) => string;
  connect: (scope?: string) => Promise<CDPConnection>; ready: (line?: object) => Promise<void>; close: () => Promise<void> };

export async function until<T>(fn: () => T, what = "the condition", ms = 5000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A relay of its own on a short temp socket path, with the fake behind it. */
export async function harness(opts: { maxRequest?: number; downloadWaitMs?: number; windowPerPage?: boolean; peerCheck?: boolean | PeerGate; stage?: boolean; use?: RelayUse } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "ab-relay-"));
  const socket = join(dir, "cdp.sock"), fake = new FakeReceiver(), logs: string[] = [], conns: CDPConnection[] = [];
  // One window per page (the Linux design) unless a test asks for the Mac's tabs: the tests do not depend on the platform.
  const relay = await startRelay({ socket, input: fake.input, output: fake.output, log: (l) => logs.push(l), windowPerPage: true, ...opts });
  const url = (scope: string) => `ws+unix://${socket}:/devtools/browser/${scope}`;
  return {
    fake, relay, socket, logs, url,
    connect: async (scope = "s1") => { const c = await CDPConnection.connect(url(scope)); conns.push(c); return c; },
    ready: async (line: object = LINE) => {
      fake.line({ t: "link", up: true, version: "0.3.1" });
      fake.line(line);
      await until(() => relay.model.notReady() === null, "the relay to be ready");
    },
    close: async () => {
      for (const c of conns) await c.close();
      fake.input.end();
      await relay.closed;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A raw WebSocket to the endpoint: its close code and reason, or the HTTP answer that refused it. */
export function raw(url: string, headers: Record<string, string> = {}): Promise<{ ws?: WebSocket; status?: number; body?: string; closed: Promise<[number, string]> }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    const closed = new Promise<[number, string]>((r) => ws.once("close", (code, reason) => r([code, String(reason)])));
    ws.once("open", () => resolve({ ws, closed }));
    ws.once("unexpected-response", (_req, res) => {
      let body = "";
      res.on("data", (d) => (body += d)).on("end", () => resolve({ status: res.statusCode, body, closed }));
    });
    ws.once("error", () => {});
  });
}

/**
 * Back the fake receiver with the fake Chrome of fake-chrome.ts, so that agent-browser's own commands run through the
 * relay with real answers: the tabs are the fake Chrome's pages (their windows, focus and front state), and each
 * debugger op is a CDP call on one connection of its own, as chrome.debugger is. Returns a function that ends that
 * connection.
 */
export async function backByChrome(fake: FakeReceiver, chrome: FakeChrome): Promise<() => void> {
  const ws = new WebSocket(chrome.ws, { perMessageDeflate: false });
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  const pending = new Map<number, (m: any) => void>(), ids = new Map<string, number>(), targets = new Map<number, string>();
  const sessions = new Map<number, string>(), tabOfSession = new Map<string, number>();
  let next = 1;
  const send = (method: string, params: object = {}, sessionId?: string) => new Promise<any>((resolve) => {
    const id = next++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    if (m.id !== undefined) { pending.get(m.id)?.(m); pending.delete(m.id); return; }
    const tabId = m.sessionId ? tabOfSession.get(m.sessionId) : undefined;
    if (tabId !== undefined) fake.emit("debugger.onEvent", { source: { tabId }, method: m.method, params: m.params ?? {} });
  });
  const idOf = (targetId: string) => {
    let id = ids.get(targetId);
    if (id === undefined) { ids.set(targetId, (id = 100 + ids.size)); targets.set(id, targetId); }
    return id;
  };
  // One model of the tabs' front state too (review-45b note 9): a tab is active when it is in front of its window in the
  // fake Chrome (not a background tab: FakeChrome.tabSwitches puts the others behind).
  const tab = (p: FakePage) => ({ id: idOf(p.targetId), windowId: p.windowId, index: 0, active: !p.background, url: p.url, ...(p.listedUrl ? { pendingUrl: p.listedUrl } : {}), title: p.title, status: "complete" });
  const page = (id: number) => {
    const p = chrome.pages.get(targets.get(id) ?? "");
    if (!p) throw new Error(`No tab with id: ${id}.`);
    return p;
  };
  fake.op = async ({ op, args }) => {
    switch (op) {
      case "tabs.create": {
        const t = tab(chrome.pages.get((await send("Target.createTarget", { url: args[0].url })).result.targetId)!);
        fake.emit("tabs.onCreated", { tab: t, attached: false, held: false });
        return t;
      }
      // A window of its own (agent-browser's open on Linux, ab-v16.26; the relay's every page, ab-v16.28): the fake Chrome's
      // new window, which takes the focus only when the call asks for it.
      case "windows.create": {
        const t = tab(chrome.pages.get((await send("Target.createTarget", { url: args[0].url, newWindow: true, background: args[0].focused === false })).result.targetId)!);
        fake.emit("tabs.onCreated", { tab: t, attached: false, held: false });
        return { id: t.windowId, state: "normal", focused: chrome.focusedWindow === t.windowId, tabs: [t] };
      }
      case "tabs.get": return tab(page(args[0]));
      // chrome.tabs.update({ active: true }) selects the tab in its window and does not focus the window.
      case "tabs.update": { const p = page(args[0]); if (args[1]?.active) chrome.selectTab(p); return tab(p); }
      // One model of the windows (review-45 F3): the receiver's window ops read and change the fake Chrome's.
      case "windows.get": return { id: args[0], left: 0, top: 0, width: 1280, height: 800, state: "normal", type: "normal", focused: chrome.focusedWindow === args[0] };
      case "windows.update": if (args[1]?.focused) chrome.focusWindow(args[0], "windows.update"); return { id: args[0], state: "normal", focused: chrome.focusedWindow === args[0] };
      case "tabs.query": return [...chrome.pages.values()].filter((p) => args[0].windowId === undefined || p.windowId === args[0].windowId).map(tab);
      case "tabs.remove":
        page(args[0]);
        await send("Target.closeTarget", { targetId: targets.get(args[0]) });
        fake.emit("tabs.onRemoved", { tabId: args[0], removeInfo: { windowId: 1, isWindowClosing: false } });
        return null;
      case "debugger.getTargets": return [...chrome.pages.values()].map((p) => ({ id: p.targetId, tabId: idOf(p.targetId), type: "page", url: p.url, title: p.title, attached: sessions.has(idOf(p.targetId)) }));
      case "debugger.attach": {
        page(args[0]);
        if (sessions.has(args[0])) return { already: true };
        const { sessionId } = (await send("Target.attachToTarget", { targetId: targets.get(args[0]), flatten: true })).result;
        sessions.set(args[0], sessionId); tabOfSession.set(sessionId, args[0]);
        return { already: false };
      }
      case "debugger.detach": {
        const sid = sessions.get(args[0]);
        if (sid) { sessions.delete(args[0]); tabOfSession.delete(sid); await send("Target.detachFromTarget", { sessionId: sid }); }
        return null;
      }
      case "debugger.sendCommand": {
        const [target, method, params] = args;
        const sid = target.sessionId ?? sessions.get(target.tabId);
        if (!sid) return { error: "not attached" };
        const r = await send(method, params ?? {}, sid);
        // chrome.debugger gives a CDP error as its JSON text.
        return r.error ? { error: JSON.stringify(r.error) } : r.result;
      }
    }
    return undefined;
  };
  return () => ws.close();
}
