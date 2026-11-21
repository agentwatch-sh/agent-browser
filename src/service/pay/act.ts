// The card payment's act window in the service, up to the operator's approval (contract C11, the card payment: check 8,
// the request, the one private window; chrome-extension's C4 `pay_merchant_block`, `pay_cookies_copy`, `act_rules` and
// `act_end`, C5's rule 90, C10's act window; the secure card checkout design, sections 8.1 to 8.4, 8.6 and 8.8; board
// ab-sta.6, the plan's Task 5a). It is PayRequests' `prepare` (request.ts). Task 5b adds the fill, the press and the
// result after the approval, in the same window (PayActWindow, the handle that `prepare` gives in Prepared's `act`).
//
// The order (C11):
// a. Check 8: the one private window (lock.ts, shared with the sign-in act and PageFetch), at most 60 s; else the busy
//    text, and no request starts (`noRequest`).
// b. The merchant's registrable domain, from Chrome itself, before any receiver request: Page.getFrameTree on the
//    agent's tab gives the main frame's `domainAndRegistry` (Chrome's public suffix list). An empty value, an IP literal
//    or a host that is itself a public suffix stops with the session copy's text. Only for a loopback test host
//    (`localhost` or a name that ends with `.localhost`) the domain is the host itself.
// c. The act window (as the sign-in act opens it: windows.create with the mark act, the tab hidden, the service's own
//    session, outside the screen), then C4's `pay_merchant_block` (rule 90: from here to `act_end` no tab other than the
//    act's reaches the domain), `pay_cookies_copy` (the default context's cookies of the domain into the act's store: a
//    count, never a value), then the origin's localStorage: the service reads it from the agent's tab by CDP (READ_LOCAL
//    in the act's own isolated world of that tab's main frame, never the page's own world: Chromium gives an extension's
//    debugger no DOMStorage domain; board ab-sta.8), and writes it in the act's context before any script of the merchant runs: the
//    act's Fetch answers the first load of the origin with a blank document, the service writes the storage there, then
//    the act tab loads the agent tab's URL.
// d. The act's rules (C4's `act_rules`: the request's origin, the payment providers' frame origins while the fields
//    mount, and the merchant's origins of the domain that the act page loaded from; top-level GET navigations stay open),
//    confirmed by the receiver's answer, as the sign-in act confirms them.
// e. The act page: its origin is the request's origin or a known provider's hosted page; the service attaches to its
//    frames (Target auto-attach, flatten: the out-of-process frames) and finds the card fields with no key (fields.ts):
//    no payment step, card fields outside a provider frame, card fields in frames of two providers, or a check at the
//    payment step stops with C11's text.
// e2. The act's rules again, now of the one provider whose frames hold the card fields (board ab-sta.8): the request's
//    origin, that provider's frame and API origins (providers.ts), then the merchant's origins; confirmed before the
//    pay_request and before the first key. Chrome applies the act's rules before the act's Fetch sees a request, so the
//    act cannot learn an origin later: the rules of the fill hold to the act's end.
// f. The page's order (order.ts, readOrder), and the answer with the merchant's domain and this window.
//
// A step that fails stops with its text (C11's table), and the window ends. The window ends at the signal too (the
// agent's cancel, the service's stop), at each step. The end is the sign-in act's clean end without the move: the main
// frame's inputs empty, the tab's history cleared, Fetch off, `act_end` (the receiver closes the act's tabs, then removes
// rule 90 and the act's rules), the lock released, the buffers zeroed. An `act_end` that fails twice leaves its end to
// the window's next holder (lock.ts), which sends it before its own window.
//
// The log rule (C11): no log line holds a value of the card, a cookie, a storage item, the page's text, a URL path or a
// query. The storage items stay in the service's memory only from their read to their write.

import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { CHECK_READ, challengeOf, checkArgs, type CheckRead } from "../fetch/fetch-page.ts";
import type { Release, WindowLock } from "../fetch/lock.ts";
import { call, EMPTY_INPUTS, MARK_TITLE } from "../signins/act-page.ts";
import { outsideScreen } from "../signins/act-rules.ts";
import type { CardView } from "./digits.ts";
import { asksCheck, findCardFields, PAY_TAG, READ_FIELDS, type ActFrame, type CardFields, type FieldRead } from "./fields.ts";
import { readOrder, type ActSession } from "./order.ts";
import { isProviderOrigin, PROVIDER_ORIGINS, providerHosts, providerOf, type Provider } from "./providers.ts";
import type { PayRequestView, Prepared, PreparedAct } from "./request.ts";
import { PAY_TEXT } from "./texts.ts";

/** The first values (C11; the sign-in act's and PageFetch's where the design names none). */
export const PAY_ACT_LIMITS = {
  /** Check 8: the request waits for the one private window at most this long. */
  busyMs: 60_000,
  /** C4: the act's caller waits this long for each request of channel main, from its send. */
  receiverMs: 10_000,
  /** The act's own bound of a request of channel main behind an import (C4: at most 115 s), as the sign-in act's. */
  queueMs: 120_000,
  /** Each CDP command of the act's own session waits at most this long (C10's wait of the request). */
  cdpMs: 30_000,
  /** The move of the act window outside the screen. */
  moveMs: 3_000,
  /** The load of the blank document and of the act page. */
  loadMs: 30_000,
  /** The act page: this long with no navigation of its main frame before the reads. */
  settleMs: 1_000,
  /** The act page: the card fields may come this long after the page's load (a provider's frame mounts after it). */
  fieldsMs: 20_000,
  /** The turn of the act page's reads while the fields do not come. */
  pollMs: 250,
} as const;
export type PayActLimits = { -readonly [K in keyof typeof PAY_ACT_LIMITS]: number };

/** The receiver's hello features (C4): the act window and the two requests of the pay act. */
export const ACT_FEATURE = "act";
export const PAY_FEATURE = "pay";
/** C5's rule 90, the merchant rule: `pay_merchant_block` answers `{"rules":[90]}` after a read that holds it. */
export const MERCHANT_RULE = 90;
/** C4's limit of `send_to` in `act_rules`. */
export const MAX_SEND_TO = 32;
/** The bridge's error of a window while another private window is open (C10). */
const PRIVATE_WINDOW = "another private window is open";

/** What the model gives the act (model.ts, actPort): its bridge, the hiding of the act's tabs and their events. */
export interface PayModelPort {
  notReady(): string | null;
  /** One bridge op (C10): windows.create, windows.get, debugger.attach, debugger.sendCommand. */
  call<T = any>(op: string, args?: unknown[], o?: { wait?: number }): Promise<T>;
  hide(tabId: number): void;
  listen(fn: (ev: Record<string, any>) => void): () => void;
}
/** The receiver's channel main (C4) for the pay act, and its hello's features. */
export interface PayReceiver {
  features(): ReadonlySet<string>;
  request(op: "act_rules" | "pay_cookies_copy" | "pay_merchant_block" | "act_end", body: Record<string, unknown>, waitMs: number): Promise<Record<string, unknown>>;
}
/** The X level: the screen's size, and the move of the act window to the right of the screen (the sign-in act's). */
export interface PayScreen {
  size(): { width: number; height: number } | null;
  moveOff(marker: string): Promise<number>;
}
export type PayPrepareOptions = {
  model: PayModelPort; receiver: PayReceiver; screen: PayScreen;
  /** The one private window's lock, shared with the sign-in act and PageFetch (lock.ts). */
  lock: WindowLock;
  log: (line: string) => void;
  /** Tests only: the test merchant's provider origins (`https://pay.localhost`), never in the shipped list. */
  providerOrigins?: readonly string[];
  /** Tests only: the test provider's API origins (board ab-sta.8), never in the shipped list. */
  providerApis?: readonly string[];
  /** Tests only: shorter waits. */
  limits?: Partial<PayActLimits>;
};

/** Chrome's answer to a command of a domain that the target does not have (-32601, "'<method>' wasn't found"). */
const NO_DOMAIN = /-32601|wasn't found/;

/** The blank document of the storage write: the act's Fetch answers the first load of its URL (as C4's import does). */
const BLANK_HEADERS = [{ name: "Content-Type", value: "text/html; charset=utf-8" }, { name: "Cache-Control", value: "no-store" }];
const BLANK_BODY = Buffer.from('<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>agentwatch</title>', "utf8").toString("base64");

/**
 * The storage write in the act's own isolated world of the blank document: only on that document (its URL, no script),
 * it empties the origin's localStorage and writes each item. It answers whether it ran and the items it wrote.
 */
export const WRITE_LOCAL = `${PAY_TAG("local")} (url, json) => {
  if (location.href !== url || document.scripts.length > 0) return { ok: false, n: 0 };
  const items = JSON.parse(json);
  localStorage.clear();
  let n = 0;
  for (const [k, v] of items) { localStorage.setItem(k, v); n++; }
  return { ok: true, n };
}`;

/**
 * The read of the origin's localStorage in the act's own isolated world of the agent tab's main frame (board ab-sta.8:
 * Chromium 156 answers DOMStorage.getDOMStorageItems of an extension's debugger with -32601, "wasn't found"): only while
 * that frame is on the origin (else null), each key and its value, at most 1000 items. The page's own scripts cannot
 * change this world's Storage, and no page script of the agent's tab runs.
 */
export const READ_LOCAL = `${PAY_TAG("readlocal")} (origin) => {
  if (location.origin !== origin) return null;
  const out = [];
  for (let i = 0; i < localStorage.length && i < 1000; i++) { const k = localStorage.key(i); if (k !== null) out.push([k, String(localStorage.getItem(k))]); }
  return out;
}`;

/** An IP literal (IPv4, or IPv6 with or without its brackets). */
const ipLiteral = (h: string) => isIP(h.replace(/^\[|\]$/g, "")) !== 0;
/** A loopback test host (the sign-in design's rule of a test origin): `localhost`, or a name that ends with `.localhost`. */
const loopbackName = (h: string) => h === "localhost" || h.endsWith(".localhost");

/**
 * The merchant's registrable domain (step b): Chrome's `domainAndRegistry` of the agent tab's main frame, or null when
 * the receiver must not get it: an empty value (a host that is itself a public suffix, such as `co.uk` or `github.io`), an
 * IP literal, a value with no dot (the receiver refuses it), or a value that is not the host or a parent of it. A
 * loopback test host gives the host itself (Chrome's list has no `localhost`).
 */
export function merchantDomain(host: string, fromChrome: unknown): string | null {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (!h || ipLiteral(h)) return null;
  if (loopbackName(h)) return h.includes(".") ? h : null;
  if (typeof fromChrome !== "string") return null;
  const d = fromChrome.toLowerCase().replace(/\.$/, "");
  if (!d || !d.includes(".") || ipLiteral(d)) return null;
  return h === d || h.endsWith(`.${d}`) ? d : null;
}

/** A host of the domain: the domain itself or one of its subdomains. */
const inDomain = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/** The abort of the preparation (the agent's cancel, the service's stop). */
class Aborted extends Error { constructor() { super("aborted"); } }
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));
/** An error's text for a log line: no URL, at most 160 characters. */
const whyOf = (e: unknown) => String((e as Error)?.message ?? e).replace(/[a-z][a-z0-9+.-]*:\/\/\S*/gi, "<a URL>").slice(0, 160);

/** The step of the preparation, and the text of a failure in it that has no text of its own. */
type Stage = "lock" | "domain" | "window" | "block" | "cookies" | "storage" | "page" | "rules" | "fields" | "order";
const STAGE_TEXT: Record<Stage, string> = {
  lock: PAY_TEXT.busy, domain: PAY_TEXT.copy, window: PAY_TEXT.noWindow, block: PAY_TEXT.rules, cookies: PAY_TEXT.copy, storage: PAY_TEXT.copy,
  page: PAY_TEXT.noPaymentStep, rules: PAY_TEXT.rules, fields: PAY_TEXT.noPaymentStep, order: PAY_TEXT.noTotal,
};

/** The preparation of the payment requests (PayRequests' `prepare`): one PayActWindow for each request. */
export class PayPrepare {
  private readonly o: PayPrepareOptions;
  private readonly limits: PayActLimits;
  constructor(o: PayPrepareOptions) { this.o = o; this.limits = { ...PAY_ACT_LIMITS, ...o.limits }; }
  /** C11's preparation of one request (steps a to f): the page's order with the window, or a stop after the window's end. */
  prepare(req: PayRequestView, card: CardView, signal: AbortSignal): Promise<Prepared> {
    return new PayActWindow(this.o, this.limits, req, signal).run(card);
  }
}

/**
 * One request's act window, from the preparation to the request's end (Prepared's `act`). Task 5b uses its session,
 * its frames, the finder's fields, the guard's hook and its end.
 */
export class PayActWindow implements PreparedAct {
  private readonly o: PayPrepareOptions;
  private readonly limits: PayActLimits;
  readonly request: PayRequestView;
  private readonly signal: AbortSignal;
  /** The origin of the agent tab's page: the request's origin, or a known provider's hosted payment page (check 6). */
  readonly pageOrigin: string;
  private stage: Stage = "lock";
  private release: Release | null = null;
  /** The act window may exist: its end sends act_end. */
  private opened = false;
  window: number | null = null;
  tab: number | null = null;
  /** The act tab's main frame. */
  frame: string | null = null;
  domain: string | null = null;
  /** The receiver confirmed rule 90 (the agent's text gets the block's line). */
  blockOn = false;
  /** The act page's origin, once its checks passed. */
  actOrigin: string | null = null;
  /** The act page's frames and card fields as the preparation found them (Task 5b finds them again after the approval). */
  frames: ActFrame[] = [];
  fields: CardFields | null = null;
  /** The one provider whose frames hold the card fields (board ab-sta.8): the act's rules and the guard take its origins. */
  provider: Provider | null = null;
  /** The act tab is gone (a detach, a close, a replace), or it opened a popup. */
  lost = false;
  popup = false;
  /** The requests that the receiver's rules stopped (Chrome's ERR_BLOCKED_BY_CLIENT) and the requests that the guard failed. */
  blocked = 0;
  guarded = 0;
  /**
   * The guard's decision for each paused request of the act tab and its frames (Task 5b sets it); with none, the request
   * goes on. `session` is the frame's or the worker's session, undefined for the act tab's own. A decision that comes
   * later (a promise) holds the request until it comes; a rejection fails it.
   */
  guard: ((p: Record<string, any>, session: string | undefined) => "continue" | "fail" | Promise<"continue" | "fail">) | null = null;
  /** The act tab's and its frames' open WebSockets and WebTransports, by their ids: their URLs (Task 5b: C11's form rule 6 before the first key). */
  readonly sockets = new Map<string, string>();
  /** A frame or a worker of the act tab where Fetch could not start: the guard does not hold there (Task 5b stops; review-228 N6). */
  unguarded = false;
  /** The one log line of a dedicated worker with no Fetch of its own went (board ab-sta.8). */
  private workerNoted = false;
  /** The window's end began (Task 5b sends no act_rules after it; review-228 N7). */
  get ended(): boolean { return this.ending !== null; }
  /** The act tab's out-of-process frames and workers: their sessions (Target auto-attach, flatten). */
  readonly children = new Map<string, { type: string; url: string }>();
  private loads = 0;
  private navAt = 0;
  private navError: string | null = null;
  private blank: string | null = null;
  private blankServed = false;
  private blankFailed = false;
  /** The origins of the domain that the act tab's own requests went to (the act's rules let them on). */
  private readonly seen = new Set<string>();
  private storage: [string, string][] | null = null;
  /** The agent tab's main frame (step b): the storage read's world is made there. */
  private agentFrame: string | null = null;
  private readonly buffers: Buffer[] = [];
  private off: (() => void) | null = null;
  private ending: Promise<void> | null = null;

  constructor(o: PayPrepareOptions, limits: PayActLimits, req: PayRequestView, signal: AbortSignal) {
    this.o = o; this.limits = limits; this.request = req; this.signal = signal;
    this.pageOrigin = URL.canParse(req.tab.url) ? new URL(req.tab.url).origin : "null";
  }

  /** The test merchant's provider origins (tests only) with the shipped list. */
  private get extra(): readonly string[] { return this.o.providerOrigins ?? []; }

  // ---------------------------------------------------------------- the preparation (steps a to f)

  async run(card: CardView): Promise<Prepared> {
    try {
      // a. Check 8: the one private window.
      const release = await this.turn();
      if (release === null) return await this.stop({ stop: PAY_TEXT.busy, noRequest: true });
      this.release = release;
      // b. The merchant's registrable domain, before any receiver request.
      this.stage = "domain";
      const domain = await this.domainOfTab();
      if (domain === null) return await this.stop({ stop: PAY_TEXT.copy });
      this.domain = domain;
      // c. The act window, the block, the cookies, the storage, the act page.
      this.stage = "window";
      const noWindow = await this.openWindow();
      if (noWindow) return await this.fail(noWindow);
      this.stage = "block";
      if (!(await this.block())) return await this.fail(PAY_TEXT.rules);
      this.stage = "cookies";
      if (!(await this.copyCookies())) return await this.fail(PAY_TEXT.copy);
      this.stage = "storage";
      if (!(await this.copyStorage())) return await this.fail(PAY_TEXT.copy);
      this.stage = "page";
      if (!(await this.navigate(this.request.tab.url)) || !(await this.settled())) return await this.fail(PAY_TEXT.noPaymentStep);
      // d. The act's rules, confirmed.
      this.stage = "rules";
      if (!(await this.rules())) return await this.fail(PAY_TEXT.rules);
      // e. The act page: its origin, its frames, its card fields and their one provider, a check at the payment step.
      this.stage = "fields";
      const page = await this.actPage();
      if ("stop" in page) return await this.stop(page);
      // e2. The act's rules of that provider (board ab-sta.8), confirmed before the pay_request.
      this.stage = "rules";
      if (!(await this.rules())) return await this.fail(PAY_TEXT.rules);
      // f. The page's order.
      this.stage = "order";
      const order = await this.step(readOrder(this.session(), card));
      if ("stop" in order) return await this.stop(order);
      return { order, ...(this.actOrigin !== this.request.origin ? { providerOrigin: this.actOrigin! } : {}), domain: this.domain, blocked: this.blocked, guarded: this.guarded, act: this };
    } catch (e) {
      if (e instanceof Aborted || this.signal.aborted) return this.stop({ stop: PAY_TEXT.cancelled });
      if (this.lost) return this.stop({ stop: PAY_TEXT.lostBefore });
      this.o.log(`pay: request ${this.request.id}: the act window stopped at its ${this.stage} step (${whyOf(e)})`);
      return this.stop({ stop: STAGE_TEXT[this.stage] });
    }
  }

  /** A stop of a step after the window opened: its text, or the lost window's when the act tab went meanwhile. */
  private fail(text: string): Promise<Prepared> { return this.stop({ stop: this.lost ? PAY_TEXT.lostBefore : text }); }

  /** A stop of the preparation: the window's end first, then the answer (the domain only when rule 90 held). */
  private async stop(p: { stop: string; noRequest?: boolean }): Promise<Prepared> {
    await this.end();
    return { ...p, ...(this.blockOn && this.domain ? { domain: this.domain } : {}), blocked: this.blocked, guarded: this.guarded };
  }

  /** A wait of the preparation that ends at its signal. */
  private step<T>(p: Promise<T>): Promise<T> {
    if (this.signal.aborted) { p.catch(() => {}); return Promise.reject(new Aborted()); }
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(new Aborted());
      this.signal.addEventListener("abort", onAbort, { once: true });
      p.then((v) => { this.signal.removeEventListener("abort", onAbort); if (this.signal.aborted) reject(new Aborted()); else resolve(v); },
        (e) => { this.signal.removeEventListener("abort", onAbort); reject(this.signal.aborted ? new Aborted() : e); });
    });
  }

  /** Check 8's turn: the release, or null after 60 s. A turn that comes after the abort goes at once. */
  private async turn(): Promise<Release | null> {
    const turn = this.o.lock.act(this.limits.busyMs);
    try { return await this.step(turn); }
    catch (e) { void turn.then((r) => r?.()); throw e; }
  }

  private sendTo(tabId: number, method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    return this.o.model.call("debugger.sendCommand", [sessionId ? { tabId, sessionId } : { tabId }, method, params], { wait: this.limits.cdpMs });
  }
  /** One CDP command of the act tab (its own session, or a frame's with `sessionId`). */
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    if (this.lost || this.tab === null) return Promise.reject(new Error("the act tab is gone"));
    return this.sendTo(this.tab, method, params, sessionId);
  }

  /** One request of C4's channel main: the receiver's wait from its send, and the act's own bound behind an import. */
  private ask(op: "act_rules" | "pay_cookies_copy" | "pay_merchant_block" | "act_end", body: Record<string, unknown>): Promise<Record<string, unknown>> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), this.limits.receiverMs + this.limits.queueMs); });
    return Promise.race([this.o.receiver.request(op, body, this.limits.receiverMs), late]).finally(() => clearTimeout(timer));
  }

  /** Wait until `fn` holds, at most `ms`; the abort ends the wait. */
  private async until(fn: () => boolean, ms: number): Promise<boolean> {
    const end = performance.now() + ms;
    while (!fn()) {
      if (this.signal.aborted) throw new Aborted();
      if (performance.now() >= end) return false;
      await sleep(25);
    }
    if (this.signal.aborted) throw new Aborted();
    return true;
  }

  /** b. The registrable domain of the agent tab's page, from Chrome (Page.getFrameTree's `domainAndRegistry`), or null. */
  private async domainOfTab(): Promise<string | null> {
    const tree = await this.step(this.sendTo(this.request.tab.id, "Page.getFrameTree"));
    const frame = tree?.frameTree?.frame;
    const url = typeof frame?.url === "string" && URL.canParse(frame.url) ? new URL(frame.url) : null;
    // The agent's tab still shows the page of check 6 (its origin).
    if (!url || url.origin !== this.pageOrigin) return null;
    this.agentFrame = typeof frame?.id === "string" ? frame.id : null;
    return merchantDomain(url.hostname, frame?.domainAndRegistry);
  }

  /** The agent tab's localStorage of the origin (READ_LOCAL in a new isolated world of its main frame), or null. */
  private async readAgentLocal(): Promise<unknown> {
    if (this.agentFrame === null) return null;
    const tab = this.request.tab.id;
    const w = await this.sendTo(tab, "Page.createIsolatedWorld", { frameId: this.agentFrame, worldName: `aw-pay-${randomBytes(4).toString("hex")}`, grantUniversalAccess: false });
    if (!Number.isInteger(w?.executionContextId)) return null;
    const v = await this.sendTo(tab, "Runtime.evaluate", { expression: call(READ_LOCAL, this.pageOrigin), contextId: w.executionContextId, returnByValue: true, awaitPromise: false });
    return v?.exceptionDetails ? null : v?.result?.value;
  }

  /** c. The act window as the sign-in act opens it; null when it is ready, else the stop's text. */
  private async openWindow(): Promise<string | null> {
    const m = this.o.model, f = this.o.receiver.features();
    if (!f.has(ACT_FEATURE) || !f.has(PAY_FEATURE)) return PAY_TEXT.noWindow;
    const screen = this.o.screen.size();
    if (!screen) return PAY_TEXT.noWindow;
    this.off = m.listen((ev) => this.onEvent(ev));
    const create = m.call("windows.create", [{ url: "about:blank", focused: false, incognito: true }, this.request.scope, "act"]);
    let w: any;
    try { w = await this.step(create); }
    catch (e) {
      // A window that may still open (no answer, or the abort during the create) gets act_end at the end.
      if (e instanceof Aborted) { await create.catch(() => null); this.opened = true; throw e; }
      const why = (e as Error).message;
      if (why === "timeout") this.opened = true;
      if (why === PRIVATE_WINDOW) return PAY_TEXT.privateWindow;
      this.o.log(`pay: request ${this.request.id}: the act window did not open (windows.create failed: ${whyOf(e)})`);
      return PAY_TEXT.noWindow;
    }
    this.opened = true;
    const tab = w?.tabs?.[0]?.id;
    if (!Number.isInteger(w?.id) || !Number.isInteger(tab) || w.incognito !== true) return PAY_TEXT.noWindow;
    this.window = w.id; this.tab = tab;
    m.hide(tab);
    // The service's own session on the act tab: the guard's Fetch on every request of the tab (the blank document's answer
    // too), and the frames and workers attached before they run (each runs after its own session's set-up).
    await this.step(m.call("debugger.attach", [tab]));
    await this.step(this.send("Page.enable"));
    await this.step(this.send("Network.enable"));
    await this.step(this.send("Network.setBypassServiceWorker", { bypass: true }));
    await this.step(this.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }));
    await this.step(this.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }));
    const tree = await this.step(this.send("Page.getFrameTree"));
    this.frame = typeof tree?.frameTree?.frame?.id === "string" ? tree.frameTree.frame.id : null;
    if (!this.frame) return PAY_TEXT.noWindow;
    return (await this.moveOff(screen)) ? null : PAY_TEXT.noWindow;
  }

  /** The act window outside the screen at the X level, before any page loads (the sign-in act's move by a title marker). */
  private async moveOff(screen: { width: number; height: number }): Promise<boolean> {
    const marker = `aw-act-${randomBytes(8).toString("hex")}`;
    await this.step(this.evaluateIn(undefined, this.frame!, call(MARK_TITLE, marker))).catch((e) => { if (e instanceof Aborted) throw e; });
    for (const end = performance.now() + this.limits.moveMs; performance.now() < end;) {
      if ((await this.step(this.o.screen.moveOff(marker).catch(() => 0))) > 0) {
        const placed = await this.step(this.o.model.call("windows.get", [this.window]).catch(() => null));
        if (placed && outsideScreen(placed, screen)) return true;
      }
      await this.step(sleep(100));
    }
    return false;
  }

  /** C4's `pay_merchant_block` with `on` true: confirmed by the answer `{"rules":[90]}`. */
  private async block(): Promise<boolean> {
    const a = await this.step(this.ask("pay_merchant_block", { tab: this.tab, domain: this.domain, on: true })).catch((e) => { if (e instanceof Aborted) throw e; return null; });
    this.blockOn = Array.isArray(a?.rules) && (a.rules as unknown[]).includes(MERCHANT_RULE);
    return this.blockOn;
  }

  /** C4's `pay_cookies_copy`: its answer is a count, never a cookie. A failure logs its kind (board ab-sta.8). */
  private async copyCookies(): Promise<boolean> {
    let why = "an answer with no count";
    const a = await this.step(this.ask("pay_cookies_copy", { tab: this.tab, domain: this.domain })).catch((e) => { if (e instanceof Aborted) throw e; why = (e as Error)?.message === "timeout" ? "a timeout" : "the receiver's error"; return null; });
    if (Number.isSafeInteger(a?.count) && (a!.count as number) >= 0) return true;
    this.o.log(`pay: request ${this.request.id}: the session copy stopped at the cookies (${why})`);
    return false;
  }

  /**
   * The origin's localStorage: the read from the agent's tab by CDP (READ_LOCAL in the act's own isolated world of its main
   * frame), then the blank document of the origin in the act tab (the act's Fetch answers its first load), and the write
   * there in the act's own isolated world. Each failure logs its point (board ab-sta.8), never a value.
   */
  private async copyStorage(): Promise<boolean> {
    const failed = (what: string) => { this.o.log(`pay: request ${this.request.id}: the session copy stopped at ${what}`); return false; };
    const entries = await this.step(this.readAgentLocal()).catch((e) => { if (e instanceof Aborted) throw e; return null; });
    if (!Array.isArray(entries) || !entries.every((x) => Array.isArray(x) && x.length === 2 && typeof x[0] === "string" && typeof x[1] === "string")) return failed("the read of the agent tab's storage");
    this.storage = entries as [string, string][];
    this.blank = `${this.pageOrigin}/__agentwatch_pay_${randomBytes(8).toString("hex")}__`;
    if (!(await this.navigate(this.blank)) || !this.blankServed || this.blankFailed) return failed("the blank document");
    const tree = await this.step(this.send("Page.getFrameTree"));
    if (tree?.frameTree?.frame?.url !== this.blank) return failed("the blank document");
    const w = await this.step(this.evaluateIn(undefined, this.frame!, call(WRITE_LOCAL, this.blank, JSON.stringify(this.storage)))).catch((e) => { if (e instanceof Aborted) throw e; return null; });
    const n = this.storage.length;
    this.storage = null;
    return w !== null && typeof w === "object" && (w as { ok?: unknown }).ok === true && (w as { n?: unknown }).n === n ? true : failed("the storage write");
  }

  /** A navigation of the act tab and its load (a navigation that fails is no load). */
  private async navigate(url: string): Promise<boolean> {
    const before = this.loads;
    this.navError = null;
    void this.send("Page.navigate", { url }).then((a) => { if (typeof a?.errorText === "string" && a.errorText && a.errorText !== "net::ERR_ABORTED") this.navError = a.errorText; }, () => {});
    await this.until(() => this.loads > before || this.lost || this.navError !== null, this.limits.loadMs);
    return this.loads > before && !this.lost && this.navError === null;
  }

  /** The act page's main frame with no navigation for the settle time (a redirect, a route of the page), within the load's time. */
  private settled(): Promise<boolean> {
    return this.until(() => this.lost || performance.now() - this.navAt >= this.limits.settleMs, this.limits.loadMs).then((ok) => ok && !this.lost);
  }

  /**
   * d and e2. C4's `act_rules`: `origin` is the request's origin; `send_to` holds it, then the providers' origins, then
   * the origins of the merchant's domain that the act tab's requests went to, at most 32 (C4). The providers' origins:
   * before the card fields are found, each provider's frame origins (the fields mount); once they are found, only the
   * act's provider's frame and API origins (board ab-sta.8), and no other provider's.
   */
  sendToList(): string[] {
    const out: string[] = [];
    const add = (o: string) => { if (!out.includes(o) && out.length < MAX_SEND_TO) out.push(o); };
    add(this.request.origin);
    for (const o of this.provider ? providerHosts(this.provider) : [...PROVIDER_ORIGINS, ...this.extra]) add(o);
    for (const o of this.seen) add(o);
    return out;
  }
  private async rules(): Promise<boolean> {
    const a = await this.step(this.ask("act_rules", { tab: this.tab, origin: this.request.origin, send_to: this.sendToList() })).catch((e) => { if (e instanceof Aborted) throw e; return null; });
    return Array.isArray(a?.rules) && a.rules.length > 0;
  }

  /** e. The act page's checks and its card fields, read again each turn until the fields come or their time ends. */
  private async actPage(): Promise<{ stop: string } | { fields: CardFields }> {
    const end = performance.now() + this.limits.fieldsMs;
    for (;;) {
      if (this.lost) return { stop: PAY_TEXT.lostBefore };
      if (this.popup) return { stop: PAY_TEXT.noPaymentStep };
      const frames = await this.step(this.readFrames());
      const main = frames[0];
      // The act page's origin: the request's, or a known provider's hosted payment page.
      if (!main || (main.origin !== this.request.origin && !isProviderOrigin(main.origin, this.extra))) return { stop: PAY_TEXT.noPaymentStep };
      this.actOrigin = main.origin;
      const read = await this.step(this.evaluateIn(undefined, main.frameId!, `(${CHECK_READ})(${checkArgs().map((a) => JSON.stringify(a)).join(", ")})`)).catch((e) => { if (e instanceof Aborted) throw e; return null; }) as CheckRead | null;
      // A captcha of the page (a visible frame or a mark of a check): the frames that the page shows, not the invisible ones.
      const challenge = read && typeof read === "object" && Array.isArray(read.frames) && read.marks ? challengeOf(read, []) !== null : false;
      const found = findCardFields(frames, this.extra);
      if ("stop" in found && found.stop === PAY_TEXT.fields) return found;
      if (!("stop" in found)) {
        if (challenge || asksCheck(main.fields)) return { stop: PAY_TEXT.check };
        // The one provider of the card fields (board ab-sta.8): fields in frames of two providers are no known provider's.
        const provider = providerOfFields(frames, found, this.extra, this.o.providerApis ?? []);
        if (provider === null) return { stop: PAY_TEXT.fields };
        this.provider = provider;
        this.frames = frames;
        this.fields = found;
        return { fields: found };
      }
      if (performance.now() >= end) return { stop: challenge ? PAY_TEXT.check : PAY_TEXT.noPaymentStep };
      await this.step(sleep(this.limits.pollMs));
    }
  }

  /**
   * The act page's frames: the main frame and its frames in the act tab's own session (Page.getFrameTree), then each
   * out-of-process frame in its own session, each with its fields (READ_FIELDS in a new isolated world of the frame).
   */
  async readFrames(): Promise<ActFrame[]> {
    const out: ActFrame[] = [];
    const walk = async (node: any, session: string | undefined, main: boolean): Promise<void> => {
      const f = node?.frame;
      if (typeof f?.id !== "string") return;
      const origin = frameOrigin(f);
      const read = await this.evaluateIn(session, f.id, `(${READ_FIELDS})()`).catch(() => null);
      out.push({ origin, main, fields: Array.isArray(read) ? read.filter(fieldRead) : [], ...(session ? { session } : {}), frameId: f.id });
      for (const c of Array.isArray(node.childFrames) ? node.childFrames : []) await walk(c, session, false);
    };
    await walk((await this.send("Page.getFrameTree"))?.frameTree, undefined, true);
    for (const [session, child] of [...this.children]) {
      if (child.type !== "iframe") continue;
      const tree = await this.send("Page.getFrameTree", {}, session).catch(() => null);
      await walk(tree?.frameTree, session, false);
    }
    return out;
  }

  /** One evaluation in a new isolated world of a frame (the act's own world: the page's scripts cannot change it). */
  async evaluateIn<T = unknown>(session: string | undefined, frameId: string, expression: string): Promise<T> {
    const w = await this.send("Page.createIsolatedWorld", { frameId, worldName: `aw-pay-${randomBytes(4).toString("hex")}`, grantUniversalAccess: false }, session);
    if (!Number.isInteger(w?.executionContextId)) throw new Error("no world");
    const v = await this.send("Runtime.evaluate", { expression, contextId: w.executionContextId, returnByValue: true, awaitPromise: false }, session);
    if (v?.exceptionDetails) throw new Error("the act's read failed");
    return v?.result?.value as T;
  }

  /** The act page's main frame as readOrder's session (order.ts): each evaluation in a new isolated world. */
  session(): ActSession {
    return { evaluate: <T>(expression: string) => this.evaluateIn<T>(undefined, this.frames[0]?.frameId ?? this.frame!, expression) };
  }

  /** Task 5b: buffers that the end fills with zeros (the card's values of the fill). */
  hold(...buffers: Buffer[]): void {
    // A buffer that comes after the end began goes to zeros at once (review-227 N5b).
    if (this.ending) { for (const b of buffers) b.fill(0); return; }
    this.buffers.push(...buffers);
  }

  // ---------------------------------------------------------------- the end (the sign-in act's clean end, without the move)

  /** The clean end, once: a second call gives the first call's promise. */
  end(): Promise<void> {
    this.ending ??= this.cleanEnd();
    return this.ending;
  }

  private async cleanEnd(): Promise<void> {
    let left: (() => Promise<void>) | undefined;
    try {
      if (this.opened) {
        if (this.tab !== null && this.frame !== null && !this.lost) {
          await this.evaluateIn(undefined, this.frame, call(EMPTY_INPUTS)).catch(() => {});
          await this.send("Page.resetNavigationHistory").catch(() => {});
          await this.send("Fetch.disable").catch(() => {});
        }
        // act_end, once more after 500 ms when it fails; else the window's next holder sends it first (lock.ts).
        let ended = false;
        for (let tryNo = 1; tryNo <= 2 && !ended; tryNo++) {
          try { await this.ask("act_end", {}); ended = true; }
          catch (e) {
            if (tryNo === 1) { await sleep(500); continue; }
            this.o.log(`pay: request ${this.request.id}: act_end failed twice (${(e as Error).message === "timeout" ? "timeout" : "the receiver's answer"}); the window's next holder ends the act first`);
          }
        }
        if (!ended) left = () => this.endLeft();
      }
    } finally {
      this.off?.();
      this.off = null;
      this.storage = null;
      for (const b of this.buffers) b.fill(0);
      this.buffers.length = 0;
      const release = this.release;
      this.release = null;
      release?.(left);
    }
  }

  /** The end of an act window whose act_end failed, which the one private window's next holder runs before its own window. */
  private async endLeft(): Promise<void> {
    try {
      await this.ask("act_end", {});
      this.o.log(`pay: request ${this.request.id}: the left act window ended before the next private window`);
    } catch (e) {
      this.o.log(`pay: request ${this.request.id}: the left act window did not end before the next private window (${(e as Error).message === "timeout" ? "timeout" : "the receiver's answer"})`);
    }
  }

  // ---------------------------------------------------------------- the act tab's events

  private onEvent(ev: Record<string, any>): void {
    if (this.tab === null) return;
    switch (ev.ev) {
      case "debugger.onEvent":
        if (ev.source?.tabId === this.tab) this.onCdp(String(ev.method), ev.params ?? {}, typeof ev.source?.sessionId === "string" ? ev.source.sessionId : undefined);
        return;
      case "debugger.onDetach": if (ev.source?.tabId === this.tab) this.lost = true; return;
      case "tabs.onRemoved": if (ev.tabId === this.tab) this.lost = true; return;
      case "tabs.onReplaced": if (ev.removedTabId === this.tab) this.lost = true; return;
      // A popup of the act tab (C10: an act popup): the preparation stops; act_end closes it.
      case "webNavigation.onCreatedNavigationTarget": if (ev.details?.sourceTabId === this.tab) this.popup = true; return;
      // A tab of the act tab, or another tab in the act window (review-227 N5c).
      case "tabs.onCreated": if (ev.tab?.incognito === true && (ev.tab?.openerTabId === this.tab || (this.window !== null && ev.tab?.windowId === this.window && ev.tab?.id !== this.tab))) this.popup = true; return;
      case "bridge.tooLarge":
        // A paused request too large for the link: the guard cannot read it, so it fails.
        if (ev.tabId === this.tab && ev.of === "debugger.onEvent" && ev.method === "Fetch.requestPaused" && typeof ev.requestId === "string") {
          this.guarded++;
          void this.send("Fetch.failRequest", { requestId: ev.requestId, errorReason: "BlockedByClient" }, typeof ev.sessionId === "string" ? ev.sessionId : undefined).catch(() => {});
        }
        return;
    }
  }

  private onCdp(method: string, p: Record<string, any>, session: string | undefined): void {
    switch (method) {
      case "Fetch.requestPaused": this.paused(p, session); return;
      case "Target.attachedToTarget": this.onChild(p); return;
      case "Target.detachedFromTarget": if (typeof p.sessionId === "string") this.children.delete(p.sessionId); return;
      case "Network.loadingFailed": if (/ERR_BLOCKED_BY_CLIENT/.test(String(p.errorText))) this.blocked++; return;
      // The open connections of the act tab and its frames (review-227 N1: a WebSocket of the act page's load stays open after act_rules).
      case "Network.webSocketCreated": if (typeof p.requestId === "string" && typeof p.url === "string") this.sockets.set(`${session ?? ""} ws ${p.requestId}`, p.url); return;
      case "Network.webSocketClosed": this.sockets.delete(`${session ?? ""} ws ${p.requestId}`); return;
      case "Network.webTransportCreated": if (typeof p.transportId === "string" && typeof p.url === "string") this.sockets.set(`${session ?? ""} wt ${p.transportId}`, p.url); return;
      case "Network.webTransportClosed": this.sockets.delete(`${session ?? ""} wt ${p.transportId}`); return;
    }
    if (session !== undefined) return;
    switch (method) {
      case "Page.frameNavigated": if (!p.frame?.parentId) this.navAt = performance.now(); return;
      case "Page.navigatedWithinDocument": if (p.frameId === this.frame) this.navAt = performance.now(); return;
      case "Page.loadEventFired": this.loads++; return;
    }
  }

  /**
   * A paused request of the act tab or of a frame: the blank document's first load gets the blank answer; another load of
   * its URL fails; each other request goes on, or fails by the guard's decision (Task 5b).
   */
  private paused(p: Record<string, any>, session: string | undefined): void {
    const id = p.requestId;
    if (typeof id !== "string") return;
    const url = String(p.request?.url ?? "");
    if (session === undefined && this.blank !== null && url === this.blank) {
      if (!this.blankServed && p.resourceType === "Document") {
        this.blankServed = true;
        void this.send("Fetch.fulfillRequest", { requestId: id, responseCode: 200, responseHeaders: BLANK_HEADERS, body: BLANK_BODY }).catch(() => { this.blankFailed = true; });
      } else void this.send("Fetch.failRequest", { requestId: id, errorReason: "BlockedByClient" }).catch(() => {});
      return;
    }
    if (session === undefined && this.domain !== null && URL.canParse(url)) {
      const u = new URL(url);
      if ((u.protocol === "https:" || u.protocol === "http:") && inDomain(u.hostname, this.domain)) this.seen.add(u.origin);
    }
    const decide = (d: "continue" | "fail") => {
      if (d === "fail") {
        this.guarded++;
        void this.send("Fetch.failRequest", { requestId: id, errorReason: "BlockedByClient" }, session).catch(() => {});
      } else void this.send("Fetch.continueRequest", { requestId: id }, session).catch(() => {});
    };
    let d: "continue" | "fail" | Promise<"continue" | "fail">;
    try { d = this.guard?.(p, session) ?? "continue"; } catch { d = "fail"; }
    if (typeof d === "string") decide(d);
    else void d.then(decide, () => decide("fail"));
  }

  /** A frame or a worker that Chrome attached before it runs: its own children too, then it runs. */
  private onChild(p: Record<string, any>): void {
    const session = p.sessionId;
    if (typeof session !== "string") return;
    const type = String(p.targetInfo?.type ?? "");
    this.children.set(session, { type, url: String(p.targetInfo?.url ?? "") });
    void (async () => {
      if (type === "iframe") {
        await this.send("Page.enable", {}, session).catch(() => {});
        await this.send("Network.enable", {}, session).catch(() => {});
        await this.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, session).catch(() => {});
      } else {
        // A worker's own connections count in the act's open-connection check (review-228 N6).
        await this.send("Network.enable", {}, session).catch(() => {});
      }
      // The guard in the frames and the workers too (Task 5b; the design, section 8.6): Fetch on the child's own session.
      // A child whose Fetch does not start is unguarded: the act stops (review-228 N6), and the log names only the kind.
      // A dedicated worker has no Fetch domain of its own through chrome.debugger (Chromium 156 answers -32601, "wasn't
      // found"), and the act tab's own Fetch pauses its requests (board ab-sta.8, measured live): it stays guarded.
      await this.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, session).catch((e) => {
        if (!this.children.has(session)) return;
        if (type === "worker" && NO_DOMAIN.test(String((e as Error)?.message ?? ""))) {
          if (!this.workerNoted) { this.workerNoted = true; this.o.log(`pay: request ${this.request.id}: a dedicated worker of the act tab has no Fetch of its own; the act tab's Fetch holds its requests`); }
          return;
        }
        this.unguarded = true;
        // The child's kind and the error's kind only (board ab-sta.8: a service worker and a dedicated worker differ here).
        const kind = type === "iframe" ? "frame" : type === "service_worker" ? "service worker" : type === "shared_worker" ? "shared worker" : "worker";
        const why = (e as Error)?.message === "timeout" ? "timeout" : NO_DOMAIN.test(String((e as Error)?.message ?? "")) ? "no Fetch domain" : "an error";
        this.o.log(`pay: request ${this.request.id}: the guard did not start in a ${kind} of the act tab (${why})`);
      });
      await this.send("Runtime.runIfWaitingForDebugger", {}, session).catch(() => {});
    })();
  }
}

/**
 * The one provider of the card fields (board ab-sta.8): the provider of each found field's frame (providers.ts,
 * providerOf), or null when the fields are in frames of two providers or of none.
 */
export function providerOfFields(frames: readonly ActFrame[], found: CardFields, extra: readonly string[], extraApi: readonly string[]): Provider | null {
  let one: Provider | null = null;
  for (const at of Object.values(found)) {
    if (!at) continue;
    const p = providerOf(frames[at.frame]?.origin ?? "null", extra, extraApi);
    if (p === null || (one !== null && one.name !== p.name)) return null;
    one = p;
  }
  return one;
}

/** A frame's origin: its security origin as Chrome gives it, else its URL's origin. */
function frameOrigin(f: { url?: unknown; securityOrigin?: unknown }): string {
  if (typeof f.securityOrigin === "string" && URL.canParse(f.securityOrigin) && new URL(f.securityOrigin).origin === f.securityOrigin) return f.securityOrigin;
  return typeof f.url === "string" && URL.canParse(f.url) ? new URL(f.url).origin : "null";
}
/** A field of READ_FIELDS' shape. */
function fieldRead(x: unknown): x is FieldRead {
  const f = x as FieldRead;
  return f !== null && typeof f === "object" && Number.isInteger(f.i) && (f.tag === "input" || f.tag === "select") && typeof f.type === "string" && typeof f.visible === "boolean"
    && typeof f.enabled === "boolean" && typeof f.autocomplete === "string" && typeof f.name === "string" && typeof f.id === "string" && typeof f.label === "string";
}
