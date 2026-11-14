// The live rows of the input stage's drag and the other script calls (board ab-t30.12.3; C11 "The input stage", the drag
// and the script calls): real Playwright of the three pinned versions on a local *.localhost page, through the stage (the
// relay's endpoint) and on a plain Chromium of its own (Playwright's own input).
// - dragTo onto a drop zone that accepts the drop: the client gets Playwright's result, and the page gets the drop with
//   its data; through the stage the page sees trusted `dragstart`, `dragenter`, `dragover` events along a path (the
//   harness gap R8: more than 5 moves or drag events with the button down before the drop), the `drop` and `dragend`,
//   and no untrusted event (R7, R15); the stage's trace names the drag's moves and drag events.
// - locator.drop (where the version has it), dispatchEvent and blur pass as with Playwright's own input: the same result
//   and the same untrusted events, which the harness counts (R7, R15: the answer Q3 a).

import { createServer, type Server } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StageContext } from "./stage-live.ts";

const G = "stage";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The page: a draggable card, a drop zone that accepts the drop, a text field and a button; a log of the page's events. */
function dragPage(): string {
  return `<!doctype html><meta charset=utf-8><title>drag</title>
<style>body{margin:0;font:16px sans-serif} .p{position:absolute}</style>
<div id=src class=p draggable=true style="left:100px;top:100px;width:120px;height:50px;background:#cde">card</div>
<div id=dst class=p style="left:560px;top:320px;width:220px;height:120px;background:#edc">zone</div>
<input id=x class=p type=text value="hello" style="left:100px;top:520px;width:200px;font-size:16px">
<button id=b class=p style="left:420px;top:520px">button</button>
<script>
window.__ev = [];
for (const t of ['mousedown', 'mousemove', 'mouseup', 'click', 'dragstart', 'dragenter', 'dragover', 'dragleave', 'drop', 'dragend', 'focus', 'blur'])
  addEventListener(t, (e) => { const g = e.target; __ev.push({ type: e.type, id: g && g.id, trusted: e.isTrusted, b: e.buttons }); }, true);
src.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', 'card-7'); });
dst.addEventListener('dragover', (e) => e.preventDefault());
dst.addEventListener('drop', (e) => { e.preventDefault(); dst.dataset.got = e.dataTransfer.getData('text/plain'); });
</script>`;
}

type Ev = { type: string; id: string; trusted: boolean; b: number };
type Row = { name: string; act: (p: any) => Promise<unknown>; drag: boolean; has?: (p: any) => boolean };
const ROWS: Row[] = [
  { name: "dragTo onto a drop zone that accepts the drop", act: (p) => p.locator("#src").dragTo(p.locator("#dst")), drag: true },
  { name: "locator.drop passes, counted (R7, R15)", act: (p) => p.locator("#dst").drop({ data: { "text/plain": "card-7" } }), drag: false, has: (p) => typeof p.locator("#dst").drop === "function" },
  { name: "dispatchEvent passes, counted (R7, R15)", act: (p) => p.locator("#b").dispatchEvent("click"), drag: false },
  { name: "blur passes, counted (blurs; R7, R15)", act: async (p) => { await p.focus("#x"); await sleep(200); await p.evaluate(() => { (window as any).__ev = []; }); return p.locator("#x").blur(); }, drag: false },
];
/** R8's measure (the harness's): the moves and the drag events with the button down from the press (here the page's dragstart: Chromium sends no press event to the page before a drag) to the drop. */
function r8(ev: Ev[]): number | null {
  const start = ev.findIndex((e) => e.type === "mousedown" || e.type === "dragstart"), drop = ev.findIndex((e) => e.type === "drop");
  if (start < 0 || drop < 0) return null;
  return ev.slice(start, drop).filter((e) => (e.type === "mousemove" && (e.b & 1)) || e.type === "dragover" || e.type === "drag").length;
}

function server(): Promise<{ server: Server; port: number }> {
  const HTML = dragPage();
  const s = createServer((req, res) => {
    const host = String(req.headers.host ?? "");
    if (!/^a\.localhost:/.test(host)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(HTML);
  });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r({ server: s, port: (s.address() as any).port })));
}

export async function stageDragCases(o: StageContext): Promise<void> {
  const { server: srv, port } = await server();
  const URL_ = `http://a.localhost:${port}/drag`;
  const out: Record<string, unknown> = { port, rows: [] as unknown[] };
  const stageLines = () => o.relayLines.filter((l) => l.line.startsWith("relay: the input stage"));
  try {
    for (const { version, pw } of o.pws) {
      const plain = await pw.chromium.launchPersistentContext(o.profileDir(`dplain-${version}`), {
        executablePath: o.chromium, headless: false, viewport: null, timeout: 30_000,
        env: { PATH: "/usr/bin:/bin", HOME: o.profileDir(`dhome-${version}`), DISPLAY: o.display, XAUTHORITY: o.xauth },
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
            const ev: Ev[] = await p.evaluate(() => (window as any).__ev);
            const got = await p.evaluate(() => document.getElementById("dst")!.dataset.got ?? null);
            const types = ev.filter((e) => e.type !== "mousemove").map((e) => `${e.type}${e.trusted ? "" : "(untrusted)"}@${e.id || "-"}`);
            return { result, error, ms, got, untrusted: ev.filter((e) => !e.trusted).map((e) => e.type), types, r8: r8(ev), moves: ev.filter((e) => e.type === "mousemove" && (e.b & 1)).length,
              dragovers: ev.filter((e) => e.type === "dragover" && e.trusted).length };
          };
          const lines0 = stageLines().length;
          const sp = await ctx.newPage();
          if (row.has && !row.has(sp)) {
            await sp.close().catch(() => {});
            o.record({ group: G, case: `the drag and the script calls: ${row.name} (Playwright ${version})`, status: "skip", ms: 0, why: `Playwright ${version} has no locator.drop` });
            continue;
          }
          const s = await run(sp).finally(() => sp.close().catch(() => {}));
          const pp = await plain.newPage();
          const q = await run(pp).finally(() => pp.close().catch(() => {}));
          const trace = stageLines().slice(lines0).map((l) => l.line.replace(/^relay: the input stage: tab \d+: /, ""));
          // The client's result: Playwright's own (the call's answer and the drop's data), with no error.
          const same = !s.error && !q.error && JSON.stringify(s.result ?? null) === JSON.stringify(q.result ?? null) && s.got === q.got;
          let page: boolean, traced = true;
          if (row.drag) {
            // A person's drag: trusted dragstart, dragenter and dragover events (more than 5: R8), the drop at the zone, dragend; no untrusted event.
            const want = ["dragstart@src", "dragenter@dst", "drop@dst", "dragend@src"];
            page = s.got === "card-7" && s.untrusted.length === 0 && want.every((w) => s.types.includes(w)) && (s.r8 ?? 0) > 5 && s.dragovers > 5
              && s.types.indexOf("dragstart@src") < s.types.indexOf("drop@dst") && s.types.indexOf("drop@dst") < s.types.indexOf("dragend@src");
            traced = trace.some((l) => /^a drag: \d+ moves with the button down, then \d+ drag events$/.test(l));
          } else page = JSON.stringify(s.untrusted) === JSON.stringify(q.untrusted) && JSON.stringify(s.types) === JSON.stringify(q.types);
          const ok = same && page && traced;
          o.record({ group: G, case: `the drag and the script calls: ${row.name} (Playwright ${version})`, status: ok ? "pass" : "fail", ms: s.ms,
            detail: { same, page, traced, R7R15: { stage: s.untrusted.length, own: q.untrusted.length }, R8: { stage: s.r8, own: q.r8 }, stage: s, own: q, trace: trace.filter((l) => /^a drag:/.test(l)) } });
          (out.rows as unknown[]).push({ version, row: row.name, stage: s, own: q, trace });
        }
      } finally {
        await browser.close().catch(() => {});
        await plain.close().catch(() => {});
      }
    }
  } finally {
    writeFileSync(join(o.run, "stage-drag-live.json"), JSON.stringify(out, null, 1) + "\n");
    srv.close();
  }
}
