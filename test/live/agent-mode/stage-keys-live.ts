// The live rows of the input stage's keys and text (board ab-t30.10; the input design's section 13.2 and build task 6):
// a part of the group `stage` of the agent-mode live test (run.ts, CASES=stage; STAGE_PARTS=keys runs this part
// alone). The relay runs with the stage on (AGENT_BROWSER_INPUT_STAGE=test), behind the real receiver package and the
// stand-in daemon, on the run's own Xvfb. Pages: *.localhost only (a.localhost, and b.localhost for a cross-site frame).
//
// - The rows: each key and text row of the design's table (section 5.1: fill, clear, type, pressSequentially, press with
//   and without modifiers, keyboard.type, keyboard.press, keyboard.down and up, keyboard.insertText, a chord, a capital
//   and a symbol with Shift) and the cross-cases (a fill of 40 characters and one above the limit, a fill with a line
//   feed, a press of Enter that submits a form, a field in a cross-origin frame, a dialog at a key, a dialog at a focus
//   click, M9), with real Playwright of the three pinned versions. Each row passes when the action passes with
//   Playwright's default timeout through the stage, and the page's state is the same as with Playwright's own input on a
//   second Chromium with no stage (launched by the same Playwright from this run's profile folder, never a downloaded
//   browser).
// - The design's open points 1 and 2 (section 16): a date picker and a combobox that open at a click (does the next
//   action pass after the stage's focus click?), and a tag input and an input mask (how does the value differ: the named
//   exception). These rows are measures: they report, and they pass when the facts are read.
// - The harness rows R3, R4 and K1 to K4 (board ab-t30.2's harness): the input research's recorder page through the
//   stage with Playwright 1.65.0, scored as the harness scores, against STAGE_REFERENCE (the keys' reference is the
//   literature's until part B's parameters, board ab-t30.13), and against STAGE_PERSON when it names a reference of the
//   operator's published numbers (PR #117).

import { createServer, type Server } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { lostBatches, measureStep, type Rec, type StepKind, type StepMark } from "../input-harness/measures.ts";
import { checkReference } from "../input-harness/reference.ts";
import { scoreSource, textTable } from "../input-harness/score.ts";
import type { StageContext } from "./stage-live.ts";

const G = "stage";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.round((performance.timeOrigin + performance.now()) * 1000) / 1000;
const HERE = fileURLToPath(new URL(".", import.meta.url));
const RECORDER = join(HERE, "../../../docs/research/2026-11-09-click-box-input-signals/recorder.html");

/** The keys page: each field of a row, the widgets of open points 1 and 2, and a recorder of what the rows compare. */
function keysPage(port: number): string {
  return `<!doctype html><html><head><meta charset=utf-8><title>stage keys</title><style>
body{margin:0;font:16px sans-serif;height:1200px;position:relative}
input,textarea,button,#ce,#chips,#dpop,#cblist{position:absolute;font:16px monospace;box-sizing:border-box}
#t{left:100px;top:60px;width:300px;height:30px}#num{left:440px;top:60px;width:120px;height:30px}#em{left:600px;top:60px;width:260px;height:30px}
#ta{left:100px;top:110px;width:400px;height:90px}#ta2{left:540px;top:110px;width:400px;height:90px}
#ce{left:100px;top:220px;width:300px;height:40px;border:1px solid #888}
#q{left:100px;top:290px;width:240px;height:30px}#kd{left:380px;top:290px;width:240px;height:30px}#blur{left:660px;top:290px;width:240px;height:30px}
#mask{left:100px;top:350px;width:240px;height:30px}#tags{left:380px;top:350px;width:300px;height:30px}#chips{left:700px;top:350px;width:300px;height:30px}
#dp{left:100px;top:420px;width:200px;height:30px}#dpop{display:none;left:100px;top:452px;width:280px;height:200px;background:#ddf;z-index:10}
#after{left:150px;top:520px;width:140px;height:40px}
#cb{left:420px;top:420px;width:200px;height:30px}#cblist{display:none;left:420px;top:452px;width:220px;height:160px;background:#fdd;z-index:10}
#after2{left:450px;top:520px;width:140px;height:40px}
#xf{position:absolute;left:100px;top:700px;width:360px;height:120px;border:3px solid #000;padding:4px}
#sf{position:absolute;left:960px;top:220px;width:300px;height:100px;border:2px solid #000}
#xf2{position:absolute;left:520px;top:700px;width:360px;height:120px;border:3px solid #000;padding:4px}
#banner{position:fixed;left:510px;top:690px;width:400px;height:150px;background:rgba(255,255,200,0.95);z-index:20}
</style></head><body>
<input id=t value="old text"><input id=num type=number><input id=em type=email>
<textarea id=ta></textarea><textarea id=ta2></textarea><div id=ce contenteditable=true></div>
<form id=form onsubmit="event.preventDefault(); __k.submits++"><input id=q></form>
<input id=kd><input id=blur>
<input id=mask placeholder="(555) 123-4567"><input id=tags placeholder="tags"><div id=chips></div>
<input id=dp placeholder="date"><div id=dpop>calendar</div><button id=after>After</button>
<input id=cb placeholder="color"><div id=cblist>red blue green</div><button id=after2>After 2</button>
<iframe id=xf src="http://b.localhost:${port}/kframe?o=cross"></iframe><iframe id=sf src="/kframe?o=same"></iframe><iframe id=xf2 src="http://b.localhost:${port}/kframe?o=cross2"></iframe>
<div id=banner>We use cookies. <a href="#ok" id=bannerok>OK</a></div>
<script>
window.__k = { submits: 0, dialogs: [], chips: [], after: 0, after2: 0, shiftDowns: 0, keydowns: 0, banner: 0 };
document.getElementById('banner').addEventListener('mousedown', () => __k.banner++);
document.getElementById('ta2').value = 'set by a script';
addEventListener('keydown', (e) => { __k.keydowns++; if (e.key === 'Shift') __k.shiftDowns++; }, true);
document.getElementById('kd').addEventListener('keydown', (e) => { if (e.key === 'x') { __k.dialogs.push('key'); alert('x'); } });
document.getElementById('blur').addEventListener('blur', () => { __k.dialogs.push('blur'); alert('blur'); });
const mask = document.getElementById('mask');
mask.addEventListener('input', () => { const d = mask.value.replace(/\\D/g, '').slice(0, 10); mask.value = d.length > 6 ? '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6) : d.length > 3 ? '(' + d.slice(0, 3) + ') ' + d.slice(3) : d; });
const tags = document.getElementById('tags');
tags.addEventListener('keydown', (e) => { if (e.key === ',' || e.key === 'Enter') { e.preventDefault(); if (tags.value) { __k.chips.push(tags.value); tags.value = ''; document.getElementById('chips').textContent = __k.chips.join(' | '); } } });
document.getElementById('dp').addEventListener('click', () => { document.getElementById('dpop').style.display = 'block'; });
document.getElementById('cb').addEventListener('click', () => { document.getElementById('cblist').style.display = 'block'; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { document.getElementById('dpop').style.display = 'none'; document.getElementById('cblist').style.display = 'none'; } });
document.getElementById('after').addEventListener('click', () => __k.after++);
document.getElementById('after2').addEventListener('click', () => __k.after2++);
</script></body></html>`;
}
const KFRAME = `<!doctype html><html><head><meta charset=utf-8><style>body{margin:0}input{position:absolute;left:20px;top:30px;width:200px;height:30px;font:16px monospace}</style></head><body><input id=fi></body></html>`;

/** The server of the keys page, its frame, and the recorder (with its box and its /log). */
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
    if (u.pathname === "/keys") return html(keysPage(port));
    if (u.pathname === "/kframe") return html(KFRAME);
    if (u.pathname === "/blank") return html("<!doctype html><title>blank</title><p>blank");
    if (u.pathname === "/recorder.html" && host.startsWith("rec.")) return html(HTML);
    if (u.pathname === "/box.html" && host.startsWith("box.")) return html(BOX);
    res.writeHead(404).end();
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => { port = (server.address() as { port: number }).port; r({ server, port }); }));
}

/** A row: its action (with `before` steps), the fields that it decides, and `measure` for the open points' widgets (a report). */
type Row = { name: string; act: (p: any) => Promise<unknown>; before?: (p: any) => Promise<unknown>; fields: string[]; measure?: 1 | 2; frame?: boolean; frames?: string[]; extra?: string[] };
const T40 = "The quick brown fox jumps over the dogs.", T140 = "The agent browser types a text only when the plan of its keys fits in ten seconds, else it inserts the whole text in one step, as a paste.";
const click = (p: any, sel: string) => p.locator(sel).click();
const ROWS: Row[] = [
  { name: "fill() an input with text and no focus", act: (p) => p.locator("#t").fill("jane.doe@example.com"), fields: ["t"] },
  { name: "fill() an empty textarea", act: (p) => p.locator("#ta").fill("Meet me at 10:45."), fields: ["ta"] },
  { name: "fill() a number input", act: (p) => p.locator("#num").fill("12345"), fields: ["num"] },
  { name: "fill() an email input", act: (p) => p.locator("#em").fill("Jane.Doe@Example.com"), fields: ["em"] },
  { name: "fill() a contenteditable (the text as it is)", act: (p) => p.locator("#ce").fill("Hello there"), fields: ["ce"] },
  { name: "fill() with a line feed (the text as it is)", act: (p) => p.locator("#ta").fill("two\nlines"), fields: ["ta"] },
  { name: "fill() of 40 characters", act: (p) => p.locator("#t").fill(T40), fields: ["t"] },
  { name: "fill() above the limit (140 characters, the text as it is)", act: (p) => p.locator("#ta").fill(T140), fields: ["ta"] },
  { name: "clear()", act: (p) => p.locator("#t").clear(), fields: ["t"] },
  { name: "pressSequentially() into an empty textarea with no focus", act: (p) => p.locator("#ta").pressSequentially("Meet me at 10:45."), fields: ["ta"] },
  { name: "pressSequentially() into a textarea whose text a script set (the caret at its end)", act: (p) => p.locator("#ta2").pressSequentially(" and more"), fields: ["ta2"] },
  { name: "type() (locator) into an input with text", act: (p) => p.locator("#t").type("XY"), fields: ["t"] },
  { name: "press('Enter') submits a form", before: (p) => p.locator("#q").fill("query"), act: (p) => p.locator("#q").press("Enter"), fields: ["q"], extra: ["submits"] },
  { name: "press('Control+A'), then keyboard.type()", act: async (p) => { await p.locator("#t").press("Control+A"); await p.keyboard.type("new"); }, fields: ["t"] },
  { name: "keyboard.type() after a click", act: async (p) => { await click(p, "#t"); await p.keyboard.press("End"); await p.keyboard.type(" Hello World"); }, fields: ["t"] },
  { name: "keyboard.press('Backspace')", act: async (p) => { await click(p, "#t"); await p.keyboard.press("End"); await p.keyboard.press("Backspace"); }, fields: ["t"] },
  { name: "keyboard.down('Shift'), ArrowLeft x3, keyboard.up('Shift'), keyboard.type()", act: async (p) => {
    await click(p, "#t"); await p.keyboard.press("End"); await p.keyboard.down("Shift"); for (let i = 0; i < 3; i++) await p.keyboard.press("ArrowLeft"); await p.keyboard.up("Shift"); await p.keyboard.type("X"); }, fields: ["t"] },
  { name: "keyboard.insertText()", act: async (p) => { await click(p, "#t"); await p.keyboard.press("End"); await p.keyboard.insertText(" inserted"); }, fields: ["t"] },
  { name: "a capital and a symbol with Shift: keyboard.type('A@!')", act: async (p) => { await click(p, "#ta"); await p.keyboard.type("A@! Bb"); }, fields: ["ta"] },
  { name: "a field in a cross-origin frame: fill()", act: (p) => p.frameLocator("#xf").locator("#fi").fill("Card 4242"), fields: [], frame: true },
  { name: "a field in a cross-origin frame: pressSequentially()", act: (p) => p.frameLocator("#xf").locator("#fi").pressSequentially("4242 Exp"), fields: [], frame: true },
  { name: "a dialog at a key (alert() in a keydown handler)", act: async (p) => { await click(p, "#kd"); await p.keyboard.type("axb"); }, fields: ["kd"], extra: ["dialogs"] },
  { name: "a dialog at a focus click (M9: alert() at the blur of the field before)", before: (p) => click(p, "#blur"), act: (p) => p.locator("#t").fill("after the dialog"), fields: ["t"], extra: ["dialogs"] },
  // review-119: a field in a same-origin frame (the hit test at the field's own point), a field in a cross-origin frame
  // under a fixed banner of the top page (no click on the banner), an email field whose caret a fill left at its end
  // (no focus click: B4), and a long pressSequentially with Playwright's default timeout (B7).
  { name: "a field in a same-origin frame: fill()", act: (p) => p.frameLocator("#sf").locator("#fi").fill("Same 4242"), fields: [], frames: ["same"] },
  { name: "a field in a cross-origin frame under a fixed banner of the top page: fill()", act: (p) => p.frameLocator("#xf2").locator("#fi").fill("Card 4242"), fields: [], frames: ["cross2"], extra: ["banner"] },
  { name: "pressSequentially() into an email input whose text a fill set (the caret at its end)", before: async (p) => { await p.locator("#em").fill("a@b.co"); await click(p, "#t"); }, act: (p) => p.locator("#em").pressSequentially("m"), fields: ["em"] },
  { name: "a long pressSequentially() (600 characters) with Playwright's default timeout", act: (p) => p.locator("#ta").pressSequentially("the quick brown fox jumps over the lazy dog ".repeat(14).slice(0, 600)), fields: ["ta"] },
  { name: "open point 1: a date picker that opens at a click; then a click on the button under it", act: async (p) => { await p.locator("#dp").fill("2026-11-12"); await p.locator("#after").click({ timeout: 10_000 }); }, fields: ["dp"], extra: ["after", "dpop"], measure: 1 },
  { name: "open point 1: a combobox that opens at a click; then a click on the button under it", act: async (p) => { await p.locator("#cb").fill("blue"); await p.locator("#after2").click({ timeout: 10_000 }); }, fields: ["cb"], extra: ["after2", "cblist"], measure: 1 },
  { name: "open point 2: a tag input (a comma makes a chip)", act: (p) => p.locator("#tags").fill("red,green,blue"), fields: ["tags"], extra: ["chips"], measure: 2 },
  { name: "open point 2: an input mask (a phone number)", act: (p) => p.locator("#mask").fill("5551234567"), fields: ["mask"], measure: 2 },
];

/** The page's state after a row: the fields' values, the submits, the dialogs, the chips, the clicks under the widgets, the widgets' state, the frame's field. */
async function stateOf(p: any): Promise<any> {
  const s = await p.evaluate(() => {
    const v = (id: string) => { const el = document.getElementById(id) as any; return el.isContentEditable ? el.textContent : el.value; };
    const k = (window as any).__k;
    return { values: Object.fromEntries(["t", "num", "em", "ta", "ta2", "ce", "q", "kd", "mask", "tags", "dp", "cb"].map((id) => [id, v(id)])), submits: k.submits, dialogs: k.dialogs, chips: k.chips,
      after: k.after, after2: k.after2, dpop: getComputedStyle(document.getElementById("dpop")!).display, cblist: getComputedStyle(document.getElementById("cblist")!).display, shiftDowns: k.shiftDowns, keydowns: k.keydowns, banner: k.banner };
  });
  s.frames = {} as Record<string, unknown>;
  for (const f of p.frames()) { const o = /kframe\?o=(\w+)/.exec(f.url())?.[1]; if (o) s.frames[o] = await f.evaluate(() => (document.getElementById("fi") as HTMLInputElement).value).catch((e: Error) => `error: ${e.message.split("\n")[0]}`); }
  s.frame = s.frames.cross ?? null;
  return s;
}
const compared = (row: Row, st: any) => ({ ...Object.fromEntries(row.fields.map((f) => [f, st.values[f]])), ...Object.fromEntries((row.extra ?? []).map((x) => [x, st[x]])), ...(row.frame ? { frame: st.frame } : {}),
  ...Object.fromEntries((row.frames ?? []).map((o) => [`frame:${o}`, st.frames[o]])) });

async function timed<T>(fn: () => Promise<T>): Promise<{ ok: boolean; ms: number; value?: T; error?: string }> {
  const t0 = Date.now();
  try { const value = await fn(); return { ok: true, ms: Date.now() - t0, value }; } catch (e) { return { ok: false, ms: Date.now() - t0, error: String((e as Error).message ?? e).split("\n")[0].slice(0, 200) }; }
}

export async function stageKeyCases(o: StageContext): Promise<void> {
  const recs: Rec[] = [];
  const { server, port } = await pagesServer(recs);
  const KEYS_URL = `http://a.localhost:${port}/keys`;
  const out: Record<string, unknown> = { port, rows: [] as unknown[] };
  const stageLines = () => o.relayLines.filter((l) => l.line.startsWith("relay: the input stage"));
  try {
    for (const { version, pw } of o.pws) {
      const plain = await pw.chromium.launchPersistentContext(o.profileDir(`kplain-${version}`), {
        executablePath: o.chromium, headless: false, viewport: null, timeout: 30_000,
        env: { PATH: "/usr/bin:/bin", HOME: o.profileDir(`khome-${version}`), DISPLAY: o.display, XAUTHORITY: o.xauth },
        args: ["--no-first-run", "--no-default-browser-check", "--password-store=basic", "--window-size=1280,900", "--window-position=0,0",
          "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE a.localhost , EXCLUDE b.localhost", "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=a.localhost;b.localhost"],
      });
      const browser = await pw.chromium.connectOverCDP(o.url("stage"), { timeout: 20_000 });
      const ctx = browser.contexts()[0];
      try {
        // STAGE_KEY_ROWS: a regular expression of the rows' names to run (all rows when it is not set).
        const only = process.env.STAGE_KEY_ROWS ? new RegExp(process.env.STAGE_KEY_ROWS) : null;
        for (const row of ROWS.filter((r) => !only || only.test(r.name))) {
          const name = `${row.name} (Playwright ${version})`;
          const run = async (p: any) => {
            p.on("dialog", (d: any) => { void d.accept(); });
            await p.goto(KEYS_URL);
            await p.waitForFunction(() => document.readyState === "complete" && [...document.querySelectorAll("iframe")].every((f) => !!(f as HTMLIFrameElement).contentWindow));
            await sleep(300);
            if (row.before) await row.before(p);
            const r = await timed(() => row.act(p));
            await sleep(500);
            return { ...r, state: await stateOf(p) };
          };
          const lines0 = stageLines().length;
          const sp = await ctx.newPage();
          const s = await run(sp).finally(() => sp.close().catch(() => {}));
          const pp = await plain.newPage();
          const q = await run(pp).finally(() => pp.close().catch(() => {}));
          const trace = stageLines().slice(lines0).map((l) => l.line.replace(/^relay: the input stage: tab \d+: /, ""));
          const fieldLines = trace.filter((l) => /^(a focus click|no focus click|typed keys|a text as it is)/.test(l));
          const same = JSON.stringify(compared(row, s.state)) === JSON.stringify(compared(row, q.state));
          const ok = row.measure ? true : s.ok && q.ok && same;
          const detail = { stage: { ok: s.ok, ms: s.ms, ...(s.error ? { error: s.error } : {}) }, own: { ok: q.ok, ms: q.ms, ...(q.error ? { error: q.error } : {}) }, same,
            shiftDowns: [s.state.shiftDowns, q.state.shiftDowns], fieldLines, ...(same ? {} : { stageState: compared(row, s.state), ownState: compared(row, q.state) }) };
          o.record({ group: G, case: name, status: ok ? "pass" : "fail", ms: s.ms, detail });
          (out.rows as unknown[]).push({ version, row: row.name, measure: row.measure ?? null, stage: s, own: q, same, trace });
        }
        if (version === "1.65.0" && !process.env.STAGE_KEY_ROWS) await harnessKeys(o, ctx, port, recs, out);
      } finally {
        await browser.close().catch(() => {});
        await plain.close().catch(() => {});
      }
    }
  } finally {
    writeFileSync(join(o.run, "stage-keys-live.json"), JSON.stringify(out, null, 1) + "\n");
    server.close();
  }
}

/** The harness rows R3, R4 and K1 to K4: the recorder through the stage (Playwright 1.65.0), scored as the harness scores. */
async function harnessKeys(o: StageContext, ctx: any, port: number, recs: Rec[], out: Record<string, unknown>): Promise<void> {
  const REC = `http://rec.a.localhost:${port}/recorder.html?sink=1&run=keys&box=${encodeURIComponent(`http://box.b.localhost:${port}/box.html`)}`;
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
  const TEXTS = ["Hello World, OK!", "Sorry, the three of them are at the theatre then.", "The Quick Brown Fox, at 10:45! Then home.", "she sells sea shells by the sea shore"];
  try {
    await page.goto(REC);
    for (let end = Date.now() + 15_000; Date.now() < end && !lastOf("layout"); ) await sleep(100);
    await step("idle", "idle 1 s", () => sleep(1000));
    await step("type", `locator('#f').click(); keyboard.type('${TEXTS[0]}')`, async () => { await page.locator("#f").click(); await page.keyboard.type(TEXTS[0]); }, widthOf("f"));
    await step("click", "locator('#b').click()", () => page.locator("#b").click(), widthOf("b"));
    await step("type", "locator('#ta').pressSequentially(...) (no focus)", () => page.locator("#ta").pressSequentially(TEXTS[1]));
    await step("click", "locator('#b').click()", () => page.locator("#b").click(), widthOf("b"));
    await step("fill", "locator('#f').fill('jane.doe@example.com') (no focus)", () => page.locator("#f").fill("jane.doe@example.com"));
    await step("type", "keyboard.type(...) (capitals and symbols)", async () => { await page.keyboard.press("End"); await page.keyboard.type(" " + TEXTS[2]); });
    await step("click", "locator('#b').click()", () => page.locator("#b").click(), widthOf("b"));
    await step("fill", "locator('#ta').fill(...) (no focus)", () => page.locator("#ta").fill(TEXTS[3]));
    await step("type", "keyboard.type(...) (a second text for K1 per key)", async () => { await page.keyboard.press("End"); await page.keyboard.type(" " + TEXTS[3] + " " + TEXTS[1]); });
  } finally { await page.close().catch(() => {}); }
  await sleep(1500);
  const mine = recs.filter((r: any) => !r.run || r.run === "keys");
  const lost = lostBatches(mine.filter((r: any) => r.e === "seq").map((r: any) => r.n));
  writeFileSync(join(o.run, "stage-keys-harness-results.json"), JSON.stringify({ scenarios: { stage: { t0: marks[0]?.t0 ?? 0, t1: marks.at(-1)?.t1 ?? 0, marks, recs: mine, lostBatches: lost } } }) + "\n");
  const KEY_ROWS = /^(R3\/R14|R4|K1|K2|K3|K4|K6)$/;
  for (const [label, file] of [["", process.env.STAGE_REFERENCE], [" against the person", process.env.STAGE_PERSON]] as const) {
    if (!file) { if (!label) o.record({ group: G, case: "the harness rows R3, R4 and K1 to K4", status: "skip", ms: 0, why: "no STAGE_REFERENCE" }); continue; }
    const reference = checkReference(JSON.parse(readFileSync(file, "utf8")));
    const steps = marks.map((m) => measureStep(mine, m));
    const rows = scoreSource(steps, reference, { lostBatches: lost });
    writeFileSync(join(o.run, `stage-keys-harness-report${label ? "-person" : ""}.txt`), textTable({ stage: rows }));
    (out as any)[`harness${label ? "Person" : ""}`] = { failedSteps: marks.filter((m) => !m.ok).map((m) => `${m.name}: ${m.error}`), rows: rows.filter((r) => KEY_ROWS.test(r.gap)) };
    // Against the literature the rows are bars; against the person (part B's numbers before ab-t30.13 fits them) a report.
    for (const r of rows.filter((x) => KEY_ROWS.test(x.gap)))
      o.record({ group: G, case: `harness${label} ${r.gap}: ${r.measure}`, status: label ? "pass" : r.verdict === "fail" ? "fail" : r.verdict === "pass" ? "pass" : "skip", ms: 0, detail: { bar: r.bar, value: r.value, verdict: r.verdict, n: r.n } });
  }
}
