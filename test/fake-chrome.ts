// A fake Chrome for the tests. It speaks the part of the DevTools Protocol this package uses, on
// 127.0.0.1, over a WebSocket at /devtools/browser/<id> as Chrome does. Pages are fixtures: a small
// DOM (elements with boxes, text and click handlers) whose page code runs in a node:vm context, so
// outline, text, click, type, eval and fetch run the library's real page functions. It starts no
// browser, and its page fetch() and downloads reach only http://127.0.0.1 (the test's own fixture
// server). It records every CDP call, so a test can prove which tabs were never touched.
//
// For `record` it also screencasts (real JPEG frames, acknowledged one at a time), emulates a device
// size, and gives page code the DOM calls the recording overlay uses. Like Google Sheets, it refuses
// innerHTML (Trusted Types), a <style> element and an inline style attribute (a strict style-src).

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import vm from "node:vm";
import { crc32, deflateSync } from "node:zlib";
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

/** A solid mid-grey baseline JPEG of any size: one component, one-symbol Huffman tables, so every 8x8 block is two zero bits. */
export function greyJpeg(width: number, height: number): Buffer {
  const seg = (marker: number, body: number[]) => [0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body];
  const bits = Math.ceil(width / 8) * Math.ceil(height / 8) * 2;
  const data = new Array(Math.ceil(bits / 8)).fill(0);
  if (bits % 8) data[data.length - 1] = (1 << (8 - (bits % 8))) - 1; // pad the last byte with 1 bits
  const oneSymbol = (cls: number) => [cls, 1, ...new Array(15).fill(0), 0]; // one code of length 1, symbol 0
  return Buffer.from([
    0xff, 0xd8,
    ...seg(0xdb, [0, ...new Array(64).fill(1)]),
    ...seg(0xc0, [8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0]),
    ...seg(0xc4, [...oneSymbol(0x00), ...oneSymbol(0x10)]),
    ...seg(0xda, [1, 1, 0x00, 0, 63, 0]),
    ...data,
    0xff, 0xd9,
  ]);
}

/** A PNG of width x height RGBA pixels, every row with PNG filter `filter` (0-4). */
export function rgbaPng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number], filter = 0): Buffer {
  const stride = width * 4, raw = Buffer.alloc((stride + 1) * height), img = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) img.set(pixel(x, y), y * stride + x * 4);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = filter;
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? img[y * stride + i - 4] : 0, b = y ? img[(y - 1) * stride + i] : 0, c = i >= 4 && y ? img[(y - 1) * stride + i - 4] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter];
      raw[y * (stride + 1) + 1 + i] = (img[y * stride + i] - pred) & 0xff;
    }
  }
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(body.length, 0); head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const TRUSTED_HTML = "Failed to set the 'innerHTML' property on 'Element': This document requires 'TrustedHTML' assignment.";

/** A node that page code creates (the recording overlay): DOM calls only, as a strict page allows. */
export class FakeNode {
  readonly page: FakePage;
  readonly tagName: string;
  attrs = new Map<string, string>();
  readonly style: Record<string, unknown> & { setProperty(k: string, v: string, priority?: string): void };
  children: FakeNode[] = [];
  parent: FakeNode | FakeShadowRoot | FakeElement | null = null;
  shadow?: FakeShadowRoot;

  constructor(page: FakePage, tag: string) {
    this.page = page;
    this.tagName = tag.toUpperCase();
    const style: Record<string, unknown> = {};
    Object.defineProperty(style, "setProperty", { value: (k: string, v: string) => { style[k] = v; } });
    this.style = style as FakeNode["style"];
  }
  setAttribute(n: string, v: string) {
    if (n.toLowerCase() === "style") throw new Error("fake CSP: an inline style attribute is refused (style-src)");
    this.attrs.set(n, String(v));
  }
  getAttribute(n: string) { return this.attrs.get(n) ?? null; }
  set innerHTML(_v: string) { throw new TypeError(TRUSTED_HTML); }
  get innerHTML() { return ""; }
  appendChild(c: FakeNode) { return this.insertBefore(c, null); }
  insertBefore(c: FakeNode, ref: FakeNode | null) {
    c.remove();
    c.parent = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
    return c;
  }
  remove() {
    const p = this.parent;
    if (p instanceof FakeElement) this.page.appended.splice(this.page.appended.indexOf(this), 1);
    else if (p) p.children.splice(p.children.indexOf(this), 1);
    this.parent = null;
  }
  get isConnected(): boolean {
    let n: FakeNode = this;
    for (;;) {
      const p = n.parent;
      if (p instanceof FakeShadowRoot) n = p.host;
      else if (p instanceof FakeNode) n = p;
      else return p === this.page.body && this.page.appended.includes(n);
    }
  }
  attachShadow(_opts: { mode: string }) { return (this.shadow = new FakeShadowRoot(this)); }
  animate(_keyframes: unknown[], opts: { duration?: number }) {
    this.page.animations++;
    const a = { onfinish: null as null | (() => void), cancelled: false, cancel() { a.cancelled = true; } };
    this.page.later(opts.duration ?? 0, () => { if (!a.cancelled) a.onfinish?.(); });
    return a;
  }
  getBoundingClientRect() { return { x: 0, y: 0, left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }; }
  getClientRects() { return []; }
}

export class FakeShadowRoot {
  readonly host: FakeNode;
  children: FakeNode[] = [];
  constructor(host: FakeNode) { this.host = host; }
  appendChild(c: FakeNode) { return this.insertBefore(c, null); }
  insertBefore(c: FakeNode, ref: FakeNode | null) { return FakeNode.prototype.insertBefore.call(this as unknown as FakeNode, c, ref); }
}

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
  get isContentEditable() { return this.attrs.get("contenteditable") === "true"; }
  get type() { return this.attrs.get("type") ?? "text"; }
  getBoundingClientRect() {
    const [x, y, width, height] = this.hidden ? [0, 0, 0, 0] : this.rect;
    return { x, y, left: x, top: y, width, height, right: x + width, bottom: y + height };
  }
  getClientRects() { return this.hidden ? [] : [this.getBoundingClientRect()]; }
  scrollIntoView() {}
  focus() { this.page.focused = this; }
  click() { void this.page.activate(this); }
  set innerHTML(_v: string) { throw new TypeError(TRUSTED_HTML); }
  get innerHTML() { return ""; }
  /** Only the body takes children: page code appends its own nodes to the document element. */
  appendChild(c: FakeNode) {
    c.remove();
    c.parent = this;
    this.page.appended.push(c);
    return c;
  }
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
  /** Every key event, with its modifiers and macOS editing commands. */
  keyEvents: { type: string; key: string; modifiers: number; text?: string; commands?: string[] }[] = [];
  wheel = 0;
  /** What a clipped screenshot shows: a test changes it to change the page's pixels (an add-on's fill). */
  paint = 0;
  /** The cells a grid editor (data-cells) committed with Tab or Enter, in order. */
  cells: string[] = [];
  /** Called with each key a key event presses. */
  onKey?: (key: string) => void;
  /** The device metrics override, while one is set. */
  metrics: { width: number; height: number; deviceScaleFactor: number } | undefined;
  /** Nodes page code appended to the document element (the recording overlay), and its animations. */
  appended: FakeNode[] = [];
  animations = 0;
  body!: FakeElement;
  /** The page's dedicated workers (by URL); a session's Target.setAutoAttach attaches them. */
  workers: string[] = [];
  bodies = new Map<string, { body: Buffer; mime: string }>();
  private context: vm.Context = vm.createContext({});
  private isolatedContexts = new Map<number, vm.Context>();
  private nextContextId = 1000;
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
    this.appended = [];
    this.elements = (spec?.elements ?? []).map((e, i) => {
      const Cls = e.tag === "input" ? FakeInputElement : e.tag === "a" ? FakeAnchorElement : FakeElement;
      return new Cls(this, e, i);
    });
    this.isolatedContexts.clear(); // a navigation destroys every isolated world
    this.context = this.newContext();
    spec?.onload?.(this);
  }

  later(ms: number, fn: () => void) {
    const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms);
    this.timers.add(t);
  }

  close() { for (const t of this.timers) clearTimeout(t); this.timers.clear(); }

  /** A new isolated world: its own global scope, the same shared DOM. */
  createIsolatedWorld(): number {
    const id = ++this.nextContextId;
    this.isolatedContexts.set(id, this.newContext());
    return id;
  }

  private newContext(): vm.Context {
    const page = this;
    const body = new FakeElement(this, { tag: "body" }, 0);
    this.body = body;
    Object.defineProperty(body, "innerText", { get: () => [page.text, ...page.elements.map((e) => e.innerText)].filter(Boolean).join("\n") });
    const document = {
      body,
      documentElement: body,
      get title() { return page.title; },
      set title(v: string) { page.title = String(v); },
      querySelector: (s: string) => page.select(s)[0] ?? null,
      querySelectorAll: (s: string) => page.select(s),
      get activeElement() { return page.focused ?? body; },
      createElement: (tag: string) => {
        if (tag.toLowerCase() === "style") throw new Error("fake CSP: a <style> element is refused (style-src)");
        return new FakeNode(page, tag);
      },
      createElementNS: (_ns: string, tag: string) => new FakeNode(page, tag),
    };
    const sandbox: Record<string, unknown> = {
      document,
      location: { get href() { return page.url; }, get hostname() { try { return new URL(page.url).hostname; } catch { return ""; } } },
      get innerWidth() { return page.metrics?.width ?? 1280; },
      get innerHeight() { return page.metrics?.height ?? 800; },
      requestAnimationFrame: (fn: (t: number) => void) => page.later(16, () => fn(performance.now())),
      performance: { now: () => performance.now() },
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

  /** Run page code the way Runtime.evaluate does. With a contextId, run it in that isolated world. */
  async evaluate(expression: string, awaitPromise: boolean, contextId?: number): Promise<{ result: object } | { exceptionDetails: object }> {
    const context = contextId === undefined ? this.context : this.isolatedContexts.get(contextId);
    if (!context) throw new Error("Cannot find context with specified id"); // the world was destroyed by a navigation
    try {
      let v = vm.runInContext(expression, context, { timeout: 5_000 });
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
    this.fake.network(this, "Network.requestWillBeSent", { requestId, type: "Fetch", documentURL: this.url, request: { method, url: url.href, postData: init.body }, initiator: { type: "script" } });
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

  /** Text typed into the focused field: an input's value, an editable element's text, else the page. */
  typeInto(text: string) {
    const f = this.focused;
    if (f && f.value !== undefined) f.value += text;
    else if (f?.isContentEditable) f.text += text;
    else this.typed += text;
  }

  hit(x: number, y: number): FakeElement | undefined {
    return [...this.elements].reverse().find((e) => {
      const r = e.getBoundingClientRect();
      return !e.hidden && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    });
  }
}

type Cast = { timer: NodeJS.Timeout; maxWidth: number; maxHeight: number; waiting: boolean; sent: number; acked: number };
/** A session on a page, or (with `worker`) on one of its workers, attached through the page's session. */
type Session = { id: string; page: FakePage; client: WebSocket; runtime: boolean; network: boolean; cast?: Cast; worker?: string };

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
  /** A method named here fails once with this message (a test of error handling). */
  readonly failOnce = new Map<string, string>();
  /** Screencast frames sent and acknowledged, over every session. */
  frames = { sent: 0, acked: 0 };
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
        for (const [id, s] of fake.sessions) if (s.client === client) { fake.stopCast(s); fake.sessions.delete(id); }
      });
    });
    return fake;
  }

  async close() {
    for (const s of this.sessions.values()) this.stopCast(s);
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

  network(page: FakePage, method: string, params: object, fromWorker = false) { this.toSessions(page, method, params, (s) => s.network && !!s.worker === fromWorker); }

  /**
   * Traffic a test injects into a page (as if the page had sent it), or with `worker` into its workers'
   * sessions. With `ms` the request stays in flight that long before its response.
   */
  traffic(page: FakePage, r: { method?: string; url: string; postData?: string; status?: number; body?: string; mime?: string }, opts: { worker?: boolean; ms?: number } = {}) {
    const requestId = `inj.${Math.random().toString(36).slice(2)}`;
    const worker = !!opts.worker;
    this.network(page, "Network.requestWillBeSent", { requestId, type: "Fetch", documentURL: page.url, request: { method: r.method ?? "GET", url: r.url, postData: r.postData } }, worker);
    page.bodies.set(requestId, { body: Buffer.from(r.body ?? ""), mime: r.mime ?? "application/json" });
    const finish = () => {
      this.network(page, "Network.responseReceived", { requestId, type: "Fetch", response: { url: r.url, status: r.status ?? 200, mimeType: r.mime ?? "application/json" } }, worker);
      this.network(page, "Network.loadingFinished", { requestId }, worker);
    };
    if (opts.ms) setTimeout(finish, opts.ms); else finish();
  }

  navigate(page: FakePage, url: string) {
    page.load(url);
    this.toSessions(page, "Page.frameNavigated", { frame: { id: `F-${page.targetId}`, url, loaderId: randomUUID() }, type: "Navigation" });
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

  private toSessions(page: FakePage, method: string, params: object, want: (s: Session) => boolean = (s) => !s.worker) {
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
      const failure = this.failOnce.get(msg.method);
      if (failure !== undefined) { this.failOnce.delete(msg.method); return fail(failure); }
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
        this.stopCast(s);
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
          this.stopCast(s);
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

  /**
   * Screencast: a frame every 33 ms, the next only after the last was acknowledged, as Chrome does. Like
   * Chrome, the first frame has the window's own size; later ones have the emulated size.
   */
  private startCast(s: Session, params: { maxWidth?: number; maxHeight?: number }) {
    this.stopCast(s);
    const cast: Cast = { maxWidth: params.maxWidth ?? 1e9, maxHeight: params.maxHeight ?? 1e9, waiting: false, sent: 0, acked: 0, timer: setInterval(() => {
      if (cast.waiting) return;
      const m = cast.sent > 0 ? s.page.metrics : undefined;
      let w = m ? Math.round(m.width * m.deviceScaleFactor) : 1280, h = m ? Math.round(m.height * m.deviceScaleFactor) : 800;
      const k = Math.min(1, cast.maxWidth / w, cast.maxHeight / h);
      w = Math.round(w * k); h = Math.round(h * k);
      cast.waiting = true;
      cast.sent++;
      this.frames.sent++;
      const metadata = { offsetTop: 0, pageScaleFactor: 1, deviceWidth: w, deviceHeight: h, scrollOffsetX: 0, scrollOffsetY: 0, timestamp: Date.now() / 1000 };
      s.client.send(JSON.stringify({ method: "Page.screencastFrame", params: { data: this.jpeg(w, h), metadata, sessionId: cast.sent }, sessionId: s.id }));
    }, 33) };
    s.cast = cast;
  }

  stopCast(s: Session) {
    if (s.cast) clearInterval(s.cast.timer);
    s.cast = undefined;
  }

  private jpegs = new Map<string, string>();
  private jpeg(w: number, h: number): string {
    const key = `${w}x${h}`;
    if (!this.jpegs.has(key)) this.jpegs.set(key, greyJpeg(w, h).toString("base64"));
    return this.jpegs.get(key)!;
  }

  private async onSession(s: Session, method: string, params: any): Promise<object | undefined> {
    const page = s.page;
    switch (method) {
      case "Page.enable": case "Emulation.setFocusEmulationEnabled": case "Fetch.disable": case "Network.disable": case "Page.bringToFront":
      case "Runtime.runIfWaitingForDebugger": return {};
      case "Target.setAutoAttach":
        // Like Chrome: each of the page's workers is attached through this session, announced on it.
        if (params.autoAttach) for (const url of page.workers) {
          const id = randomUUID().replace(/-/g, "").toUpperCase();
          this.sessions.set(id, { id, page, client: s.client, runtime: false, network: false, worker: url });
          s.client.send(JSON.stringify({ method: "Target.attachedToTarget", sessionId: s.id,
            params: { sessionId: id, waitingForDebugger: false, targetInfo: { targetId: `W-${id.slice(0, 8)}`, type: "worker", url, title: "", attached: true } } }));
        }
        return {};
      case "Target.detachFromTarget": return this.onBrowser(s.client, method, params);
      case "Emulation.setDeviceMetricsOverride": page.metrics = { width: params.width, height: params.height, deviceScaleFactor: params.deviceScaleFactor }; return {};
      case "Emulation.clearDeviceMetricsOverride": page.metrics = undefined; return {};
      case "Page.startScreencast": this.startCast(s, params); return {};
      case "Page.stopScreencast": this.stopCast(s); return {};
      case "Page.screencastFrameAck": if (s.cast) { s.cast.waiting = false; s.cast.acked++; this.frames.acked++; } return {};
      case "Runtime.enable": s.runtime = true; return {};
      case "Network.enable": s.network = true; return {};
      case "Page.navigate": {
        const url = String(params.url);
        this.navigate(page, url);
        return { frameId: `F-${page.targetId}`, loaderId: randomUUID() };
      }
      case "Page.createIsolatedWorld": return { executionContextId: page.createIsolatedWorld() };
      case "Runtime.evaluate": return page.evaluate(String(params.expression), !!params.awaitPromise, params.contextId);
      case "Input.dispatchMouseEvent": {
        if (params.type === "mouseWheel") { page.wheel += params.deltaY ?? 0; return {}; }
        const el = page.hit(params.x, params.y);
        if (params.type === "mouseMoved") { page.hovered = el; if (el) el.onhover?.(page, el); }
        if (params.type === "mousePressed" && el && el.value !== undefined) page.focused = el; // a press focuses a text field, as in Chrome
        if (params.type === "mouseReleased" && el) await page.activate(el);
        return {};
      }
      case "Input.insertText":
        // An app's own editor (data-keys-only, like the Google Sheets cell editor) ignores inserted text.
        if (page.focused?.hasAttribute("data-keys-only")) return {};
        page.typeInto(params.text);
        return {};
      case "Input.dispatchKeyEvent":
        page.keyEvents.push({ type: params.type, key: params.key, modifiers: params.modifiers ?? 0, text: params.text, commands: params.commands });
        if (params.type === "keyDown" || params.type === "rawKeyDown") { page.keys.push(params.key); page.onKey?.(params.key); }
        // In a grid editor (data-cells), Tab and Enter commit the cell and leave the editor empty for the next one.
        if ((params.key === "Tab" || params.key === "Enter") && params.type !== "keyUp" && page.focused?.hasAttribute("data-cells")) {
          page.cells.push(page.focused.text);
          page.focused.text = "";
        }
        // A key with text types it, as in Chrome (Enter's "\r" only submits).
        if (params.type === "keyDown" && params.text && params.text !== "\r") page.typeInto(params.text);
        return {};
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
      case "Page.getLayoutMetrics": return { cssContentSize: { x: 0, y: 0, width: page.metrics?.width ?? 1280, height: 2400 }, cssVisualViewport: { pageX: 0, pageY: 0 } };
      case "Page.captureScreenshot":
        if (!params.clip) return { data: PNG_1x1 };
        { // A clip: 8x8 pixels at the device scale, all in a colour that follows page.paint.
          const k = page.metrics?.deviceScaleFactor ?? 1, v = page.paint % 256;
          return { data: rgbaPng(Math.max(1, Math.round(8 * k)), Math.max(1, Math.round(8 * k)), () => [v, 255 - v, 128, 255]).toString("base64") };
        }
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
