// Fakes of the input stage's tests (board ab-t30.9): a fake clock, a fake tab (the stage's host, StagePage) with a fake
// Chrome that answers from a vector's page facts (test/vectors/stage.json), the model's gate for one tab (a promise
// chain, with a client's Page.handleJavaScriptDialog before it), and a client that sends the vector's calls at their
// times. No browser and no timer of the system: every time is the fake clock's.

import assert from "node:assert/strict";
import { drawPerson, paramsFor, type Person } from "../src/human/person.ts";
import { seededRandom } from "../src/human/random.ts";
import { ELEMENT_KIND, NODE_GEO, OBSTACLE_AGAIN, OBSTACLE_BOTH, OBSTACLE_FIND, SAME_ELEMENT, Stage, TWO_FRAMES, type Body, type StageClock, type StagePage } from "../src/relay/stage.ts";

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

export type Sent = { t: number; child?: string; method: string; params: any; pass?: number; read?: boolean; answered?: number };
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
  private dialogOpen = false;
  private held: (() => void)[] = [];
  private errorsUsed = new Set<string>();
  private eventsDone = new Set<number>();
  constructor(v: any, clock: FakeClock, o: { id?: number; person?: Person } = {}) {
    this.v = v; this.clock = clock; this.id = o.id ?? 7;
    this.person = o.person ?? drawPerson(paramsFor(v.platform === "mac" ? "darwin" : "linux"), seededRandom(v.seed));
    this.modelPoint = v.page.last ? { ...v.page.last, x11: false } : null;
  }

  // ---- StagePage
  send(child: string | undefined, method: string, params: Record<string, unknown>): Promise<any> {
    const s: Sent = { t: this.clock.now(), ...(child ? { child } : {}), method, params, read: !method.startsWith("Input.") };
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
    if (fn === ELEMENT_KIND) return this.elementAt(args[0], args[1]);
    if (fn === SAME_ELEMENT) { const a = this.elementAt(args[0], args[1]), b = this.elementAt(args[2], args[3]); return !!a && a.id === b?.id; }
    throw new Error(`no fake for ${fn.slice(0, 40)}`);
  }
  async activate(): Promise<void> { this.activations.push(this.clock.now()); }
  point() { return this.modelPoint; }

  /** The element of the top page at a point: the smallest node box that holds it (a frame's element is the frame). */
  elementAt(x: number, y: number): any {
    const p = { x, y };
    for (const [name, f] of Object.entries<any>(this.v.page.frames ?? {})) if (within(p, f.box)) return { id: `frame:${name}`, tag: "iframe" };
    const hits = Object.entries<any>(this.v.page.nodes).filter(([, n]) => !n.frame && within(p, n.box)).sort(([, a], [, b]) => a.box.width * a.box.height - b.box.width * b.box.height);
    if (!hits.length) return { id: "body", tag: "body" };
    const [id, n] = hits[0];
    return { id, tag: n.tag, type: n.type, role: n.role, href: !!n.href, usemap: !!n.usemap, editable: !!n.editable };
  }

  /** The index of the out item that a sent event is (the first unused sent event of its method and type). */
  private outIndexOf(s: Sent): number {
    for (const [k, o] of this.v.out.entries() as [number, any][]) {
      if (o.pass || o.method !== s.method || o.type !== s.params?.type || this.eventsDone.has(k)) continue;
      return k;
    }
    return -1;
  }

  /** Chrome's answer. While a dialog is open, Chrome answers no input event; after the close it answers them in order. */
  private async chrome(s: Sent): Promise<any> {
    const V = this.v, ch = V.chrome ?? {};
    const h = await this.hook(s);
    if (h !== undefined) { s.answered = this.clock.now(); return h; }
    if (s.method.startsWith("Input.")) {
      const k = this.outIndexOf(s);
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
      s.answered = this.clock.now();
      return {};
    }
    if (s.method === "Page.handleJavaScriptDialog") {
      s.answered = this.clock.now();
      if (this.dialogOpen) {
        this.dialogOpen = false;
        const held = this.held.splice(0);
        // Chrome answers the dialog's command first, then the input events that it kept, in order.
        setImmediate(() => { for (const r of held) r(); });
      }
      return {};
    }
    s.answered = this.clock.now();
    if (s.pass !== undefined) return ch.results?.[s.pass] ?? {};
    const p = s.params as any;
    if (s.method === "Page.getLayoutMetrics") return { cssLayoutViewport: { clientWidth: V.page.viewport.width, clientHeight: V.page.viewport.height, pageX: 0, pageY: 0 } };
    if (s.method === "Runtime.callFunctionOn" && p.functionDeclaration === NODE_GEO) {
      const n = V.page.nodes[p.objectId];
      if (!n) throw new Error("Could not find object with given id");
      const top = topBox(V, p.objectId)!, f = n.frame ? V.page.frames[n.frame] : null;
      const cross = f?.origin === "cross", b = cross ? n.box : top, ox = cross ? 0 : top.x - n.box.x, oy = cross ? 0 : top.y - n.box.y;
      return { result: { type: "object", value: { ox, oy, top: !cross, flat: true, box: { x0: b.x, y0: b.y, x1: b.x + b.width, y1: b.y + b.height } } } };
    }
    if (s.method === "DOM.getFrameOwner") return { backendNodeId: 900 + Object.keys(V.page.frames).indexOf(String(p.frameId).replace(/^F-/, "")) };
    if (s.method === "DOM.getBoxModel") {
      const name = Object.keys(V.page.frames)[p.backendNodeId - 900], f = V.page.frames[name], d = (f.border ?? 0) + (f.padding ?? 0);
      const x0 = f.box.x + d, y0 = f.box.y + d, x1 = f.box.x + f.box.width - d, y1 = f.box.y + f.box.height - d;
      return { model: { content: [x0, y0, x1, y0, x1, y1, x0, y1] } };
    }
    if (s.method === "Runtime.callFunctionOn" && [OBSTACLE_FIND, OBSTACLE_BOTH, OBSTACLE_AGAIN, TWO_FRAMES].includes(p.functionDeclaration)) return { result: { type: "object", subtype: "null", value: null } };
    if (s.method === "Runtime.releaseObject") return {};
    return {};
  }
}

/**
 * Run a vector's client calls through the stage, with the model's gate of the tab: a call that the stage takes runs as a
 * step of the gate, any other call is sent when it leaves the gate (an ordinary call does not wait for its answer), and a
 * client's Page.handleJavaScriptDialog goes at once, before the gate.
 */
export async function runVector(v: any, o: { seed?: number; hook?: (s: Sent) => any; tab?: (t: FakeTab) => void; maxMs?: number } = {}) {
  const clock = new FakeClock();
  const seed = o.seed ?? v.seed;
  const tab = new FakeTab({ ...v, seed }, clock);
  const logs: string[] = [];
  const stage = new Stage({ log: (l) => logs.push(l), random: seededRandom(seed * 7919 + 1), platform: v.platform, clock, stamp: clock.stamp });
  tab.stage = stage;
  if (o.hook) tab.hook = o.hook;
  o.tab?.(tab);
  for (const [name, f] of Object.entries<any>(v.page.frames ?? {})) if (f.origin === "cross") stage.event(tab, undefined, "Target.attachedToTarget", { sessionId: "child", targetInfo: { type: "iframe", targetId: `F-${name}` } });
  const answers: Answer[] = [], arrived = new Map<number, number>();
  let gate: Promise<void> = Promise.resolve();
  const send = (c: any) => {
    arrived.set(c.id, clock.now());
    const child = c.session === "child" ? "child" : undefined;
    const answer = (body: Body) => { assert.ok(!answers.some((a) => a.id === c.id), `${v.id}: one answer for call ${c.id}`); answers.push({ id: c.id, t: clock.now(), body, n: tab.sent.length }); onAnswer(c.id); };
    if (c.method === "Page.handleJavaScriptDialog") { void tab.pass(child, c.method, c.params, answer); return; }
    const e = stage.arrive(tab, child, c.method, c.params, answer);
    if (e) gate = gate.then(() => stage.step(tab, e));
    else gate = gate.then(() => tab.pass(child, c.method, c.params, answer));
  };
  const later = (c: any) => (c.waitMs ? clock.timer(c.waitMs, () => send(c)) : send(c));
  const onAnswer = (id: number) => { for (const c of v.in) if (c.after === id) later(c); };
  tab.onClientEvent = (method) => { for (const c of v.in) if (c.afterEvent === method) later(c); };
  for (const c of v.in) if (c.at !== undefined) clock.timer(c.at, () => later(c));
  await clock.run(() => answers.length === v.in.length && clock.t > 0 || answers.length === v.in.length && v.in.length === 0, o.maxMs ?? 120_000);
  await idle();
  return { clock, tab, stage, answers, arrived, logs };
}
