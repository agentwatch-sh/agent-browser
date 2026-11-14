// The live rows of the input stage's script calls (board ab-t30.12.1; C11 "The input stage", the script calls): real
// Playwright of the three pinned versions on a local *.localhost page, through the stage (the relay's endpoint) and on a
// plain Chromium of its own (Playwright's own input). Each translated call (selectOption by keys and by typed letters, the
// fill of a date, a time and a range input, selectText) gives the client Playwright's result, and the page sees no
// untrusted `input` or `change` (the harness gap R7: untrusted events); each passed call (blur, the fill of a color input)
// goes as with Playwright's own input, and the stage counts it.

import { createServer, type Server } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StageContext } from "./stage-live.ts";

const G = "stage";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NAMES = ["Afghanistan", "Albania", "Algeria", "Andorra", "Angola", "Argentina", "Armenia", "Australia", "Austria", "Belgium", "Brazil", "Canada",
  "Chile", "China", "Denmark", "Egypt", "France", "Georgia", "Germany", "Ghana", "Greece", "India", "Italy", "Japan", "Kenya", "Mexico", "Niger", "Nigeria",
  "Norway", "Peru", "Poland", "Spain", "Sweden", "Togo", "United Kingdom", "United States", "Zambia"];

/** The page: a select, a long select, picker inputs, a range, a color input and a text field; a log of the page's events. */
function scriptPage(): string {
  const opt = (v: string, l: string, x = "") => `<option value="${v}"${x}>${l}</option>`;
  return `<!doctype html><meta charset=utf-8><title>script calls</title>
<style>body{margin:0;font:16px sans-serif} .p{position:absolute}</style>
<select id=s class=p style="left:40px;top:40px;width:200px;font-size:16px">${["A", "B", "C", "D", "E", "F", "G", "H"].map((k) => opt(k.toLowerCase(), `Item ${k}`, k === "C" ? " disabled" : k === "E" ? " hidden" : "")).join("")}</select>
<select id=big class=p style="left:300px;top:40px;width:240px;font-size:16px">${NAMES.map((n) => opt(n.toLowerCase().replace(/ /g, "-"), n)).join("")}</select>
<input id=d class=p type=date style="left:40px;top:120px;width:240px;font-size:16px">
<input id=t class=p type=time style="left:300px;top:120px;width:200px;font-size:16px">
<input id=r class=p type=range min=0 max=100 step=1 value=50 style="left:40px;top:190px;width:300px">
<input id=c class=p type=color value="#112233" style="left:400px;top:180px;width:80px;height:40px">
<input id=x class=p type=text value="hello world" style="left:40px;top:260px;width:240px;font-size:16px">
<script>
window.__ev = [];
for (const t of ['pointerdown', 'mousedown', 'click', 'keydown', 'input', 'change', 'select', 'focus', 'blur'])
  addEventListener(t, (e) => { const g = e.target; __ev.push({ type: e.type, id: g && g.id, trusted: e.isTrusted }); }, true);
</script>`;
}

/** The rows: the call, the field, and whether the stage translates it (else it passes, counted). */
type Row = { name: string; id: string; act: (p: any) => Promise<unknown>; translated: boolean; trace: RegExp | null; read: (p: any) => Promise<unknown> };
const val = (id: string) => (p: any) => p.evaluate((i: string) => { const e = document.getElementById(i) as any; return e.value; }, id);
const ROWS: Row[] = [
  { name: "selectOption by the arrow keys (past a disabled and a hidden option)", id: "s", act: (p) => p.selectOption("#s", "f"), translated: true, trace: /^selectOption: a click and 4 keys$/, read: val("s") },
  { name: "selectOption of a long list by typed letters", id: "big", act: (p) => p.selectOption("#big", { label: "Nigeria" }), translated: true, trace: /^selectOption: a click and \d+ keys$/, read: val("big") },
  { name: "fill of a date input", id: "d", act: (p) => p.fill("#d", "2026-12-31"), translated: true, trace: /^the fill of a date input: a click and 8 keys$/, read: val("d") },
  { name: "fill of a time input (12 hours)", id: "t", act: (p) => p.fill("#t", "21:30"), translated: true, trace: /^the fill of a time input: a click and 5 keys$/, read: val("t") },
  { name: "fill of a range input", id: "r", act: (p) => p.fill("#r", "80"), translated: true, trace: null, read: val("r") },
  { name: "selectText of a text input", id: "x", act: (p) => p.locator("#x").selectText(), translated: true, trace: /^selectText: the select-all chord$/,
    read: (p) => p.evaluate(() => { const e = document.getElementById("x") as HTMLInputElement; return [e.selectionStart, e.selectionEnd, document.activeElement?.id]; }) },
  { name: "blur passes, counted", id: "x", act: async (p) => { await p.focus("#x"); await sleep(200); await p.evaluate(() => { (window as any).__ev = []; }); return p.locator("#x").blur(); }, translated: false, trace: null,
    read: (p) => p.evaluate(() => document.activeElement?.id ?? null) },
  { name: "fill of a color input passes, counted", id: "c", act: (p) => p.fill("#c", "#ff0000"), translated: false, trace: /^no focus click \(fieldNotText\)$/, read: val("c") },
];

function server(): Promise<{ server: Server; port: number }> {
  const HTML = scriptPage();
  const s = createServer((req, res) => {
    const host = String(req.headers.host ?? "");
    if (!/^a\.localhost:/.test(host)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(HTML);
  });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r({ server: s, port: (s.address() as any).port })));
}

export async function stageScriptCases(o: StageContext): Promise<void> {
  const { server: srv, port } = await server();
  const URL_ = `http://a.localhost:${port}/script`;
  const out: Record<string, unknown> = { port, rows: [] as unknown[] };
  const stageLines = () => o.relayLines.filter((l) => l.line.startsWith("relay: the input stage"));
  try {
    for (const { version, pw } of o.pws) {
      const plain = await pw.chromium.launchPersistentContext(o.profileDir(`splain-${version}`), {
        executablePath: o.chromium, headless: false, viewport: null, timeout: 30_000,
        env: { PATH: "/usr/bin:/bin", HOME: o.profileDir(`shome-${version}`), DISPLAY: o.display, XAUTHORITY: o.xauth },
        args: ["--no-first-run", "--no-default-browser-check", "--password-store=basic", "--window-size=1280,900", "--window-position=0,0",
          "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE a.localhost", "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=a.localhost"],
      });
      const browser = await pw.chromium.connectOverCDP(o.url("stage"), { timeout: 20_000 });
      const ctx = browser.contexts()[0];
      try {
        for (const row of ROWS) {
          const run = async (p: any) => {
            await p.goto(URL_);
            await p.waitForFunction(() => document.readyState === "complete");
            await sleep(300);
            await p.evaluate(() => { (window as any).__ev = []; });
            const t0 = Date.now();
            let result: unknown, error: string | undefined;
            try { result = await row.act(p); } catch (e) { error = (e as Error).message.split("\n")[0].slice(0, 200); }
            const ms = Date.now() - t0;
            await sleep(400);
            const ev: { type: string; id: string; trusted: boolean }[] = await p.evaluate(() => (window as any).__ev);
            const mine = ev.filter((e) => e.id === row.id);
            return { result, error, ms, value: await row.read(p), untrusted: mine.filter((e) => !e.trusted).map((e) => e.type), trusted: mine.filter((e) => e.trusted).map((e) => e.type) };
          };
          const lines0 = stageLines().length;
          const sp = await ctx.newPage();
          const s = await run(sp).finally(() => sp.close().catch(() => {}));
          const pp = await plain.newPage();
          const q = await run(pp).finally(() => pp.close().catch(() => {}));
          const trace = stageLines().slice(lines0).map((l) => l.line.replace(/^relay: the input stage: tab \d+: /, ""));
          // The client's result: Playwright's own (the call's answer and the field's value), with no error.
          const same = !s.error && !q.error && JSON.stringify(s.result ?? null) === JSON.stringify(q.result ?? null) && JSON.stringify(s.value) === JSON.stringify(q.value);
          // The page: a translated call's field gets no untrusted event and a trusted pointer press; a passed call's events are Playwright's own.
          const page = row.translated ? s.untrusted.length === 0 && s.trusted.includes("mousedown") : JSON.stringify(s.untrusted) === JSON.stringify(q.untrusted);
          const traced = !row.trace || trace.some((l) => row.trace!.test(l));
          const ok = same && page && traced;
          o.record({ group: G, case: `the script calls: ${row.name} (Playwright ${version})`, status: ok ? "pass" : "fail", ms: s.ms,
            detail: { same, page, traced, stage: s, own: q, trace: trace.filter((l) => /^(selectOption|the fill|selectText|no focus click|a focus click)/.test(l)) } });
          (out.rows as unknown[]).push({ version, row: row.name, stage: s, own: q, trace });
        }
      } finally {
        await browser.close().catch(() => {});
        await plain.close().catch(() => {});
      }
    }
  } finally {
    writeFileSync(join(o.run, "stage-script-live.json"), JSON.stringify(out, null, 1) + "\n");
    srv.close();
  }
}
