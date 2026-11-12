// The page-side read texts of the input stage's scroll and wheel (board ab-t30.11; review-122 note 2 and review-122b R1
// to R4 and R7): each text runs here as the page runs it, in a context of its own (node:vm), on a small model of a DOM:
// documents (standards mode or quirks mode), windows, elements with boxes, scroll positions and styles, open shadow roots
// and slots. The unit tests of the stage run the fake's model of these texts (stage-fakes.ts); these tests run the texts.

import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { SCROLL_STATE, WHEEL_COLUMN, WHEEL_POINTS, WHEEL_ROOTS, WHEEL_ROOTS_AT } from "../src/relay/stage.ts";

type Box = { x: number; y: number; w: number; h: number };

/** A window: its viewport, its scroll, and the computed style of an element (its `css`, with CSS's defaults). */
class Win {
  scrollX = 0; scrollY = 0; frameElement: El | null = null;
  top: Win = this; parent: Win = this;
  document!: Doc;
  getComputedStyle(e: El) {
    const c = e.css, o = c.overflow ?? "visible";
    return { overflowX: c.overflowX ?? o, overflowY: c.overflowY ?? o, position: c.position ?? "static", borderLeftWidth: "0px", borderTopWidth: "0px", paddingLeft: "0px", paddingTop: "0px",
      scrollPaddingLeft: "auto", scrollPaddingTop: "auto", scrollPaddingRight: "auto", scrollPaddingBottom: "auto", scrollMarginLeft: "0px", scrollMarginTop: "0px", scrollMarginRight: "0px", scrollMarginBottom: "0px" };
  }
}
/** A shadow root: its host, its children, and the element at a point that a test gives it. */
class Root {
  nodeType = 11; children: El[] = []; activeElement: El | null = null; at: ((x: number, y: number) => El | null) | null = null;
  readonly host: El;
  constructor(host: El) { this.host = host; }
  append(...c: El[]) { for (const e of c) { e.parentNode = this; e.ownerDocument = this.host.ownerDocument; this.children.push(e); } return this; }
  querySelectorAll(_s: string) { return descendants(this); }
  elementFromPoint(x: number, y: number) { return this.at ? this.at(x, y) : null; }
}
/** An element: its box in its document's points (with no scroll), its scroll, its scroll size, its style. */
class El {
  nodeType = 1; children: El[] = []; parentNode: El | Root | Doc | null = null; shadowRoot: Root | null = null; assignedSlot: El | null = null;
  assigned: El[] = []; scrollTop = 0; scrollLeft = 0; sw: number | null = null; sh: number | null = null; isContentEditable = false; ownerDocument!: Doc;
  contentDocument: Doc | null = null;
  readonly localName: string; box: Box; css: Record<string, string>;
  constructor(localName: string, box: Box = { x: 0, y: 0, w: 0, h: 0 }, css: Record<string, string> = {}) { this.localName = localName; this.box = box; this.css = css; }
  get parentElement(): El | null { return this.parentNode instanceof El ? this.parentNode : null; }
  get isConnected() { return true; }
  get clientLeft() { return 0; }
  get clientTop() { return 0; }
  getClientRects() { return [this.getBoundingClientRect()]; }
  get clientWidth() { return this.box.w; }
  get clientHeight() { return this.box.h; }
  get scrollWidth() { return this.sw ?? this.box.w; }
  get scrollHeight() { return this.sh ?? this.box.h; }
  append(...c: El[]) { for (const e of c) { e.parentNode = this; e.ownerDocument = this.ownerDocument; this.children.push(e); } return this; }
  attachShadow() { return (this.shadowRoot = new Root(this)); }
  querySelectorAll(_s: string) { return descendants(this); }
  contains(x: El) { for (let p: any = x; p; p = p.parentNode) if (p === this) return true; return false; }
  assignedElements(_o?: unknown) { return this.assigned; }
  /** The box less the scroll of the window and of each element scroller above it in the flat tree. */
  getBoundingClientRect() {
    let dx = 0, dy = 0;
    for (let p = up(this); p; p = up(p)) if (p !== this.ownerDocument.body && p !== this.ownerDocument.documentElement) { dx += p.scrollLeft; dy += p.scrollTop; }
    const w = this.ownerDocument.defaultView, b = this.box, x = b.x - dx - w.scrollX, y = b.y - dy - w.scrollY;
    return { left: x, top: y, right: x + b.w, bottom: y + b.h, width: b.w, height: b.h };
  }
}
const up = (n: El): El | null => n.assignedSlot || n.parentElement || (n.parentNode instanceof Root ? n.parentNode.host : null);
function descendants(n: { children: El[] }): El[] { const out: El[] = []; const walk = (m: { children: El[] }) => { for (const c of m.children) { out.push(c); walk(c); } }; walk(n); return out; }
/** A document with its html and body: standards mode (the html's box is the viewport) or quirks mode (the body's is). */
class Doc {
  nodeType = 9; documentElement: El; body: El; defaultView: Win; activeElement: El | null = null; at: ((x: number, y: number) => El | null) | null = null;
  readonly compatMode: "CSS1Compat" | "BackCompat";
  constructor(compatMode: "CSS1Compat" | "BackCompat", page: { w: number; h: number }, view = { w: 1280, h: 720 }) {
    this.compatMode = compatMode;
    this.defaultView = new Win(); this.defaultView.document = this;
    this.documentElement = new El("html", compatMode === "BackCompat" ? { x: 0, y: 0, w: page.w, h: page.h } : { x: 0, y: 0, ...view });
    this.documentElement.ownerDocument = this; this.documentElement.parentNode = this;
    this.body = new El("body", compatMode === "BackCompat" ? { x: 0, y: 0, ...view } : { x: 0, y: 0, w: page.w, h: page.h });
    this.documentElement.append(this.body);
    // The scroll size of the page: on the scrolling element (the body in quirks mode, else the html).
    const se = this.scrollingElement; se.sw = page.w; se.sh = page.h;
  }
  get scrollingElement() { return this.compatMode === "BackCompat" ? this.body : this.documentElement; }
  elementFromPoint(x: number, y: number) { return this.at ? this.at(x, y) : this.body; }
}
/** A text, run in a context of its own whose global holds `document` (the page's world); its value as plain data. */
function run(doc: Doc, text: string, args: unknown[], ctx: Record<string, unknown> = {}): any {
  const c = vm.createContext(Object.assign(ctx, { document: doc }));
  const fn = vm.runInContext(`(${text})`, c);
  return { ctx: c, value: JSON.parse(JSON.stringify(fn(...args))) };
}
/** A function text run on a node (`this`), in a context whose global is `ctx`. */
function runOn(node: unknown, text: string, args: unknown[], ctx: Record<string, unknown>): any {
  const c = vm.isContext(ctx) ? ctx : vm.createContext(ctx);
  return JSON.parse(JSON.stringify(vm.runInContext(`(${text})`, c).apply(node, args)));
}

/** A page 4,000 px tall with a paragraph under the point 640,360 and a canvas 540 px below it. */
function canvasPage(mode: "CSS1Compat" | "BackCompat") {
  const doc = new Doc(mode, { w: 1280, h: 4000 }), p = new El("p", { x: 0, y: 340, w: 1280, h: 40 }), cv = new El("canvas", { x: 600, y: 900, w: 100, h: 100 });
  doc.body.append(p, cv);
  doc.at = (x, y) => (y >= 340 && y < 380 ? p : doc.body);
  return { doc, p, cv };
}

// ================================================================ mouse.wheel's column (WHEEL_COLUMN)

test("WHEEL_COLUMN: the page's range in quirks mode comes from the body's client box, as SCROLL_STATE reads it (review-122b R1): a canvas 540 px below the point stops the notches at 4 in both modes", () => {
  for (const mode of ["CSS1Compat", "BackCompat"] as const) {
    const { doc } = canvasPage(mode);
    const r = run(doc, WHEEL_COLUMN, [640, 360, 12, 0, 120, 0]).value;
    assert.deepEqual(r.k, [0, 4], `${mode}: 4 notches`);
    assert.deepEqual(r.left, [0, 3280], `${mode}: the page's range left (4,000 less the viewport's 720)`);
  }
});

test("WHEEL_COLUMN: a shadow root's scroller around a slot moves the slotted content: the column reads the elements assigned to the slot (review-122b R2), and rule 2 gets them as roots", () => {
  const doc = new Doc("CSS1Compat", { w: 1280, h: 720 });
  const host = new El("x-scroll", { x: 1130, y: 100, w: 140, h: 300 }), sh = host.attachShadow();
  const sc = new El("div", { x: 1130, y: 100, w: 140, h: 300 }, { overflow: "auto" }), slot = new El("slot", { x: 1130, y: 100, w: 140, h: 1500 });
  sc.sh = 1500; sh.append(sc); sc.append(slot);
  const content = new El("div", { x: 1130, y: 100, w: 140, h: 1500 }), cv = new El("canvas", { x: 1140, y: 600, w: 100, h: 100 });
  doc.body.append(host); host.append(content); content.append(cv);
  content.assignedSlot = slot; slot.assigned = [content];
  doc.at = () => host; sh.at = () => content;
  const { ctx, value } = run(doc, WHEEL_COLUMN, [1200, 200, 12, 0, 120, 0]);
  assert.deepEqual(value.k, [0, 3], "the canvas 400 px below the point: 3 notches");
  assert.equal(runOn(undefined, WHEEL_ROOTS_AT, [32], ctx), 2, "the scroller and the slotted content");
});

test("WHEEL_COLUMN's read after an end of the plan (review-122b R3): a new element under the point whose chain up to the same scroller passes rule 1 (another paragraph) is the same wheel point; an input under the point, or another scroller, is not", () => {
  const doc = new Doc("CSS1Compat", { w: 1280, h: 4000 }), p1 = new El("p", { x: 0, y: 340, w: 1280, h: 40 }), p2 = new El("p", { x: 0, y: 580, w: 1280, h: 40 }), inp = new El("input", { x: 0, y: 580, w: 1280, h: 40 });
  doc.body.append(p1, p2);
  doc.at = () => p1;
  const { ctx } = run(doc, WHEEL_COLUMN, [640, 360, 5, 0, 120, 0]);
  doc.defaultView.scrollY = 240; doc.at = () => p2;
  assert.equal(runOn(undefined, WHEEL_COLUMN, [640, 360, 3, 0, 120, 1], ctx).same, true, "another paragraph");
  doc.body.append(inp); doc.at = () => inp;
  assert.equal(runOn(undefined, WHEEL_COLUMN, [640, 360, 3, 0, 120, 1], ctx).same, false, "an input");
  doc.at = () => p1;
  assert.equal(runOn(undefined, WHEEL_COLUMN, [640, 360, 3, 0, 120, 1], ctx).same, true, "the first element");
});

// ================================================================ the wheel point (WHEEL_POINTS, WHEEL_ROOTS)

test("WHEEL_POINTS: the target's own column counts the target itself only (review-122b R4): a frame around the target at a level above it, and a cross-origin frame's owner, do not count", () => {
  const top = new Doc("CSS1Compat", { w: 1280, h: 4000 }), frame = new El("iframe", { x: 300, y: 400, w: 700, h: 800 });
  top.body.append(frame);
  const inner = new Doc("CSS1Compat", { w: 700, h: 3000 }, { w: 700, h: 800 }), btn = new El("button", { x: 50, y: 2000, w: 100, h: 40 });
  inner.body.append(btn); inner.defaultView.frameElement = frame; inner.defaultView.top = top.defaultView; inner.defaultView.parent = top.defaultView;
  // The round on the top page (level 1 of the read): the frame is the element around the target there.
  const S = { el: btn, marks: [inner, top], depth: [0, 1], wins: [inner.defaultView, top.defaultView], fes: [frame], cum: [[300, 400], [0, 0]], owner: false };
  const pass = runOn(btn, WHEEL_POINTS, [1, [[640, 100]], [0, 600]], { __agentBrowserStageScroll: S, document: top });
  assert.deepEqual(pass, [0], "the frame at a level above: the point passes");
  // A cross-origin frame's owner read in the relay's own world (SCROLL_STATE with owner, then WHEEL_POINTS on the owner).
  const oc = vm.createContext({ document: top });
  const st = runOn(frame, SCROLL_STATE, [null, null, null, null, false, true], oc);
  assert.ok(st && st.levels.length === 1 && st.levels[0].doc, "the owner's read: the top page's level");
  assert.deepEqual(runOn(frame, WHEEL_POINTS, [0, [[640, 100]], [0, 600]], oc), [0], "the owner: the point passes");
  // The target itself counts when it is a canvas (the control).
  const page = new Doc("CSS1Compat", { w: 1280, h: 4000 }), cv = new El("canvas", { x: 600, y: 900, w: 100, h: 100 });
  page.body.append(cv);
  const C = { el: cv, marks: [page], depth: [0], wins: [page.defaultView], fes: [], cum: [[0, 0]], owner: false };
  assert.deepEqual(runOn(cv, WHEEL_POINTS, [0, [[640, 100], [200, 100]], [0, 900]], { __agentBrowserStageScroll: C, document: page }), [1], "a canvas target: the point whose column meets it fails");
});

test("WHEEL_POINTS: rule 4's column reads the content that a slot of a shadow root's scroller holds (review-122b R2)", () => {
  const doc = new Doc("CSS1Compat", { w: 1280, h: 720 });
  const host = new El("x-scroll", { x: 1130, y: 100, w: 140, h: 300 }), sh = host.attachShadow();
  const sc = new El("div", { x: 1130, y: 100, w: 140, h: 300 }, { overflow: "auto" }), slot = new El("slot", { x: 1130, y: 100, w: 140, h: 1500 });
  sc.sh = 1500; sh.append(sc); sc.append(slot);
  const content = new El("div", { x: 1130, y: 100, w: 140, h: 1500 }), cv = new El("canvas", { x: 1140, y: 600, w: 100, h: 100 }), btn = new El("button", { x: 1140, y: 1300, w: 110, h: 40 });
  doc.body.append(host); host.append(content); content.append(cv, btn);
  content.assignedSlot = slot; slot.assigned = [content];
  doc.at = () => host; sh.at = () => content;
  const S = { el: btn, marks: [sc, doc], depth: [0, 0], wins: [doc.defaultView], fes: [], cum: [[0, 0]], owner: false };
  const ctx = vm.createContext({ __agentBrowserStageScroll: S, document: doc });
  assert.deepEqual(runOn(btn, WHEEL_POINTS, [0, [[1200, 200], [1150, 200]], [0, 1000]], ctx), [], "each point's column meets the slotted canvas");
  assert.equal(runOn(btn, WHEEL_ROOTS, [0, 32], ctx), 2, "rule 2: the scroller and the slotted content");
});

test("WHEEL_ROOTS: the roots after the first WHEEL_ROOTS_MAX (32) stay out of rule 2's read (review-122b R7)", () => {
  const doc = new Doc("CSS1Compat", { w: 1280, h: 4000 });
  for (let i = 0; i < 40; i++) { const h = new El("x-c", { x: 0, y: 100 * i, w: 10, h: 10 }); h.attachShadow().append(new El("canvas", { x: 0, y: 100 * i, w: 10, h: 10 })); doc.body.append(h); }
  const S = { el: doc.body, marks: [doc], depth: [0], wins: [doc.defaultView], fes: [], cum: [[0, 0]], owner: false };
  assert.equal(runOn(doc.body, WHEEL_ROOTS, [0, 32], { __agentBrowserStageScroll: S, document: doc }), 32);
  assert.equal(runOn(doc.body, WHEEL_ROOTS, [0, 64], { __agentBrowserStageScroll: S, document: doc }), 41, "the html and the 40 shadow roots");
});
