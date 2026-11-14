// The live rows of the input stage's file chooser (board ab-t30.12.2; C11 "The input stage", files): real Playwright of
// the three pinned versions on a local *.localhost page, through the stage (the relay's endpoint, with its files in the
// run's own folder: the live rows' door AGENT_BROWSER_STAGE_FILES) and on a plain Chromium of its own (Playwright's own
// input). setInputFiles with paths, with buffers, on a hidden input's label, and through Playwright's own file chooser
// (fileChooser.setFiles) gives the client Playwright's result: the input's files (names and sizes), and the form's upload
// that the page's server gets. Through the stage the page sees a trusted press and click before the input's trusted
// `input` and `change`, no untrusted event (the harness gap R7) and no focus with no press (R14's measure); the buffers'
// files are in the scope's own folder with mode 0600.

import { createServer, type Server } from "node:http";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StageContext } from "./stage-live.ts";
import { SCOPE_FILES } from "../../../src/relay/scope-files.ts";

const G = "stage";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The page: a form with a file input, a hidden file input with a label, and a log of the page's events. */
const PAGE = `<!doctype html><meta charset=utf-8><title>files</title>
<style>body{margin:0;font:16px sans-serif} .p{position:absolute}</style>
<form id=fo class=p action=/upload method=post enctype=multipart/form-data style="left:40px;top:40px">
<input id=f type=file name=up multiple style="width:300px"> <label id=lb for=fh style="display:inline-block;padding:6px 12px;background:#ddd">Choose</label>
<input id=fh type=file name=up2 style="display:none"> <button id=go>Send</button></form>
<script>
window.__ev = [];
for (const t of ['pointerdown', 'mousedown', 'mouseup', 'click', 'focusin', 'input', 'change', 'cancel'])
  addEventListener(t, (e) => { const g = e.target; __ev.push({ type: e.type, id: g && g.id, trusted: e.isTrusted }); }, true);
</script>`;

/** The parts of a multipart body: each file's field, name and size in bytes. */
function uploads(body: Buffer, type: string): { field: string; name: string; size: number }[] {
  const b = /boundary=(.+)$/.exec(type)?.[1];
  if (!b) return [];
  const out: { field: string; name: string; size: number }[] = [], sep = Buffer.from(`--${b}`);
  let at = body.indexOf(sep);
  while (at >= 0) {
    const next = body.indexOf(sep, at + sep.length);
    if (next < 0) break;
    const part = body.subarray(at + sep.length + 2, next - 2), h = part.indexOf("\r\n\r\n");
    const head = part.subarray(0, h).toString(), m = /name="([^"]*)"; filename="([^"]*)"/.exec(head);
    if (m && m[2]) out.push({ field: m[1], name: m[2], size: part.length - h - 4 });
    at = next;
  }
  return out;
}

function server(): Promise<{ server: Server; port: number }> {
  const s = createServer((req, res) => {
    if (!/^a\.localhost:/.test(String(req.headers.host ?? ""))) { res.writeHead(404).end(); return; }
    if (req.method === "POST" && req.url === "/upload") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => res.writeHead(200, { "content-type": "text/plain" }).end(JSON.stringify(uploads(Buffer.concat(chunks), String(req.headers["content-type"] ?? "")))));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
  });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r({ server: s, port: (s.address() as any).port })));
}

type Row = { name: string; id: string; act: (p: any, files: string[]) => Promise<unknown>; trace: RegExp; label?: boolean };
const BUF = (name: string, n: number, mimeType = "text/plain") => ({ name, mimeType, buffer: Buffer.alloc(n, 0x61) });
const ROWS: Row[] = [
  { name: "setInputFiles with paths (two files)", id: "f", act: (p, f) => p.setInputFiles("#f", f), trace: /^setInputFiles: the files to the chooser's input \(filesByChooser\)$/ },
  { name: "setInputFiles with buffers (two files)", id: "f", act: (p) => p.setInputFiles("#f", [BUF("b.txt", 13), BUF("c.bin", 2048, "application/octet-stream")]), trace: /^setInputFiles: the files to the chooser's input \(filesByChooser\)$/ },
  { name: "setInputFiles with a buffer on a hidden input (its label's click)", id: "fh", label: true, act: (p) => p.locator("#fh").setInputFiles(BUF("d.txt", 100)), trace: /^setInputFiles: a click on the label and the chooser \(buffers\)$/ },
  { name: "Playwright's own file chooser: a click, then fileChooser.setFiles with a path", id: "f",
    act: async (p, f) => { const [fc] = await Promise.all([p.waitForEvent("filechooser"), p.click("#f")]); return fc.setFiles(f[0]); }, trace: /^setInputFiles: the files to the chooser's input \(filesInChooser\)$/ },
];

export async function stageFileCases(o: StageContext): Promise<void> {
  const { server: srv, port } = await server();
  const URL_ = `http://a.localhost:${port}/files`;
  const dir = o.profileDir("upload-files");
  const paths = ["a.txt", "e.csv"].map((n, i) => { const p = join(dir, n); writeFileSync(p, "x".repeat(10 + i * 90)); return p; });
  const out: Record<string, unknown> = { port, rows: [] as unknown[] };
  const stageLines = () => o.relayLines.filter((l) => l.line.startsWith("relay: the input stage"));
  try {
    for (const { version, pw } of o.pws) {
      const plain = await pw.chromium.launchPersistentContext(o.profileDir(`fplain-${version}`), {
        executablePath: o.chromium, headless: false, viewport: null, timeout: 30_000,
        env: { PATH: "/usr/bin:/bin", HOME: o.profileDir(`fhome-${version}`), DISPLAY: o.display, XAUTHORITY: o.xauth },
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
            let error: string | undefined;
            try { await row.act(p, paths); } catch (e) { error = (e as Error).message.split("\n")[0].slice(0, 200); }
            const ms = Date.now() - t0;
            await sleep(400);
            const ev: { type: string; id: string; trusted: boolean }[] = await p.evaluate(() => (window as any).__ev);
            const files = await p.evaluate((i: string) => Array.from((document.getElementById(i) as HTMLInputElement).files ?? [], (f) => ({ name: f.name, size: f.size, type: f.type })), row.id);
            // The form's upload: the page's own button, then the server's list of the files that it got.
            await Promise.all([p.waitForURL("**/upload", { timeout: 15_000 }), p.click("#go")]);
            const upload = JSON.parse(await p.textContent("body"));
            const near = ev.filter((e) => e.id === row.id || (row.label && e.id === "lb"));
            return { error, ms, files, upload, events: near.map((e) => `${e.type}:${e.id}${e.trusted ? "" : "(untrusted)"}`) };
          };
          const lines0 = stageLines().length;
          const sp = await ctx.newPage();
          const s = await run(sp).finally(() => sp.close().catch(() => {}));
          const pp = await plain.newPage();
          const q = await run(pp).finally(() => pp.close().catch(() => {}));
          const trace = stageLines().slice(lines0).map((l) => l.line.replace(/^relay: the input stage: tab \d+: /, ""));
          const strip = (fs: { name: string; size: number }[]) => fs.map((f) => ({ name: f.name, size: f.size }));
          // The client's result: Playwright's own (the input's files, the form's upload), with no error.
          const same = !s.error && !q.error && JSON.stringify(strip(s.files)) === JSON.stringify(strip(q.files)) && JSON.stringify(s.upload) === JSON.stringify(q.upload) && s.files.length > 0;
          // The page: a trusted press and click before the input's input and change, no untrusted event, no focus with no press.
          const e = s.events, at = (t: string) => e.findIndex((x: string) => x.startsWith(`${t}:${row.id}`));
          const press = e.findIndex((x: string) => x.startsWith("mousedown:")), click = e.findIndex((x: string) => x.startsWith("click:"));
          const focusNoPress = e.some((x: string, i: number) => x.startsWith("focusin:") && !e.slice(0, i).some((y: string) => y.startsWith("mousedown:")));
          const page = !e.some((x: string) => x.endsWith("(untrusted)")) && press >= 0 && click > press && at("input") > click && at("change") > at("input") && !focusNoPress && !e.some((x: string) => x.startsWith("cancel:"));
          const traced = trace.some((l) => row.trace.test(l));
          o.record({ group: G, case: `files: ${row.name} (Playwright ${version})`, status: same && page && traced ? "pass" : "fail", ms: s.ms,
            detail: { same, page, traced, focusNoPress, stage: s, own: q, trace: trace.filter((l) => /^setInputFiles/.test(l)) } });
          (out.rows as unknown[]).push({ version, row: row.name, stage: s, own: q, trace });
        }
      } finally {
        await browser.close().catch(() => {});
        await plain.close().catch(() => {});
      }
    }
    // The scope's own folder (C11, files): the buffers' files under <run>/scope-files/stage/call-*/, mode 0600, folders 0700.
    const root = join(o.run, SCOPE_FILES), scope = join(root, "stage");
    const calls = readdirSync(scope).map((c) => join(scope, c));
    const files = calls.flatMap((c) => readdirSync(c).map((n) => join(c, n)));
    const modes = { root: statSync(root).mode & 0o777, scope: statSync(scope).mode & 0o777, calls: [...new Set(calls.map((c) => statSync(c).mode & 0o777))], files: [...new Set(files.map((f) => statSync(f).mode & 0o777))] };
    const names = files.map((f) => f.split("/").pop()).sort();
    const ok = modes.root === 0o700 && modes.scope === 0o700 && modes.calls.join() === String(0o700) && modes.files.join() === String(0o600) && calls.length === 2 * o.pws.length;
    o.record({ group: G, case: "files: the buffers' files are in the scope's own folder (mode 0700 folders, a new folder for each call, 0600 files)", status: ok ? "pass" : "fail", ms: 0,
      detail: { modes: Object.fromEntries(Object.entries(modes).map(([k, v]) => [k, Array.isArray(v) ? v.map((x) => x.toString(8)) : v.toString(8)])), calls: calls.length, names } });
    out.folder = { calls: calls.length, names };
  } finally {
    writeFileSync(join(o.run, "stage-files-live.json"), JSON.stringify(out, null, 1) + "\n");
    srv.close();
  }
}
