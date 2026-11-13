// The input stage's pointer part (board ab-t30.9; the input design's sections 4 to 6 and build task 5; C11 "The input
// stage", with test/vectors/stage.json). The vectors of the pointer rows run through the stage with a fake Chrome and a
// fake clock (stage-fakes.ts) for several seeds: the events out, their times and fields, and the order and times of the
// answers. Then a test for each rule that the vectors do not show: the timestamps and the rate, the in-flight bound, the
// lock, the dialog rules and the limits, the error of an event, the recovery and the way around, the frame mapping, the
// press point's hit test, the catch-up's merge and the activation before a path.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { paramsFor } from "../src/human/person.ts";
import {
  crosses, decodeArg, OBSTACLE_AGAIN, OBSTACLE_BOTH, OBSTACLE_FIND, RECOGNIZERS, recognize, Stage, STAGE_ACTION_MAX_MS, STAGE_BUILD_ON, STAGE_EVENT_WAIT_MS,
  STAGE_LATENCY_MS, STAGE_MOVE_MS, STAGE_MOVES_IN_FLIGHT, STAGE_NOTCH_PX, STAGE_SCROLL_ROUNDS, CLIPBOARD_HOLD_MS, STAGE_FLUSH_MS, STAGE_TEST_ENV, STAGE_TYPE_MAX_MS, stageOn,
  TWO_FRAMES, utilityCall, KEPT_MAX,
} from "../src/relay/stage.ts";
import { GEOMETRY_WAIT_MS } from "../src/relay/pointer.ts";
import { seededRandom } from "../src/human/random.ts";
import { charKey, SHIFT } from "../src/human/keys.ts";
import { FakeClock, FakeTab, runVector, topBox, type Sent } from "./stage-fakes.ts";

const V = JSON.parse(readFileSync(new URL("./vectors/stage.json", import.meta.url), "utf8"));
const F = V.firstValues, K = V.constants;
const vec = (id: string) => structuredClone(V.vectors.find((x: any) => x.id === id));

/** The vectors of the pointer part (board ab-t30.9), of the keys and the text (board ab-t30.10), of the scroll and the wheel (board ab-t30.11), and those of the later part (board ab-t30.12). */
const POINTER = ["click", "dblclick", "dblclick-button", "triple-click", "right-click", "click-delay", "click-modifiers", "hover-modifiers", "click-position",
  "click-trial", "move-steps", "hover", "move", "move-same-point", "down-up", "mouse-click", "check", "frame-click", "frame-hover", "tap", "rule-gate",
  "rule-dialog-at-press", "rule-event-error"];
const KEYS = ["type", "press-sequentially", "type-delay", "type-long", "press-chord", "fill", "fill-line-feed", "fill-long", "fill-long-mac", "fill-paste-refused", "clear", "insert-text", "focus-field", "focus-button"];
const SCROLL = ["wheel", "wheel-residual", "wheel-mac", "wheel-column", "scroll-into-view", "scroll-into-view-mac", "scroll-wheel-point", "scroll-no-move", "scroll-frame", "focus-field-below-fold"];
const LATER: Record<string, string[]> = {
  "ab-t30.12 (the script calls)": ["mouse-drag", "fill-date", "select-option", "set-files-paths", "set-files-payloads", "drag-to", "drop", "blur", "select-text", "dispatch-event"],
};

const isRange = (x: unknown): x is [number, number] => Array.isArray(x) && x.length === 2;
const fits = (v: number, want: unknown) => (isRange(want) ? v >= want[0] - 1e-9 && v <= want[1] + 1e-9 : v === want);
/** The hit test of a pixel: the right and the bottom edges of a box are outside it. */
const inBox = (p: { x: number; y: number }, b: { x: number; y: number; width: number; height: number }) => p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;

/** Check a run of a vector against its `out` and `answers` (the vectors' format). */
function check(v: any, run: Awaited<ReturnType<typeof runVector>>, seed: number) {
  const w = `${v.id} (seed ${seed})`;
  const { tab, answers, arrived } = run;
  const sent = tab.sent.filter((s) => !s.read);
  const items: { first: number; last: number }[] = [];
  let i = 0;
  const fromT = (ref: string) => ref === "start" ? 0 : ref.startsWith("in:") ? arrived.get(Number(ref.slice(3)))! : items[Number(ref.slice(4))].last;
  for (const [k, o] of v.out.entries() as [number, any][]) {
    const at = `${w} out:${k}`;
    const s = sent[i];
    assert.ok(s, `${at}: an event (${o.pass ? `the pass of ${o.for}` : `${o.method} ${o.type}`}); sent ${sent.length}: ${sent.map((x) => x.pass ?? x.params?.type).join(",")}`);
    if (o.pass) {
      assert.equal(s.pass, o.for, `${at}: the pass of call ${o.for}`);
      assert.equal(s.child === "child", o.session === "child", `${at}: its session`);
      items[k] = { first: s.t, last: s.t };
      i++;
    } else if (o.typing !== undefined) {
      // Typed keys: a keyDown with its text and a keyUp for each character, a Shift rawKeyDown before each shifted one and
      // its keyUp after that character's, each hold in holdMs.
      let j = i;
      while (j < sent.length && sent[j].pass === undefined && sent[j].method === "Input.dispatchKeyEvent") j++;
      const run = sent.slice(i, j), downs = run.filter((x) => x.params.type === "keyDown");
      assert.equal(downs.map((x) => x.params.text).join(""), o.typing, `${at}: the text as typed keys`);
      for (const d of downs) {
        const shifted = !!(charKey(d.params.text)!.modifiers & SHIFT), q = run.indexOf(d);
        const up = run.slice(q + 1).find((x) => x.params.type === "keyUp" && x.params.code === d.params.code)!;
        assert.ok(up && up.t - d.t >= o.holdMs[0] && up.t - d.t <= o.holdMs[1], `${at}: the hold of ${d.params.text}: ${up ? up.t - d.t : "no keyUp"} ms`);
        assert.equal(!!(d.params.modifiers & SHIFT), shifted, `${at}: ${d.params.text} with modifiers ${d.params.modifiers}`);
        if (shifted) {
          const sd = run.slice(0, q).reverse().find((x) => x.params.key === "Shift");
          const su = run.slice(run.indexOf(up) + 1).find((x) => x.params.key === "Shift" && x.params.type === "keyUp");
          assert.ok(sd?.params.type === "rawKeyDown" && su, `${at}: a Shift press before ${d.params.text} and its release after ${d.params.text}'s`);
        }
      }
      assert.deepEqual([...new Set(downs.filter((d) => charKey(d.params.text)!.modifiers & SHIFT).map((d) => d.params.text))], o.shift, `${at}: the shifted characters`);
      items[k] = { first: run[0].t, last: run[run.length - 1].t };
      i = j;
    } else if (o.notches !== undefined) {
      // Wheel notches: that many mouseWheel events, each with the item's fields, gapMs apart, on the top page's session.
      const runOf = sent.slice(i, i + o.notches);
      assert.equal(runOf.length, o.notches, `${at}: ${o.notches} notches`);
      for (const [q, x] of runOf.entries()) {
        assert.ok(x.pass === undefined && x.method === o.method && x.params.type === o.type && !x.child, `${at}: notch ${q} is a mouseWheel of the top page (${x.method} ${x.params?.type})`);
        for (const [f, want] of Object.entries(o.fields ?? {})) assert.ok(fits(x.params[f], want), `${at}: notch ${q}: ${f} ${x.params[f]}, not ${JSON.stringify(want)}`);
        if (q > 0) assert.ok(fits(x.t - runOf[q - 1].t, o.gapMs), `${at}: a gap of ${x.t - runOf[q - 1].t} ms, not in ${o.gapMs}`);
      }
      items[k] = { first: runOf[0].t, last: runOf[runOf.length - 1].t };
      i += o.notches;
    } else if (o.path || o.line) {
      // The run ends at another event, or at the next item's first event when that item is a run of its own from a later call.
      const next = v.out[k + 1], nextAt = next && (next.path || next.line) && String(next.from).startsWith("in:") ? arrived.get(Number(next.from.slice(3)))! : Infinity;
      let j = i;
      while (j < sent.length && sent[j].pass === undefined && sent[j].method === o.method && sent[j].params.type === o.type && (j === i || sent[j].t <= nextAt)) j++;
      const runOf = sent.slice(i, j);
      assert.ok(runOf.length >= o.count[0] && runOf.length <= o.count[1], `${at}: ${runOf.length} moves, not in ${o.count}`);
      for (let q = 1; q < runOf.length; q++) {
        const gap = runOf[q].t - runOf[q - 1].t;
        assert.ok(gap >= o.gapMs && gap % o.gapMs === 0, `${at}: a gap of ${gap} ms (one move each ${o.gapMs} ms)`);
      }
      const first = runOf[0], last = runOf[runOf.length - 1], d = last.t - first.t;
      if (!o.path?.part) assert.ok(d + o.gapMs >= o.durMs[0] && d <= o.durMs[1], `${at}: ${d} ms from the first move to the last, not in ${o.durMs}`);
      for (const q of runOf) {
        for (const [f, want] of Object.entries(o.fields ?? {})) assert.ok(fits(q.params[f], want), `${at}: ${f} ${q.params[f]}, not ${JSON.stringify(want)}`);
        if (v.platform === "linux") assert.ok(Number.isInteger(q.params.x) && Number.isInteger(q.params.y), `${at}: whole px`);
      }
      const g = o.path ?? o.line;
      if (g.part !== "outside") assert.ok(fits(last.params.x, g.to.x) && fits(last.params.y, g.to.y), `${at}: it ends at ${JSON.stringify(g.to)}, not ${last.params.x},${last.params.y}`);
      if (!g.part || g.part === "outside") assert.ok(Math.hypot(first.params.x - g.from.x, first.params.y - g.from.y) <= F.maxSpeedPxPerMs * 2 * o.gapMs + 2, `${at}: it starts one step from ${JSON.stringify(g.from)}`);
      if (g.part === "outside" || g.part === "inside") {
        const box = topBox(v, g.box)!;
        if (g.part === "outside") assert.ok(runOf.every((q) => !inBox(q.params, box)), `${at}: every sample outside the target before the setup`);
        else assert.ok(inBox(first.params, box), `${at}: the first sample after the setup is inside the target`);
      }
      items[k] = { first: first.t, last: last.t };
      i = j;
    } else {
      assert.equal(s.method, o.method, `${at}: ${o.method}`);
      assert.equal(s.params.type, o.type, `${at}: ${o.type}`);
      for (const [f, want] of Object.entries(o.fields ?? {})) {
        if (f === "data") { assert.deepEqual(s.params.data, want, `${at}: data`); continue; }
        assert.ok(fits(s.params[f], want), `${at}: ${f} ${s.params[f]}, not ${JSON.stringify(want)}`);
      }
      items[k] = { first: s.t, last: s.t };
      i++;
    }
    // The time of the item's first event from its reference.
    const t0 = fromT(o.from), dt = items[k].first - t0;
    assert.ok(dt >= o.at[0] && dt <= o.at[1], `${at}: ${dt} ms after ${o.from}, not in ${o.at}`);
  }
  assert.equal(i, sent.length, `${w}: no event after the vector's last (${sent.slice(i).map((x) => `${x.method} ${x.params?.type ?? x.pass}`).join(", ")})`);
  for (const s of sent.filter((x) => x.method.startsWith("Input.") && x.method !== "Input.insertText" && x.pass === undefined)) {
    const ts = s.params.timestamp * 1000, sendAt = run.clock.epoch + s.t;
    assert.ok(typeof s.params.timestamp === "number", `${w}: every event has a timestamp`);
    if (v.platform === "linux") assert.ok(Math.abs(ts - Math.round(ts)) < 1e-6, `${w}: a timestamp in whole ms on Linux`);
    assert.ok(sendAt - ts >= K.STAGE_LATENCY_MS[0] - 0.5 && sendAt - ts <= K.STAGE_LATENCY_MS[1] + 0.5, `${w}: the timestamp ${sendAt - ts} ms before the send`);
  }
  // The answers: in the vector's order, each after its item's events, with its result or error.
  const order = answers.map((a) => a.id);
  assert.deepEqual(order, v.answers.map((a: any) => a.id), `${w}: the order of the answers`);
  const errorOf = (id: number) => answers.find((a) => a.id === id)!.body.error;
  for (const want of v.answers) {
    const got = answers.find((a) => a.id === want.id)!;
    if (want.after === "none") {
      if (want.result) assert.deepEqual(got.body.result, want.result, `${w} answer ${want.id}: the stage's own result`);
    } else if (want.mayBeEarly) assert.ok(items[Number(want.after.slice(4))], `${w} answer ${want.id}: its event ${want.after} went (before or after the answer: the early answer)`);
    else assert.ok(got.t >= items[Number(want.after.slice(4))].last, `${w} answer ${want.id}: after ${want.after}`);
    if (want.error === "chrome") assert.deepEqual(got.body.error, { code: v.chrome.errors[want.after].code, message: v.chrome.errors[want.after].message }, `${w} answer ${want.id}: Chrome's error`);
    else if (want.error === "the same") assert.deepEqual(got.body.error, errorOf(v.answers.find((x: any) => x.error === "chrome").id), `${w} answer ${want.id}: the same error`);
    else assert.ok(!got.body.error, `${w} answer ${want.id}: no error (${JSON.stringify(got.body.error)})`);
    if (want.waits !== undefined) assert.ok(got.t >= answers.find((a) => a.id === want.waits)!.t, `${w} answer ${want.id}: after the answer of ${want.waits}`);
    if (want.after !== "none" && want.result) assert.deepEqual(got.body.result, want.result, `${w} answer ${want.id}: its result`);
    if (want.from !== undefined) { const dt = got.t - fromT(want.from); assert.ok(dt >= want.at[0] && dt <= want.at[1], `${w} answer ${want.id}: ${dt} ms after ${want.from}, not in ${want.at}`); }
  }
}

// ================================================================ the vectors of the pointer rows

test("the vectors: each one is a built part's or a later part's, and the stage runs every vector of the pointer rows, of the key and text rows, and of the scroll and wheel rows", () => {
  const all = V.vectors.map((x: any) => x.id).sort();
  assert.deepEqual([...POINTER, ...KEYS, ...SCROLL, ...Object.values(LATER).flat()].sort(), all, "every vector has its part");
  for (const id of [...POINTER, ...KEYS, ...SCROLL]) assert.ok(V.vectors.some((x: any) => x.id === id), id);
});

for (const id of [...POINTER, ...KEYS, ...SCROLL]) {
  test(`vector ${id}: the stage's events, their times and fields, and the answers (5 seeds)`, async () => {
    const v = vec(id);
    for (const seed of [v.seed, v.seed + 101, v.seed + 202, v.seed + 303, v.seed + 404]) check(v, await runVector(v, { seed }), seed);
  });
}

// ================================================================ the build switch, the constants, the recognizers

test("the build switch: off in the build; the model's option turns it on or off; the relay's variable turns it on only with the value \"test\"", () => {
  assert.equal(STAGE_BUILD_ON, false, "the stage stays off until ab-t30.9 to ab-t30.12 are all merged");
  assert.equal(stageOn(undefined, {}), false);
  assert.equal(stageOn(undefined, { [STAGE_TEST_ENV]: "1" }), false);
  assert.equal(stageOn(undefined, { [STAGE_TEST_ENV]: "on" }), false);
  assert.equal(stageOn(undefined, { [STAGE_TEST_ENV]: "test" }), true);
  assert.equal(stageOn(true, {}), true);
  assert.equal(stageOn(false, { [STAGE_TEST_ENV]: "test" }), false);
  assert.equal(stageOn(), process.env[STAGE_TEST_ENV] === "test", "the default reads the environment");
});

test("the constants are C11's (the vectors' constants), and the person's device holds the rate, the latency and the in-flight bound", () => {
  assert.deepEqual({ STAGE_MOVE_MS, STAGE_LATENCY_MS: [...STAGE_LATENCY_MS], STAGE_EVENT_WAIT_MS, STAGE_MOVES_IN_FLIGHT, STAGE_NOTCH_PX, STAGE_TYPE_MAX_MS, STAGE_ACTION_MAX_MS, STAGE_SCROLL_ROUNDS, CLIPBOARD_HOLD_MS, STAGE_FLUSH_MS }, K);
  for (const p of [paramsFor("linux"), paramsFor("darwin")]) {
    assert.deepEqual([p.device.rateMs, p.device.latencyMs, p.device.movesInFlight], [K.STAGE_MOVE_MS, K.STAGE_LATENCY_MS, K.STAGE_MOVES_IN_FLIGHT]);
    assert.deepEqual([p.path.short.maxPx, (p.path.short.speed as any).uniform, (p.press.modifierAfterMs as any).uniform], [F.shortMovePx, F.shortSpeedPxPerMs, F.modifierAfterMs]);
  }
  assert.equal(GEOMETRY_WAIT_MS, 200);
});

test("the recognizers are C11's table: each pattern matches its Playwright texts of the three versions, and no client's function", () => {
  assert.deepEqual(Object.keys(RECOGNIZERS).sort(), V.recognizers.map((r: any) => r.name).sort());
  for (const r of V.recognizers) {
    assert.equal(RECOGNIZERS[r.name].source, new RegExp(r.pattern).source, `${r.name}: C11's pattern`);
    for (const [ver, t] of Object.entries<string>(r.texts)) assert.equal(recognize(t), r.name, `${r.name} of ${ver}`);
    for (const t of r.notTexts) assert.notEqual(recognize(t), r.name, `${r.name}: not ${t.slice(0, 50)}`);
  }
  // A recognizer that matches a part of the text would match a client's function that only contains the name.
  assert.equal(recognize("([injected, node]) => { injected.setupHitTargetInterceptor(node); return 1; }"), null);
  assert.equal(recognize("(h) => { h.stop(); }"), null);
});

test("the decoder of Playwright's serialized argument reads the captured calls: the node, the action, the hit point, the trial, the stop's handle", () => {
  const setup = vec("click").in.find((c: any) => c.id === 4), stop = vec("click").in.find((c: any) => c.id === 8);
  const u = utilityCall(setup.method, setup.params)!;
  assert.equal(u.name, "hit-target check");
  assert.deepEqual(u.args[0], [{ handle: "7.3.2" }, { handle: "7.3.10" }, { actionType: "mouse", hitPoint: { x: 100, y: 240 }, trial: false }]);
  const s = utilityCall(stop.method, stop.params)!;
  assert.equal(s.name, "the check's stop");
  assert.deepEqual([s.args, s.handles], [[{ handle: "7.3.20" }, undefined], ["7.3.20"]]);
  assert.deepEqual(decodeArg({ o: [{ k: "a", v: { v: "null" } }, { k: "b", v: { a: [1, "x", true, { v: "undefined" }] } }] }, []), { a: null, b: [1, "x", true, undefined] });
  // The probe's first decoder read numbers as {"n": ...}: a number is itself.
  assert.equal(decodeArg({ n: 5 }, []), undefined);
  assert.equal(utilityCall("Runtime.callFunctionOn", { functionDeclaration: "() => 1", arguments: [] }), null, "not a utility call");
  assert.equal(utilityCall("Runtime.evaluate", setup.params), null);
});

// ================================================================ the rules (a fake tab of their own)

/** A small vector of the tests' own: a page, its nodes, and calls. */
function own(calls: any[], page: Partial<any> = {}, chrome: any = {}, extra: Partial<any> = {}) {
  return { id: "own", platform: "linux", seed: 5, clock: 0, page: { viewport: { width: 1280, height: 720 }, last: { x: 900, y: 700 }, nodes: {}, focused: null, ...page }, chrome,
    in: calls.map((c, i) => ({ id: i + 1, ...c })), out: [], answers: [], ...extra };
}
const mouse = (type: string, x: number, y: number, extra: object = {}) => ({ method: "Input.dispatchMouseEvent", params: { type, x, y, button: type === "mouseMoved" ? "none" : "left", buttons: type === "mousePressed" ? 1 : 0, modifiers: 0, ...(type === "mouseMoved" ? {} : { clickCount: 1 }), ...(type === "mousePressed" ? { force: 0.5 } : {}), ...extra } });
const moves = (t: FakeTab) => t.sent.filter((s) => s.method === "Input.dispatchMouseEvent" && s.params.type === "mouseMoved");
const events = (t: FakeTab) => t.sent.filter((s) => s.method.startsWith("Input.") && s.pass === undefined);
const setupCall = (node: string, action: string, hit: { x: number; y: number } | null, session?: string) => ({
  method: "Runtime.callFunctionOn", ...(session ? { session } : {}),
  params: { ...structuredClone(vec("click").in[3].params), arguments: [{ objectId: "7.3.1" }, { value: true }, { value: false }, { value: vec("click").in[3].params.arguments[3].value }, { value: 1 },
    { value: { a: [{ h: 0 }, { h: 1 }, { o: [{ k: "actionType", v: action }, { k: "hitPoint", v: hit ? { o: [{ k: "x", v: hit.x }, { k: "y", v: hit.y }] } : { v: "undefined" } }, { k: "trial", v: false }] }] } },
    { objectId: "7.3.2" }, { objectId: node }] },
});
const stopCall = (handle = "7.3.20", session?: string) => ({ method: "Runtime.callFunctionOn", ...(session ? { session } : {}), params: structuredClone(vec("click").in[7].params) as any, _h: handle });

test("the timestamps: whole ms on Linux, the plan's latency of 3 to 5 ms before the send, from the send and never from the plan; with its fraction on the Mac", async () => {
  for (const platform of ["linux", "mac"]) {
    const v = own([{ at: 0, ...mouse("mouseMoved", 300, 200) }], {}, {}, { platform });
    const r = await runVector(v);
    const ms = moves(r.tab);
    assert.ok(ms.length > 10);
    const lat = new Set<number>();
    for (const s of ms) {
      const ts = s.params.timestamp * 1000, before = r.clock.epoch + s.t - ts;
      assert.ok(before >= 3 - 0.5 && before <= 5 + 0.5 && before > 0, `${platform}: ${before} ms before the send (no event from the future)`);
      if (platform === "linux") assert.ok(Number.isInteger(Math.round(ts * 1000) / 1000) && Math.abs(ts - Math.round(ts)) < 1e-6, "whole ms");
      lat.add(Math.round((before) * 1000));
    }
    if (platform === "mac") assert.ok(ms.some((s) => Math.abs(s.params.timestamp * 1000 - Math.round(s.params.timestamp * 1000)) > 1e-6), "the Mac keeps the fraction");
  }
});

test("the rate: the moves of a path go each STAGE_MOVE_MS with no wait for the answer of the move before (a Chrome that answers each move after 30 ms)", async () => {
  const v = own([{ at: 0, ...mouse("mouseMoved", 300, 200) }]);
  const r = await runVector(v, { tab: (t) => { t.hook = (s) => (s.method === "Input.dispatchMouseEvent" ? t.clock.sleep(30).then(() => ({})) : undefined); } });
  const ms = moves(r.tab);
  assert.ok(ms.length > 20, `${ms.length} moves`);
  for (let q = 1; q < ms.length; q++) assert.ok(ms[q].t - ms[q - 1].t < 30, `a move ${ms[q].t - ms[q - 1].t} ms after the one before: not awaited one by one`);
  assert.ok(ms.filter((s, q) => q > 0 && s.t - ms[q - 1].t === STAGE_MOVE_MS).length > ms.length / 2, "mostly one each STAGE_MOVE_MS");
});

test("the in-flight bound: when a move is due while STAGE_MOVES_IN_FLIGHT wait, the path stops, the client's own move goes, and the stage logs it", async () => {
  const v = own([{ at: 0, ...mouse("mouseMoved", 200, 150) }]);
  const r = await runVector(v, { tab: (t) => { t.hook = (s) => (s.method === "Input.dispatchMouseEvent" ? new Promise(() => {}) : undefined); }, maxMs: 30_000 });
  const ms = moves(r.tab);
  assert.equal(ms.length, STAGE_MOVES_IN_FLIGHT + 1, "8 moves of the path, then the client's own move");
  assert.deepEqual([ms.at(-1)!.params.x, ms.at(-1)!.params.y], [200, 150], "the client's own point");
  assert.equal(r.stage.counts.inFlightStops, 1);
  assert.ok(r.logs.some((l) => /stopped at 8 moves without an answer/.test(l)), "logged");
  assert.ok(!r.logs.some((l) => /\b(200|150)\b/.test(l)), "no point in a log line");
  assert.equal(r.stage.counts.waitEnds, 1, "then STAGE_EVENT_WAIT_MS ends the plan");
  assert.equal(r.stage.lock.held, 0, "the lock is free");
});

/** Two tabs of one stage, each with its own fake Chrome, and their calls in the client's order. */
async function twoTabs(callsA: any[], callsB: any[]) {
  const clock = new FakeClock();
  const logs: string[] = [];
  const stage = new Stage({ log: (l) => logs.push(l), random: seededRandom(3), platform: "linux", clock, stamp: clock.stamp });
  const mk = (id: number, calls: any[]) => {
    const v = own(calls);
    const t = new FakeTab(v, clock, { id });
    t.stage = stage;
    const answers: { id: number; t: number }[] = [];
    for (const c of v.in) clock.timer(c.at ?? 0, () => t.queue(undefined, c.method, c.params, () => answers.push({ id: c.id, t: clock.now() })));
    return { t, v, answers };
  };
  const A = mk(1, callsA), B = mk(2, callsB);
  await clock.run(() => A.answers.length === A.v.in.length && B.answers.length === B.v.in.length);
  return { A, B, stage, clock, logs };
}

test("the input lock: two tabs' actions never interleave; the second waits for the first's release, in the order of arrival, and each activation comes before its action's first event", async () => {
  const click = (x: number, y: number, at: number) => [{ at, ...mouse("mouseMoved", x, y) }, { at, ...mouse("mousePressed", x, y) }, { at, ...mouse("mouseReleased", x, y) }];
  const { A, B, stage } = await twoTabs(click(100, 100, 0), click(500, 400, 1));
  const ea = events(A.t), eb = events(B.t);
  assert.ok(ea.length > 10 && eb.length > 10);
  assert.ok(eb[0].t > ea.at(-1)!.t, `B's first event (${eb[0].t}) after A's last (${ea.at(-1)!.t})`);
  assert.equal(A.t.activations.length, 1); assert.equal(B.t.activations.length, 1);
  assert.ok(A.t.activations[0] <= ea[0].t && B.t.activations[0] >= ea.at(-1)!.t && B.t.activations[0] <= eb[0].t, "the activation after the lock and before the first event");
  assert.equal(stage.lock.held, 0);
});

test("the gate's order: a held answer comes after its events; the press is answered after the pause and the press, the release after the hold", async () => {
  const r = await runVector(vec("rule-gate"));
  const ev = events(r.tab), press = ev.find((s) => s.params.type === "mousePressed")!, rel = ev.find((s) => s.params.type === "mouseReleased")!;
  const a = (id: number) => r.answers.find((x) => x.id === id)!.t;
  assert.ok(a(1) >= moves(r.tab).at(-1)!.t && a(1) <= press.t, "the move's answer after its last move, before the press");
  assert.ok(a(2) >= press.t && a(2) <= rel.t && a(3) >= rel.t, "the press's and the release's answers after their events");
  assert.ok(rel.t - press.t >= F.holdMs[0] && rel.t - press.t <= F.holdMs[1], "a person's hold");
  const evaluate = r.tab.sent.find((s) => s.pass === 4)!;
  assert.ok(evaluate.t >= rel.t, "the Runtime.evaluate after the click goes after the release");
});

test("a dialog between two moves of a path (a mouseover handler opens an alert): the plan ends; no event while the dialog is open; the client's move, press and release go at once after its close; the lock is free at once; no event of the plan after the client's later call", async () => {
  const calls = [{ at: 0, ...mouse("mouseMoved", 300, 200) }, { at: 0, ...mouse("mousePressed", 300, 200) }, { at: 0, ...mouse("mouseReleased", 300, 200) },
    { afterEvent: "Page.javascriptDialogOpening", waitMs: 20_000, method: "Page.handleJavaScriptDialog", params: { accept: true } },
    { after: 4, method: "Runtime.evaluate", params: { expression: "1" } }];
  const v = own(calls);
  let n = 0;
  const r = await runVector(v, { tab: (t) => {
    t.hook = (s) => {
      if (s.method === "Input.dispatchMouseEvent" && s.params.type === "mouseMoved" && ++n === 5) {
        t.clientEvents.push({ t: t.clock.now(), method: "Page.javascriptDialogOpening" });
        t.stage.event(t, undefined, "Page.javascriptDialogOpening", { type: "alert", message: "x" });
        setImmediate(() => { t.dialogSeen = true; }); // Chrome got this move before the dialog opened
        t.onClientEvent("Page.javascriptDialogOpening");
      }
      return undefined;
    };
  } });
  const ev = events(r.tab), opened = r.tab.clientEvents[0].t;
  const after = ev.slice(5);
  assert.equal(ev[4].t, opened, "the dialog opens at the fifth move");
  const dialog = r.tab.sent.find((s) => s.method === "Page.handleJavaScriptDialog")!, later = r.tab.sent.find((s) => s.pass === 5)!;
  assert.ok(dialog.t >= opened + 20_000, "the client answers the dialog after 20 s");
  assert.ok(!ev.some((s) => s.dropped), "no input event while the dialog is open (Chrome would drop it)");
  assert.deepEqual(after.map((s) => s.params.type), ["mouseMoved", "mousePressed", "mouseReleased"], "the client's own three events");
  assert.ok(after.every((s) => s.t - dialog.t >= 0 && s.t - dialog.t <= 1), "at once after the dialog's close");
  assert.deepEqual([after[0].params.x, after[0].params.y], [300, 200], "the move to the client's point");
  assert.equal(r.stage.lock.held, 0, "the lock is free");
  assert.ok(ev.every((s) => r.tab.sent.indexOf(s) < r.tab.sent.indexOf(later)), "no event of the plan after the client's later call (it waits in the gate)");
  assert.equal(r.stage.counts.dialogEnds, 1);
});

test("a dialog at a press that the client answers after 20 s: the lock is free at once; the release waits for the close and goes at once after it; each input call gets Chrome's own answer, never the stage's", async () => {
  const v = vec("rule-dialog-at-press");
  v.in[3].waitMs = 20_000;
  let heldAtClose = -1;
  const r = await runVector(v, { tab: (t) => { t.hook = (s) => { if (s.method === "Page.handleJavaScriptDialog") heldAtClose = t.stage.lock.held; return undefined; }; } });
  assert.equal(heldAtClose, 0, "the lock is free while the dialog is open");
  const dialog = r.answers.find((a) => a.id === 4)!;
  for (const id of [2, 3]) assert.ok(r.answers.find((a) => a.id === id)!.t >= dialog.t, `call ${id} answers after the dialog's close (Chrome's answer)`);
  const ev = events(r.tab), rel = ev.find((s) => s.params.type === "mouseReleased")!;
  const close = r.tab.sent.find((s) => s.method === "Page.handleJavaScriptDialog")!.t;
  assert.ok(rel.t >= close && rel.t - close <= 1, `the release at once after the close (${rel.t - close} ms)`);
  assert.ok(!ev.some((s) => s.dropped), "no input event while the dialog is open");
  assert.equal(r.stage.lock.held, 0);
});

test("STAGE_EVENT_WAIT_MS: an event whose answer never comes ends the plan at 2 s: the held button is released, the lock is free, and the client's next call goes", async () => {
  const calls = [{ at: 0, ...mouse("mousePressed", 900, 700) }, { at: 3000, ...mouse("mouseMoved", 950, 700) }, { at: 3000, method: "Runtime.evaluate", params: { expression: "1" } }];
  const v = own(calls);
  const r = await runVector(v, { tab: (t) => { t.hook = (s) => (s.method === "Input.dispatchMouseEvent" && s.params.type === "mousePressed" ? new Promise(() => {}) : undefined); }, maxMs: 10_000 });
  const ev = events(r.tab), press = ev.find((s) => s.params.type === "mousePressed")!, rel = ev.find((s) => s.params.type === "mouseReleased");
  assert.ok(rel, "the stage releases the held button");
  assert.equal(rel!.t - press.t, STAGE_EVENT_WAIT_MS, "at STAGE_EVENT_WAIT_MS");
  assert.equal(r.stage.counts.waitEnds, 1);
  assert.ok(r.tab.sent.some((s) => s.pass === 3), "the client's next call went");
  assert.ok(moves(r.tab).length >= 1, "the next move went");
  assert.equal(r.stage.lock.held, 0);
});

test("a read that never answers fails open at GEOMETRY_WAIT_MS: the hover's mapping read; the setup goes after 200 ms, with no path before it", async () => {
  const v = vec("hover");
  const r = await runVector(v, { hook: (s) => (s.method === "Runtime.callFunctionOn" && s.params.functionDeclaration?.startsWith("function () { let x = 0") ? new Promise(() => {}) : undefined), maxMs: 30_000 });
  const setup = r.tab.sent.find((s) => s.pass === 1)!;
  assert.equal(setup.t, GEOMETRY_WAIT_MS, "the setup at 200 ms");
  assert.ok(moves(r.tab).every((s) => s.t > setup.t), "no move before the setup (the naive way)");
  assert.equal(r.stage.counts.hoverNaive, 1);
  assert.ok(r.stage.counts.readFails >= 1);
});

test("an error of an event: the plan stops, the held key is released first, the refused call gets Chrome's error and each later call of the plan the same error", async () => {
  const v = vec("click-modifiers");
  let n = 0;
  const r = await runVector(v, { hook: (s) => (s.method === "Input.dispatchMouseEvent" && s.params.type === "mouseMoved" && ++n === 4 ? Promise.reject(Object.assign(new Error("Internal error"), { code: -32000 })) : undefined) });
  const ev = events(r.tab);
  const up = ev.filter((s) => s.method === "Input.dispatchKeyEvent" && s.params.type === "keyUp");
  assert.equal(up.length, 1, "the stage releases the held Shift");
  const err = (id: number) => r.answers.find((a) => a.id === id)!.body.error;
  assert.deepEqual(err(3), { code: -32000, message: "Internal error" }, "the move gets Chrome's error");
  assert.deepEqual([err(4), err(5)], [err(3), err(3)], "the press and the release get the same error");
  assert.ok(!ev.some((s) => s.params.type === "mousePressed"), "no press");
  const a3 = r.answers.find((a) => a.id === 3)!;
  assert.ok(r.tab.sent.indexOf(up[0]) < a3.n, "the stage's own release of Shift went before the error's answer");
  assert.deepEqual(r.answers.find((a) => a.id === 6)!.body, { result: {} }, "the client's own Shift release later gets no event");
  assert.equal(r.stage.lock.held, 0);
});

test("a client's release of a button that the stage released at the end of a plan gets no event: the stage answers it at once", async () => {
  const calls = [{ at: 0, ...mouse("mousePressed", 900, 700) }, { at: 5000, ...mouse("mouseReleased", 900, 700) }];
  const r = await runVector(own(calls), { tab: (t) => { t.hook = (s) => (s.method === "Input.dispatchMouseEvent" && s.params.type === "mousePressed" ? new Promise(() => {}) : undefined); }, maxMs: 10_000 });
  const rel = events(r.tab).filter((s) => s.params.type === "mouseReleased");
  assert.equal(rel.length, 1, "one release: the stage's at STAGE_EVENT_WAIT_MS");
  assert.ok(rel[0].t < 5000);
  assert.deepEqual(r.answers.find((a) => a.id === 2)!.body, { result: {} });
  assert.equal(r.stage.counts.releasedAlready, 1);
});

test("STAGE_ACTION_MAX_MS: an action that holds the lock (a button down, no release) frees it at 25 s, and another tab's action goes", async () => {
  const { A, B, stage } = await twoTabs([{ at: 0, ...mouse("mousePressed", 900, 700) }], [{ at: 10, ...mouse("mouseMoved", 500, 400) }]);
  const eb = events(B.t);
  assert.ok(eb.length > 0 && eb[0].t >= STAGE_ACTION_MAX_MS && eb[0].t <= STAGE_ACTION_MAX_MS + 10, `B's first event at ${eb[0]?.t}`);
  assert.equal(stage.counts.limitEnds, 1);
  assert.equal(events(A.t).filter((s) => s.params.type === "mouseReleased").length, 0, "the limit sends no release of its own");
});

test("the catch-up's merge: after an X record of the activation, the stage's next path starts at the recorded point; else at the stage's last point", async () => {
  const v = own([{ at: 0, ...mouse("mouseMoved", 300, 200) }, { at: 2000, ...mouse("mouseMoved", 700, 300) }]);
  const r = await runVector(v, { tab: (t) => {
    const act = t.activate.bind(t);
    t.activate = async () => { await act(); if (t.activations.length === 2) t.modelPoint = { x: 1100, y: 100, x11: true }; };
  } });
  const ms = moves(r.tab), second = ms.filter((s) => s.t >= 2000);
  assert.ok(Math.hypot(ms[0].params.x - 900, ms[0].params.y - 700) <= 60, "the first path from the page's last point");
  assert.ok(Math.hypot(second[0].params.x - 1100, second[0].params.y - 100) <= 60, `the second from the X record: ${second[0].params.x},${second[0].params.y}`);
});

test("a page with no last point: the path starts at a random point of the viewport's middle 30% to 70%", async () => {
  const starts = new Set<string>();
  for (let seed = 1; seed <= 12; seed++) {
    const v = own([{ at: 0, ...mouse("mouseMoved", 50, 50) }], { last: null });
    v.seed = seed;
    const r = await runVector(v);
    const f = moves(r.tab)[0];
    assert.ok(f.params.x >= 0.3 * 1280 - 60 && f.params.x <= 0.7 * 1280 + 60 && f.params.y >= 0.3 * 720 - 60 && f.params.y <= 0.7 * 720 + 60, `${f.params.x},${f.params.y}`);
    starts.add(`${f.params.x},${f.params.y}`);
  }
  assert.ok(starts.size >= 10, "no fixed start");
});

test("the press point's hit test: a spread point where the stage's own hit test finds another element: the press is at the client's point", async () => {
  const v = vec("click");
  let reads = 0;
  for (const seed of [11, 12, 13, 14]) {
    const r = await runVector(v, { seed, hook: (s) => (s.method === "ownRead" && /=== document\.elementFromPoint/.test(s.params.fn) ? (reads++, false) : undefined) });
    const press = events(r.tab).find((s) => s.params.type === "mousePressed")!;
    assert.deepEqual([press.params.x, press.params.y], [100, 240], "the client's point");
  }
  assert.equal(reads, 4, "one hit test each");
});

test("the press point's conditions 1 and 3 alone: a locator double click at a button's middle, and a click at a div's middle (with the client's quad), press at the client's point", async () => {
  // Condition 1: the click vector (its quad, a button at its middle) as a double click: no press of the action spreads.
  const d = vec("click");
  const press2 = { ...structuredClone(d.in[5]), id: 8, params: { ...d.in[5].params, clickCount: 2 } }, release2 = { ...structuredClone(d.in[6]), id: 9, params: { ...d.in[6].params, clickCount: 2 } };
  const stop = { ...structuredClone(d.in[7]), id: 10, after: 9 };
  d.in = [...d.in.slice(0, 7), press2, release2, stop];
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const r = await runVector(d, { seed });
    const presses = events(r.tab).filter((s) => s.params.type === "mousePressed");
    assert.equal(presses.length, 2);
    for (const p of presses) assert.deepEqual([p.params.x, p.params.y], [100, 240], `seed ${seed}: a double click presses at the client's point`);
  }
  // Condition 3: the same click on a div (no element whose effect does not depend on the point).
  const c = vec("click");
  c.page.nodes["7.3.10"].tag = "div";
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const r = await runVector(c, { seed });
    const press = events(r.tab).find((s) => s.params.type === "mousePressed")!;
    assert.deepEqual([press.params.x, press.params.y], [100, 240], `seed ${seed}: a div presses at the client's point`);
  }
});

test("the press point's spread: within 1/4 of the smaller side of the middle, with a standard deviation near 1/8 of it", async () => {
  const v = vec("click"), d: number[] = [];
  for (let seed = 1; seed <= 60; seed++) {
    const r = await runVector(v, { seed });
    const p = events(r.tab).find((s) => s.params.type === "mousePressed")!.params;
    d.push(p.x - 100, p.y - 240);
  }
  assert.ok(d.every((x) => Math.abs(x) <= 10), "at most 10 px (1/4 of 40)");
  const sd = Math.sqrt(d.reduce((a, x) => a + x * x, 0) / d.length);
  assert.ok(sd >= 3 && sd <= 6.5, `sd ${sd.toFixed(2)} (1/8 of 40 is 5)`);
  assert.ok(new Set(d).size > 8, "a spread");
});

/** A page of the recovery: a menu whose panel covers the target until the pointer leaves the menu's root. */
function menuRun(o: { always?: boolean } = {}) {
  const v = own([], { nodes: { "7.3.10": { tag: "button", box: { x: 600, y: 300, width: 80, height: 40 }, focused: false } }, last: { x: 640, y: 100 } });
  const root = { x0: 560, y0: 80, x1: 760, y1: 130 }, panel = { x0: 560, y0: 130, x1: 760, y1: 400 };
  let open = true, misses = 0;
  const calls: any[] = [];
  return { v, root, panel, calls, hook(t: FakeTab) {
    return (s: Sent) => {
      const p = s.params as any;
      if (s.method === "Runtime.callFunctionOn" && p.functionDeclaration === OBSTACLE_FIND) return open || o.always ? { result: { type: "object", objectId: "obstacle-1" } } : { result: { type: "object", subtype: "null", value: null } };
      if (s.method === "Runtime.callFunctionOn" && p.functionDeclaration === OBSTACLE_BOTH) return { result: { type: "object", value: { x0: root.x0, y0: root.y0, x1: panel.x1, y1: panel.y1 } } };
      if (s.method === "Runtime.callFunctionOn" && p.functionDeclaration === TWO_FRAMES) return { result: { type: "boolean", value: true } };
      if (s.method === "Runtime.callFunctionOn" && p.functionDeclaration === OBSTACLE_AGAIN) return { result: { type: "object", value: root } };
      if (s.method === "Input.dispatchMouseEvent" && s.params.type === "mouseMoved") {
        const q = s.params, inMenu = q.x >= root.x0 && q.x <= root.x1 && q.y >= root.y0 && q.y <= (open ? panel.y1 : root.y1);
        if (inMenu && q.y <= root.y1) open = true; else if (!inMenu) open = false;
      }
      if (s.pass !== undefined) {
        const c = t.v.in.find((x: any) => x.id === s.pass);
        if (c?.params?.arguments?.[3]?.value?.includes("setupHitTargetInterceptor")) return open || o.always ? (misses++, { result: { type: "string", value: "<div class=panel> intercepts pointer events" } }) : { result: { type: "object", objectId: "7.3.20" } };
      }
      return undefined;
    };
  }, get misses() { return misses; } };
}

test("the miss watch and the recovery: a miss marks the tab; at the next setup the pointer leaves the obstacle (15 px outside, away from the target), two frames pass, and the next path goes around the kept box", async () => {
  const m = menuRun();
  // Attempt 1: the setup misses (the panel is open); attempt 2: the recovery, then the setup passes, then the click.
  const calls = [setupCall("7.3.10", "mouse", { x: 640, y: 320 }), { ...setupCall("7.3.10", "mouse", { x: 640, y: 320 }), after: 1 },
    { after: 2, ...mouse("mouseMoved", 640, 320) }, { after: 2, ...mouse("mousePressed", 640, 320) }, { after: 2, ...mouse("mouseReleased", 640, 320) }];
  m.v.in = calls.map((c, i) => ({ id: i + 1, ...(i === 0 ? { at: 0 } : {}), ...c }));
  const r = await runVector(m.v, { tab: (t) => { t.hook = m.hook(t); } });
  assert.equal(r.stage.counts.setupMisses, 1);
  assert.equal(r.stage.counts.recoveries, 1);
  const exit = moves(r.tab).filter((s) => s.t < r.tab.sent.find((x) => x.pass === 2)!.t).at(-1)!;
  assert.ok(exit.params.x < m.root.x0 - 10 || exit.params.x > m.panel.x1 + 10 || exit.params.y < m.root.y0 - 10, `the exit point ${exit.params.x},${exit.params.y} is outside the boxes`);
  assert.ok(r.tab.sent.some((s) => s.params?.functionDeclaration === TWO_FRAMES), "two frames");
  const click = moves(r.tab).filter((s) => s.t > r.tab.sent.find((x) => x.pass === 2)!.t);
  assert.ok(click.length > 5);
  assert.ok(click.every((s) => !(s.params.x > m.root.x0 && s.params.x < m.root.x1 && s.params.y > m.root.y0 && s.params.y < m.root.y1)), "the path goes around the kept box");
  const press = events(r.tab).find((s) => s.params.type === "mousePressed")!;
  assert.deepEqual([press.params.x, press.params.y], [640, 320]);
  assert.ok(r.logs.some((l) => /a recovery in tab 7/.test(l)));
});

test("the miss watch at the check's stop: a stop whose answer is not \"done\" marks the tab, and the next setup of the node gets the recovery", async () => {
  const m = menuRun();
  // Attempt 1: the setup passes (the panel is closed), the click's press hits the opened panel (the stop's answer is a miss).
  const calls = [setupCall("7.3.10", "mouse", { x: 640, y: 320 }), { after: 1, ...mouse("mouseMoved", 640, 320) }, { after: 1, ...mouse("mousePressed", 640, 320) },
    { after: 1, ...mouse("mouseReleased", 640, 320) }, { ...stopCall(), after: 4 }, { ...setupCall("7.3.10", "mouse", { x: 640, y: 320 }), after: 5 }];
  m.v.in = calls.map((c, i) => ({ id: i + 1, ...(i === 0 ? { at: 0 } : {}), ...c }));
  let first = true;
  const r = await runVector(m.v, { tab: (t) => {
    const h = m.hook(t);
    t.hook = (s) => {
      const p = s.params as any;
      if (s.pass === 1) { first = false; return { result: { type: "object", objectId: "7.3.20" } }; }
      if (s.pass === 5) return { result: { type: "string", value: "<div class=panel> intercepts pointer events" } };
      if (first) return undefined;
      return h(s) ?? (p?.functionDeclaration ? undefined : undefined);
    };
  } });
  assert.equal(r.stage.counts.stopMisses, 1, "the stop's miss marks the tab");
  assert.equal(r.stage.counts.recoveries, 1, "the recovery at the next setup");
});

test("a hold counts from the press's send: Chrome answers the press after 150 ms, and the release goes 60 to 180 ms after the press's send", async () => {
  const r = await runVector(vec("mouse-click"), { tab: (t) => { t.hook = (s) => (s.method === "Input.dispatchMouseEvent" && s.params.type === "mousePressed" ? t.clock.sleep(150).then(() => ({})) : undefined); } });
  const ev = events(r.tab), press = ev.find((s) => s.params.type === "mousePressed")!, rel = ev.find((s) => s.params.type === "mouseReleased")!;
  assert.ok(rel.t - press.t >= Math.max(F.holdMs[0], 150) && rel.t - press.t <= F.holdMs[1], `the release ${rel.t - press.t} ms after the press's send`);
});

test("the way around: a path whose straight way crosses the kept box goes through a corner of the wider box, as two paths, and never enters the box", () => {
  const box = { x0: 400, y0: 200, x1: 600, y1: 260 };
  assert.ok(crosses({ x: 500, y: 100 }, { x: 500, y: 400 }, box));
  assert.ok(!crosses({ x: 300, y: 100 }, { x: 300, y: 400 }, box));
});

test("at most two recoveries in one action: a target that is always covered gets two recoveries, then the rest goes as Playwright sends it, until Playwright's own timeout", async () => {
  const m = menuRun({ always: true });
  const n = 8;
  const calls: any[] = [];
  for (let k = 0; k < n; k++) calls.push({ ...setupCall("7.3.10", "mouse", { x: 640, y: 320 }), ...(k === 0 ? { at: 0 } : { after: k }) });
  m.v.in = calls.map((c, i) => ({ id: i + 1, ...c }));
  const r = await runVector(m.v, { tab: (t) => { t.hook = m.hook(t); } });
  assert.equal(r.stage.counts.recoveries, 2, "two recoveries");
  assert.equal(r.stage.counts.recoveryLimits, 1);
  assert.ok(r.stage.counts.plainAttempts >= 1, "each later attempt goes as Playwright sends it");
  assert.equal(r.stage.state(7)!.plain, false, "the plain mode ends with its attempt (here the setup's own miss)");
  assert.equal(r.answers.length, n, "every setup answered (Playwright retries until its timeout)");
});

test("the frame mapping of a cross-origin frame: the owner on the parent's session (DOM.getFrameOwner) and its content box; the hover's samples outside the mapped box before the setup", async () => {
  const v = vec("frame-hover");
  v.page.frames.inner.origin = "cross";
  v.page.nodes["7.4.10"].mapped = undefined;
  v.in[0].session = "child";
  v.in[2].session = "child";
  const r = await runVector(v);
  const box = topBox(v, "7.4.10")!;
  const setup = r.tab.sent.find((s) => s.pass === 1)!;
  assert.equal(setup.child, "child");
  assert.ok(r.tab.sent.some((s) => s.method === "DOM.getFrameOwner" && !s.child), "the owner on the top page's session");
  const before = moves(r.tab).filter((s) => s.t < setup.t), after = moves(r.tab).filter((s) => s.t > setup.t);
  assert.ok(before.length > 3 && before.every((s) => !inBox(s.params, box)), "the samples outside the box first");
  assert.ok(inBox(after[0].params, box), "the first move after the setup inside the frame's element");
  assert.deepEqual([after.at(-1)!.params.x, after.at(-1)!.params.y], [382, 357], "Playwright's point in the top page");
  assert.equal(r.stage.counts.hoverLastLegs, 1, "the mapped point is Playwright's: the rest of the path goes at its move");
});

test("a cross-origin frame with no attach record of its session: the frame's id from the session's own target info; the mapping holds", async () => {
  const v = vec("frame-hover");
  v.page.frames.inner.origin = "cross";
  v.page.nodes["7.4.10"].mapped = undefined;
  v.in[0].session = "child"; v.in[2].session = "child";
  const r = await runVector(v, { noAttach: true });
  const box = topBox(v, "7.4.10")!, setup = r.tab.sent.find((s) => s.pass === 1)!;
  assert.ok(r.tab.sent.some((s) => s.method === "Target.getTargetInfo" && s.child === "child"));
  const after = moves(r.tab).filter((s) => s.t > setup.t);
  assert.ok(moves(r.tab).filter((s) => s.t < setup.t).length > 3, "the samples outside the box before the setup");
  assert.ok(inBox(after[0].params, box), "the first move after the setup inside the frame's element");
  assert.equal(r.stage.counts.hoverLastLegs, 1, "the mapped point is Playwright's: the rest of the path goes at its move");
});

test("a page with no last point and an X pointer over it (Linux, at an activation): the path starts at the X pointer's place", async () => {
  const v = own([{ at: 0, ...mouse("mouseMoved", 600, 400) }], { last: null });
  const r = await runVector(v, { tab: (t) => { t.xPoint = async () => ({ x: 150.4, y: 620.6 }); } });
  const f = moves(r.tab)[0];
  assert.ok(Math.hypot(f.params.x - 150, f.params.y - 621) <= F.maxSpeedPxPerMs * 2 * 8 + 2, `the first move ${f.params.x},${f.params.y} is one step from the X pointer`);
  assert.equal(r.stage.counts.startsAtXPointer, 1);
});

test("a click with a modifier when the pointer is on the target already (no path): the press comes 40 to 120 ms after the modifier's press", async () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const v = vec("click-modifiers");
    v.page.last = { x: 500, y: 150 };
    const r = await runVector(v, { seed });
    const ev = events(r.tab), down = ev.find((s) => s.method === "Input.dispatchKeyEvent")!, press = ev.find((s) => s.params.type === "mousePressed")!;
    assert.equal(moves(r.tab).length, 0, "no path");
    assert.ok(press.t - down.t >= 40 && press.t - down.t <= 120, `seed ${seed}: ${press.t - down.t} ms after the modifier's press`);
  }
});

test("the hover: a sample on the right or the bottom edge of the target's box is outside it (the hit test of that pixel finds another element)", async () => {
  // Paths that enter #b (60..140 x 220..260) from the right and from below: over many seeds, the first sample after the
  // setup is always inside the pixels of the box, never on its right or bottom edge.
  for (let seed = 1; seed <= 40; seed++) {
    const v = vec("hover");
    v.page.last = seed % 2 ? { x: 900, y: 240 } : { x: 100, y: 700 };
    const r = await runVector(v, { seed });
    const setup = r.tab.sent.find((s) => s.pass === 1)!, first = moves(r.tab).find((s) => s.t > setup.t);
    if (!first) continue;
    assert.ok(first.params.x < 140 && first.params.y < 260 && first.params.x >= 60 && first.params.y >= 220, `seed ${seed}: ${first.params.x},${first.params.y}`);
  }
});

test("the hover: a pointer inside the target already sends the whole path after the setup; a move that does not move sends nothing", async () => {
  const v = vec("hover");
  v.page.last = { x: 70, y: 230 };
  const r = await runVector(v);
  const setup = r.tab.sent.find((s) => s.pass === 1)!;
  assert.ok(moves(r.tab).every((s) => s.t > setup.t), "no move before the setup");
  assert.ok(moves(r.tab).length >= 1);
});

test("the activation before a path (C11, the window comes forward for input): the first move of an action comes after the activation, also the hover's samples before the setup", async () => {
  for (const id of ["move", "hover", "click"]) {
    const r = await runVector(vec(id));
    const first = events(r.tab)[0];
    assert.ok(r.tab.activations.length >= 1 && r.tab.activations[0] <= first.t, `${id}: the activation before the first event`);
  }
});

test("a short move: the client's line at 0.5 to 1.5 px/ms, at the device's rate, within 1 px of the line, ending at the client's point", async () => {
  for (let seed = 1; seed <= 20; seed++) {
    const v = own([{ at: 0, ...mouse("mouseMoved", 930, 680) }]);
    v.seed = seed;
    const r = await runVector(v);
    const ms = moves(r.tab), D = Math.hypot(30, 20), last = ms.at(-1)!;
    assert.deepEqual([last.params.x, last.params.y], [930, 680]);
    const dur = last.t + 0;
    assert.ok(dur >= D / 1.5 - 8 && dur <= D / 0.5 + 8, `${dur} ms for ${D.toFixed(1)} px`);
    for (const s of ms) {
      const u = ((s.params.x - 900) * 30 + (s.params.y - 700) * -20) / (D * D), px = 900 + 30 * u, py = 700 - 20 * u;
      assert.ok(Math.hypot(s.params.x - px, s.params.y - py) <= 1.5, "within the jitter of the line (and the rounding)");
    }
  }
});

test("the stage never answers a call before its events: each answer of an input call comes after Chrome answered its last event", async () => {
  for (const id of ["click", "dblclick", "hover-modifiers", "click-modifiers"]) {
    const r = await runVector(vec(id), { tab: (t) => { t.hook = (s) => (s.method.startsWith("Input.") ? t.clock.sleep(3).then(() => ({})) : undefined); } });
    for (const a of r.answers) {
      const c = vec(id).in.find((x: any) => x.id === a.id);
      if (!c.method.startsWith("Input.")) continue;
      const mine = r.tab.sent.slice(0, a.n).filter((s) => s.method.startsWith("Input."));
      assert.ok(mine.every((s) => s.answered !== undefined && s.answered <= a.t), `${id} ${a.id}: its events answered first`);
    }
  }
});

test("the spread point is decided with the path: a locator click whose press comes later (a click with delay) and a click in a frame press at the client's point", async () => {
  // click({ delay }): Playwright awaits the move before it sends the press, so the stage plans the path with no press in view.
  const v = vec("click");
  v.in[5].after = 5; v.in[6].after = 6; v.in[6].waitMs = 300;
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const r = await runVector(v, { seed });
    const press = events(r.tab).find((s) => s.params.type === "mousePressed")!;
    assert.deepEqual([press.params.x, press.params.y], [100, 240], `seed ${seed}: the client's point`);
  }
  // A button in a cross-origin frame: the setup's hit point is in the frame's own points.
  const f = vec("frame-click");
  f.page.nodes["8.5.10"].tag = "button";
  f.in[0].params.arguments[5].value.a[2].o[1].v.o = [{ k: "x", v: 22 }, { k: "y", v: 32 }];
  for (const seed of [1, 2, 3]) {
    const r = await runVector(f, { seed });
    const press = events(r.tab).find((s) => s.params.type === "mousePressed")!;
    assert.deepEqual([press.params.x, press.params.y], [324, 134], "the client's point in the top page");
  }
});

test("a press away from the page's last point (a client that sent no move there) gets a path there first, then the pause", async () => {
  const r = await runVector(own([{ at: 0, ...mouse("mousePressed", 500, 300) }, { at: 0, ...mouse("mouseReleased", 500, 300) }]));
  const ev = events(r.tab), ms = moves(r.tab), press = ev.find((s) => s.params.type === "mousePressed")!;
  assert.ok(ms.length > 10, "a path first");
  assert.deepEqual([ms.at(-1)!.params.x, ms.at(-1)!.params.y], [500, 300]);
  assert.ok(press.t - ms.at(-1)!.t >= F.pauseMs[0] && press.t - ms.at(-1)!.t <= F.pauseMs[1], "then the pause");
});

test("a hover's action holds the lock from its first sample to its last: another tab's action waits for Playwright's move; with no move in 1 s the rest goes and the lock is free", async () => {
  const hov = vec("hover");
  // Tab A hovers (its move comes 500 ms after the setup's answer); tab B moves at 10 ms.
  const clock = new FakeClock();
  const stage = new Stage({ log: () => {}, random: seededRandom(9), platform: "linux", clock, stamp: clock.stamp });
  const A = new FakeTab(hov, clock, { id: 1 }), B = new FakeTab(own([]), clock, { id: 2 });
  A.stage = stage; B.stage = stage;
  const answers: string[] = [];
  const sendA = (c: any) => A.queue(undefined, c.method, c.params, () => { answers.push(`A${c.id}`); if (c.id === 1) clock.timer(500, () => sendA(hov.in[1])); if (c.id === 2) sendA(hov.in[2]); });
  clock.timer(0, () => sendA(hov.in[0]));
  clock.timer(10, () => { const m = mouse("mouseMoved", 500, 400); B.queue(undefined, m.method, m.params, () => answers.push("B1")); });
  await clock.run(() => answers.length === 4);
  const lastA = moves(A).at(-1)!, firstB = moves(B)[0];
  assert.ok(firstB.t >= lastA.t, `B's first move (${firstB.t}) after A's last (${lastA.t})`);
  // No move: the rest goes after HOVER_WAIT_MS, and the lock is free.
  const v = vec("hover");
  v.in = v.in.filter((c: any) => c.id === 1);
  const r = await runVector(v);
  await r.clock.advance(1500);
  assert.equal(r.stage.lock.held, 0, "the lock is free");
  assert.equal(r.stage.counts.hoverRestsDropped, 1);
});


// ================================================================ review-116, round 1

const DIALOG = { type: "alert", message: "x", url: "http://a.localhost/", hasBrowserHandler: false, defaultPrompt: "" };
/** A dialog that opens at the fifth move of the tab (a mouseover handler): Chrome drops what it gets while the dialog is open. */
function dialogAtFifthMove(t: FakeTab) {
  let n = 0;
  t.hook = (s) => {
    if (s.method === "Input.dispatchMouseEvent" && s.params.type === "mouseMoved" && ++n === 5) {
      t.clientEvents.push({ t: t.clock.now(), method: "Page.javascriptDialogOpening" });
      t.stage.event(t, undefined, "Page.javascriptDialogOpening", DIALOG);
      setImmediate(() => { t.dialogSeen = true; });
    }
    return undefined;
  };
}
/** A vector of its own whose first press opens a dialog (a confirm() in mousedown): Chrome keeps that press until the close. */
function pressOpensDialog(calls: any[], extra: Partial<any> = {}) {
  return own(calls, {}, { events: [{ method: "Page.javascriptDialogOpening", params: DIALOG, at: "out:0" }], dialog: { opensAt: "out:0" } },
    { out: [{ method: "Input.dispatchMouseEvent", type: "mousePressed" }], ...extra });
}

test("review B1 case 1: at the close, the ended plan's events take the lock again after another tab's action, and the activation runs before the ended press", async () => {
  const clock = new FakeClock();
  const stage = new Stage({ log: () => {}, random: seededRandom(4), platform: "linux", clock, stamp: clock.stamp });
  const A = new FakeTab(own([]), clock, { id: 1 }), B = new FakeTab(own([]), clock, { id: 2 });
  A.stage = stage; B.stage = stage;
  dialogAtFifthMove(A);
  const answers: string[] = [];
  const click = (t: FakeTab, x: number, y: number, tag: string) => { for (const c of [mouse("mouseMoved", x, y), mouse("mousePressed", x, y), mouse("mouseReleased", x, y)]) t.queue(undefined, c.method, c.params, () => answers.push(tag)); };
  clock.timer(0, () => click(A, 300, 200, "A"));
  clock.timer(100, () => click(B, 700, 500, "B"));
  clock.timer(250, () => { void A.pass(undefined, "Page.handleJavaScriptDialog", { accept: true }, () => answers.push("A-dialog")); });
  await clock.run(() => answers.length === 7);
  const close = A.sent.find((s) => s.method === "Page.handleJavaScriptDialog")!.t, eb = events(B), aAfter = events(A).filter((s) => s.t >= close && !s.dropped);
  assert.ok(eb[0].t < close && eb.at(-1)!.t > close, "B's action runs at A's close");
  assert.deepEqual(aAfter.map((s) => s.params.type), ["mouseMoved", "mousePressed", "mouseReleased"]);
  assert.ok(aAfter[0].t >= eb.at(-1)!.t, `A's ended events (${aAfter[0].t}) wait for the end of B's action (${eb.at(-1)!.t})`);
  const act = A.activations.filter((t) => t >= close), press = aAfter.find((s) => s.params.type === "mousePressed")!;
  assert.ok(act.length >= 1 && act[0] <= press.t, "the activation before A's ended press");
  assert.equal(stage.lock.held, 0);
});

test("review B1 case 2: mouse.down() whose mousedown opens confirm(), no client call left: the gate opens only after the close and the stage's release; a later call goes after both", async () => {
  const v = pressOpensDialog([{ at: 0, ...mouse("mousePressed", 900, 700) }, { at: 200, method: "Runtime.evaluate", params: { expression: "1" } }, { at: 1000, method: "Page.handleJavaScriptDialog", params: { accept: true } }]);
  const r = await runVector(v, { maxMs: 10_000 });
  const close = r.tab.sent.find((s) => s.method === "Page.handleJavaScriptDialog")!, rel = r.tab.sent.find((s) => s.params?.type === "mouseReleased"), later = r.tab.sent.find((s) => s.pass === 2)!;
  assert.ok(rel, "the stage releases the button that the plan holds");
  assert.ok(r.tab.sent.indexOf(close) < r.tab.sent.indexOf(rel!) && r.tab.sent.indexOf(rel!) < r.tab.sent.indexOf(later), "the close, the release, then the later call");
  assert.ok(!rel!.dropped, "the release went after the close: Chrome did not drop it");
  assert.equal(r.answers.length, 3);
  assert.equal(r.stage.lock.held, 0);
});

test("review B1 case 2, with no step running: a dialog that opens after mouse.down()'s answer (a timer of the page): the end's own step holds the tab's gate until the close and the stage's release; a later call goes after both", async () => {
  const v = own([{ at: 0, ...mouse("mousePressed", 900, 700) }, { at: 600, method: "Runtime.evaluate", params: { expression: "1" } }, { at: 1500, method: "Page.handleJavaScriptDialog", params: { accept: true } }]);
  const r = await runVector(v, { maxMs: 10_000, tab: (t) => { t.clock.timer(300, () => {
    t.clientEvents.push({ t: t.clock.now(), method: "Page.javascriptDialogOpening" });
    t.stage.event(t, undefined, "Page.javascriptDialogOpening", DIALOG);
    t.dialogSeen = true;
  }); } });
  assert.ok(r.answers.find((a) => a.id === 1)!.t < 300, "mouse.down() answered before the dialog: no step runs at its open");
  const close = r.tab.sent.find((s) => s.method === "Page.handleJavaScriptDialog")!, rel = r.tab.sent.find((s) => s.params?.type === "mouseReleased"), later = r.tab.sent.find((s) => s.pass === 2)!;
  assert.ok(rel, "the stage releases the button that the plan holds");
  assert.ok(r.tab.sent.indexOf(close) < r.tab.sent.indexOf(rel!) && r.tab.sent.indexOf(rel!) < r.tab.sent.indexOf(later), "the close, the release, then the later call");
  assert.ok(!rel!.dropped, "the release went after the close: Chrome did not drop it");
  assert.equal(r.answers.length, 3);
  assert.equal(r.stage.lock.held, 0);
});

test("review B3: STAGE_ACTION_MAX_MS frees the lock at once; the tab's ended calls take it again later (every call ends)", async () => {
  const { A, B, stage } = await twoTabs([{ at: 0, ...mouse("mousePressed", 900, 700) }, { at: 26_000, ...mouse("mouseReleased", 900, 700) }], [{ at: 10, ...mouse("mouseMoved", 500, 400) }]);
  const eb = events(B.t);
  assert.ok(eb.length > 0 && eb[0].t >= STAGE_ACTION_MAX_MS && eb[0].t <= STAGE_ACTION_MAX_MS + 10, `B's first event at ${eb[0]?.t}`);
  assert.equal(events(A.t).filter((s) => s.params.type === "mouseReleased").length, 1, "A's own release later, as the client sent it");
  assert.equal(stage.lock.held, 0);
});

test("review B2: after two recoveries the plain mode covers only that attempt: a later mouse call with no setup, and a later action of the node with no miss before it, get the person's input", async () => {
  const m = menuRun({ always: true });
  const calls: any[] = [];
  for (let k = 0; k < 4; k++) calls.push({ ...setupCall("7.3.10", "mouse", { x: 640, y: 320 }), ...(k === 0 ? { at: 0 } : { after: k }) });
  calls.push({ after: 4, ...mouse("mouseMoved", 300, 500) }, { after: 4, ...mouse("mousePressed", 300, 500) }, { after: 4, ...mouse("mouseReleased", 300, 500) });
  // 5 s later, a new action of the same node that passes: its setup (no miss before it in 2 s), its click.
  calls.push({ ...setupCall("7.3.10", "mouse", { x: 640, y: 320 }), after: 7, waitMs: 5000 });
  calls.push({ after: 8, ...mouse("mouseMoved", 640, 320) }, { after: 8, ...mouse("mousePressed", 640, 320) }, { after: 8, ...mouse("mouseReleased", 640, 320) });
  m.v.in = calls.map((c, i) => ({ id: i + 1, ...c }));
  const r = await runVector(m.v, { tab: (t) => {
    const h = m.hook(t);
    t.hook = (s) => (s.pass === 8 ? { result: { type: "object", objectId: "7.3.20" } } : h(s));
  } });
  assert.equal(r.stage.counts.recoveries, 2);
  const arrive = (id: number) => r.arrived.get(id)!;
  const first = moves(r.tab).filter((s) => s.t >= arrive(5) && s.t < arrive(9)), second = moves(r.tab).filter((s) => s.t >= arrive(9));
  assert.ok(first.length > 5, `a path for the mouse call with no setup (${first.length} moves)`);
  assert.ok(second.length > 5, `a path for the later action with no miss (${second.length} moves)`);
});

test("the daemon lead's point: when the tab closes or detaches while the stage holds an ended plan's events, each held client call gets Chrome's error, and the gate opens", async () => {
  const v = pressOpensDialog([{ at: 0, ...mouse("mousePressed", 900, 700) }, { at: 0, ...mouse("mouseReleased", 900, 700) }, { at: 600, method: "Runtime.evaluate", params: { expression: "1" } }]);
  const r = await runVector(v, { maxMs: 10_000, tab: (t) => { t.clock.timer(500, () => { t.closed = true; t.stage.drop(t.id); }); } });
  const rel = r.answers.find((a) => a.id === 2)!, later = r.answers.find((a) => a.id === 3);
  assert.ok(rel.body.error && /No target/.test(rel.body.error.message), `the held release gets Chrome's error: ${JSON.stringify(rel.body)}`);
  assert.ok(later, "the gate opened: the later call went");
  assert.equal(r.stage.lock.held, 0);
});

test("review N1: the dialog's wait ends at each of its signals with no Closed event: the client's Page.disable, a navigation of the main frame, a crash", async () => {
  for (const [method, params] of [["Page.disable", {}], ["Page.frameNavigated", { frame: { id: "main", url: "http://a.localhost/next" } }], ["Inspector.targetCrashed", {}]] as const) {
    const v = pressOpensDialog([{ at: 0, ...mouse("mousePressed", 900, 700) }, { at: 0, ...mouse("mouseReleased", 900, 700) }, { at: 600, method: "Runtime.evaluate", params: { expression: "1" } }]);
    const r = await runVector(v, { maxMs: 10_000, tab: (t) => { t.clock.timer(500, () => t.stage.event(t, undefined, method, params)); } });
    // The press waits for the dialog's close (Chrome keeps it); the fake's dialog stays open, so only the press waits.
    assert.ok([2, 3].every((id) => r.answers.some((a) => a.id === id)), `${method}: the held release and the later call answered`);
    const rel = r.tab.sent.find((s) => s.params?.type === "mouseReleased")!;
    assert.ok(rel && rel.t >= 500 && rel.t <= 501, `${method}: the held release went at the signal (${rel?.t})`);
  }
  // A main frame's navigation also clears the tab's kept quads and handles (N7).
});

test("review N3: the stage's own release of a held button has the clickCount of its press", async () => {
  const r = await runVector(own([{ at: 0, ...mouse("mousePressed", 900, 700, { clickCount: 2 }) }]), { tab: (t) => { t.hook = (s) => (s.params?.type === "mousePressed" ? new Promise(() => {}) : undefined); }, maxMs: 10_000 });
  const rel = events(r.tab).find((s) => s.params.type === "mouseReleased")!;
  assert.equal(rel.params.clickCount, 2);
});

test("review N4: a move to the page's last point takes no lock and runs no activation", async () => {
  const { A, B } = await twoTabs([{ at: 0, ...mouse("mousePressed", 900, 700) }], [{ at: 10, ...mouse("mouseMoved", 900, 700) }]);
  assert.equal(events(B.t).length, 0, "no event");
  assert.equal(B.t.activations.length, 0, "no activation");
  assert.ok(B.answers[0].t <= 11, `answered at once (${B.answers[0].t})`);
  void A;
});

test("a move to the pointer's own point while a hover's rest waits: no event, the rest dropped, the lock free", async () => {
  const v = vec("hover");
  v.in = v.in.filter((c: any) => c.id === 1);
  const r = await runVector(v);
  const n = events(r.tab).length, at = moves(r.tab).at(-1)!.params;
  assert.ok(r.stage.state(r.tab.id)!.action, "the hover's action holds the lock: its rest waits for Playwright's move");
  let body: any;
  r.tab.queue(undefined, "Input.dispatchMouseEvent", mouse("mouseMoved", at.x, at.y).params, (b) => { body = b; });
  await r.clock.run(() => body !== undefined, r.clock.now() + 1000);
  assert.deepEqual(body, { result: {} });
  assert.equal(events(r.tab).length, n, "no event: the pointer is at that point");
  assert.equal(r.stage.counts.sameMoves, 1);
  assert.equal(r.stage.counts.hoverRestsDropped ?? 0, 0, "the move drops the rest: no rest at HOVER_WAIT_MS");
  await r.clock.advance(1500);
  assert.equal(r.stage.lock.held, 0, "the lock is free");
});

test("review N7: the kept quads and handles of a tab are bounded, and a navigation of its main frame clears them", async () => {
  const clock = new FakeClock();
  const stage = new Stage({ log: () => {}, random: seededRandom(4), platform: "linux", clock, stamp: clock.stamp });
  const t = new FakeTab(own([]), clock);
  t.stage = stage;
  for (let i = 0; i < 300; i++) stage.saw(t, undefined, "DOM.getContentQuads", { objectId: `o${i}` }, { quads: [[0, 0, 10, 0, 10, 10, 0, 10]] });
  assert.ok(stage.state(t.id)!.quads <= 64, `${stage.state(t.id)!.quads} quads kept`);
  stage.event(t, undefined, "Page.frameNavigated", { frame: { id: "main", url: "http://a.localhost/next" } });
  assert.equal(stage.state(t.id)!.quads, 0);
  assert.equal(stage.state(t.id)!.handles, 0);
});

test("review N8: an error of a hover's own sample stops the plan as an error of an event does (no more samples, the lock free); the setup goes as the client sent it", async () => {
  let n = 0;
  const r = await runVector(vec("hover"), { hook: (s) => (s.method === "Input.dispatchMouseEvent" && s.params.type === "mouseMoved" && ++n === 3 ? Promise.reject(Object.assign(new Error("Internal error"), { code: -32000 })) : undefined) });
  const setup = r.tab.sent.find((s) => s.pass === 1)!;
  assert.equal(moves(r.tab).filter((s) => s.t <= setup.t).length, 3, "no sample after the refused one");
  assert.equal(r.stage.counts.eventErrors, 1);
  assert.equal(r.answers.length, 3);
  assert.equal(r.stage.lock.held, 0);
});

test("review N6 and N12: the dialog vector's note says that the plan's own events are dropped; the parameter files cite C11's text", () => {
  const note: string = vec("rule-dialog-at-press").note;
  assert.ok(note.includes("its own events are dropped") && !note.includes("its own events go"), note);
  const C11 = readFileSync(new URL("../docs/contracts/C11.md", import.meta.url), "utf8").replace(/\s+/g, " ");
  for (const p of [paramsFor("linux"), paramsFor("darwin")] as any[]) {
    for (const k of ["path.short", "press.modifierAfterMs"]) {
      const src: string = p.sources[k];
      assert.ok(!/shortMovePx|shortSpeedPxPerMs|modifierAfterMs/.test(src), `${k}: no vector name in its source`);
      const quoted = [...src.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      assert.ok(quoted.length > 0 && quoted.every((q) => C11.includes(q)), `${k}: its source quotes C11's text: ${src}`);
    }
  }
});


// ================================================================ review-116b (the narrow re-check) and the daemon lead's point

/**
 * Two tabs of one stage: A's click (its move, press and release in one tick) opens an alert at the fifth move of its path
 * (a mouseover handler); `atDrop` runs at 300 ms, before the close; B's click comes at 400 ms.
 */
async function droppedRun(atDrop: (A: FakeTab, stage: Stage) => void, o: { maxMs?: number } = {}) {
  const clock = new FakeClock();
  const stage = new Stage({ log: () => {}, random: seededRandom(4), platform: "linux", clock, stamp: clock.stamp });
  const A = new FakeTab(own([]), clock, { id: 1 }), B = new FakeTab(own([]), clock, { id: 2 });
  A.stage = stage; B.stage = stage;
  dialogAtFifthMove(A);
  const answers: { tab: string; type: string; t: number; body: any }[] = [];
  const click = (t: FakeTab, x: number, y: number, tag: string) => {
    for (const c of [mouse("mouseMoved", x, y), mouse("mousePressed", x, y), mouse("mouseReleased", x, y)]) t.queue(undefined, c.method, c.params, (body) => answers.push({ tab: tag, type: c.params.type, t: clock.now(), body }));
  };
  clock.timer(0, () => click(A, 300, 200, "A"));
  clock.timer(300, () => atDrop(A, stage));
  clock.timer(400, () => click(B, 700, 500, "B"));
  await clock.run(() => answers.filter((a) => a.tab === "B").length === 3, o.maxMs ?? 60_000);
  let gateOpen = false;
  void A.gate.then(() => { gateOpen = true; });
  await clock.advance(100);
  return { A, B, stage, clock, answers, gateOpen };
}

test("review-116b R1 case 1 (the tab's end): a click whose path opens an alert, the tab dropped before the close: each ended call goes to Chrome and gets its error for the closed tab, A's gate opens, the lock is free, and the next tab's input goes", async () => {
  const r = await droppedRun((A, stage) => { A.closed = true; stage.drop(A.id); });
  const a = r.answers.filter((x) => x.tab === "A");
  assert.equal(a.length, 3, `each of A's calls ends: ${JSON.stringify(a)}`);
  assert.ok(a.every((x) => x.body.error && /No target/.test(x.body.error.message)), "Chrome's error for a closed target");
  assert.ok(events(r.B).length > 3, "B's click goes");
  assert.ok(r.gateOpen, "A's gate opens");
  assert.equal(r.stage.lock.held, 0, "the lock is free");
});

test("review-116b R1 case 1 and the daemon lead's point (a session's end): the tab dropped before the close: the stage sends no held event and nothing goes back; A's gate opens, the lock is free, and the next tab's input goes", async () => {
  let dropAt = -1;
  const r = await droppedRun((A, stage) => { dropAt = A.clock.now(); stage.drop(A.id, "session"); });
  assert.equal(r.answers.filter((x) => x.tab === "A").length, 0, "nothing goes back to a session that ended");
  assert.equal(events(r.A).filter((s) => s.t >= dropAt).length, 0, "no held move, press or release (the plan holds no button: its press never went)");
  assert.ok(events(r.B).length > 3, "B's click goes");
  assert.ok(r.gateOpen, "A's gate opens");
  assert.equal(r.stage.lock.held, 0, "the lock is free");
});

test("the daemon lead's point (a session's end with a button down): a press opened confirm(); the session ends before the close: the stage sends only the release of the held button, with the clickCount of its press, at the drop; nothing goes back; the lock is free; the gate opens", async () => {
  const v = pressOpensDialog([{ at: 0, ...mouse("mousePressed", 900, 700, { clickCount: 2 }) }, { at: 0, ...mouse("mouseReleased", 900, 700, { clickCount: 2 }) }]);
  let gateOpen = false;
  const r = await runVector(v, { maxMs: 2_000, tab: (t) => { t.clock.timer(500, () => { t.stage.drop(t.id, "session"); void t.gate.then(() => { gateOpen = true; }); }); } });
  const after = events(r.tab).filter((s) => s.t >= 500);
  assert.deepEqual(after.map((s) => [s.params.type, s.params.clickCount, s.t]), [["mouseReleased", 2, 500]], "only the release of the held button, at the drop");
  assert.equal(r.answers.filter((a) => a.id === 2).length, 0, "the held release call gets nothing back");
  assert.ok(gateOpen, "the gate opens");
  assert.equal(r.stage.lock.held, 0);
});

/**
 * A's alert on the path, closed at 250 ms; between A's ended move and A's ended press, a call of A's that passes and that
 * Chrome answers after 40 s (a focus call of the activation chain, say) holds A's gate while A's ended events hold the
 * lock that they took again. B's move and press (no release: B's action holds the lock to its own limit) come at 400 ms.
 */
async function heldTail(at?: { ms: number; fn: (A: FakeTab, stage: Stage) => void }) {
  const clock = new FakeClock();
  const stage = new Stage({ log: () => {}, random: seededRandom(4), platform: "linux", clock, stamp: clock.stamp });
  const A = new FakeTab(own([]), clock, { id: 1 }), B = new FakeTab(own([]), clock, { id: 2 });
  A.stage = stage; B.stage = stage;
  dialogAtFifthMove(A);
  const h = A.hook;
  A.hook = (s) => (s.method === "Runtime.evaluate" ? A.clock.sleep(40_000).then(() => ({ result: {} })) : h(s));
  const answers: string[] = [];
  const q = (t: FakeTab, c: any, tag: string) => t.queue(undefined, c.method, c.params, () => answers.push(tag));
  clock.timer(0, () => {
    q(A, mouse("mouseMoved", 300, 200), "A move");
    A.gate = A.gate.then(() => new Promise<void>((res) => { void A.pass(undefined, "Runtime.evaluate", { expression: "1" }, () => { answers.push("A evaluate"); res(); }); }));
    q(A, mouse("mousePressed", 300, 200), "A press");
    q(A, mouse("mouseReleased", 300, 200), "A release");
  });
  clock.timer(250, () => { void A.pass(undefined, "Page.handleJavaScriptDialog", { accept: true }, () => answers.push("A dialog")); });
  clock.timer(400, () => { q(B, mouse("mouseMoved", 700, 500), "B move"); q(B, mouse("mousePressed", 700, 500), "B press"); });
  if (at) clock.timer(at.ms, () => at.fn(A, stage));
  await clock.run(() => answers.length === 7, 120_000);
  return { A, B, stage, clock, answers };
}

test("review-116b R1 and review-126b note 3: a lock that ended events take again has the limit STAGE_ACTION_MAX_MS: at the limit the lock is free (the next tab's input goes), and the remaining ended calls take it again in the order of arrival, so none goes with no lock (another tab's paste could have its text on the selection)", async () => {
  const { A, B, stage, answers } = await heldTail();
  const close = A.sent.find((s) => s.method === "Page.handleJavaScriptDialog")!.t, eb = events(B);
  assert.ok(eb[0].t >= close + STAGE_ACTION_MAX_MS && eb[0].t <= close + STAGE_ACTION_MAX_MS + 50, `B's first event at ${eb[0].t}: at the limit of A's taken lock (the close at ${close})`);
  // B's client holds its button: B's action keeps the lock until its own limit, STAGE_ACTION_MAX_MS after it began.
  const bEnd = eb[0].t + STAGE_ACTION_MAX_MS - 500, aPress = events(A).find((s) => s.params.type === "mousePressed")!;
  assert.ok(aPress.t >= bEnd, `A's ended press at ${aPress.t}: after B's action freed the lock (about ${eb[0].t + STAGE_ACTION_MAX_MS}), not at the evaluate's answer (40000) with no lock`);
  assert.ok(A.activations.some((t) => t >= bEnd && t <= aPress.t), `A's activation before its press, with the lock taken again: ${A.activations.join(", ")}`);
  assert.deepEqual(answers.slice(-2), ["A press", "A release"]);
  await A.clock.advance(STAGE_ACTION_MAX_MS);
  assert.equal(stage.lock.held, 0, "the lock is free");
  assert.equal(stage.counts.tailLimits, 1, "one limit of the taken lock");
});

test("review-116b R1: drop() frees the tab's taken lock at once: the next tab's input goes at the drop, not at the lock's limit", async () => {
  const { B, stage } = await heldTail({ ms: 1000, fn: (A, st) => { A.closed = true; st.drop(A.id); } });
  const eb = events(B);
  assert.ok(eb[0].t >= 1000 && eb[0].t <= 1050, `B's first event at ${eb[0].t}: at the drop (1000)`);
  await B.clock.advance(STAGE_ACTION_MAX_MS * 2);
  assert.equal(stage.lock.held, 0, "the lock is free");
});

test("the daemon lead's point: a dialog at a press, and a navigation of the main frame closes it: no press reaches the new page, the stage's release goes with the press's clickCount, the held release gets the error that the context is gone, and the gate opens", async () => {
  const v = pressOpensDialog([{ at: 0, ...mouse("mousePressed", 900, 700, { clickCount: 2 }) }, { at: 0, ...mouse("mouseReleased", 900, 700, { clickCount: 2 }) }, { at: 600, method: "Runtime.evaluate", params: { expression: "1" } }]);
  const r = await runVector(v, { maxMs: 10_000, tab: (t) => { t.clock.timer(500, () => t.navigate()); } });
  const after = events(r.tab).filter((s) => s.t >= 500);
  assert.equal(after.filter((s) => s.params.type === "mousePressed").length, 0, "no press reaches the new page");
  assert.deepEqual(after.map((s) => [s.params.type, s.params.clickCount]), [["mouseReleased", 2]], "the stage's own release of the held button, and no other event");
  const rel = r.answers.find((a) => a.id === 2)!;
  assert.ok(rel.body.error && /context/i.test(rel.body.error.message), `the held release gets the error that the context is gone: ${JSON.stringify(rel.body)}`);
  assert.ok(r.answers.some((a) => a.id === 3), "the gate opens: the later call goes");
  assert.equal(r.stage.lock.held, 0);
});

test("the daemon lead's point: a navigation of the main frame ends the wait for a close of an alert on the path: the held move, press and release get the error that the context is gone, and no event goes", async () => {
  const v = own([{ at: 0, ...mouse("mouseMoved", 300, 200) }, { at: 0, ...mouse("mousePressed", 300, 200) }, { at: 0, ...mouse("mouseReleased", 300, 200) }, { at: 600, method: "Runtime.evaluate", params: { expression: "1" } }]);
  const r = await runVector(v, { maxMs: 10_000, tab: (t) => { dialogAtFifthMove(t); t.clock.timer(500, () => t.navigate()); } });
  assert.equal(events(r.tab).filter((s) => s.t >= 500).length, 0, "no event after the navigation");
  for (const id of [1, 2, 3]) {
    const a = r.answers.find((x) => x.id === id)!;
    assert.ok(a.body.error && /context/i.test(a.body.error.message), `call ${id}: ${JSON.stringify(a.body)}`);
  }
  assert.ok(r.answers.some((a) => a.id === 4), "the gate opens");
  assert.equal(r.stage.lock.held, 0);
});

test("review-116b note B: the recovery count is per node: a miss of one node gives a setup of another node no recovery", async () => {
  const m = menuRun({ always: true });
  const calls = [{ at: 0, ...setupCall("7.3.10", "mouse", { x: 640, y: 320 }) }, { after: 1, ...setupCall("7.3.11", "mouse", { x: 640, y: 380 }) }];
  m.v.page.nodes["7.3.11"] = { tag: "button", box: { x: 600, y: 360, width: 80, height: 40 }, focused: false };
  m.v.in = calls.map((c, i) => ({ id: i + 1, ...c }));
  const r = await runVector(m.v, { tab: (t) => { t.hook = m.hook(t); } });
  assert.equal(r.stage.counts.setupMisses, 2);
  assert.equal(r.stage.counts.recoveries ?? 0, 0, "no recovery: the miss was of another node");
  assert.ok(!r.tab.sent.some((s) => s.params?.functionDeclaration === OBSTACLE_FIND), "no read at the hit point");
});

test("review-116b note E and N8: a recovery's move out that Chrome refuses stops the plan (C11, an error of an event): the setup goes as the client sent it, no new action starts (no hover path), and the lock is free", async () => {
  for (const action of ["hover", "mouse"]) {
    const m = menuRun({ always: true });
    m.v.in = [{ id: 1, at: 0, ...setupCall("7.3.10", action, { x: 640, y: 320 }) }, { id: 2, after: 1, ...setupCall("7.3.10", action, { x: 640, y: 320 }) }];
    let both = false, refusedAt = -1;
    const r = await runVector(m.v, { tab: (t) => {
      const h = m.hook(t);
      t.hook = (s) => {
        if (s.params?.functionDeclaration === OBSTACLE_BOTH) both = true;
        if (both && refusedAt < 0 && s.method === "Input.dispatchMouseEvent") { refusedAt = s.t; return Promise.reject(Object.assign(new Error("Internal error"), { code: -32000 })); }
        return h(s);
      };
    } });
    assert.ok(refusedAt >= 0, `${action}: the recovery's move out went`);
    assert.equal(r.stage.counts.recoveries, 1);
    assert.equal(events(r.tab).filter((s) => s.t >= refusedAt).length, 1, `${action}: no event after the refused one`);
    assert.equal(r.tab.activations.filter((t) => t >= refusedAt).length, 0, `${action}: no new action (its activation) after the refused move`);
    assert.equal(r.stage.counts.hoverPathsBeforeSetup ?? 0, action === "hover" ? 1 : 0, `${action}: no hover path for the setup of the refused recovery`);
    assert.ok(r.tab.sent.some((s) => s.pass === 2), `${action}: the setup goes as the client sent it`);
    assert.equal(r.answers.length, 2);
    assert.equal(r.stage.counts.eventErrors, 1);
    assert.equal(r.stage.lock.held, 0, `${action}: the lock is free`);
  }
});

test("review-116b N7: the handles that the setups returned are bounded too (KEPT_MAX); the latest stays", async () => {
  const n = KEPT_MAX + 6;
  const v = own(Array.from({ length: n }, (_, i) => ({ ...(i === 0 ? { at: 0 } : { after: i }), ...setupCall("7.3.10", "mouse", { x: 640, y: 320 }) })), { nodes: { "7.3.10": { tag: "button", box: { x: 600, y: 300, width: 80, height: 40 }, focused: false } } });
  const r = await runVector(v, { hook: (s) => (s.pass !== undefined ? { result: { type: "object", objectId: `h-${s.pass}` } } : undefined) });
  assert.equal(r.answers.length, n);
  assert.equal(r.stage.state(r.tab.id)!.handles, KEPT_MAX, `${r.stage.state(r.tab.id)!.handles} handles kept`);
  // The stop of a handle that the bound dropped is not watched; the stop of the latest setup is: its miss marks the node.
  const stop = (h: string) => { const p = structuredClone(vec("click").in[7].params); p.arguments[7] = { objectId: h }; return p; };
  r.stage.saw(r.tab, undefined, "Runtime.callFunctionOn", stop("h-1"), { result: { type: "string", value: "error:notconnected" } });
  assert.equal(r.stage.state(r.tab.id)!.miss, false, "the oldest handle is gone");
  r.stage.saw(r.tab, undefined, "Runtime.callFunctionOn", stop(`h-${n}`), { result: { type: "string", value: "error:notconnected" } });
  assert.equal(r.stage.state(r.tab.id)!.miss, true);
});

test("review-116b R1: a step that waits for the lock when the model drops its tab (a session's end) takes no action and sends nothing; the lock goes on to the next", async () => {
  const clock = new FakeClock();
  const stage = new Stage({ log: () => {}, random: seededRandom(4), platform: "linux", clock, stamp: clock.stamp });
  const A = new FakeTab(own([]), clock, { id: 1 }), B = new FakeTab(own([]), clock, { id: 2 });
  A.stage = stage; B.stage = stage;
  const answers: string[] = [];
  const q = (t: FakeTab, c: any, tag: string) => t.queue(undefined, c.method, c.params, () => answers.push(tag));
  clock.timer(0, () => q(B, mouse("mousePressed", 700, 500), "B press"));
  clock.timer(100, () => q(A, mouse("mouseMoved", 300, 200), "A move"));
  clock.timer(200, () => stage.drop(A.id, "session"));
  clock.timer(1000, () => q(B, mouse("mouseReleased", 700, 500), "B release"));
  await clock.run(() => answers.includes("B release"), 10_000);
  await clock.advance(2000);
  assert.equal(events(A).length, 0, "no event of A's");
  assert.equal(A.activations.length, 0, "no action of A's (no activation)");
  assert.ok(!answers.includes("A move"), "nothing goes back to the session that ended");
  assert.equal(stage.lock.held, 0, "the lock is free");
});

test("the daemon lead's point (the tab's end): the held calls go to Chrome; then the stage releases only what the client did not release", async () => {
  // A press opened confirm(); the client's move with the button down waits (no release of the client's): the stage's release goes after it.
  const v1 = pressOpensDialog([{ at: 0, ...mouse("mousePressed", 900, 700, { clickCount: 2 }) }, { at: 0, ...mouse("mouseMoved", 950, 700, { button: "left", buttons: 1 }) }]);
  const r1 = await runVector(v1, { maxMs: 5_000, tab: (t) => { t.clock.timer(500, () => { t.closed = true; t.stage.drop(t.id); }); } });
  const moved = r1.tab.sent.find((s) => s.params?.type === "mouseMoved" && s.t >= 500)!, rel1 = r1.tab.sent.filter((s) => s.params?.type === "mouseReleased");
  assert.ok(moved && moved.params.x === 950 && moved.params.buttons === 1, "the held move went to Chrome at the drop, at the client's point");
  assert.ok(r1.answers.find((a) => a.id === 2)?.body.error, "and got Chrome's error for the closed tab");
  assert.equal(rel1.length, 1);
  assert.ok(rel1[0].pass === undefined && rel1[0].params.clickCount === 2 && r1.tab.sent.indexOf(rel1[0]) > r1.tab.sent.indexOf(moved), "then the stage's own release, with the press's clickCount");
  // The client's release waits: it goes as the client sent it, and the stage sends no second release.
  const v2 = pressOpensDialog([{ at: 0, ...mouse("mousePressed", 900, 700) }, { at: 0, ...mouse("mouseReleased", 900, 700) }]);
  const r2 = await runVector(v2, { maxMs: 5_000, tab: (t) => { t.clock.timer(500, () => { t.closed = true; t.stage.drop(t.id); }); } });
  const rel2 = r2.tab.sent.filter((s) => s.params?.type === "mouseReleased");
  assert.equal(rel2.length, 1, "only the client's own release, no second release of the stage's");
  assert.ok(rel2[0].t >= 500 && r2.answers.find((a) => a.id === 2)?.body.error, "the client's release went to Chrome at the drop and got Chrome's error");
  // The client's release waits behind its move with the button down: it goes as the client sent it, and the stage sends no second release.
  const v3 = pressOpensDialog([{ at: 0, ...mouse("mousePressed", 900, 700) }, { at: 0, ...mouse("mouseMoved", 950, 700, { button: "left", buttons: 1 }) }, { at: 0, ...mouse("mouseReleased", 950, 700) }]);
  const r3 = await runVector(v3, { maxMs: 5_000, tab: (t) => { t.clock.timer(500, () => { t.closed = true; t.stage.drop(t.id); }); } });
  assert.deepEqual(r3.tab.sent.filter((s) => s.params?.type === "mouseReleased").map((s) => s.pass), [3], "only the client's own release, as it sent it");
  assert.ok([2, 3].every((id) => r3.answers.some((a) => a.id === id)), "the held move and release end (the fake keeps the press's own answer: its tab closed)");
  assert.equal(r2.stage.lock.held, 0);
});

/** Four setups of one node that Playwright retries: three misses (two recoveries), then the attempt at the limit, which passes (its handle 7.3.20). */
function atTheLimit(after: any[]) {
  const m = menuRun({ always: true });
  const calls: any[] = [];
  for (let k = 0; k < 4; k++) calls.push({ ...setupCall("7.3.10", "mouse", { x: 640, y: 320 }), ...(k === 0 ? { at: 0 } : { after: k }) });
  calls.push(...after);
  m.v.in = calls.map((c, i) => ({ id: i + 1, ...c }));
  return { v: m.v, tab: (t: FakeTab) => { const h = m.hook(t); t.hook = (s) => (s.pass === 4 ? { result: { type: "object", objectId: "7.3.20" } } : h(s)); } };
}

test("review-116b: the end of the stage's action ends the plain attempt: after the attempt at the limit, a mouse call with no setup and no stop between gets the person's input", async () => {
  const x = atTheLimit([{ after: 4, ...mouse("mouseMoved", 640, 320) }, { after: 4, ...mouse("mousePressed", 640, 320) }, { after: 4, ...mouse("mouseReleased", 640, 320) },
    { after: 7, waitMs: 100, ...mouse("mouseMoved", 200, 600) }]);
  const r = await runVector(x.v, { tab: x.tab });
  assert.equal(r.stage.counts.recoveries, 2);
  assert.ok(r.stage.counts.plainAttempts >= 1);
  const later = moves(r.tab).filter((s) => s.t >= r.arrived.get(8)!);
  assert.ok(later.length > 5, `a path for the later move (${later.length} moves)`);
});

test("review-116b: the stop's answer ends the plain attempt while the action stays open (Shift held): a later mouse call gets the person's input", async () => {
  const shift = (type: string) => ({ method: "Input.dispatchKeyEvent", params: { type, key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: type === "keyUp" ? 0 : 8, location: 1 } });
  const x = atTheLimit([{ after: 4, ...shift("rawKeyDown") }, { after: 5, ...mouse("mouseMoved", 640, 320, { modifiers: 8 }) }, { after: 5, ...mouse("mousePressed", 640, 320, { modifiers: 8 }) },
    { after: 5, ...mouse("mouseReleased", 640, 320, { modifiers: 8 }) }, { after: 8, ...stopCall() }, { after: 9, ...mouse("mouseMoved", 200, 600, { modifiers: 8 }) }, { after: 10, ...shift("keyUp") }]);
  const r = await runVector(x.v, { tab: x.tab });
  assert.ok(r.stage.counts.plainAttempts >= 1);
  const later = moves(r.tab).filter((s) => s.t >= r.arrived.get(10)!);
  assert.ok(later.length > 5, `a path for the later move (${later.length} moves)`);
});

test("the daemon lead's point: a navigation of the main frame during a click with Shift (an alert on the path): the stage releases the held Shift, and no mouse event goes", async () => {
  const shift = (type: string) => ({ method: "Input.dispatchKeyEvent", params: { type, key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: type === "keyUp" ? 0 : 8, location: 1 } });
  const v = own([{ at: 0, ...shift("rawKeyDown") }, { after: 1, ...mouse("mouseMoved", 300, 200, { modifiers: 8 }) }, { after: 1, ...mouse("mousePressed", 300, 200, { modifiers: 8 }) },
    { after: 1, ...mouse("mouseReleased", 300, 200, { modifiers: 8 }) }, { after: 1, ...shift("keyUp") }]);
  const r = await runVector(v, { maxMs: 10_000, tab: (t) => { dialogAtFifthMove(t); t.clock.timer(500, () => t.navigate()); } });
  const after = events(r.tab).filter((s) => s.t >= 500);
  assert.deepEqual(after.map((s) => [s.method, s.params.type, s.params.key]), [["Input.dispatchKeyEvent", "keyUp", "Shift"]], "only the release of the held Shift");
  for (const id of [2, 3, 4, 5]) assert.ok(/context/i.test(r.answers.find((a) => a.id === id)?.body.error?.message ?? ""), `call ${id}: the error that the context is gone`);
  assert.equal(r.stage.lock.held, 0);
});
