// The probe page of the anti-detect drive measurement (ab-v16.21), its log server, and the analysis of
// one step window. Not part of `npm test`. run.ts beside it starts the server and drives the pages.
//
// The page reports each signal that a site can read about its tab, its window and its input, with
// Date.now() timestamps, by navigator.sendBeacon (out of band: no page-visible request answers it):
//   state:  visibilitychange, focus, blur, pagehide, pageshow, freeze, resume (each with
//           document.visibilityState and document.hasFocus()), and the geometry at load and at each resize
//           (inner/outer size, screenX/Y, screen.*, devicePixelRatio).
//   timing: every requestAnimationFrame time, every tick of a 50 ms setInterval, each
//           IntersectionObserver callback, the lazy image's load (the server also logs its request).
//   input:  every pointer, mouse, key, wheel, beforeinput, input, focusin and focusout event, with
//           isTrusted, the coordinates (client and screen), movementX/Y, pressure, buttons, key, code,
//           inputType, navigator.userActivation, and the visibility and focus at that moment.
//   tabs:   a BroadcastChannel between the probe's own pages: each page posts its state on each change,
//           as a site with two tabs can (the analysis finds two pages that report focus at one time).
// Batches (frames, ticks, moves) leave every 250 ms, so a hidden page sends them about once a second.

import { createServer, type Server } from "node:http";

/** One logged record: a page event, or a driver mark (tab "driver"). */
export type Rec = { t: number; tab: string; ev: string; vis?: string; focus?: boolean; [k: string]: unknown };

/** The probe's own layout: fixed boxes, so a person's pointer (xdotool) can find them without CDP. */
export const LAYOUT = { button: { x: 70, y: 280 }, field: { x: 110, y: 232 }, rafButton: { x: 70, y: 345 }, neutral: { x: 600, y: 420 } };
/** A button below the fold (page y 1200 to 1240, the viewport is 557 px high): a person scrolls to it first. */
export const FAR = { x: 70, pageY: 1220 };

export function page(tab: string): string {
  return `<!doctype html><title>probe ${tab}</title>
<style>body{margin:0;font:16px sans-serif;height:7000px}#box{position:fixed;left:0;top:0;width:200px;height:200px;background:#c00}
#f{position:fixed;left:10px;top:220px;width:200px;height:24px}#b{position:fixed;left:10px;top:260px;width:120px;height:40px}
#r{position:fixed;left:10px;top:325px;width:120px;height:40px}#s{position:fixed;left:220px;top:260px}#rd{position:fixed;left:220px;top:325px}
#far{position:absolute;left:10px;top:1200px;width:120px;height:40px}#lazy{position:absolute;left:10px;top:6000px;width:100px;height:100px}#sent{position:absolute;left:200px;top:6980px;width:10px;height:10px}</style>
<div id="box"></div><input id="f" autocomplete="off"><button id="b">Click</button><button id="r">Frame</button><button id="far">Far</button>
<p id="s">clicks: 0</p><p id="rd">frames: 0</p>
<img id="lazy" loading="lazy" src="/lazy.png?tab=${tab}"><div id="sent"></div>
<script>
const TAB = ${JSON.stringify(tab)};
const ua = () => navigator.userActivation ? { ua: navigator.userActivation.isActive, uh: navigator.userActivation.hasBeenActive } : {};
const send = (ev, extra) => navigator.sendBeacon("/log", JSON.stringify({ t: Date.now(), tab: TAB, ev, vis: document.visibilityState, focus: document.hasFocus(), ...extra }));
const geo = () => ({ iw: innerWidth, ih: innerHeight, ow: outerWidth, oh: outerHeight, sx: screenX, sy: screenY,
  sw: screen.width, sh: screen.height, aw: screen.availWidth, ah: screen.availHeight, al: screen.availLeft, at: screen.availTop,
  dpr: devicePixelRatio, ext: screen.isExtended });
const bc = new BroadcastChannel("probe");
bc.onmessage = (m) => send("bc", { from: m.data.tab, fromVis: m.data.vis, fromFocus: m.data.focus });
const state = (ev, extra) => { send(ev, extra); bc.postMessage({ tab: TAB, vis: document.visibilityState, focus: document.hasFocus() }); };
document.addEventListener("visibilitychange", () => state("visibilitychange"));
addEventListener("focus", () => state("focus"));
addEventListener("blur", () => state("blur"));
for (const e of ["pagehide", "pageshow"]) addEventListener(e, () => state(e));
for (const e of ["freeze", "resume"]) document.addEventListener(e, () => state(e));
addEventListener("resize", () => send("geo", geo()));
let moves = [];
const input = (e) => {
  const r = { type: e.type, trusted: e.isTrusted, ts: Math.round(e.timeStamp), te: Math.round(performance.timeOrigin + e.timeStamp), id: e.target && e.target.id || e.target && e.target.nodeName,
    vis: document.visibilityState, focus: document.hasFocus(), ...ua() };
  if ("clientX" in e) Object.assign(r, { cx: e.clientX, cy: e.clientY, sx: e.screenX, sy: e.screenY, mx: e.movementX, my: e.movementY, b: e.buttons, btn: e.button, det: e.detail });
  if ("pointerType" in e) Object.assign(r, { pt: e.pointerType, pr: e.pressure, pid: e.pointerId, w: e.width });
  if ("key" in e) Object.assign(r, { key: e.key, code: e.code, kc: e.keyCode, rep: e.repeat });
  if ("inputType" in e) Object.assign(r, { it: e.inputType, data: e.data });
  if (e.sourceCapabilities !== undefined) r.sc = e.sourceCapabilities ? e.sourceCapabilities.firesTouchEvents : null;
  if (e.type === "pointermove" || e.type === "mousemove") { moves.push(r); return; }
  if (moves.length) { send("moves", { list: moves }); moves = []; }
  send("in", r);
};
for (const e of ["pointerover", "pointerenter", "pointerdown", "pointerup", "pointerout", "pointerleave", "pointermove", "pointercancel",
  "mouseover", "mouseenter", "mousedown", "mouseup", "mouseout", "mouseleave", "mousemove", "click", "auxclick", "contextmenu", "dblclick",
  "keydown", "keypress", "keyup", "beforeinput", "input", "wheel", "focusin", "focusout"]) document.addEventListener(e, input, { capture: true, passive: true });
let clicks = 0, rafs = 0;
document.getElementById("b").addEventListener("click", () => { clicks++; document.getElementById("s").textContent = "clicks: " + clicks; });
// Content that only a frame makes: a click asks for a frame, and only that frame writes the count.
document.getElementById("r").addEventListener("click", () => requestAnimationFrame(() => { rafs++; document.getElementById("rd").textContent = "frames: " + rafs; send("raf-content", { n: rafs }); }));
// Scrolls (at most one record each 100 ms, and the last one): a person scrolls with the wheel or a key; a script's
// scrollIntoView scrolls with neither. farTop is the far button's top in the viewport.
let lastScroll = 0, scrollTimer = 0;
const scrolled = () => send("scroll", { y: Math.round(scrollY), farTop: Math.round(document.getElementById("far").getBoundingClientRect().top) });
addEventListener("scroll", () => { if (Date.now() - lastScroll > 100) { lastScroll = Date.now(); scrolled(); } clearTimeout(scrollTimer); scrollTimer = setTimeout(scrolled, 150); }, { passive: true });
document.getElementById("far").addEventListener("click", () => send("far-click"));
addEventListener("keydown", (e) => { if (e.key === "End") { scrollTo(0, document.body.scrollHeight); send("scrolled", { y: scrollY }); } });
new IntersectionObserver((es) => { for (const x of es) send("io", { target: x.target.id, hit: x.isIntersecting }); }).observe(document.getElementById("sent"));
document.getElementById("lazy").addEventListener("load", () => send("lazy-load"));
let frames = [], ticks = [];
(function frame() { frames.push(Date.now()); requestAnimationFrame(frame); })();
setInterval(() => ticks.push(Date.now()), 50);
setInterval(() => {
  const extra = {};
  if (frames.length) { extra.frames = frames; frames = []; }
  if (ticks.length) { extra.ticks = ticks; ticks = []; }
  if (moves.length) { send("moves", { list: moves }); moves = []; }
  send("batch", { ...extra, ...ua() });
}, 250);
send("load", { ...geo(), webdriver: navigator.webdriver, hl: history.length, ...ua() });
</script>`;
}

/** A 1x1 PNG for the lazy image. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

/**
 * The log server: /p?tab=NAME serves a probe page, /log takes its beacons, /lazy.png logs its request. `record`
 * changes each beacon before it goes into the log (the Mac check drops the key values: mac-rules.ts, probeRecord).
 */
export function startServer(log: Rec[], o: { record?: (r: Rec) => Rec } = {}): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (req.method === "POST" && u.pathname === "/log") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => { try { const r = JSON.parse(body); log.push(o.record ? o.record(r) : r); } catch { /* not ours */ } res.writeHead(204); res.end(); });
      return;
    }
    if (u.pathname === "/lazy.png") {
      log.push({ t: Date.now(), tab: u.searchParams.get("tab") ?? "?", ev: "lazy-request" });
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
      res.end(PNG);
      return;
    }
    if (u.pathname === "/p") {
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      res.end(page(u.searchParams.get("tab") ?? "x"));
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, port: (server.address() as { port: number }).port })));
}

// ------------------------------------------------------------------------------------------------ analysis

const of = (log: Rec[], tab: string, from: number, to: number) => log.filter((e) => e.tab === tab && e.t >= from && e.t <= to);

/** The page's visibility at time t: the last state report at or before t (load, a change, a batch). */
export function visAt(log: Rec[], tab: string, t: number): string | undefined {
  return log.filter((e) => e.tab === tab && e.t <= t && e.vis).at(-1)?.vis;
}

/** Milliseconds of [from, to] in which the page reported "visible" (from its visibilitychange events). */
export function visibleMs(log: Rec[], tab: string, from: number, to: number): number {
  let state = visAt(log, tab, from), at = from, total = 0;
  for (const e of of(log, tab, from, to).filter((x) => x.ev === "visibilitychange")) {
    if (state === "visible") total += e.t - at;
    state = e.vis; at = e.t;
  }
  if (state === "visible") total += to - at;
  return total;
}

const listOf = (log: Rec[], tab: string, key: "frames" | "ticks") => log.filter((e) => e.tab === tab && Array.isArray(e[key])).flatMap((e) => e[key] as number[]);

/** Frames (rAF calls) and 50 ms timer ticks of a page in [from, to], per second. */
export function rates(log: Rec[], tab: string, from: number, to: number): { fps: number; tps: number } {
  const s = (to - from) / 1000;
  const n = (key: "frames" | "ticks") => listOf(log, tab, key).filter((t) => t >= from && t <= to).length;
  return { fps: Math.round(n("frames") / s), tps: Math.round(n("ticks") / s) };
}

/** The input events of a page in [from, to], moves expanded, in arrival order. */
export function inputs(log: Rec[], tab: string, from: number, to: number): Record<string, any>[] {
  return of(log, tab, from, to).flatMap((e) => e.ev === "in" ? [{ ...e }] : e.ev === "moves" ? (e.list as Record<string, any>[]).map((m) => ({ ...m, t: e.t })) : []);
}

/** Compress a sequence of event types: runs of the same move type become "pointermove x12". */
export function sequence(evs: Record<string, any>[]): string {
  const out: string[] = [];
  let last = "", n = 0;
  const flush = () => { if (last) out.push(n > 1 ? `${last}x${n}` : last); };
  for (const e of evs) { if (e.type === last) { n++; continue; } flush(); last = e.type; n = 1; }
  flush();
  return out.join(" ");
}

const ACTS = ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "keydown", "keyup", "keypress", "beforeinput", "input", "wheel"];

/** What one step showed a site in `tab`: its state, its events, its input, and the frames after it. */
export function stepSignals(log: Rec[], tab: string, t0: number, t1: number) {
  const during = of(log, tab, t0, t1 + 200);
  const ins = inputs(log, tab, t0, t1 + 200);
  const down = ins.find((e) => e.type === "mousedown"), up = ins.find((e) => e.type === "mouseup"), pdown = ins.find((e) => e.type === "pointerdown");
  // The moves before the first press (review-47: the column says "before the press"; a move after the release is not one).
  const moves = ins.filter((e) => e.type === "mousemove" && (!down || (typeof e.te === "number" && typeof down.te === "number" ? e.te < down.te : ins.indexOf(e) < ins.indexOf(down))));
  const keys = ins.filter((e) => e.type === "keydown");
  const inputEv = ins.filter((e) => e.type === "input");
  const after = listOf(log, tab, "frames").filter((t) => t >= t1 + 300 && t <= t1 + 1300).length;
  const lastState = log.filter((e) => e.tab === tab && e.t <= t1 + 1300 && e.vis).at(-1);
  return {
    visBefore: visAt(log, tab, t0), visibleMs: visibleMs(log, tab, t0, t1 + 200),
    visChanges: during.filter((e) => e.ev === "visibilitychange").map((e) => `${e.vis}@${e.t - t0}`),
    focusEvents: during.filter((e) => e.ev === "focus" || e.ev === "blur").map((e) => `${e.ev}@${e.t - t0}`),
    focusAfter: lastState?.focus, visAfter: lastState?.vis,
    framesDuring: listOf(log, tab, "frames").filter((t) => t >= t0 && t <= t1).length, framesAfter: after,
    inputSeq: sequence(ins),
    untrusted: ins.filter((e) => e.trusted === false).length,
    // A press, a release, a click, a key or a text change while the page reports "hidden". A person's page can get
    // pointerout and pointerleave while it goes hidden (its window is covered), and never an action.
    inputHidden: ins.filter((e) => e.vis === "hidden" && ACTS.includes(e.type)).length,
    inputUnfocused: ins.filter((e) => e.focus === false && ["mousedown", "keydown", "click", "input"].includes(e.type)).length,
    screenMinusClient: down ? [down.sx - down.cx, down.sy - down.cy] : undefined,
    pressure: pdown?.pr, downUpMs: down && up ? up.ts - down.ts : undefined,
    moves: moves.length, movesWithMovement: moves.filter((m) => m.mx || m.my).length,
    keydowns: keys.length, inputTypes: [...new Set(inputEv.map((e) => e.it))].join(","),
    activationAtDown: down ? down.ua : undefined,
    // A move of more than 100 px from the last pointer point: the jump from a real pointer event (an activation
    // under the X pointer) to the first CDP move, or a CDP move with no path.
    pointerJumps: ins.filter((e) => (e.type === "mousemove" || e.type === "pointermove") && Math.hypot(e.mx ?? 0, e.my ?? 0) > 100).length / 2 + 0.5 | 0,
    // A position change that the movement does not explain (ab-v16.26, correction 3b): a real event at the X pointer with
    // movement 0 after a path that ended elsewhere, or a move whose movement came from another point (pointerSignals).
    pointerUnexplained: pointerSignals(log, tab, t0, t1 + 200).unexplained,
    // A scroll with no wheel, key or press in the second before it (scrollIntoView), and a field's focus with no press
    // in the second before it (el.focus()).
    scrollsWithoutInput: during.filter((e) => e.ev === "scroll" && !ins.some((i) => ["wheel", "keydown", "pointerdown"].includes(i.type) && i.t <= e.t && e.t - i.t < 1000)).length,
    // A window that comes forward gives the field that had the focus a focusin again (a person's page too, run 8 of
    // ab-v16.26: person-window-multi): such a focusin within 100 ms of the page's focus event is not counted.
    // navigator.userActivation became active in the step with no press and no key (a script run "as a user gesture").
    // A change of isActive from false to true (the page's batches, 250 ms apart) with no press or key in the 600 ms before it.
    activationWithoutInput: (() => {
      const rs = log.filter((e) => e.tab === tab && typeof e.ua === "boolean" && e.t <= t1 + 200);
      const all = inputs(log, tab, t0 - 1000, t1 + 200);
      let n = 0;
      for (let i = 1; i < rs.length; i++) if (rs[i].t >= t0 && rs[i].ua && !rs[i - 1].ua
        && !all.some((x) => ["pointerdown", "mousedown", "keydown"].includes(x.type) && x.t <= rs[i].t && rs[i].t - x.t < 600)) n++;
      return n;
    })(),
    focusWithoutPress: ins.filter((e) => e.type === "focusin" && e.id === "f" && !ins.some((i) => i.type === "pointerdown" && i.t <= e.t && e.t - i.t < 1000)
      && !during.some((x) => x.ev === "focus" && x.t <= e.t + 5 && e.t - x.t < 100)).length,
  };
}

/**
 * The real pointer's traces in a page (ab-v16.26, correction 3b of the research's review): over [from, to], with the
 * page's activations at `activations` (epoch ms). A person's pointer moves in one piece: each mousemove's movementX/Y
 * matches the change of its clientX/Y, and the pointer enters a window that comes forward where it is at that time.
 *   jumps:       mousemoves with a movement of more than 100 px (the first CDP move after a real event elsewhere)
 *   unexplained: mousemoves whose position changed by more than 20 px more or less than their movement says (a real
 *                event at the X pointer after a CDP path that ended elsewhere: movement 0, a new position; or a real
 *                event whose movement comes from another point than the page's last one)
 *   entries:     the first mousemove after each activation (client x,y and movement); sameEntries counts those at
 *                the point (within 3 px) of an earlier entry: an X pointer that never moves gives each entry there
 */
export function pointerSignals(log: Rec[], tab: string, from: number, to: number, activations: number[] = []) {
  const moves = inputs(log, tab, from, to).filter((e) => e.type === "mousemove").map((e) => ({ ...e, at: typeof e.te === "number" ? e.te : e.t }))
    .sort((a, b) => a.at - b.at);
  let jumps = 0, unexplained = 0;
  const detail: string[] = [];
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i], mv = Math.hypot(m.mx ?? 0, m.my ?? 0);
    if (mv > 100) { jumps++; detail.push(`jump (${m.cx},${m.cy}) mv(${m.mx},${m.my})`); }
    if (i === 0) continue;
    const p = moves[i - 1], dx = m.cx - p.cx, dy = m.cy - p.cy;
    if (Math.hypot(dx - (m.mx ?? 0), dy - (m.my ?? 0)) > 20) { unexplained++; detail.push(`unexplained (${p.cx},${p.cy})->(${m.cx},${m.cy}) mv(${m.mx},${m.my})`); }
  }
  const entries = activations.map((a) => moves.find((m) => m.at >= a)).filter((m): m is (typeof moves)[number] => !!m)
    .filter((m, i, all) => all.indexOf(m) === i);
  let sameEntries = 0;
  entries.forEach((e, i) => { if (entries.slice(0, i).some((x) => Math.abs(x.cx - e.cx) <= 3 && Math.abs(x.cy - e.cy) <= 3)) sameEntries++; });
  return { moves: moves.length, jumps, unexplained, sameEntries, entries: entries.map((e) => `(${e.cx},${e.cy}) mv(${e.mx},${e.my})`), detail: detail.slice(0, 12) };
}

/** Milliseconds of [from, to] in which both pages reported document.hasFocus() true (100 ms samples of each page's
 *  latest report; a hidden page reports at least once a second). A person's focus is in one page at a time. */
export function bothFocusedMs(log: Rec[], a: string, b: string, from: number, to: number): number {
  const ra = log.filter((e) => e.tab === a && e.focus !== undefined), rb = log.filter((e) => e.tab === b && e.focus !== undefined);
  let ia = -1, ib = -1, n = 0;
  for (let g = from; g <= to; g += 100) {
    while (ia + 1 < ra.length && ra[ia + 1].t <= g) ia++;
    while (ib + 1 < rb.length && rb[ib + 1].t <= g) ib++;
    if (ia >= 0 && ib >= 0 && ra[ia].focus && rb[ib].focus) n += 100;
  }
  return n;
}
