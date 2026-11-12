// The live rows of the input stage's scroll and wheel (board ab-t30.11; the input design's sections 8 and 13.2, and build
// task 7): a part of the group `stage` of the agent-mode live test (run.ts, CASES=stage; STAGE_PARTS=scroll runs this part
// alone). The relay runs with the stage on (AGENT_BROWSER_INPUT_STAGE=test), behind the real receiver package and the
// stand-in daemon, on the run's own Xvfb. Pages: *.localhost only (a.localhost, and b.localhost for a cross-site frame).
//
// - The rows: mouse.wheel (one call, a series of small calls, down and back, across), a click below the fold,
//   scrollIntoViewIfNeeded(), a fill and a pressSequentially of a field below the fold, a button in an inner scroller below
//   the fold, a button and a field below the fold of a same-origin and of a cross-origin frame's own document, and the
//   wheel point's cross-cases: a click below the fold with the pointer over an element with a wheel listener that is not
//   passive, over a canvas with a wheel handler, and over a focused number input (M11); a page whose listener of the window
//   prevents the wheel (the end after a round that does not move); and the page's content that passes under the wheel
//   point during a round (an inner scroller, a focused number input and a canvas across the page, also inside an open
//   shadow root), with real Playwright of the three pinned versions. Review 122 added a carousel with overflow: hidden, a
//   focused number input as the target, dragTo's scroll with the button down, a scroller in a shadow root around a slot,
//   and a fixed header of the page's scroll-padding. Each row passes when the action passes with Playwright's default
//   timeout through the stage, and the page's state is the same as with Playwright's own input on a second Chromium with no
//   stage (a wheel's scroll within one notch, as C11's residual gives it; an element in view where Playwright's own scroll
//   centers it). The two rows of mouse.wheel's column (review-122, the lead's option b) have a bar of their own: Playwright's
//   own input gives the later notches to the element that comes under the point (measured), and the stage does not.
// - The harness rows R5, R6 and P7 (board ab-t30.2's harness): the input research's recorder page through the stage with
//   Playwright 1.65.0 (wheel calls and clicks below the fold), scored as the harness scores, against STAGE_REFERENCE, and
//   against STAGE_PERSON when it names a reference of the operator's published numbers (PR #117): a report, not a bar,
//   until board ab-t30.13 (the Mac's wheel model).

import { createServer, type Server } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { lostBatches, measureStep, wheelMeasures, type Rec, type StepKind, type StepMark } from "../input-harness/measures.ts";
import { checkReference } from "../input-harness/reference.ts";
import { scoreSource, textTable } from "../input-harness/score.ts";
import type { StageContext } from "./stage-live.ts";

const G = "stage";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.round((performance.timeOrigin + performance.now()) * 1000) / 1000;
const HERE = fileURLToPath(new URL(".", import.meta.url));
const RECORDER = join(HERE, "../../../docs/research/2026-11-09-click-box-input-signals/recorder.html");

/**
 * The scroll page: a page taller and wider than the viewport, a button and two fields below the fold, an inner scroller
 * below the fold with a button in it, a same-origin and a cross-origin frame whose own documents scroll, and in the first
 * screen an element with a wheel listener that is not passive (a map), a canvas with a wheel handler and a number input.
 * `v`: a variant: `stop` (a listener of the window that prevents the wheel), `list`, `num`, `canvas` (an element across the
 * page between the first screen and the button below the fold, that the page's content moves under the wheel point).
 */
function scrollPage(port: number, v: string): string {
  const across = v === "list" ? `<div id=across class=a style="left:0;top:1100px;width:2600px;height:240px;overflow:auto;border:1px solid #000"><div style="height:1200px">a list</div></div>`
    : v === "num" ? `<input id=across class=a type=number style="left:0;top:1100px;width:2600px;height:40px">`
    : v === "canvas" ? `<canvas id=across class=a width=2600 height=240 style="left:0;top:1100px;width:2600px;height:240px;background:#eef"></canvas>`
    : v === "shadow" ? `<x-wheel id=across class=a style="left:0;top:1100px;width:2600px;height:240px;display:block"></x-wheel>`
    : v === "car" ? `<div id=car class=a style="left:0;top:2000px;width:600px;height:120px;overflow:hidden;border:1px solid #000"><div style="position:relative;width:1800px;height:100px"><button id=cbtn style="position:absolute;left:700px;top:30px;width:120px;height:40px">Next slide</button></div></div>`
    : v === "fnum" ? `<input id=fnum class=a type=number style="left:600px;top:2400px;width:100px;height:130px">`
    : v === "drag" ? `<div id=card class=a style="left:1150px;top:100px;width:100px;height:60px;background:#ccf">card</div><div id=zone class=a style="left:1100px;top:2400px;width:160px;height:100px;background:#cfc">zone</div>`
    : v === "slot" ? `<x-scroll id=xs class=a style="left:1130px;top:100px;width:140px;height:300px;display:block"><div style="height:1500px;position:relative"><button id=sbtn style="position:absolute;top:1200px;left:10px;width:110px;height:40px">Slot</button></div></x-scroll>`
    : v === "pad" ? `<style>html{scroll-padding-top:120px}</style><div id=hdr style="position:fixed;left:0;top:0;width:100%;height:120px;background:#333;z-index:9"></div>` : "";
  return `<!doctype html><html><head><meta charset=utf-8><title>stage scroll</title><style>
body{margin:0;font:16px sans-serif;height:5200px;width:2600px;position:relative}
.a{position:absolute;box-sizing:border-box}
#map{left:50px;top:100px;width:500px;height:350px;background:#dfd}
#num{left:100px;top:470px;width:200px;height:30px}
#cv{left:50px;top:520px;width:500px;height:150px;background:#fde}
#sf{left:700px;top:60px;width:400px;height:300px;border:2px solid #000}
#xf{left:700px;top:400px;width:400px;height:280px;border:3px solid #000;padding:4px}
#far{left:100px;top:2400px;width:160px;height:40px}
#fld{left:400px;top:2600px;width:300px;height:30px}
#fld2{left:400px;top:2700px;width:300px;height:30px}
#list{left:100px;top:3200px;width:400px;height:300px;overflow:auto;border:1px solid #000}
#lbtn{position:absolute;left:20px;top:1200px;width:160px;height:40px}
</style></head><body>
<div id=map class=a>map</div><input id=num class=a type=number><canvas id=cv class=a width=500 height=150></canvas>
<iframe id=sf class=a src="/sframe?o=same"></iframe><iframe id=xf class=a src="http://b.localhost:${port}/sframe?o=cross"></iframe>
${across}
<button id=far class=a>Far</button><input id=fld class=a><input id=fld2 class=a>
<div id=list class=a><div style="position:relative;height:2000px"><button id=lbtn>In the list</button></div></div>
<script>
window.__s = { clicks: { far: 0, lbtn: 0, cbtn: 0, sbtn: 0 }, map: 0, cv: 0, across: 0, downs: { fld: 0, fld2: 0 }, drag: { down: 0, bad: 0, dropped: 0 } };
for (const id of ['far', 'lbtn', 'cbtn', 'sbtn']) document.getElementById(id)?.addEventListener('click', () => __s.clicks[id]++);
for (const id of ['fld', 'fld2']) document.getElementById(id).addEventListener('mousedown', () => __s.downs[id]++);
// A map that zooms at the wheel, and a canvas with a wheel handler: listeners that are not passive (they prevent the scroll).
document.getElementById('map').addEventListener('wheel', (e) => { __s.map++; e.preventDefault(); }, { passive: false });
document.getElementById('cv').addEventListener('wheel', (e) => { __s.cv++; e.preventDefault(); }, { passive: false });
const across = document.getElementById('across');
if (across && across.localName === 'canvas') across.addEventListener('wheel', (e) => { __s.across++; e.preventDefault(); }, { passive: false });
if (across && (across.localName === 'div' || across.localName === 'input')) across.addEventListener('wheel', () => __s.across++, { passive: true });
// review-122 B1: a canvas with a wheel handler inside an open shadow root; note 5: a scroller in a shadow root around a slot.
customElements.define('x-wheel', class extends HTMLElement { constructor() { super(); const r = this.attachShadow({ mode: 'open' }); r.innerHTML = '<canvas width=2600 height=240 style="display:block;width:2600px;height:240px;background:#eef"></canvas>'; r.querySelector('canvas').addEventListener('wheel', (e) => { __s.across++; e.preventDefault(); }, { passive: false }); } });
customElements.define('x-scroll', class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<div style="height:300px;overflow:auto"><slot></slot></div>'; } });
// review-122 B3: a drag of the page's own (mouse events): every move after the press has the button down.
const card = document.getElementById('card'), zone = document.getElementById('zone');
if (card) {
  let down = false;
  card.addEventListener('mousedown', () => { down = true; __s.drag.down++; });
  addEventListener('mousemove', (e) => { if (down && !(e.buttons & 1)) __s.drag.bad++; });
  addEventListener('mouseup', (e) => { if (down && zone.contains(e.target)) __s.drag.dropped++; down = false; });
}
${v === "stop" ? "addEventListener('wheel', (e) => { __s.stopped = (__s.stopped || 0) + 1; e.preventDefault(); }, { passive: false });" : ""}
</script></body></html>`;
}
/** A frame's document that scrolls (2,000 px tall): a button and a field below its fold. */
const SFRAME = `<!doctype html><html><head><meta charset=utf-8><style>body{margin:0;height:2000px;position:relative}#fb{position:absolute;left:30px;top:1500px;width:120px;height:36px}#ff{position:absolute;left:30px;top:1700px;width:200px;height:30px}</style></head><body>`
  + `<button id=fb>In the frame</button><input id=ff><script>window.__f = { clicks: 0, downs: 0 }; document.getElementById('fb').addEventListener('click', () => __f.clicks++); document.getElementById('ff').addEventListener('mousedown', () => __f.downs++);</script></body></html>`;

/** The server of the scroll page, its frames, and the recorder (with its box and its /log). */
function pagesServer(recs: Rec[]): Promise<{ server: Server; port: number }> {
  const HTML = readFileSync(RECORDER, "utf8");
  const piece = (re: RegExp) => { const m = re.exec(HTML); if (!m) throw new Error(`recorder.html has no ${re}`); return m[1]; };
  const BOX = `<!doctype html><html><head><meta charset=utf-8><title>box</title></head><body>${piece(/<template id="box-html">([\s\S]*?)<\/template>/)}`
    + `<script>${piece(/<script id="core">([\s\S]*?)<\/script>/)}</script><script>${piece(/<script type="text\/plain" id="box-ui">([\s\S]*?)<\/script>/)}</script></body></html>`;
  let port = 0;
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x"), host = String(req.headers.host ?? "");
    if (req.method === "POST" && u.pathname === "/log") {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (d) => (body += d));
      req.on("end", () => { try { recs.push(...(JSON.parse(body) as Rec[])); } catch { /* a broken beacon */ } res.writeHead(204).end(); });
      return;
    }
    const html = (s: string) => res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(s);
    if (u.pathname === "/scroll") return html(scrollPage(port, u.searchParams.get("v") ?? ""));
    if (u.pathname === "/sframe") return html(SFRAME);
    if (u.pathname === "/recorder.html" && host.startsWith("rec.")) return html(HTML);
    if (u.pathname === "/box.html" && host.startsWith("box.")) return html(BOX);
    res.writeHead(404).end();
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => { port = (server.address() as { port: number }).port; r({ server, port }); }));
}

/**
 * A row: its page variant, its action (with `before` steps), the fields of the state that it decides, and `within`: the
 * fields whose numbers may differ by up to that much (a wheel's scroll: one notch, as C11's residual gives it).
 * `trace`: a line of the stage that the row needs (its notches, or the counted fallback).
 */
type Row = { name: string; v?: string; act: (p: any) => Promise<unknown>; before?: (p: any) => Promise<unknown>; fields: string[]; within?: Record<string, number>; trace?: RegExp;
  /** A bar of the row's own on the stage's state (Playwright's own input differs by design), in place of the same state. */
  bar?: (stage: any) => boolean };
const click = (sel: string) => (p: any) => p.locator(sel).click();
const ROWS: Row[] = [
  { name: "mouse.wheel(0, 600)", before: (p) => p.mouse.move(640, 300), act: (p) => p.mouse.wheel(0, 600), fields: ["scrollY", "scrollX"], trace: /^a wheel call: 5 notches/ },
  { name: "mouse.wheel(0, 100) four times (the residual: within one notch)", before: (p) => p.mouse.move(640, 300), act: async (p) => { for (let i = 0; i < 4; i++) await p.mouse.wheel(0, 100); }, fields: ["scrollY"], within: { scrollY: 120 } },
  { name: "mouse.wheel(0, 600), then mouse.wheel(0, -600)", before: (p) => p.mouse.move(640, 300), act: async (p) => { await p.mouse.wheel(0, 600); await p.mouse.wheel(0, -600); }, fields: ["scrollY"] },
  { name: "mouse.wheel(300, 0) (across: within one notch)", before: (p) => p.mouse.move(640, 300), act: (p) => p.mouse.wheel(300, 0), fields: ["scrollX", "scrollY"], within: { scrollX: 120 } },
  { name: "a click below the fold: locator('#far').click()", act: click("#far"), fields: ["clicks", "farInView"], trace: /^a scroll into view: \d+ notches/ },
  { name: "locator('#far').scrollIntoViewIfNeeded()", act: (p) => p.locator("#far").scrollIntoViewIfNeeded(), fields: ["farInView"], trace: /^a scroll into view: \d+ notches/ },
  { name: "a fill of a field below the fold: locator('#fld').fill()", act: (p) => p.locator("#fld").fill("below the fold"), fields: ["values"], trace: /^a focus click: \d+ notches into view/ },
  { name: "pressSequentially() into a field below the fold", act: (p) => p.locator("#fld2").pressSequentially("typed below"), fields: ["values"], trace: /^a focus click: \d+ notches into view/ },
  { name: "a button in an inner scroller below the fold: locator('#lbtn').click()", act: click("#lbtn"), fields: ["clicks", "lbtnInView"], trace: /^a scroll into view: \d+ notches in [2-4] rounds/ },
  { name: "a scroller in a same-origin frame: a button below the frame's fold", act: (p) => p.frameLocator("#sf").locator("#fb").click(), fields: ["frames"], trace: /^a scroll into view: \d+ notches/ },
  { name: "a scroller in a cross-origin frame: a button below the frame's fold", act: (p) => p.frameLocator("#xf").locator("#fb").click(), fields: ["frames"], trace: /^a scroll into view: \d+ notches/ },
  { name: "a field out of view inside a same-origin frame's own scroller: fill()", act: (p) => p.frameLocator("#sf").locator("#ff").fill("same frame"), fields: ["frameValues"], trace: /^a focus click: \d+ notches into view/ },
  { name: "a field out of view inside a cross-origin frame's own scroller: fill()", act: (p) => p.frameLocator("#xf").locator("#ff").fill("cross frame"), fields: ["frameValues"], trace: /^a focus click: \d+ notches into view/ },
  { name: "the pointer over an element with a wheel listener that is not passive (a map): a click below the fold", before: (p) => p.mouse.move(300, 280), act: click("#far"), fields: ["clicks", "map"] },
  { name: "the pointer over a canvas with a wheel handler: a click below the fold", before: (p) => p.mouse.move(300, 600), act: click("#far"), fields: ["clicks", "cv"] },
  { name: "the pointer over a focused number input (M11): a click below the fold", before: async (p) => { await p.locator("#num").fill("5"); await p.mouse.move(200, 485); }, act: click("#far"), fields: ["clicks", "numValue"] },
  { name: "a listener of the window that prevents the wheel: a click below the fold (the end after a round that does not move)", v: "stop", act: click("#far"), fields: ["clicks"], trace: /^a scroll into view as the client sent it \(noMove\)/ },
  { name: "an inner scroller across the page that the content moves under the wheel point: a click below the fold", v: "list", act: click("#far"), fields: ["clicks", "acrossTop"] },
  { name: "a focused number input across the page that the content moves under the wheel point (M11): a click below the fold", v: "num", before: async (p) => { await p.locator("#across").fill("7"); await p.evaluate(() => scrollTo(0, 0)); }, act: click("#far"), fields: ["clicks", "acrossValue"] },
  { name: "a canvas with a wheel handler across the page that the content moves under the wheel point: a click below the fold", v: "canvas", act: click("#far"), fields: ["clicks", "across"] },
  // mouse.wheel's column (review-122, the lead's option b; the measures of the first round): the notches stop before the
  // element that the page's content would bring under the point, and the rest goes as one event. Playwright's own input
  // gives the later notches to that element (the list moves, the canvas's handler runs): the row's bar is the stage's.
  { name: "mouse.wheel(0, 1440) at a point that the inner scroller across the page would come under: the list does not move, and the page moves the asked total (the call's column)", v: "list", before: (p) => p.mouse.move(640, 300), act: (p) => p.mouse.wheel(0, 1440), fields: ["acrossTop", "scrollY"],
    bar: (s) => s.acrossTop === 0 && Math.abs(s.scrollY - 1440) <= 120, trace: /^a wheel call: \d+ notches, then the rest as one event/ },
  { name: "mouse.wheel(0, 1440) at a point that the canvas across the page would come under: its handler gets no wheel event, and the page moves the asked total (the call's column)", v: "canvas", before: (p) => p.mouse.move(640, 300), act: (p) => p.mouse.wheel(0, 1440), fields: ["across", "scrollY"],
    bar: (s) => s.across === 0 && Math.abs(s.scrollY - 1440) <= 120, trace: /^a wheel call: \d+ notches, then the rest as one event/ },
  // Review 122.
  { name: "a button in a box with overflow: hidden (a carousel) below the fold: locator('#cbtn').click() (review-122 B2)", v: "car", act: click("#cbtn"), fields: ["clicks", "carLeft"], trace: /^a scroll into view as the client sent it \(hidden\)/ },
  { name: "a canvas with a wheel handler inside an open shadow root across the page: a click below the fold (review-122 B1)", v: "shadow", act: click("#far"), fields: ["clicks", "across"] },
  { name: "a focused number input as the click's target below the fold, the pointer below the page's middle (review-122 note 3)", v: "fnum", before: async (p) => { await p.locator("#fnum").fill("5"); await p.evaluate(() => scrollTo(0, 0)); await p.mouse.move(640, 560); }, act: click("#fnum"), fields: ["fnumValue"], trace: /^a scroll into view: \d+ notches/ },
  { name: "dragTo() from a card to a zone below the fold: the zone's scroll while the button is down (review-122 B3)", v: "drag", act: (p) => p.locator("#card").dragTo(p.locator("#zone")), fields: ["drag"], trace: /^a scroll into view as the client sent it \(held\)/ },
  { name: "a button in a shadow root's scroller around a slot (the flat tree): locator('#sbtn').click() (review-122 note 5)", v: "slot", act: click("#sbtn"), fields: ["clicks", "scrollY"], within: { scrollY: 120 }, trace: /^a scroll into view: \d+ notches/ },
  { name: "a button under a fixed header of the page's scroll-padding: locator('#far').click() (review-122 note 4)", v: "pad", before: (p) => p.evaluate(() => scrollTo(0, 2340)), act: click("#far"), fields: ["clicks", "farTop"], within: { farTop: 120 }, trace: /^a scroll into view: \d+ notches/ },
];

/** The page's state after a row: its scroll, the clicks, the fields, the listeners' counts, what is in view, and the frames' clicks and fields. */
async function stateOf(p: any): Promise<any> {
  const s = await p.evaluate(() => {
    const k = (window as any).__s, inView = (id: string) => { const r = document.getElementById(id)!.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth; };
    const across = document.getElementById("across") as any, el = (id: string) => document.getElementById(id) as any;
    return { scrollY: Math.round(scrollY), scrollX: Math.round(scrollX), clicks: k.clicks, map: k.map, cv: k.cv, across: k.across, downs: k.downs,
      values: { fld: (document.getElementById("fld") as HTMLInputElement).value, fld2: (document.getElementById("fld2") as HTMLInputElement).value },
      numValue: (document.getElementById("num") as HTMLInputElement).value, farInView: inView("far"), lbtnInView: inView("lbtn"),
      acrossTop: across && across.localName === "div" ? across.scrollTop : null, acrossValue: across && across.localName === "input" ? across.value : null,
      carLeft: el("car") ? el("car").scrollLeft : null, fnumValue: el("fnum") ? el("fnum").value : null, drag: k.drag, farTop: Math.round(el("far").getBoundingClientRect().top) };
  });
  s.frames = {} as Record<string, unknown>; s.frameValues = {} as Record<string, unknown>; s.frameDowns = {} as Record<string, unknown>;
  for (const f of p.frames()) {
    const o = /sframe\?o=(\w+)/.exec(f.url())?.[1];
    if (!o) continue;
    const r = await f.evaluate(() => ({ clicks: (window as any).__f.clicks, downs: (window as any).__f.downs, value: (document.getElementById("ff") as HTMLInputElement).value })).catch((e: Error) => ({ error: e.message.split("\n")[0] }));
    s.frames[o] = (r as any).clicks ?? r; s.frameValues[o] = (r as any).value ?? r; s.frameDowns[o] = (r as any).downs ?? null;
  }
  return s;
}
/** The row's fields of two states agree (a number within its row's bound). */
function agree(row: Row, a: any, b: any): boolean {
  return row.fields.every((f) => (row.within?.[f] !== undefined && typeof a[f] === "number" && typeof b[f] === "number" ? Math.abs(a[f] - b[f]) <= row.within[f] : JSON.stringify(a[f]) === JSON.stringify(b[f])));
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ok: boolean; ms: number; value?: T; error?: string }> {
  const t0 = Date.now();
  try { const value = await fn(); return { ok: true, ms: Date.now() - t0, value }; } catch (e) { return { ok: false, ms: Date.now() - t0, error: String((e as Error).message ?? e).split("\n")[0].slice(0, 200) }; }
}

export async function stageScrollCases(o: StageContext): Promise<void> {
  const recs: Rec[] = [];
  const { server, port } = await pagesServer(recs);
  const out: Record<string, unknown> = { port, rows: [] as unknown[] };
  const stageLines = () => o.relayLines.filter((l) => l.line.startsWith("relay: the input stage"));
  try {
    for (const { version, pw } of o.pws) {
      const plain = await pw.chromium.launchPersistentContext(o.profileDir(`splain-${version}`), {
        executablePath: o.chromium, headless: false, viewport: null, timeout: 30_000,
        env: { PATH: "/usr/bin:/bin", HOME: o.profileDir(`shome-${version}`), DISPLAY: o.display, XAUTHORITY: o.xauth },
        args: ["--no-first-run", "--no-default-browser-check", "--password-store=basic", "--window-size=1280,900", "--window-position=0,0",
          "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE a.localhost , EXCLUDE b.localhost", "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=a.localhost;b.localhost"],
      });
      const browser = await pw.chromium.connectOverCDP(o.url("stage"), { timeout: 20_000 });
      const ctx = browser.contexts()[0];
      try {
        // STAGE_SCROLL_ROWS: a regular expression of the rows' names to run (all rows when it is not set).
        const only = process.env.STAGE_SCROLL_ROWS ? new RegExp(process.env.STAGE_SCROLL_ROWS) : null;
        for (const row of ROWS.filter((r) => !only || only.test(r.name))) {
          const name = `${row.name} (Playwright ${version})`;
          const run = async (p: any) => {
            p.on("dialog", (d: any) => { void d.accept(); });
            await p.goto(`http://a.localhost:${port}/scroll${row.v ? `?v=${row.v}` : ""}`);
            await p.waitForFunction(() => document.readyState === "complete" && [...document.querySelectorAll("iframe")].every((f) => !!(f as HTMLIFrameElement).contentWindow));
            await sleep(300);
            if (row.before) await row.before(p);
            const r = await timed(() => row.act(p));
            await sleep(1000); // the smooth scroll of a wheel ends
            return { ...r, state: await stateOf(p) };
          };
          const lines0 = stageLines().length;
          const sp = await ctx.newPage();
          const s = await run(sp).finally(() => sp.close().catch(() => {}));
          const pp = await plain.newPage();
          const q = await run(pp).finally(() => pp.close().catch(() => {}));
          const trace = stageLines().slice(lines0).map((l) => l.line.replace(/^relay: the input stage: tab \d+: /, ""));
          const same = agree(row, s.state, q.state);
          const traced = !row.trace || trace.some((l) => row.trace!.test(l));
          const met = row.bar ? row.bar(s.state) : same;
          const ok = s.ok && q.ok && met && traced;
          const pick = (st: any) => Object.fromEntries(row.fields.map((f) => [f, st[f]]));
          const scrollLines = trace.filter((l) => /^(a scroll into view|a wheel call|a focus click|no focus click)/.test(l));
          o.record({ group: G, case: name, status: ok ? "pass" : "fail", ms: s.ms, detail: { stage: { ok: s.ok, ms: s.ms, ...(s.error ? { error: s.error } : {}) }, own: { ok: q.ok, ms: q.ms, ...(q.error ? { error: q.error } : {}) },
            same, traced, scrollLines, ...(row.bar ? { bar: met } : {}), ...(same && !row.bar ? {} : { stageState: pick(s.state), ownState: pick(q.state) }) } });
          (out.rows as unknown[]).push({ version, row: row.name, stage: s, own: q, same, traced, trace });
        }
        // The harness rows with Playwright 1.65.0: with all rows, or alone with STAGE_SCROLL_HARNESS=1.
        if (version === "1.65.0" && (!process.env.STAGE_SCROLL_ROWS || process.env.STAGE_SCROLL_HARNESS === "1")) await harnessScroll(o, ctx, port, recs, out);
      } finally {
        await browser.close().catch(() => {});
        await plain.close().catch(() => {});
      }
    }
  } finally {
    writeFileSync(join(o.run, "stage-scroll-live.json"), JSON.stringify(out, null, 1) + "\n");
    server.close();
  }
}

/** The harness rows R5, R6 and P7: the recorder through the stage (Playwright 1.65.0): wheel calls and clicks below the fold, scored as the harness scores. */
async function harnessScroll(o: StageContext, ctx: any, port: number, recs: Rec[], out: Record<string, unknown>): Promise<void> {
  const REC = `http://rec.a.localhost:${port}/recorder.html?sink=1&run=scroll&box=${encodeURIComponent(`http://box.b.localhost:${port}/box.html`)}`;
  const marks: StepMark[] = [];
  const page = await ctx.newPage();
  const lastOf = (e: string, f = "top") => recs.filter((r: any) => r.e === e && (r.f ?? "top") === f).at(-1) as any;
  const step = async (kind: StepKind, name: string, fn: () => Promise<unknown>, width?: number) => {
    const t0 = now();
    let ok = true, error: string | undefined;
    try { await fn(); } catch (e) { ok = false; error = String((e as Error).message).split("\n")[0].slice(0, 200); }
    marks.push({ name, source: "stage", kind, ok, t0, t1: now(), ...(width ? { width } : {}), ...(error ? { error } : {}) });
    await sleep(900);
  };
  try {
    await page.goto(REC);
    for (let end = Date.now() + 15_000; Date.now() < end && !lastOf("layout"); ) await sleep(100);
    await step("idle", "idle 1 s", () => sleep(1000));
    for (let i = 0; i < 2; i++) {
      // The pointer over the page's content before each round's wheel calls (after a round's clicks it is on #b, with the
      // recorder's fields and its frame within one notch below: the call's column would send each call as one event).
      await page.mouse.move(600, 600);
      await step("wheel", "mouse.wheel(0, 600)", async () => { await page.mouse.wheel(0, 600); await sleep(500); });
      await step("wheel", "mouse.wheel(0, -600)", async () => { await page.mouse.wheel(0, -600); await sleep(500); });
      await step("wheel", "mouse.wheel(0, 360)", async () => { await page.mouse.wheel(0, 360); await sleep(500); });
      await step("wheel", "mouse.wheel(0, -360)", async () => { await page.mouse.wheel(0, -360); await sleep(500); });
      await step("far", "locator('#far').click() (below the fold)", () => page.locator("#far").click(), 40);
      await step("far", "locator('#b').click() (above, at the top)", () => page.locator("#b").click(), 40);
    }
  } finally { await page.close().catch(() => {}); }
  await sleep(1500);
  const mine = recs.filter((r: any) => !r.run || r.run === "scroll");
  const lost = lostBatches(mine.filter((r: any) => r.e === "seq").map((r: any) => r.n));
  writeFileSync(join(o.run, "stage-scroll-harness-results.json"), JSON.stringify({ scenarios: { stage: { t0: marks[0]?.t0 ?? 0, t1: marks.at(-1)?.t1 ?? 0, marks, recs: mine, lostBatches: lost } } }) + "\n");
  const steps = marks.map((m) => measureStep(mine, m));
  // P7 against the person (part B, PR #117; the Mac's trackpad): the stage's wheel as the page saw it, for the PR's report.
  const W = steps.map((s) => s.wheel).filter((w) => w && w.events > 0);
  const all = wheelMeasures(mine.filter((r: any) => r.e === "wheel" || r.e === "scroll"));
  out.wheel = { steps: W.map((w) => ({ events: w!.events, absDeltaY: [...new Set(w!.absDeltaY)], ratios: [...new Set(w!.ratios)], gapsMs: w!.gapsMs })),
    events: all?.events ?? 0, scrolls: all?.scrolls ?? 0, scrollsWithNoWheelOrKey: all?.scrollsWithNoWheelOrKey ?? 0, failedSteps: marks.filter((m) => !m.ok).map((m) => `${m.name}: ${m.error}`) };
  const ROWS_P = /^(R5\/R6|P7)$/;
  for (const [label, file] of [["", process.env.STAGE_REFERENCE], [" against the person", process.env.STAGE_PERSON]] as const) {
    if (!file) { if (!label) o.record({ group: G, case: "the harness rows R5, R6 and P7", status: "skip", ms: 0, why: "no STAGE_REFERENCE" }); continue; }
    const reference = checkReference(JSON.parse(readFileSync(file, "utf8")));
    const rows = scoreSource(steps, reference, { lostBatches: lost });
    writeFileSync(join(o.run, `stage-scroll-harness-report${label ? "-person" : ""}.txt`), textTable({ stage: rows }));
    (out as any)[`harness${label ? "Person" : ""}`] = { failedSteps: marks.filter((m) => !m.ok).map((m) => `${m.name}: ${m.error}`), rows: rows.filter((r) => ROWS_P.test(r.gap)) };
    // Against the literature the rows are bars; against the person (part B's numbers before ab-t30.13) a report.
    for (const r of rows.filter((x) => ROWS_P.test(x.gap)))
      o.record({ group: G, case: `harness${label} ${r.gap}: ${r.measure}`, status: label ? "pass" : r.verdict === "fail" ? "fail" : r.verdict === "pass" ? "pass" : "skip", ms: 0, detail: { bar: r.bar, value: r.value, verdict: r.verdict, n: r.n } });
  }
}
