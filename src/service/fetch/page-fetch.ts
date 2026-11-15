// PageFetch in the service (contract C11, "PageFetch"; the PageFetch design, docs/superpowers/specs/2026-11-15-page-
// fetch-design.md, sections 5.1 to 5.9; board ab-v16.102, stage 2). An agent gives one URL; the service loads it in a clean
// private window of the agent Chrome that no client sees, waits until the page has rendered, converts the live DOM to
// markdown with Defuddle in an isolated world of the tab, ends the window, and answers the markdown with a short header.
//
// The order: the arguments; a read on from the scope's memory (an `offset` past 0); the address rule (address.ts), before
// the rate and any window; the scope's rate; the receiver's `fetch` feature and the readiness; the one private window (lock.ts,
// shared with the sign-in act); the window (C10's windows.create with the mark `fetch`), its tab hidden, the service's own
// session on it (the guard on every request of the tab, its frames and its workers, the dialogs, the downloads), the
// move outside the screen; the navigation, the ready wait and the challenge check; the conversion; the end (C4's
// fetch_end: the service never closes the window itself); the memory, the answer and the one log line.
//
// No input: the service sends no Input.* event and no key, grants no permission and answers no prompt. The log line holds
// the scope, the host, the result, the HTTP status, the time, the size and the downloads that started: never a URL path,
// a query or the page's text.

import { randomBytes } from "node:crypto";
import type { ActScreen } from "../signins/act.ts";
import { MARK_TITLE, call } from "../signins/act-page.ts";
import { outsideScreen } from "../signins/act-rules.ts";
import { checkUrl, hostOf, systemResolve, type HostCheck, type Resolve } from "./address.ts";
import { CHECK_READ, challengeOf, checkArgs, convertExpression, defuddleBundle, type CheckRead, type Converted } from "./fetch-page.ts";
import type { Release, WindowLock } from "./lock.ts";

/** The tool's name (the operator's name, C11). */
export const PAGE_FETCH = "PageFetch";
/** The receiver's hello feature of the fetch window (C4): the service tests for membership in the hello's list. */
export const FETCH_FEATURE = "fetch";
/** The bridge's error of a window while another private window is open (C10). */
const PRIVATE_WINDOW = "another private window is open";

/** The first values (C11; the design, sections 5.1, 5.5 and 5.8). */
export const FETCH_LIMITS = {
  /** The longest wait for ready, from the navigation's start. */
  readyMs: 30_000,
  /** The whole fetch, from the window's turn to the conversion's answer. */
  wholeMs: 60_000,
  /** Ready: no navigation has started for this long. */
  settleMs: 2_000,
  /** Ready: no network request of the tab has been open for this long. */
  quietMs: 500,
  /** The most navigations of the main frame after the first (redirects and the page's own). */
  navigations: 10,
  /** The most different hosts (scheme and host) in one fetch: each request to another host fails, and the fetch goes on. */
  hosts: 64,
  /** The end: fetch_end, once more after 500 ms, waits at most this long in all. */
  endMs: 20_000,
  /** C4: fetch_end's wait from its send. */
  receiverMs: 9_000,
  /** Each CDP command of the service's own session waits at most this long. */
  cdpMs: 30_000,
  /** The move of the window outside the screen. */
  moveMs: 3_000,
  /** The longest wait for the private window behind other fetches and acts. */
  waitMs: 600_000,
  /** The scope's rate: at most `rate` fetches in `rateMs`. */
  rate: 30,
  rateMs: 600_000,
  /** The scope's memory of results: each for this long, at most `memoryCount`. */
  memoryMs: 900_000,
  memoryCount: 20,
  /** One answer holds at most this many characters of markdown. */
  partChars: 100_000,
  /** `main` with fewer characters than this converts the whole page instead. */
  fallbackChars: 200,
  /** The service keeps at most this many characters of one result. */
  keepChars: 5_000_000,
} as const;
type Limits = { -readonly [K in keyof typeof FETCH_LIMITS]: number };

export type FetchCode = "refused" | "blocked" | "timeout" | "busy" | "unavailable";
/** A tool error (C11): its code and one plain sentence. */
export class FetchRefusal extends Error {
  readonly code: FetchCode;
  constructor(code: FetchCode, sentence: string) { super(`Not fetched (${code}): ${sentence}`); this.code = code; }
}
const no = (code: FetchCode, sentence: string): never => { throw new FetchRefusal(code, sentence); };

/** The caller: the MCP session's scope and how its request was admitted. */
export type FetchCaller = { scope: string; admission: "local" | "remote" };

/** What the model gives PageFetch (model.ts, actPort): its bridge, the hiding of its tabs and their events. */
export interface FetchModelPort {
  notReady(): string | null;
  call<T = any>(op: string, args?: unknown[], o?: { wait?: number }): Promise<T>;
  hide(tabId: number): void;
  listen(fn: (ev: Record<string, any>) => void): () => void;
}
/** The receiver's channel main (C4) for the fetch window, and its hello's features. */
export interface FetchReceiver {
  features(): ReadonlySet<string>;
  request(op: "fetch_end", body: Record<string, unknown>, waitMs: number): Promise<Record<string, unknown>>;
}

export type PageFetchOptions = {
  model: FetchModelPort; receiver: FetchReceiver; lock: WindowLock;
  /** The X level (Linux): the move of the fetch window outside the screen; null: no move. */
  screen: ActScreen | null;
  log: (line: string) => void;
  /** The box's resolver (tests: a fake). */
  resolve?: Resolve;
  /** Defuddle's script (tests: a fake). */
  bundle?: () => string;
  /** Tests only: shorter limits, a clock, and the live tests' one local server. */
  limits?: Partial<Limits>;
  now?: () => number;
  admit?: (u: URL) => boolean;
};

/** One fetched page in the scope's memory. */
type Result = { url: string; title: string; status: number | null; whole: boolean; fallback: boolean; markdown: string; cut: boolean; downloads: number };

/** The fetch's state while it runs. */
type Run = {
  scope: string; url: string; mode: "main" | "whole";
  window: number | null; tab: number | null; frame: string | null;
  /** The tab's popups: each is closed. */
  popups: Set<number>;
  navs: number; navAt: number; loaded: boolean; status: number | null; mime: string | null;
  open: Set<string>; quietAt: number;
  frameUrls: Set<string>;
  hosts: Map<string, Promise<HostCheck>>;
  refusedMain: string | null; socket: boolean; tooMany: boolean; lost: boolean; unguarded: boolean; navError: string | null;
  guarded: number; dialogs: number; downloads: number; done: boolean;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));
const MAX_TITLE = 300;

export class PageFetch {
  private readonly o: PageFetchOptions;
  private readonly limits: Limits;
  private readonly now: () => number;
  private readonly resolve: Resolve;
  private readonly memory = new Map<string, { key: string; at: number; result: Result }[]>();
  private readonly rates = new Map<string, number[]>();
  /** The last fetch's window did not end (its fetch_end failed): the window's next holder ends it first (lock.ts). */
  private endFailed = false;

  constructor(o: PageFetchOptions) {
    this.o = o;
    this.limits = { ...FETCH_LIMITS, ...o.limits };
    this.now = o.now ?? Date.now;
    this.resolve = o.resolve ?? systemResolve;
  }

  /** The tool's call for one MCP request: the answer's text, or a FetchRefusal with C11's text. */
  async fetch(c: FetchCaller, args: Record<string, unknown>): Promise<string> {
    const t0 = performance.now();
    let host = "none", result = "ok", status: number | null = null, size = 0, from = "", downloads = 0;
    // The memory and the rate of every scope lose their old entries at each call (also a scope that does not come back).
    this.prune();
    try {
      if (c.admission !== "local") no("unavailable", "PageFetch works only for sessions of this box.");
      const a = this.args(args);
      host = a.host;
      const key = `${a.mode} ${a.url}`;
      // A read on: an offset past 0 reads the scope's memory of the same URL and mode, with no second fetch.
      if (a.offset > 0) {
        const kept = this.remembered(c.scope, key);
        if (kept) { from = " (from memory)"; status = kept.status; const text = this.answer(kept, a.offset); size = text.length; return text; }
      }
      // The address rule before the rate and any window: a refused URL costs no fetch.
      const check = await checkUrl(a.url, this.resolve, { main: true, admit: this.o.admit });
      if (!check.ok) no("refused", `The host ${check.why}; ${NEVER_LOCAL}`);
      this.take(c.scope);
      const r = await this.turn(c.scope, a.url, a.mode, (n) => { downloads = n; });
      status = r.status;
      this.remember(c.scope, key, r);
      const text = this.answer(r, a.offset);
      size = text.length;
      return text;
    } catch (e) {
      result = e instanceof FetchRefusal ? e.code : "failed";
      throw e;
    } finally {
      this.o.log(`page-fetch: scope ${c.scope}, host ${host}, result ${result}${from}, status ${status ?? "none"}, ${Math.round(performance.now() - t0)} ms, ${size} characters, ${downloads} downloads`);
    }
  }

  // ---------------------------------------------------------------- the arguments, the memory, the rate

  private args(args: Record<string, unknown>): { url: string; host: string; mode: "main" | "whole"; offset: number } {
    const url = args.url;
    if (typeof url !== "string" || url.length === 0) no("refused", "Give the URL of a page as the argument url.");
    let u: URL;
    try { u = new URL(url as string); } catch { return no("refused", "The URL must be an absolute http or https URL."); }
    if (u.protocol !== "http:" && u.protocol !== "https:") no("refused", "The URL must use http or https.");
    const mode = args.mode === undefined ? "main" : args.mode;
    if (mode !== "main" && mode !== "whole") no("refused", "mode must be main or whole.");
    const offset = args.offset === undefined ? 0 : args.offset;
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) no("refused", "offset must be a whole number of 0 or more.");
    return { url: u.href, host: hostOf(u), mode: mode as "main" | "whole", offset: offset as number };
  }

  /** The old entries of every scope go: the results after 15 minutes, the rate's fetches after 10 minutes. */
  private prune(): void {
    const now = this.now();
    for (const [scope, list] of this.memory) {
      const kept = list.filter((m) => now - m.at < this.limits.memoryMs);
      if (kept.length) this.memory.set(scope, kept); else this.memory.delete(scope);
    }
    for (const [scope, list] of this.rates) {
      const kept = list.filter((t) => now - t < this.limits.rateMs);
      if (kept.length) this.rates.set(scope, kept); else this.rates.delete(scope);
    }
  }

  /** Tests: the results and the rate entries that the service keeps, over all scopes. */
  kept(): { results: number; scopes: number; rates: number } {
    let results = 0, rates = 0;
    for (const l of this.memory.values()) results += l.length;
    for (const l of this.rates.values()) rates += l.length;
    return { results, scopes: new Set([...this.memory.keys(), ...this.rates.keys()]).size, rates };
  }

  private remembered(scope: string, key: string): Result | null {
    const now = this.now();
    const list = (this.memory.get(scope) ?? []).filter((m) => now - m.at < this.limits.memoryMs);
    if (list.length) this.memory.set(scope, list); else this.memory.delete(scope);
    return list.find((m) => m.key === key)?.result ?? null;
  }

  private remember(scope: string, key: string, result: Result): void {
    const now = this.now();
    const list = (this.memory.get(scope) ?? []).filter((m) => now - m.at < this.limits.memoryMs && m.key !== key);
    list.push({ key, at: now, result });
    this.memory.set(scope, list.slice(-this.limits.memoryCount));
  }

  /** The scope's rate: a fetch past it gets `busy` with the time to wait. */
  private take(scope: string): void {
    const now = this.now();
    const list = (this.rates.get(scope) ?? []).filter((t) => now - t < this.limits.rateMs);
    if (list.length >= this.limits.rate) {
      this.rates.set(scope, list);
      const wait = Math.max(1, Math.ceil((list[0] + this.limits.rateMs - now) / 1000));
      no("busy", `This session made ${this.limits.rate} fetches in ${Math.round(this.limits.rateMs / 60_000)} minutes; try again in ${wait} s.`);
    }
    list.push(now);
    this.rates.set(scope, list);
  }

  /** The answer: the header, then the part of the markdown from `offset`. */
  private answer(r: Result, offset: number): string {
    const total = r.markdown.length;
    if (offset > 0 && offset >= total) no("refused", `offset ${offset} is past the end of the page's ${total} characters.`);
    const end = Math.min(total, offset + this.limits.partChars);
    const lines = [
      `URL: ${r.url}`,
      `Title: ${r.title}`,
      `Status: ${r.status ?? "none"}`,
      "Kind: html",
      `Mode: ${r.fallback ? `whole (main gave fewer than ${this.limits.fallbackChars} characters)` : r.whole ? "whole" : "main"}`,
      `Length: ${total} characters${r.cut ? ` (the service keeps at most ${this.limits.keepChars} characters of a page)` : ""}`,
    ];
    if (offset > 0 || end < total) lines.push(`Part: characters ${offset} to ${end}${end < total ? `; the next part starts at offset ${end}` : "; the last part"}`);
    return `${lines.join("\n")}\n\n${r.markdown.slice(offset, end)}`;
  }

  // ---------------------------------------------------------------- the window's turn

  /** The feature and the readiness, the window's turn, then the fetch, which holds the window at most its whole limit and its end. */
  private async turn(scope: string, url: string, mode: "main" | "whole", downloads: (n: number) => void): Promise<Result> {
    this.usable();
    const release = await this.o.lock.fetch(this.limits.waitMs);
    if (release === "busy") no("busy", "Eight fetches already wait for the agent browser's private window; try again later.");
    if (release === "timeout") no("busy", `PageFetch waited ${Math.round(this.limits.waitMs / 60_000)} minutes for the agent browser's private window; try again later.`);
    try {
      this.usable();
      return await this.run(scope, url, mode, downloads);
    } finally {
      const left = this.endFailed;
      this.endFailed = false;
      (release as Release)(left ? () => this.endLeft() : undefined);
    }
  }

  /** The end of a fetch window that did not end, which the window's next holder (an act or a fetch) runs before its own. */
  private async endLeft(): Promise<void> {
    try {
      await this.o.receiver.request("fetch_end", {}, this.limits.receiverMs);
      this.o.log("page-fetch: the left fetch window ended before the next private window");
    } catch (e) {
      this.o.log(`page-fetch: the left fetch window did not end before the next private window (${(e as Error).message === "timeout" ? "timeout" : "the receiver's answer"})`);
    }
  }

  private usable(): void {
    if (!this.o.receiver.features().has(FETCH_FEATURE)) no("unavailable", "The agent extension has no fetch window; it needs a newer release.");
    const notReady = this.o.model.notReady();
    // C11's readiness text, a whole sentence ("The agent browser is not ready: ...").
    if (notReady !== null) no("unavailable", notReady);
  }

  // ---------------------------------------------------------------- the fetch

  private async run(scope: string, url: string, mode: "main" | "whole", downloads: (n: number) => void): Promise<Result> {
    const r: Run = { scope, url, mode, window: null, tab: null, frame: null, popups: new Set(), navs: 0, navAt: 0, loaded: false, status: null, mime: null,
      open: new Set(), quietAt: 0, frameUrls: new Set(), hosts: new Map(), refusedMain: null, socket: false, tooMany: false, lost: false, unguarded: false,
      navError: null, guarded: 0, dialogs: 0, downloads: 0, done: false };
    const off = this.o.model.listen((ev) => this.onEvent(r, ev));
    let opened = false, timer: NodeJS.Timeout | undefined;
    try {
      const limit = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new FetchRefusal("timeout", `The page did not finish within ${this.limits.wholeMs / 1000} s.`)), this.limits.wholeMs);
      });
      // The page's work runs on after the limit until its next step sees the end (stopped): its own end is caught here.
      const work = this.page(r, () => { opened = true; });
      work.catch(() => {});
      return await Promise.race([work, limit]);
    } finally {
      clearTimeout(timer);
      r.done = true;
      downloads(r.downloads);
      if (opened) await this.end(r);
      off();
    }
  }

  private send(r: Run, method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    if (r.lost) return Promise.reject(new Error("the fetch tab is gone"));
    return this.sendTo(r.tab!, method, params, sessionId);
  }

  private sendTo(tabId: number, method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    return this.o.model.call("debugger.sendCommand", [sessionId ? { tabId, sessionId } : { tabId }, method, params], { wait: this.limits.cdpMs });
  }

  /** An evaluation in a new isolated world of the tab's current document (a navigation drops each world). */
  private async evaluate<T>(r: Run, expression: string, tabId = r.tab!, frame = r.frame): Promise<T> {
    const w = await this.sendTo(tabId, "Page.createIsolatedWorld", { frameId: frame, worldName: `aw-fetch-${randomBytes(4).toString("hex")}`, grantUniversalAccess: false });
    const v = await this.sendTo(tabId, "Runtime.evaluate", { expression, contextId: w?.executionContextId, returnByValue: true, awaitPromise: false });
    if (!w || v?.exceptionDetails) throw new Error("the read failed");
    return v?.result?.value as T;
  }

  private async page(r: Run, opened: () => void): Promise<Result> {
    const m = this.o.model;
    // The fetch window: incognito, the mark fetch, the caller's scope, at about:blank, with no focus (C10).
    let w: any;
    try { w = await m.call("windows.create", [{ url: "about:blank", focused: false, incognito: true }, r.scope, "fetch"]); }
    catch (e) {
      const why = (e as Error).message;
      if (why === "timeout") opened();
      if (why === PRIVATE_WINDOW) no("busy", "A private window of the operator is open in the agent browser; try again after it closes.");
      return no("unavailable", "The agent browser could not open its fetch window.");
    }
    opened();
    const tab = w?.tabs?.[0]?.id;
    if (!Number.isInteger(w?.id) || !Number.isInteger(tab) || w.incognito !== true) no("unavailable", "The agent browser could not open its fetch window.");
    r.window = w.id; r.tab = tab;
    m.hide(tab);
    try {
      // The service's own session on the tab: the guard (Fetch, every URL at the request stage) and the frames and
      // workers attached before they run, each with the same guard; downloads denied.
      await m.call("debugger.attach", [tab]);
      await this.send(r, "Page.enable");
      await this.send(r, "Network.enable");
      await this.send(r, "Network.setBypassServiceWorker", { bypass: true });
      await this.send(r, "Page.setDownloadBehavior", { behavior: "deny" }).catch(() => {});
      await this.send(r, "Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
      await this.send(r, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
      const tree = await this.send(r, "Page.getFrameTree");
      r.frame = tree?.frameTree?.frame?.id ?? null;
    } catch { return no("unavailable", "The agent browser could not hold its fetch window."); }
    if (!r.frame) no("unavailable", "The agent browser could not hold its fetch window.");
    await this.moveOff(r);
    // The navigation: Page.navigate answers when the navigation commits or fails; the ready wait bounds it.
    r.navAt = performance.now(); r.loaded = false;
    const t0 = performance.now();
    void this.send(r, "Page.navigate", { url: r.url }).then((a) => { if (typeof a?.errorText === "string" && a.errorText) r.navError = a.errorText; }, () => {});
    let nextRead = 0, onCheck: string | null = null;
    for (;;) {
      this.stopped(r);
      const now = performance.now(), atLimit = now - t0 >= this.limits.readyMs;
      const ready = r.loaded && now - r.navAt >= this.limits.settleMs && r.open.size === 0 && now - r.quietAt >= this.limits.quietMs;
      // A navigation that failed (no answer, a refused name, a TLS error); one that a later navigation replaced waits on.
      if (r.navError && r.navError !== "net::ERR_ABORTED") no("timeout", `The page did not load (${r.navError}).`);
      if ((ready || atLimit) && now >= nextRead) {
        if (!r.loaded) no("timeout", `The page did not load within ${this.limits.readyMs / 1000} s.`);
        if (r.mime === "application/pdf") no("unavailable", "The page is a PDF; PageFetch reads PDFs in a later release.");
        const read = await this.evaluate<CheckRead>(r, `(${CHECK_READ})(${checkArgs().map((a) => JSON.stringify(a)).join(", ")})`).catch(() => null);
        this.stopped(r);
        const ch = read ? challengeOf(read, [...r.frameUrls]) : null;
        if (ch && "click" in ch) no("blocked", `The page shows a check that needs a person's click (${ch.click}); PageFetch never clicks.`);
        if (ch && "check" in ch) {
          onCheck = ch.check;
          if (atLimit) no("blocked", `The page stayed on a check page (${onCheck}) for ${this.limits.readyMs / 1000} s.`);
          nextRead = performance.now() + 1000;
        } else if (read) break;
        else if (atLimit) no("timeout", `The page did not load within ${this.limits.readyMs / 1000} s.`);
      }
      await sleep(50);
    }
    // The conversion: Defuddle in a new isolated world of the rendered page.
    let bundle: string;
    try { bundle = (this.o.bundle ?? defuddleBundle)(); } catch { return no("unavailable", "The agent browser could not load its converter."); }
    let out: Converted | null;
    try { out = await this.evaluate<Converted>(r, convertExpression(bundle, r.url, r.mode, this.limits.fallbackChars)); } catch { out = null; }
    this.stopped(r);
    if (!out || typeof out.content !== "string") return no("unavailable", "The agent browser could not convert the page.");
    const cut = out.content.length > this.limits.keepChars;
    return {
      url: typeof out.url === "string" && out.url ? out.url : r.url,
      title: String(out.title ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE),
      status: r.status, whole: out.whole === true, fallback: out.fallback === true,
      markdown: cut ? out.content.slice(0, this.limits.keepChars) : out.content, cut, downloads: r.downloads,
    };
  }

  /** The causes that end a fetch while it runs, in this order. */
  private stopped(r: Run): void {
    if (r.done) no("timeout", `The page did not finish within ${this.limits.wholeMs / 1000} s.`);
    if (r.refusedMain) no("refused", `The page went on to another address, and the host ${r.refusedMain}; ${NEVER_LOCAL}`);
    if (r.socket) no("refused", "The page opened a WebSocket or a WebTransport; PageFetch allows neither.");
    if (r.tooMany) no("blocked", `The page went through more than ${this.limits.navigations} navigations.`);
    if (r.unguarded) no("unavailable", "The agent browser could not guard a frame, a worker or a popup of the page.");
    if (r.lost) no("unavailable", "The agent browser lost its fetch window before the page was ready.");
  }

  /** The window outside the screen (Linux: the X level, as the sign-in act's window), before the page loads. */
  private async moveOff(r: Run): Promise<void> {
    const screen = this.o.screen;
    if (!screen) return;
    const size = screen.size();
    if (!size) no("unavailable", "The agent browser could not keep its fetch window off the screen.");
    const marker = `aw-fetch-${randomBytes(8).toString("hex")}`;
    await this.evaluate(r, call(MARK_TITLE, marker)).catch(() => null);
    for (const end = performance.now() + this.limits.moveMs; performance.now() < end;) {
      if ((await screen.moveOff(marker).catch(() => 0)) > 0) {
        const placed = await this.o.model.call("windows.get", [r.window]).catch(() => null);
        if (placed && outsideScreen(placed, size!)) return;
      }
      await sleep(100);
    }
    no("unavailable", "The agent browser could not keep its fetch window off the screen.");
  }

  /** C4's fetch_end, once more after 500 ms when it fails, within the end's limit; the receiver ends a left window before the next one. */
  private async end(r: Run): Promise<void> {
    const until = performance.now() + this.limits.endMs;
    for (let tryNo = 1; ; tryNo++) {
      const left = Math.max(1, until - performance.now());
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), left); });
      try { await Promise.race([this.o.receiver.request("fetch_end", {}, Math.min(this.limits.receiverMs, left)), late]); return; }
      catch (e) {
        if (tryNo === 1 && until - performance.now() > 500) { await sleep(500); continue; }
        this.o.log(`page-fetch: fetch_end failed${tryNo === 1 ? " at the end's limit" : " twice"} (${(e as Error).message === "timeout" ? "timeout" : "the receiver's answer"}); the next private window or the receiver's start ends the fetch window`);
        this.endFailed = true;
        return;
      } finally { clearTimeout(timer); }
    }
  }

  // ---------------------------------------------------------------- the tab's events

  private onEvent(r: Run, ev: Record<string, any>): void {
    if (r.done || r.tab === null) return;
    switch (ev.ev) {
      case "debugger.onEvent": {
        const tab = ev.source?.tabId;
        if (tab === r.tab) this.onCdp(r, String(ev.method), ev.params ?? {}, typeof ev.source?.sessionId === "string" ? ev.source.sessionId : undefined);
        // Each request of a popup fails: the popup closes, and it loads nothing.
        else if (r.popups.has(tab) && ev.method === "Fetch.requestPaused" && typeof ev.params?.requestId === "string") {
          r.guarded++;
          void this.sendTo(tab, "Fetch.failRequest", { requestId: ev.params.requestId, errorReason: "BlockedByClient" }).catch(() => {});
        }
        return;
      }
      case "debugger.onDetach": if (ev.source?.tabId === r.tab) r.lost = true; return;
      case "tabs.onRemoved": if (ev.tabId === r.tab) r.lost = true; r.popups.delete(ev.tabId); return;
      case "tabs.onReplaced": if (ev.removedTabId === r.tab) r.lost = true; return;
      case "webNavigation.onCreatedNavigationTarget": if (ev.details?.sourceTabId === r.tab) this.onPopup(r, ev.details?.tabId); return;
      case "tabs.onCreated": if (ev.tab?.incognito === true && ev.tab?.openerTabId === r.tab) this.onPopup(r, ev.tab?.id); return;
      case "downloads.onCreated":
        // Downloads are denied (Page.setDownloadBehavior), and the receiver cancels each download of a fetch window (C10):
        // the service only counts an incognito download that starts while the fetch runs, for its log line.
        if (ev.item?.incognito === true) r.downloads++;
        return;
      case "bridge.tooLarge":
        // A paused request too large for the link: the guard cannot read it, so it fails.
        if (ev.tabId === r.tab && ev.of === "debugger.onEvent" && ev.method === "Fetch.requestPaused" && typeof ev.requestId === "string") {
          r.guarded++;
          void this.sendTo(r.tab!, "Fetch.failRequest", { requestId: ev.requestId, errorReason: "BlockedByClient" }, typeof ev.sessionId === "string" ? ev.sessionId : undefined).catch(() => {});
        }
        return;
    }
  }

  private onCdp(r: Run, method: string, p: any, session: string | undefined): void {
    const now = performance.now();
    switch (method) {
      case "Fetch.requestPaused": this.guard(r, p, session); return;
      case "Target.attachedToTarget": this.onChild(r, p); return;
      case "Page.javascriptDialogOpening":
        // A dialog (alert, confirm, prompt, beforeunload) is dismissed.
        r.dialogs++;
        void this.send(r, "Page.handleJavaScriptDialog", { accept: false }, session).catch(() => {});
        return;
      case "Network.webSocketCreated": case "Network.webTransportCreated":
        // A WebSocket or a WebTransport of the tab, a frame or a worker is no request of the guard: the receiver's rule
        // blocks each one in a fetch tab (C5), and one that Chrome reports ends the fetch.
        r.socket = true;
        return;
    }
    if (session !== undefined) return;
    switch (method) {
      case "Page.frameNavigated":
        if (!p.frame?.parentId) { r.navAt = now; r.loaded = false; }
        else if (typeof p.frame?.url === "string") r.frameUrls.add(p.frame.url);
        return;
      case "Page.navigatedWithinDocument": if (p.frameId === r.frame) r.navAt = now; return;
      case "Page.loadEventFired": r.loaded = true; return;
      case "Network.requestWillBeSent": if (typeof p.requestId === "string") r.open.add(p.requestId); return;
      case "Network.loadingFinished": case "Network.loadingFailed":
        if (r.open.delete(p.requestId) && r.open.size === 0) r.quietAt = now;
        return;
      case "Network.responseReceived":
        if (p.type === "Document" && p.frameId === r.frame && Number.isInteger(p.response?.status)) { r.status = p.response.status; r.mime = typeof p.response?.mimeType === "string" ? p.response.mimeType : null; }
        return;
    }
  }

  /**
   * The address rule of one URL of the fetch, each host checked once in the fetch, at most `hosts` different hosts (the
   * box's resolver runs on a small shared pool): a request to another host fails (`over`), and the fetch goes on.
   */
  private check(r: Run, url: string): Promise<HostCheck & { over?: true }> {
    let u: URL;
    try { u = new URL(url); } catch { return Promise.resolve({ ok: false, why: "a URL that the service cannot read" }); }
    if (u.protocol === "data:" || u.protocol === "blob:" || u.protocol === "about:") return Promise.resolve({ ok: true });
    const key = `${u.protocol}//${u.host}`;
    let c = r.hosts.get(key);
    if (!c) {
      if (r.hosts.size >= this.limits.hosts) return Promise.resolve({ ok: false, why: `${u.hostname} is past the limit of ${this.limits.hosts} hosts in one fetch`, over: true });
      c = checkUrl(url, this.resolve, { admit: this.o.admit });
      r.hosts.set(key, c);
    }
    return c;
  }

  /** The guard: each paused request of the tab, its frames and its workers passes the address rule, else it fails. */
  private guard(r: Run, p: any, session: string | undefined): void {
    const id = p.requestId;
    if (typeof id !== "string") return;
    const fail = () => { r.guarded++; void this.send(r, "Fetch.failRequest", { requestId: id, errorReason: "BlockedByClient" }, session).catch(() => {}); };
    const main = session === undefined && p.resourceType === "Document" && p.frameId === r.frame;
    if (main) {
      r.navs++; r.navAt = performance.now();
      if (r.navs > this.limits.navigations + 1) { r.tooMany = true; fail(); return; }
    }
    const url = String(p.request?.url ?? "");
    void this.check(r, url).then((c) => {
      if (c.ok) { void this.send(r, "Fetch.continueRequest", { requestId: id }, session).catch(() => {}); return; }
      // A host past the limit fails its request only, also a navigation of the main frame: the fetch goes on.
      if (main && !("over" in c && c.over)) r.refusedMain = c.why;
      fail();
    });
  }

  /** A frame or a worker that Chrome attached before it runs: the same guard, its own children, then it runs. */
  private onChild(r: Run, p: any): void {
    const child = p.sessionId;
    if (typeof child !== "string") return;
    if (typeof p.targetInfo?.url === "string" && p.targetInfo.type === "iframe") r.frameUrls.add(p.targetInfo.url);
    void (async () => {
      try {
        // The guard, the child's own children (each waits for its guard too) and its WebSocket events, or no run (fail closed).
        await this.send(r, "Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, child);
        await this.send(r, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, child);
        await this.send(r, "Network.enable", {}, child);
        if (p.targetInfo?.type === "iframe") await this.send(r, "Page.enable", {}, child).catch(() => {});
      } catch {
        // A frame or a worker with no guard ends the fetch (fail closed); its parent never lets it run.
        if (!r.done) r.unguarded = true;
        return;
      }
      await this.send(r, "Runtime.runIfWaitingForDebugger", {}, child).catch(() => {});
    })();
  }

  /** A popup of the fetch tab: the service's own session on it, and its close from an isolated world; one that the service cannot hold ends the fetch. */
  private onPopup(r: Run, tabId: unknown): void {
    if (!Number.isInteger(tabId) || r.popups.has(tabId as number) || tabId === r.tab) return;
    const id = tabId as number;
    this.o.model.hide(id);
    r.popups.add(id);
    void (async () => {
      try {
        await this.o.model.call("debugger.attach", [id]);
        await this.sendTo(id, "Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
        const tree = await this.sendTo(id, "Page.getFrameTree");
        await this.evaluate(r, "window.close()", id, tree?.frameTree?.frame?.id ?? null);
      } catch { if (!r.done && r.popups.has(id)) r.unguarded = true; }
    })();
  }
}

/** The end of each sentence of the address rule's refusals. */
const NEVER_LOCAL = "PageFetch never reaches the box itself or a private network.";
