// Drive Chrome over CDP, safely. By default that is the consumer's agent browser, a dedicated Chrome
// on the consumer's own profile, with only the logins made in it (agent.ts); mode "personal" uses the
// operator's own Chrome, only when the operator asks, and then only inside the caller's own pinned window.
//
// Safety model: the tooling only opens, attaches to, or acts on page targets whose host is on the
// consumer's allowlist. Every other tab (mail, banking, admin dashboards) is never attached to; we
// only ever see its target type and URL in Target.getTargets, and even those URLs are never printed.
// Every connection goes through the consumer's proxy socket (proxy.ts).

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, statSync, rmSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { CDPConnection, CDPError } from "./cdp.ts";
import { assertAllowedUrl, isAllowedUrl, loadAllowlist, validateAllowlist } from "./allowlist.ts";
import { launchAgentChrome } from "./agent.ts";
import { approvalNeededMessage, browserTarget } from "./diagnostics.ts";
import { ApprovalNeededError, ChromeUnreachableError, NotAllowedError, PinRequiredError, TabNotFoundError, UsageError, runCleanup, withCleanupErrors } from "./errors.ts";
import { assertTestStateIsolated, macWindows, personalUserDataDir, recordPath, resolveOptions, statePath, underNodeTest, windowPerPage, type BrowserOptions, type Settings } from "./options.ts";
import { proxyUrl, socketAlive, startProxy } from "./proxy.ts";
import { withFileLock } from "./lock.ts";
import type { Hands } from "./input.ts";
import { displayOf, noticeNotOwn, type DisplayInfo } from "./display.ts";
import { ensureWatchBack } from "./watchback.ts";

export type TargetInfo = { targetId: string; type: string; url: string; title: string; attached: boolean };
/** An allowlisted page, with its name and, for a tab opened under a tab scope, that scope. */
export type PageInfo = TargetInfo & { name?: string; scope?: string };

/** The consumer's allowlist: the `allow` array, else the file. One of them is required. */
export function allowlistOf(s: Settings): string[] {
  if (s.allow) return validateAllowlist(s.allow, "allow");
  if (s.allowlistFile) return loadAllowlist(s.allowlistFile);
  throw new UsageError("an allowlist is required: pass allowlistFile (CLI: --allowlist FILE)");
}

// ---------- endpoint discovery (personal mode) ----------

/**
 * Candidate endpoints of the operator's Chrome, best first: the endpoint option, DevToolsActivePort in
 * its user-data folder, then the endpoint this consumer cached. Under a test the real profile is never
 * read: only an explicit personalUserDataDir counts.
 */
export function endpointCandidates(s: Settings): { source: string; ws: string }[] {
  const out: { source: string; ws: string }[] = [];
  if (s.endpoint) out.push({ source: "endpoint", ws: s.endpoint });
  if (!underNodeTest() || s.personalUserDataDir) try {
    const [port, path] = readFileSync(join(personalUserDataDir(s), "DevToolsActivePort"), "utf8").trim().split("\n");
    if (port && path) out.push({ source: "DevToolsActivePort", ws: `ws://127.0.0.1:${port}${path}` });
  } catch { /* unreadable, or Chrome not debuggable */ }
  try {
    const cached = JSON.parse(readFileSync(statePath(s, "chrome.json"), "utf8"));
    if (typeof cached.ws === "string") out.push({ source: "cache", ws: cached.ws });
  } catch { /* none cached */ }
  return out;
}

export function rememberEndpoint(s: Settings, ws: string) {
  writeFileSync(statePath(s, "chrome.json"), JSON.stringify({ ws }, null, 2));
}

function chromeHelp(s: Settings): string {
  const command = s.mode === "agent" ? `${s.commandName} launch --login` : `${s.commandName} --mode personal connect ws://127.0.0.1:9222/devtools/browser/<id>`;
  return `Could not reach Chrome (mode ${s.mode}). In ${s.mode === "agent" ? "the agent" : "your own"} Chrome, open chrome://inspect/#remote-debugging and enable
remote debugging. Approve the connection prompt, then retry. If needed, run
  ${command}`;
}

// ---------- browser ----------

/**
 * The tab record, in its folder (options.ts, recordDir): the state folder, or behind agent mode's endpoint (cdpUrl) the
 * endpoint scope's own folder, <stateDir>/endpoint-scopes/<scopeFolderName(scope)>/ (board task ab-v16.58). The relay
 * lists only the endpoint scope's tabs, and updateRecord drops the entries of the tabs that the connection does not
 * list, so a record that two endpoint scopes shared lost each scope's entries at the other's next change. The input
 * lock (input.lock) and pointer.json stay in the state folder: one of each for the agent browser, for every endpoint
 * scope (input.ts). tabs.json maps the name of each tab opened with no tab scope
 * to its targetId, as it always has. tab-scopes.json holds each tab opened under a tab scope, by
 * targetId: its scope and its name there (null: no name). So a name belongs to one scope, and two
 * scopes can each have a tab named "main". reads.json holds the read-first marks (targetId -> the URL
 * that outline or text last read there), and window.json the pinned window. tab-pages.json lists the
 * pages that an explicit `open --tab` opened as a background tab where each page gets a window of its
 * own (windowPerPage): they keep the old modes (see Tab.drive). Every caller of the record's folder
 * writes these five files, so each of them changes only under the record lock (updateRecord).
 */
type Registry = Record<string, string>; // tab name -> targetId (tabs with no scope)
type ScopeRecord = Record<string, { scope: string; name: string | null }>; // targetId -> its scope and its name there
type Reads = Record<string, string>; // targetId -> the URL that outline or text read
/** The whole record, as a change under the lock sees it and changes it. */
type TabRecord = { registry: Registry; scopes: ScopeRecord; reads: Reads; window: number | undefined; tabPages: string[] };
const REGISTRY_FILE = "tabs.json", SCOPES_FILE = "tab-scopes.json", READS_FILE = "reads.json", WINDOW_FILE = "window.json", TAB_PAGES_FILE = "tab-pages.json",
  RECORD_LOCK = "tabs.lock";

/**
 * How agent-browser drives a page (ab-v16.26). "window": a page in a window of its own, or a tab that a
 * site or a pinned window put in front of its window, where each page gets a window of its own
 * (windowPerPage): no focus emulation, as a person's page. "focus-emulation": the old default, focus
 * emulation while a command is attached (personal mode, an explicit `open --tab` in agent mode, a display
 * that is not the agent browser's own on Linux, and the relay on the Mac). "hidden": the old hiddenDrive, no focus emulation and input and shots under Tab.whileDrawn and
 * Tab.whileDrawnForShot (the same places, with hiddenDrive).
 */
export type Drive = "window" | "focus-emulation" | "hidden";

/** Write JSON to a temporary file and rename it over `path`, so a reader never sees half a file. */
function writeJsonAtomic(path: string, value: unknown) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

export class AgentBrowser {
  readonly conn: CDPConnection;
  readonly settings: Settings;
  readonly allow: string[];
  readonly product: string;
  /**
   * The design of one window per page applies: agent mode on Linux (windowPerPage; ab-v16.26), with the agent Chrome
   * on a display of its own (display.ts), and agent mode on the Mac (macWindows; ab-v16.27). Else every page is driven
   * as before, in a background tab.
   */
  readonly windows: boolean;
  /**
   * The Mac's design (macWindows; ab-v16.27): no command ever activates a window (no Page.bringToFront, no
   * Target.activateTarget). A hidden window page (behind a popup tab in its window) is not brought in front: its input
   * waits until it shows again, which it does about 1.0 s after that popup closed (Tab.toFront, input.ts).
   */
  readonly mac: boolean;
  /** What agent-browser found of the agent Chrome's display (display.ts), where the design can apply; else undefined. */
  readonly display: DisplayInfo | undefined;
  private sessions = new Map<string, Tab>();
  private notedDisplay = false;

  private constructor(conn: CDPConnection, settings: Settings, allow: string[], product: string, display: DisplayInfo | undefined) {
    this.conn = conn;
    this.settings = settings;
    this.allow = allow;
    this.product = product;
    this.display = display;
    this.mac = macWindows(settings);
    this.windows = this.mac || !!display?.own;
  }

  /**
   * Connect through the consumer's proxy socket. A live proxy is an approved connection and is used
   * first. Otherwise the upstream endpoint is found (the endpoint option; in agent mode the agent
   * Chrome, launched if needed; in personal mode the operator's Chrome), a proxy is started for it,
   * and the connection goes through that proxy. With existingOnly, nothing is launched or started.
   * `launch` (@internal, tests only) replaces launchAgentChrome.
   */
  static async connect(options: BrowserOptions | Settings, opts: { existingOnly?: boolean; launch?: typeof launchAgentChrome } = {}): Promise<AgentBrowser> {
    const s = resolveOptions(options);
    const allow = allowlistOf(s);
    assertTestStateIsolated(s);
    // Agent mode's endpoint: the relay is the one connection; no proxy, no launch, no prompt.
    if (s.cdpUrl) {
      try { return await AgentBrowser.over(s.cdpUrl, s, allow); }
      catch (e) { throw new ChromeUnreachableError(`agent mode's endpoint did not answer (${(e as Error).message})`, { cause: e }); }
    }
    // On the Mac the give-back watcher runs for as long as the agent Chrome does (watchback.ts): each command that connects
    // makes sure of it, after the proxy is up (so after an approval that a new connection needed). Not for a diagnosis.
    const watch = async (b: AgentBrowser) => { if (!opts.existingOnly && macWindows(s)) await ensureWatchBack(s); return b; };
    if (existsSync(s.socketPath) && await socketAlive(s.socketPath)) {
      try { return await watch(await AgentBrowser.fromProxy(s, allow)); } catch { /* stale or broken proxy */ }
    }
    if (opts.existingOnly) throw new ChromeUnreachableError("no usable existing Chrome proxy; diagnosis does not launch or connect upstream");
    // Checked before any launch: a new Chrome needs a new approval too.
    if (s.noPrompt) throw new ApprovalNeededError(approvalNeededMessage(s, browserTarget(s)));
    // No give-back guard for this start: it leaves the agent Chrome in front (its first window takes the front),
    // so Chrome's approval prompt, which the proxy's connection raises next, shows in front until the operator
    // answers it (test/agent.test.ts holds this).
    const start = opts.launch ?? launchAgentChrome;
    const candidates = s.mode === "agent"
      ? [{ source: s.endpoint ? "endpoint" : "agent profile", ws: s.endpoint ?? await start(s, { background: true, giveBack: false }) }]
      : endpointCandidates(s);
    let lastErr: unknown;
    for (const c of candidates) {
      try {
        await startProxy(s, c.ws);
        if (s.mode === "personal" && c.source !== "cache") rememberEndpoint(s, c.ws);
        return await watch(await AgentBrowser.fromProxy(s, allow));
      } catch (e) { lastErr = e; }
    }
    // Chrome's instant refusal, and a prompt that nobody answered, are their own causes: remote debugging is on there, so the general help would mislead.
    const message = (lastErr as Error | undefined)?.message ?? "";
    if (/refused the connection without a prompt|until a person answers its/.test(message)) throw new ChromeUnreachableError(message, { cause: lastErr });
    throw new ChromeUnreachableError(`${chromeHelp(s)}${lastErr ? `\n(${message})` : ""}`, { cause: lastErr });
  }

  private static fromProxy(s: Settings, allow: string[]): Promise<AgentBrowser> { return AgentBrowser.over(proxyUrl(s), s, allow); }

  private static async over(url: string, s: Settings, allow: string[]): Promise<AgentBrowser> {
    const conn = await CDPConnection.connect(url, 5_000);
    try {
      const v = await conn.send("Browser.getVersion", {}, undefined, 5_000);
      // The display check is Linux's (an X display of its own); the Mac's design needs none.
      const display = windowPerPage(s) && !macWindows(s) ? await displayOf(s) : undefined;
      return new AgentBrowser(conn, s, allow, v.product, display);
    } catch (e) {
      await conn.close();
      throw e;
    }
  }

  get mode() { return this.settings.mode; }

  /**
   * The log line of a display that is not the agent browser's own (display.ts, noticeNotOwn): at the first page that
   * this connection opens or attaches, whose drive it changes, never at a command that only lists (review-45c).
   */
  private noteDisplay(): void {
    if (this.notedDisplay || !this.display || this.display.own) return;
    this.notedDisplay = true;
    noticeNotOwn(this.settings, this.display);
  }

  /** The tab scope this browser works in, or undefined: every tab. */
  get tabScope(): string | undefined { return this.settings.tabScope; }

  // --- the tab record (names and scopes), persisted across CLI invocations ---

  private readRegistry(): Registry {
    try { return JSON.parse(readFileSync(recordPath(this.settings, REGISTRY_FILE), "utf8")); } catch { return {}; }
  }

  private readScopes(): ScopeRecord {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(recordPath(this.settings, SCOPES_FILE), "utf8")); } catch { return {}; }
    const out: ScopeRecord = {};
    if (raw && typeof raw === "object" && !Array.isArray(raw)) for (const [id, e] of Object.entries(raw as Record<string, { scope?: unknown; name?: unknown }>))
      if (e && typeof e.scope === "string" && (e.name === null || typeof e.name === "string")) out[id] = { scope: e.scope, name: e.name };
    return out;
  }

  private readTabPages(): string[] {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(recordPath(this.settings, TAB_PAGES_FILE), "utf8")); } catch { return []; }
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
  }

  private readMarks(): Reads {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(recordPath(this.settings, READS_FILE), "utf8")); } catch { return {}; }
    const out: Reads = {};
    if (raw && typeof raw === "object" && !Array.isArray(raw)) for (const [id, url] of Object.entries(raw as Record<string, unknown>))
      if (typeof url === "string") out[id] = url;
    return out;
  }

  /**
   * Change the tab record (tabs.json, tab-scopes.json, reads.json, window.json, tab-pages.json) under the record
   * folder's lock (tabs.lock; recordDir): several processes (CLI calls of different sessions) write it, and a
   * read-modify-write without the lock can lose another's change. The entries of tabs that Chrome no
   * longer has (that this connection's Target.getTargets does not list: behind agent mode's endpoint, the endpoint
   * scope's tabs only, so each endpoint scope has a record of its own) are dropped here, from the names, the scopes,
   * the read marks and the tab pages. The target list is
   * read inside the lock, so a tab that another process recorded before this one took the lock is in
   * it; when the list cannot be read, nothing is dropped. Only a file that changed is written, to a
   * temporary file renamed over it, so a reader (which takes no lock) never sees half a file.
   */
  private async updateRecord(change: (r: TabRecord) => void): Promise<void> {
    await withFileLock(recordPath(this.settings, RECORD_LOCK), Date.now() + 10_000, async () => {
      const r: TabRecord = { registry: this.readRegistry(), scopes: this.readScopes(), reads: this.readMarks(), window: this.pinnedWindow(), tabPages: this.readTabPages() };
      const before = { registry: JSON.stringify(r.registry), scopes: JSON.stringify(r.scopes), reads: JSON.stringify(r.reads), window: r.window, tabPages: JSON.stringify(r.tabPages) };
      change(r);
      const live = await this.conn.send("Target.getTargets", {}, undefined, 5_000)
        .then(({ targetInfos }) => new Set((targetInfos as TargetInfo[]).map((t) => t.targetId)), () => undefined);
      if (live) {
        for (const [name, id] of Object.entries(r.registry)) if (!live.has(id)) delete r.registry[name];
        for (const id of Object.keys(r.scopes)) if (!live.has(id)) delete r.scopes[id];
        for (const id of Object.keys(r.reads)) if (!live.has(id)) delete r.reads[id];
        r.tabPages = r.tabPages.filter((id) => live.has(id));
      }
      if (JSON.stringify(r.registry) !== before.registry) writeJsonAtomic(recordPath(this.settings, REGISTRY_FILE), r.registry);
      if (JSON.stringify(r.scopes) !== before.scopes) writeJsonAtomic(recordPath(this.settings, SCOPES_FILE), r.scopes);
      if (JSON.stringify(r.reads) !== before.reads) writeJsonAtomic(recordPath(this.settings, READS_FILE), r.reads);
      if (JSON.stringify(r.tabPages) !== before.tabPages) writeJsonAtomic(recordPath(this.settings, TAB_PAGES_FILE), r.tabPages);
      if (r.window !== before.window) {
        if (r.window === undefined) rmSync(recordPath(this.settings, WINDOW_FILE), { force: true });
        else writeJsonAtomic(recordPath(this.settings, WINDOW_FILE), { windowId: r.window });
      }
    }, "the tab record lock");
  }

  // --- the read-first rule: a screenshot needs an outline or text of the same tab at the same URL ---

  /** The URL at which outline or text last read this tab, if any (commands.shot checks it). */
  readMark(targetId: string): string | undefined {
    return this.readMarks()[targetId];
  }

  /** Record that outline or text read this tab at this URL (under the record lock). */
  async markRead(targetId: string, url: string): Promise<void> {
    await this.updateRecord((r) => { r.reads[targetId] = url; });
  }

  // --- the pinned window: when pinned, nothing outside that one Chrome window is touched ---

  pinnedWindow(): number | undefined {
    try { return JSON.parse(readFileSync(recordPath(this.settings, WINDOW_FILE), "utf8")).windowId; } catch { return undefined; }
  }

  /** Pin this window, or clear the pin (undefined). Async: it writes window.json under the record lock. */
  async pinWindow(windowId: number | undefined): Promise<void> {
    await this.updateRecord((r) => { r.window = windowId; });
  }

  /** Personal mode acts only inside the caller's own pinned window. */
  assertPinned(): void {
    if (this.mode === "personal" && this.pinnedWindow() === undefined)
      throw new PinRequiredError(`personal mode acts only in a pinned window: run \`${this.settings.commandName} --mode personal open <url>\` (it opens and pins a window of its own), or \`window pin <tab>\``);
  }

  async windowOf(targetId: string): Promise<number> {
    const { windowId } = await this.conn.send("Browser.getWindowForTarget", { targetId });
    return windowId;
  }

  /** An allowlisted page, in the pinned window if one is pinned: a tab we may touch. */
  private async reachable(t: TargetInfo, win = this.pinnedWindow()): Promise<boolean> {
    if (t.type !== "page" || !isAllowedUrl(t.url, this.allow)) return false;
    return win === undefined || (await this.windowOf(t.targetId).catch(() => -1)) === win;
  }

  /**
   * Page targets on allowlisted hosts (and in the pinned window, if one is pinned).
   * Other tabs are filtered out before anything sees them. With a tab scope, only the scope's tabs,
   * unless anyScope: then every such tab, each with its scope (none for a tab with no scope).
   */
  async allowedPages(opts: { anyScope?: boolean } = {}): Promise<PageInfo[]> {
    const { targetInfos } = await this.conn.send("Target.getTargets");
    const reg = this.readRegistry(), scopes = this.readScopes();
    const byId = new Map(Object.entries(reg).map(([n, id]) => [id, n]));
    const only = opts.anyScope ? undefined : this.tabScope;
    const out: PageInfo[] = [];
    for (const t of targetInfos as TargetInfo[]) {
      const scoped = scopes[t.targetId];
      if (only !== undefined && scoped?.scope !== only) continue; // another scope's tab, or one with no scope: not even its window is asked for
      if (!(await this.reachable(t))) continue;
      out.push(scoped ? { ...t, name: scoped.name ?? undefined, scope: scoped.scope } : { ...t, name: byId.get(t.targetId) });
    }
    return out;
  }

  /** Count of page targets we are not allowed to touch (for status output only). */
  async otherPageCount(): Promise<number> {
    const { targetInfos } = await this.conn.send("Target.getTargets");
    const pages = (targetInfos as TargetInfo[]).filter((t) => t.type === "page");
    return pages.length - (await this.allowedPages({ anyScope: true })).length;
  }

  /**
   * Open a page and navigate it. With a pinned window the tab opens inside that window. In the agent
   * browser on Linux (windowPerPage, ab-v16.26) and on the Mac (macWindows, ab-v16.27) it gets a window of
   * its own (Target.createTarget with newWindow and background: a new window without the focus; on the Mac
   * it comes behind the front window, measured 2026-11-05 and 2026-11-06), driven with no focus emulation:
   * its page is visible and draws, as a person's window that is not in front, and it gets the focus only
   * with the agent's input. An explicit newWindow: false (`open --tab`) opens a background tab there
   * instead, which keeps the old modes (Tab.drive): a site can tell such a tab from a person's. A
   * foreground tab activated Chrome on the Mac, which took the operator's focus and Space (measured
   * 2026-10-30). Between commands a background tab is hidden and its timers
   * slow down as in plain Chrome (the agent browser has no timer flags after release v0.2.9); during
   * each command its page is visible. Click, type, eval, text, shot and record still work in it
   * (test/live/background-tabs/check.ts; measured on Linux only: on macOS a recording of a background
   * tab may now get about 28 fps, which is not measured again). In the operator's Chrome with no pin,
   * it gets a window of its own, opened behind theirs, and that window is pinned at once: there a
   * background *tab* was throttled and trusted input stalled, while a separate window renders normally
   * without stealing focus.
   */
  async open(url: string, opts: { name?: string; newWindow?: boolean; timeoutMs?: number } = {}): Promise<Tab> {
    assertAllowedUrl(url, this.allow);
    this.noteDisplay();
    const win = this.pinnedWindow();
    const agent = this.mode === "agent", windows = this.windows;
    // An explicit tab where each page gets a window of its own: it keeps the old modes (Tab.drive). Also in the gate's
    // fallback (a display that is not the agent browser's own): so the tab keeps them when the gate opens later
    // (review-45b note 6). Over agent mode's endpoint the relay opens a window for every page (ab-v16.28), so there it
    // is a window page like any other.
    const tabPage = windowPerPage(this.settings) && opts.newWindow === false && !this.settings.cdpUrl;
    let targetId: string;
    if (win !== undefined) targetId = await this.openInWindow(win);
    else {
      if (!agent && opts.newWindow === false)
        throw new PinRequiredError("personal mode: no window is pinned, so a tab has no window of its own to open in; open without --tab to get one");
      targetId = (await this.conn.send("Target.createTarget", { url: "about:blank", background: true, newWindow: opts.newWindow ?? (!agent || windows) })).targetId;
    }
    // The new tab exists from here. When it cannot be recorded (the record lock timed out, say) or
    // attached, it is closed again (best effort), so it never stays as a tab that nobody recorded:
    // under a tab scope that would be a "no scope" tab that every other caller sees.
    let tab: Tab;
    try {
      // Personal mode with no pin: the tab's own new window is pinned at once, in the same change as its record.
      const pin = win === undefined && !agent ? await this.windowOf(targetId) : undefined;
      const scope = this.tabScope, name = opts.name;
      if (pin !== undefined || scope !== undefined || name || tabPage) await this.updateRecord((r) => {
        if (pin !== undefined) r.window = pin;
        if (tabPage) r.tabPages.push(targetId);
        if (scope !== undefined) {
          // A name belongs to one tab of the scope: a tab that had it before keeps its place in the scope, without the name.
          if (name) for (const e of Object.values(r.scopes)) if (e.scope === scope && e.name === name) e.name = null;
          r.scopes[targetId] = { scope, name: name || null };
        } else if (name) r.registry[name] = targetId;
      });
      tab = await this.attach(targetId);
    } catch (e) {
      await this.conn.send("Target.closeTarget", { targetId }, undefined, 5_000).catch(() => {});
      throw e;
    }
    if (url !== "about:blank") {
      try { await tab.goto(url, { timeoutMs: opts.timeoutMs }); }
      catch (e) {
        // A refused navigation (the relay's CDP error "Not allowed:" over --cdp-url, or our own allowlist) leaves the empty tab that
        // this call created: close it (best effort) and report the refusal as before (ab-v16.59). Any other failure keeps the tab.
        if (e instanceof NotAllowedError || /^Page\.navigate: Not allowed:/.test((e as Error)?.message ?? ""))
          await this.conn.send("Target.closeTarget", { targetId }, undefined, 5_000).catch(() => {});
        throw e;
      }
    }
    return tab;
  }

  /**
   * CDP cannot create a tab in a chosen window, so ask a tab that is already in the pinned
   * window to window.open() one; Chrome puts it in the opener's window.
   */
  private async openInWindow(win: number): Promise<string> {
    // Any allowlisted tab in the pinned window can open the new one; this scope's own tab first.
    const pages = await this.allowedPages({ anyScope: true });
    if (!pages.length) throw new Error("the pinned window has no allowlisted tab to open from; open one there by hand");
    const before = new Set(((await this.conn.send("Target.getTargets")).targetInfos as TargetInfo[]).map((t) => t.targetId));
    const opener = await this.attach((pages.find((p) => this.tabScope !== undefined && p.scope === this.tabScope) ?? pages[0]).targetId);
    await opener.evaluateAsUser(() => { window.open("about:blank", "_blank"); });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const { targetInfos } = await this.conn.send("Target.getTargets");
      const fresh = (targetInfos as TargetInfo[]).find((t) => t.type === "page" && !before.has(t.targetId));
      if (fresh) {
        if ((await this.windowOf(fresh.targetId)) !== win) {
          await this.conn.send("Target.closeTarget", { targetId: fresh.targetId });
          throw new Error("new tab landed outside the pinned window; closed it");
        }
        return fresh.targetId;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("timed out opening a tab in the pinned window (popup blocked?)");
  }

  /**
   * Resolve an allowlisted tab by name, targetId (prefix), or URL substring, without attaching. With a
   * tab scope, all three forms look only among the scope's tabs; when only a tab outside the scope
   * matches by name or target-id prefix, the error says so and names --any-scope, and never that tab's
   * URL or title. A URL substring that matches only outside the scope gets the plain "no tab" error:
   * the hint would let a caller test the other scopes' URLs one substring at a time. With no scope, or
   * with anyScope, they look among every allowlisted tab (see match).
   */
  async resolve(ref: string, opts: { anyScope?: boolean } = {}): Promise<PageInfo> {
    if (!ref) throw new UsageError("a tab reference is required");
    const scope = this.tabScope, cmd = this.settings.commandName;
    const pages = await this.allowedPages(opts);
    const reg = this.readRegistry();
    const hit = this.match(ref, pages, reg);
    if (hit) return hit;
    if (scope === undefined || opts.anyScope) throw new TabNotFoundError(`no allowlisted tab matches "${ref}" (see: ${cmd} tabs${scope === undefined ? "" : " --any-scope"})`);
    let outside = false;
    try { outside = this.match(ref, await this.allowedPages({ anyScope: true }), reg, { byUrl: false }) !== undefined; }
    catch (e) { if (!(e instanceof TabNotFoundError)) throw e; outside = true; } // a name of two other scopes: it matches outside too
    if (outside) throw new TabNotFoundError(`no tab of scope "${scope}" matches "${ref}", but a tab outside this scope does (another scope's, or one with no scope); pass --any-scope to reach it`);
    throw new TabNotFoundError(`no allowlisted tab of scope "${scope}" matches "${ref}" (see: ${cmd} tabs)`);
  }

  /**
   * The tab `ref` names among `pages`, first hit wins: a name (of this scope, then of a tab with no
   * scope, then of another scope, an error when two other scopes use it), a target-id prefix, a URL
   * substring (unless byUrl is false).
   */
  private match(ref: string, pages: PageInfo[], reg: Registry, opts: { byUrl?: boolean } = {}): PageInfo | undefined {
    const scope = this.tabScope;
    const own = scope === undefined ? undefined : pages.find((p) => p.scope === scope && p.name === ref);
    if (own) return own;
    const unscoped = pages.find((p) => p.scope === undefined && p.targetId === reg[ref]);
    if (unscoped) return unscoped;
    const others = pages.filter((p) => p.scope !== undefined && p.scope !== scope && p.name === ref);
    if (others.length > 1)
      throw new TabNotFoundError(`"${ref}" names a tab in each of ${others.length} other scopes; use the tab's target-id prefix (see: ${this.settings.commandName} tabs${scope === undefined ? "" : " --any-scope"})`);
    return others[0]
      ?? pages.find((p) => p.targetId.toLowerCase().startsWith(ref.toLowerCase()))
      ?? (opts.byUrl === false ? undefined : pages.find((p) => p.url.includes(ref)));
  }

  /** Find an allowlisted tab (see resolve) and attach to it. */
  async find(ref: string, opts: { anyScope?: boolean } = {}): Promise<Tab> {
    return this.attach((await this.resolve(ref, opts)).targetId);
  }

  async attach(targetId: string): Promise<Tab> {
    this.assertPinned();
    this.noteDisplay();
    const existing = this.sessions.get(targetId);
    if (existing) return existing;
    const { targetInfos } = await this.conn.send("Target.getTargets");
    const info = (targetInfos as TargetInfo[]).find((t) => t.targetId === targetId);
    if (!info || info.type !== "page") throw new TabNotFoundError(`target ${targetId} is not an open page`);
    if (!isAllowedUrl(info.url, this.allow)) throw new NotAllowedError(info.url);
    if (!(await this.reachable(info))) throw new NotAllowedError(info.url, "refusing: that tab is outside the pinned window");
    const { sessionId } = await this.conn.send("Target.attachToTarget", { targetId, flatten: true });
    const tab = new Tab(this, targetId, sessionId, this.driveOf(targetId));
    await tab.send("Page.enable");
    // Our injected code runs in an isolated world (see evaluate), so the Runtime domain stays off:
    // a page can tell the Runtime domain is enabled, and we never need its events.
    // Focus emulation lets a page in a background tab or an unfocused window accept trusted input and
    // draw. It also makes a background tab's page "visible" (a visible capture in Chromium's
    // emulation_handler.cc) for as long as the session is attached: a site sees each command as a
    // visibilitychange to "visible" and back, and a focus that no blur follows. With hiddenDrive there
    // is none (ab-v16.15): input and shots in a background tab run under Tab.whileDrawn and
    // Tab.whileDrawnForShot, which keep the page "hidden". A page in a window of its own needs none
    // (ab-v16.26): Chrome draws it, and the agent's input gives it the focus, as a person's does.
    if (tab.drive === "focus-emulation") await tab.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    this.sessions.set(targetId, tab);
    return tab;
  }

  /**
   * How a page is driven (Drive): where each page gets a window of its own (windowPerPage), "window",
   * except a tab of an explicit `open --tab`; elsewhere the old modes, by the hiddenDrive option.
   */
  driveOf(targetId: string): Drive {
    if (this.windows && !this.readTabPages().includes(targetId)) return "window";
    return this.settings.hiddenDrive ? "hidden" : "focus-emulation";
  }

  /** Drop a closed tab: its session, its name, its place in a tab scope, its read mark and its tab-page mark. Async: the record changes under its lock. */
  async forget(targetId: string): Promise<void> {
    this.sessions.delete(targetId);
    await this.updateRecord((r) => {
      for (const [n, id] of Object.entries(r.registry)) if (id === targetId) delete r.registry[n];
      delete r.scopes[targetId];
      delete r.reads[targetId];
      r.tabPages = r.tabPages.filter((id) => id !== targetId);
    });
  }

  /** Detach from everything and close the socket. Tabs stay open. */
  async disconnect() {
    for (const tab of this.sessions.values()) {
      await this.conn.send("Target.detachFromTarget", { sessionId: tab.sessionId }).catch(() => {});
    }
    this.sessions.clear();
    await this.conn.close();
  }
}

// ---------- tab ----------

export type Download = { path: string; suggestedFilename: string; url: string };
export type CapturedResponse = { url: string; status: number; mimeType: string; body: string };

export const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  // F1 to F12, key codes 112 to 123. Most are also Chrome's own shortcuts; keyFields sends them to the page only.
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, { code: `F${i + 1}`, keyCode: 112 + i }])),
};

/**
 * The key fields of one Input.dispatchKeyEvent. A function key goes without nativeVirtualKeyCode: Chrome
 * then marks the event skip_if_unhandled, and never runs it as one of its own shortcuts, before the page
 * or after it (F1 help, F5 reload, F11 full screen, F12 DevTools, Control+F4 closes the tab; F3, F6, F7
 * and F10 take the focus to Chrome's own UI). The page still gets the key. (Chromium
 * content/browser/devtools/protocol/input_handler.cc, InputHandler::DispatchKeyEvent; measured in
 * test/live/function-keys/.) Other keys keep their native key code, as before.
 */
export function keyFields(key: string, code: string, keyCode: number, modifiers = 0) {
  return { key, code, windowsVirtualKeyCode: keyCode, ...(/^F\d+$/.test(code) ? {} : { nativeVirtualKeyCode: keyCode }), modifiers };
}

/** An empty path is a usage error, before any CDP call: "" would be the current folder (fetchToFile wrote "./.part"). */
function notEmpty(path: string, method: string): void {
  if (path === "") throw new UsageError(`${method}: the path is empty`);
}

/** An exact page size for a screenshot or a recording: CSS pixels and a device pixel ratio. */
export type Viewport = { width: number; height: number; scale: number };

/** The capture of a shot's picture (Tab.whileDrawnForShot gives it to the shot); `resized`: under the shot's size override. */
type OwnCapture = (params: Record<string, unknown>, resized?: boolean) => Promise<{ data: string }>;
/**
 * What Tab.whileDrawnForShot gives the shot: its own capture, and `underLeft`, for a shot with a size override, before
 * the override is cleared: last captures go out under the override, when Chrome can still end them, and it gives the
 * number of the shot's captures sent under the override that Chrome may still hold.
 */
type ShotCaptures = { own: OwnCapture; underLeft: () => Promise<number> };
/** The cheapest capture, with no clip: for Tab.whileDrawn and Tab.whileDrawnForShot, which do not use its picture. */
const HOLD_CAPTURE = { format: "jpeg", quality: 1, optimizeForSpeed: true };

/** A shot whose own capture Chrome did not end in time. */
class ShotTimeout extends Error {
  readonly head: string;
  readonly tail: string;
  constructor(head: string, tail: string) {
    super(`${head}. ${tail}`);
    this.head = head;
    this.tail = tail;
  }
  /**
   * Add the shot's whole time after the head of the message (and of the stack, which starts with it).
   * Only the head changes: a note that came later (withCleanupErrors) stays.
   */
  gaveUpAfter(ms: number) {
    const head = `${this.head}; the shot gave up after ${(ms / 1000).toFixed(1)} s`;
    this.message = this.message.replace(this.head, head);
    if (this.stack?.includes(this.head)) this.stack = this.stack.replace(this.head, head);
  }
}

/** True when `p` has not settled after `ms`. */
async function late(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p.then(() => false, () => false), new Promise<boolean>((r) => { timer = setTimeout(() => r(true), ms); })]);
  } finally { clearTimeout(timer); }
}

/**
 * The captures that keep Chrome drawing a tab's page while it is not in front (Tab.whileDrawn, Tab.whileDrawnForShot),
 * in the order sent. Done: Chrome answered it, refused it, or ended it with a later one (Chrome ends every earlier
 * capture with a later one). A capture that timed out is not done: Chrome may still hold it.
 */
class HeldCaptures {
  private readonly sent: { done: boolean; under: boolean }[] = [];
  private readonly tab: Tab;
  constructor(tab: Tab) { this.tab = tab; }

  /** The captures in flight. */
  held(): number { return this.sent.filter((c) => !c.done).length; }

  /** The captures in flight that went out under a size override (`under`): each sets it again when it ends. */
  heldUnder(): number { return this.sent.filter((c) => !c.done && c.under).length; }

  /** Track a capture (any params; `under`: sent under a size override): when it ends, it and every earlier one are done. */
  track<R>(p: Promise<R>, under = false): Promise<R> {
    const me = { done: false, under };
    this.sent.push(me);
    return p.then((v) => { for (const c of this.sent.slice(0, this.sent.indexOf(me) + 1)) c.done = true; return v; },
      (e) => { if (e instanceof CDPError && e.code !== undefined) me.done = true; throw e; });
  }

  /**
   * The cheapest capture, with no clip (a clip resizes the page for the capture). Its picture is not
   * used. True when it ended, else why not: a timeout, or Chrome's own error.
   */
  capture(timeoutMs: number, under = false): Promise<true | string> {
    return this.track(this.tab.send("Page.captureScreenshot", HOLD_CAPTURE, timeoutMs), under).then(() => true as const, (e) =>
      e instanceof CDPError && /no response after/.test(e.message) ? `did not end in ${timeoutMs / 1000} s` : `failed (${(e as Error).message})`);
  }

  /**
   * The last captures, when one is in flight: true when they ended, else why the last one did not. The last capture
   * ends after the next frame (45 to 100 ms on taylor; about 1 s in the default mode), and every earlier one with it.
   * When it waits too (the earlier ones ended just before it was sent, on a page that draws nothing new), it holds
   * the page drawing, so one more ends it: at most three more.
   */
  async last(timeoutMs: number, under = false): Promise<true | string> {
    return this.held() ? this.chain(timeoutMs, under) : true;
  }

  /** The chain of last(), also when this object sent no capture: a later capture ends every earlier one (Tab.endSizeLeft). */
  async chain(timeoutMs: number, under = false): Promise<true | string> {
    let last = this.capture(timeoutMs, under);
    for (let more = 0; more < 3; more++) {
      if (!(await late(last, 250))) break;
      last = this.capture(timeoutMs, under);
    }
    return last;
  }
}

/** The log line of last captures that did not end (Tab.whileDrawn, Tab.whileDrawnForShot); `note` comes at its end. */
function stayLine(targetId: string, hidden: boolean, why: string, left: number, note = ""): string {
  return `agent-browser: the last ${hidden ? "hidden " : ""}capture of tab ${targetId.slice(0, 8)} ${why}; ${left} capture${left > 1 ? "s" : ""} of it stay${left > 1 ? "" : "s"} in flight, and Chrome can keep drawing that background tab until its next capture${note}`;
}

export class Tab {
  readonly browser: AgentBrowser;
  readonly targetId: string;
  readonly sessionId: string;
  /** How this page is driven (AgentBrowser.driveOf): a window of its own, or one of the old modes of a tab. */
  readonly drive: Drive;

  constructor(browser: AgentBrowser, targetId: string, sessionId: string, drive?: Drive) {
    this.browser = browser;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.drive = drive ?? browser.driveOf?.(targetId) ?? "focus-emulation";
  }

  private isolatedContextId?: number;
  private mainFrameId?: string;

  send<T = any>(method: string, params: object = {}, timeoutMs?: number): Promise<T> {
    return this.browser.conn.send<T>(method, params, this.sessionId, timeoutMs);
  }

  /**
   * Timing of a shot under whileDrawnForShot (ab-b84.17), in ms. `framesMs`: the limit of the wait for two
   * frames after the shot's first capture. `lateMs`: when the shot's own capture has not ended after
   * this long, one more capture goes out to end it. `ownMs`: the timeout of the shot's own capture.
   * `lastMs`: the timeout of each last capture (also after input). `underMs`: how long a failed shot
   * that changed the size waits for its captures sent under the size override to end by themselves, before its last
   * captures go out under it. Static, so that a test can make them shorter.
   * Measured on taylor with Chromium 156 (2026-11-05, 12 shots in the default mode and 6 with
   * hiddenDrive; README, **A shot, in both modes**): the two frames came in 0.02 to 2.03 s in the
   * default mode (a background tab draws about once a second there), and in 0.02 s with hiddenDrive;
   * the shot's own capture then ended in 1.07 to 2.10 s, and in 0.07 s.
   */
  static readonly shotTiming = { framesMs: 5000, lateMs: 3000, ownMs: 30_000, lastMs: 5000, underMs: 3000 };

  /**
   * Run `fn` (input) while Chrome draws this tab's page: with hiddenDrive (ab-v16.15). Else, or with hiddenDrive for
   * a tab in front, `fn` runs as it is: focus emulation (attach) or the tab itself makes Chrome draw; a page in a
   * window of its own comes in front of its window first (toFront). A shot has a method of its own
   * (whileDrawnForShot). Chrome draws no frame of a tab that is not in front. There a page that never drew one (it
   * loaded in the background) drops each click and key (Blink drops input until a page's first commit), a mouse
   * move waits for the next frame (up to 5 s, Blink's fallback timer), and a shot waits for a frame that never
   * comes. A Page.captureScreenshot in flight makes Chrome draw the tab and leaves the page hidden (a hidden
   * capture, stay_hidden in Chromium's page_handler.cc): the page sees no visibilitychange. So one capture is in
   * flight while `fn` runs, and a last one ends them all: after it, Chrome draws nothing again. Measured on taylor
   * with Chromium 156 (test/live/background-tabs/visibility.ts; README, **A command on a background tab: two
   * modes**).
   *
   * How a capture ends. Chrome ends a capture when the frame that it forces is presented
   * (RenderWidgetHostImpl::GetSnapshotFromBrowser waits for ForceRedraw), and a frame of a tab that is
   * not in front is never on screen: it counts only when a later frame replaces it. A page that changes
   * by itself (a caret, an animation) draws one; on a page that does not change, only a later capture
   * does, and Chrome then ends every earlier capture with it. But two captures sent before Chrome drew
   * a frame share the frame that they force, and nothing replaces it: then both wait.
   *
   * The allowlist is checked before the first capture: a page off it gets none. When `fn` itself takes
   * the tab off the list (a click on a link), the last captures still reach the new page; their
   * pictures are dropped, as every hold capture's is.
   *
   * `repeat` sends a new capture each time one ends (on a page that draws by itself, each one ends after
   * a frame).
   */
  private async whileDrawn<T>(fn: () => Promise<T>, opts: { repeat?: boolean } = {}): Promise<T> {
    await this.endSizeLeft();
    if (this.drive !== "hidden") { await this.toFront(); return fn(); }
    await this.assertAllowed();
    if (await this.evaluate(() => document.visibilityState) !== "hidden") return fn();
    const caps = new HeldCaptures(this);
    let done = false;
    void (async () => { while ((await caps.capture(10 * 60_000)) === true && opts.repeat && !done); })();
    try {
      // The first frame ends Blink's input suppression, the second one comes after its commit.
      await this.twoFrames(2000);
      return await fn();
    } finally {
      done = true;
      const r = await caps.last(Tab.shotTiming.lastMs);
      if (r !== true) this.browser.settings.log(stayLine(this.targetId, true, r, caps.held()));
    }
  }

  /**
   * Run a shot (`fn`) while Chrome draws this tab's page (ab-b84.17): in both modes, and also for a page in a window
   * of its own. With hiddenDrive for a tab in front, `fn` runs as it is. It works as whileDrawn (see there: how a
   * capture ends) with these differences.
   *
   * After its first capture, the shot waits for two frames (`twoFrames`) before its own capture goes out: that frame
   * between them is what ends the first capture and the shot's own. review-41 measured it on taylor:
   * with no wait, 8 of 8 default-mode shots and 4 of 4 hiddenDrive shots failed after 30 s. The second
   * frame is for a complete picture too: a frame drawn just after Chrome starts to draw a page can lack
   * the tiles below its first row (a shot of only the top 256 px, once in 30 shots of a hidden tab).
   * In the default mode, Chrome draws a background tab about once a second, so the wait takes up to 2 s
   * there; its limit is `shotTiming.framesMs`. When the limit comes first, a log line says so. With one
   * frame the shot goes on; with none it fails at once with a clear error: Chrome would end neither
   * capture, and the shot would wait 30 s for nothing. Focus emulation makes every page "visible", so in
   * the default mode a shot cannot tell a tab in front from a background one, and always gets a capture
   * in flight; in front it ends after a frame.
   *
   * The shot's own capture can still wait alone: when the first capture ended before it went out. A
   * shot that changes the size (`shot --size`, `shot --full`) lays the page out again, and with
   * hiddenDrive that relayout ended the first capture of a still page in `shot --size`'s 0.5 s settle
   * (review-41b on taylor: 3 of 3 such shots waited for the fallback below, 3.6 s). So when no capture
   * is in flight just before such a shot's own capture, one more first capture goes out, and two frames
   * (then 5 of 5 took 0.6 s). For a full-page capture this is the only help: it changes the device
   * emulation while it waits, so no capture may go out during it. A plain shot of a tab in front gets
   * no new first capture: there the first one ends after a frame, and so does the shot's own. For the
   * other cases (the page changed once by itself), when the shot's own capture, not a full-page one,
   * has not ended after `shotTiming.lateMs`, one more capture goes out to end it (a log line says so),
   * up to three; with no frame wait (a mutation check), such shots then ended at 3.1 to 4.1 s. The
   * shot waits for the new first capture and these captures to end before it returns, and so before a
   * size override is cleared: a capture sent while the override is set sets it again when it ends
   * (Chromium's PageHandler::ScreenshotCaptured restores the emulation that it found). When a capture
   * of the shot failed (its timeout), Chrome may still hold it, and the last captures end it: one
   * chain; when they do not end, no more go out (review-41b: two chains took 42 s and left 13
   * captures). With a size override, they go out under it, before it is cleared (`underLeft`), and the
   * override is cleared only when no capture sent under it is left in flight; else it stays set
   * (screenshotNow, sizeLeft). After a failed full-page capture, or with no frame, a log line says
   * that captures stay in flight instead. The error of a capture that timed out gives the shot's
   * whole time.
   *
   * The allowlist is checked before the first capture, as in whileDrawn. A shot checks it again after its own
   * capture and writes no file for a tab that left it; when the main frame goes to a new page during
   * the shot, the shot fails at once (Chrome may not end a capture of the old page: in the default mode
   * the shot's own capture waited 30 s).
   *
   * Only the first capture goes out, not one each time one ends (whileDrawn's `repeat`): the shot's own capture can
   * change the device emulation (a clip, a size); a capture sent during that change would set it again when it ends.
   * `fn` gets the capture for the shot's own picture (`own`): the one described above; and `underLeft` (ShotCaptures).
   */
  private async whileDrawnForShot<T>(fn: (shot: ShotCaptures) => Promise<T>): Promise<T> {
    await this.endSizeLeft();
    const hidden = this.drive === "hidden", log = this.browser.settings.log, tab = this.targetId.slice(0, 8);
    await this.assertAllowed();
    if (hidden && await this.evaluate(() => document.visibilityState) !== "hidden")
      return fn({ own: (params) => this.send("Page.captureScreenshot", params, Tab.shotTiming.ownMs), underLeft: async () => 0 });
    const { framesMs, lateMs, ownMs, lastMs } = Tab.shotTiming, t0 = Date.now();
    // drew: false when Chrome drew no frame in the wait: then no capture can end. ownClip: a full-page
    // capture of the shot failed: Chrome may still hold it, and its emulation. chainFailed: the last
    // captures did not end: Chrome draws nothing now, and more captures would only wait too. The
    // captures that went out under a size override: caps.heldUnder().
    let drew = true, ownClip = false, chainFailed = false;
    const caps = new HeldCaptures(this);
    // When the main frame goes to a new page during a shot, Chrome may not end the captures of the old
    // page (review-41b on taylor, default mode: the shot's own capture failed after 30 s, though later
    // captures ended; review-41c: after a same-site navigation one ended 50 ms after the shot failed).
    // So the shot fails at once then, also in its frame waits.
    const stopNav = new AbortController();
    let navigatedNow = false;
    const navError = () => new Error(`shot: tab ${tab} went to a new page during the shot, and Chrome may not end a capture of the old page; no shot is taken. Read the page again, then take the shot.`);
    const navigated: Promise<never> = this.browser.conn.waitForEvent<{ frame: { parentId?: string } }>("Page.frameNavigated",
      { sessionId: this.sessionId, predicate: (p) => !p.frame.parentId, timeoutMs: 60 * 60_000, signal: stopNav.signal })
      .then(() => { navigatedNow = true; throw navError(); }, () => new Promise<never>(() => {}));
    navigated.catch(() => {}); // handled: a navigation when nothing waits on it is no unhandled rejection
    const framesForShot = async () => {
      // A navigation can give Chrome's own error before Page.frameNavigated: the isolated world of the frame wait
      // is gone ("Cannot find context with specified id", review-41e), or the target is.
      const n = await Promise.race([navigated, this.twoFrames(framesMs).catch((e) => {
        throw e instanceof CDPError && /Inspected target navigated or closed|Cannot find context with specified id/.test(e.message) ? navError() : e;
      })]);
      if (n === 2) return;
      log(`agent-browser shot: tab ${tab} drew ${n} of 2 frames in ${framesMs / 1000} s after a capture of its shot; ${n ? "the shot goes on" : "the shot fails"}`);
      if (n) return;
      drew = false;
      throw new Error(`shot: Chrome drew no frame of tab ${tab} in ${framesMs / 1000} s after the shot's first capture. Chrome ends a capture only after it draws a frame, so the shot's capture would wait for ever (a loaded machine, or a page that hangs). Try the shot again.`);
    };
    // A log line's note, only when captures that went out under the size override stay in flight.
    const underNote = () => { const u = caps.heldUnder(); return u ? `; ${u} of them went out under the size override` : ""; };
    const lastCaptures = async (under = false) => {
      const n = caps.held();
      if (!n) return;
      if (!drew || ownClip || chainFailed) {
        // With no frame, no capture can end now; the tab's next command ends them all. After a failed
        // full-page capture, a capture sent now would set that capture's emulation again when it ends.
        const cause = ownClip ? "a full-page capture failed" : chainFailed ? "the last captures did not end" : "Chrome drew no frame";
        log(`agent-browser shot: ${n} capture${n > 1 ? "s" : ""} of tab ${tab} stay${n > 1 ? "" : "s"} in flight (${cause}); Chrome can keep drawing that background tab until its next capture${underNote()}`);
        return;
      }
      const r = await caps.last(lastMs, under);
      if (r === true) return;
      chainFailed = true;
      log(stayLine(this.targetId, hidden, r, caps.held(), underNote()));
    };
    const own: OwnCapture = async (params, resized = false) => {
      const clip = "clip" in params, rearm: Promise<true | string>[] = [];
      // A navigation in the settle: send nothing under the size override.
      if (navigatedNow) throw navError();
      // The captures sent under a size override: each found it, and sets it again when it ends (see screenshotNow).
      // After a failure the shot waits for them to end by themselves, at most underMs (after a navigation during the
      // shot they ended 25 ms to 1.1 s later, review-41d on taylor), before its last captures go out under it.
      const under: Promise<unknown>[] = [];
      const afterUnder = async () => {
        if (!resized || !under.length || !(await late(Promise.allSettled(under), Tab.shotTiming.underMs))) return;
        log(`agent-browser shot: the captures of tab ${tab} sent under the size override did not end in ${Tab.shotTiming.underMs / 1000} s after the shot failed`);
      };
      if ((clip || resized) && !caps.held()) {
        rearm.push(caps.capture(10 * 60_000, resized));
        if (resized) under.push(rearm[0]);
        try { await framesForShot(); } catch (e) { await afterUnder(); throw e; }
      }
      const shot = caps.track(this.send<{ data: string }>("Page.captureScreenshot", params, ownMs), resized);
      if (resized) under.push(shot);
      const result = Promise.race([shot, navigated]);
      const kicks: Promise<true | string>[] = [];
      while (!clip && kicks.length < 3 && await late(result, lateMs)) {
        log(`agent-browser shot: the shot's capture of tab ${tab} did not end in ${((kicks.length + 1) * lateMs) / 1000} s; one more capture goes out to end it`);
        kicks.push(caps.capture(10 * 60_000, resized));
        if (resized) under.push(kicks.at(-1)!);
      }
      let ok = false;
      try {
        const r = await result;
        ok = true;
        return r;
      } catch (e) {
        if (clip) ownClip = true;
        const timedOut = e instanceof CDPError && /no response after/.test(e.message);
        // Not after a timeout: Chrome then drew no frame for ownMs, and the captures would only wait too.
        if (!timedOut) await afterUnder();
        // Chrome's own error can come before Page.frameNavigated (review-41d: 4 of 56 hidden-drive runs).
        if (e instanceof CDPError && /Not attached to an active page|Inspected target navigated or closed/.test(e.message)) throw navError();
        if (timedOut)
          throw new ShotTimeout(`shot: Chrome did not end the shot's capture of tab ${tab} in ${ownMs / 1000} s${kicks.length ? ` (also not with ${kicks.length} more capture${kicks.length > 1 ? "s" : ""})` : ""}`,
            "Chrome ends a capture only after it draws a frame of the tab: a loaded machine, a page that hangs or goes to a new page, or a tab that Chrome no longer draws can stop that. Try the shot again.");
        throw e;
      } finally {
        // Before a size override is cleared: a capture sent while it is set sets it again when it ends.
        // The new first capture ends with the shot's own, just before it; an extra one just after it.
        // After a failure, the last captures come later: under the size override (underLeft), or after the shot.
        if (ok && (rearm.length || kicks.length)) {
          await late(Promise.all([...rearm, ...kicks]), 250);
          await lastCaptures(resized);
        }
      }
    };
    // The shot's last captures under its size override, before screenshotNow clears it: they end the captures that
    // went out under it while it is still set. Not when no capture can end now (as in lastCaptures).
    const underLeft = async () => {
      if (caps.heldUnder() && drew && !ownClip && !chainFailed) await lastCaptures(true);
      return caps.heldUnder();
    };
    void caps.capture(10 * 60_000);
    let failure: unknown;
    try {
      await framesForShot();
      return await fn({ own, underLeft });
    } catch (e) {
      failure = e;
      throw e;
    } finally {
      // After the size override was cleared, no capture that went out under it is in flight (screenshotNow).
      await lastCaptures();
      stopNav.abort();
      // The shot's true time, with its last captures.
      if (failure instanceof ShotTimeout) failure.gaveUpAfter(Date.now() - t0);
    }
  }

  /**
   * A shot with a size override left it set (screenshotNow): captures that went out under it may still end, and one
   * that ends after a clear sets the view to the shot's size for good. Chrome clears it at the end of the tab's
   * session (AgentBrowser.disconnect, at the end of each command), and drops those captures with it. On a tab that
   * stays attached, its next input, shot, record or goto first ends them under the override, then clears it
   * (endSizeLeft); a read (text, outline, eval, waitFor) before that sees the shot's size.
   */
  private sizeLeft = false;
  /** The endSizeLeft that runs now: a later caller waits for it, and sends no captures and no clear of its own. */
  private endingSize?: Promise<void>;

  /**
   * When a shot left its size override set (sizeLeft): last captures under it; when the last one ended, every earlier
   * one did: then the clear. Each input runs it first (whileDrawn; byHand, also for record in a window of its own;
   * setFiles), and so do a shot (whileDrawnForShot), recordTab, which sets an override of its own (review-65), and
   * goto, whose new page would load at the shot's size (review-65b). One at a time (review-65b): two calls at the same
   * time each sent captures and a clear, and a capture of one ended after the clear of the other.
   * @internal
   */
  endSizeLeft(): Promise<void> {
    if (!this.sizeLeft) return Promise.resolve();
    return this.endingSize ??= this.endSizeLeftNow().finally(() => { this.endingSize = undefined; });
  }

  private async endSizeLeftNow(): Promise<void> {
    await this.assertAllowed();
    const r = await new HeldCaptures(this).chain(Tab.shotTiming.lastMs, true);
    if (r !== true) {
      this.browser.settings.log(`agent-browser: the last capture of tab ${this.targetId.slice(0, 8)} under the size override that a shot left set ${r}; the override stays set`);
      return;
    }
    this.sizeLeft = false;
    await this.send("Emulation.clearDeviceMetricsOverride");
  }

  /** The tab's URL as Chrome lists it (Target.getTargets): it runs nothing in the page, which can be off the allowlist. */
  private async listedUrl(): Promise<string | undefined> {
    const { targetInfos } = await this.browser.conn.send("Target.getTargets");
    return (targetInfos as TargetInfo[]).find((t) => t.targetId === this.targetId)?.url;
  }

  /** Two animation frames of the page, at most `ms`: the number that came (whileDrawn, whileDrawnForShot). */
  private twoFrames(ms: number): Promise<number> {
    return this.evaluate((ms: number) => new Promise<number>((r) => {
      let n = 0;
      const t = setTimeout(() => r(n), ms);
      const frame = () => { if (++n < 2) requestAnimationFrame(frame); else { clearTimeout(t); r(n); } };
      requestAnimationFrame(frame);
    }), ms);
  }

  async url(): Promise<string> {
    return this.evaluate(() => location.href);
  }

  /**
   * A page in a window of its own (drive "window") that is not in front of that window is hidden: the opener behind a
   * site's popup tab, an older tab of a pinned window, a tab that an older agent-browser opened in the background, a
   * sign-in tab of `launch --login`. Chrome draws nothing of it there: input stalls or reaches a hidden page, and a wait
   * for content that a frame writes, or record, gets nothing (review-45, measured on taylor). So before input, a wait,
   * record and a read (text, outline, eval: a person who reads a tab switches to it, and an eval that waits for a frame,
   * or lazy content, needs the page drawn; review-45b), such a page comes in front of its window, as a person's tab
   * switch does (Page.bringToFront; on Linux it also activates the window). No tab ever moves to another window.
   * On the Mac (AgentBrowser.mac; ab-v16.27) no command activates a window, and CDP has no tab switch without an
   * activation there: such a page only waits until it shows again (waitShown; the opener shows again about 1.0 s after
   * its popup tab closed), and a read goes on when it does not. Input refuses such a page (input.ts, Hands.begin).
   * Elsewhere this does nothing. `deadline` (epoch ms): the wait for the input lock ends then (Tab.waitFor's timeout);
   * `signal` ends that wait, and the wait for the page to show, at once (Tab.waitFor's condition held).
   */
  async toFront(opts: { deadline?: number; signal?: AbortSignal } = {}): Promise<void> {
    if (this.drive !== "window") return;
    await this.assertAllowed();
    if (await this.evaluate(() => document.visibilityState) !== "hidden") return;
    if (this.browser.mac) {
      if (!(await this.waitShown(opts)) && !opts.signal?.aborted)
        this.browser.settings.log(`agent-browser: tab ${this.targetId.slice(0, 8)} is hidden behind another tab of its window; on macOS agent-browser does not switch tabs (that brings the agent Chrome to the front), so this read goes on in the hidden page`);
      return;
    }
    // On Linux Page.bringToFront also activates the window: inside the input lock, so that it never lands inside another
    // agent's input command (review-47c: a read's switch during another agent's typing left two focused pages). The
    // lock is reentrant, so record and the input commands, which hold it, do not wait for themselves. The page's state
    // is read again inside the lock: the other agent's command can have changed it.
    const { withInputLock } = await import("./input.ts");
    await withInputLock(this.browser.settings, async () => {
      await this.assertAllowed();
      if (await this.evaluate(() => document.visibilityState) !== "hidden") return;
      await this.send("Page.bringToFront");
      for (const end = Date.now() + 1000; Date.now() < end && !opts.signal?.aborted; await new Promise((r) => setTimeout(r, 20)))
        if (await this.evaluate(() => document.visibilityState) === "visible") return;
      if (!opts.signal?.aborted) this.browser.settings.log(`agent-browser: tab ${this.targetId.slice(0, 8)} is still hidden 1 s after Page.bringToFront`);
    }, opts);
  }

  /**
   * On the Mac (ab-v16.27): wait until a hidden window page shows again, with no activation, at most the input timing's
   * showMs (2.5 s), or until `deadline` (epoch ms) or `signal`. True when the page is visible. After a popup tab in front
   * of its opener closed, the opener showed again about 1.0 s later (1006 to 1012 ms, the Mac check of 2026-11-06).
   */
  async waitShown(opts: { deadline?: number; signal?: AbortSignal } = {}): Promise<boolean> {
    const end = Math.min(Date.now() + this.browser.settings.inputTiming.showMs, opts.deadline ?? Infinity);
    for (;;) {
      if (await this.evaluate(() => document.visibilityState) === "visible") return true;
      if (Date.now() >= end || opts.signal?.aborted) return false;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /** Refuse to act if the tab has wandered off the allowlist (e.g. an OAuth redirect) or out of the pinned window. */
  async assertAllowed(): Promise<void> {
    const url = await this.url();
    if (!isAllowedUrl(url, this.browser.allow)) throw new NotAllowedError(url);
    this.browser.assertPinned();
    const win = this.browser.pinnedWindow();
    if (win !== undefined && (await this.browser.windowOf(this.targetId)) !== win)
      throw new NotAllowedError(url, "refusing: this tab has been moved out of the pinned window");
  }

  async goto(url: string, opts: { timeoutMs?: number } = {}): Promise<void> {
    assertAllowedUrl(url, this.browser.allow);
    await this.endSizeLeft();
    const loaded = this.browser.conn.waitForEvent("Page.loadEventFired", {
      sessionId: this.sessionId,
      timeoutMs: opts.timeoutMs ?? 45_000,
    });
    // A refused or failed command leaves no load event to wait for: the wait must not reject unseen later.
    const res = await this.send("Page.navigate", { url }).catch((e) => { loaded.catch(() => {}); throw e; });
    if (res.errorText) { loaded.catch(() => {}); throw new Error(`navigation failed: ${res.errorText}`); }
    await loaded;
  }

  /** The main frame's id (stable for the tab's life); cached. */
  private async frameId(): Promise<string> {
    if (this.mainFrameId === undefined) {
      const { frameTree } = await this.send("Page.getFrameTree");
      this.mainFrameId = frameTree.frame.id as string;
    }
    return this.mainFrameId;
  }

  /**
   * A private isolated world for our injected code. It shares the page's DOM but has its own global
   * scope, so the functions we run and the temporaries we store (fetchToFile) never appear on the
   * page's own window, and the page cannot replace the globals we use. Created on demand and
   * remembered; a navigation destroys it, and evaluate() makes a new one and retries once.
   */
  private async isolatedWorld(): Promise<number> {
    if (this.isolatedContextId === undefined) {
      const { executionContextId } = await this.send("Page.createIsolatedWorld", { frameId: await this.frameId(), worldName: "agent-browser" });
      this.isolatedContextId = executionContextId as number;
    }
    return this.isolatedContextId;
  }

  /**
   * Run a function in the page, in our isolated world, and return its (JSON-serialisable) result.
   * The function is serialised, so it cannot close over Node variables; pass them as args. In a window of its own
   * (Tab.drive "window", ab-v16.26) it does not run as a user gesture: a gesture gives the page a user activation
   * (navigator.userActivation) with no press and no key, which a site can see (measured on taylor: each read made the
   * page active). evaluateAsUser runs it as one. Elsewhere it runs as one, as before.
   */
  async evaluate<R, A extends unknown[] = []>(fn: ((...args: A) => R) | string, ...args: A): Promise<Awaited<R>> {
    return this.evaluateIn(fn, args, this.drive !== "window");
  }

  /** As evaluate, run as a user gesture (a popup that the page opens needs one): `eval`, and the open in a pinned window. */
  async evaluateAsUser<R, A extends unknown[] = []>(fn: ((...args: A) => R) | string, ...args: A): Promise<Awaited<R>> {
    return this.evaluateIn(fn, args, true);
  }

  private async evaluateIn<R, A extends unknown[]>(fn: ((...args: A) => R) | string, args: A, userGesture: boolean): Promise<Awaited<R>> {
    const expression = typeof fn === "string" ? fn : `(${fn.toString()})(...${JSON.stringify(args)})`;
    for (let attempt = 0; ; attempt++) {
      const contextId = await this.isolatedWorld();
      let res: { exceptionDetails?: { exception?: { description?: string }; text?: string }; result: { value: Awaited<R> } };
      try {
        res = await this.send("Runtime.evaluate", { expression, contextId, awaitPromise: true, returnByValue: true, ...(userGesture ? { userGesture: true } : {}) });
      } catch (e) {
        // A navigation destroys the isolated world; make a new one and retry once.
        if (attempt === 0 && e instanceof CDPError && /context/i.test(e.message)) { this.isolatedContextId = undefined; continue; }
        throw e;
      }
      if (res.exceptionDetails) {
        const d = res.exceptionDetails;
        throw new Error(`page error: ${d.exception?.description ?? d.text}`);
      }
      return res.result.value;
    }
  }

  /**
   * Poll a page function until it returns a truthy value; returns that value. A hidden window page comes in front
   * (toFront); its wait for the input lock is part of `timeoutMs` (review-47d note 6), so the wait ends near its timeout
   * also while another agent's input holds the lock (the page then stays hidden, and a condition that needs a frame
   * times out). The condition is polled from the start, also during that wait (review-52 note 3): one that holds ends
   * the wait at once, and the page then gets no tab switch. Before the timeout's error, the switch ends and the
   * condition is polled once more.
   */
  async waitFor<R, A extends unknown[] = []>(
    fn: ((...args: A) => R) | string,
    opts: { timeoutMs?: number; intervalMs?: number; args?: A; what?: string } = {},
  ): Promise<Awaited<R>> {
    const { timeoutMs = 30_000, intervalMs = 250, args = [] as unknown as A } = opts;
    const deadline = Date.now() + timeoutMs, stop = new AbortController();
    let fronted = false;
    // A hidden window page draws nothing (toFront); a read that fails there fails below.
    const front = this.toFront({ deadline, signal: stop.signal }).catch(() => {}).finally(() => { fronted = true; });
    try {
      for (;;) {
        const v = await this.evaluate(fn, ...args).catch(() => undefined);
        if (v) return v as Awaited<R>;
        if (Date.now() > deadline) {
          if (!fronted) { await front; continue; }
          throw new Error(`timed out waiting for ${opts.what ?? "condition"}`);
        }
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    } finally {
      stop.abort();
      await front;
    }
  }

  waitForSelector(selector: string, timeoutMs?: number) {
    return this.waitFor((s: string) => {
      const el = document.querySelector(s) as HTMLElement | null;
      return !!el && el.getClientRects().length > 0;
    }, { args: [selector], timeoutMs, what: selector });
  }

  /**
   * Run `fn` with a person's hands (input.ts), for a page in a window of its own (drive "window"; ab-v16.26): inside
   * the agent browser's input lock (one input at a time, across processes), after the page's window came forward.
   */
  private async byHand<T>(fn: (h: Hands) => Promise<T>): Promise<T> {
    await this.endSizeLeft();
    await this.assertAllowed();
    const { withInputLock, Hands } = await import("./input.ts");
    return withInputLock(this.browser.settings, async () => {
      // The wait for the lock can take minutes, and the page can go to a host off the allowlist meanwhile (review-47):
      // the allowlist is read again inside the lock, before any code of ours runs there for the input, and the guard
      // stops each input event once the main frame went off the list (Hands also reads the list before each press
      // and each key).
      await this.assertAllowed();
      let left: string | undefined;
      const main = await this.frameId(), allow = this.browser.allow;
      const offNav = this.browser.conn.on("Page.frameNavigated", (p: { frame?: { url?: string; parentId?: string } }, sid?: string) => {
        if (sid === this.sessionId && !p.frame?.parentId && !isAllowedUrl(p.frame?.url ?? "", allow)) left = p.frame?.url ?? "";
      });
      // Also as soon as the main frame starts or asks for a navigation to a host off the list (review-47c: one move still
      // reached an off-list page before its commit). A request for a page elsewhere (a target=_blank link: disposition
      // newTab, newWindow or download) leaves the main frame where it is: only "currentTab" counts, as in Playwright
      // (review-47d note 7). The new tab itself is off the list, so no command reaches it.
      const early = (p: { frameId?: string; url?: string }, sid?: string) => {
        if (sid === this.sessionId && p.frameId === main && p.url && !isAllowedUrl(p.url, allow)) left = p.url;
      };
      const offStart = this.browser.conn.on("Page.frameStartedNavigating", early);
      const offAsk = this.browser.conn.on("Page.frameRequestedNavigation", (p: { frameId?: string; url?: string; disposition?: string }, sid?: string) => {
        if (p.disposition === "currentTab") early(p, sid);
      });
      const off = () => { offNav(); offStart(); offAsk(); };
      const guard = () => { if (left !== undefined) throw new NotAllowedError(left); };
      let h: Hands | undefined;
      try {
        h = await Hands.begin(this, guard);
        guard();
        await this.assertAllowed();
        return await fn(h);
      } finally {
        off();
        await h?.end().catch((e) => { this.browser.settings.log(`agent-browser: could not keep the pointer's place (${(e as Error).message})`); });
      }
    });
  }

  /**
   * For a command that sends its own input (record): in a window of its own, the input lock and the window's
   * activation around `fn`, which gets the hands (where the pointer is; Hands.movedTo keeps where it ends); elsewhere
   * `fn` as it is, with none.
   */
  async withInput<T>(fn: (h?: Hands) => Promise<T>): Promise<T> {
    return this.drive === "window" ? this.byHand((h) => fn(h)) : fn();
  }

  /**
   * Move the mouse over an element (opens hover menus). In a window of its own (Tab.drive "window"), a person's
   * pointer path from where the pointer is, after the wheel brought the element into view (input.ts); else one move
   * to its centre, under whileDrawn.
   */
  async hover(selector: string): Promise<void> {
    if (this.drive === "window") return this.byHand((h) => h.hover(selector));
    await this.whileDrawn(async () => {
      const pt = await this.centerOf(selector);
      await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pt.x, y: pt.y });
    }, { repeat: true });
  }

  /**
   * Trusted click on the first element matching a CSS selector. In a window of its own, a person's click (input.ts:
   * the wheel brings it into view, a path to a point of its middle 40%, a press of 70 to 90 ms with force 0.5); else at
   * its centre after scrollIntoView, under whileDrawn.
   */
  async click(selector: string): Promise<void> {
    if (this.drive === "window") return this.byHand((h) => h.click(selector));
    await this.whileDrawn(async () => {
      const pt = await this.centerOf(selector);
      await this.clickAtNow(pt.x, pt.y);
    }, { repeat: true });
  }

  private async centerOf(selector: string): Promise<{ x: number; y: number }> {
    await this.assertAllowed();
    const pt = await this.evaluate((s: string) => {
      const el = document.querySelector(s) as HTMLElement | null;
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    }, selector);
    if (!pt) throw new Error(`no element matches ${selector}`);
    if (pt.w === 0 || pt.h === 0) throw new Error(`element ${selector} is not visible`);
    return pt;
  }

  /** Trusted click on the smallest visible element whose text matches exactly (case-insensitive, trimmed). In a window of its own a person's click; else under whileDrawn. */
  async clickText(text: string, opts: { within?: string } = {}): Promise<void> {
    if (this.drive === "window") return this.byHand((h) => h.click(null, { text, within: opts.within }));
    await this.assertAllowed();
    await this.whileDrawn(() => this.clickTextNow(text, opts), { repeat: true });
  }

  private async clickTextNow(text: string, opts: { within?: string }): Promise<void> {
    const pt = await this.evaluate((t: string, within: string | null) => {
      const root = within ? document.querySelector(within) : document.body;
      if (!root) return null;
      const want = t.trim().toLowerCase();
      const cands = [...root.querySelectorAll<HTMLElement>("button, a, [role=button], [role=menuitem], [role=tab], label, span, div")]
        .filter((el) => (el.innerText ?? "").trim().toLowerCase() === want && el.getClientRects().length > 0);
      cands.sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height
        - b.getBoundingClientRect().width * b.getBoundingClientRect().height);
      const el = cands[0];
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, text, opts.within ?? null);
    if (!pt) throw new Error(`no visible element with text "${text}"`);
    await this.clickAtNow(pt.x, pt.y);
  }

  /** Trusted click at a point of the viewport (CSS pixels). In a window of its own a person's path and press; else under whileDrawn. */
  async clickAt(x: number, y: number): Promise<void> {
    if (this.drive === "window") return this.byHand((h) => h.clickAt(x, y));
    await this.whileDrawn(() => this.clickAtNow(x, y), { repeat: true });
  }

  private async clickAtNow(x: number, y: number): Promise<void> {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  /**
   * Focus an element (optional) and type the text into the focused field. Into an input or a textarea,
   * first as inserted text, and when the field's text did not change, again as one key event per
   * character. Into an editable element (an app's own editor, such as the Google Sheets cell editor) as
   * key events at once: inserted text can reach its DOM and never reach the app (#6). When the text did
   * not arrive, or no text field has the focus, an error says so: type never reports what did not happen.
   * A tab or a newline moves on (in a spreadsheet, to the next cell or row), after which the field is
   * another one: only the text before the first of them is checked, and the rest goes as key events
   * (Tab, Enter and characters), so "a\tb\tc\n" fills a row of cells. Under whileDrawn. In a window of its own
   * (Tab.drive "window"), a person's typing (input.ts): the field gets the focus by a click, with the caret where
   * el.focus() would put it, and the text goes as one key-event pair per character, 90 to 150 ms apart, never as
   * inserted text (a character with no US key excepted).
   */
  async type(text: string, selector?: string): Promise<void> {
    if (this.drive === "window") return this.byHand((h) => this.typeNow(text, selector, h));
    await this.assertAllowed();
    await this.whileDrawn(() => this.typeNow(text, selector), { repeat: true });
  }

  private async typeNow(text: string, selector?: string, h?: Hands): Promise<void> {
    if (selector && h) await h.focusField(selector);
    if (h) await h.check(); // the field's click can take the page off the allowlist
    else if (selector) {
      const ok = await this.evaluate((s: string) => {
        const el = document.querySelector(s) as HTMLElement | null;
        el?.focus();
        return !!el;
      }, selector);
      if (!ok) throw new Error(`no element matches ${selector}`);
    }
    // The focused field's text and kind, or null when no text field (an input, a textarea, an editable element) has the focus.
    const field = () => this.evaluate(() => {
      const el = document.activeElement as (HTMLElement & { value?: unknown }) | null;
      if (!el || el === document.body) return null;
      if (typeof el.value === "string") return { text: el.value, editable: false };
      return el.isContentEditable ? { text: el.innerText ?? el.textContent ?? "", editable: true } : null;
    });
    const before = await field();
    if (before === null) throw new Error("type: no text field has the focus; click one first, or name it with --into");
    const cut = text.search(/[\t\n]/), head = cut < 0 ? text : text.slice(0, cut), rest = cut < 0 ? "" : text.slice(cut);
    const { typeChar } = await import("./record.ts");
    const key = h ? (ch: string) => h.typeChar(ch) : (ch: string) => typeChar(this, ch);
    const unchanged = async () => (await field())?.text === before.text;
    if (head) {
      if (!before.editable && !h) await this.send("Input.insertText", { text: head });
      if (h || before.editable || await unchanged()) {
        for (const ch of head) await key(ch);
        if (await unchanged()) throw new Error(`type: the text did not arrive: the focused field is unchanged after ${before.editable || h ? "" : "inserted text and after "}key events`);
      }
    }
    for (const ch of rest) await key(ch);
  }

  /** Under whileDrawn; in a window of its own, after the window came forward, with the key held down a short time (input.ts). */
  async press(key: keyof typeof KEYS | string): Promise<void> {
    const k = KEYS[key];
    if (!k) throw new UsageError(`unsupported key ${key}; known: ${Object.keys(KEYS).join(", ")}`);
    const base = keyFields(key, k.code, k.keyCode);
    // The same key events as below (a keyDown with the key's text; keyFields keeps a function key in the page), held down a short time.
    if (this.drive === "window") return this.byHand((h) => h.keyPress(base, k.text));
    await this.assertAllowed();
    await this.whileDrawn(async () => {
      await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...base, text: k.text });
      await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    }, { repeat: true });
  }

  /**
   * Put local files into an <input type=file>. In a window of its own, as a person picks them: a click on the input
   * (or on its label) opens Chrome's file chooser, which agent-browser intercepts, and the files go to the input that
   * it names (input.ts); an input with no box and no label gets them with no click, as elsewhere, with a log line.
   */
  async setFiles(selector: string, files: string[]): Promise<void> {
    if (files.some((f) => f === "")) throw new UsageError("setFiles: a file path is empty");
    await this.endSizeLeft(); // out of a window of its own, setFiles goes neither to whileDrawn nor to byHand
    if (this.drive === "window") return this.byHand(async (h) => {
      if (await h.setFiles(selector, files)) return;
      await this.assertAllowed();
      await this.setFilesNow(selector, files);
    });
    // Not a window page, so no tab switch (Tab.toFront does nothing here): a window page's comes in Hands.begin above.
    await this.assertAllowed();
    await this.setFilesNow(selector, files);
  }

  private async setFilesNow(selector: string, files: string[]): Promise<void> {
    const { root } = await this.send("DOM.getDocument", { depth: 0 });
    // The document whose input gets the files is on the allowlist (review-47c: the page can go to a new page meanwhile).
    if (typeof root.documentURL === "string" && !isAllowedUrl(root.documentURL, this.browser.allow)) throw new NotAllowedError(root.documentURL);
    const { nodeId } = await this.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error(`no element matches ${selector}`);
    await this.send("DOM.setFileInputFiles", { nodeId, files });
  }

  /**
   * A PNG of the tab. Read the page with outline or text first: a screenshot is the last resort.
   * With a viewport, the page is laid out at exactly that size for the shot (so the PNG is
   * width x scale by height x scale), and the override is cleared afterwards, but only when no capture that went
   * out under it is left in flight: else it stays set until the tab's session ends (screenshotNow; sizeLeft). A
   * failure to clear it never hides the shot's own error. Under whileDrawnForShot, in both modes (ab-b84.17): its
   * first capture comes before the override, and the shot's own capture, two frames later, ends it. whileDrawnForShot checks
   * the allowlist, before that first capture.
   */
  async screenshot(path: string, opts: { fullPage?: boolean; viewport?: Viewport; settleMs?: number } = {}): Promise<string> {
    notEmpty(path, "screenshot");
    return this.whileDrawnForShot((shot) => this.screenshotNow(path, opts, shot));
  }

  private async screenshotNow(path: string, opts: { fullPage?: boolean; viewport?: Viewport; settleMs?: number }, shot: ShotCaptures): Promise<string> {
    if (!opts.viewport) return this.capture(path, !!opts.fullPage, shot.own, false);
    const { width, height, scale } = opts.viewport, log = this.browser.settings.log, tab = this.targetId.slice(0, 8);
    const size = () => this.evaluate(() => `${innerWidth}x${innerHeight}`).catch(() => undefined);
    const before = await size();
    await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });
    let failure: unknown;
    try {
      await new Promise((r) => setTimeout(r, opts.settleMs ?? 500)); // the page lays itself out again at the new size
      await this.capture(path, !!opts.fullPage, shot.own, true);
    } catch (e) { failure = e; }
    // A capture that went out under the override sets it again when it ends, and one that ends after the clear sets
    // the view to the shot's size for good (review-41d). Measured on taylor with Chromium 156 (2026-11-06,
    // test/live/background-tabs/override.ts): after the clear, a later capture of the same session ended such a capture
    // and left the view at the shot's size (3 of 3, the page visible); with the page hidden, the clear's own relayout
    // ended it 33 to 43 ms later (6 of 6).
    // So the shot's last captures go out under the override first (underLeft), and the override is cleared only when
    // none of its captures sent under it is left in flight. Else it stays set: Chrome clears it at the end of the
    // tab's session and drops those captures with the session (6 of 6: the view had its own size again, and their
    // late end changed nothing); on a tab that stays attached, its next input, shot, record or goto clears it
    // (sizeLeft).
    const left = await shot.underLeft();
    if (left) {
      this.sizeLeft = true;
      log(`agent-browser shot: ${left} capture${left > 1 ? "s" : ""} of tab ${tab} sent under the size override may still end, and one that ends after a clear sets the shot's size again for good; the override stays set until the tab's session ends (at the end of a command) or its next input, shot, record or goto ends them`);
      if (failure) throw failure;
      return path;
    }
    const cleanupErrors = await runCleanup([["clear the device metrics override", () => this.send("Emulation.clearDeviceMetricsOverride")]]);
    if (failure) {
      // The page's size, but only on a page that is still on the allowlist (review-41e: Chrome's list, no read in the page).
      const url = await this.listedUrl().catch(() => undefined);
      const after = url !== undefined && isAllowedUrl(url, this.browser.allow) ? await size() : undefined;
      if (before && after && after !== before)
        log(`agent-browser shot: after the failed shot the page of tab ${tab} is ${after}, not ${before} as before the size override`);
      throw withCleanupErrors(failure, cleanupErrors);
    }
    if (cleanupErrors.length) throw new Error(`the screenshot was saved to ${path}, but the tab keeps the emulated size: ${cleanupErrors.join("; ")}`);
    return path;
  }

  private async capture(path: string, fullPage: boolean, own: OwnCapture, resized: boolean): Promise<string> {
    const params: Record<string, unknown> = { format: "png" };
    if (fullPage) {
      const { cssContentSize } = await this.send("Page.getLayoutMetrics");
      params.captureBeyondViewport = true;
      params.clip = { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 };
    }
    const { data } = await own(params, resized);
    // The tab can leave the allowlist while the capture waits (a redirect): then no file is written.
    await this.assertAllowed();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(data, "base64"));
    return path;
  }

  /** Visible text of the page (or an element), for agents to read without screenshots. A hidden window page comes in front first (toFront). */
  async text(selector?: string): Promise<string> {
    await this.assertAllowed();
    await this.toFront();
    return this.evaluate((s: string | null) => {
      const el = (s ? document.querySelector(s) : document.body) as HTMLElement | null;
      return el?.innerText ?? "";
    }, selector ?? null);
  }

  /**
   * Fetch a URL from inside the page (so the site's cookies apply) and save it locally.
   * Streams in chunks so large media files never sit in one giant string.
   * The URL must be allowlisted too: it is fetched with the profile's cookies.
   */
  async fetchToFile(url: string, path: string, chunkBytes = 8 * 1024 * 1024): Promise<{ bytes: number; contentType: string }> {
    notEmpty(path, "fetchToFile");
    assertAllowedUrl(url, this.browser.allow);
    await this.assertAllowed();
    const key = `__agent_browser_${Math.random().toString(36).slice(2)}`;
    const head = await this.evaluate(async (u: string, k: string) => {
      const r = await fetch(u, { credentials: "include" });
      if (!r.ok) return { error: `HTTP ${r.status}` };
      const blob = await r.blob();
      (window as any)[k] = blob;
      return { size: blob.size, type: blob.type };
    }, url, key);
    if ("error" in head) throw new Error(`fetch ${url}: ${head.error}`);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = path + ".part";
    writeFileSync(tmp, "");
    try {
      for (let off = 0; off < head.size; off += chunkBytes) {
        const b64 = await this.evaluate(async (k: string, s: number, e: number) => {
          const buf = new Uint8Array(await (window as any)[k].slice(s, e).arrayBuffer());
          let bin = "";
          for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
          return btoa(bin);
        }, key, off, off + chunkBytes);
        writeFileSync(tmp, Buffer.from(b64, "base64"), { flag: "a" });
      }
    } finally {
      await this.evaluate((k: string) => { delete (window as any)[k]; }, key).catch(() => {});
    }
    renameSync(tmp, path);
    return { bytes: statSync(path).size, contentType: head.type };
  }

  /**
   * Download a URL through Chrome's network stack (the browser's cookies, no page CORS),
   * streamed via CDP's IO domain. Use this for CDN media that pages can't fetch() cross-origin.
   * The URL must be allowlisted too (add the CDN's host): it is loaded with the profile's cookies.
   */
  async download(url: string, path: string): Promise<{ bytes: number; status: number }> {
    notEmpty(path, "download");
    assertAllowedUrl(url, this.browser.allow);
    await this.assertAllowed();
    const { frameTree } = await this.send("Page.getFrameTree");
    const { resource } = await this.send("Network.loadNetworkResource", {
      frameId: frameTree.frame.id,
      url,
      options: { disableCache: false, includeCredentials: true },
    });
    if (!resource.success || !resource.stream)
      throw new Error(`download ${url}: HTTP ${resource.httpStatusCode ?? "?"} ${resource.netErrorName ?? ""}`.trim());
    mkdirSync(dirname(path), { recursive: true });
    const tmp = path + ".part";
    writeFileSync(tmp, "");
    try {
      for (;;) {
        const chunk = await this.send("IO.read", { handle: resource.stream, size: 8 * 1024 * 1024 });
        if (chunk.data) writeFileSync(tmp, Buffer.from(chunk.data, chunk.base64Encoded ? "base64" : "utf8"), { flag: "a" });
        if (chunk.eof) break;
      }
    } finally {
      await this.send("IO.close", { handle: resource.stream }).catch(() => {});
    }
    renameSync(tmp, path);
    return { bytes: statSync(path).size, status: resource.httpStatusCode };
  }

  /**
   * Run an action that triggers a browser download and save the file into `dir`.
   * Download behaviour is browser-wide, so it is redirected only for the duration of
   * this call and then restored to Chrome's default.
   */
  async expectDownload(action: () => Promise<unknown>, dir: string, timeoutMs = 120_000): Promise<Download> {
    notEmpty(dir, "expectDownload");
    const conn = this.browser.conn;
    mkdirSync(dir, { recursive: true });
    await conn.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: dir, eventsEnabled: true });
    try {
      const begin = conn.waitForEvent("Browser.downloadWillBegin", { timeoutMs: 30_000 });
      await action();
      const { guid, suggestedFilename, url } = await begin;
      await conn.waitForEvent("Browser.downloadProgress", {
        predicate: (p: any) => p.guid === guid && (p.state === "completed" || p.state === "canceled"),
        timeoutMs,
      }).then((p: any) => { if (p.state === "canceled") throw new Error("download was canceled"); });
      const final = uniquePath(join(dir, basename(suggestedFilename || guid)));
      renameSync(join(dir, guid), final);
      return { path: final, suggestedFilename, url };
    } finally {
      await conn.send("Browser.setDownloadBehavior", { behavior: "default" }).catch(() => {});
    }
  }

  /**
   * While `action` runs, pause the first request whose URL matches `urlPattern` (CDP glob, e.g.
   * "*\/api/generate/*"), let `transform` rewrite its body, and send it on. Used when a site
   * attaches a bot-check token to a form submit: the page earns the token, we set the fields.
   * A cross-origin submit is preceded by a CORS preflight (an OPTIONS request with no body), which Chrome
   * shows to the Fetch domain too: it is continued untouched, and the request after it is the one rewritten.
   * Resolves with the original and rewritten bodies.
   */
  async interceptRequest(
    urlPattern: string,
    transform: (body: string) => string,
    action: () => Promise<unknown>,
    timeoutMs = 30_000,
  ): Promise<{ original: string; sent: string }> {
    const conn = this.browser.conn;
    await this.send("Fetch.enable", { patterns: [{ urlPattern, requestStage: "Request" }] });
    const cancel = new AbortController();
    const offPreflight = conn.on("Fetch.requestPaused", (ev: any, sid?: string) => {
      if (sid === this.sessionId && isPreflight(ev.request)) void this.send("Fetch.continueRequest", { requestId: ev.requestId }).catch(() => {});
    });
    try {
      const paused = conn.waitForEvent("Fetch.requestPaused", { sessionId: this.sessionId, predicate: (ev: any) => !isPreflight(ev.request), timeoutMs, signal: cancel.signal });
      paused.catch(() => {}); // if `action` throws first this wait is abandoned (cancelled in the finally): its rejection must not go unhandled
      await action();
      const ev = await paused;
      let original = ev.request.postData ?? "";
      if (!original && ev.request.hasPostData) {
        const r = await this.send("Fetch.getRequestPostData", { requestId: ev.requestId }).catch(() => null);
        original = r ? (r.base64Encoded ? Buffer.from(r.postData, "base64").toString("utf8") : r.postData) : "";
      }
      let sent: string;
      try {
        sent = transform(original);
      } catch (e) {
        await this.send("Fetch.failRequest", { requestId: ev.requestId, errorReason: "Aborted" });
        throw e;
      }
      await this.send("Fetch.continueRequest", { requestId: ev.requestId, postData: Buffer.from(sent).toString("base64") });
      return { original, sent };
    } finally {
      cancel.abort();
      offPreflight();
      await this.send("Fetch.disable").catch(() => {});
    }
  }

  /** Record the URL and HTTP status of every response whose URL matches, until `stop()`. */
  async watchResponses(match: (url: string) => boolean): Promise<{ seen: { url: string; status: number }[]; stop(): void }> {
    await this.send("Network.enable");
    const seen: { url: string; status: number }[] = [];
    const off = this.browser.conn.on("Network.responseReceived", (p: any, sid?: string) => {
      if (sid === this.sessionId && match(p.response.url)) seen.push({ url: p.response.url, status: p.response.status });
    });
    return { seen, stop: off };
  }

  /** Run `action` and return the first network response whose URL matches (body included). A CORS preflight's response is never it. */
  async expectResponse(match: (url: string) => boolean, action: () => Promise<unknown>, timeoutMs = 60_000): Promise<CapturedResponse> {
    const conn = this.browser.conn;
    const finished = new Set<string>(), preflights = new Set<string>();
    const cancel = new AbortController();
    const off = conn.on("Network.loadingFinished", (p, sid) => { if (sid === this.sessionId) finished.add(p.requestId); });
    const offSent = conn.on("Network.requestWillBeSent", (p, sid) => { if (sid === this.sessionId && (p.request?.method === "OPTIONS" || p.initiator?.type === "preflight")) preflights.add(p.requestId); });
    let resp: any;
    try {
      await this.send("Network.enable");
      const received = conn.waitForEvent("Network.responseReceived", {
        sessionId: this.sessionId,
        predicate: (p: any) => p.type !== "Preflight" && !preflights.has(p.requestId) && match(p.response.url),
        timeoutMs,
        signal: cancel.signal,
      });
      received.catch(() => {}); // if `action` throws first this wait is abandoned (cancelled in the finally): its rejection must not go unhandled
      await action();
      resp = await received;
      if (!finished.has(resp.requestId)) {
        await conn.waitForEvent("Network.loadingFinished", {
          sessionId: this.sessionId,
          predicate: (p: any) => p.requestId === resp.requestId,
          timeoutMs,
          signal: cancel.signal,
        });
      }
    } finally {
      cancel.abort();
      off();
      offSent();
    }
    const { body, base64Encoded } = await this.send("Network.getResponseBody", { requestId: resp.requestId });
    return {
      url: resp.response.url,
      status: resp.response.status,
      mimeType: resp.response.mimeType,
      body: base64Encoded ? Buffer.from(body, "base64").toString("utf8") : body,
    };
  }

  async close(): Promise<void> {
    await this.browser.conn.send("Target.closeTarget", { targetId: this.targetId });
    await this.browser.forget(this.targetId);
  }
}

/** A CORS preflight: the OPTIONS request a browser sends before a cross-origin POST, with no body of its own. */
const isPreflight = (request: { method?: string } | undefined) => request?.method === "OPTIONS";

function uniquePath(p: string): string {
  if (!existsSync(p)) return p;
  const dot = p.lastIndexOf(".");
  const [stem, ext] = dot > p.lastIndexOf("/") ? [p.slice(0, dot), p.slice(dot)] : [p, ""];
  for (let i = 2; ; i++) if (!existsSync(`${stem}-${i}${ext}`)) return `${stem}-${i}${ext}`;
}
