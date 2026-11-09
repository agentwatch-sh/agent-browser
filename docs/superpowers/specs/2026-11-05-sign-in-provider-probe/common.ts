// The shared parts of the sign-in provider probe (board task ab-v16.45): the run folder, the fake hosts, a private
// Xvfb and Chromium processes that the probe starts itself. It stops only the processes that it started, by the pids
// that it recorded (results: pids). It deletes nothing.

import { harnessGuard, reservedDisplay } from "../../../../test/live/guard.ts";

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeCert, startSite, type Hit } from "./site.ts";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const CHROMIUM = process.env.CHROMIUM ?? "/usr/bin/chromium";
export const PORT = Number(process.env.PORT ?? 8461);
export const DISPLAY_N = Number(process.env.DISPLAY_N ?? 145);
if (!Number.isInteger(DISPLAY_N) || DISPLAY_N < 1) { process.stderr.write("DISPLAY_N is a positive whole number\n"); process.exit(2); }
const reserved = reservedDisplay(DISPLAY_N, "DISPLAY_N");
if (reserved) { process.stderr.write(`${reserved}\n`); process.exit(2); }
export const RUN = resolve(process.env.RUN ?? "");
if (!process.env.RUN) { process.stderr.write("usage: RUN=<empty folder> PART=... node probe.ts\n"); process.exit(2); }
export const S = `https://site.test:${PORT}`, P = `https://tenant.auth0.test:${PORT}`, M = `https://manage.auth0.test:${PORT}`, O = `https://other.test:${PORT}`;
const t0 = Date.now();
export const now = () => Date.now() - t0;

const harness = await harnessGuard("documentation probe");

mkdirSync(join(RUN, "logs"), { recursive: true });
mkdirSync(join(RUN, "home"), { recursive: true });
chmodSync(RUN, 0o700);
export const logLine = (file: string, text: string) => appendFileSync(join(RUN, "logs", file), `${new Date().toISOString()} ${text}\n`);

export const pids: Record<string, number[]> = { xvfb: [], chromium: [] };
const children: ChildProcess[] = [];

export const cert = makeCert(RUN);
export const site = startSite({ port: PORT, key: cert.key, cert: cert.cert, now });
await site.ready;
export const hits: Hit[] = site.hits;
/** The site's hits since `at` (probe ms), short: host, method, path. */
export const hitsSince = (at: number) => hits.filter((h) => h.at >= at);

export const xauth = join(RUN, "xauth");
export async function startXvfb(): Promise<void> {
  const field = (b: Buffer) => Buffer.concat([Buffer.from([b.length >> 8, b.length & 255]), b]);
  writeFileSync(xauth, Buffer.concat([Buffer.from([0xff, 0xff]), field(Buffer.alloc(0)), field(Buffer.from(String(DISPLAY_N))), field(Buffer.from("MIT-MAGIC-COOKIE-1")), field(randomBytes(16))]), { mode: 0o600 });
  if (existsSync(`/tmp/.X11-unix/X${DISPLAY_N}`) || existsSync(`/tmp/.X${DISPLAY_N}-lock`)) throw new Error(`display :${DISPLAY_N} is taken`);
  const out = openSync(join(RUN, "logs/xvfb.log"), "a");
  const x = spawn("Xvfb", [`:${DISPLAY_N}`, "-nolisten", "tcp", "-auth", xauth, "-screen", "0", "1280x900x24"], { stdio: ["ignore", out, out] });
  harness.track(x.pid, "Xvfb");
  pids.xvfb.push(x.pid!);
  children.push(x);
  for (let i = 0; i < 50 && !existsSync(`/tmp/.X11-unix/X${DISPLAY_N}`); i++) await sleep(200);
}
export const xenv = () => ({ PATH: "/usr/bin:/bin", HOME: join(RUN, "home"), LANG: "en_US.UTF-8", DISPLAY: `:${DISPLAY_N}`, XAUTHORITY: xauth });

/** The agent unit's argv (agentwatch daemon/browser/unit.py, as the agent-mode live test), with the fake hosts and the probe's certificate. */
export function chromiumArgs(profile: string, extra: string[]): string[] {
  return [`--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--password-store=basic", "--silent-debugger-extension-api",
    "--enable-unsafe-swiftshader", "--lang=en-US", "--window-position=0,0", "--window-size=1280,900", "--disable-backgrounding-occluded-windows",
    `--host-resolver-rules=MAP site.test 127.0.0.1, MAP tenant.auth0.test 127.0.0.1, MAP manage.auth0.test 127.0.0.1, MAP other.test 127.0.0.1, EXCLUDE localhost`,
    `--ignore-certificate-errors-spki-list=${cert.spki}`, ...extra, "about:blank"];
}

export function startChromium(args: string[], o: { pipe?: boolean } = {}): ChildProcess {
  const out = openSync(join(RUN, "logs/chromium.log"), "a");
  const c = spawn(CHROMIUM, args, { env: xenv(), stdio: o.pipe ? ["ignore", out, out, "pipe", "pipe"] : ["ignore", out, out] });
  harness.track(c.pid, "Chromium");
  pids.chromium.push(c.pid!);
  children.push(c);
  return c;
}

/** Stop one child that this run started: SIGTERM, then SIGKILL after 3 s. */
export async function stopChild(c: ChildProcess): Promise<void> {
  if (c.exitCode !== null || c.signalCode !== null) return;
  const gone = new Promise<boolean>((r) => c.once("exit", () => r(true)));
  c.kill("SIGTERM");
  if (await Promise.race([gone, sleep(3000).then(() => false)])) return;
  c.kill("SIGKILL");
  await Promise.race([gone, sleep(2000)]);
}
export function track(c: ChildProcess): ChildProcess { children.push(c); harness.track(c.pid, "child"); return c; }
export async function stopAll(): Promise<void> {
  for (const c of [...children].reverse()) await stopChild(c);
  await new Promise<void>((r) => site.server.close(() => r()));
}

/** Chromium's debugging pipe (part "initiator" only): NUL-separated JSON on fds 3 and 4. */
export class Pipe {
  private next = 1;
  private buf = "";
  private readonly pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  readonly events: { method: string; params: any; sessionId?: string }[] = [];
  private readonly c: ChildProcess;
  constructor(c: ChildProcess) {
    this.c = c;
    (c.stdio[4] as NodeJS.ReadableStream).on("data", (d: Buffer) => {
      this.buf += d.toString("utf8");
      let i;
      while ((i = this.buf.indexOf("\0")) >= 0) {
        const m = JSON.parse(this.buf.slice(0, i));
        this.buf = this.buf.slice(i + 1);
        if (m.id !== undefined) { const p = this.pending.get(m.id); this.pending.delete(m.id); if (m.error) p?.rej(new Error(m.error.message)); else p?.res(m.result); }
        else this.events.push(m);
      }
    });
  }
  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = this.next++;
    (this.c.stdio[3] as NodeJS.WritableStream).write(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }) + "\0");
    return Promise.race([new Promise((res, rej) => this.pending.set(id, { res, rej })), sleep(15_000).then(() => { throw new Error(`no answer to ${method}`); })]);
  }
  async evaluate(sessionId: string, expression: string): Promise<any> {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
}
