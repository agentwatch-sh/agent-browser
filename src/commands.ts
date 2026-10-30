// The operations: one function for each CLI command, with the same parameters and the same result
// document. The CLI prints these results as JSON; Node code calls them in-process; the Python
// adapter runs the CLI. COMMAND_SPECS describes them all, and the parity tests read it.

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AgentBrowser, allowlistOf, rememberEndpoint, type PageInfo, type Tab } from "./browser.ts";
import { agentChromePid, agentEndpoint, launchAgentChrome, INSPECT_URL } from "./agent.ts";
import { browserTarget, localBrowserStatus, notifyBrowserStatus, type NotifyResult } from "./diagnostics.ts";
import { isAllowedUrl } from "./allowlist.ts";
import { AgentBrowserError, NotAllowedError, ReadFirstError, UsageError, redirectError } from "./errors.ts";
import { resolveOptions, statePath, type BrowserMode, type BrowserOptions, type Settings } from "./options.ts";
import { idx, netLog, outline as outlineTab, type NetEntry, type OutlineElement } from "./outline.ts";
import { proxyInfo, socketAlive, stopProxy } from "./proxy.ts";
import { checkScale, parseSize, planRecording, recordTab, type RecordEvent } from "./record.ts";

// ---------- the spec ----------

export type ParamType = "string" | "boolean" | "number";
export type ParamSpec = {
  /** The parameter's name in the library and in JSON (camelCase); Python uses its snake_case form. */
  name: string;
  type: ParamType;
  required: boolean;
  /** "positional", or the CLI flag that carries it (for example "--name"). */
  cli: string;
  /** The CLI can read it from standard input with --stdin (so a secret never goes into argv). */
  stdin?: boolean;
  description: string;
};
export type CommandSpec = { name: string; summary: string; usage: string; params: ParamSpec[] };

const p = (name: string, type: ParamType, required: boolean, cli: string, description: string, stdin?: boolean): ParamSpec =>
  ({ name, type, required, cli, description, ...(stdin ? { stdin } : {}) });
const TAB = p("tab", "string", true, "positional", "a tab name from open --name, a target-id prefix, or a URL substring (allowlisted tabs only)");

export const COMMAND_SPECS: CommandSpec[] = [
  { name: "launch", summary: "Start the agent browser; --login opens every allowlisted site to sign in", usage: "launch [--login]",
    params: [p("login", "boolean", false, "--login", "open every allowlisted site so the operator can sign in")] },
  { name: "quit", summary: "Stop the proxy and close the agent browser (never the operator's Chrome)", usage: "quit", params: [] },
  { name: "status", summary: "Read-only connection status; never starts Chrome or a proxy", usage: "status [--notify]",
    params: [p("notify", "boolean", false, "--notify", "when no proxy works, send one message to the notify hook")] },
  { name: "connect", summary: "Personal mode: remember the operator's Chrome endpoint and connect", usage: "connect <ws-url>",
    params: [p("endpoint", "string", true, "positional", "ws://127.0.0.1:<port>/devtools/browser/<id>")] },
  { name: "stop", summary: "Stop this consumer's proxy (the next command restarts it, with one more approval)", usage: "stop", params: [] },
  { name: "window", summary: "Show the pinned window, pin the window that holds <tab>, or unpin", usage: "window [pin <tab> | unpin]",
    params: [p("pin", "string", false, "pin <tab>", "pin the window that holds this tab"), p("unpin", "boolean", false, "unpin", "clear the pin")] },
  { name: "tabs", summary: "List allowlisted tabs (other tabs are never shown)", usage: "tabs", params: [] },
  { name: "open", summary: "Open an allowlisted URL in a new tab", usage: "open <url> [--name N] [--tab]",
    params: [p("url", "string", true, "positional", "an allowlisted http(s) URL"), p("name", "string", false, "--name", "remember the tab under this name"),
      p("tab", "boolean", false, "--tab", "personal mode: a tab in the pinned window rather than a window of its own")] },
  { name: "goto", summary: "Navigate a tab to an allowlisted URL", usage: "goto <tab> <url>",
    params: [TAB, p("url", "string", true, "positional", "an allowlisted http(s) URL")] },
  { name: "outline", summary: "Number the interactive elements on screen (read this before a screenshot)", usage: "outline <tab> [--all]",
    params: [TAB, p("all", "boolean", false, "--all", "include elements outside the viewport")] },
  { name: "click", summary: "Trusted click on #N (from outline) or a selector, or on the element whose text matches", usage: "click <tab> <selector|#N> | click <tab> --text LABEL",
    params: [TAB, p("target", "string", false, "positional", "#N from outline, or a CSS selector"), p("text", "string", false, "--text", "click the smallest visible element with this exact text")] },
  { name: "hover", summary: "Move the mouse over an element (hover menus)", usage: "hover <tab> <selector|#N>",
    params: [TAB, p("target", "string", true, "positional", "#N from outline, or a CSS selector")] },
  { name: "type", summary: "Type text into #N or a selector, else the focused field; fails when it did not arrive; never echoed", usage: "type <tab> (<text> | --stdin) [--into S]",
    params: [TAB, p("text", "string", true, "positional", "the text to insert", true), p("into", "string", false, "--into", "#N or a CSS selector to focus first")] },
  { name: "press", summary: "Press a key: Enter, Tab, Escape, Backspace, Delete, an arrow, Home, End, PageUp, PageDown, F2", usage: "press <tab> <key>",
    params: [TAB, p("key", "string", true, "positional", "Enter, Tab, Escape, Backspace, Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp, PageDown or F2")] },
  { name: "text", summary: "Visible text of the page or of an element (read this before a screenshot)", usage: "text <tab> [selector|#N]",
    params: [TAB, p("selector", "string", false, "positional", "#N or a CSS selector; default the whole page")] },
  { name: "eval", summary: "Evaluate a JavaScript expression in the page (awaits promises) and return its JSON value", usage: "eval <tab> (<js> | --stdin)",
    params: [TAB, p("expression", "string", true, "positional", "a JavaScript expression", true)] },
  { name: "shot", summary: "Screenshot as PNG; refused until outline or text has read the page at its current URL", usage: "shot <tab> [path] [--full] [--size WxH] [--scale N]",
    params: [TAB, p("path", "string", false, "positional", "output PNG; default <state-dir>/shots/<time>.png"), p("full", "boolean", false, "--full", "the full page, not only the viewport"),
      p("size", "string", false, "--size", "lay the page out at exactly WIDTHxHEIGHT CSS pixels for the shot (cleared afterwards)"),
      p("scale", "number", false, "--scale", "the device pixel ratio for the shot, e.g. 1 or 2 (cleared afterwards)")] },
  { name: "fetch", summary: "Save a URL with the page's fetch() and cookies (same-origin and CORS rules apply)", usage: "fetch <tab> <url> <path>",
    params: [TAB, p("url", "string", true, "positional", "an allowlisted http(s) URL"), p("path", "string", true, "positional", "output file")] },
  { name: "download", summary: "Save a URL through Chrome's network stack (cross-origin CDN media)", usage: "download <tab> <url> <path>",
    params: [TAB, p("url", "string", true, "positional", "an allowlisted http(s) URL (add a CDN's host to the allowlist)"), p("path", "string", true, "positional", "output file")] },
  { name: "close", summary: "Close a tab", usage: "close <tab>", params: [TAB] },
  { name: "net", summary: "Record the tab's fetch/XHR/WebSocket traffic; never headers, bodies redacted", usage: "net <tab> [--seconds N] [--match S] [--max N]",
    params: [TAB, p("seconds", "number", false, "--seconds", "how long to record; default 60, at most 3600"), p("match", "string", false, "--match", "only URLs that contain this text"),
      p("max", "number", false, "--max", "clip each body at this many characters; default 4000")] },
  { name: "record", summary: "Record the tab to MP4 while a step script drives it (demo cursor, exact size)", usage: "record <tab> --out clip.mp4 [--script steps.json] [--setup steps.json] [--size 1920x1080] [--fps 30] [--scale 1|2] [--no-cursor] [--settle ms] [--seed N] [--ffmpeg PATH]",
    params: [TAB, p("out", "string", true, "--out", "the MP4 to write; the provenance JSON goes beside it (clip.mp4 -> clip.json)"),
      p("script", "string", false, "--script", "a JSON array of steps (wait, goto, click, hover, type, press, scroll, highlight, waitFor, eval); default none"),
      p("setup", "string", false, "--setup", "steps in the same format that run before the recording starts (off camera)"),
      p("size", "string", false, "--size", "the page size in CSS pixels for the run; default 1920x1080"),
      p("fps", "number", false, "--fps", "frames per second of the MP4; default 30"),
      p("scale", "number", false, "--scale", "the device pixel ratio: 1 (default) or 2; the video is size x scale pixels"),
      p("noCursor", "boolean", false, "--no-cursor", "draw no demo cursor or click ripple (a highlight step still draws its ring)"),
      p("settle", "number", false, "--settle", "ms of still page recorded before the first step and after the last; default 600"),
      p("seed", "number", false, "--seed", "the seed of the cursor paths, aim points and typing pace; the same seed moves the same way; default 1"),
      p("ffmpeg", "string", false, "--ffmpeg", "the ffmpeg binary (absolute path); default ffmpeg on PATH")] },
  { name: "commands", summary: "This list, as JSON", usage: "commands", params: [] },
];

// ---------- results ----------

export type TabRef = { id: string; targetId: string; name: string | null; url: string; title: string };
type Ok<C extends string, T> = { ok: true; command: C } & T;

export type LaunchResult = Ok<"launch", { started: boolean; endpoint: string; profileDir: string; login: boolean; opened: string[]; errors: { url: string; error: string }[] }>;
export type QuitResult = Ok<"quit", { proxyStopped: boolean; chromePid: number | null; closed: boolean }>;
export type StatusResult = Ok<"status", {
  connected: boolean; mode: BrowserMode; target: string; detail: string | null; product: string | null;
  proxy: { pid: number; upstream: string } | null; profileDir: string | null; allowedTabs: number | null; otherTabs: number | null;
  allowlist: string[]; window: number | null; notification: NotifyResult | null;
}>;
export type ConnectResult = Ok<"connect", { endpoint: string; product: string }>;
export type StopResult = Ok<"stop", { stopped: boolean }>;
export type WindowResult = Ok<"window", { window: number | null; tabs: TabRef[] }>;
export type TabsResult = Ok<"tabs", { tabs: TabRef[]; window: number | null }>;
export type OpenResult = Ok<"open", { tab: TabRef; window: number | null }>;
export type GotoResult = Ok<"goto", { tab: TabRef }>;
export type OutlineResult = Ok<"outline", { tab: TabRef; elements: OutlineElement[] }>;
export type ClickResult = Ok<"click", { tab: TabRef; target: string | null; text: string | null }>;
export type HoverResult = Ok<"hover", { tab: TabRef; target: string }>;
export type TypeResult = Ok<"type", { tab: TabRef; into: string | null; length: number }>;
export type PressResult = Ok<"press", { tab: TabRef; key: string }>;
export type TextResult = Ok<"text", { tab: TabRef; selector: string | null; text: string }>;
export type EvalResult = Ok<"eval", { tab: TabRef; value: unknown }>;
export type ShotResult = Ok<"shot", { tab: TabRef; path: string; fullPage: boolean }>;
export type FetchResult = Ok<"fetch", { tab: TabRef; url: string; path: string; bytes: number; contentType: string }>;
export type DownloadResult = Ok<"download", { tab: TabRef; url: string; path: string; bytes: number; status: number }>;
export type CloseResult = Ok<"close", { tab: TabRef }>;
export type NetResult = Ok<"net", { tab: TabRef; seconds: number; entries: NetEntry[] }>;
export type RecordResult = Ok<"record", {
  tab: TabRef; path: string; provenance: string; width: number; height: number; scale: number; fps: number; videoWidth: number; videoHeight: number;
  frames: number; seconds: number; maxFrameGapMs: number; steps: number; events: RecordEvent[]; warnings: string[];
}>;
export type CommandsResult = Ok<"commands", { commands: CommandSpec[] }>;

/** The longest `net` capture, in seconds. */
export const MAX_NET_SECONDS = 3600;

// ---------- helpers ----------

async function withBrowser<T>(o: BrowserOptions | Settings, fn: (b: AgentBrowser) => Promise<T>): Promise<T> {
  const b = await AgentBrowser.connect(o);
  try { return await fn(b); } finally { await b.disconnect(); }
}

const tabRef = (p: PageInfo): TabRef => ({ id: p.targetId.slice(0, 8), targetId: p.targetId, name: p.name ?? null, url: p.url, title: p.title });

/** The tab's reference with its live URL and title (after a navigation), refused if it was redirected off the allowlist. */
async function liveRef(tab: Tab, name: string | null): Promise<TabRef> {
  await tab.assertAllowed();
  const { url, title } = await tab.evaluate(() => ({ url: location.href, title: document.title }));
  if (!isAllowedUrl(url, tab.browser.allow)) throw new NotAllowedError(url);
  return { id: tab.targetId.slice(0, 8), targetId: tab.targetId, name, url, title };
}

async function onTab<T>(o: BrowserOptions | Settings, ref: string, fn: (tab: Tab, info: TabRef, b: AgentBrowser) => Promise<T>): Promise<T> {
  return withBrowser(o, async (b) => {
    const info = await b.resolve(ref);
    return fn(await b.attach(info.targetId), tabRef(info), b);
  });
}

function need(value: string | undefined, what: string): string {
  if (typeof value !== "string" || !value) throw new UsageError(`${what} is required`);
  return value;
}

function httpUrl(url: string): string {
  let u: URL;
  try { u = new URL(url); } catch { throw new UsageError(`not a URL: ${url}`); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new UsageError(`only http(s) URLs can be fetched: ${u.protocol}`);
  return url;
}

// The read-first rule: a screenshot needs an outline or text of the same tab at the same URL.
const readsPath = (s: Settings) => statePath(s, "reads.json");
function reads(s: Settings): Record<string, string> {
  try { return JSON.parse(readFileSync(readsPath(s), "utf8")); } catch { return {}; }
}
function markRead(s: Settings, targetId: string, url: string) {
  writeFileSync(readsPath(s), JSON.stringify({ ...reads(s), [targetId]: url }, null, 2));
}

async function stopProxyAndWait(s: Settings): Promise<boolean> {
  const stopped = stopProxy(s);
  for (let i = 0; stopped && i < 150 && await socketAlive(s.socketPath); i++) await new Promise((r) => setTimeout(r, 20));
  return stopped;
}

// ---------- the operations ----------

export const commands = {
  async launch(o: BrowserOptions | Settings, p: { login?: boolean } = {}): Promise<LaunchResult> {
    const s = resolveOptions(o);
    if (s.mode !== "agent") throw new UsageError("launch is for the agent browser (mode agent)");
    const urls = p.login ? allowlistOf(s).map((h) => `https://${h}/`) : [];
    const running = s.endpoint ?? await agentEndpoint(s);
    const endpoint = running ?? await launchAgentChrome(s, {
      background: !p.login, // a sign-in needs the window in front; any other start leaves the operator's screen as it is
      urls: [INSPECT_URL, ...urls],
      timeoutMs: 10 * 60_000,
      onWaiting: () => s.log(`waiting for remote debugging: turn it on in ${INSPECT_URL} (Ctrl-C to stop waiting)`),
    });
    const opened: string[] = [], errors: { url: string; error: string }[] = [];
    if (!running) opened.push(...urls); // Chrome opened them at launch
    else if (urls.length) {
      await withBrowser(s, async (b) => {
        for (const u of urls) {
          try { await b.open(u); opened.push(u); } catch (e) { errors.push({ url: u, error: (e as Error).message }); }
        }
      });
    }
    return { ok: true, command: "launch", started: !running, endpoint, profileDir: s.profileDir, login: !!p.login, opened, errors };
  },

  async quit(o: BrowserOptions | Settings): Promise<QuitResult> {
    const s = resolveOptions(o);
    if (s.mode !== "agent") throw new UsageError("quit is for the agent browser; it never closes the operator's Chrome");
    const proxyStopped = await stopProxyAndWait(s);
    // Signal the process rather than connect: a new debugging connection would prompt.
    const pid = agentChromePid(s);
    if (pid) process.kill(pid, "SIGTERM");
    return { ok: true, command: "quit", proxyStopped, chromePid: pid ?? null, closed: !!pid };
  },

  async status(o: BrowserOptions | Settings, p: { notify?: boolean } = {}): Promise<StatusResult> {
    const s = resolveOptions(o);
    if (p.notify && !s.notify) throw new UsageError("--notify needs a notify hook (CLI: --notify-command)");
    const allowlist = allowlistOf(s);
    const base = { ok: true as const, command: "status" as const, mode: s.mode, target: browserTarget(s), allowlist };
    let b: AgentBrowser;
    try { b = await AgentBrowser.connect(s, { existingOnly: true }); }
    catch (e) {
      if (e instanceof AgentBrowserError && e.code === "usage") throw e;
      const detail = await localBrowserStatus(s);
      return { ...base, connected: false, detail, product: null, proxy: null, profileDir: s.mode === "agent" ? s.profileDir : null,
        allowedTabs: null, otherTabs: null, window: null, notification: p.notify ? await notifyBrowserStatus(s, detail) : null };
    }
    try {
      const pages = await b.allowedPages();
      return { ...base, connected: true, detail: null, product: b.product, proxy: proxyInfo(s) ?? null, profileDir: s.mode === "agent" ? s.profileDir : null,
        allowedTabs: pages.length, otherTabs: await b.otherPageCount(), window: b.pinnedWindow() ?? null, notification: null };
    } finally { await b.disconnect(); }
  },

  async connect(o: BrowserOptions | Settings, p: { endpoint: string }): Promise<ConnectResult> {
    const s = resolveOptions(o);
    if (s.mode !== "personal") throw new UsageError("connect is for personal mode; the agent browser is found automatically");
    const endpoint = need(p.endpoint, "endpoint (ws-url)");
    await stopProxyAndWait(s);
    rememberEndpoint(s, endpoint);
    return withBrowser({ ...s, endpoint }, async (b) => ({ ok: true, command: "connect", endpoint, product: b.product }));
  },

  async stop(o: BrowserOptions | Settings): Promise<StopResult> {
    return { ok: true, command: "stop", stopped: await stopProxyAndWait(resolveOptions(o)) };
  },

  async window(o: BrowserOptions | Settings, p: { pin?: string; unpin?: boolean } = {}): Promise<WindowResult> {
    if (p.pin && p.unpin) throw new UsageError("window: pin or unpin, not both");
    return withBrowser(o, async (b) => {
      if (p.pin) b.pinWindow(await b.windowOf((await b.resolve(p.pin)).targetId));
      else if (p.unpin) b.pinWindow(undefined);
      const w = b.pinnedWindow();
      return { ok: true, command: "window", window: w ?? null, tabs: w === undefined ? [] : (await b.allowedPages()).map(tabRef) };
    });
  },

  async tabs(o: BrowserOptions | Settings): Promise<TabsResult> {
    return withBrowser(o, async (b) => ({ ok: true, command: "tabs", tabs: (await b.allowedPages()).map(tabRef), window: b.pinnedWindow() ?? null }));
  },

  async open(o: BrowserOptions | Settings, p: { url: string; name?: string; tab?: boolean }): Promise<OpenResult> {
    const url = need(p.url, "url");
    return withBrowser(o, async (b) => {
      const tab = await b.open(url, { name: p.name, newWindow: p.tab ? false : undefined });
      try { return { ok: true, command: "open", tab: await liveRef(tab, p.name ?? null), window: b.pinnedWindow() ?? null }; }
      catch (e) { throw redirectError(e, url, b.settings); }
    });
  },

  async goto(o: BrowserOptions | Settings, p: { tab: string; url: string }): Promise<GotoResult> {
    const url = need(p.url, "url");
    return onTab(o, need(p.tab, "tab"), async (tab, info) => {
      await tab.goto(url);
      try { return { ok: true, command: "goto", tab: await liveRef(tab, info.name) }; }
      catch (e) { throw redirectError(e, url, tab.browser.settings); }
    });
  },

  async outline(o: BrowserOptions | Settings, p: { tab: string; all?: boolean }): Promise<OutlineResult> {
    return onTab(o, need(p.tab, "tab"), async (tab, info, b) => {
      const elements = await outlineTab(tab, !!p.all);
      markRead(b.settings, tab.targetId, await tab.url());
      return { ok: true, command: "outline", tab: info, elements };
    });
  },

  async click(o: BrowserOptions | Settings, p: { tab: string; target?: string; text?: string }): Promise<ClickResult> {
    if (!!p.target === !!p.text) throw new UsageError("click needs a target (#N or a selector) or --text, not both");
    return onTab(o, need(p.tab, "tab"), async (tab, info) => {
      if (p.text) await tab.clickText(p.text); else await tab.click(idx(p.target!));
      return { ok: true, command: "click", tab: info, target: p.target ?? null, text: p.text ?? null };
    });
  },

  async hover(o: BrowserOptions | Settings, p: { tab: string; target: string }): Promise<HoverResult> {
    const target = need(p.target, "target");
    return onTab(o, need(p.tab, "tab"), async (tab, info) => {
      await tab.hover(idx(target));
      return { ok: true, command: "hover", tab: info, target };
    });
  },

  async type(o: BrowserOptions | Settings, p: { tab: string; text: string; into?: string }): Promise<TypeResult> {
    if (typeof p.text !== "string") throw new UsageError("text is required");
    return onTab(o, need(p.tab, "tab"), async (tab, info) => {
      await tab.type(p.text, p.into ? idx(p.into) : undefined);
      return { ok: true, command: "type", tab: info, into: p.into ?? null, length: p.text.length };
    });
  },

  async press(o: BrowserOptions | Settings, p: { tab: string; key: string }): Promise<PressResult> {
    const key = need(p.key, "key");
    return onTab(o, need(p.tab, "tab"), async (tab, info) => {
      await tab.press(key);
      return { ok: true, command: "press", tab: info, key };
    });
  },

  async text(o: BrowserOptions | Settings, p: { tab: string; selector?: string }): Promise<TextResult> {
    return onTab(o, need(p.tab, "tab"), async (tab, info, b) => {
      const text = await tab.text(p.selector ? idx(p.selector) : undefined);
      markRead(b.settings, tab.targetId, await tab.url());
      return { ok: true, command: "text", tab: info, selector: p.selector ?? null, text };
    });
  },

  // Not Node's eval(): the expression runs inside the allowlisted page (CDP Runtime.evaluate), after the allowlist check.
  async eval(o: BrowserOptions | Settings, p: { tab: string; expression: string }): Promise<EvalResult> {
    const expression = need(p.expression, "expression");
    return onTab(o, need(p.tab, "tab"), async (tab, info) => {
      await tab.assertAllowed();
      const value = await tab.evaluate(expression);
      return { ok: true, command: "eval", tab: info, value: value === undefined ? null : value };
    });
  },

  async shot(o: BrowserOptions | Settings, p: { tab: string; path?: string; full?: boolean; size?: string; scale?: number }): Promise<ShotResult> {
    const size = p.size === undefined ? undefined : parseSize(p.size);
    const scale = p.scale === undefined ? undefined : checkScale(p.scale);
    return onTab(o, need(p.tab, "tab"), async (tab, info, b) => {
      const s = b.settings;
      if (reads(s)[tab.targetId] !== await tab.url())
        throw new ReadFirstError(`read the page first: run \`${s.commandName} outline ${info.id}\` or \`text ${info.id}\`; a screenshot is the last resort`);
      const out = p.path ? resolve(p.path) : join(statePath(s, "shots"), `${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
      // --scale alone keeps the tab's own size and changes only the pixel ratio.
      const viewport = size || scale !== undefined
        ? { ...(size ?? await tab.evaluate(() => ({ width: innerWidth, height: innerHeight }))), scale: scale ?? 1 }
        : undefined;
      return { ok: true, command: "shot", tab: info, path: await tab.screenshot(out, { fullPage: !!p.full, viewport }), fullPage: !!p.full };
    });
  },

  async fetch(o: BrowserOptions | Settings, p: { tab: string; url: string; path: string }): Promise<FetchResult> {
    const url = httpUrl(need(p.url, "url")), path = resolve(need(p.path, "path"));
    return onTab(o, need(p.tab, "tab"), async (tab, info) => {
      const r = await tab.fetchToFile(url, path);
      return { ok: true, command: "fetch", tab: info, url, path, bytes: r.bytes, contentType: r.contentType };
    });
  },

  async download(o: BrowserOptions | Settings, p: { tab: string; url: string; path: string }): Promise<DownloadResult> {
    const url = httpUrl(need(p.url, "url")), path = resolve(need(p.path, "path"));
    return onTab(o, need(p.tab, "tab"), async (tab, info) => {
      const r = await tab.download(url, path);
      return { ok: true, command: "download", tab: info, url, path, bytes: r.bytes, status: r.status };
    });
  },

  async close(o: BrowserOptions | Settings, p: { tab: string }): Promise<CloseResult> {
    return onTab(o, need(p.tab, "tab"), async (tab, info) => {
      await tab.close();
      return { ok: true, command: "close", tab: info };
    });
  },

  async net(o: BrowserOptions | Settings, p: { tab: string; seconds?: number; match?: string; max?: number }, hooks: { onEntry?: (e: NetEntry) => void } = {}): Promise<NetResult> {
    const seconds = p.seconds ?? 60, max = p.max ?? 4000;
    if (!(seconds > 0) || !(max > 0)) throw new UsageError("--seconds and --max must be positive numbers");
    if (seconds > MAX_NET_SECONDS) throw new UsageError(`--seconds is at most ${MAX_NET_SECONDS}`);
    return onTab(o, need(p.tab, "tab"), async (tab, info) => {
      const entries = await netLog(tab, seconds, p.match, max, hooks.onEntry);
      return { ok: true, command: "net", tab: info, seconds, entries };
    });
  },

  /**
   * Record the tab to MP4 while a step script drives it. Everything is checked before the connection
   * (the steps, the paths, ffmpeg). Not under the read-first rule: a recording is a video for people,
   * not a way for an agent to read a page.
   */
  async record(o: BrowserOptions | Settings, p: { tab: string; out: string; script?: string; setup?: string; size?: string; fps?: number; scale?: number;
    noCursor?: boolean; settle?: number; seed?: number; ffmpeg?: string }): Promise<RecordResult> {
    const s = resolveOptions(o);
    const plan = planRecording(p, allowlistOf(s));
    return onTab(s, need(p.tab, "tab"), async (tab, info) => {
      const r = await recordTab(tab, plan);
      const { width, height, scale } = plan.viewport;
      // The tab's URL and title from the end of the run: after the encode nothing runs in the tab again.
      const ref: TabRef = { ...info, url: r.finalUrl, title: r.title };
      return { ok: true, command: "record", tab: ref, path: plan.out, provenance: plan.provenance, width, height, scale, fps: plan.fps,
        videoWidth: r.videoWidth, videoHeight: r.videoHeight, frames: r.frames, seconds: r.seconds, maxFrameGapMs: r.maxFrameGapMs, steps: plan.steps.length,
        events: r.events, warnings: r.warnings };
    });
  },

  async commands(): Promise<CommandsResult> {
    return { ok: true, command: "commands", commands: COMMAND_SPECS };
  },
};

export type CommandName = keyof typeof commands;
