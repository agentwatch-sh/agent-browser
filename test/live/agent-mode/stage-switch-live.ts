// The live rows of the input stage's build switch (board ab-t30.24; C11 "The input stage", the build switch): the relay
// runs as the daemon starts it, with no variable of the stage's tests (no AGENT_BROWSER_INPUT_STAGE, so no test
// clipboard and no test folder of files), and the stage is on because the build switch is on. Real Playwright of the
// three pinned versions on a local *.localhost page, through the stage (the relay's endpoint) and on a plain Chromium of
// its own (Playwright's own input), one essential row of each part of the stage: a click, a type of a short text, a fill
// of a long text, a scroll into view, a selectOption, setInputFiles (paths from a client with isLocal, and buffers), a
// dragTo; then agent-browser's own commands over the endpoint. Each row records the client's result, the page's events
// and the time of the action through the stage and with Playwright's own input.
// - The relay of the daemon has no display, so a long text goes as Playwright's own input there (C11, the paste, rule 2:
//   the trace names "no paste: noClipboard"), and it has no folder of files, so a set files call passes, counted (C11,
//   files: "The relay of the old path has no folder").

import { createServer, type Server } from "node:http";
import { execFile, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StageContext } from "./stage-live.ts";

const G = "stage";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LONG = Array.from({ length: 60 }, (_, i) => `Line ${i + 1}: the quick brown fox jumps over the lazy dog.`).join("\n");

/** The page: one element for each row; a log of the page's events with isTrusted. */
function switchPage(): string {
  return `<!doctype html><meta charset=utf-8><title>switch</title>
<style>body{margin:0;font:16px sans-serif;height:3200px} .p{position:absolute}</style>
<button id=b class=p style="left:100px;top:80px;width:120px;height:40px">button</button>
<input id=t class=p type=text style="left:100px;top:160px;width:300px;font-size:16px">
<textarea id=area class=p style="left:100px;top:220px;width:420px;height:120px"></textarea>
<select id=s class=p style="left:100px;top:380px;font-size:16px"><option value=a>Alpha</option><option value=b>Beta</option><option value=c>Gamma</option></select>
<input id=f class=p type=file style="left:100px;top:440px">
<div id=src class=p draggable=true style="left:640px;top:80px;width:120px;height:50px;background:#cde">card</div>
<div id=dst class=p style="left:820px;top:300px;width:220px;height:120px;background:#edc">zone</div>
<div id=far class=p style="left:100px;top:2400px;width:200px;height:40px;background:#dec">far</div>
<script>
window.__ev = [];
for (const t of ['mousedown', 'mouseup', 'click', 'keydown', 'keyup', 'beforeinput', 'input', 'change', 'wheel', 'dragstart', 'dragenter', 'dragover', 'drop', 'dragend', 'paste'])
  addEventListener(t, (e) => { const g = e.target, d = document.documentElement.dataset, k = e.isTrusted ? 'tr' : 'un'; __ev.push({ type: e.type, id: (g && g.id) || '-', trusted: e.isTrusted }); d[k] = String(Number(d[k] || 0) + 1); }, true);
b.addEventListener('click', () => { b.dataset.n = String(Number(b.dataset.n || 0) + 1); });
src.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', 'card-7'); });
dst.addEventListener('dragover', (e) => e.preventDefault());
dst.addEventListener('drop', (e) => { e.preventDefault(); dst.dataset.got = e.dataTransfer.getData('text/plain'); });
</script>`;
}

type Ev = { type: string; id: string; trusted: boolean };
type Row = {
  name: string;
  act: (p: any, file: string) => Promise<unknown>;
  /** What the client gets from the page after the action (the same through the stage and with Playwright's own input). */
  read: (p: any) => Promise<unknown>;
  want: (got: any) => boolean;
  /** The page's trusted events through the stage, in order (each at least once). */
  trusted: string[];
  /** A client with isLocal (setInputFiles with paths: DOM.setFileInputFiles). */
  local?: boolean;
  /** C11 sends the call as the client sent it here (the relay of the daemon has no folder): the same events as Playwright's own. */
  passes?: boolean;
  trace?: RegExp;
};
const value = (id: string) => (p: any) => p.evaluate((i: string) => (document.getElementById(i) as HTMLInputElement).value, id);
const files = (p: any) => p.evaluate(() => Array.from((document.getElementById("f") as HTMLInputElement).files ?? [], (f) => `${f.name}:${f.size}`));
const ROWS: Row[] = [
  { name: "click", act: (p) => p.click("#b"), read: (p) => p.evaluate(() => document.getElementById("b")!.dataset.n ?? "0"), want: (n) => n === "1", trusted: ["mousedown@b", "mouseup@b", "click@b"] },
  { name: "type of a short text (pressSequentially)", act: (p) => p.locator("#t").pressSequentially("Hello, World"), read: value("t"), want: (v) => v === "Hello, World", trusted: ["keydown@t", "input@t", "keyup@t"] },
  { name: `fill of a long text (${LONG.length} characters)`, act: (p) => p.fill("#area", LONG), read: value("area"), want: (v) => v === LONG, trusted: ["input@area"], trace: /^a text as it is \(.*no paste: noClipboard\)$/ },
  { name: "scroll into view (scrollIntoViewIfNeeded)", act: (p) => p.locator("#far").scrollIntoViewIfNeeded(), read: (p) => p.evaluate(() => { const r = document.getElementById("far")!.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }), want: (v) => v === true, trusted: ["wheel"] },
  { name: "selectOption", act: (p) => p.selectOption("#s", "c"), read: value("s"), want: (v) => v === "c", trusted: ["change@s"] },
  { name: "setInputFiles with a path (a client with isLocal)", local: true, act: (p, f) => p.setInputFiles("#f", f), read: files, want: (v) => JSON.stringify(v) === JSON.stringify(["switch.txt:13"]), trusted: ["click@f", "input@f", "change@f"], trace: /^setInputFiles: a click on the input and the chooser \(paths\)$/ },
  { name: "setInputFiles with a buffer (the relay has no folder: it passes, counted)", passes: true, act: (p) => p.setInputFiles("#f", { name: "buf.txt", mimeType: "text/plain", buffer: Buffer.from("from a buffer") }), read: files, want: (v) => JSON.stringify(v) === JSON.stringify(["buf.txt:13"]), trusted: [] },
  { name: "dragTo onto a drop zone", act: (p) => p.locator("#src").dragTo(p.locator("#dst")), read: (p) => p.evaluate(() => document.getElementById("dst")!.dataset.got ?? null), want: (v) => v === "card-7", trusted: ["dragstart@src", "dragenter@dst", "drop@dst", "dragend@src"] },
];

function server(): Promise<{ server: Server; port: number }> {
  const HTML = switchPage();
  const s = createServer((req, res) => {
    const host = String(req.headers.host ?? "");
    if (!/^a\.localhost:/.test(host)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(HTML);
  });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r({ server: s, port: (s.address() as any).port })));
}

/** The run: one row on one page; the time of the action alone. */
async function runRow(p: any, url: string, row: Row, file: string) {
  await p.goto(url);
  await p.waitForFunction(() => document.readyState === "complete");
  await sleep(300);
  await p.evaluate(() => { (window as any).__ev = []; });
  const t0 = Date.now();
  let error: string | undefined;
  try { await row.act(p, file); } catch (e) { error = (e as Error).message.split("\n")[0].slice(0, 200); }
  const ms = Date.now() - t0;
  await sleep(400);
  const ev: Ev[] = await p.evaluate(() => (window as any).__ev);
  const got = error ? null : await row.read(p);
  const kinds = (es: Ev[]) => [...new Set(es.map((e) => `${e.type}@${e.id}`))];
  return { error, ms, got, untrusted: kinds(ev.filter((e) => !e.trusted)), trustedKinds: kinds(ev.filter((e) => e.trusted)), events: ev.length };
}

export async function stageSwitchCases(o: StageContext & { relayBin: string; tracked: (c: ChildProcess) => ChildProcess }): Promise<void> {
  const { server: srv, port } = await server();
  const URL_ = `http://a.localhost:${port}/switch`;
  const out: Record<string, unknown> = { port, rows: [] as unknown[], cli: [] as unknown[] };
  const stageLines = () => o.relayLines.filter((l) => l.line.startsWith("relay: the input stage"));
  const dir = join(o.run, "switch-files");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "switch.txt");
  writeFileSync(file, "a file here.\n");
  try {
    for (const { version, pw } of o.pws) {
      const plain = await pw.chromium.launchPersistentContext(o.profileDir(`wplain-${version}`), {
        executablePath: o.chromium, headless: false, viewport: null, timeout: 30_000,
        env: { PATH: "/usr/bin:/bin", HOME: o.profileDir(`whome-${version}`), DISPLAY: o.display, XAUTHORITY: o.xauth },
        args: ["--no-first-run", "--no-default-browser-check", "--password-store=basic", "--window-size=1280,900", "--window-position=0,0",
          "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE a.localhost", "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=a.localhost"],
      });
      const browser = await pw.chromium.connectOverCDP(o.url("stage"), { timeout: 20_000 });
      const local = await pw.chromium.connectOverCDP(o.url("stage"), { timeout: 20_000, isLocal: true });
      try {
        for (const row of ROWS) {
          const lines0 = stageLines().length;
          const sp = await (row.local ? local : browser).contexts()[0].newPage();
          const s = await runRow(sp, URL_, row, file).finally(() => sp.close().catch(() => {}));
          const trace = stageLines().slice(lines0).map((l) => l.line.replace(/^relay: the input stage: tab \d+: /, ""));
          const pp = await plain.newPage();
          const q = await runRow(pp, URL_, row, file).finally(() => pp.close().catch(() => {}));
          // The client's result: Playwright's own (no error, and the page holds what the call asked for).
          const same = !s.error && !q.error && row.want(s.got) && JSON.stringify(s.got) === JSON.stringify(q.got);
          // The page: through the stage, trusted events of the action and no untrusted one; a call that passes: Playwright's own events.
          const page = row.passes ? JSON.stringify(s.untrusted) === JSON.stringify(q.untrusted) && JSON.stringify(s.trustedKinds) === JSON.stringify(q.trustedKinds)
            : s.untrusted.length === 0 && row.trusted.every((k) => s.trustedKinds.some((x) => (k.includes("@") ? x === k : x.startsWith(`${k}@`))));
          const traced = row.trace ? trace.some((l) => row.trace!.test(l)) : true;
          const ok = same && page && traced;
          o.record({ group: G, case: `the switch on: ${row.name} (Playwright ${version})`, status: ok ? "pass" : "fail", ms: s.ms,
            detail: { same, page, traced, ms: { stage: s.ms, own: q.ms }, stage: s, own: q, trace: trace.slice(0, 12) } });
          (out.rows as unknown[]).push({ version, row: row.name, ok, ms: { stage: s.ms, own: q.ms }, stage: s, own: q, trace });
        }
      } finally {
        await browser.close().catch(() => {});
        await local.close().catch(() => {});
        await plain.close().catch(() => {});
      }
    }
    await cliCases(o, URL_, out);
    // The relay ran with no door of the stage's tests: no line of a test clipboard or of a test folder of files.
    const doors = o.relayLines.filter((l) => /the live rows' door/.test(l.line)).length;
    const traced = stageLines().length;
    o.record({ group: G, case: "the switch on: the relay runs with no variable of the stage's tests, and the stage is on (its trace lines), with no test door", status: doors === 0 && traced > 0 ? "pass" : "fail", ms: 0,
      detail: { doors, stageLines: traced, variable: process.env.AGENT_BROWSER_INPUT_STAGE ?? null } });
  } finally {
    writeFileSync(join(o.run, "stage-switch-live.json"), JSON.stringify(out, null, 1) + "\n");
    srv.close();
  }
}

/** agent-browser's own commands over the endpoint (the stage's scope): open, type --into, click, the field's value, close. */
async function cliCases(o: StageContext & { relayBin: string; tracked: (c: ChildProcess) => ChildProcess }, url: string, out: Record<string, unknown>): Promise<void> {
  const state = join(o.run, "switch-ab-state"), allow = join(o.run, "switch-allow.json");
  writeFileSync(allow, JSON.stringify({ allow: ["a.localhost"] }));
  // Not execFileSync: the stand-in daemon runs in this process, and a blocked event loop would hold every bridge message.
  const cli = (...args: string[]) => new Promise<any>((resolve) => {
    o.tracked(execFile(process.execPath, [o.relayBin, ...args, "--cdp-url", o.url("stage"), "--state-dir", state, "--allowlist", allow, "--no-launch", "--json"], { encoding: "utf8", timeout: 60_000 }, (e, stdout) => {
      try { resolve(JSON.parse(stdout)); } catch { resolve({ ok: false, error: { message: e?.message ?? "no output" } }); }
    }));
  });
  const steps: [string, string[], (r: any) => boolean][] = [
    ["open", ["open", url, "--name", "sw"], (r) => r.tab?.name === "sw"],
    ["type --into (a click on the field, then keys)", ["type", "sw", "Lin", "--into", "#t"], (r) => r.length === 3],
    ["click", ["click", "sw", "#b"], () => true],
    // The page's counts are in the DOM (document.documentElement.dataset), so the world of the eval does not matter.
    ["the field's value, the button's clicks and the page's events", ["eval", "sw", "JSON.stringify([document.getElementById('t').value, document.getElementById('b').dataset.n, document.documentElement.dataset.un || '0', document.documentElement.dataset.tr || '0'])"],
      (r) => { const [v, n, untrusted, trusted] = JSON.parse(r.value); return v === "Lin" && n === "1" && untrusted === "0" && Number(trusted) > 0; }],
    ["close", ["close", "sw"], (r) => r.ok === true],
  ];
  for (const [name, args, want] of steps) {
    const lines0 = o.relayLines.filter((l) => l.line.startsWith("relay: the input stage")).length;
    const t0 = Date.now();
    const r = await cli(...args);
    const ms = Date.now() - t0;
    const trace = o.relayLines.filter((l) => l.line.startsWith("relay: the input stage")).slice(lines0).map((l) => l.line.replace(/^relay: the input stage: tab \d+: /, ""));
    const ok = r.ok !== false && want(r);
    o.record({ group: G, case: `the switch on: agent-browser ${name}`, status: ok ? "pass" : "fail", ms, detail: { result: r, trace: trace.slice(0, 12) } });
    (out.cli as unknown[]).push({ name, ok, ms, result: r, trace });
  }
}
