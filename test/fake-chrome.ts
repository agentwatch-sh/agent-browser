// A fake Chrome for the tests. It speaks the part of the DevTools Protocol this package uses, on
// 127.0.0.1, over a WebSocket at /devtools/browser/<id> as Chrome does. Pages are fixtures: a small
// DOM (elements with boxes, text and click handlers) whose page code runs in a node:vm context, so
// outline, text, click, type, eval and fetch run the library's real page functions. It starts no
// browser, and its page fetch() and downloads reach only http://127.0.0.1 (the test's own fixture
// server). It records every CDP call, so a test can prove which tabs were never touched.

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import vm from "node:vm";
import { WebSocketServer, type WebSocket } from "ws";

export type ElementSpec = {
  tag: string;
  id?: string;
  text?: string;
  attrs?: Record<string, string>;
  /** x, y, width, height in CSS pixels. Default: one 30 px row per element, in order. */
  rect?: [number, number, number, number];
  hidden?: boolean;
  value?: string;
  onclick?: (page: FakePage, el: FakeElement) => void | Promise<void>;
  onhover?: (page: FakePage, el: FakeElement) => void;
};
export type PageSpec = { title?: string; text?: string; elements?: ElementSpec[]; onload?: (page: FakePage) => void };
/** A fixture site: the page for a URL, or undefined for an empty page. */
export type Site = (url: URL) => PageSpec | undefined;

export type Call = { method: string; params: any; sessionId?: string; targetId?: string };

/** A 1x1 PNG. */
export const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

export class FakeElement {
  readonly page: FakePage;
  tagName: string;
  id: string;
  attrs = new Map<string, string>();
  text: string;
  rect: [number, number, number, number];
  hidden: boolean;
  value: string | undefined;
  files: { name: string }[] = [];
  onclick?: ElementSpec["onclick"];
  onhover?: ElementSpec["onhover"];

  constructor(page: FakePage, spec: ElementSpec, row: number) {
    this.page = page;
    this.tagName = spec.tag.toUpperCase();
    this.id = spec.id ?? "";
    for (const [k, v] of Object.entries(spec.attrs ?? {})) this.attrs.set(k, v);
    this.text = spec.text ?? "";
    this.rect = spec.rect ?? [10, 10 + row * 30, 120, 24];
    this.hidden = !!spec.hidden;
    this.value = spec.value ?? (["INPUT", "TEXTAREA"].includes(this.tagName) ? "" : undefined);
    this.onclick = spec.onclick;
    this.onhover = spec.onhover;
  }
  getAttribute(n: string): string | null { return n === "id" ? (this.id || null) : this.attrs.get(n) ?? null; }
  setAttribute(n: string, v: string) { if (n === "id") this.id = String(v); else this.attrs.set(n, String(v)); }
  removeAttribute(n: string) { this.attrs.delete(n); }
  hasAttribute(n: string) { return n === "id" ? !!this.id : this.attrs.has(n); }
  get innerText() { return this.hidden ? "" : this.text; }
  get textContent() { return this.text; }
  set textContent(v: string) { this.text = String(v); }
  get placeholder() { return this.attrs.get("placeholder") ?? ""; }
  get type() { return this.attrs.get("type") ?? "text"; }
  getBoundingClientRect() {
    const [x, y, width, height] = this.hidden ? [0, 0, 0, 0] : this.rect;
    return { x, y, left: x, top: y, width, height, right: x + width, bottom: y + height };
  }
  getClientRects() { return this.hidden ? [] : [this.getBoundingClientRect()]; }
  scrollIntoView() {}
  focus() { this.page.focused = this; }
  click() { void this.page.activate(this); }
  querySelector(sel: string) { return this.querySelectorAll(sel)[0] ?? null; }
  querySelectorAll(sel: string): FakeElement[] { return this.tagName === "BODY" ? this.page.select(sel) : []; }
}
export class FakeInputElement extends FakeElement {}
export class FakeAnchorElement extends FakeElement {}

/** A compiled selector list: tag, #id, .class, [attr], [attr=value] and combinations; comma-separated. */
function compile(selector: string): (el: FakeElement) => boolean {
  const compound = (s: string) => {
    const tests: ((el: FakeElement) => boolean)[] = [];
    const re = /([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[\s*([\w-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\s*\]/y;
    for (let i = 0; i < s.length;) {
      re.lastIndex = i;
      const m = re.exec(s);
      if (!m) throw new SyntaxError(`fake DOM: unsupported selector '${selector}'`);
      i = re.lastIndex;
      const [, tag, id, cls, attr, v1, v2, v3] = m;
      const value = v1 ?? v2 ?? v3;
      if (tag) tests.push((el) => el.tagName === tag.toUpperCase());
      else if (id) tests.push((el) => el.id === id);
      else if (cls) tests.push((el) => (el.getAttribute("class") ?? "").split(/\s+/).includes(cls));
      else if (value === undefined) tests.push((el) => el.hasAttribute(attr));
      else tests.push((el) => el.getAttribute(attr) === value);
    }
    return (el: FakeElement) => tests.every((t) => t(el));
  };
  const parts = selector.split(",").map((s) => s.trim()).filter(Boolean).map(compound);
  if (!parts.length) throw new SyntaxError(`fake DOM: empty selector`);
  return (el) => parts.some((p) => p(el));
}

export class FakePage {
  readonly fake: FakeChrome;
  readonly targetId: string;
  windowId: number;
  url = "about:blank";
  title = "";
  text = "";
  elements: FakeElement[] = [];
  focused: FakeElement | undefined;
  hovered: FakeElement | undefined;
  typed = "";
  keys: string[] = [];
  bodies = new Map<string, { body: Buffer; mime: string }>();
  private context: vm.Context = vm.createContext({});
  private timers = new Set<NodeJS.Timeout>();
  private nextRequest = 1;

  constructor(fake: FakeChrome, targetId: string, windowId: number) {
    this.fake = fake;
    this.targetId = targetId;
    this.windowId = windowId;
  }

  select(selector: string): FakeElement[] {
    const match = compile(selector);
    return this.elements.filter(match);
  }

  /** Load a URL: a fixture page for http://127.0.0.1, an empty page for anything else (the fake never leaves this machine). */
  load(url: string) {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.url = url;
    let spec: PageSpec | undefined;
    if (url !== "about:blank") { try { spec = this.fake.site(new URL(url)); } catch { spec = undefined; } }
    this.title = spec?.title ?? "";
    this.text = spec?.text ?? "";
    this.focused = this.hovered = undefined;
    this.elements = (spec?.elements ?? []).map((e, i) => {
      const Cls = e.tag === "input" ? FakeInputElement : e.tag === "a" ? FakeAnchorElement : FakeElement;
      return new Cls(this, e, i);
    });
    this.context = this.newContext();
    spec?.onload?.(this);
  }

  later(ms: number, fn: () => void) {
    const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms);
    this.timers.add(t);
  }

  close() { for (const t of this.timers) clearTimeout(t); this.timers.clear(); }

  private newContext(): vm.Context {
    const page = this;
    const body = new FakeElement(this, { tag: "body" }, 0);
    Object.defineProperty(body, "innerText", { get: () => [page.text, ...page.elements.map((e) => e.innerText)].filter(Boolean).join("\n") });
    const document = {
      body,
      documentElement: body,
      get title() { return page.title; },
      set title(v: string) { page.title = String(v); },
      querySelector: (s: string) => page.select(s)[0] ?? null,
      querySelectorAll: (s: string) => page.select(s),
    };
    const sandbox: Record<string, unknown> = {
      document,
      location: { get href() { return page.url; }, get hostname() { try { return new URL(page.url).hostname; } catch { return ""; } } },
      innerWidth: 1280,
      innerHeight: 800,
      getComputedStyle: (el: FakeElement) => ({ visibility: el.hidden ? "hidden" : "visible", display: el.hidden ? "none" : "block" }),
      HTMLElement: FakeElement,
      HTMLInputElement: FakeInputElement,
      HTMLAnchorElement: FakeAnchorElement,
      fetch: (input: string, init?: { method?: string; body?: string }) => page.fetch(String(input), init),
      btoa, atob, Blob,
      setTimeout: (fn: () => void, ms: number) => page.later(ms, fn),
      console: { log: (...args: unknown[]) => page.fake.console(page, args) },
      open: (url: string) => { page.fake.openFrom(page, url ?? "about:blank"); return null; },
    };
    sandbox.window = sandbox;
    return vm.createContext(sandbox);
  }

  /** Run page code the way Runtime.evaluate does. */
  async evaluate(expression: string, awaitPromise: boolean): Promise<{ result: object } | { exceptionDetails: object }> {
    try {
      let v = vm.runInContext(expression, this.context, { timeout: 5_000 });
      if (awaitPromise && v && typeof v.then === "function") v = await v;
      return { result: v === undefined ? { type: "undefined" } : { type: typeof v, value: JSON.parse(JSON.stringify(v)) } };
    } catch (e: any) {
      return { exceptionDetails: { text: "Uncaught", exception: { description: String(e?.stack ?? e) } } };
    }
  }

  /** The page's fetch(): only to this machine, with Network events like Chrome's. */
  async fetch(input: string, init: { method?: string; body?: string } = {}): Promise<Response> {
    const url = new URL(input, this.url);
    if (url.hostname !== "127.0.0.1") throw new TypeError("Failed to fetch");
    const requestId = `${this.targetId.slice(0, 6)}.${this.nextRequest++}`;
    const method = init.method ?? "GET";
    this.fake.network(this, "Network.requestWillBeSent", { requestId, type: "Fetch", request: { method, url: url.href, postData: init.body }, initiator: { type: "script" } });
    const res = await globalThis.fetch(url, { method, body: init.body });
    const body = Buffer.from(await res.arrayBuffer());
    const mime = (res.headers.get("content-type") ?? "").split(";")[0];
    this.bodies.set(requestId, { body, mime });
    this.fake.network(this, "Network.responseReceived", { requestId, type: "Fetch", response: { url: url.href, status: res.status, mimeType: mime } });
    this.fake.network(this, "Network.loadingFinished", { requestId });
    return new Response(body, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "" } });
  }

  /** A trusted click: the element's handler, else a link's navigation or download. */
  async activate(el: FakeElement) {
    if (el.onclick) return el.onclick(this, el);
    const href = el.getAttribute("href");
    if (el.tagName !== "A" || href === null) return;
    const target = new URL(href, this.url).href;
    // A download finishes after the click returns, as in Chrome.
    if (el.hasAttribute("download")) { void this.fake.download(this, target, el.getAttribute("download") || basename(new URL(target).pathname)); return; }
    this.fake.navigate(this, target);
  }

  hit(x: number, y: number): FakeElement | undefined {
    return [...this.elements].reverse().find((e) => {
      const r = e.getBoundingClientRect();
      return !e.hidden && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    });
  }
}

type Session = { id: string; page: FakePage; client: WebSocket; runtime: boolean; network: boolean };

export class FakeChrome {
  readonly site: Site;
  readonly pages = new Map<string, FakePage>();
  readonly calls: Call[] = [];
  /** Targets that are not pages (a service worker), to prove they are filtered out. */
  readonly otherTargets: { targetId: string; type: string; url: string; title: string }[] = [];
  private sessions = new Map<string, Session>();
  private streams = new Map<string, { data: Buffer; offset: number }>();
  private downloadBehavior: { behavior: string; downloadPath?: string } = { behavior: "default" };
  private wss!: WebSocketServer;
  private clients = new Set<WebSocket>();
  private nextWindow = 1;
  currentWindow = 1;
  connections = 0;
  ws = "";

  private constructor(site: Site) { this.site = site; }

  static async start(site: Site = () => undefined): Promise<FakeChrome> {
    const fake = new FakeChrome(site);
    const path = `/devtools/browser/${randomUUID()}`;
    fake.wss = new WebSocketServer({ host: "127.0.0.1", port: 0, path, perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
    await new Promise<void>((r) => fake.wss.once("listening", () => r()));
    fake.ws = `ws://127.0.0.1:${(fake.wss.address() as { port: number }).port}${path}`;
    fake.wss.on("connection", (client) => {
      fake.connections++;
      fake.clients.add(client);
      client.on("message", (raw) => { void fake.onMessage(client, JSON.parse(String(raw))); });
      client.on("close", () => {
        fake.clients.delete(client);
        for (const [id, s] of fake.sessions) if (s.client === client) fake.sessions.delete(id);
      });
    });
    return fake;
  }

  async close() {
    for (const p of this.pages.values()) p.close();
    for (const c of this.clients) c.terminate();
    await new Promise<void>((r) => this.wss.close(() => r()));
  }

  /** A tab the test opens "by hand", for example a mail tab no command may touch. */
  addPage(url: string, opts: { newWindow?: boolean } = {}): FakePage {
    const windowId = opts.newWindow ? ++this.nextWindow : this.currentWindow;
    const page = new FakePage(this, randomUUID().replace(/-/g, "").toUpperCase(), windowId);
    this.pages.set(page.targetId, page);
    page.load(url);
    return page;
  }

  /** Calls that named this target, directly or through one of its sessions. */
  callsFor(targetId: string): Call[] { return this.calls.filter((c) => c.targetId === targetId); }

  console(page: FakePage, args: unknown[]) {
    this.toSessions(page, "Runtime.consoleAPICalled", { type: "log", args: args.map((a) => ({ type: typeof a, value: a })) }, (s) => s.runtime);
  }

  network(page: FakePage, method: string, params: object) { this.toSessions(page, method, params, (s) => s.network); }

  /** Traffic a test injects into a page (as if the page had sent it). */
  traffic(page: FakePage, r: { method?: string; url: string; postData?: string; status?: number; body?: string; mime?: string }) {
    const requestId = `inj.${Math.random().toString(36).slice(2)}`;
    this.network(page, "Network.requestWillBeSent", { requestId, type: "Fetch", request: { method: r.method ?? "GET", url: r.url, postData: r.postData } });
    page.bodies.set(requestId, { body: Buffer.from(r.body ?? ""), mime: r.mime ?? "application/json" });
    this.network(page, "Network.responseReceived", { requestId, type: "Fetch", response: { url: r.url, status: r.status ?? 200, mimeType: r.mime ?? "application/json" } });
    this.network(page, "Network.loadingFinished", { requestId });
  }

  navigate(page: FakePage, url: string) {
    page.load(url);
    setTimeout(() => this.toSessions(page, "Page.loadEventFired", { timestamp: Date.now() / 1000 }), 5);
  }

  openFrom(opener: FakePage, url: string) {
    const page = new FakePage(this, randomUUID().replace(/-/g, "").toUpperCase(), opener.windowId);
    this.pages.set(page.targetId, page);
    page.load(url);
  }

  async download(page: FakePage, url: string, suggestedFilename: string) {
    const { behavior, downloadPath } = this.downloadBehavior;
    if (behavior !== "allowAndName" || !downloadPath) return;
    const guid = randomUUID();
    this.broadcast("Browser.downloadWillBegin", { frameId: page.targetId, guid, url, suggestedFilename });
    const data = Buffer.from(await (await globalThis.fetch(this.local(url))).arrayBuffer());
    writeFileSync(join(downloadPath, guid), data);
    setTimeout(() => this.broadcast("Browser.downloadProgress", { guid, totalBytes: data.length, receivedBytes: data.length, state: "completed" }), 50);
  }

  private local(url: string): string {
    if (new URL(url).hostname !== "127.0.0.1") throw new Error("the fake Chrome reaches only 127.0.0.1");
    return url;
  }

  private toSessions(page: FakePage, method: string, params: object, want: (s: Session) => boolean = () => true) {
    for (const s of this.sessions.values()) if (s.page === page && want(s)) s.client.send(JSON.stringify({ method, params, sessionId: s.id }));
  }

  private broadcast(method: string, params: object) {
    for (const c of this.clients) c.send(JSON.stringify({ method, params }));
  }

  private info(p: FakePage) {
    const attached = [...this.sessions.values()].some((s) => s.page === p);
    return { targetId: p.targetId, type: "page", url: p.url, title: p.title, attached, browserContextId: "default" };
  }

  private async onMessage(client: WebSocket, msg: { id: number; method: string; params?: any; sessionId?: string }) {
    const params = msg.params ?? {};
    const session = msg.sessionId ? this.sessions.get(msg.sessionId) : undefined;
    this.calls.push({ method: msg.method, params, sessionId: msg.sessionId, targetId: session?.page.targetId ?? params.targetId });
    const reply = (result: object) => client.send(JSON.stringify({ id: msg.id, result, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) }));
    const fail = (message: string, code = -32000) => client.send(JSON.stringify({ id: msg.id, error: { code, message }, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) }));
    try {
      if (msg.sessionId && !session) return fail(`Session with given id not found.`);
      const result = session ? await this.onSession(session, msg.method, params) : await this.onBrowser(client, msg.method, params);
      if (result === undefined) return fail(`'${msg.method}' wasn't found`, -32601);
      reply(result);
    } catch (e) { fail((e as Error).message); }
  }

  private async onBrowser(client: WebSocket, method: string, params: any): Promise<object | undefined> {
    switch (method) {
      case "Browser.getVersion": return { protocolVersion: "1.3", product: "FakeChrome/1.0", userAgent: "FakeChrome" };
      case "Browser.getWindowForTarget": {
        const p = this.pages.get(params.targetId);
        if (!p) throw new Error("No target with given id found");
        return { windowId: p.windowId, bounds: { left: 0, top: 0, width: 1280, height: 800, windowState: "normal" } };
      }
      case "Browser.setDownloadBehavior": this.downloadBehavior = { behavior: params.behavior, downloadPath: params.downloadPath }; return {};
      case "Browser.close": setTimeout(() => void this.close(), 5); return {};
      case "Target.getTargets": return { targetInfos: [...[...this.pages.values()].map((p) => this.info(p)), ...this.otherTargets.map((t) => ({ ...t, attached: false }))] };
      case "Target.createTarget": {
        const windowId = params.newWindow ? ++this.nextWindow : this.currentWindow;
        const page = new FakePage(this, randomUUID().replace(/-/g, "").toUpperCase(), windowId);
        this.pages.set(page.targetId, page);
        page.load(params.url ?? "about:blank");
        return { targetId: page.targetId };
      }
      case "Target.attachToTarget": {
        const page = this.pages.get(params.targetId);
        if (!page) throw new Error("No target with given id found");
        const id = randomUUID().replace(/-/g, "").toUpperCase();
        this.sessions.set(id, { id, page, client, runtime: false, network: false });
        return { sessionId: id };
      }
      case "Target.detachFromTarget": {
        const s = this.sessions.get(params.sessionId);
        if (!s) throw new Error("No session with given id found");
        this.sessions.delete(s.id);
        this.broadcast("Target.detachedFromTarget", { sessionId: s.id, targetId: s.page.targetId });
        return {};
      }
      case "Target.closeTarget": {
        const page = this.pages.get(params.targetId);
        if (!page) throw new Error("No target with given id found");
        page.close();
        this.pages.delete(page.targetId);
        for (const s of [...this.sessions.values()]) if (s.page === page) {
          this.sessions.delete(s.id);
          this.broadcast("Target.detachedFromTarget", { sessionId: s.id, targetId: page.targetId });
        }
        return { success: true };
      }
      case "IO.read": return this.read(params);
      case "IO.close": this.streams.delete(params.handle); return {};
      default: return undefined;
    }
  }

  private read(params: { handle: string; size?: number }) {
    const st = this.streams.get(params.handle);
    if (!st) throw new Error("Invalid stream handle");
    const chunk = st.data.subarray(st.offset, st.offset + (params.size ?? 1 << 20));
    st.offset += chunk.length;
    return { data: chunk.toString("base64"), base64Encoded: true, eof: st.offset >= st.data.length };
  }

  private async onSession(s: Session, method: string, params: any): Promise<object | undefined> {
    const page = s.page;
    switch (method) {
      case "Page.enable": case "Emulation.setFocusEmulationEnabled": case "Fetch.disable": case "Network.disable": return {};
      case "Runtime.enable": s.runtime = true; return {};
      case "Network.enable": s.network = true; return {};
      case "Page.navigate": {
        const url = String(params.url);
        this.navigate(page, url);
        return { frameId: `F-${page.targetId}`, loaderId: randomUUID() };
      }
      case "Runtime.evaluate": return page.evaluate(String(params.expression), !!params.awaitPromise);
      case "Input.dispatchMouseEvent": {
        const el = page.hit(params.x, params.y);
        if (params.type === "mouseMoved") { page.hovered = el; if (el) el.onhover?.(page, el); }
        if (params.type === "mouseReleased" && el) await page.activate(el);
        return {};
      }
      case "Input.insertText":
        if (page.focused && page.focused.value !== undefined) page.focused.value += params.text;
        else page.typed += params.text;
        return {};
      case "Input.dispatchKeyEvent": if (params.type === "keyDown") page.keys.push(params.key); return {};
      case "DOM.getDocument": return { root: { nodeId: 1, nodeName: "#document" } };
      case "DOM.querySelector": {
        const el = page.select(params.selector)[0];
        return { nodeId: el ? page.elements.indexOf(el) + 2 : 0 };
      }
      case "DOM.setFileInputFiles": {
        const el = page.elements[params.nodeId - 2];
        if (!el) throw new Error("Could not find node with given id");
        el.files = (params.files as string[]).map((f) => ({ name: basename(f) }));
        return {};
      }
      case "Page.getLayoutMetrics": return { cssContentSize: { x: 0, y: 0, width: 1280, height: 2400 } };
      case "Page.captureScreenshot": return { data: PNG_1x1 };
      case "Page.getFrameTree": return { frameTree: { frame: { id: `F-${page.targetId}`, url: page.url } } };
      case "Network.getResponseBody": {
        const b = page.bodies.get(params.requestId);
        if (!b) throw new Error("No resource with given identifier found");
        const text = /^(text\/|application\/json)/.test(b.mime);
        return { body: text ? b.body.toString("utf8") : b.body.toString("base64"), base64Encoded: !text };
      }
      case "Network.loadNetworkResource": {
        let res: Response;
        try { res = await globalThis.fetch(this.local(params.url)); }
        catch { return { resource: { success: false, netErrorName: "net::ERR_FAILED" } }; }
        const handle = randomUUID();
        this.streams.set(handle, { data: Buffer.from(await res.arrayBuffer()), offset: 0 });
        return { resource: { success: res.ok, httpStatusCode: res.status, stream: handle } };
      }
      case "IO.read": return this.read(params);
      case "IO.close": this.streams.delete(params.handle); return {};
      default: return undefined;
    }
  }
}
