// The fakes of the sign-in act's tests (board ab-v16.97.4): the model's act port with a fake act tab and its page, the
// receiver's channel main of the act (C4: act_rules, act_cookies, act_end), the X screen, the store, and stage 1c's
// move. They record each call in order, with the state at its time, so a test can prove the act's order: no key before
// the receiver confirmed the act's rules and before the window was outside the screen. Every value is a TEST value.

import { seededRandom } from "../src/human/random.ts";
import { paramsFor, personFor } from "../src/human/person.ts";
import type { FieldRead, PageRead } from "../src/service/signins/act-rules.ts";
import { SignInAct, type ActModelPort, type ActReceiver, type ActScreen, type ActStore, type SignInActOptions } from "../src/service/signins/act.ts";
import type { RecordFields } from "../src/service/signins/seal.ts";
import type { StoreState } from "../src/service/signins/store.ts";

export const ORIGIN = "http://login.localhost:8080";
/** A username with a character that has no US key: the act inserts it as text (fast in tests). */
export const USER = "canary.üser@act.localhost.test";
/** A password with a character that has no US key: the act inserts it as text (fast in tests). */
export const PASS_INSERT = "Canary-Act-Päss-7Q";
/** A password whose every character has a US key: the act types it with the generator's keys. */
export const PASS_KEYS = "Cn7q";
export const CANARIES = [USER, PASS_INSERT, PASS_KEYS];

export const field = (i: number, type: string, o: Partial<FieldRead> = {}): FieldRead =>
  ({ i, type, visible: true, enabled: true, form: 0, autocomplete: "", name: "", id: "", maxLength: -1, box: { x: 100, y: 100 + 50 * i, w: 240, h: 32 }, ...o });
export type FakePage = PageRead & { viewport?: { width: number; height: number }; submit?: { x: number; y: number; w: number; h: number } | null; local?: Record<string, string> };
export const loginPage = (o: Partial<FakePage> = {}): FakePage => ({
  href: `${ORIGIN}/login`, origin: ORIGIN, fields: [field(0, "email", { autocomplete: "username" }), field(1, "password")],
  forms: [{ method: "post", action: `${ORIGIN}/login` }], framePassword: false, viewport: { width: 1280, height: 720 }, submit: { x: 100, y: 220, w: 120, h: 36 }, ...o,
});
export const homePage = (o: Partial<FakePage> = {}): FakePage => ({ href: `${ORIGIN}/home`, origin: ORIGIN, fields: [], forms: [], framePassword: false, viewport: { width: 1280, height: 720 }, submit: null, local: { token: "test-local-token" }, ...o });

export type Rec = { at: number; what: string; detail?: any; rules: boolean; outside: boolean; lock: boolean };

/** One fake world of the act: the model's port, the receiver, the screen, the store and the move. */
export class ActWorld {
  readonly log: Rec[] = [];
  readonly logs: string[] = [];
  readonly events: any[] = [];
  readonly hidden = new Set<number>();
  private listeners = new Set<(ev: any) => void>();
  notReady: string | null = null;
  entries: string[] = ["login.localhost"];
  features = new Set(["scopes", "act"]);
  // the act window and its tab
  windowCreate: (args: any[]) => any = () => ({ id: 30, incognito: true, focused: false, tabs: [{ id: 31, windowId: 30, incognito: true, url: "", pendingUrl: "about:blank" }] });
  bounds = { left: 0, top: 0, width: 1280, height: 800, state: "normal" };
  movesOff = true;
  rulesAnswer: (body: any) => any = () => ({ rules: [10, 11, 12, 13, 14, 15] });
  cookies: any[] = [{ name: "test_session", value: "test-session-value-1", domain: "login.localhost", hostOnly: true, path: "/", secure: false, httpOnly: true, sameSite: "lax", session: true }];
  moveOk = true;
  moved: any[] = [];
  rulesHeld = false;
  outside = false;
  locked = false;
  // the page
  pages = new Map<string, FakePage>([[`${ORIGIN}/login`, loginPage()], [`${ORIGIN}/home`, homePage()]]);
  current: FakePage | null = null;
  /** Where a submit goes (the URL of the next page), or null: no navigation (a sign-in by fetch that fails). */
  submitTo: string | null = `${ORIGIN}/home`;
  /** The act window's marker, and the popups: their tabs, their windows (the bounds and the marker of the page) and the calls on them. */
  actMarker: string | null = null;
  movesPopups = true;
  readonly popupTabs = new Map<number, { windowId: number }>();
  readonly popupWindows = new Map<number, { bounds: { left: number; top: number; width: number; height: number }; marker: string | null }>();
  readonly popupCalls: { tab: number; method: string }[] = [];
  /** A popup of the act tab in a window of its own (C10: an incognito tab whose opener is the act tab), and its webNavigation event. */
  openPopup(tab = 41, windowId = 40, o: { opener?: number | null; bounds?: { left: number; top: number; width: number; height: number } } = {}): void {
    this.popupTabs.set(tab, { windowId });
    this.popupWindows.set(windowId, { bounds: o.bounds ?? { left: 10, top: 10, width: 400, height: 300 }, marker: null });
    const opener = o.opener === undefined ? 31 : o.opener;
    this.emit({ t: "ev", ch: "bridge", ev: "tabs.onCreated", tab: { id: tab, windowId, incognito: true, ...(opener !== null ? { openerTabId: opener } : {}), url: "" }, attached: false, held: false });
  }
  private popupCmd(tab: number, method: string, params: any): any {
    this.popupCalls.push({ tab, method });
    const t = this.popupTabs.get(tab);
    if (!t) throw new Error("not attached");
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: `F${tab}` } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: this.ctx++ };
    if (method === "Runtime.evaluate") {
      const m = /\/\*aw-act:mark\*\/.*\)\("(aw-act-[0-9a-f]+)"\)$/s.exec(String(params.expression));
      const w = this.popupWindows.get(t.windowId);
      if (m && w) w.marker = m[1];
      return { result: { type: "boolean", value: true } };
    }
    return {};
  }
  /** The wait (C10) of each debugger.sendCommand of the act. */
  readonly waits: number[] = [];
  /** A test's hook at each read of the type watch's flag (a popup's event during that read: review-124b F1). */
  onHit: () => void = () => {};
  /** Tabs whose debugger.attach the receiver refuses (a popup before its mark: review-124b note d). */
  readonly refuseAttach = new Set<number>();
  /** Windows whose windows.get fails (review-124b note b). */
  readonly failWindowGet = new Set<number>();
  /** A server that never answers: Page.navigate gets no answer and no page loads. */
  stall = false;
  /** A test's hook at each Input call (a page that flips the field's type, a WebSocket that opens). */
  onInput: (method: string, params: any) => void = () => {};
  watchHit = false;
  watchInstalled = false;
  typed = new Map<number, string>();
  focused: number | null = null;
  emptied = 0;
  historyCleared = false;
  fetchOn = false;
  guardCalls: { method: string; requestId: string }[] = [];
  private ctx = 100;
  readonly store: FakeStore;

  constructor(o: { password?: string; username?: string } = {}) {
    this.store = new FakeStore(o.username ?? USER, o.password ?? PASS_INSERT);
  }

  private rec(what: string, detail?: any): void { this.log.push({ at: performance.now(), what, detail, rules: this.rulesHeld, outside: this.outside, lock: this.locked }); }
  emit(ev: any): void { for (const fn of [...this.listeners]) fn(ev); }
  cdpEvent(method: string, params: any = {}): void { this.emit({ t: "ev", ch: "bridge", ev: "debugger.onEvent", source: { tabId: 31 }, method, params }); }

  private navigate(url: string): void {
    const next = this.pages.get(url) ?? homePage({ href: url, origin: new URL(url).origin, local: {} });
    setTimeout(() => {
      this.current = next;
      this.focused = null;
      this.cdpEvent("Page.frameNavigated", { frame: { id: "F31", url } });
      setTimeout(() => this.cdpEvent("Page.loadEventFired", { timestamp: 1 }), 5);
    }, 5);
  }

  private page(method: string, params: any): any {
    switch (method) {
      case "Page.getFrameTree": return { frameTree: { frame: { id: "F31", url: "about:blank" } } };
      case "Page.createIsolatedWorld": return { executionContextId: this.ctx++ };
      case "Page.navigate": this.rec("navigate", params.url); if (this.stall) return new Promise(() => {}); this.navigate(params.url); return { frameId: "F31" };
      case "Page.resetNavigationHistory": this.historyCleared = true; this.rec("resetHistory"); return {};
      case "Fetch.enable": this.fetchOn = true; this.rec("fetchOn"); return {};
      case "Fetch.disable": this.fetchOn = false; this.rec("fetchOff"); return {};
      case "Fetch.failRequest": case "Fetch.continueRequest": this.guardCalls.push({ method, requestId: params.requestId }); return {};
      case "Runtime.evaluate": return { result: { type: "object", value: this.evaluate(String(params.expression)) } };
      case "Input.insertText": case "Input.dispatchKeyEvent": case "Input.dispatchMouseEvent": return this.input(method, params);
      default: return {};
    }
  }

  private evaluate(expr: string): any {
    const tag = /\/\*aw-act:([a-z]+)\*\//.exec(expr)?.[1];
    const arg = (() => { const m = /\)\((.*)\)$/s.exec(expr); return m && m[1] ? JSON.parse(`[${m[1]}]`) : []; })();
    const p = this.current;
    switch (tag) {
      case "mark": this.rec("mark", arg[0]); return true;
      case "read": this.rec("read"); return p ? { href: p.href, origin: p.origin, fields: p.fields, forms: p.forms, framePassword: p.framePassword, viewport: p.viewport ?? { width: 1280, height: 720 } } : null;
      case "box": { const f = p?.fields.find((x) => x.i === arg[0]); return f ? f.box : null; }
      case "submit": return p?.submit ?? null;
      case "watch": this.watchInstalled = true; this.rec("watch", arg[0]); return true;
      case "hit": this.onHit(); return this.watchHit;
      case "empty": this.emptied++; this.typed.clear(); this.rec("empty"); return 2;
      case "local": return { origin: p?.origin ?? "null", items: p?.local ?? {} };
    }
    throw new Error(`a fake evaluation with no tag: ${expr.slice(0, 40)}`);
  }

  private input(method: string, params: any): any {
    this.rec(method, method === "Input.dispatchMouseEvent" ? params.type : params.type ?? "insert");
    this.onInput(method, params);
    const p = this.current;
    if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed" && p) {
      const inside = (b: { x: number; y: number; w: number; h: number }) => params.x >= b.x && params.x < b.x + b.w && params.y >= b.y && params.y < b.y + b.h;
      const f = p.fields.find((x) => inside(x.box));
      if (f) this.focused = f.i;
      else if (p.submit && inside(p.submit)) { this.rec("submit"); if (this.submitTo) this.navigate(this.submitTo); }
    }
    const text = method === "Input.insertText" ? params.text : method === "Input.dispatchKeyEvent" && params.type === "keyDown" ? params.text : undefined;
    if (typeof text === "string") {
      if (text === "\r") { this.rec("submit"); if (this.submitTo) this.navigate(this.submitTo); }
      else if (this.focused !== null) this.typed.set(this.focused, (this.typed.get(this.focused) ?? "") + text);
    }
    return {};
  }

  /** The model's act port. */
  readonly model: ActModelPort = {
    notReady: () => this.notReady,
    entries: () => this.entries,
    call: async (op: string, args: any[] = [], o: { wait?: number } = {}) => {
      if (op === "debugger.sendCommand") this.waits.push(o.wait ?? -1);
      await new Promise((r) => setImmediate(r));
      switch (op) {
        case "windows.create": { this.rec("windows.create", args); const a = this.windowCreate(args); if (a?.error) throw new Error(a.error); return a; }
        case "windows.get": {
          this.rec("windows.get", args[0]);
          if (args[0] === 30) return { id: 30, incognito: true, ...this.bounds };
          if (this.failWindowGet.has(args[0])) throw new Error("timeout");
          const pw = this.popupWindows.get(args[0]);
          if (!pw) throw new Error(`No window with id: ${args[0]}.`);
          return { id: args[0], ...pw.bounds };
        }
        case "tabs.get": { const t = this.popupTabs.get(args[0]); if (!t) throw new Error(`No tab with id: ${args[0]}.`); return { id: args[0], windowId: t.windowId, incognito: true }; }
        case "debugger.attach": this.rec("attach", args[0]); if (this.refuseAttach.has(args[0])) throw new Error("not an agent tab"); return { already: false };
        case "debugger.sendCommand": {
          const [target, method, params] = args;
          if (target.tabId !== 31) return this.popupCmd(target.tabId, method, params ?? {});
          return this.page(method, params ?? {});
        }
      }
      throw new Error(`unknown op ${op}`);
    },
    hide: (tabId) => { this.hidden.add(tabId); },
    listen: (fn) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; },
    inputLock: async (fn) => { this.locked = true; this.rec("lock"); try { return await fn(); } finally { this.locked = false; this.rec("unlock"); } },
    person: (scope) => personFor(scope, 7, paramsFor("linux")),
    random: seededRandom(11),
  };

  readonly receiver: ActReceiver = {
    features: () => this.features,
    request: async (op, body) => {
      this.rec(op, body);
      await new Promise((r) => setImmediate(r));
      if (op === "act_rules") { const a = this.rulesAnswer(body); if (a?.error) throw new Error(a.error); if (a?.late) return new Promise(() => {}); this.rulesHeld = true; return a; }
      if (op === "act_cookies") return { cookies: this.cookies };
      this.rulesHeld = false; return { closed: 1 };
    },
  };

  readonly screen: ActScreen = {
    size: () => ({ width: 1280, height: 800 }),
    moveOff: async (marker) => {
      this.rec("moveOff", marker);
      // A popup's window: only the X window whose page holds this marker moves (the marker that its page took).
      for (const [id, w] of this.popupWindows) if (w.marker === marker) { if (!this.movesPopups) return 0; w.bounds = { ...w.bounds, left: 1480 }; this.rec("popupMoved", id); return 1; }
      if (this.actMarker === null) this.actMarker = marker;
      if (marker !== this.actMarker) return 0;
      if (this.movesOff) { this.bounds = { ...this.bounds, left: 1480 }; this.outside = true; }
      return this.movesOff ? 1 : 0;
    },
  };

  act(o: Partial<SignInActOptions> = {}): SignInAct {
    return new SignInAct({
      model: this.model, receiver: this.receiver, store: this.store, screen: this.screen,
      move: { move: async (payload) => { this.moved.push(payload); this.rec("move"); return this.moveOk; } },
      emit: (ev) => this.events.push(ev), log: (l) => this.logs.push(l), repoOf: () => "owner/repo",
      limits: { busyMs: 400, outcomeMs: 1500, settleMs: 40, receiverMs: 300, queueMs: 200, popupMs: 300 }, ...o,
    });
  }

  /** The index of the first record of `what` (or -1). */
  first(what: string): number { return this.log.findIndex((r) => r.what === what); }
  keys(): Rec[] { return this.log.filter((r) => r.what === "Input.insertText" || (r.what === "Input.dispatchKeyEvent" && r.detail !== "keyUp")); }
}

/** A store of one approved record (and the test's others), open, with the act's counters. */
export class FakeStore implements ActStore {
  st: StoreState = "open";
  records: RecordFields[];
  open = new Map<string, boolean>();
  limits = new Map<string, "stopped" | "hour_limit">();
  started: string[] = [];
  ended: [string, string][] = [];
  zeroed: Buffer[] = [];
  private readonly user: string;
  private readonly pass: string;
  constructor(user: string, pass: string) {
    this.user = user; this.pass = pass;
    this.records = [{ v: 1, id: "c-0000000a", gen: 1, name: "staging", origin: ORIGIN, path: "/login", send_to: [ORIGIN], repos: null, by: "operator", approved: true }];
  }
  state() { return this.st; }
  named(name: string) {
    const all = this.records.filter((r) => r.approved && r.name === name);
    return all.length === 1 ? { fields: all[0], file: { ...all[0], sealed: {} } as Record<string, unknown> } : null;
  }
  usable() { return this.records.filter((r) => r.approved); }
  openForUse(x: Record<string, unknown>) {
    if (this.st !== "open") return { refused: "locked" as const };
    if (this.open.get(String(x.id)) === false) return { refused: "cannot_open" as const };
    const v = { username: Buffer.from(this.user, "utf8"), password: Buffer.from(this.pass, "utf8") };
    this.zeroed.push(v.username, v.password);
    return v;
  }
  /** The lockout guard and the hour's limit as the store keeps them (store.ts): 3 failed results in a row stop; 6 acts in the hour. */
  fails = new Map<string, number>();
  limit(id: string) {
    if (this.limits.has(id)) return this.limits.get(id)!;
    return this.started.filter((x) => x === id).length >= this.hourLimit ? "hour_limit" : null;
  }
  hourLimit = 6;
  actStarted(id: string) { this.started.push(id); }
  actEnded(id: string, result: string) {
    this.ended.push([id, result]);
    if (result === "signed_in") { this.fails.set(id, 0); return false; }
    if (!["not_accepted", "timeout", "second_factor"].includes(result)) return false;
    const n = (this.fails.get(id) ?? 0) + 1;
    this.fails.set(id, n);
    if (n >= 3 && this.limits.get(id) !== "stopped") { this.limits.set(id, "stopped"); return true; }
    return false;
  }
}
