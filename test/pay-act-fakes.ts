// The fakes of the card payment's act window (board ab-sta.6, the plan's Task 5a): the model's act port with the agent's
// tab (its frame tree with Chrome's `domainAndRegistry`, its DOMStorage) and a fake act tab with its pages, frames and
// out-of-process frames (Target auto-attach, flatten), the receiver's channel main of the pay act (C4: act_rules,
// pay_cookies_copy, pay_merchant_block, act_end, with C5's rule 90 as a state), the X screen and the one private
// window's real lock. Each call is recorded in order, so a test can prove the preparation's order. Every value here is a
// made-up TEST value.

import { WindowLock } from "../src/service/fetch/lock.ts";
import { PayPrepare, type PayActLimits, type PayModelPort, type PayReceiver, type PayScreen } from "../src/service/pay/act.ts";
import type { FieldRead } from "../src/service/pay/fields.ts";
import type { PayRequestView } from "../src/service/pay/request.ts";
import { TEST_CARD_VALUES, TEST_CARDS } from "./pay-test-cards.ts";

export const SHOP = "https://shop.example.com";
export const STRIPE = "https://js.stripe.com";
export const AGENT_TAB = 7, ACT_WINDOW = 30, ACT_TAB = 31;
/** The agent tab's localStorage (TEST values): the act's blank document gets each item. */
export const STORAGE: [string, string][] = [["cart", "test-cart-17"], ["session_hint", "test-hint-value-3"]];

export const field = (i: number, o: Partial<FieldRead> = {}): FieldRead => ({ i, tag: "input", type: "text", visible: true, enabled: true, autocomplete: "", name: "", id: "", label: "", ...o });
/** A provider frame's card fields by autocomplete (as hosted fields give them). */
export const CARD_FIELDS: FieldRead[] = [field(0, { autocomplete: "cc-number", type: "tel" }), field(1, { autocomplete: "cc-exp" }), field(2, { autocomplete: "cc-csc", type: "tel" }), field(3, { autocomplete: "postal-code" })];
/** The merchant's own fields: an email and a delivery postal code (no card field). */
export const SHOP_FIELDS: FieldRead[] = [field(0, { autocomplete: "email", type: "email" }), field(1, { autocomplete: "shipping postal-code" })];
export const CHECKOUT_LINES = ["Zoo entry – adult × 2: $48.00", "Service fee: $3.00", "Total: $51.00", "Deliver to: Ann Example", "Email: ann@example.com"];

export type FakeFrame = { id: string; url: string; fields: FieldRead[]; oop: boolean };
export type FakePage = {
  lines: string[]; fields: FieldRead[]; frames: FakeFrame[];
  /** The check read's answer (a captcha's frame or mark). */
  check?: { title?: string; text?: string; frames?: { src: string; visible: boolean }[]; marks?: { click: string[]; check: string[] } };
  /** The URLs of the page's own requests at its load (each paused at the act's Fetch). */
  requests?: string[];
  /** A redirect of the main frame to this URL at the load. */
  redirect?: string;
  /** The page never loads. */
  noLoad?: boolean;
  /** The page opens a popup at its load. */
  popup?: boolean;
};
export const checkoutPage = (o: Partial<FakePage> = {}): FakePage => ({
  lines: CHECKOUT_LINES, fields: SHOP_FIELDS, frames: [{ id: "PF1", url: `${STRIPE}/v3/elements-inner-card.html`, fields: CARD_FIELDS, oop: true }],
  requests: [`${SHOP}/app.js`, "https://api.shop.example.com/cart", "https://cdn.other-host.net/lib.js"], ...o,
});

export type Call = { what: string; detail?: any; rule90: string | null; lock: string | null };

/** One fake world of the pay act. */
export class PayBrowser {
  readonly calls: Call[] = [];
  readonly logs: string[] = [];
  readonly lock = new WindowLock();
  private listeners = new Set<(ev: any) => void>();
  features = new Set(["scopes", "act", "fetch", "pay"]);
  // ---- the agent's tab
  agentUrl = `${SHOP}/checkout?cart=1`;
  /** Chrome's `domainAndRegistry` of the agent tab's main frame (its public suffix list). */
  agentDomain: unknown = "example.com";
  agentStorage: unknown = STORAGE;
  agentFails = new Set<string>();
  // ---- the act window
  windowError: string | null = null;
  movesOff = true;
  bounds = { left: 0, top: 0, width: 1280, height: 800 };
  // ---- the receiver
  rule90: string | null = null;
  rulesHeld = false;
  sendTo: string[] | null = null;
  actEnds = 0;
  blockAnswer: (body: any) => any = (b) => ({ rules: b.on ? [90] : [] });
  cookiesAnswer: (body: any) => any = () => ({ count: 2 });
  rulesAnswer: (body: any) => any = () => ({ rules: [10, 11, 12, 13, 14, 15] });
  endAnswer: () => any = () => ({ closed: 1 });
  // ---- the act tab
  pages = new Map<string, FakePage>([[`${SHOP}/checkout?cart=1`, checkoutPage()]]);
  current = "about:blank";
  page: FakePage | null = null;
  /** The act's localStorage, by origin, as the write left it. */
  readonly local = new Map<string, [string, string][]>();
  fetchOn = false;
  autoAttach = false;
  historyCleared = false;
  /** The act's Fetch answers: requestId to its answer. */
  readonly answers = new Map<string, string>();
  fulfillFails = false;
  writeAnswer: ((url: string, items: [string, string][]) => any) | null = null;
  readonly attached = new Map<string, FakeFrame>();
  protected paused = new Map<string, (how: string) => void>();
  protected nextReq = 1;
  private ctx = 100;
  protected worlds = new Map<number, { session: string | undefined; frame: string }>();
  /** A test's hook at each recorded call (an abort at a step). */
  onCall: (what: string) => void = () => {};
  closed = false;

  /** Board ab-sta.7 (Task 5b): the hooks of the act's own reads and commands (pay-fill-fakes.ts); undefined: none. */
  protected moreEval(_tag: string | undefined, _args: () => any[], _where: FakeFrame | "main"): any { return undefined; }
  protected moreCdp(_method: string, _params: any, _session: string | undefined): any { return undefined; }
  protected moreWindow(_args: any[]): Record<string, unknown> { return {}; }

  rec(what: string, detail?: any): void { this.calls.push({ what, detail, rule90: this.rule90, lock: this.lock.held() }); this.onCall(what); }
  emit(ev: any): void { for (const fn of [...this.listeners]) fn(ev); }
  cdp(method: string, params: any = {}, sessionId?: string): void {
    this.emit({ t: "ev", ch: "bridge", ev: "debugger.onEvent", source: { tabId: ACT_TAB, ...(sessionId ? { sessionId } : {}) }, method, params });
  }
  /** The index of the first call of `what` (or -1). */
  first(what: string): number { return this.calls.findIndex((c) => c.what === what); }
  count(what: string): number { return this.calls.filter((c) => c.what === what).length; }

  /** A paused request of the act tab: the service's answer resolves it. */
  private pause(url: string, resourceType: string): Promise<string> {
    const requestId = `R${this.nextReq++}`;
    return new Promise((resolve) => {
      this.paused.set(requestId, resolve);
      this.cdp("Fetch.requestPaused", { requestId, request: { url, method: "GET" }, resourceType, frameId: "F31" });
    });
  }

  protected async navigate(url: string): Promise<void> {
    if (this.closed) return;
    const how = this.fetchOn ? await this.pause(url, "Document") : "continue";
    if (how === "fail") return;
    const page = how === "fulfill" ? null : this.pages.get(url) ?? null;
    if (how !== "fulfill" && page?.noLoad) return;
    const to = page?.redirect ?? url;
    this.current = to; this.page = page;
    this.cdp("Page.frameNavigated", { frame: { id: "F31", url: to } });
    if (page?.popup) this.emit({ t: "ev", ch: "bridge", ev: "tabs.onCreated", tab: { id: 41, windowId: 40, incognito: true, openerTabId: ACT_TAB } });
    for (const r of page?.requests ?? []) void this.pause(r, "Script");
    setTimeout(() => {
      this.cdp("Page.loadEventFired", { timestamp: 1 });
      if (this.autoAttach) for (const f of page?.frames ?? []) if (f.oop) this.attachFrame(f);
    }, 3);
  }

  protected attachFrame(f: FakeFrame): void {
    const sessionId = `S-${f.id}`;
    this.attached.set(sessionId, f);
    this.cdp("Target.attachedToTarget", { sessionId, targetInfo: { targetId: f.id, type: "iframe", url: f.url }, waitingForDebugger: true });
  }

  private frameOf(session: string | undefined, frame: string): FakeFrame | "main" | null {
    if (session === undefined) {
      if (frame === "F31") return "main";
      return this.page?.frames.find((f) => !f.oop && f.id === frame) ?? null;
    }
    const f = this.attached.get(session);
    return f && f.id === frame ? f : null;
  }

  private evaluate(expr: string, ctx: { session: string | undefined; frame: string }): any {
    const tag = /\/\*aw-(?:act|pay|fetch):([a-z]+)\*\//.exec(expr)?.[0];
    // The arguments of a call (act-page.ts, call): the JSON after the function's text.
    const args = () => { const at = expr.lastIndexOf("})("); return at >= 0 ? JSON.parse(`[${expr.slice(at + 3, -1)}]`) : []; };
    const where = this.frameOf(ctx.session, ctx.frame);
    if (where === null) throw new Error("Cannot find context with specified id");
    switch (tag) {
      case "/*aw-act:mark*/": this.rec("mark"); return true;
      case "/*aw-act:empty*/": this.rec("empty"); return 0;
      case "/*aw-pay:fields*/": this.rec("fields", ctx); return where === "main" ? (this.page?.fields ?? []) : where.fields;
      case "/*aw-pay:order*/": this.rec("order"); return { lines: this.page?.lines ?? [], inputs: [] };
      case "/*aw-fetch:check*/": this.rec("check"); return { title: "Checkout", text: "", frames: [], marks: { click: [], check: [] }, ...this.page?.check };
      case "/*aw-pay:local*/": {
        const [url, json] = args() as [string, string];
        const items = JSON.parse(json) as [string, string][];
        this.rec("write", { url, at: this.current, n: items.length });
        if (this.writeAnswer) return this.writeAnswer(url, items);
        if (this.current !== url) return { ok: false, n: 0 };
        this.local.set(new URL(url).origin, items);
        return { ok: true, n: items.length };
      }
    }
    // Board ab-sta.7 (Task 5b): the act's own reads (pay-fill-fakes.ts).
    const more = this.moreEval(tag, args, where);
    if (more !== undefined) return more;
    throw new Error(`a fake evaluation with no tag: ${expr.slice(0, 40)}`);
  }

  private act(method: string, params: any, session: string | undefined): any {
    if (this.closed) throw new Error("No tab with given id");
    if (session !== undefined) {
      const f = this.attached.get(session);
      if (!f) throw new Error("No session with given id");
      this.rec(`child ${method}`, session);
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: f.id, url: f.url, securityOrigin: new URL(f.url).origin } } };
      if (method === "Page.createIsolatedWorld") { const id = this.ctx++; this.worlds.set(id, { session, frame: params.frameId }); return { executionContextId: id }; }
      if (method === "Runtime.evaluate") return { result: { type: "object", value: this.evaluate(String(params.expression), this.worlds.get(params.contextId)!) } };
      return this.moreCdp(method, params, session) ?? {};
    }
    switch (method) {
      case "Page.getFrameTree": {
        this.rec("act tree");
        const origin = URL.canParse(this.current) && this.current !== "about:blank" ? new URL(this.current).origin : "null";
        return { frameTree: { frame: { id: "F31", url: this.current, securityOrigin: origin }, childFrames: (this.page?.frames ?? []).filter((f) => !f.oop).map((f) => ({ frame: { id: f.id, parentId: "F31", url: f.url, securityOrigin: new URL(f.url).origin } })) } };
      }
      case "Page.createIsolatedWorld": { const id = this.ctx++; this.worlds.set(id, { session: undefined, frame: params.frameId }); return { executionContextId: id }; }
      case "Runtime.evaluate": return { result: { type: "object", value: this.evaluate(String(params.expression), this.worlds.get(params.contextId)!) } };
      case "Page.navigate": this.rec("navigate", params.url); void this.navigate(params.url); return { frameId: "F31" };
      case "Fetch.enable": this.fetchOn = true; this.rec("fetchOn"); return {};
      case "Fetch.disable": this.fetchOn = false; this.rec("fetchOff"); return {};
      case "Target.setAutoAttach": this.autoAttach = true; this.rec("autoAttach", params); return {};
      case "Page.resetNavigationHistory": this.historyCleared = true; this.rec("resetHistory"); return {};
      case "Fetch.fulfillRequest": case "Fetch.continueRequest": case "Fetch.failRequest": {
        const how = method === "Fetch.fulfillRequest" ? "fulfill" : method === "Fetch.continueRequest" ? "continue" : "fail";
        this.rec(method, { requestId: params.requestId, ...(how === "fulfill" ? { body: Buffer.from(params.body, "base64").toString("utf8"), headers: params.responseHeaders } : {}) });
        if (how === "fulfill" && this.fulfillFails) throw new Error("Invalid InterceptionId.");
        this.answers.set(params.requestId, how);
        this.paused.get(params.requestId)?.(how);
        this.paused.delete(params.requestId);
        return {};
      }
      default: { const more = this.moreCdp(method, params, undefined); if (more !== undefined) return more; this.rec(method); return {}; }
    }
  }

  private agent(method: string, params: any): any {
    this.rec(`agent ${method}`, params);
    if (this.agentFails.has(method)) throw new Error("not attached");
    switch (method) {
      case "Page.getFrameTree": return { frameTree: { frame: { id: "A7", url: this.agentUrl, securityOrigin: new URL(this.agentUrl).origin, domainAndRegistry: this.agentDomain } } };
      case "DOMStorage.getDOMStorageItems": return { entries: this.agentStorage };
    }
    throw new Error(`the agent's tab got ${method}`);
  }

  readonly model: PayModelPort = {
    notReady: () => null,
    call: async (op: string, args: any[] = []) => {
      await new Promise((r) => setImmediate(r));
      switch (op) {
        case "windows.create": {
          this.rec("windows.create", args);
          if (this.windowError) throw new Error(this.windowError);
          this.closed = false;
          return { id: ACT_WINDOW, incognito: true, focused: false, tabs: [{ id: ACT_TAB, windowId: ACT_WINDOW, incognito: true }] };
        }
        case "windows.get": return { id: args[0], incognito: true, ...this.bounds, ...this.moreWindow(args) };
        case "debugger.attach": this.rec("attach", args[0]); return { already: false };
        case "debugger.sendCommand": {
          const [target, method, params] = args;
          if (target.tabId === AGENT_TAB) return this.agent(method, params ?? {});
          if (target.tabId !== ACT_TAB) throw new Error("No tab with given id");
          return this.act(method, params ?? {}, target.sessionId);
        }
      }
      throw new Error(`unknown op ${op}`);
    },
    hide: (tabId) => { this.rec("hide", tabId); },
    listen: (fn) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; },
  };

  readonly receiver: PayReceiver = {
    features: () => this.features,
    request: async (op, body) => {
      this.rec(op, body);
      await new Promise((r) => setImmediate(r));
      const answer = (a: any) => { if (a?.error) throw new Error(a.error); if (a?.late) return new Promise<never>(() => {}); return a; };
      switch (op) {
        case "pay_merchant_block": { const a = answer(this.blockAnswer(body)); if (Array.isArray(a?.rules) && a.rules.includes(90)) this.rule90 = body.domain as string; return a; }
        case "pay_cookies_copy": return answer(this.cookiesAnswer(body));
        case "act_rules": { const a = answer(this.rulesAnswer(body)); this.sendTo = body.send_to as string[]; this.rulesHeld = true; return a; }
        case "act_end": {
          this.actEnds++;
          const a = answer(this.endAnswer());
          // C4: first the tabs, then the rules (rule 90 with the act's rules).
          if (!this.closed) { this.closed = true; this.emit({ t: "ev", ch: "bridge", ev: "tabs.onRemoved", tabId: ACT_TAB }); }
          this.rule90 = null; this.rulesHeld = false;
          return a;
        }
      }
      throw new Error(`unknown op ${op}`);
    },
  };

  readonly screen: PayScreen = {
    size: () => ({ width: 1280, height: 800 }),
    moveOff: async (marker) => { this.rec("moveOff", marker); if (this.movesOff) this.bounds = { ...this.bounds, left: 1480 }; return this.movesOff ? 1 : 0; },
  };

  /** The preparation over this world, with short waits. */
  prepare(o: { providerOrigins?: readonly string[]; limits?: Partial<PayActLimits> } = {}): PayPrepare {
    return new PayPrepare({ model: this.model, receiver: this.receiver, screen: this.screen, lock: this.lock, log: (l) => this.logs.push(l),
      ...(o.providerOrigins ? { providerOrigins: o.providerOrigins } : {}),
      limits: { busyMs: 200, receiverMs: 200, queueMs: 100, moveMs: 300, loadMs: 600, settleMs: 20, fieldsMs: 300, pollMs: 20, ...o.limits } });
  }
}

/** A request's view as PayRequests gives it to the preparation. */
export const requestView = (o: Partial<PayRequestView> = {}): PayRequestView => ({
  id: "abcdefabcdefabcd", scope: "web-1", origin: SHOP, amount: "51.00", currency: "USD", card: "travel", description: "Two adult zoo tickets", button: null,
  tab: { id: AGENT_TAB, url: `${SHOP}/checkout?cart=1` }, ...o,
});
/** A card's view for the order's digit filter (a published test number's bytes; pay-test-cards.ts). */
export const cardView = () => ({ number: Buffer.from(TEST_CARDS.visa), expiry: Buffer.from(TEST_CARD_VALUES.expiry) });
