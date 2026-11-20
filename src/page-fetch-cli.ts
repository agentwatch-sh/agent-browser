// `agent-browser page-fetch <url> --allow-file FILE` (board ab-v16.113; the README, "PageFetch without agentwatch"): one
// PageFetch in a Chromium of its own, with no agentwatch, no service, no extension and no --cdp-url. The operator's board
// answer (2026-11-18): "this would be a use of agentbrowser without agentwatch i think. i.e. we pre-configure the browser
// in the support repo toi do what we need." The first caller is the host-side route of the support agent's unattended
// runs, on a box with no agentwatch session.
//
// - Always strict mode: --allow-file is required, `{"allow":["host","host/path",...]}` (fetch-list.ts has the rules). The
//   file belongs to the host-side route, not to the run that asks for a fetch: the command refuses a file that is not a
//   regular file (also a symbolic link), that its group or others can write, or whose owner is neither root nor the
//   user that runs the command, from the opened descriptor, so a swap between the check and the read does not pass. A
//   missing, unreadable, invalid or empty file is refused too, each before Chrome starts (exit 2).
// - PageFetch's own core (src/service/fetch/page-fetch.ts) with all of its rules: the fetch list first, the address rule
//   (never the box itself, never a private network) before the rate and any window, so an off-list or refused URL never
//   starts Chrome; GET and HEAD only, each other request of the window failed and counted; an off-list main document
//   refused and never followed; no cookie, key or request body (a new profile, a new browser context); downloads denied;
//   no input, no click, no form; dialogs dismissed; the caps and the 60 s limit of a fetch.
// - The core's ports over direct CDP on Chrome's pipe (directPorts): windows.create is Target.createBrowserContext and
//   Target.createTarget, fetch_end is Target.disposeBrowserContext. No lock and no rate across processes: each call is a
//   new process and a new fetch, and --offset and --max-chars cut that fetch's markdown.
// - Its own Chromium (--chrome, default /usr/bin/chromium), headless, with a new profile folder under the system's temp
//   folder that it removes after the fetch, also after an error or a signal; the folder is also Chrome's HOME, and one
//   line on standard error names it, for a route that kills the command (a kill leaves it). It never touches the agent
//   browser's Chrome, profile, state folder, socket or extension. Chrome's host resolver maps every host to NOTFOUND
//   except the list's hosts, so no other host gets even a DNS lookup or a connect (also a preconnect or a WebSocket),
//   its background services are off, and so are the report uploads (Reporting, NEL), which leave outside the guard.
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
/** The start of the log line on standard error that names the profile folder (its absolute path follows). */
export const PROFILE_LINE = "page-fetch: profile ";
/** The signals at which the command ends Chrome, removes its profile folder and exits 1. */
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

// ------------------------------------------------------------------ the allow file

/**
 * The allow file's entries and its name (its base name, for the texts: never a path of the box). The file is opened with
 * no follow of a symbolic link and with no wait (a FIFO), and the checks read the opened descriptor: a regular file, not
 * writable by its group or by others, at most ALLOW_FILE_MAX bytes, and owned by root or by `euid`, the user that runs the
 * command (board ab-v16.114: the owner of a file can change its mode and its text at any time). Each refusal is a
 * UsageError (exit 2). `euid` is process.geteuid() (none on a system without it: then no owner check).
 */
export function readAllowFile(path: string, euid: number | undefined = process.geteuid?.()): FetchList & { entries: string[] } {
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
    if (euid !== undefined && st.uid !== 0 && st.uid !== euid) throw new UsageError("--allow-file: another user owns the allow file; root or the user that runs page-fetch must own it (chown)");
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
 * The features that Chrome's --disable-features turns off (one flag: a second one would replace the first). Reporting and
 * NetworkErrorLogging (board ab-v16.114): the network service uploads a page's reports (Reporting-Endpoints, Report-To,
 * NEL) itself, as a POST with a body and its CORS preflight, outside the tab's Fetch guard (measured on Chromium 156 with
 * a local server: each upload reached the server, and none paused in the guard; with the two features off, none left).
 */
export const CHROME_DISABLED_FEATURES = [
  "Translate", "OptimizationHints", "OptimizationGuideModelDownloading", "MediaRouter", "DialMediaRouteProvider", "AutofillServerCommunication",
  "CertificateTransparencyComponentUpdater", "InterestFeedContentSuggestions", "NetworkTimeServiceQuerying", "PrivacySandboxSettings4",
  "Reporting", "NetworkErrorLogging",
] as const;

/**
 * Chrome's arguments: headless, the new profile, the debugging pipe, the host resolver rules of the list's hosts (every
 * other host is NOTFOUND: no DNS lookup and no connect), Chrome's background services off, and the report uploads off.
 */
export function chromeArgs(o: { profile: string; hosts: readonly string[] }): string[] {
  if (o.hosts.length === 0 || o.hosts.some((h) => !/^[a-z0-9.-]+$/.test(h))) throw new Error("the hosts must be normalized hosts");
  return [
    "--headless", `--user-data-dir=${o.profile}`, "--remote-debugging-pipe", "--no-proxy-server",
    `--host-resolver-rules=MAP * ~NOTFOUND, ${o.hosts.map((h) => `EXCLUDE ${h}`).join(", ")}`,
    "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-component-extensions-with-background-pages",
    "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-default-apps", "--disable-domain-reliability",
    "--disable-client-side-phishing-detection", "--safebrowsing-disable-auto-update", "--disable-breakpad", "--no-pings", "--dns-prefetch-disable",
    `--disable-features=${CHROME_DISABLED_FEATURES.join(",")}`,
    "--password-store=basic", "--mute-audio", "--window-size=1280,900", "about:blank",
  ];
}

/** One CDP connection: commands (with a session for a target), and its messages with no id (the events). */
export interface Cdp {
  send(method: string, params?: Record<string, unknown>, sessionId?: string, waitMs?: number): Promise<any>;
  listen(fn: (m: { method: string; params?: any; sessionId?: string }) => void): void;
  /** `fn` runs once when the connection closes (Chrome ended, or its pipe failed). */
  onClose(fn: () => void): void;
}

/** CDP over Chrome's debugging pipe (--remote-debugging-pipe): JSON messages, each ended by a NUL byte. */
export class PipeCdp implements Cdp {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private readonly listeners = new Set<(m: any) => void>();
  private readonly closers = new Set<() => void>();
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

  onClose(fn: () => void): void { if (this.closedWhy !== null) fn(); else this.closers.add(fn); }

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
    for (const f of [...this.closers]) f();
    this.closers.clear();
  }
}

/** A running Chrome: its connection and its end (Browser.close, then a signal; it waits for the exit). */
export type Launched = { cdp: Cdp; close(): Promise<void> };

/**
 * The variables of the environment that Chrome gets from the command's own (the review of PR #214): no proxy, no
 * CHROMIUM_FLAGS, no display. HOME is not one of them: chromeEnv sets it to the fetch's profile folder.
 */
export const CHROME_ENV_KEYS = ["PATH", "USER", "LOGNAME", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "TZ", "TMPDIR"] as const;

/**
 * Chrome's environment: only CHROME_ENV_KEYS of `env` (PATH has a default), and HOME `home`, the fetch's own profile
 * folder (board ab-v16.114), so Chrome and Debian's wrapper read no per-user state of the box (~/.pki/nssdb,
 * ~/.config/chromium, ~/.cache): what they write there goes with the profile folder.
 */
export function chromeEnv(home: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (!home.startsWith("/")) throw new Error("Chrome's HOME must be an absolute path");
  const out: Record<string, string> = {};
  for (const k of CHROME_ENV_KEYS) if (typeof env[k] === "string" && env[k] !== "") out[k] = env[k]!;
  out.PATH ??= "/usr/local/bin:/usr/bin:/bin";
  out.HOME = home;
  return out;
}

/**
 * Start Chrome with `args` and its debugging pipe on the descriptors 3 (Chrome reads) and 4 (Chrome writes), with the
 * minimal environment of chromeEnv (HOME is `home`): no proxy variable, no CHROMIUM_FLAGS (Debian's wrapper reads it), and
 * no DISPLAY or WAYLAND_DISPLAY (Chrome is headless: it never reaches a display of the box). The start waits for an answer
 * on the pipe (Browser.getVersion), at most CHROME_START_MS; an early exit gives the end of Chrome's own error output.
 */
export async function launchChrome(o: { chrome: string; args: string[]; home: string; log: (l: string) => void; startMs?: number }): Promise<Launched> {
  const child: ChildProcess = spawn(o.chrome, o.args, { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], env: chromeEnv(o.home) });
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
 * window): windows.create is a new browser context (no cookie, no storage, downloads denied) and a target in it;
 * debugger.sendCommand sends on the tab's session or on a child session; the events of each session reach the core as the
 * extension's debugger.onEvent; fetch_end disposes the context. There is no client to hide a tab from.
 *
 * The browser's own auto-attach (Target.setAutoAttach with waitForDebuggerOnStart, the review of PR #214) holds each new
 * target before it runs, so no request of it leaves before its guard:
 * - a page of the fetch's context that is not its tab is a popup: the core gets tabs.onCreated; the adapter enables its
 *   guard (Fetch, every request at the request stage, which the core fails) and the auto-attach of its own children, then
 *   it runs; one whose guard fails never runs, and it closes;
 * - a shared worker of the fetch's context goes to the core as a child of the tab, whose guard holds its requests;
 * - a service worker never runs: its target stays held until the context ends (the tab's requests bypass service
 *   workers, so no page needs one), and so does each child of a popup, and a shared or service worker that a session
 *   attaches;
 * - a target of the fetch's context of any other type (a worklet, `other`, a type of a later Chrome) never runs either
 *   (board ab-v16.114): it has no guard, so it stays held; the context stays the fetch's after fetch_end, so a target
 *   that attaches while it ends is held too;
 * - a target of another context, and Chrome's own UI targets (`browser_ui`, also in the fetch's context: its window's
 *   omnibox popup), run and are detached at once.
 */
export function directPorts(cdp: () => Promise<Cdp>): { model: FetchModelPort; receiver: FetchReceiver } {
  const listeners = new Set<(ev: Record<string, any>) => void>();
  const emit = (ev: Record<string, any>) => { for (const f of [...listeners]) f(ev); };
  const tabs = new Map<number, { targetId: string; session: string | null; running: boolean }>();
  const byTarget = new Map<string, number>();
  const bySession = new Map<string, number>();
  const children = new Map<string, number>();
  /** The sessions of the targets that never run (service workers, the children of popups, targets of other types). */
  const held = new Set<string>();
  /** The fetch's browser contexts, also after fetch_end disposes one. */
  const ours = new Set<string>();
  /** Pages of the fetch's context that Chrome attached before the tab's target was known. */
  const early = new Map<string, { sessionId: string; info: any }>();
  let conn: Cdp | null = null, context: string | null = null, nextTab = 10, mainId: number | null = null, creating = false;
  const send = (method: string, params: Record<string, unknown>, sessionId?: string) => conn!.send(method, params, sessionId);
  /** A popup: the core holds and closes it; the adapter guards it, holds its children, then lets it run. */
  const popup = (sessionId: string, info: any) => {
    const id = nextTab++;
    tabs.set(id, { targetId: info.targetId, session: sessionId, running: true });
    byTarget.set(info.targetId, id);
    bySession.set(sessionId, id);
    emit({ ev: "tabs.onCreated", tab: { id, incognito: true, openerTabId: mainId, windowId: 1 } });
    void (async () => {
      try {
        await send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, sessionId);
        await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
      } catch {
        await send("Target.closeTarget", { targetId: info.targetId }).catch(() => {});
        return;
      }
      await send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {});
    })();
  };
  const onBrowser = (m: { method: string; params?: any }) => {
    const p = m.params ?? {};
    if (m.method === "Target.attachedToTarget" && typeof p.sessionId === "string") {
      const info = p.targetInfo ?? {};
      const mine = typeof info.browserContextId === "string" && ours.has(info.browserContextId);
      if (!mine || info.type === "browser_ui") {
        void send("Runtime.runIfWaitingForDebugger", {}, p.sessionId).catch(() => {}).then(() => send("Target.detachFromTarget", { sessionId: p.sessionId }).catch(() => {}));
        return;
      }
      if (info.type !== "page" && info.type !== "shared_worker") { held.add(p.sessionId); return; }
      if (info.type === "shared_worker") {
        if (mainId === null) { held.add(p.sessionId); return; }
        children.set(p.sessionId, mainId);
        emit({ ev: "debugger.onEvent", source: { tabId: mainId }, method: "Target.attachedToTarget", params: p });
        return;
      }
      const known = byTarget.get(info.targetId);
      if (known !== undefined) { const t = tabs.get(known)!; if (t.session === null) { t.session = p.sessionId; bySession.set(p.sessionId, known); } return; }
      if (mainId === null || creating) { early.set(info.targetId, { sessionId: p.sessionId, info }); return; }
      popup(p.sessionId, info);
      return;
    }
    if (m.method === "Target.targetDestroyed") {
      const id = byTarget.get(p.targetId);
      if (id !== undefined) emit({ ev: "tabs.onRemoved", tabId: id });
      return;
    }
    if (m.method === "Target.detachedFromTarget" && typeof p.sessionId === "string") {
      held.delete(p.sessionId);
      const id = bySession.get(p.sessionId);
      if (id !== undefined) { bySession.delete(p.sessionId); emit({ ev: "debugger.onDetach", source: { tabId: id } }); return; }
      const owner = children.get(p.sessionId);
      if (owner !== undefined) { children.delete(p.sessionId); emit({ ev: "debugger.onEvent", source: { tabId: owner }, method: "Target.detachedFromTarget", params: p }); }
    }
  };
  const onMessage = (m: { method: string; params?: any; sessionId?: string }) => {
    const s = m.sessionId;
    if (s === undefined) { onBrowser(m); return; }
    const tab = bySession.get(s) ?? children.get(s);
    if (tab === undefined) return;
    if (m.method === "Target.attachedToTarget" && typeof m.params?.sessionId === "string") {
      const type = m.params.targetInfo?.type;
      // A service worker or a shared worker that a session attaches, and each child of a popup, never run.
      if (type === "service_worker" || type === "shared_worker" || tab !== mainId) { held.add(m.params.sessionId); return; }
      // A child session (a frame or a dedicated worker that the tab's auto-attach holds) belongs to the tab of its parent.
      children.set(m.params.sessionId, tab);
    }
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
          if (conn === null) {
            conn = await cdp();
            conn.listen(onMessage);
            // Chrome ended (a signal to its process group, a crash): each tab is gone, so the core's wait ends at once.
            conn.onClose(() => { for (const id of [...bySession.values()]) emit({ ev: "debugger.onDetach", source: { tabId: id } }); bySession.clear(); });
          }
          await send("Target.setDiscoverTargets", { discover: true });
          context = (await send("Target.createBrowserContext", { disposeOnDetach: true })).browserContextId;
          ours.add(context!);
          await send("Browser.setDownloadBehavior", { behavior: "deny", browserContextId: context });
          // Each new target waits before it runs (the browser's own auto-attach; one that fails ends the fetch).
          await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
          creating = true;
          let t: any;
          try { t = await send("Target.createTarget", { url: "about:blank", browserContextId: context, newWindow: true, background: true, ...(want.width ? { width: want.width, height: want.height } : {}) }); }
          finally { creating = false; }
          const id = nextTab++;
          mainId = id;
          tabs.set(id, { targetId: t.targetId, session: null, running: false });
          byTarget.set(t.targetId, id);
          const mine = early.get(t.targetId);
          early.delete(t.targetId);
          if (mine) { tabs.get(id)!.session = mine.sessionId; bySession.set(mine.sessionId, id); }
          for (const [, e] of early) popup(e.sessionId, e.info);
          early.clear();
          return { id: 1, incognito: true, focused: false, tabs: [{ id, windowId: 1, incognito: true }] };
        }
        case "debugger.attach": {
          const tab = tabs.get(args[0] as number);
          if (!tab || conn === null) throw new Error("no such tab");
          // The tab's own session from the auto-attach: it may come a moment after the target.
          for (let i = 0; i < 100 && tab.session === null; i++) await new Promise((r) => setTimeout(r, 10));
          if (tab.session === null) {
            const a = await send("Target.attachToTarget", { targetId: tab.targetId, flatten: true });
            tab.session = a.sessionId;
            bySession.set(a.sessionId, args[0] as number);
          }
          // The tab waits at about:blank, which loads nothing: it runs now, and the core sets its guard before it navigates.
          if (!tab.running) { tab.running = true; await send("Runtime.runIfWaitingForDebugger", {}, tab.session!).catch(() => {}); }
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
  launch?: (o: { chrome: string; args: string[]; home: string; log: (l: string) => void }) => Promise<Launched>;
  resolve?: Resolve;
  /** The user that runs the command, for the allow file's owner (process.geteuid() by default; tests give another). */
  euid?: number;
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
export async function runPageFetchCommand(values: Values, rest: string[], io: IO, deps: PageFetchDeps = {}): Promise<number> {
  const json = values.json === true;
  let o: ReturnType<typeof parse>, list: FetchList;
  try {
    o = parse(values, rest);
    list = readAllowFile(o.file, deps.euid ?? process.geteuid?.());
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await (json ? write(io.stdout, `${JSON.stringify({ ok: false, code: "usage", message })}\n`) : write(io.stderr, `agent-browser: ${message}\n`));
    return 2;
  }
  const log = (l: string) => { io.stderr.write(`${l}\n`); };
  let launched: Launched | null = null, launching: Promise<Launched> | null = null, profile: string | null = null;
  let stopped: string | null = null, force: NodeJS.Timeout | null = null, cleaning: Promise<void> | null = null;
  // One cleanup for the whole call: it waits for a launch that runs, ends Chrome and waits for its exit, and only then
  // removes the profile folder (a Chrome that still runs can write into it again).
  const cleanup = () => cleaning ??= (async () => {
    if (launching !== null) await launching.catch(() => {});
    const l = launched;
    launched = null;
    if (l) await l.close().catch(() => {});
    if (profile !== null) {
      const p = profile;
      profile = null;
      // Retries for a late write into the folder (ENOTEMPTY, EBUSY); an error here changes neither the exit code nor the
      // output (review-215, note 8): the profile line already named the folder for the route.
      try { rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
      catch (e) { log(`agent-browser: page-fetch: the profile folder could not be removed (${(e as NodeJS.ErrnoException).code ?? "error"})`); }
    }
  })();
  const start = async (): Promise<Cdp> => {
    if (stopped !== null || cleaning !== null) throw new Error(stopped ?? "page-fetch ended");
    // An absolute path (a relative TMPDIR too, review-215 note 2): the profile line names it, and Chrome's HOME is it.
    const tmp = resolve(deps.tmp ?? tmpdir());
    // The log line below holds the path: a control character (C0, DEL, C1) or a line or paragraph separator in it would
    // break that one line (review-215 note 3).
    if (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(tmp)) throw new Error("the temp folder's path holds a control character");
    profile = mkdtempSync(join(tmp, PROFILE_PREFIX));
    // The one line that names the profile folder, before Chrome starts: a route that kills the command (SIGKILL, or the
    // forced exit after the cleanup's limit) removes that one folder itself (board ab-v16.114).
    log(`${PROFILE_LINE}${profile}`);
    launching = (deps.launch ?? launchChrome)({ chrome: o.chrome, args: chromeArgs({ profile, hosts: hostsOf(list.entries) }), home: profile, log });
    const l = await launching;
    launched = l;
    if (stopped !== null) throw new Error(stopped);
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
