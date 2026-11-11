// The live rows of the input stage's pointer part (board ab-t30.9; the input design's section 13.2 and build task 5): the
// group `stage` of the agent-mode live test (run.ts), alone (CASES=stage). The relay runs with the stage on (its
// environment's AGENT_BROWSER_INPUT_STAGE=test: the build switch's door for the live rows), behind the real receiver
// package and the stand-in daemon, on the run's own Xvfb. Pages: *.localhost only (a.localhost and b.localhost, of the
// scope's own list), served by this group.
//
// - The rows: each pointer row of the design's table (section 5.1) and the cross-cases that touch it (a click whose path
//   crosses a hover menu that covers the target, M7; a hover with a hover layer, M8; a hover in a same-origin frame, M10,
//   and in a cross-origin frame; a double click on a word; a dialog at a press), with real Playwright of the three pinned
//   versions (1.64.1, 1.65.0, and 1.66.0-alpha-2026-11-09, the playwright-core of @playwright/mcp 0.0.85), each from the
//   run's scratch folder. Each row passes when the action passes with Playwright's default timeout through the stage, and
//   the page's state is the same as with Playwright's own input on a second Chromium with no stage (launched by the same
//   Playwright from this run's profile folder, never a downloaded browser). M8 is the design's named better case:
//   Playwright's own hover fails there (with a 6 s timeout on the second Chromium), and the stage's passes.
// - The measures of open point 4 (a hover and a click in a cross-origin frame; the press point's spread, and the frame
//   owner's box by DOM.getContentQuads and by DOM.getBoxModel) and of open point 5 (does Chrome keep input events while
//   a dialog is open, and give them to the page in order after the close).
// - The harness rows R1, R2 and R9 to R13 (board ab-t30.2's harness, test/live/input-harness/): the input research's
//   recorder page (rec.a.localhost, with its box on box.b.localhost, a cross-site frame) through the stage with Playwright
//   1.65.0, with activations of its window; its records are scored against the reference of a harness run's XTEST steps
//   (STAGE_REFERENCE: a reference.json of `input-harness/run.ts --only source`).

import { createServer, type Server } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { lostBatches, measureStep, type Rec, type StepKind, type StepMark } from "../input-harness/measures.ts";
import { checkReference } from "../input-harness/reference.ts";
import { scoreSource, textTable } from "../input-harness/score.ts";

export type StageContext = {
  url: (scope: string) => string; run: string; chromium: string; display: string; xauth: string;
  /** The three pinned Playwright versions, each its playwright-core module (from the run's scratch folder). */
  pws: { version: string; pw: any }[];
  record: (r: { group: string; case: string; status: "pass" | "fail" | "skip"; ms: number; detail?: unknown; error?: string; why?: string }) => void;
  relayLines: { t: number; line: string }[];
  /** A folder of the run for one plain Chromium's profile (recorded, so the run removes it). */
  profileDir: (name: string) => string;
};

const G = "stage";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.round((performance.timeOrigin + performance.now()) * 1000) / 1000;
const HERE = fileURLToPath(new URL(".", import.meta.url));
const RECORDER = join(HERE, "../../../docs/research/2026-11-09-click-box-input-signals/recorder.html");

/** The rows' page: each element of a row, and a recorder of the events that the rows compare (the page's own script). */
function rowsPage(port: number): string {
  return `<!doctype html><html><head><meta charset=utf-8><title>stage rows</title><style>
body{margin:0;font:16px sans-serif;height:1400px;position:relative}
#b{position:absolute;left:100px;top:200px;width:120px;height:40px}
#bs{position:absolute;left:260px;top:200px;width:120px;height:40px}
#chk{position:absolute;left:420px;top:212px;width:16px;height:16px;margin:0}
#hov{position:absolute;left:480px;top:200px;width:120px;height:60px;background:#eee}
#word{position:absolute;left:100px;top:290px;width:420px;margin:0;font:20px monospace}
#menu{position:absolute;left:640px;top:80px;width:200px}
#trig{height:40px;background:#ddd}
#panel{display:none;position:absolute;left:0;top:40px;width:200px;height:260px;background:#fcc}
#menu:hover #panel{display:block}
#under{position:absolute;left:680px;top:200px;width:120px;height:40px}
#card{position:absolute;left:100px;top:400px;width:200px;height:120px;background:#eef}
#layer{display:none;position:absolute;left:50px;top:40px;width:100px;height:40px;background:#000;color:#fff}
#card:hover #layer{display:block}
#conf{position:absolute;left:340px;top:420px;width:120px;height:40px}
#pad{position:absolute;left:880px;top:420px;width:240px;height:200px;background:#efe}
#sf{position:absolute;left:100px;top:560px;width:300px;height:120px;border:2px solid #000}
#xf{position:absolute;left:460px;top:560px;width:300px;height:120px;border:3px solid #000;padding:4px}
</style></head><body>
<button id=b>Button</button><button id=bs><span>Span</span></button><input type=checkbox id=chk><div id=hov>hover me</div>
<p id=word>alpha bravo charlie delta</p>
<div id=menu><div id=trig>Menu</div><div id=panel>panel</div></div>
<button id=under>Under</button>
<div id=card>card<div id=layer>Quick view</div></div>
<button id=conf>Confirm</button>
<div id=pad></div>
<iframe id=sf src="/frame?o=same"></iframe>
<iframe id=xf src="http://b.localhost:${port}/frame?o=cross"></iframe>
<script>
window.__s = { ev: [], hov: { enter: 0, shift: null }, card: { enter: 0 }, last: null, conf: [], sel: '' };
const id = (t) => t && t.id || (t && t.parentElement && t.parentElement.id) || '';
// On the document in the bubble phase, as a page's own scripts listen: after Playwright's hit-target check on the window.
for (const type of ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'auxclick'])
  document.addEventListener(type, (e) => { const t = id(e.target); if (t && t !== 'sf' && t !== 'xf') __s.ev.push([type, t, e.button, e.detail, e.shiftKey, ...(t === 'pad' ? [e.offsetX, e.offsetY] : [])]); });
document.getElementById('hov').addEventListener('mouseenter', () => __s.hov.enter++);
document.getElementById('hov').addEventListener('mousemove', (e) => { __s.hov.shift = e.shiftKey; });
document.getElementById('card').addEventListener('mouseenter', () => __s.card.enter++);
addEventListener('mousemove', (e) => { __s.last = [e.clientX, e.clientY]; }, true);
document.getElementById('conf').addEventListener('mousedown', () => { __s.conf.push(confirm('Sure?')); });
document.addEventListener('selectionchange', () => { __s.sel = String(getSelection()); });
</script></body></html>`;
}
const FRAME_PAGE = `<!doctype html><html><head><meta charset=utf-8><style>body{margin:0}#t{position:absolute;left:40px;top:30px;width:100px;height:40px}</style></head><body>
<button id=t>Frame</button><script>window.__f = { click: 0, enter: 0, moves: 0 };
document.getElementById('t').addEventListener('click', () => __f.click++); document.getElementById('t').addEventListener('mouseenter', () => __f.enter++);
document.getElementById('t').addEventListener('mousemove', () => __f.moves++);</script></body></html>`;

/** The server of the rows' page, the frames, the blank page and the recorder (with its box and its /log). */
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
    if (u.pathname === "/rows") return html(rowsPage(port));
    if (u.pathname === "/frame") return html(FRAME_PAGE);
    if (u.pathname === "/blank") return html("<!doctype html><title>blank</title><p>blank");
    if (u.pathname === "/recorder.html" && host.startsWith("rec.")) return html(HTML);
    if (u.pathname === "/box.html" && host.startsWith("box.")) return html(BOX);
    res.writeHead(404).end();
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => { port = (server.address() as { port: number }).port; r({ server, port }); }));
}

/** A row: the action, and the page's state that the two browsers must share. `better`: the design's named case where Playwright's own input fails. */
type Row = { name: string; act: (p: any) => Promise<unknown>; before?: (p: any) => Promise<unknown>; better?: boolean; since?: string };
const ROWS: Row[] = [
  { name: "locator.click()", act: (p) => p.locator("#b").click() },
  { name: "locator.click() on a button with a span (condition 4)", act: (p) => p.locator("#bs").click() },
  { name: "dblclick()", act: (p) => p.locator("#b").dblclick() },
  { name: "click({ clickCount: 3 })", act: (p) => p.locator("#b").click({ clickCount: 3 }) },
  { name: "click({ button: 'right' })", act: (p) => p.locator("#b").click({ button: "right" }) },
  { name: "click({ button: 'middle' })", act: (p) => p.locator("#b").click({ button: "middle" }) },
  { name: "click({ delay: 300 })", act: (p) => p.locator("#b").click({ delay: 300 }) },
  { name: "click({ modifiers: ['Shift'] })", act: (p) => p.locator("#b").click({ modifiers: ["Shift"] }) },
  { name: "hover({ modifiers: ['Shift'] })", act: (p) => p.locator("#hov").hover({ modifiers: ["Shift"] }) },
  { name: "click({ position })", act: (p) => p.locator("#pad").click({ position: { x: 7, y: 9 } }) },
  { name: "click({ force })", act: (p) => p.locator("#b").click({ force: true }) },
  { name: "click({ trial })", act: (p) => p.locator("#b").click({ trial: true }) },
  { name: "click({ steps })", act: (p) => p.locator("#b").click({ steps: 5 }), since: "1.65.0" },
  { name: "mouse.move(x, y, { steps })", act: (p) => p.mouse.move(700, 480, { steps: 10 }) },
  { name: "locator.hover()", act: (p) => p.locator("#hov").hover() },
  { name: "hover({ position })", act: (p) => p.locator("#hov").hover({ position: { x: 10, y: 12 } }) },
  { name: "mouse.move(x, y)", act: (p) => p.mouse.move(900, 500) },
  { name: "mouse.down(), mouse.up()", before: (p) => p.mouse.move(950, 520), act: async (p) => { await p.mouse.down(); await p.mouse.up(); } },
  { name: "mouse.click(x, y)", act: (p) => p.mouse.click(1000, 500) },
  { name: "mouse.dblclick(x, y)", act: (p) => p.mouse.dblclick(1000, 500) },
  { name: "check()", act: (p) => p.locator("#chk").check() },
  { name: "frame click (same-origin)", act: (p) => p.frameLocator("#sf").locator("#t").click() },
  { name: "frame click (cross-origin)", act: (p) => p.frameLocator("#xf").locator("#t").click() },
  { name: "frame hover (same-origin, M10)", act: (p) => p.frameLocator("#sf").locator("#t").hover() },
  { name: "frame hover (cross-origin)", act: (p) => p.frameLocator("#xf").locator("#t").hover() },
  { name: "tap() (no touch: refused)", act: (p) => p.locator("#b").tap() },
  { name: "a click whose path crosses a hover menu that covers the target (M7)", before: (p) => p.mouse.move(740, 20), act: (p) => p.locator("#under").click() },
  { name: "hover on a card with a hover layer over its middle (M8)", act: (p) => p.locator("#card").hover(), better: true },
  { name: "dblclick on a word", act: (p) => p.locator("#word").dblclick({ position: { x: 90, y: 12 } }) },
  { name: "a dialog at a press (confirm() in mousedown)", act: (p) => p.locator("#conf").click() },
];

/** The page's state after a row: the click events, the hover, the last move, the selection, the check box, the dialog, the frames. */
async function stateOf(p: any): Promise<unknown> {
  const s = await p.evaluate(() => ({ ...(window as any).__s, checked: (document.getElementById("chk") as HTMLInputElement).checked }));
  const frames: Record<string, unknown> = {};
  for (const f of p.frames()) { const o = /o=(same|cross)/.exec(f.url())?.[1]; if (o) frames[o] = await f.evaluate(() => { const x = (window as any).__f; return { click: x.click, enter: x.enter, moved: x.moves > 0 }; }).catch((e: Error) => `error: ${e.message.split("\n")[0]}`); }
  return { ev: s.ev, hov: { entered: s.hov.enter > 0, shift: s.hov.shift }, card: s.card.enter > 0, last: s.last, conf: s.conf, sel: s.sel, checked: s.checked, frames };
}
/** The fields of a row's state that depend on the row (a move's last point only for a row that ends with a move). */
function compared(row: Row, st: any): unknown {
  const moveRow = /mouse\.move|hover/.test(row.name);
  return { ...st, last: moveRow && !/hover\(|M8|M10|frame/.test(row.name) ? st.last : undefined, hov: row.name.includes("hover") && !/frame|M8/.test(row.name) ? st.hov : undefined };
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ok: boolean; ms: number; value?: T; error?: string }> {
  const t0 = Date.now();
  try { const value = await fn(); return { ok: true, ms: Date.now() - t0, value }; } catch (e) { return { ok: false, ms: Date.now() - t0, error: String((e as Error).message ?? e).split("\n")[0].slice(0, 200) }; }
}

export async function stageCases(o: StageContext): Promise<void> {
  const recs: Rec[] = [];
  const { server, port } = await pagesServer(recs);
  const ROWS_URL = `http://a.localhost:${port}/rows`, BLANK = `http://a.localhost:${port}/blank`;
  const out: Record<string, unknown> = { port };
  const stageLines = () => o.relayLines.filter((l) => l.line.startsWith("relay: the input stage"));
  try {
    for (const { version, pw } of o.pws) {
      // The second Chromium, with no stage: Playwright's own input (this version), on the run's Xvfb, local pages only.
      const plain = await pw.chromium.launchPersistentContext(o.profileDir(`plain-${version}`), {
        executablePath: o.chromium, headless: false, viewport: null, timeout: 30_000,
        env: { PATH: "/usr/bin:/bin", HOME: o.profileDir(`home-${version}`), DISPLAY: o.display, XAUTHORITY: o.xauth },
        args: ["--no-first-run", "--no-default-browser-check", "--password-store=basic", "--window-size=1280,900", "--window-position=0,0",
          "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE a.localhost , EXCLUDE b.localhost", "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=a.localhost;b.localhost"],
      });
      const browser = await pw.chromium.connectOverCDP(o.url("stage"), { timeout: 20_000 });
      const ctx = browser.contexts()[0];
      try {
        for (const row of ROWS) {
          const name = `${row.name} (Playwright ${version})`;
          if (row.since && version.localeCompare(row.since, undefined, { numeric: true }) < 0) { o.record({ group: G, case: name, status: "skip", ms: 0, why: `the option is new in ${row.since}` }); continue; }
          const run = async (p: any, timeout?: number) => {
            p.on("dialog", (d: any) => { void d.accept(); });
            await p.goto(ROWS_URL);
            await p.waitForFunction(() => document.readyState === "complete" && [...document.querySelectorAll("iframe")].every((f) => !!(f as HTMLIFrameElement).contentWindow));
            await sleep(300);
            if (row.before) await row.before(p);
            const r = await timed(() => (timeout ? (async () => { p.setDefaultTimeout(timeout); return row.act(p); })() : row.act(p)));
            await sleep(400);
            return { ...r, state: await stateOf(p) };
          };
          const sp = await ctx.newPage(), lines0 = stageLines().length;
          const s = await run(sp).finally(() => sp.close().catch(() => {}));
          const pp = await plain.newPage();
          const q = await run(pp, row.better ? 6000 : undefined).finally(() => pp.close().catch(() => {}));
          const trace = stageLines().slice(lines0).map((l) => l.line.replace(/^relay: the input stage: tab \d+: /, ""));
          const same = JSON.stringify(compared(row, s.state)) === JSON.stringify(compared(row, q.state));
          const tapRow = row.name.startsWith("tap()");
          const ok = row.better ? s.ok && !q.ok : tapRow ? !s.ok && !q.ok && s.error === q.error : s.ok && q.ok && same;
          o.record({ group: G, case: name, status: ok ? "pass" : "fail", ms: s.ms,
            detail: { stage: { ok: s.ok, ms: s.ms, ...(s.error ? { error: s.error } : {}) }, own: { ok: q.ok, ms: q.ms, ...(q.error ? { error: q.error } : {}) }, same,
              setups: trace.filter((l) => l.startsWith("a setup")).length, ...(same ? {} : { stageState: compared(row, s.state), ownState: compared(row, q.state) }) } });
          (out.rows as unknown[] ?? (out.rows = []) as unknown[]).push({ version, row: row.name, stage: s, own: q, same, trace });
        }
        if (version === "1.65.0") {
          await measures(o, ctx, plain, ROWS_URL, port, out);
          await harnessRows(o, ctx, BLANK, port, recs, out);
        }
      } finally {
        await browser.close().catch(() => {});
        await plain.close().catch(() => {});
      }
    }
  } finally {
    writeFileSync(join(o.run, "stage-live.json"), JSON.stringify(out, null, 1) + "\n");
    server.close();
  }
}

/** Open points 4 and 5: the press point's spread, the cross-origin frame's owner box, and Chrome's input events during a dialog. */
async function measures(o: StageContext, ctx: any, plain: any, ROWS_URL: string, port: number, out: Record<string, unknown>): Promise<void> {
  // The press point's spread: 40 clicks on #b (120 x 40: 1/8 of the smaller side is 5 px, 1/4 is 10 px) through the stage.
  {
    const p = await ctx.newPage();
    try {
      await p.goto(ROWS_URL);
      await p.evaluate(() => { (window as any).__off = []; document.getElementById("b")!.addEventListener("click", (e) => { const r = (e.target as Element).getBoundingClientRect(); (window as any).__off.push([e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2)]); }); });
      const t0 = Date.now();
      for (let i = 0; i < 40; i++) { await p.mouse.move(150 + (i % 5) * 150, 380 + (i % 3) * 30); await p.locator("#b").click(); }
      const off: [number, number][] = await p.evaluate(() => (window as any).__off);
      const d = off.flat(), sd = Math.sqrt(d.reduce((a, x) => a + x * x, 0) / Math.max(1, d.length)), max = Math.max(...d.map(Math.abs)), atMiddle = off.filter(([x, y]) => Math.abs(x) <= 0.5 && Math.abs(y) <= 0.5).length;
      const spanOff = await (async () => {
        await p.evaluate(() => { (window as any).__soff = []; document.getElementById("bs")!.addEventListener("click", (e) => { const r = document.getElementById("bs")!.getBoundingClientRect(); (window as any).__soff.push([e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2)]); }); });
        for (let i = 0; i < 10; i++) { await p.mouse.move(150 + i * 60, 380); await p.locator("#bs").click(); }
        return p.evaluate(() => (window as any).__soff);
      })();
      const m = { clicks: off.length, sdPx: Math.round(sd * 100) / 100, maxPx: max, atMiddle, bar: { sd: 5, max: 10 }, ms: Date.now() - t0, spanButton: { clicks: spanOff.length, atMiddle: spanOff.filter(([x, y]: number[]) => Math.abs(x) <= 0.5 && Math.abs(y) <= 0.5).length } };
      out.spread = m;
      o.record({ group: G, case: "open point 4: the press point's spread (40 clicks on a 120 x 40 button)", status: off.length === 40 && max <= 10 && sd >= 3 && sd <= 7 ? "pass" : "fail", ms: m.ms, detail: m });
    } finally { await p.close().catch(() => {}); }
  }
  // The frame owner's box: DOM.getContentQuads (C11's text) against DOM.getBoxModel's content quad, for the cross-origin
  // frame #xf (left 460, top 560, border 3, padding 4: its content box starts at 467,567).
  {
    const p = await plain.newPage();
    try {
      await p.goto(ROWS_URL);
      await p.waitForFunction(() => document.readyState === "complete");
      await sleep(500);
      const s = await p.context().newCDPSession(p);
      const tree = await s.send("Page.getFrameTree");
      const child = (tree.frameTree.childFrames ?? []).map((f: any) => f.frame).find((f: any) => /o=cross/.test(f.url));
      const owner = await s.send("DOM.getFrameOwner", { frameId: child.id });
      const quads = (await s.send("DOM.getContentQuads", { backendNodeId: owner.backendNodeId })).quads[0];
      const model = (await s.send("DOM.getBoxModel", { backendNodeId: owner.backendNodeId })).model;
      const rect = await p.evaluate(() => { const r = document.getElementById("xf")!.getBoundingClientRect(); return [r.left, r.top]; });
      const m = { iframeRect: rect, contentQuads: quads.slice(0, 2), boxModelBorder: model.border.slice(0, 2), boxModelContent: model.content.slice(0, 2), contentBox: [467, 567] };
      out.frameOwner = m;
      o.record({ group: G, case: "open point 4: the frame owner's box (DOM.getContentQuads against DOM.getBoxModel's content)", status: model.content[0] === 467 && model.content[1] === 567 ? "pass" : "fail", ms: 0, detail: m });
      await s.detach();
    } catch (e) { o.record({ group: G, case: "open point 4: the frame owner's box", status: "fail", ms: 0, error: (e as Error).message }); }
    finally { await p.close().catch(() => {}); }
  }
  // Open point 5: Chrome's input events during a dialog (no stage: a raw CDP session of the second Chromium). A press
  // opens confirm() in mousedown; while it is open, a release and a move; the times of their answers; the page's events.
  {
    const p = await plain.newPage();
    try {
      p.on("dialog", () => {}); // a listener of its own: Playwright then leaves the dialog open (the raw session closes it)
      await p.goto(ROWS_URL);
      await p.waitForFunction(() => document.readyState === "complete");
      await p.evaluate(() => { (window as any).__d = []; for (const t of ["mousedown", "mouseup", "click", "mousemove"]) addEventListener(t, (e: any) => (window as any).__d.push([t, Math.round(performance.timeOrigin + performance.now())]), true); });
      const s = await p.context().newCDPSession(p);
      await s.send("Page.enable");
      let opened = 0;
      const dialog = new Promise<void>((r) => s.on("Page.javascriptDialogOpening", () => { opened = now(); r(); }));
      const at = { x: 400, y: 440 }, answers: Record<string, number> = {};
      const mouse = (type: string, extra: object = {}) => s.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1, ...extra }).then(() => { answers[type] = now(); }, (e: Error) => { answers[type] = -1; void e; });
      await s.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y, button: "none" });
      void mouse("mousePressed", { buttons: 1 });
      await Promise.race([dialog, sleep(3000)]);
      void mouse("mouseReleased", { buttons: 0 });
      void s.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x + 30, y: at.y, button: "none" }).then(() => { answers.move = now(); });
      await sleep(1000);
      const beforeClose = { ...answers };
      const closed = now();
      await s.send("Page.handleJavaScriptDialog", { accept: true });
      await sleep(1000);
      const ev: [string, number][] = await p.evaluate(() => (window as any).__d);
      const after = ev.filter(([, t]) => t >= closed - 5).map(([t]) => t);
      const m = { dialogOpened: opened > 0, answersWhileOpen: Object.keys(beforeClose), answersAfterClose: Object.keys(answers).filter((k) => !(k in beforeClose)),
        pageEventsAfterClose: after, order: ev.map(([t]) => t), kept: after.includes("mouseup") && after.includes("click") && after.includes("mousemove") };
      out.dialog = m;
      o.record({ group: G, case: "open point 5: Chrome keeps input events while a dialog is open, and gives them to the page in order after the close", status: m.dialogOpened && m.kept && m.answersWhileOpen.length === 0 ? "pass" : "fail", ms: 0, detail: m });
      await s.detach();
    } catch (e) { o.record({ group: G, case: "open point 5: input events during a dialog", status: "fail", ms: 0, error: (e as Error).message }); }
    finally { await p.close().catch(() => {}); }
  }
}

/** The harness rows: the recorder through the stage (Playwright 1.65.0), with activations of its window, scored as the harness scores. */
async function harnessRows(o: StageContext, ctx: any, BLANK: string, port: number, recs: Rec[], out: Record<string, unknown>): Promise<void> {
  const REC = `http://rec.a.localhost:${port}/recorder.html?sink=1&run=stage&box=${encodeURIComponent(`http://box.b.localhost:${port}/box.html`)}`;
  const marks: StepMark[] = [];
  const page = await ctx.newPage();
  const lastOf = (e: string, f = "top") => recs.filter((r: any) => r.e === e && (r.f ?? "top") === f).at(-1) as any;
  const widthOf = (id: string) => { const r = lastOf("layout")?.r?.[id] as number[] | undefined; return r ? Math.round(Math.min(r[2], r[3])) : 24; };
  const step = async (kind: StepKind, name: string, fn: () => Promise<unknown>, width?: number) => {
    const t0 = now();
    let ok = true, error: string | undefined;
    try { await fn(); } catch (e) { ok = false; error = String((e as Error).message).split("\n")[0].slice(0, 200); }
    marks.push({ name, source: "stage", kind, ok, t0, t1: now(), ...(width ? { width } : {}), ...(error ? { error } : {}) });
    await sleep(700);
  };
  /** Another window comes forward (its own pointer move through the stage), so that the next input activates the recorder's window. */
  const away = async () => { const b = await ctx.newPage(); await b.goto(BLANK); await b.mouse.move(300 + Math.random() * 200, 300); await sleep(400); return b; };
  try {
    await page.goto(REC);
    for (let end = Date.now() + 15_000; Date.now() < end && !(lastOf("layout") && lastOf("state", "box")); ) await sleep(100);
    await step("idle", "idle 2 s", () => sleep(2000));
    const opened: any[] = [];
    for (let round = 0; round < 2; round++) {
      await step("click", "locator('#b').click()", () => page.locator("#b").click(), widthOf("b"));
      await step("click", "locator('#chk').click()", () => page.locator("#chk").click(), widthOf("chk"));
      await step("hover", "locator('#hov').hover()", () => page.locator("#hov").hover(), widthOf("hov"));
    }
    await step("move", "mouse.move(700, 600, { steps: 20 })", () => page.mouse.move(700, 600, { steps: 20 }));
    for (let i = 0; i < 2; i++) {
      await step("box", "frameLocator('#box').locator('#cb').click()", () => page.frameLocator("#box").locator("#cb").click(), 24);
      await step("click", "locator('#b').click()", () => page.locator("#b").click(), widthOf("b"));
    }
    await step("dblclick", "locator('#b').dblclick()", () => page.locator("#b").dblclick(), widthOf("b"));
    await step("modclick", "locator('#b').click({ modifiers: ['Shift'] })", () => page.locator("#b").click({ modifiers: ["Shift"] }), widthOf("b"));
    await step("modclick", "locator('#chk').click({ modifiers: ['Shift'] })", () => page.locator("#chk").click({ modifiers: ["Shift"] }), widthOf("chk"));
    await step("dblclick", "locator('#hov').dblclick()", () => page.locator("#hov").dblclick(), widthOf("hov"));
    for (let i = 0; i < 3; i++) {
      opened.push(await away());
      await step("click", "locator('#b').click() after another window came forward (an activation)", () => page.locator("#b").click(), widthOf("b"));
    }
    for (const b of opened) await b.close().catch(() => {});
  } finally { await page.close().catch(() => {}); }
  await sleep(1500);
  const mine = recs.filter((r: any) => !r.run || r.run === "stage");
  const lost = lostBatches(mine.filter((r: any) => r.e === "seq").map((r: any) => r.n));
  writeFileSync(join(o.run, "stage-harness-results.json"), JSON.stringify({ scenarios: { stage: { t0: marks[0]?.t0 ?? 0, t1: marks.at(-1)?.t1 ?? 0, marks, recs: mine, lostBatches: lost } } }) + "\n");
  const refFile = process.env.STAGE_REFERENCE;
  if (!refFile) { o.record({ group: G, case: "the harness rows R1, R2, R9 to R13", status: "skip", ms: 0, why: "no STAGE_REFERENCE (a reference.json of input-harness/run.ts --only source)" }); return; }
  const reference = checkReference(JSON.parse(readFileSync(refFile, "utf8")));
  const steps = marks.map((m) => measureStep(mine, m));
  const rows = scoreSource(steps, reference, { lostBatches: lost });
  const text = textTable({ stage: rows });
  writeFileSync(join(o.run, "stage-harness-report.txt"), text);
  out.harness = { failedSteps: marks.filter((m) => !m.ok).map((m) => `${m.name}: ${m.error}`), rows };
  for (const r of rows.filter((x) => /^(R1\/R2|R9|R10|R11|R12|R13|M1|P1|P2|P3|P4|P5|P8)$/.test(x.gap)))
    o.record({ group: G, case: `harness ${r.gap}: ${r.measure}`, status: r.verdict === "fail" ? "fail" : r.verdict === "pass" ? "pass" : "skip", ms: 0, detail: { bar: r.bar, value: r.value, verdict: r.verdict, n: r.n } });
}
