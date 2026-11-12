// Fakes of the input stage's tests (board ab-t30.9): a fake clock, a fake tab (the stage's host, StagePage) with a fake
// Chrome that answers from a vector's page facts (test/vectors/stage.json), the model's gate for one tab (a promise
// chain, with a client's Page.handleJavaScriptDialog before it), and a client that sends the vector's calls at their
// times. No browser and no timer of the system: every time is the fake clock's.

import assert from "node:assert/strict";
import { drawPerson, paramsFor, type Person } from "../src/human/person.ts";
import { seededRandom } from "../src/human/random.ts";
import { CARET_SET, ELEMENT_KIND, FIELD_HIT, FIELD_STATE, FIELD_STILL, FIELD_STILL_IN, FOCUSED_FIELD, FOCUSED_IN, NODE_GEO, OBSTACLE_AGAIN, OBSTACLE_BOTH, OBSTACLE_FIND, OWNER_AT, SAME_ELEMENT, SCROLL_STATE, Stage, TEXT_TYPES, TWO_FRAMES, utilityCall, WHEEL_ELS, WHEEL_POINTS, type Body, type StageClock, type StagePage } from "../src/relay/stage.ts";

/** A clock of the tests: it moves only when every promise has settled, to its next timer. */
export class FakeClock implements StageClock {
  t = 0;
  private timers: { at: number; seq: number; fn: () => void; dead?: boolean }[] = [];
  private seq = 0;
  readonly epoch = 1_800_000_000_000;
  now = () => this.t;
  sleep = (ms: number) => new Promise<void>((r) => { this.timer(ms, r); });
  timer = (ms: number, fn: () => void) => {
    const x = { at: this.t + Math.max(0, ms), seq: this.seq++, fn };
    this.timers.push(x);
    return () => { x.dead = true; };
  };
  /** The epoch time of the fake clock (the stage's stamp). */
  stamp = () => this.epoch + this.t;
  /** Run until `done` or no timer is left (or `maxMs`): one timer at a time, every promise settled between two. */
  async run(done: () => boolean, maxMs = 120_000): Promise<void> {
    for (let i = 0; i < 2_000_000; i++) {
      await idle();
      if (done()) return;
      const live = this.timers.filter((x) => !x.dead).sort((a, b) => a.at - b.at || a.seq - b.seq);
      this.timers = live;
      if (!live.length || live[0].at > maxMs) return;
      const next = live[0];
      next.dead = true;
      this.t = Math.max(this.t, next.at);
      next.fn();
    }
  }
  /** Move the clock by `ms`, firing the timers on the way. */
  async advance(ms: number): Promise<void> { const end = this.t + ms; await this.run(() => false, end); await idle(); this.t = Math.max(this.t, end); await idle(); }
}
export const idle = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };

/** A command that the tab sent: its time, session, method and params; `dropped`: an input event that Chrome got while a dialog was open. */
export type Sent = { t: number; child?: string; method: string; params: any; pass?: number; read?: boolean; answered?: number; dropped?: boolean };
/** An answer to the client: its call, its time, its body, and how many commands the tab had sent then. */
export type Answer = { id: number; t: number; body: Body; n: number };
type Box = { x: number; y: number; width: number; height: number };

/** The top page's box of a node of the vector (its `mapped` box in a same-origin frame, its frame's box plus border in a cross-origin one). */
export function topBox(v: any, id: string): Box | null {
  const n = v.page.nodes[id];
  if (!n) return null;
  if (!n.frame) return n.box;
  if (n.mapped) return n.mapped;
  const f = v.page.frames[n.frame], d = (f.border ?? 0) + (f.padding ?? 0);
  return { x: n.box.x + f.box.x + d, y: n.box.y + f.box.y + d, width: n.box.width, height: n.box.height };
}
const within = (p: { x: number; y: number }, b: Box) => p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
const textual = (n: any) => (n.tag === "input" && TEXT_TYPES.includes(n.type ?? "text")) || n.tag === "textarea" || n.contenteditable === true;

/**
 * One tab of a vector, as the model gives it to the stage: its fake Chrome answers the stage's events and reads and the
 * client's calls from the vector's page facts and its `chrome` part. `hooks` lets a test change an answer.
 */
export class FakeTab implements StagePage {
  readonly id: number;
  readonly person: Person;
  readonly sent: Sent[] = [];
  readonly activations: number[] = [];
  readonly logs: string[] = [];
  readonly v: any;
  readonly clock: FakeClock;
  stage!: Stage;
  /** A test's answer of a command: a value, or a promise; undefined for the default. */
  hook: (s: Sent) => any = () => undefined;
  /** The client's events (Page.javascriptDialogOpening): the client's afterEvent calls wait for them. */
  readonly clientEvents: { t: number; method: string }[] = [];
  onClientEvent: (method: string) => void = () => {};
  /** The model's point of the page (an X record: x11 true). */
  modelPoint: { x: number; y: number; x11: boolean } | null;
  /** The tab's gate (the model's): each step after the one before. */
  gate: Promise<void> = Promise.resolve();
  /** The tab is gone (a detach or a removal): Chrome refuses every command of it. */
  closed = false;
  private dialogOpen = false;
  /** A test opened a dialog by its own hook (the client got Page.javascriptDialogOpening). */
  dialogSeen = false;
  private held: (() => void)[] = [];
  private errorsUsed = new Set<string>();
  private eventsDone = new Set<number>();
  /**
   * The page's fields (board ab-t30.10): the focused node, and each text field's value and selection, changed by the key
   * events, the texts, the clicks and Playwright's scripts (fill's select-all, focusNode's caret reset) as Chrome would.
   * A node's `mask: "digits"`: a key handler of the page that drops each typed key that is not a digit (an input mask:
   * the named exception); `value`: its text (else `text` letters).
   */
  focusedId: string | null;
  readonly fields = new Map<string, { value: string; s: number; e: number }>();
  /** The modifier keys down in the page (by the key events). */
  private mods = new Set<string>();
  /** The field that the stage's last focus read marked (the typing rule's read; review-119 P1). */
  private marked: string | null = null;
  /**
   * review-119: an input event that opens a dialog in the page (an alert in its handler): Chrome holds its answer until the
   * close, and drops each input event that it gets while the dialog is open; the stage and the client hear of the dialog
   * `dialogNoticeMs` later (the events that Chrome gets in that time are dropped too).
   */
  opensDialog: (s: Sent) => boolean = () => false;
  dialogNoticeMs = 0;
  heldAfterCloseMs = 0;
  /**
   * review-119b R3: a key handler of the page that blocks the page's main thread for that many ms at an input event (a busy
   * page). Chrome queues the later input events and gives them to the page in order when it is free (none is dropped), and
   * each answer, and each read of the page, comes then.
   */
  busy: (s: Sent) => number = () => 0;
  private freeAt = 0;
  private async free(): Promise<void> { const ms = this.freeAt - this.clock.now(); if (ms > 0) await new Promise<void>((r) => this.clock.timer(ms, r)); }
  /**
   * The scroll model (board ab-t30.11). Each scroller's position: "document" (the top page), "frame:<f>" (a frame's
   * document) and each element scroller of `page.scrollers` (its `box`, the client box, in the layout points of its
   * parent's content; `parent`, else its frame's document or the top page). A node's box is in the layout points of its
   * scroller's content (`scroller`, else its frame's document or the top page), so a scroll moves it. A wheel event
   * scrolls the first scroller under the point that can move in its direction (a frame's document, then its owner's), by
   * its delta (at most `step`); none when a scroller on the way `stops` the wheel (a non-passive listener that prevents
   * the default action). `wheels`: each wheel event that the page got, with the element under its point.
   */
  readonly sc: Record<string, { x: number; y: number }> = {};
  readonly wheels: { t: number; x: number; y: number; dx: number; dy: number; at: string; moved: string | null }[] = [];
  /** The scrollers of each reader's last SCROLL_STATE (by its handle), and the elements of its last WHEEL_POINTS. */
  private readonly marks = new Map<string, string[]>();
  private readonly els = new Map<string, string[]>();
  /** The arguments of the last SCROLL_STATE (the client's rect). */
  private lastArgs: any[] | null = null;
  constructor(v: any, clock: FakeClock, o: { id?: number; person?: Person } = {}) {
    this.v = v; this.clock = clock; this.id = o.id ?? 7;
    this.person = o.person ?? drawPerson(paramsFor(v.platform === "mac" ? "darwin" : "linux"), seededRandom(v.seed));
    this.modelPoint = v.page.last ? { ...v.page.last, x11: false } : null;
    this.focusedId = v.page.focused ?? null;
    for (const [id, n] of Object.entries<any>(v.page.nodes)) if (textual(n)) {
      const value = typeof n.value === "string" ? n.value : "abcdefghij".repeat(10).slice(0, n.text ?? 0);
      const c = n.caret ?? [0, 0];
      this.fields.set(id, { value, s: c[0], e: c[1] });
    }
    const S = v.page.scrollers ?? {};
    this.sc.document = { x: S.document?.scrollX ?? 0, y: S.document?.scrollY ?? 0 };
    for (const [f, fr] of Object.entries<any>(v.page.frames ?? {})) this.sc[`frame:${f}`] = { x: fr.scrollX ?? 0, y: fr.scrollY ?? 0 };
    for (const [name, s] of Object.entries<any>(S)) if (name !== "document") this.sc[name] = { x: s.scrollX ?? 0, y: s.scrollY ?? 0 };
  }

  // ---- the scroll model's geometry (every point in the top page's viewport points)
  private facts(name: string): any { return name === "document" ? this.v.page.scrollers?.document ?? {} : name.startsWith("frame:") ? this.v.page.frames[name.slice(6)] : this.v.page.scrollers[name]; }
  /** The document of a scroller ("document" or "frame:<f>"). */
  docOf(name: string): string { if (name === "document" || name.startsWith("frame:")) return name; const s = this.facts(name); return s.frame ? `frame:${s.frame}` : this.docOf(s.parent ?? "document"); }
  /** The scroller around a scroller, in its document (null for a document). */
  parentOf(name: string): string | null { if (name === "document" || name.startsWith("frame:")) return null; const s = this.facts(name); return s.parent ?? (s.frame ? `frame:${s.frame}` : "document"); }
  /** The scroller of a node's content, and of a frame's element in the top page. */
  nodeScroller(id: string): string { const n = this.v.page.nodes[id]; return n.scroller ?? (n.frame ? `frame:${n.frame}` : "document"); }
  frameScroller(f: string): string { return this.v.page.frames[f].scroller ?? "document"; }
  /** A layout point of a scroller's content in the top page's viewport. */
  toTop(name: string, x: number, y: number): { x: number; y: number } {
    const s = this.sc[name];
    if (name === "document") return { x: x - s.x, y: y - s.y };
    if (name.startsWith("frame:")) { const c = this.frameContent(name.slice(6)); return { x: c.x + x - s.x, y: c.y + y - s.y }; }
    return this.toTop(this.parentOf(name)!, x - s.x, y - s.y);
  }
  /** A frame's content box (its viewport) in the top page. */
  frameContent(f: string): Box { const fr = this.v.page.frames[f], d = (fr.border ?? 0) + (fr.padding ?? 0), o = this.toTop(this.frameScroller(f), fr.box.x + d, fr.box.y + d); return { x: o.x, y: o.y, width: fr.box.width - 2 * d, height: fr.box.height - 2 * d }; }
  frameBox(f: string): Box { const fr = this.v.page.frames[f], o = this.toTop(this.frameScroller(f), fr.box.x, fr.box.y); return { x: o.x, y: o.y, width: fr.box.width, height: fr.box.height }; }
  /** A scroller's client box in the top page. */
  clientBox(name: string): Box {
    if (name === "document") return { x: 0, y: 0, width: this.v.page.viewport.width, height: this.v.page.viewport.height };
    if (name.startsWith("frame:")) return this.frameContent(name.slice(6));
    const b = this.facts(name).box, o = this.toTop(this.parentOf(name)!, b.x, b.y);
    return { x: o.x, y: o.y, width: b.width, height: b.height };
  }
  /** A node's box in the top page, now. */
  liveBox(id: string): Box { const n = this.v.page.nodes[id], o = this.toTop(this.nodeScroller(id), n.box.x, n.box.y); return { x: o.x, y: o.y, width: n.box.width, height: n.box.height }; }
  /** A scroller's range ([x, y]). */
  maxOf(name: string): [number, number] {
    const f = this.facts(name) ?? {}, c = this.clientBox(name);
    return [Math.max(0, (f.width ?? c.width) - c.width), Math.max(0, (f.height ?? c.height) - c.height)];
  }
  /** The scrollers from one up to its document, then (from a frame's document) the frame element's in the top page. */
  chainOf(name: string): string[] {
    const out: string[] = [];
    for (let s: string | null = name; s; s = this.parentOf(s)) out.push(s);
    const d = out[out.length - 1];
    if (d.startsWith("frame:")) out.push(...this.chainOf(this.frameScroller(d.slice(6))));
    return out;
  }
  /** Whether a top point is inside the client box of each scroller of a chain (in one document). */
  private clipped(p: { x: number; y: number }, chain: string[]): boolean { return chain.every((s) => within(p, this.clientBox(s))); }
  /**
   * The element of a document at a top point: a node with `over`, a frame (top page only), the smallest node or element
   * scroller there (inside the client box of each scroller around it), else the document's body. With `into`, the hit
   * goes on inside a frame whose content box holds the point.
   */
  hitIn(doc: string, p: { x: number; y: number }, into = false): { kind: "node" | "scroller" | "frame" | "body"; id: string; doc: string } {
    const V = this.v, inDoc = (s: string) => this.docOf(s) === doc;
    const nodes = Object.keys(V.page.nodes).filter((id) => inDoc(this.nodeScroller(id)) && within(p, this.liveBox(id)) && this.clipped(p, this.chainOf(this.nodeScroller(id)).filter((s) => s !== doc && inDoc(s))));
    const over = nodes.find((id) => V.page.nodes[id].over && !V.page.nodes[id].frame);
    if (over) return { kind: "node", id: over, doc };
    if (doc === "document") for (const f of Object.keys(V.page.frames ?? {})) {
      if (!within(p, this.frameBox(f)) || !this.clipped(p, this.chainOf(this.frameScroller(f)).filter((s) => s !== "document"))) continue;
      if (into && within(p, this.frameContent(f))) return this.hitIn(`frame:${f}`, p, true);
      return { kind: "frame", id: f, doc };
    }
    const scs = Object.keys(V.page.scrollers ?? {}).filter((s) => s !== "document" && inDoc(s) && this.clipped(p, this.chainOf(s).filter((x) => x !== doc && inDoc(x))));
    const area = (b: Box) => b.width * b.height;
    const all: [string, "node" | "scroller", number][] = [...nodes.map((id) => [id, "node", area(this.liveBox(id))] as [string, "node", number]), ...scs.map((s) => [s, "scroller", area(this.clientBox(s))] as [string, "scroller", number])];
    all.sort((a, b) => a[2] - b[2]);
    return all.length ? { kind: all[0][1], id: all[0][0], doc } : { kind: "body", id: "body", doc };
  }
  /** The scrollers of a hit, innermost first, in its document and then its frame's owner's. */
  private hitChain(h: { kind: string; id: string; doc: string }): string[] {
    if (h.kind === "node") return this.chainOf(this.nodeScroller(h.id));
    if (h.kind === "scroller") return this.chainOf(h.id);
    return this.chainOf(h.doc);
  }
  /** Chrome's wheel event at a top point: the first scroller on the way that can move in its direction moves. */
  private wheel(p: any): void {
    const h = this.hitIn("document", p, true), chain = this.hitChain(h);
    let moved: string | null = null;
    for (const [d, axis] of [[Number(p.deltaY ?? 0), "y"], [Number(p.deltaX ?? 0), "x"]] as const) {
      if (!d) continue;
      for (const s of chain) {
        const f = this.facts(s) ?? {};
        if (f.stops) break;
        const m = this.maxOf(s)[axis === "x" ? 0 : 1], at = this.sc[s][axis];
        if ((d > 0 && at >= m) || (d < 0 && at <= 0)) continue;
        const step = Math.min(Math.abs(d), f.step ?? Infinity) * Math.sign(d);
        this.sc[s][axis] = Math.max(0, Math.min(m, at + step));
        moved = s;
        break;
      }
    }
    this.wheels.push({ t: this.clock.now(), x: p.x, y: p.y, dx: Number(p.deltaX ?? 0), dy: Number(p.deltaY ?? 0), at: h.id, moved });
  }
  /** SCROLL_STATE: a node's (or, with an owner's handle, a frame owner's) scrollers, in the points of the read's own top (a cross-origin frame's viewport on its session). */
  private scrollState(objectId: string, child: string | undefined): any {
    const V = this.v, own = objectId.startsWith("own:");
    const f = own ? Object.keys(V.page.frames)[Number(objectId.slice(4)) - 900] : V.page.nodes[objectId]?.frame;
    if (!own && !V.page.nodes[objectId]) throw new Error("Could not find object with given id");
    const n = own ? null : V.page.nodes[objectId];
    if (n?.hidden) return { result: { type: "object", value: { none: true } } };
    const cross = !own && !!f && V.page.frames[f].origin === "cross" && !!child;
    const start = own ? this.frameScroller(f) : this.nodeScroller(objectId);
    let chain = this.chainOf(start);
    if (cross) chain = chain.slice(0, chain.indexOf(`frame:${f}`) + 1);
    const o = cross ? this.frameContent(f) : { x: 0, y: 0 };
    const lb = own ? this.frameBox(f) : this.liveBox(objectId), a = (i: number) => this.lastArgs?.[i];
    // The client's rect (DOM.scrollIntoViewIfNeeded's, relative to the node's border box): that part of the node.
    const b = typeof a(0) === "number" ? { x: lb.x + a(0), y: lb.y + a(1), width: a(2), height: a(3) } : lb;
    this.marks.set(objectId, chain);
    const rect = (x: Box) => [x.x - o.x, x.y - o.y, x.x - o.x + x.width, x.y - o.y + x.height];
    const levels = chain.map((s) => ({ r: rect(this.clientBox(s)), s: [this.sc[s].x, this.sc[s].y], m: this.maxOf(s), doc: s === "document" || s.startsWith("frame:") }));
    return { result: { type: "object", value: { t: rect(b), levels, top: !cross, flat: true, ox: cross ? 0 : 0, oy: 0 } } };
  }
  /** WHEEL_POINTS: rules 1 and 3 of the wheel point at each point (in the reader's points), for the reader's scroller k. */
  private wheelPoints(objectId: string, child: string | undefined, k: number, pts: [number, number][]): any {
    const V = this.v, chain = this.marks.get(objectId), m = chain?.[k];
    if (!m) return { result: { type: "object", value: null } };
    const f = objectId.startsWith("own:") ? null : V.page.nodes[objectId]?.frame;
    const cross = !!f && V.page.frames[f].origin === "cross" && !!child, o = cross ? this.frameContent(f) : { x: 0, y: 0 };
    const doc = this.docOf(m), BAD = ["input", "select", "textarea", "canvas", "embed", "object", "video", "audio", "iframe", "frame"];
    const els: string[] = [], pass: { i: number; chain: number[] }[] = [];
    for (let i = 0; i < pts.length && pass.length < 4; i++) {
      const p = { x: pts[i][0] + o.x, y: pts[i][1] + o.y };
      // The frame levels above the scroller's document: the element there is the frame's (a cross-origin reader checks its own document only).
      if (doc !== "document" && !cross) { const top = this.hitIn("document", p); if (top.kind !== "frame" || `frame:${top.id}` !== doc) continue; }
      const h = this.hitIn(doc, p);
      if (h.kind === "frame") continue;
      const node = h.kind === "node" ? V.page.nodes[h.id] : null;
      if (node && (BAD.includes(node.tag) || node.contenteditable)) continue;
      const sch = this.hitChain(h).filter((s) => this.docOf(s) === doc);
      if (sch[0] !== m && !(m === doc && sch[0] === doc)) continue;
      if (sch.slice(0, sch.indexOf(m) + 1).some((s) => BAD.includes(this.facts(s)?.tag))) continue;
      const names = [...(node ? [`node:${h.id}`] : []), ...sch.slice(0, sch.indexOf(m) + 1).filter((s) => s !== doc).map((s) => `sc:${s}`), ...(m === doc ? [`html:${doc}`] : [])];
      pass.push({ i, chain: names.map((x) => { let j = els.indexOf(x); if (j < 0) { j = els.length; els.push(x); } return j; }) });
    }
    this.els.set(objectId, els);
    return { result: { type: "object", value: pass } };
  }
  /** DOMDebugger.getEventListeners of an element of a wheel point's chain: the page's facts (`listener`: nonpassive or passive). */
  private listenersOf(objectId: string): any {
    const name = objectId.slice(3);
    const kind = name.startsWith("html:") ? this.facts(name.slice(5))?.htmlListener : (name.startsWith("node:") ? this.v.page.nodes[name.slice(5)] : name.startsWith("sc:") ? this.facts(name.slice(3)) : null)?.listener;
    const l = kind === "nonpassive" ? [{ passive: false }] : kind === "passive" ? [{ passive: true }] : [];
    return { listeners: l.map((x) => ({ type: "wheel", useCapture: false, once: false, scriptId: "1", lineNumber: 0, columnNumber: 0, ...x })) };
  }
  /** The value of a field (the tests). */
  valueOf(id: string): string | undefined { return this.fields.get(id)?.value; }

  // ---- StagePage
  send(child: string | undefined, method: string, params: Record<string, unknown>): Promise<any> {
    const s: Sent = { t: this.clock.now(), ...(child ? { child } : {}), method, params, read: !method.startsWith("Input.") };
    // A text that the stage sends as the client sent it (the typing rule refused it): the pass of that call.
    if (method === "Input.insertText") { const c = this.v.in.find((x: any) => x.method === method && x.params.text === params.text); if (c) s.pass = c.id; }
    // The Mac's wheel goes as the client sent it, with the stage's timestamp (C11, the scroll and the wheel): the pass of that call.
    if (this.v.platform === "mac" && method === "Input.dispatchMouseEvent" && params.type === "mouseWheel") {
      const { timestamp: _t, ...rest } = params as any;
      const c = this.v.in.find((x: any) => x.method === method && JSON.stringify(x.params) === JSON.stringify(rest));
      if (c) s.pass = c.id;
    }
    this.sent.push(s);
    return this.chrome(s);
  }
  pass(child: string | undefined, method: string, params: any, answer: (body: Body) => void): Promise<void> {
    const id = this.v.in.find((c: any) => c.params === params)?.id;
    const s: Sent = { t: this.clock.now(), ...(child ? { child } : {}), method, params, pass: id };
    this.sent.push(s);
    this.chrome(s).then((r) => { this.stage.saw(this, child, method, params, r); answer({ result: r ?? {} }); }, (e) => answer({ error: this.error(method, e) }));
    return Promise.resolve();
  }
  error(_method: string, e: unknown) { const x = e as any; return { code: typeof x?.code === "number" ? x.code : -32000, message: String(x?.message ?? x) }; }
  async ownRead(fn: string, args: number[]): Promise<unknown> {
    const s: Sent = { t: this.clock.now(), method: "ownRead", params: { fn, args }, read: true };
    this.sent.push(s);
    const h = await this.hook(s);
    if (h !== undefined) return h;
    await this.free();
    if (fn === ELEMENT_KIND) return this.elementAt(args[0], args[1]);
    if (fn === FOCUSED_FIELD) {
      const n = this.focusedId ? this.v.page.nodes[this.focusedId] : null;
      if (n?.frame && this.v.page.frames[n.frame]?.origin === "cross") return { frame: true };
      this.marked = this.focusedId;
      return this.focusRead(this.focusedId);
    }
    if (fn === FIELD_STILL) return this.stillFocused();
    if (fn === SAME_ELEMENT) { const a = this.elementAt(args[0], args[1]), b = this.elementAt(args[2], args[3]); return !!a && a.id === b?.id; }
    throw new Error(`no fake for ${fn.slice(0, 40)}`);
  }
  /** A node of the top page resolved into the stage's own world (a cross-origin frame's owner, by its backendNodeId). */
  async ownNode(backendNodeId: number): Promise<string | null> {
    const s: Sent = { t: this.clock.now(), method: "ownNode", params: { backendNodeId }, read: true };
    this.sent.push(s);
    const h = await this.hook(s);
    if (h !== undefined) return h;
    return `own:${backendNodeId}`;
  }
  /** The activation brings the tab's window forward: a document whose window did not have the focus has it then. */
  windowFocus = false;
  async activate(): Promise<void> { this.activations.push(this.clock.now()); this.windowFocus = true; }
  inGate(fn: () => Promise<void>): void { this.gate = this.gate.then(fn).catch(() => {}); }
  /** A client's call in the tab's gate: the stage's step for a call that it takes, else the call as it is. */
  queue(child: string | undefined, method: string, params: any, answer: (body: Body) => void): void {
    const e = this.stage.arrive(this, child, method, params, answer);
    // As the model: a call that the stage does not take waits for the end of the tab's key run.
    const endRun = e ? null : this.stage.other(this);
    if (endRun) this.gate = this.gate.then(endRun);
    this.gate = this.gate.then(() => (e ? this.stage.step(this, e) : this.pass(child, method, params, answer)));
  }
  point() { return this.modelPoint; }
  /**
   * A navigation of the main frame (a test's own): the old document's dialog is gone, Chrome answers the input events
   * that it kept, and the stage gets Page.frameNavigated with no parent.
   */
  navigate(url = "http://a.localhost/next"): void {
    this.dialogOpen = false; this.dialogSeen = false;
    for (const r of this.held.splice(0)) r();
    this.stage.event(this, undefined, "Page.frameNavigated", { frame: { id: "main", url } });
  }

  /** The typing rule's read of a focused node (FOCUSED_FIELD's value). */
  private focusRead(id: string | null): any {
    const n = id ? this.v.page.nodes[id] : null;
    if (!n) return null;
    const typing = (n.tag === "input" && TEXT_TYPES.includes(n.type ?? "text")) || n.tag === "textarea", fl = this.fields.get(id!);
    return { tag: n.tag, type: n.tag === "input" ? n.type ?? "text" : undefined, editable: !!n.contenteditable, typing, value: typing && fl ? fl.value : null, s: typing && fl && n.type !== "email" && n.type !== "number" ? fl.s : null, e: typing && fl && n.type !== "email" && n.type !== "number" ? fl.e : null };
  }
  /** The marked field still has the focus: it is the focused node, and its document has the focus. */
  private stillFocused(): boolean {
    const n = this.marked ? this.v.page.nodes[this.marked] : null;
    return !!n && this.marked === this.focusedId && (!n.windowAway || (this.windowFocus && !n.windowStaysAway));
  }
  /** Chrome's input into the page's fields: a press on a field focuses it (the caret at its left end, else its end); keys and texts edit the focused field. */
  private input(s: Sent): void {
    const p = s.params, V = this.v;
    if (s.method === "Input.dispatchMouseEvent" && p.type === "mousePressed") {
      const top = (id: string) => this.liveBox(id);
      const hit = Object.entries<any>(V.page.nodes).filter(([id]) => within(p, top(id))).sort(([a], [b]) => top(a).width * top(a).height - top(b).width * top(b).height)[0];
      if (hit && this.fields.has(hit[0])) {
        this.focusedId = hit[0];
        const fl = this.fields.get(hit[0])!, at = p.x - top(hit[0]).x <= 6 ? 0 : fl.value.length;
        fl.s = fl.e = at;
      } else if (hit) this.focusedId = null;
      return;
    }
    const fl = this.focusedId ? this.fields.get(this.focusedId) : undefined, node = this.focusedId ? V.page.nodes[this.focusedId] : null;
    const put = (t: string) => { if (!fl) return; fl.value = fl.value.slice(0, fl.s) + t + fl.value.slice(fl.e); fl.s = fl.e = fl.s + t.length; };
    if (s.method === "Input.insertText") return put(String(p.text));
    if (s.method !== "Input.dispatchKeyEvent") return;
    if (["Shift", "Control", "Alt", "Meta"].includes(p.key)) { if (p.type === "keyUp") this.mods.delete(p.key); else this.mods.add(p.key); return; }
    if (p.type === "keyUp" || !fl) return;
    // The Mac: a key's editing commands act in place of the key.
    if (Array.isArray(p.commands) && p.commands.length) {
      for (const c of p.commands) {
        if (c === "moveToRightEndOfLine" || c === "moveToEndOfDocument") fl.s = fl.e = fl.value.length;
        else if (c === "moveToLeftEndOfLine" || c === "moveToBeginningOfDocument") fl.s = fl.e = 0;
        else if (c === "moveRight") fl.s = fl.e = Math.min(fl.value.length, Math.max(fl.s, fl.e) + (fl.s === fl.e ? 1 : 0));
        else if (c === "moveRightAndModifySelection") fl.e = Math.min(fl.value.length, fl.e + 1);
      }
      return;
    }
    const ctl = this.mods.has("Control") || this.mods.has("Meta");
    if (p.text && !ctl) { if (node?.mask === "digits" && !/^[0-9]$/.test(p.text)) return; return put(String(p.text)); }
    if (p.key === "Delete" || p.key === "Backspace") { if (fl.s !== fl.e) put(""); else if (p.key === "Delete") { fl.value = fl.value.slice(0, fl.s) + fl.value.slice(fl.s + 1); } else if (fl.s > 0) { fl.value = fl.value.slice(0, fl.s - 1) + fl.value.slice(fl.s); fl.s = fl.e = fl.s - 1; } return; }
    if (p.key === "Home" || (p.key === "ArrowUp" && ctl) || (p.key === "ArrowLeft" && this.mods.has("Meta"))) { fl.s = fl.e = 0; return; }
    if (p.key === "End" || (p.key === "ArrowDown" && ctl) || (p.key === "ArrowRight" && this.mods.has("Meta"))) { fl.s = fl.e = fl.value.length; return; }
    if (p.key === "ArrowRight") { if (this.mods.has("Shift")) fl.e = Math.min(fl.value.length, fl.e + 1); else { fl.s = fl.e = Math.min(fl.value.length, Math.max(fl.s, fl.e) + (fl.s === fl.e ? 1 : 0)); } return; }
    if (p.key === "a" && ctl) { fl.s = 0; fl.e = fl.value.length; }
  }
  /** Playwright's script of a passed utility call: fill selects the field's text and focuses it; focusNode focuses the node (with its caret reset). */
  private script(s: Sent): void {
    const u = utilityCall(s.method, s.params);
    if (!u || (u.name !== "fill" && u.name !== "focus")) return;
    const args = (u.args[0] ?? []) as any[], id = args[1]?.handle, n = id ? this.v.page.nodes[id] : null, fl = id ? this.fields.get(id) : undefined;
    if (!n) return;
    if (u.name === "fill") { if (fl) { this.focusedId = id; fl.s = 0; fl.e = fl.value.length; } return; }
    const was = this.focusedId === id;
    this.focusedId = id;
    if (args[2] === true && !was && n.tag === "input" && fl) fl.s = fl.e = 0;
  }

  /** The element of the top page at a point: the smallest node box that holds it (a frame's element is the frame). */
  elementAt(x: number, y: number): any {
    const h = this.hitIn("document", { x, y });
    if (h.kind === "frame") return { id: `frame:${h.id}`, tag: "iframe" };
    if (h.kind === "scroller") return { id: `scroller:${h.id}`, tag: this.facts(h.id).tag ?? "div" };
    if (h.kind === "body") return { id: "body", tag: "body" };
    const n = this.v.page.nodes[h.id];
    if (n.over) return { id: h.id, tag: n.tag };
    return { id: h.id, tag: n.tag, type: n.type, role: n.role, href: !!n.href, usemap: !!n.usemap, editable: !!n.editable };
  }

  /** The index of the out item that a sent event is (the first unused sent event of its method and type). */
  private outIndexOf(s: Sent): number {
    for (const [k, o] of this.v.out.entries() as [number, any][]) {
      if (o.pass || o.method !== s.method || o.type !== s.params?.type || this.eventsDone.has(k)) continue;
      return k;
    }
    return -1;
  }

  /**
   * Chrome's answer. An input event that Chrome got before a dialog opened waits for the dialog's close (its answer comes
   * then); one that it gets while the dialog is open is dropped: answered at once, and the page never gets it (measured
   * by board ab-t30.9, the input design's open point 5).
   */
  private async chrome(s: Sent): Promise<any> {
    const V = this.v, ch = V.chrome ?? {};
    const h = await this.hook(s);
    if (h !== undefined) { s.answered = this.clock.now(); return h; }
    if (this.closed) throw Object.assign(new Error("No target with given id found"), { code: -32602 });
    if (s.method.startsWith("Input.") && (this.dialogOpen || this.dialogSeen)) { s.dropped = true; s.answered = this.clock.now(); return {}; }
    if (s.method.startsWith("Input.")) {
      this.input(s);
      if (s.method === "Input.dispatchMouseEvent" && s.params?.type === "mouseWheel") this.wheel(s.params);
      const k = this.outIndexOf(s);
      if (this.opensDialog(s)) {
        this.dialogOpen = true;
        const notice = () => {
          this.clientEvents.push({ t: this.clock.now(), method: "Page.javascriptDialogOpening" });
          this.stage.event(this, undefined, "Page.javascriptDialogOpening", { type: "alert", message: "x" });
          this.onClientEvent("Page.javascriptDialogOpening");
        };
        if (this.dialogNoticeMs > 0) this.clock.timer(this.dialogNoticeMs, notice); else setImmediate(notice);
      }
      if (k >= 0) {
        this.eventsDone.add(k);
        const key = `out:${k}`;
        for (const [i, ev] of (ch.events ?? []).entries() as [number, any][]) if (ev.at === key && !this.eventsDone.has(1000 + i)) {
          this.eventsDone.add(1000 + i);
          this.clientEvents.push({ t: this.clock.now(), method: ev.method });
          this.stage.event(this, undefined, ev.method, ev.params);
          this.onClientEvent(ev.method);
        }
        if (ch.dialog?.opensAt === key) this.dialogOpen = true;
        const err = ch.errors?.[key];
        if (err && !this.errorsUsed.has(key)) { this.errorsUsed.add(key); throw Object.assign(new Error(err.message), { code: err.code }); }
      }
      if (this.dialogOpen) await new Promise<void>((r) => this.held.push(r));
      const ms = this.busy(s);
      if (ms > 0) this.freeAt = Math.max(this.freeAt, this.clock.now()) + ms;
      await this.free();
      s.answered = this.clock.now();
      return {};
    }
    if (s.method === "Page.handleJavaScriptDialog") {
      s.answered = this.clock.now();
      this.dialogOpen = false; this.dialogSeen = false;
      const held = this.held.splice(0);
      // Chrome answers the dialog's command first, then the input events that it kept, in order, and the close event. With
      // heldAfterCloseMs (review-119 B2 a), the close event comes first and the kept events' answers that much later.
      if (this.heldAfterCloseMs > 0) {
        setImmediate(() => this.stage.event(this, undefined, "Page.javascriptDialogClosed", { result: true, userInput: "" }));
        this.clock.timer(this.heldAfterCloseMs, () => { for (const r of held) r(); });
      } else setImmediate(() => { for (const r of held) r(); this.stage.event(this, undefined, "Page.javascriptDialogClosed", { result: true, userInput: "" }); });
      return {};
    }
    await this.free();
    s.answered = this.clock.now();
    if (s.pass !== undefined) { this.script(s); return ch.results?.[s.pass] ?? {}; }
    const p = s.params as any;
    // The top page's scroll (review-119b R4): the boxes are viewport points; the layout viewport's offset is the scroll.
    const scroll = V.page.scroll ?? { x: 0, y: 0 };
    if (s.method === "Page.getLayoutMetrics" && s.child) return { cssLayoutViewport: { clientWidth: V.page.viewport.width, clientHeight: V.page.viewport.height, pageX: 0, pageY: 0 } };
    if (s.method === "Page.getLayoutMetrics") return { cssLayoutViewport: { clientWidth: V.page.viewport.width, clientHeight: V.page.viewport.height, pageX: scroll.x + this.sc.document.x, pageY: scroll.y + this.sc.document.y } };
    // The scroll's reads (board ab-t30.11).
    if (s.method === "Runtime.callFunctionOn" && p.functionDeclaration === SCROLL_STATE) { this.lastArgs = (p.arguments ?? []).map((x: any) => x?.value); return this.scrollState(p.objectId, s.child); }
    if (s.method === "Runtime.callFunctionOn" && p.functionDeclaration === WHEEL_POINTS) return this.wheelPoints(p.objectId, s.child, p.arguments[0].value, p.arguments[1].value);
    if (s.method === "Runtime.callFunctionOn" && p.functionDeclaration === WHEEL_ELS) return { result: { type: "object", subtype: "array", objectId: `els:${p.objectId}` } };
    if (s.method === "Runtime.getProperties" && String(p.objectId).startsWith("els:")) return { result: (this.els.get(String(p.objectId).slice(4)) ?? []).map((name, i) => ({ name: String(i), value: { type: "object", subtype: "node", objectId: `el:${name}` } })) };
    if (s.method === "DOMDebugger.getEventListeners") return this.listenersOf(String(p.objectId));
    if (s.method === "Runtime.callFunctionOn" && p.functionDeclaration === OWNER_AT) {
      const f = Object.keys(V.page.frames)[Number(String(p.objectId).slice(4)) - 900];
      return { result: { type: "object", value: (p.arguments[0].value as [number, number][]).map(([x, y]) => { const h = this.hitIn("document", { x, y }); return h.kind === "frame" && h.id === f; }) } };
    }
    if (s.method === "Runtime.releaseObjectGroup") return {};
    if (s.method === "Runtime.callFunctionOn" && p.functionDeclaration === NODE_GEO) {
      const n = V.page.nodes[p.objectId];
      if (!n) throw new Error("Could not find object with given id");
      // The node's box in the points of its process's top (a cross-origin frame's viewport), and the offset of its own document there.
      const top = this.liveBox(p.objectId), f = n.frame ? V.page.frames[n.frame] : null, fc = f ? this.frameContent(n.frame) : null;
      const cross = f?.origin === "cross", b = cross ? { ...n.box, x: top.x - fc!.x, y: top.y - fc!.y } : top, ox = cross || !fc ? 0 : fc.x, oy = cross || !fc ? 0 : fc.y;
      return { result: { type: "object", value: { ox, oy, top: !cross, flat: true, box: { x0: b.x, y0: b.y, x1: b.x + b.width, y1: b.y + b.height } } } };
    }
    if (s.method === "Target.getTargetInfo" && s.child) return { targetInfo: { targetId: `F-${Object.keys(V.page.frames).find((k) => V.page.frames[k].origin === "cross")}`, type: "iframe" } };
    if (s.method === "DOM.getFrameOwner") return { backendNodeId: 900 + Object.keys(V.page.frames).indexOf(String(p.frameId).replace(/^F-/, "")) };
    if (s.method === "DOM.getContentQuads" && typeof p.backendNodeId === "number") {
      // A frame owner's quads: its border box (measured: DOM.getContentQuads gives the border box, not the content box).
      const b = this.frameBox(Object.keys(V.page.frames)[p.backendNodeId - 900]);
      return { quads: [[b.x, b.y, b.x + b.width, b.y, b.x + b.width, b.y + b.height, b.x, b.y + b.height]] };
    }
    if (s.method === "DOM.getBoxModel") {
      const c = this.frameContent(Object.keys(V.page.frames)[p.backendNodeId - 900]);
      const x0 = c.x, y0 = c.y, x1 = c.x + c.width, y1 = c.y + c.height;
      return { model: { content: [x0, y0, x1, y0, x1, y1, x0, y1] } };
    }
    if (s.method === "Runtime.callFunctionOn" && [OBSTACLE_FIND, OBSTACLE_BOTH, OBSTACLE_AGAIN, TWO_FRAMES].includes(p.functionDeclaration)) return { result: { type: "object", subtype: "null", value: null } };
    if (s.method === "Runtime.callFunctionOn" && p.functionDeclaration === FIELD_STATE) {
      const n = V.page.nodes[p.objectId];
      if (!n) throw new Error("Could not find object with given id");
      const top = this.liveBox(p.objectId), f = n.frame ? V.page.frames[n.frame] : null, cross = f?.origin === "cross", fc = f ? this.frameContent(n.frame) : null;
      const b = cross ? { ...n.box, x: top.x - fc!.x, y: top.y - fc!.y } : top, ox = cross || !fc ? 0 : fc.x, oy = cross || !fc ? 0 : fc.y, fl = this.fields.get(p.objectId);
      const kind = n.tag === "textarea" ? "textarea" : n.tag === "input" && TEXT_TYPES.includes(n.type ?? "text") ? "input" : n.contenteditable ? "editable" : "other";
      const active = this.focusedId === p.objectId;
      const hasFocus = !n.windowAway || (this.windowFocus && !n.windowStaysAway);
      return { result: { type: "object", value: { kind, type: n.tag === "input" ? n.type ?? "text" : undefined, disabled: !!n.disabled, readOnly: !!n.readOnly, active, focused: active && hasFocus, len: fl ? fl.value.length : n.text ?? 0, s: fl ? fl.s : null, e: fl ? fl.e : null, ox, oy, top: !cross, flat: true,
        box: { x0: b.x, y0: b.y, x1: b.x + b.width, y1: b.y + b.height } } } };
    }
    if (s.method === "Runtime.callFunctionOn" && p.functionDeclaration === FIELD_HIT) {
      const n = V.page.nodes[p.objectId], [x, y] = [p.arguments[0].value, p.arguments[1].value];
      // The point of the field's own document's viewport in the top page (a frame's: from its content box).
      const f = n.frame ? V.page.frames[n.frame] : null, fc = f ? this.frameContent(n.frame) : null, q = fc ? { x: x + fc.x, y: y + fc.y } : { x, y };
      // The element at the point of the field's own document: the smallest node of its document there, inside a frame's viewport.
      const doc = this.docOf(this.nodeScroller(p.objectId)), area = (id: string) => this.liveBox(id).width * this.liveBox(id).height;
      const hits = Object.keys(V.page.nodes).filter((id) => this.docOf(this.nodeScroller(id)) === doc && within(q, this.liveBox(id))).sort((a, b) => area(a) - area(b));
      let ok = hits[0] === p.objectId && (!fc || within(q, fc));
      // A same-origin frame: the element of the top page at the mapped point must be the frame's owner.
      if (ok && f && f.origin !== "cross") ok = this.elementAt(q.x, q.y).id === `frame:${n.frame}`;
      return { result: { type: "boolean", value: ok } };
    }
    if (s.method === "Runtime.callFunctionOn" && p.functionDeclaration === FOCUSED_IN) {
      const n = V.page.nodes[p.objectId], fo = this.focusedId ? V.page.nodes[this.focusedId] : null;
      if (!n || !fo || (fo.frame ?? null) !== (n.frame ?? null)) return { result: { type: "object", value: { away: true } } };
      this.marked = this.focusedId;
      return { result: { type: "object", value: this.focusRead(this.focusedId) } };
    }
    if (s.method === "Runtime.callFunctionOn" && p.functionDeclaration === FIELD_STILL_IN) return { result: { type: "boolean", value: this.stillFocused() } };
    if (s.method === "DOM.getNodeForLocation") {
      // The node at a point of the top page: a node that lies over the others (over: true), else a frame's owner, else the
      // smallest node. Chrome reads a document point (InspectorDOMAgent: DocumentToFrame), so the scroll comes off.
      const el = this.elementAt(p.x - scroll.x - this.sc.document.x, p.y - scroll.y - this.sc.document.y), frames = Object.keys(V.page.frames ?? {});
      const id = String(el.id).startsWith("frame:") ? 900 + frames.indexOf(String(el.id).slice(6)) : 500 + Object.keys(V.page.nodes).indexOf(el.id);
      return { backendNodeId: id, frameId: "main" };
    }
    if (s.method === "Runtime.callFunctionOn" && p.functionDeclaration === CARET_SET) {
      const fl = this.fields.get(p.objectId);
      if (fl) { fl.s = p.arguments[0].value; fl.e = p.arguments[1].value; }
      return { result: { type: "boolean", value: true } };
    }
    if (s.method === "Runtime.releaseObject") return {};
    return {};
  }
}

/**
 * Run a vector's client calls through the stage, with the model's gate of the tab: a call that the stage takes runs as a
 * step of the gate, any other call is sent when it leaves the gate (an ordinary call does not wait for its answer), and a
 * client's Page.handleJavaScriptDialog goes at once, before the gate.
 */
export async function runVector(v: any, o: { seed?: number; hook?: (s: Sent) => any; tab?: (t: FakeTab) => void; maxMs?: number; noAttach?: boolean } = {}) {
  const clock = new FakeClock();
  const seed = o.seed ?? v.seed;
  const tab = new FakeTab({ ...v, seed }, clock);
  const logs: string[] = [];
  const stage = new Stage({ log: (l) => logs.push(l), random: seededRandom(seed * 7919 + 1), platform: v.platform, clock, stamp: clock.stamp });
  tab.stage = stage;
  if (o.hook) tab.hook = o.hook;
  o.tab?.(tab);
  if (!o.noAttach) for (const [name, f] of Object.entries<any>(v.page.frames ?? {})) if (f.origin === "cross") stage.event(tab, undefined, "Target.attachedToTarget", { sessionId: "child", targetInfo: { type: "iframe", targetId: `F-${name}` } });
  const answers: Answer[] = [], arrived = new Map<number, number>();
  const send = (c: any) => {
    arrived.set(c.id, clock.now());
    const child = c.session === "child" ? "child" : undefined;
    const answer = (body: Body) => { assert.ok(!answers.some((a) => a.id === c.id), `${v.id}: one answer for call ${c.id}`); answers.push({ id: c.id, t: clock.now(), body, n: tab.sent.length }); onAnswer(c.id); };
    if (c.method === "Page.handleJavaScriptDialog") { void tab.pass(child, c.method, c.params, answer); return; }
    tab.queue(child, c.method, c.params, answer);
  };
  const later = (c: any) => (c.waitMs ? clock.timer(c.waitMs, () => send(c)) : send(c));
  const onAnswer = (id: number) => { for (const c of v.in) if (c.after === id) later(c); };
  tab.onClientEvent = (method) => { for (const c of v.in) if (c.afterEvent === method) later(c); };
  // The calls of one time arrive in one tick, as Playwright's Promise.all sends a click's move, press and release.
  const byTime = new Map<number, any[]>();
  for (const c of v.in) if (c.at !== undefined) byTime.set(c.at, [...(byTime.get(c.at) ?? []), c]);
  for (const [at, cs] of byTime) clock.timer(at, () => { for (const c of cs) later(c); });
  // Every call answered, and no planned event left (an early-answered release goes after its answer).
  const planned = () => stage.state(tab.id)?.planned ?? 0;
  await clock.run(() => (answers.length === v.in.length && clock.t > 0 || answers.length === v.in.length && v.in.length === 0) && planned() === 0, o.maxMs ?? 120_000);
  await idle();
  return { clock, tab, stage, answers, arrived, logs };
}
