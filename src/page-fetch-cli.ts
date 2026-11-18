// `agent-browser page-fetch <url> --allow-file FILE` (board ab-v16.113; the README, "PageFetch without agentwatch"): one
// PageFetch in a Chromium of its own, with no agentwatch, no service, no extension and no --cdp-url. The operator's board
// answer (2026-11-18): "this would be a use of agentbrowser without agentwatch i think. i.e. we pre-configure the browser
// in the support repo toi do what we need." The first caller is the host-side route of the support agent's unattended
// runs, on a box with no agentwatch session.
//
// - Always strict mode: --allow-file is required, `{"allow":["host","host/path",...]}` (fetch-list.ts has the rules). The
//   file belongs to the host-side route, not to the run that asks for a fetch: the command refuses a file that is not a
//   regular file (also a symbolic link) or that its group or others can write, from the mode of the opened descriptor,
//   so a swap between the check and the read does not pass. A missing, unreadable, invalid or empty file is refused too,
//   each before Chrome starts (exit 2).
// - PageFetch's own core (src/service/fetch/page-fetch.ts) with all of its rules: the fetch list first, the address rule
//   (never the box itself, never a private network) before the rate and any window, so an off-list or refused URL never
//   starts Chrome; GET and HEAD only, each other request of the window failed and counted; an off-list main document
//   refused and never followed; no cookie, key or request body (a new profile, a new browser context); downloads denied;
//   no input, no click, no form; dialogs dismissed; the caps and the 60 s limit of a fetch.
// - The core's ports over direct CDP on Chrome's pipe (directPorts): windows.create is Target.createBrowserContext and
//   Target.createTarget, fetch_end is Target.disposeBrowserContext. No lock and no rate across processes: each call is a
//   new process and a new fetch, and --offset and --max-chars cut that fetch's markdown.
// - Its own Chromium (--chrome, default /usr/bin/chromium), headless, with a new profile folder under the system's temp
//   folder that it removes after the fetch, also after an error or a signal. It never touches the agent browser's Chrome,
//   profile, state folder, socket or extension. Chrome's host resolver maps every host to NOTFOUND except the list's
//   hosts, so no other host gets even a DNS lookup or a connect (also a preconnect or a WebSocket), and its background
//   services are off.
// - The output: the MCP answer's text (the header's lines, an empty line, the markdown) on standard output, or with
//   --json one document. Exit 0 when fetched, 1 when not (the text says `Not fetched (<code>): ...`), 2 for a usage error.

import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, closeSync, constants, fstatSync, mkdtempSync, openSync, readSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { UsageError } from "./errors.ts";
import { WindowLock } from "./service/fetch/lock.ts";
import { AllowFileError, hostsOf, parseAllowFile } from "./service/fetch/fetch-list.ts";
import { FetchRefusal, FETCH_LIMITS, PageFetch, type FetchAnswer, type FetchList, type FetchModelPort, type FetchReceiver } from "./service/fetch/page-fetch.ts";
import type { Resolve } from "./service/fetch/address.ts";

export const PAGE_FETCH_USAGE = "usage: agent-browser page-fetch <url> --allow-file FILE [--mode main|whole] [--offset N] [--max-chars N] [--chrome PATH] [--json]";
/** The flags that only page-fetch takes (its --mode is the parser's old flag of the same name, which only page-fetch takes now). */
export const PAGE_FETCH_FLAGS = { "allow-file": { type: "string" }, offset: { type: "string" }, "max-chars": { type: "string" }, chrome: { type: "string" } } as const;
/** Each flag that page-fetch takes. */
const TAKES: ReadonlySet<string> = new Set([...Object.keys(PAGE_FETCH_FLAGS), "mode", "json", "help"]);
export const DEFAULT_CHROME = "/usr/bin/chromium";
/** One answer holds at most this many characters of the markdown by default (PageFetch's own part). */
export const MAX_CHARS_DEFAULT = FETCH_LIMITS.partChars;
/** The largest allow file that the command reads. */
export const ALLOW_FILE_MAX = 1024 * 1024;
/** Chrome's start: its pipe answers within this long, else the fetch is `unavailable`. */
export const CHROME_START_MS = 30_000;
/** The prefix of the profile folder under the system's temp folder. */
export const PROFILE_PREFIX = "agent-browser-page-fetch-";
/** The signals at which the command ends Chrome, removes its profile folder and exits 1. */
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

// ------------------------------------------------------------------ the allow file

/**
 * The allow file's entries and its name (its base name, for the texts: never a path of the box). The file is opened with
 * no follow of a symbolic link and with no wait (a FIFO), and the checks read the opened descriptor: a regular file, not
 * writable by its group or by others, at most ALLOW_FILE_MAX bytes. Each refusal is a UsageError (exit 2).
 */
export function readAllowFile(path: string): FetchList & { entries: string[] } {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new UsageError("--allow-file: the allow file does not exist");
    if (code === "ELOOP") throw new UsageError("--allow-file: the allow file is a symbolic link; give the file itself");
    throw new UsageError(`--allow-file: the allow file cannot be read (${code ?? "error"})`);
  }
  let text: string;
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new UsageError("--allow-file: the allow file is not a regular file");
    if ((st.mode & 0o022) !== 0) throw new UsageError("--allow-file: its group or others can write the allow file; the run that asks for a fetch must not be able to write it (chmod go-w)");
    if (st.size > ALLOW_FILE_MAX) throw new UsageError(`--allow-file: the allow file is larger than ${ALLOW_FILE_MAX} bytes`);
    const buf = Buffer.alloc(ALLOW_FILE_MAX + 1);
    let n = 0;
    for (;;) {
      let got: number;
      try { got = readSync(fd, buf, n, buf.length - n, null); }
      catch (e) { throw new UsageError(`--allow-file: the allow file cannot be read (${(e as NodeJS.ErrnoException).code ?? "error"})`); }
      if (got === 0) break;
      n += got;
      if (n > ALLOW_FILE_MAX) throw new UsageError(`--allow-file: the allow file is larger than ${ALLOW_FILE_MAX} bytes`);
    }
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(0, n)); }
    catch { throw new UsageError("--allow-file: the allow file is not UTF-8"); }
  } finally { closeSync(fd); }
  // The name in the texts: printable ASCII only (a file name can hold a newline), at most 100 characters.
  try { return { entries: parseAllowFile(text), name: basename(path).replace(/[^\x20-\x7e]/g, "?").slice(0, 100) }; }
  catch (e) { if (e instanceof AllowFileError) throw new UsageError(`--allow-file: ${e.reason}`); throw e; }
}

// ------------------------------------------------------------------ Chrome

/**
 * Chrome's arguments: headless, the new profile, the debugging pipe, the host resolver rules of the list's hosts (every
 * other host is NOTFOUND: no DNS lookup and no connect), and Chrome's background services off.
 */
export function chromeArgs(o: { profile: string; hosts: readonly string[] }): string[] {
  if (o.hosts.length === 0 || o.hosts.some((h) => !/^[a-z0-9.-]+$/.test(h))) throw new Error("the hosts must be normalized hosts");
  return [
    "--headless", `--user-data-dir=${o.profile}`, "--remote-debugging-pipe",
    `--host-resolver-rules=MAP * ~NOTFOUND, ${o.hosts.map((h) => `EXCLUDE ${h}`).join(", ")}`,
    "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-component-extensions-with-background-pages",
    "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-default-apps", "--disable-domain-reliability",
    "--disable-client-side-phishing-detection", "--safebrowsing-disable-auto-update", "--disable-breakpad", "--no-pings", "--dns-prefetch-disable",
    "--disable-features=Translate,OptimizationHints,OptimizationGuideModelDownloading,MediaRouter,DialMediaRouteProvider,AutofillServerCommunication,CertificateTransparencyComponentUpdater,InterestFeedContentSuggestions,NetworkTimeServiceQuerying,PrivacySandboxSettings4",
    "--password-store=basic", "--mute-audio", "--window-size=1280,900", "about:blank",
  ];
}

/** One CDP connection: commands (with a session for a target), and its messages with no id (the events). */
export interface Cdp {
  send(method: string, params?: Record<string, unknown>, sessionId?: string, waitMs?: number): Promise<any>;
  listen(fn: (m: { method: string; params?: any; sessionId?: string }) => void): void;
}

/** CDP over Chrome's debugging pipe (--remote-debugging-pipe): JSON messages, each ended by a NUL byte. */
export class PipeCdp implements Cdp {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private readonly listeners = new Set<(m: any) => void>();
  private buf = Buffer.alloc(0);
  private closedWhy: string | null = null;
  private readonly out: Writable;

  constructor(out: Writable, input: Readable) {
    this.out = out;
    input.on("data", (b: Buffer) => {
      this.buf = Buffer.concat([this.buf, b]);
      for (let at = this.buf.indexOf(0); at >= 0; at = this.buf.indexOf(0)) {
        const line = this.buf.subarray(0, at).toString("utf8");
        this.buf = this.buf.subarray(at + 1);
        let m: any;
        try { m = JSON.parse(line); } catch { continue; }
        this.onMessage(m);
      }
    });
    input.on("close", () => this.close("Chrome closed its debugging pipe"));
    input.on("error", () => this.close("Chrome's debugging pipe failed"));
    out.on("error", () => this.close("Chrome's debugging pipe failed"));
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string, waitMs = 30_000): Promise<any> {
    if (this.closedWhy !== null) return Promise.reject(new Error(this.closedWhy));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("timeout")); }, waitMs);
      this.pending.set(id, { resolve, reject, timer });
      this.out.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
  }

  listen(fn: (m: any) => void): void { this.listeners.add(fn); }

  private onMessage(m: any): void {
    if (typeof m?.id === "number") {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result ?? {});
      return;
    }
    if (typeof m?.method === "string") for (const f of [...this.listeners]) f(m);
  }

  close(why: string): void {
    if (this.closedWhy !== null) return;
    this.closedWhy = why;
    for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(why)); this.pending.delete(id); }
  }
}

/** A running Chrome: its connection and its end (Browser.close, then a signal; it waits for the exit). */
export type Launched = { cdp: Cdp; close(): Promise<void> };

/**
 * Start Chrome with `args` and its debugging pipe on the descriptors 3 (Chrome reads) and 4 (Chrome writes). Chrome gets no
 * DISPLAY and no WAYLAND_DISPLAY (it is headless: it never reaches a display of the box). The start waits for an answer
 * on the pipe (Browser.getVersion), at most CHROME_START_MS; an early exit gives the end of Chrome's own error output.
 */
export async function launchChrome(o: { chrome: string; args: string[]; log: (l: string) => void; startMs?: number }): Promise<Launched> {
  const env = { ...process.env };
  delete env.DISPLAY;
  delete env.WAYLAND_DISPLAY;
  const child: ChildProcess = spawn(o.chrome, o.args, { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], env });
  let err = "";
  child.stderr!.on("data", (d) => { err = (err + d).slice(-2000); });
  const exited = new Promise<number | null>((r) => { child.once("exit", (code) => r(code)); child.once("error", () => r(null)); });
  const failed = new Promise<never>((_, reject) => {
    child.once("error", (e) => reject(new Error(`Chrome did not start (${(e as NodeJS.ErrnoException).code ?? e.message})`)));
    child.once("exit", (code, signal) => reject(new Error(`Chrome ended at its start (${signal ?? `exit code ${code}`}): ${err.trim().split("\n").slice(-2).join(" | ").slice(0, 300)}`)));
  });
  failed.catch(() => {});
  const cdp = new PipeCdp(child.stdio[3] as Writable, child.stdio[4] as Readable);
  let ended = false;
  const close = async () => {
    if (ended) return;
    ended = true;
    if (child.exitCode === null && child.signalCode === null) {
      await Promise.race([cdp.send("Browser.close", {}, undefined, 2000).catch(() => {}), exited]);
      const left = await Promise.race([exited.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), 2000))]);
      if (left) {
        child.kill("SIGTERM");
        const still = await Promise.race([exited.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), 2000))]);
        if (still) { child.kill("SIGKILL"); await exited; }
      }
    }
    cdp.close("Chrome ended");
  };
  try {
    await Promise.race([cdp.send("Browser.getVersion", {}, undefined, o.startMs ?? CHROME_START_MS), failed]);
  } catch (e) {
    // An early exit also closes the pipe: its reason (Chrome's own error) wins over the pipe's.
    const why = await Promise.race([failed.catch((x: Error) => x), new Promise<Error>((r) => setTimeout(() => r(e as Error), 500))]);
    await close();
    throw why;
  }
  return { cdp, close };
}

// ------------------------------------------------------------------ the core's ports over direct CDP

/**
 * PageFetch's model port and receiver port over one CDP connection of the browser (`cdp()` starts Chrome at the first
 * window): windows.create is a new browser context (no cookie, no storage, downloads denied) and a target in it, with
 * the browser's own session on it; debugger.sendCommand sends on that session or on a child session; the events of each
 * session reach the core as the extension's debugger.onEvent; a page that a target of the context opens is a popup
 * (tabs.onCreated); fetch_end disposes the context. There is no client to hide a tab from.
 */
export function directPorts(cdp: () => Promise<Cdp>): { model: FetchModelPort; receiver: FetchReceiver } {
  const listeners = new Set<(ev: Record<string, any>) => void>();
  const emit = (ev: Record<string, any>) => { for (const f of [...listeners]) f(ev); };
  const tabs = new Map<number, { targetId: string; session: string | null }>();
  const byTarget = new Map<string, number>();
  const bySession = new Map<string, number>();
  const children = new Map<string, number>();
  let conn: Cdp | null = null, context: string | null = null, nextTab = 10;
  const onMessage = (m: { method: string; params?: any; sessionId?: string }) => {
    const s = m.sessionId;
    if (s === undefined) {
      const t = m.params?.targetInfo;
      if (m.method === "Target.targetCreated" && t?.type === "page" && context !== null && t.browserContextId === context && typeof t.openerId === "string" && byTarget.has(t.openerId) && !byTarget.has(t.targetId)) {
        const id = nextTab++;
        tabs.set(id, { targetId: t.targetId, session: null });
        byTarget.set(t.targetId, id);
        emit({ ev: "tabs.onCreated", tab: { id, incognito: true, openerTabId: byTarget.get(t.openerId), windowId: 1 } });
      } else if (m.method === "Target.targetDestroyed") {
        const id = byTarget.get(m.params?.targetId);
        if (id !== undefined) emit({ ev: "tabs.onRemoved", tabId: id });
      } else if (m.method === "Target.detachedFromTarget") {
        const id = bySession.get(m.params?.sessionId);
        if (id !== undefined) { bySession.delete(m.params.sessionId); emit({ ev: "debugger.onDetach", source: { tabId: id } }); }
      }
      return;
    }
    const tab = bySession.get(s) ?? children.get(s);
    if (tab === undefined) return;
    // A child session (a frame or a worker that the tab's auto-attach holds) belongs to the tab of its parent session.
    if (m.method === "Target.attachedToTarget" && typeof m.params?.sessionId === "string") children.set(m.params.sessionId, tab);
    emit({ ev: "debugger.onEvent", source: bySession.has(s) ? { tabId: tab } : { tabId: tab, sessionId: s }, method: m.method, params: m.params ?? {} });
    if (m.method === "Target.detachedFromTarget" && typeof m.params?.sessionId === "string") children.delete(m.params.sessionId);
  };
  const model: FetchModelPort = {
    notReady: () => null,
    hide: () => {},
    listen: (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    call: async (op: string, args: unknown[] = [], o?: { wait?: number }): Promise<any> => {
      switch (op) {
        case "windows.create": {
          const want = (args[0] ?? {}) as { width?: number; height?: number };
          if (conn === null) { conn = await cdp(); conn.listen(onMessage); }
          await conn.send("Target.setDiscoverTargets", { discover: true });
          context = (await conn.send("Target.createBrowserContext", { disposeOnDetach: true })).browserContextId;
          await conn.send("Browser.setDownloadBehavior", { behavior: "deny", browserContextId: context });
          const t = await conn.send("Target.createTarget", { url: "about:blank", browserContextId: context, newWindow: true, background: true, ...(want.width ? { width: want.width, height: want.height } : {}) });
          const id = nextTab++;
          tabs.set(id, { targetId: t.targetId, session: null });
          byTarget.set(t.targetId, id);
          return { id: 1, incognito: true, focused: false, tabs: [{ id, windowId: 1, incognito: true }] };
        }
        case "debugger.attach": {
          const tab = tabs.get(args[0] as number);
          if (!tab || conn === null) throw new Error("no such tab");
          if (tab.session !== null) return {};
          const a = await conn.send("Target.attachToTarget", { targetId: tab.targetId, flatten: true });
          tab.session = a.sessionId;
          bySession.set(a.sessionId, args[0] as number);
          return {};
        }
        case "debugger.sendCommand": {
          const [target, method, params] = args as [{ tabId: number; sessionId?: string }, string, Record<string, unknown>];
          const tab = tabs.get(target?.tabId);
          if (!tab || tab.session === null || conn === null) throw new Error("the tab has no session");
          return await conn.send(method, params ?? {}, target.sessionId ?? tab.session, o?.wait);
        }
        case "windows.get": return null;
        default: throw new Error(`no such op: ${op}`);
      }
    },
  };
  const receiver: FetchReceiver = {
    features: () => new Set(["fetch"]),
    request: async () => {
      if (conn !== null && context !== null) { const c = context; context = null; await conn.send("Target.disposeBrowserContext", { browserContextId: c }).catch(() => {}); }
      return { closed: 1 };
    },
  };
  return { model, receiver };
}

// ------------------------------------------------------------------ the command

/** What the tests give in place of the real parts. */
export type PageFetchDeps = {
  launch?: (o: { chrome: string; args: string[]; log: (l: string) => void }) => Promise<Launched>;
  resolve?: Resolve;
  /** The folder of the profile folder (the system's temp folder by default). */
  tmp?: string;
  /** The exit at a signal whose cleanup hangs (process.exit by default). */
  exit?: (code: number) => void;
  /** Shorter limits of the core (tests). */
  limits?: Record<string, number>;
  /** The source of the signals (the process by default; tests give an emitter). */
  signals?: { on(s: string, h: () => void): unknown; off(s: string, h: () => void): unknown };
};
type Values = Record<string, string | boolean | undefined>;
type IO = { stdout: Writable; stderr: Writable };
const write = (w: Writable, text: string) => new Promise<void>((r) => { w.write(text, () => r()); });
const whole = (s: string | undefined) => (s !== undefined && /^\d+$/.test(s) ? Number(s) : null);

/** The flags of a call, or a UsageError. */
function parse(values: Values, rest: string[]) {
  for (const k of Object.keys(values)) if (!TAKES.has(k)) throw new UsageError(`--${k} is not an option of page-fetch; ${PAGE_FETCH_USAGE}`);
  if (rest.length !== 1) throw new UsageError(PAGE_FETCH_USAGE);
  const str = (k: string) => (typeof values[k] === "string" ? (values[k] as string) : undefined);
  const file = str("allow-file");
  if (!file) throw new UsageError(`--allow-file is required: page-fetch fetches only what its allow file lists; ${PAGE_FETCH_USAGE}`);
  const mode = str("mode") ?? "main";
  if (mode !== "main" && mode !== "whole") throw new UsageError("--mode must be main or whole");
  const offset = str("offset") === undefined ? 0 : whole(str("offset"));
  if (offset === null || !Number.isSafeInteger(offset)) throw new UsageError("--offset must be a whole number of 0 or more");
  const maxChars = str("max-chars") === undefined ? MAX_CHARS_DEFAULT : whole(str("max-chars"));
  if (maxChars === null || maxChars < 1 || maxChars > FETCH_LIMITS.keepChars) throw new UsageError(`--max-chars must be a whole number from 1 to ${FETCH_LIMITS.keepChars}`);
  let chrome = DEFAULT_CHROME;
  if (str("chrome") !== undefined) {
    if (!str("chrome")) throw new UsageError("--chrome is empty: give the path of a Chromium, or leave the flag out");
    chrome = resolve(str("chrome")!);
    try { accessSync(chrome, constants.X_OK); } catch { throw new UsageError("--chrome: no program that this user can run is at that path"); }
  }
  return { url: rest[0], file: resolve(file), mode, offset, maxChars, chrome };
}

/** The --json document of an answer. */
const answerDoc = (a: FetchAnswer) => ({ ok: true, url: a.url, title: a.title, status: a.status, kind: a.kind, mode: a.mode, fallback: a.fallback, length: a.length, cut: a.cut, part: a.part, notes: a.notes, blocked: a.blocked, markdown: a.markdown });

/**
 * Run `page-fetch`: the exit status (0 fetched, 1 not fetched, 2 usage). The allow file and the flags are checked before
 * anything starts; Chrome starts only when the core opens its window (after the fetch list and the address rule); its
 * profile folder goes after the fetch, also after an error or a signal.
 */
export async function pageFetchMain(values: Values, rest: string[], io: IO, deps: PageFetchDeps = {}): Promise<number> {
  const json = values.json === true;
  let o: ReturnType<typeof parse>, list: FetchList;
  try {
    o = parse(values, rest);
    list = readAllowFile(o.file);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await (json ? write(io.stdout, `${JSON.stringify({ ok: false, code: "usage", message })}\n`) : write(io.stderr, `agent-browser: ${message}\n`));
    return 2;
  }
  const log = (l: string) => { io.stderr.write(`${l}\n`); };
  let launched: Launched | null = null, profile: string | null = null, stopped: string | null = null, force: NodeJS.Timeout | null = null;
  const cleanup = async () => {
    const l = launched;
    launched = null;
    if (l) await l.close().catch(() => {});
    if (profile !== null) { rmSync(profile, { recursive: true, force: true }); profile = null; }
  };
  const start = async (): Promise<Cdp> => {
    if (stopped !== null) throw new Error(stopped);
    profile = mkdtempSync(join(deps.tmp ?? tmpdir(), PROFILE_PREFIX));
    const l = await (deps.launch ?? launchChrome)({ chrome: o.chrome, args: chromeArgs({ profile, hosts: hostsOf(list.entries) }), log });
    if (stopped !== null) { await l.close().catch(() => {}); throw new Error(stopped); }
    launched = l;
    return l.cdp;
  };
  // A signal ends Chrome and removes the profile folder; the fetch then fails (its pipe is closed), and the command exits 1.
  const onSignal = (sig: string) => {
    if (stopped !== null) return;
    stopped = `page-fetch stopped at ${sig}`;
    log(`agent-browser: ${stopped}; Chrome ends and its profile folder goes`);
    void cleanup();
    // The exit, if the cleanup hangs; the end of the command clears it.
    force = setTimeout(() => (deps.exit ?? process.exit)(1), 10_000);
    force.unref();
  };
  const handlers = SIGNALS.map((s) => [s, () => onSignal(s)] as const);
  const signals = deps.signals ?? process;
  for (const [s, h] of handlers) signals.on(s, h);
  const { model, receiver } = directPorts(start);
  const core = new PageFetch({
    model, receiver, lock: new WindowLock(), screen: null, log,
    ...(deps.resolve ? { resolve: deps.resolve } : {}),
    fetchList: () => list,
    limits: { partChars: o.maxChars, ...deps.limits },
  });
  try {
    const a = await core.fetchAnswer({ scope: "page-fetch", admission: "local" }, { url: o.url, mode: o.mode, offset: o.offset });
    await cleanup();
    if (stopped !== null) throw new FetchRefusal("unavailable", `${stopped}.`);
    await write(io.stdout, json ? `${JSON.stringify(answerDoc(a))}\n` : a.text.endsWith("\n") ? a.text : `${a.text}\n`);
    return 0;
  } catch (e) {
    await cleanup();
    // After a signal the fetch ended because of it, whatever the core's text.
    const r = stopped !== null ? new FetchRefusal("unavailable", `The fetch ended: ${stopped}.`)
      : e instanceof FetchRefusal ? e : new FetchRefusal("unavailable", "The fetch failed in the command itself.");
    if (!(e instanceof FetchRefusal)) log(`agent-browser: page-fetch: ${String((e as Error)?.message ?? e).replace(/[a-z][a-z0-9+.-]*:\/\/\S*/gi, "<a URL>").slice(0, 200)}`);
    await write(io.stdout, json ? `${JSON.stringify({ ok: false, code: r.code, message: r.message })}\n` : `${r.message}\n`);
    return 1;
  } finally {
    for (const [s, h] of handlers) signals.off(s, h);
    if (force !== null) clearTimeout(force);
  }
}
