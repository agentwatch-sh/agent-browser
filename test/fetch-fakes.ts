// A fake world for PageFetch (src/service/fetch/page-fetch.ts; board ab-v16.102): the model's port (the bridge, the
// hiding, the events) with a fake fetch tab whose navigation pauses its requests in the guard as Chrome's Fetch domain
// does, a fake receiver with the `fetch` feature and C4's fetch_end, a fake X screen, and a fake resolver. The conversion
// runs the service's real expression in a node:vm context with a fake document and a fake Defuddle bundle, unless a test
// gives its own. Every host and address here is a test value.

import vm from "node:vm";
import { WindowLock } from "../src/service/fetch/lock.ts";
import { PageFetch, type PageFetchOptions } from "../src/service/fetch/page-fetch.ts";
import type { CheckRead } from "../src/service/fetch/fetch-page.ts";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A fake Defuddle bundle: its class records each options object in the context's `seen`, and gives the document's
 * `main` text in Defuddle's default mode and its `whole` text with contentSelector body.
 */
export const FAKE_BUNDLE = `module.exports = { default: class FakeDefuddle {
  constructor(doc, opts) { this.doc = doc; this.opts = opts; seen.push(opts); }
  parse() { const whole = this.opts.contentSelector === "body"; return { title: this.doc.title, content: whole ? this.doc.whole : this.doc.main }; }
} };`;

/** One page of the fake web: what the main document answers and what the page does after its load. */
export type FakePage = {
  status?: number; mime?: string; title?: string; main?: string; whole?: string;
  /** The check read's answer (no challenge by default). */
  check?: Partial<CheckRead>;
  /** The main document's redirects: each URL is one more paused request of the main frame. */
  redirects?: string[];
  /** The page never loads (no load event). */
  noLoad?: boolean;
  /** Page.navigate answers this error text. */
  navError?: string;
  /** After the load: the page's own events (subrequests, dialogs, popups, workers, its own navigations). */
  after?: (w: FetchWorld) => void | Promise<void>;
};

export type Sent = { tab: number; session?: string; method: string; params: any; at: number };

export class FetchWorld {
  readonly calls: { op: string; args: any[] }[] = [];
  readonly sent: Sent[] = [];
  readonly hidden = new Set<number>();
  readonly listeners = new Set<(ev: Record<string, any>) => void>();
  readonly log: string[] = [];
  features = new Set(["scopes", "act", "fetch"]);
  notReady: string | null = null;
  resolver: Record<string, string[]> = { "pages.example.test": ["203.0.113.10"], "other.example.test": ["203.0.113.11"] };
  pages: Record<string, FakePage> = {};
  windowCreate: (args: any[]) => any = () => ({ id: 50, incognito: true, focused: false, tabs: [{ id: 51, windowId: 50, incognito: true }] });
  fetchEnd: () => Promise<Record<string, unknown>> = async () => ({ closed: 1 });
  fetchEnds = 0;
  /** CDP methods that fail (by method, or `method session` for a child session). */
  failing = new Set<string>();
  seen: any[] = [];
  /** The paused requests that the service answered: requestId -> continue | fail. */
  readonly answered = new Map<string, "continue" | "fail">();
  private pending = new Map<string, (how: "continue" | "fail") => void>();
  private nextId = 1;
  private ctx = 100;
  tab = 51;
  frame = "F1";

  model() {
    return {
      notReady: () => this.notReady,
      call: async (op: string, args: any[] = []) => this.call(op, args),
      hide: (id: number) => { this.hidden.add(id); },
      listen: (fn: (ev: Record<string, any>) => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; },
    };
  }
  receiver() {
    return { features: () => this.features, request: async (op: "fetch_end") => { this.fetchEnds++; this.calls.push({ op, args: [] }); return this.fetchEnd(); } };
  }
  screen() { return { size: () => ({ width: 1280, height: 800 }), moveOff: async () => 1 }; }

  fetcher(o: Partial<PageFetchOptions> = {}): PageFetch {
    return new PageFetch({
      model: this.model(), receiver: this.receiver(), lock: o.lock ?? new WindowLock(), screen: this.screen(), log: (l) => this.log.push(l),
      resolve: async (h) => { const a = this.resolver[h]; if (!a) throw new Error("ENOTFOUND"); return a; },
      bundle: () => FAKE_BUNDLE,
      ...o,
      limits: { readyMs: 1_500, wholeMs: 4_000, settleMs: 40, quietMs: 10, endMs: 600, receiverMs: 200, moveMs: 300, ...o.limits },
    });
  }

  emit(ev: Record<string, any>): void { for (const f of [...this.listeners]) f(ev); }
  cdp(method: string, params: any, session?: string, tab = this.tab): void {
    this.emit({ ev: "debugger.onEvent", source: session ? { tabId: tab, sessionId: session } : { tabId: tab }, method, params });
  }

  /** A paused request of the tab (or of a child session): resolves with the service's answer. */
  pause(url: string, o: { session?: string; type?: string; frameId?: string; tab?: number } = {}): Promise<"continue" | "fail"> {
    const id = `req-${this.nextId++}`;
    const p = new Promise<"continue" | "fail">((r) => this.pending.set(id, r));
    this.cdp("Fetch.requestPaused", { requestId: id, request: { url, method: "GET" }, resourceType: o.type ?? "Fetch", frameId: o.frameId ?? this.frame, networkId: id }, o.session, o.tab);
    return p;
  }

  methods(): string[] { return this.sent.map((s) => s.method); }

  private async call(op: string, args: any[]): Promise<any> {
    this.calls.push({ op, args });
    switch (op) {
      case "windows.create": return this.windowCreate(args);
      case "windows.get": return { id: args[0], left: 1480, top: 0, width: 1280, height: 800 };
      case "debugger.attach": if (this.failing.has(`attach ${args[0]}`)) throw new Error("not attached"); return {};
      case "downloads.cancel": return null;
      case "debugger.sendCommand": return this.command(args[0], args[1], args[2] ?? {});
      default: throw new Error(`unknown op ${op}`);
    }
  }

  private async command(target: { tabId: number; sessionId?: string }, method: string, params: any): Promise<any> {
    this.sent.push({ tab: target.tabId, session: target.sessionId, method, params, at: performance.now() });
    if (this.failing.has(method) || (target.sessionId && this.failing.has(`${method} ${target.sessionId}`))) throw new Error(`${method} failed`);
    switch (method) {
      case "Page.getFrameTree": return { frameTree: { frame: { id: target.tabId === this.tab ? this.frame : `P${target.tabId}` } } };
      case "Page.createIsolatedWorld": return { executionContextId: ++this.ctx };
      case "Runtime.evaluate": return this.evaluate(String(params.expression));
      case "Page.navigate": return this.navigate(String(params.url));
      case "Fetch.continueRequest": case "Fetch.failRequest": {
        const how = method === "Fetch.continueRequest" ? "continue" : "fail";
        this.answered.set(params.requestId, how);
        this.pending.get(params.requestId)?.(how);
        this.pending.delete(params.requestId);
        return {};
      }
      default: return {};
    }
  }

  current: { url: string; page: FakePage } | null = null;

  private pageOf(url: string): FakePage { return this.pages[url] ?? this.pages["*"] ?? {}; }

  private evaluate(expr: string): any {
    if (expr.includes("/*aw-act:mark*/")) return { result: { value: true } };
    if (expr.includes("window.close()")) return { result: {} };
    const page = this.current?.page ?? {};
    if (expr.includes("/*aw-fetch:check*/")) return { result: { value: { title: page.title ?? "A test page", text: "", frames: [], marks: { click: [], check: [] }, ...page.check } } };
    if (expr.includes("/*aw-fetch:convert*/")) {
      const doc = { title: page.title ?? "A test page", main: page.main ?? "# A test page\n\n" + "The text of the test page. ".repeat(20), whole: page.whole ?? "Menu\n\n# A test page\n\nThe whole test page." };
      try {
        const seen: any[] = [];
        const value = vm.runInNewContext(expr, { document: doc, location: { href: this.current?.url ?? "about:blank" }, seen, URL });
        // Copies in this realm (the test's deepEqual compares prototypes).
        this.seen.push(...JSON.parse(JSON.stringify(seen)));
        return { result: { value: JSON.parse(JSON.stringify(value)) } };
      } catch (e) { return { exceptionDetails: { text: String(e) } }; }
    }
    return { result: { value: null } };
  }

  /** Chrome's navigation of the main frame: each request of the chain pauses in the guard; a fail ends it. */
  private async navigate(url: string): Promise<any> {
    let at = url;
    const page0 = this.pageOf(url);
    if (page0.navError) return { frameId: this.frame, errorText: page0.navError };
    for (const next of [url, ...(page0.redirects ?? [])]) {
      at = next;
      const how = await this.pause(next, { type: "Document" });
      if (how === "fail") return { frameId: this.frame, errorText: "net::ERR_BLOCKED_BY_CLIENT" };
    }
    void this.load(at, page0);
    return { frameId: this.frame, loaderId: "L1" };
  }

  /** The commit and the load of a document (also a page's own navigation). */
  async load(url: string, page: FakePage = this.pageOf(url)): Promise<void> {
    const id = `doc-${this.nextId++}`;
    this.cdp("Network.requestWillBeSent", { requestId: id, request: { url }, type: "Document", frameId: this.frame });
    this.cdp("Network.responseReceived", { requestId: id, type: "Document", frameId: this.frame, response: { url, status: page.status ?? 200, mimeType: page.mime ?? "text/html" } });
    this.cdp("Page.frameNavigated", { frame: { id: this.frame, url } });
    this.current = { url, page };
    this.cdp("Network.loadingFinished", { requestId: id });
    await sleep(5);
    if (!page.noLoad) this.cdp("Page.loadEventFired", { timestamp: 1 });
    if (page.after) await page.after(this);
  }

  /** The page's own navigation: its request pauses in the guard, then the new document loads. */
  async pageNavigates(url: string): Promise<"continue" | "fail"> {
    const how = await this.pause(url, { type: "Document" });
    if (how === "continue") await this.load(url);
    return how;
  }
}
