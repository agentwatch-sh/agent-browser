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
// With `backgroundTabs` on, a tab that agent-browser opens is not in front, as in Chrome: its page is
// hidden and Chrome draws it only in some cases (see FakePage.background). A page in a window of its
// own (Target.createTarget with newWindow) is the front tab of a window that is not active, as on
// Linux with --disable-backgrounding-occluded-windows: its page is visible and draws, and it has no
// focus until a press in it activates its window or an activation does (FakeChrome.focusedWindow).

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
  /** position: fixed: the element does not move when the page scrolls (FakeChrome.scrolls). */
  fixed?: boolean;
  onclick?: (page: FakePage, el: FakeElement) => void | Promise<void>;
  onhover?: (page: FakePage, el: FakeElement) => void;
};
export type PageSpec = { title?: string; text?: string; elements?: ElementSpec[]; onload?: (page: FakePage) => void };
/** A fixture site: the page for a URL, or undefined for an empty page. */
export type Site = (url: URL) => PageSpec | undefined;

export type Call = { method: string; params: any; sessionId?: string; targetId?: string; /** When the fake got it (Date.now()). */ t: number };

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

/** A shot of a background page (FakePage.framesDrawn), 2x2 pixels: its top row is SHOT_COLOUR, and its bottom row too, or white when the frame was not fully drawn. */
export const SHOT_COLOUR: readonly number[] = [0, 128, 255];
const SHOT_FULL = rgbaPng(2, 2, () => [...SHOT_COLOUR, 255] as [number, number, number, number]).toString("base64");
const SHOT_TOP_ONLY = rgbaPng(2, 2, (_x, y) => (y === 0 ? [...SHOT_COLOUR, 255] : [255, 255, 255, 255]) as [number, number, number, number]).toString("base64");

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
  fixed: boolean;
  private stored: string | undefined;
  /**
   * The caret of a text field or an editable element, as Chromium 156 keeps it (test/live/anti-detect/extra.ts --exp
   * caret): 0 in a field whose text came with the page, at the end after a script set the value; a press puts it
   * where it lands (8 px a character); el.focus() keeps it; Home, End, the arrows and Control+Home/End move it.
   */
  selectionStart = 0;
  selectionEnd = 0;
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
    this.fixed = !!spec.fixed;
    this.stored = spec.value ?? (["INPUT", "TEXTAREA"].includes(this.tagName) ? "" : undefined);
    this.onclick = spec.onclick;
    this.onhover = spec.onhover;
  }
  /** An input's or a textarea's text; a script that sets it puts the caret at its end, as in Chrome. */
  get value(): string | undefined { return this.stored; }
  set value(v: string | undefined) { this.stored = v; const n = (v ?? "").length; this.selectionStart = this.selectionEnd = n; }
  /** The text that the caret moves in: an input's value, else an editable element's text. */
  get caretText(): string { return this.stored ?? this.text; }
  setSelectionRange(a: number, b: number) { this.selectionStart = a; this.selectionEnd = b; }
  contains(n: unknown) { return n === this; }
  closest(sel: string) { return this.page.select(sel).includes(this) ? this : null; }
  get parentElement() { return null; }
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
    const [x0, y0, width, height] = this.hidden ? [0, 0, 0, 0] : this.rect;
    const x = this.fixed || this.hidden ? x0 : x0 - this.page.scrollX, y = this.fixed || this.hidden ? y0 : y0 - this.page.scrollY;
    return { x, y, left: x, top: y, width, height, right: x + width, bottom: y + height };
  }
  getClientRects() { return this.hidden ? [] : [this.getBoundingClientRect()]; }
  /** A script's scroll (no wheel, no key): counted, and with FakeChrome.scrolls the page scrolls the element to the middle. */
  scrollIntoView() {
    this.page.scriptScrolls++;
    if (this.page.fake.scrolls && !this.fixed) this.page.scrollTo(this.rect[0] + this.rect[2] / 2 - this.page.width / 2, this.rect[1] + this.rect[3] / 2 - this.page.height / 2);
  }
  /** A script's focus (no press): counted. The caret stays where it was (Chrome restores the cached selection). */
  focus() { this.page.scriptFocus++; this.page.focused = this; }
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
  /** The origin that about:blank got from the page that opened it (window.open() in Chrome), else none. */
  openerOrigin: string | undefined;
  /** The document's security origin, as Page.getFrameTree gives it: the URL's, else the opener's for about:blank, else "://" (opaque). */
  get securityOrigin(): string {
    try { const u = new URL(this.url); if (u.protocol === "http:" || u.protocol === "https:") return u.origin; } catch { /* below */ }
    return this.url === "about:blank" && this.openerOrigin ? this.openerOrigin : "://";
  }
  title = "";
  text = "";
  elements: FakeElement[] = [];
  focused: FakeElement | undefined;
  hovered: FakeElement | undefined;
  typed = "";
  keys: string[] = [];
  /** Every key event, with its modifiers, its key codes and macOS editing commands. */
  keyEvents: { type: string; key: string; modifiers: number; keyCode?: number; native?: number; text?: string; commands?: string[] }[] = [];
  wheel = 0;
  /** The page's scroll offset (FakeChrome.scrolls: the wheel and scrollIntoView move it). */
  scrollX = 0;
  scrollY = 0;
  /** Scrolls by a script (el.scrollIntoView) and focus by a script (el.focus()): a person makes neither. */
  scriptScrolls = 0;
  scriptFocus = 0;
  /** The file chooser opened by a trusted click on a file input (or its label), while a session intercepts it. */
  fileChoosers = 0;
  /** A test's hook: called when a session asks for the document (DOM.getDocument), before the answer. */
  onDocument?: () => void;
  /** A test's hook: the input that a click's file chooser names (Page.fileChooserOpened), in place of the clicked one. */
  chooserFor?: (clicked: FakeElement) => FakeElement | null;
  /** Listeners that page code added to the document (an isolated world's too): the fake sends them the real pointer event of an activation. */
  listeners = new Map<string, Set<(e: object) => void>>();
  /** The view size, as innerWidth and innerHeight give it. */
  get width() { return this.metrics?.width ?? this.stuck?.width ?? 1280; }
  get height() { return this.metrics?.height ?? this.stuck?.height ?? 800; }
  /** The page's own height: below its lowest element, at least 2400 px. */
  get scrollHeight() { return Math.max(2400, ...this.elements.map((e) => e.rect[1] + e.rect[3] + 100)); }
  scrollTo(x: number, y: number) {
    this.scrollX = Math.max(0, Math.min(x, 4000));
    this.scrollY = Math.max(0, Math.min(y, this.scrollHeight - this.height));
  }
  /** Dispatch an event to the document's listeners. */
  dispatch(type: string, e: object) { for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ type, ...e }); }
  /** What a clipped screenshot shows: a test changes it to change the page's pixels (an add-on's fill). */
  paint = 0;
  /** The cells a grid editor (data-cells) committed with Tab or Enter, in order. */
  cells: string[] = [];
  /** Called with each key a key event presses. */
  onKey?: (key: string) => void;
  /**
   * The view size that a capture set again when it ended after the override was cleared: it found the
   * override, and Chrome's ScreenshotCaptured sets the view to its size; no later clear or shot --size
   * undid it (review-41d on taylor, 3 of 3).
   */
  stuck: { width: number; height: number } | undefined;
  /** The device metrics override, while one is set. */
  metrics: { width: number; height: number; deviceScaleFactor: number } | undefined;
  /** Nodes page code appended to the document element (the recording overlay), and its animations. */
  appended: FakeNode[] = [];
  animations = 0;
  body!: FakeElement;
  /** The page's dedicated workers (by URL); a session's Target.setAutoAttach attaches them. */
  workers: string[] = [];
  bodies = new Map<string, { body: Buffer; mime: string }>();
  /**
   * The tab is not in front (ab-v16.15): its page reports "hidden", and Chrome draws no frame of it,
   * except while focus emulation is on (which makes the page "visible") or a capture is in flight (a
   * hidden capture: the page stays "hidden"). As measured on Chromium 156: a page that never drew a
   * frame drops each press, release and key (Input.insertText still arrives); a mouse move waits for
   * the next frame, at most 5 s; a capture waits until a later capture ends it (Chrome ends every
   * earlier pending capture with a later one), also while focus emulation makes the page "visible" and
   * draw (ab-b84.17): Chrome ends a capture when the frame that it forces is presented, and a frame of
   * a tab that is not in front is never on screen; it counts only when a later frame replaces it. So a
   * later capture ends the earlier ones only when Chrome drew a frame between them (see `capture`). A
   * capture's picture lacks everything below the first row when it was sent before Chrome drew two
   * frames of the page (see `framesDrawn`).
   */
  background = false;
  /** The page drew a frame since its load: false only for a page that loaded in a background tab. */
  drew = true;
  /** The page changes by itself (a caret, an animation): a capture sent while Chrome draws nothing still ends after a frame. */
  drawsByItself = false;
  /** Chrome draws no frame of the page at all (a loaded machine, a frozen renderer): no animation frame runs, and no capture ends. */
  noFrames = false;
  /** Called with the params of each capture of a background page as it arrives, before the fake holds it (a test's hook). */
  onCapture?: (params: Record<string, unknown>) => void;
  /** document.visibilityState after each change, in order. */
  visibilityChanges: string[] = [];
  /** The presses, releases and keys that the page dropped because it never drew a frame. */
  dropped: string[] = [];
  /** The sessions with focus emulation on. */
  readonly focusEmulated = new Set<string>();
  /**
   * Keys reached the page while its window was not the active one: Chrome then gives the page the
   * focus with no window switch, so two pages report the focus (measured on Chromium 156 on Linux:
   * window-keys-inactive of test/live/anti-detect/run.ts). It ends when the page's own window is activated.
   */
  keyFocus = false;
  /** The page's focus and blur events (document.hasFocus() changes), in order. */
  focusEvents: ("focus" | "blur")[] = [];
  private shownFocus = false;
  /**
   * The captures in flight on a background page, by their order: each one ends with a later one.
   * `at` is `frames` when it was sent: the frame that it forces is the next one.
   */
  heldCaptures: { n: number; at: number; found?: boolean; end: () => void }[] = [];
  /** Every frame that Chrome drew of the page, counted from its tab's start. */
  frames = 0;
  /**
   * The frames that Chrome drew of a background page since it last started to draw it (or since its
   * load). A frame drawn just after that start lacks the tiles below the first row (a shot of only the
   * top 256 px, seen once in 30 on Chromium 156); from the second one on, the frame is complete.
   */
  framesDrawn = 0;
  private wasDrawing = true;
  private nextCapture = 1;
  private frameWaiters: (() => void)[] = [];
  private frameDue = false;
  private closed = false;
  private shownAs: "visible" | "hidden" = "visible";
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

  get visibilityState(): "visible" | "hidden" { return !this.background || this.focusEmulated.size > 0 ? "visible" : "hidden"; }
  /** document.hasFocus(): focus emulation, keys into its inactive window (keyFocus), or the front tab of the active window. */
  get hasFocus(): boolean { return this.focusEmulated.size > 0 || this.keyFocus || (!this.background && this.fake.focusedWindow === this.windowId); }
  /** After a change of the active window, the tab in front or focus emulation: log a focus or a blur. */
  updateFocus() {
    const f = this.hasFocus;
    if (f !== this.shownFocus) { this.shownFocus = f; this.focusEvents.push(f ? "focus" : "blur"); }
  }
  /** Chrome draws the page: it is visible, or a capture is in flight. */
  get drawing(): boolean { return this.visibilityState === "visible" || this.heldCaptures.length > 0; }

  /** After a change of focus emulation or of the captures in flight: log a visibility change, and draw the frames that wait. */
  update() {
    const v = this.visibilityState;
    if (v !== this.shownAs) { this.shownAs = v; this.visibilityChanges.push(v); }
    this.updateFocus();
    if (this.drawing !== this.wasDrawing) {
      this.wasDrawing = this.drawing;
      if (this.drawing) this.framesDrawn = 0;
    }
    this.scheduleFrame();
  }

  /** Run `fn` at the page's next frame: 16 ms from now while Chrome draws the page, else when it starts to. */
  atFrame(fn: () => void) {
    this.frameWaiters.push(fn);
    this.scheduleFrame();
  }

  /** One frame at a time, 16 ms apart, while Chrome draws the page. */
  private scheduleFrame() {
    if (this.frameDue || !this.drawing || this.noFrames) return;
    this.frameDue = true;
    this.later(16, () => {
      this.frameDue = false;
      this.drew = true;
      this.framesDrawn++;
      this.frames++;
      for (const fn of this.frameWaiters.splice(0)) fn();
    });
  }

  /**
   * A capture of a background page (see `background`); its result is `data`. Alone it waits, also
   * while the page is "visible" and drawn (focus emulation), unless the page changes by itself. A later
   * capture ends it, and every capture up to that later one, after a frame, but only when Chrome drew a
   * frame after it (the frame that it forced): two captures sent before the next frame share that frame,
   * and nothing replaces it, so both wait (as measured on Chromium 156 by review-41: with no frame
   * between the two captures, 8 of 8 default-mode and 4 of 4 hidden-drive shots failed after 30 s).
   * A capture sent while a device metrics override is set sets that override again when it ends, as
   * Chrome's PageHandler::ScreenshotCaptured restores the emulation that the capture found.
   */
  capture<T>(data: T, params: Record<string, unknown> = {}): Promise<T> {
    this.onCapture?.(params);
    const n = this.nextCapture++, found = this.metrics;
    const replaces = this.drawsByItself || this.heldCaptures.some((c) => c.at < this.frames);
    return new Promise((resolve) => {
      this.heldCaptures.push({ n, at: this.frames, found: !!found, end: () => {
        if (found && !this.metrics) this.stuck = { width: found.width, height: found.height };
        if (found) this.metrics = found;
        resolve(data);
      } });
      this.update();
      if (replaces && !this.noFrames) this.later(16, () => {
        this.drew = true;
        this.frames++;
        this.endHeld((c) => c.n <= n);
      });
    });
  }

  /** End the held captures that `which` names, in their order. */
  private endHeld(which: (c: { n: number; at: number }) => boolean) {
    const ended = this.heldCaptures.filter(which);
    this.heldCaptures = this.heldCaptures.filter((c) => !which(c));
    for (const c of ended) c.end();
    this.update();
  }

  /**
   * The page changes once by itself, now: this frame replaces the frames of the held captures that
   * Chrome drew already, and ends those captures (a capture whose frame is not drawn yet goes on waiting).
   */
  changeOnce() {
    this.frames++;
    this.endHeld((c) => c.at < this.frames - 1);
  }

  /**
   * The page is laid out again (a device metrics override): its next frame changes, and ends the held
   * captures whose frames Chrome drew already. Seen by review-41b on Chromium 156 with the hidden drive:
   * the shot's first capture of a still page ended in `shot --size`'s 0.5 s settle. Only for a hidden
   * page (the hidden drive, where a capture in flight makes Chrome draw at once): in the default mode
   * Chrome draws a background tab about once a second, and the relayout's frame came after the shot's
   * own capture (review-41c, 4 of 4 live default-mode `shot --size`: the first capture ended with it).
   */
  relayout() {
    if (this.background && this.visibilityState === "hidden") this.atFrame(() => this.endHeld((c) => c.at < this.frames - 1));
  }

  private heldMoves: (() => void)[] = [];
  /**
   * A mouse move on a background page waits for its next frame: at once when Chrome draws the page and
   * it drew one already; else when a frame comes, a press or a key comes (which sends it at once), or
   * after 5 s (Blink's rAF fallback).
   */
  moveWait(fallbackMs: number): Promise<void> {
    if (!this.background || (this.drawing && this.drew)) return Promise.resolve();
    return new Promise((r) => { this.heldMoves.push(r); this.atFrame(r); this.later(fallbackMs, r); });
  }
  flushMoves() { for (const r of this.heldMoves.splice(0)) r(); }

  /** Background tab: a page that never drew a frame drops a press, a release or a key. */
  drops(what: string): boolean {
    if (!this.background || this.drew) return false;
    this.dropped.push(what);
    return true;
  }

  /**
   * The captures that were in flight when the page went to a new document: Chrome never ends them
   * (review-41b, Chromium 156, default mode: a shot whose page navigated during its own capture failed
   * after 30 s, though later captures ended). One that found a size override ends 50 ms later and sets
   * that override again (review-41d: 25 ms to 1.1 s after the shot cleared it).
   */
  lostCaptures: { n: number; at: number; end: () => void }[] = [];

  /** Load a URL: a fixture page for http://127.0.0.1, an empty page for anything else (the fake never leaves this machine). */
  load(url: string) {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.lostCaptures.push(...this.heldCaptures.filter((c) => !c.found));
    const late = this.heldCaptures.filter((c) => c.found);
    this.heldCaptures = [];
    this.frameDue = false;
    this.frameWaiters = []; // a new document never runs the old one's animation frames
    this.flushMoves();
    this.url = url;
    let spec: PageSpec | undefined;
    if (url !== "about:blank") { try { spec = this.fake.site(new URL(url)); } catch { spec = undefined; } }
    this.title = spec?.title ?? "";
    this.text = spec?.text ?? "";
    this.focused = this.hovered = undefined;
    this.appended = [];
    this.scrollX = this.scrollY = 0;
    this.listeners.clear();
    this.elements = (spec?.elements ?? []).map((e, i) => {
      const Cls = e.tag === "input" ? FakeInputElement : e.tag === "a" ? FakeAnchorElement : FakeElement;
      return new Cls(this, e, i);
    });
    this.isolatedContexts.clear(); // a navigation destroys every isolated world
    this.context = this.newContext();
    this.drew = !this.background; // a new page in a background tab has drawn no frame yet
    this.framesDrawn = 0;
    this.shownAs = this.visibilityState; // a new page starts in its tab's state: no visibilitychange
    this.shownFocus = this.hasFocus; // and in its focus: no focus event
    this.update();
    for (const c of late) this.later(50, () => c.end());
    spec?.onload?.(this);
  }

  later(ms: number, fn: () => void): NodeJS.Timeout | undefined {
    if (this.closed) return undefined; // a closed page runs nothing again
    const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms);
    this.timers.add(t);
    return t;
  }

  cancel(t: NodeJS.Timeout | undefined) {
    if (t === undefined) return;
    clearTimeout(t);
    this.timers.delete(t);
  }

  close() { this.closed = true; for (const t of this.timers) clearTimeout(t); this.timers.clear(); }

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
      get visibilityState() { return page.visibilityState; },
      hasFocus: () => page.hasFocus,
      elementFromPoint: (x: number, y: number) => page.hit(x, y) ?? body,
      get scrollingElement() { return body; },
      addEventListener: (type: string, fn: (e: object) => void) => { let set = page.listeners.get(type); if (!set) page.listeners.set(type, (set = new Set())); set.add(fn); },
      removeEventListener: (type: string, fn: (e: object) => void) => { page.listeners.get(type)?.delete(fn); },
      createElement: (tag: string) => {
        if (tag.toLowerCase() === "style") throw new Error("fake CSP: a <style> element is refused (style-src)");
        return new FakeNode(page, tag);
      },
      createElementNS: (_ns: string, tag: string) => new FakeNode(page, tag),
    };
    const sandbox: Record<string, unknown> = {
      document,
      location: { get href() { return page.url; }, get hostname() { try { return new URL(page.url).hostname; } catch { return ""; } } },
      get innerWidth() { return page.width; },
      get innerHeight() { return page.height; },
      // The window on the screen: at 0,0, with 87 px of Chrome's own frame above the page (as on taylor's Xvfb).
      screenX: 0, screenY: 0,
      get outerWidth() { return page.width; },
      get outerHeight() { return page.height + 87; },
      devicePixelRatio: 1,
      get scrollX() { return page.scrollX; },
      get scrollY() { return page.scrollY; },
      scrollTo: (x: number, y: number) => page.scrollTo(x, y),
      requestAnimationFrame: (fn: (t: number) => void) => page.atFrame(() => fn(performance.now())),
      performance: { now: () => performance.now() },
      getComputedStyle: (el: FakeElement) => ({ visibility: el.hidden ? "hidden" : "visible", display: el.hidden ? "none" : "block" }),
      HTMLElement: FakeElement,
      HTMLInputElement: FakeInputElement,
      HTMLAnchorElement: FakeAnchorElement,
      fetch: (input: string, init?: { method?: string; body?: string }) => page.fetch(String(input), init),
      btoa, atob, Blob,
      setTimeout: (fn: () => void, ms: number) => page.later(ms, fn),
      clearTimeout: (t: NodeJS.Timeout | undefined) => page.cancel(t),
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
    // A target=_blank link (noopener, Chrome's default for it): the opener's frame asks for a navigation in a new tab
    // (Page.frameRequestedNavigation with disposition newTab, on the opener's sessions), and the page opens there.
    if (el.getAttribute("target") === "_blank") { this.fake.requestNavigation(this, target, "newTab"); this.fake.openFrom(this, target); return; }
    this.fake.navigate(this, target);
  }

  /** Text typed into the focused field at its caret: an input's value, an editable element's text, else the page. */
  typeInto(text: string) {
    const f = this.focused;
    if (f && (f.value !== undefined || f.isContentEditable)) {
      const t = f.caretText, a = Math.min(f.selectionStart, t.length), b = Math.min(Math.max(f.selectionEnd, a), t.length);
      const next = t.slice(0, a) + text + t.slice(b);
      if (f.value !== undefined) f.value = next; else f.text = next;
      f.selectionStart = f.selectionEnd = a + text.length;
    } else this.typed += text;
  }

  /** A key that moves the caret of the focused field: Home, End, the arrows; with Control, Home and End go to the start and the end of the whole text. */
  moveCaret(key: string, modifiers: number) {
    const f = this.focused;
    if (!f || (f.value === undefined && !f.isContentEditable)) return;
    const n = f.caretText.length, at = f.selectionEnd, shift = (modifiers & 8) !== 0;
    const to = key === "Home" ? 0 : key === "End" ? n : key === "ArrowLeft" ? Math.max(0, at - 1) : key === "ArrowRight" ? Math.min(n, at + 1) : undefined;
    if (to === undefined) return;
    if (shift) f.selectionEnd = to; else f.selectionStart = f.selectionEnd = to;
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
type Session = { id: string; page: FakePage; client: WebSocket; runtime: boolean; network: boolean; cast?: Cast; worker?: string; /** Page.setInterceptFileChooserDialog is on. */ chooser?: boolean };

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
  /** The active window: its front tab has the focus. A new window from Target.createTarget with background: true does not take it. */
  focusedWindow = 1;
  /**
   * The real (X) pointer, in the page's client coordinates (every window is at the same place, as on taylor's Xvfb
   * with no window manager). When a window comes forward under it, its page gets a trusted mousemove there with
   * movement 0, as Chrome on Linux gives it (extra.ts --exp pointer). Undefined: the pointer is outside every window.
   */
  xPointer: { x: number; y: number } | undefined;
  /** The wheel and scrollIntoView scroll the page (FakePage.scrollY). Off (the default for the older tests): they move nothing. */
  scrolls = false;
  /** Each change of the active window, in order, and what made it: "activate" (Target.activateTarget), "bringToFront", "press" (Chrome activates the window of a page that gets a press), "open". */
  readonly windowActivations: { windowId: number; by: string; targetId?: string }[] = [];
  /**
   * Tabs share their window as in Chrome: an activation (Target.activateTarget, Page.bringToFront) puts
   * its tab in front of its window and the window's other tabs behind (background), and a page that a
   * page opens (window.open, a target=_blank link) comes in front of the opener's window, with the
   * focus. Off (the default for the older tests): only `background` says which page is behind.
   */
  tabSwitches = false;
  connections = 0;
  /** A method named here fails once with this message (a test of error handling). */
  readonly failOnce = new Map<string, string>();
  /** Screencast frames sent and acknowledged, over every session. */
  frames = { sent: 0, acked: 0 };
  /** Target.createTarget with background: true (and no new window) opens a background tab, as in Chrome (see FakePage.background). Off: every page is in front. */
  backgroundTabs = false;
  /** How long a mouse move on a background page that Chrome does not draw waits at most (Blink's rAF fallback timer). */
  moveFallbackMs = 5000;
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
        for (const [id, s] of fake.sessions) if (s.client === client) {
          fake.stopCast(s);
          fake.sessions.delete(id);
          if (s.page.focusEmulated.delete(id)) s.page.update();
        }
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

  /** Make `windowId` the active window: the pages there get the focus (their keyFocus ends), the others a blur. */
  focusWindow(windowId: number, by: string, targetId?: string) {
    if (this.focusedWindow === windowId) return;
    this.focusedWindow = windowId;
    this.windowActivations.push({ windowId, by, ...(targetId ? { targetId } : {}) });
    for (const p of this.pages.values()) { if (p.windowId === windowId) p.keyFocus = false; p.updateFocus(); }
    // The window comes forward under the X pointer: its front page gets a real pointer event there (not for a press: the pointer is already in it).
    if (by !== "press" && this.xPointer) for (const p of this.pages.values()) if (p.windowId === windowId && !p.background)
      p.dispatch("mousemove", { isTrusted: true, clientX: this.xPointer.x, clientY: this.xPointer.y, movementX: 0, movementY: 0 });
  }

  /** Target.activateTarget and Page.bringToFront: the tab comes in front of its window (tabSwitches), and its window becomes the active one. */
  activateTab(page: FakePage, by: string) {
    this.selectTab(page);
    this.focusWindow(page.windowId, by, page.targetId);
    page.updateFocus();
  }

  /** chrome.tabs.update({ active: true }): the tab comes in front of its window (tabSwitches: the others go behind); the window keeps or lacks the focus. */
  selectTab(page: FakePage) {
    if (this.tabSwitches) for (const q of this.pages.values()) if (q !== page && q.windowId === page.windowId && !q.background) { q.background = true; q.update(); }
    if (page.background) { page.background = false; page.update(); }
    for (const q of this.pages.values()) if (q.windowId === page.windowId) q.updateFocus();
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
    // As Chrome: the navigation starts (Page.frameStartedNavigating), then the new document commits (Page.frameNavigated).
    this.toSessions(page, "Page.frameStartedNavigating", { frameId: `F-${page.targetId}`, url, loaderId: randomUUID(), navigationType: "differentDocument" });
    page.load(url);
    this.toSessions(page, "Page.frameNavigated", { frame: { id: `F-${page.targetId}`, url, loaderId: randomUUID() }, type: "Navigation" });
    setTimeout(() => this.toSessions(page, "Page.loadEventFired", { timestamp: Date.now() / 1000 }), 5);
  }

  /**
   * A page's script asks for a navigation of its main frame (Page.frameRequestedNavigation); it does not commit yet.
   * `disposition` as Chrome gives it: "currentTab" for the frame itself, "newTab" (and "newWindow") for a page that opens elsewhere.
   */
  requestNavigation(page: FakePage, url: string, disposition = "currentTab") {
    this.toSessions(page, "Page.frameRequestedNavigation", { frameId: `F-${page.targetId}`, reason: disposition === "currentTab" ? "scriptInitiated" : "anchorClick", url, disposition });
  }

  /** A navigation of the main frame starts (Page.frameStartedNavigating) and does not commit yet: a slow server, say. */
  startNavigation(page: FakePage, url: string) {
    this.toSessions(page, "Page.frameStartedNavigating", { frameId: `F-${page.targetId}`, url, loaderId: randomUUID(), navigationType: "differentDocument" });
  }

  /** window.open() or a target=_blank link: a new tab in the opener's window (with tabSwitches, in front and focused). Returns it. */
  openFrom(opener: FakePage, url: string): FakePage {
    const page = new FakePage(this, randomUUID().replace(/-/g, "").toUpperCase(), opener.windowId);
    this.pages.set(page.targetId, page);
    if (url === "about:blank") page.openerOrigin = opener.securityOrigin;
    page.load(url);
    if (this.tabSwitches) this.activateTab(page, "open");
    return page;
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
    this.calls.push({ method: msg.method, params, sessionId: msg.sessionId, targetId: session?.page.targetId ?? params.targetId, t: Date.now() });
    const reply = (result: object) => client.send(JSON.stringify({ id: msg.id, result, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) }));
    const fail = (message: string, code = -32000) => client.send(JSON.stringify({ id: msg.id, error: { code, message }, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) }));
    try {
      if (msg.sessionId && !session) return fail(`Session with given id not found.`);
      const failure = this.failOnce.get(msg.method);
      if (failure !== undefined) { this.failOnce.delete(msg.method); return fail(failure); }
      const result = session ? await this.onSession(session, msg.method, params) : await this.onBrowser(client, msg.method, params);
      if (msg.sessionId && !this.sessions.has(msg.sessionId)) return; // detached meanwhile: Chrome sends no reply
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
        page.background = this.backgroundTabs && !!params.background && !params.newWindow;
        this.pages.set(page.targetId, page);
        page.load(params.url ?? "about:blank");
        if (params.newWindow && !params.background) this.focusWindow(windowId, "open", page.targetId); // a new window in front takes the focus
        return { targetId: page.targetId };
      }
      case "Target.activateTarget": {
        const page = this.pages.get(params.targetId);
        if (!page) throw new Error("No target with given id found");
        this.activateTab(page, "activate");
        return {};
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
        if (s.page.focusEmulated.delete(s.id)) s.page.update();
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
      if (cast.waiting || !s.page.drawing) return;
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
      case "Emulation.setFocusEmulationEnabled":
        if (params.enabled) page.focusEmulated.add(s.id); else page.focusEmulated.delete(s.id);
        page.update();
        return {};
      case "Page.bringToFront": this.activateTab(page, "bringToFront"); return {};
      case "Page.enable": case "Fetch.disable": case "Network.disable":
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
      case "Emulation.setDeviceMetricsOverride":
        page.metrics = { width: params.width, height: params.height, deviceScaleFactor: params.deviceScaleFactor };
        page.relayout();
        return {};
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
        if (params.type === "mouseWheel") {
          page.wheel += params.deltaY ?? 0;
          // A pane that scrolls (data-scrolls, like the Sheets grid) redraws under the wheel; elsewhere nothing moves,
          // except the page itself with FakeChrome.scrolls.
          if (page.hit(params.x, params.y)?.hasAttribute("data-scrolls")) page.paint++;
          else if (this.scrolls) page.scrollTo(page.scrollX + (params.deltaX ?? 0), page.scrollY + (params.deltaY ?? 0));
          return {};
        }
        if (params.type === "mouseMoved") await page.moveWait(this.moveFallbackMs);
        else { page.flushMoves(); if (page.drops(params.type)) return {}; }
        const el = page.hit(params.x, params.y);
        if (params.type === "mouseMoved") { page.hovered = el; if (el) el.onhover?.(page, el); }
        // On Linux a press in a page whose window is not the active one makes Chrome activate that window (measured on Chromium 156).
        if (params.type === "mousePressed") this.focusWindow(page.windowId, "press", page.targetId);
        if (params.type === "mousePressed" && el && (el.value !== undefined || el.isContentEditable)) { // a press focuses a text field, as in Chrome, with the caret where it lands
          page.focused = el;
          el.selectionStart = el.selectionEnd = Math.max(0, Math.min(el.caretText.length, Math.round((params.x - el.getBoundingClientRect().left - 2) / 8)));
        }
        if (params.type === "mouseReleased" && el) {
          // A file input, or a label for one: with the chooser intercepted, Chrome tells the session and opens no dialog.
          const file = el.type === "file" && el.tagName === "INPUT" ? el : el.tagName === "LABEL" ? page.select(`#${el.getAttribute("for")}`)[0] : undefined;
          if (file?.type === "file") {
            const who = [...this.sessions.values()].find((x) => x.page === page && x.chooser);
            const named = page.chooserFor ? page.chooserFor(file) : file; // a test's hook: another input's chooser (a frame's), or none
            if (who && named) { page.fileChoosers++; who.client.send(JSON.stringify({ method: "Page.fileChooserOpened", params: { frameId: `F-${page.targetId}`, mode: "selectSingle", backendNodeId: page.elements.indexOf(named) + 2 }, sessionId: who.id })); }
            return {};
          }
          await page.activate(el);
        }
        return {};
      }
      case "Input.insertText":
        // An app's own editor (data-keys-only, like the Google Sheets cell editor) ignores inserted text.
        if (page.focused?.hasAttribute("data-keys-only")) return {};
        if (page.windowId !== this.focusedWindow && !page.keyFocus) { page.keyFocus = true; page.updateFocus(); }
        page.typeInto(params.text);
        return {};
      case "Input.dispatchKeyEvent":
        page.flushMoves();
        if (page.drops(`${params.type} ${params.key}`)) return {};
        // Keys do not activate the window; they give the page the focus all the same (window-keys-inactive).
        if (page.windowId !== this.focusedWindow && !page.keyFocus) { page.keyFocus = true; page.updateFocus(); }
        page.keyEvents.push({ type: params.type, key: params.key, modifiers: params.modifiers ?? 0, keyCode: params.windowsVirtualKeyCode,
          native: params.nativeVirtualKeyCode, text: params.text, commands: params.commands });
        if (params.type === "keyDown" || params.type === "rawKeyDown") { page.keys.push(params.key); page.onKey?.(params.key); page.moveCaret(params.key, params.modifiers ?? 0); }
        // In a grid editor (data-cells), Tab and Enter commit the cell and leave the editor empty for the next one.
        if ((params.key === "Tab" || params.key === "Enter") && params.type !== "keyUp" && page.focused?.hasAttribute("data-cells")) {
          page.cells.push(page.focused.text);
          page.focused.text = "";
        }
        // A key with text types it, as in Chrome (Enter's "\r" only submits).
        if (params.type === "keyDown" && params.text && params.text !== "\r") page.typeInto(params.text);
        return {};
      case "DOM.getDocument": page.onDocument?.(); return { root: { nodeId: 1, nodeName: "#document", documentURL: page.url } };
      case "DOM.querySelector": {
        const el = page.select(params.selector)[0];
        return { nodeId: el ? page.elements.indexOf(el) + 2 : 0 };
      }
      case "Page.setInterceptFileChooserDialog": s.chooser = !!params.enabled; return {};
      // A node's backend id: the fake numbers both alike (an element's index + 2).
      case "DOM.describeNode": return { node: { nodeId: params.nodeId, backendNodeId: params.nodeId ?? params.backendNodeId, nodeName: "INPUT" } };
      case "DOM.setFileInputFiles": {
        const el = page.elements[(params.nodeId ?? params.backendNodeId) - 2];
        if (!el) throw new Error("Could not find node with given id");
        el.files = (params.files as string[]).map((f) => ({ name: basename(f) }));
        return {};
      }
      case "Page.getLayoutMetrics": return { cssContentSize: { x: 0, y: 0, width: page.metrics?.width ?? 1280, height: 2400 }, cssVisualViewport: { pageX: 0, pageY: 0 } };
      case "Page.captureScreenshot": {
        let data = PNG_1x1;
        if (params.clip) { // A clip: 8x8 pixels at the device scale, all in a colour that follows page.paint.
          const k = page.metrics?.deviceScaleFactor ?? 1, v = page.paint % 256;
          data = rgbaPng(Math.max(1, Math.round(8 * k)), Math.max(1, Math.round(8 * k)), () => [v, 255 - v, 128, 255]).toString("base64");
        } else if (page.background) data = page.framesDrawn >= 2 ? SHOT_FULL : SHOT_TOP_ONLY;
        return page.background ? page.capture({ data }, params) : { data };
      }
      case "Page.getFrameTree": return { frameTree: { frame: { id: `F-${page.targetId}`, url: page.url, securityOrigin: page.securityOrigin } } };
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
