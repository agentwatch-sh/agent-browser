// Extra checks of the anti-detect drive measurement (ab-v16.21), first written by the review of PR #43
// (review-43). Not part of `npm test`. Linux only, in a private Xvfb, with Chromium processes of its own
// over a pipe (no debugging port); like run.ts it never connects to a Chrome that it did not start.
//
//   node test/live/anti-detect/extra.ts --out-dir DIR [--display 122] [--exp raise|two|two-lock|two-noact|popup|jump|mem] [--n 8] [--no-window-size]
//
//   raise     the X stacking order and focus after Target.createTarget(newWindow, background), a CDP click, CDP keys and
//             Target.activateTarget (which window is above, which has the X focus)
//   two       two agents at once, each in a window of its own: each activates its window, clicks the field and types
//   two-lock  the same, with one lock that lets one agent do its activation and its input at a time
//   two-noact the same with no activation
//   popup     a page in its own window opens a target=_blank link, window.open() with no features, and window.open(..., "popup")
//   jump      the pointer at an activation: the real X pointer where Xvfb left it (over the windows), or parked outside them
//   mem       memory (PSS) and CPU of N probe pages as N windows against N background tabs
// --no-window-size starts Chromium without --window-position and --window-size (agentwatch's agent unit passes both).
// It prints one JSON object per check and writes it to DIR/<check>-XXXXXX/out.json.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { bothFocusedMs, LAYOUT, startServer, type Rec } from "./probe.ts";

const { values } = parseArgs({ options: { "out-dir": { type: "string" }, display: { type: "string" }, exp: { type: "string" }, n: { type: "string" }, "no-window-size": { type: "boolean" } } });
if (!values["out-dir"] || process.platform !== "linux") { process.stderr.write("usage (Linux only): node test/live/anti-detect/extra.ts --out-dir DIR [--display 122] [--exp raise|two|two-lock|two-noact|popup|jump|mem] [--n 8] [--no-window-size]\n"); process.exit(2); }
const DISPLAY = Number(values.display ?? 122), EXP = values.exp ?? "raise", N = Number(values.n ?? 8);
const CHECKS = ["raise", "two", "two-lock", "two-noact", "popup", "jump", "mem"];
if (!CHECKS.includes(EXP)) { process.stderr.write(`--exp takes one check of: ${CHECKS.join(", ")} (not ${JSON.stringify(EXP)})\n`); process.exit(2); }
if (!Number.isInteger(DISPLAY) || DISPLAY < 1 || !Number.isInteger(N) || N < 1) { process.stderr.write("--display and --n are whole numbers\n"); process.exit(2); }
const OUT = resolve(values["out-dir"]!);
mkdirSync(OUT, { recursive: true });
const RUN = mkdtempSync(join(OUT, `${EXP}-`));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (l: string) => process.stderr.write(`${new Date().toISOString().slice(11, 23)} ${l}\n`);
const children: ChildProcess[] = [];
process.on("exit", () => { for (const c of children.reverse()) if (c.exitCode === null) c.kill("SIGTERM"); });
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(130));

const field = (b: Buffer) => { const n = Buffer.alloc(2); n.writeUInt16BE(b.length); return Buffer.concat([n, b]); };
const xauth = join(RUN, "Xauthority");
writeFileSync(xauth, Buffer.concat([Buffer.from([0xff, 0xff]), field(Buffer.alloc(0)), field(Buffer.from(String(DISPLAY))), field(Buffer.from("MIT-MAGIC-COOKIE-1")), field(randomBytes(16))]), { mode: 0o600 });
if (existsSync(`/tmp/.X11-unix/X${DISPLAY}`)) { say(`display ${DISPLAY} in use`); process.exit(2); }
const xvfb = spawn("Xvfb", [`:${DISPLAY}`, "-auth", xauth, "-nolisten", "tcp", "-screen", "0", "1600x1000x24"], { stdio: "ignore" });
children.push(xvfb);
for (let i = 0; i < 50 && !existsSync(`/tmp/.X11-unix/X${DISPLAY}`); i++) await sleep(100);
await sleep(300);
const XENV: NodeJS.ProcessEnv = { ...process.env, DISPLAY: `:${DISPLAY}`, XAUTHORITY: xauth };
delete XENV.WAYLAND_DISPLAY; delete XENV.XDG_SESSION_TYPE;
say(`Xvfb pid ${xvfb.pid} run ${RUN}`);
const xdo = (...a: string[]) => execFileSync("xdotool", a, { env: XENV, encoding: "utf8", timeout: 5000 }).trim();

const log: Rec[] = [];
const { server, port } = await startServer(log);
const urlOf = (tab: string) => `http://probe.localhost:${port}/p?tab=${tab}`;
const loaded = async (tab: string) => { for (let i = 0; i < 150; i++) { if (log.some((e) => e.tab === tab && e.ev === "load")) return; await sleep(100); } throw new Error(`no load ${tab}`); };

const ARGS = ["--remote-debugging-pipe", "--no-first-run", "--no-default-browser-check", "--ozone-platform=x11", "--password-store=basic",
  "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-default-apps",
  "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE probe.localhost", "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=probe.localhost",
  "--window-position=0,0", "--window-size=1100,700", "--disable-backgrounding-occluded-windows"]
  .filter((a) => !values["no-window-size"] || !/^--window-(position|size)=/.test(a));
class Pipe {
  proc: ChildProcess; dir: string; private buf = ""; private id = 1; private pend = new Map<number, (m: any) => void>();
  constructor(name: string, urls: string[]) {
    this.dir = join(RUN, `profile-${name}`); mkdirSync(this.dir, { recursive: true });
    const fd = openSync(join(RUN, `chrome-${name}.log`), "a");
    this.proc = spawn("/usr/bin/chromium", [...ARGS, `--user-data-dir=${this.dir}`, ...urls], { env: XENV, stdio: ["ignore", fd, fd, "pipe", "pipe"] });
    children.push(this.proc);
    say(`chromium ${name} pid ${this.proc.pid}`);
    const r = this.proc.stdio[4] as Readable; r.setEncoding("utf8");
    r.on("data", (d: string) => { this.buf += d; for (let i; (i = this.buf.indexOf("\0")) >= 0;) { const m = JSON.parse(this.buf.slice(0, i)); this.buf = this.buf.slice(i + 1); if (typeof m.id === "number") this.pend.get(m.id)?.(m); } });
  }
  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = this.id++;
    return new Promise((res, rej) => { this.pend.set(id, (m) => { this.pend.delete(id); m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result); }); (this.proc.stdio[3] as Writable).write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0"); });
  }
  async stop() {
    if (this.proc.exitCode !== null) return;
    this.proc.kill("SIGTERM");
    for (let i = 0; i < 50 && this.proc.exitCode === null; i++) await sleep(100);
    if (this.proc.exitCode === null) { this.proc.kill("SIGKILL"); for (let i = 0; i < 20 && this.proc.exitCode === null; i++) await sleep(100); } // our own child only, by its pid
  }
}
const winOf = (pid: number, tab: string) => { for (const id of xdo("search", "--onlyvisible", "--pid", String(pid)).split("\n").filter(Boolean)) { try { if (xdo("getwindowname", id).startsWith(`probe ${tab}`)) return id; } catch {} } throw new Error(`no window ${tab}`); };
const raise = async (w: string) => { xdo("windowraise", w); xdo("windowfocus", w); await sleep(300); };
/** Top-level windows of the X root, top-most first (xwininfo lists children top to bottom), as decimal ids. */
const stack = () => execFileSync("xwininfo", ["-root", "-children"], { env: XENV, encoding: "utf8" }).split("\n").map((l) => /^\s+(0x[0-9a-f]+)/.exec(l)?.[1]).filter(Boolean).map((h) => String(parseInt(h!, 16)));
const targetOf = async (c: Pipe, tab: string) => ((await c.send("Target.getTargets")).targetInfos as any[]).find((t) => t.url.includes(`tab=${tab}`)).targetId as string;

function human(c: Pipe, sid: string) {
  let at = { x: LAYOUT.neutral.x, y: LAYOUT.neutral.y };
  const s = (m: string, p: object) => c.send(m, p, sid);
  const move = async (to: { x: number; y: number }) => { for (let i = 1; i <= 20; i++) { const q = i / 20, e = q * q * q * (10 - 15 * q + 6 * q * q); await s("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x + (to.x - at.x) * e + (i === 20 ? 0 : Math.sin(Math.PI * q) * 40), y: at.y + (to.y - at.y) * e }); await sleep(14); } at = to; };
  const click = async (to: { x: number; y: number }) => { await move(to); await sleep(120); await s("Input.dispatchMouseEvent", { type: "mousePressed", x: to.x, y: to.y, button: "left", buttons: 1, clickCount: 1, force: 0.5 }); await sleep(70); await s("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 }); };
  const key = async (k: string) => { const code = `Key${k.toUpperCase()}`, vk = k.toUpperCase().charCodeAt(0); await s("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, text: k, unmodifiedText: k }); await sleep(40); await s("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }); };
  return { click, type: async (t: string) => { for (const ch of t) { await key(ch); await sleep(90); } } };
}

const out: Record<string, unknown> = { exp: EXP };
if (EXP === "raise") {
  const c = new Pipe("raise", [urlOf("F")]); await loaded("F");
  const wf = winOf(c.proc.pid!, "F"); await raise(wf);
  const { targetId: t } = await c.send("Target.createTarget", { url: urlOf("T"), newWindow: true, background: true });
  await loaded("T"); await sleep(600);
  const wt = winOf(c.proc.pid!, "T");
  const st = (label: string) => { const s = stack(); out[label] = { focus: xdo("getwindowfocus"), Ttop: s.indexOf(wt) < s.indexOf(wf) ? "T above F" : "F above T" }; };
  // Chrome's toplevel X windows are the ones xdotool finds; their order in the root's stack tells which is above.
  st("after createTarget (no raise)");
  await raise(wf); st("after xdotool raise F");
  const { sessionId } = await c.send("Target.attachToTarget", { targetId: t, flatten: true });
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: LAYOUT.button.x, y: LAYOUT.button.y }, sessionId);
  await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: LAYOUT.button.x, y: LAYOUT.button.y, button: "left", clickCount: 1 }, sessionId);
  await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: LAYOUT.button.x, y: LAYOUT.button.y, button: "left", clickCount: 1 }, sessionId);
  await sleep(500); st("after a plain CDP click in T");
  await raise(wf); st("after xdotool raise F again");
  for (const k of "abc") { await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, text: k }, sessionId); await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: k }, sessionId); }
  await sleep(500); st("after CDP keys in T");
  await c.send("Target.activateTarget", { targetId: t }); await sleep(500); st("after Target.activateTarget(T)");
  const ev = (tab: string) => log.filter((e) => e.tab === tab && ["focus", "blur", "visibilitychange"].includes(e.ev)).map((e) => `${e.ev}:${e.vis}:${e.focus}`);
  out.F = ev("F"); out.T = ev("T");
  await c.stop();
} else if (EXP.startsWith("two")) {
  // Two agents at once, each with its own window (T1, T2 of the same site), and F in front.
  const c = new Pipe(EXP, [urlOf("F")]); await loaded("F");
  const wf = winOf(c.proc.pid!, "F"); await raise(wf);
  const ids: string[] = [];
  for (const tab of ["T1", "T2"]) { ids.push((await c.send("Target.createTarget", { url: urlOf(tab), newWindow: true, background: true })).targetId); await loaded(tab); }
  await sleep(500); await raise(wf);
  const f = await targetOf(c, "F");
  let lock = Promise.resolve();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => { if (EXP !== "two-lock") return fn(); const p = lock.then(fn); lock = p.then(() => {}, () => {}); return p; };
  const agent = async (i: number) => {
    const { sessionId } = await c.send("Target.attachToTarget", { targetId: ids[i], flatten: true });
    const h = human(c, sessionId);
    await sleep(i * 450);
    for (let r = 0; r < 6; r++) {
      await locked(async () => {
        if (EXP !== "two-noact") { await c.send("Target.activateTarget", { targetId: ids[i] }); await sleep(100); }
        await h.click(LAYOUT.field);
        await sleep(200);
        await h.type("hello");
      });
      await sleep(300 + Math.round(Math.random() * 400));
    }
  };
  const t0 = Date.now();
  await Promise.all([agent(0), agent(1)]);
  const t1 = Date.now();
  await c.send("Target.activateTarget", { targetId: f });
  await sleep(1500);
  const sorted = log.slice().sort((a, b) => a.t - b.t);
  const keysUnfocused = (tab: string) => log.filter((e) => e.tab === tab && e.ev === "in" && (e as any).type === "keydown" && (e as any).focus === false).length;
  const keysAll = (tab: string) => log.filter((e) => e.tab === tab && e.ev === "in" && (e as any).type === "keydown").length;
  const fb = (tab: string) => log.filter((e) => e.tab === tab && e.t >= t0 && (e.ev === "focus" || e.ev === "blur")).map((e) => e.ev).join(" ");
  out.ms = t1 - t0;
  out.bothFocusedT1T2 = bothFocusedMs(sorted, "T1", "T2", t0, t1);
  out.keydowns = { T1: keysAll("T1"), T2: keysAll("T2") };
  out.keydownsWhileUnfocused = { T1: keysUnfocused("T1"), T2: keysUnfocused("T2") };
  // Pointer jumps: a mouse move of more than 100 px from the last point (a real event at the X pointer at an activation,
  // then a CDP move elsewhere), as run.ts's stepSignals counts them.
  const jumps = (tab: string) => log.filter((e) => e.tab === tab && e.t >= t0).flatMap((e) => e.ev === "in" ? [e as any] : e.ev === "moves" ? (e.list as any[]) : [])
    .filter((e: any) => e.type === "mousemove" && Math.hypot(e.mx ?? 0, e.my ?? 0) > 100).length;
  out.pointerJumpsOver100 = { T1: jumps("T1"), T2: jumps("T2") };
  out.focusBlur = { T1: fb("T1"), T2: fb("T2"), F: fb("F") };
  out.fieldValues = await Promise.all(ids.map(async (id) => { const { sessionId } = await c.send("Target.attachToTarget", { targetId: id, flatten: true }); return (await c.send("Runtime.evaluate", { expression: "document.getElementById('f').value", returnByValue: true }, sessionId)).result.value; }));
  await c.stop();
} else if (EXP === "popup") {
  // A page in its own window opens a target=_blank link, window.open() with no features, and window.open() with "popup".
  const c = new Pipe("popup", [urlOf("F")]); await loaded("F");
  const wf = winOf(c.proc.pid!, "F"); await raise(wf);
  const t = (await c.send("Target.createTarget", { url: urlOf("T"), newWindow: true, background: true })).targetId;
  await loaded("T"); await sleep(500); await raise(wf);
  const { sessionId } = await c.send("Target.attachToTarget", { targetId: t, flatten: true });
  const tw = (await c.send("Browser.getWindowForTarget", { targetId: t })).windowId;
  const ev = (s: string) => c.send("Runtime.evaluate", { expression: s, returnByValue: true }, sessionId);
  await ev(`(() => { const mk = (id, top) => { const b = document.createElement("button"); b.id = id; b.style = "position:fixed;left:300px;top:" + top + "px;width:120px;height:30px"; document.body.append(b); return b; };
    const a = document.createElement("a"); a.id = "lk"; a.href = "/p?tab=P1"; a.target = "_blank"; a.textContent = "link"; a.style = "position:fixed;left:300px;top:20px;width:120px;height:30px;display:block"; document.body.append(a);
    mk("o2", 70).onclick = () => window.open("/p?tab=P2"); mk("o3", 120).onclick = () => window.open("/p?tab=P3", "", "popup,width=500,height=400"); })()`);
  const results: Record<string, unknown> = {};
  for (const [id, y, tab] of [["lk", 35, "P1"], ["o2", 85, "P2"], ["o3", 135, "P3"]] as const) {
    const t0 = Date.now();
    await c.send("Target.activateTarget", { targetId: t }); await sleep(300);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await c.send("Input.dispatchMouseEvent", { type, x: 360, y, button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0 }, sessionId);
    await loaded(tab); await sleep(1500);
    const pt = await targetOf(c, tab);
    const pw = (await c.send("Browser.getWindowForTarget", { targetId: pt })).windowId;
    const tEv = log.filter((e) => e.tab === "T" && e.t >= t0 && ["visibilitychange", "focus", "blur"].includes(e.ev)).map((e) => `${e.ev}:${e.vis}`);
    const pLoad = log.find((e) => e.tab === tab && e.ev === "load") as any;
    const pLast = log.filter((e) => e.tab === tab && e.vis).at(-1) as any;
    results[id] = { popupInOpenersWindow: pw === tw, openerEvents: tEv.join(" "), openerVisNow: log.filter((e) => e.tab === "T" && e.vis).at(-1)?.vis, popup: { vis: pLast?.vis, focus: pLast?.focus, outer: `${pLoad.ow}x${pLoad.oh}`, hl: pLoad.hl, opener: (await c.send("Target.getTargets")).targetInfos.find((x: any) => x.targetId === pt).openerId === t } };
    await c.send("Target.closeTarget", { targetId: pt }); await sleep(800);
  }
  out.popup = results;
  await c.stop();
} else if (EXP === "jump") {
  // The pointer at activation: the X pointer where Xvfb left it (over the windows), or parked outside every window.
  const res: Record<string, unknown> = {};
  for (const park of [false, true]) {
    const tag = park ? "J2" : "J1";
    const c = new Pipe(`jump-${tag}`, [urlOf(`F${tag}`)]); await loaded(`F${tag}`);
    const wf = winOf(c.proc.pid!, `F${tag}`); await raise(wf);
    const t = (await c.send("Target.createTarget", { url: urlOf(tag), newWindow: true, background: true })).targetId;
    await loaded(tag); await sleep(500); await raise(wf);
    if (park) { xdo("mousemove", "1599", "999"); await sleep(200); }
    const { sessionId } = await c.send("Target.attachToTarget", { targetId: t, flatten: true });
    const t0 = Date.now();
    await c.send("Target.activateTarget", { targetId: t }); await sleep(300);
    await human(c, sessionId).click(LAYOUT.button); await sleep(500);
    const mv = log.filter((e) => e.tab === tag && e.t >= t0).flatMap((e) => e.ev === "in" ? [e] : e.ev === "moves" ? (e.list as any[]) : []).filter((e: any) => e.type === "mousemove");
    res[park ? "parked outside the windows" : "pointer left at the screen centre"] = { first3: mv.slice(0, 3).map((e: any) => `(${e.cx},${e.cy}) mv(${e.mx},${e.my})`).join(" "), maxJumpPx: Math.max(...mv.map((e: any) => Math.hypot(e.mx, e.my))) };
    await c.stop();
  }
  out.jump = res;
} else if (EXP === "mem") {
  // Memory and CPU of N probe pages as N windows against N background tabs (all draw a rAF loop when visible).
  const pss = (dir: string) => { let kb = 0, cpu = 0; for (const p of readdirSync("/proc").filter((x) => /^\d+$/.test(x))) { try { if (!readFileSync(`/proc/${p}/cmdline`, "utf8").includes(dir)) continue; const m = /Pss:\s+(\d+)/.exec(readFileSync(`/proc/${p}/smaps_rollup`, "utf8")); if (m) kb += Number(m[1]); const st = readFileSync(`/proc/${p}/stat`, "utf8").split(") ")[1].split(" "); cpu += Number(st[11]) + Number(st[12]); } catch {} } return { mb: Math.round(kb / 1024), cpuTicks: cpu }; };
  for (const how of ["tabs", "windows"]) {
    const c = new Pipe(`mem-${how}`, [urlOf(`F-${how}`)]); await loaded(`F-${how}`);
    await raise(winOf(c.proc.pid!, `F-${how}`));
    for (let i = 0; i < N; i++) { await c.send("Target.createTarget", { url: urlOf(`${how}${i}`), ...(how === "windows" ? { newWindow: true } : {}), background: true }); await loaded(`${how}${i}`); }
    await raise(winOf(c.proc.pid!, `F-${how}`));
    await sleep(8000);
    const a = pss(c.dir); await sleep(10_000); const b = pss(c.dir);
    out[how] = { n: N, pssMB: b.mb, cpuSecondsIn10s: (b.cpuTicks - a.cpuTicks) / 100 };
    await c.stop();
  }
}
writeFileSync(join(RUN, "out.json"), JSON.stringify(out, null, 2));
process.stdout.write(JSON.stringify(out, null, 2) + "\n");
server.close();
process.exit(0);
