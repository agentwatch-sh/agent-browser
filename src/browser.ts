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
import { assertTestStateIsolated, personalUserDataDir, resolveOptions, statePath, underNodeTest, type BrowserOptions, type Settings } from "./options.ts";
import { proxyUrl, socketAlive, startProxy } from "./proxy.ts";
import { withFileLock } from "./lock.ts";

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
 * The tab record, in the state folder. tabs.json maps the name of each tab opened with no tab scope
 * to its targetId, as it always has. tab-scopes.json holds each tab opened under a tab scope, by
 * targetId: its scope and its name there (null: no name). So a name belongs to one scope, and two
 * scopes can each have a tab named "main". Both files change only under the record lock.
 */
type Registry = Record<string, string>; // tab name -> targetId (tabs with no scope)
type ScopeRecord = Record<string, { scope: string; name: string | null }>; // targetId -> its scope and its name there
const REGISTRY_FILE = "tabs.json", SCOPES_FILE = "tab-scopes.json", RECORD_LOCK = "tabs.lock";

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
  private sessions = new Map<string, Tab>();

  private constructor(conn: CDPConnection, settings: Settings, allow: string[], product: string) {
    this.conn = conn;
    this.settings = settings;
    this.allow = allow;
    this.product = product;
  }

  /**
   * Connect through the consumer's proxy socket. A live proxy is an approved connection and is used
   * first. Otherwise the upstream endpoint is found (the endpoint option; in agent mode the agent
   * Chrome, launched if needed; in personal mode the operator's Chrome), a proxy is started for it,
   * and the connection goes through that proxy. With existingOnly, nothing is launched or started.
   */
  static async connect(options: BrowserOptions | Settings, opts: { existingOnly?: boolean } = {}): Promise<AgentBrowser> {
    const s = resolveOptions(options);
    const allow = allowlistOf(s);
    assertTestStateIsolated(s);
    if (existsSync(s.socketPath) && await socketAlive(s.socketPath)) {
      try { return await AgentBrowser.fromProxy(s, allow); } catch { /* stale or broken proxy */ }
    }
    if (opts.existingOnly) throw new ChromeUnreachableError("no usable existing Chrome proxy; diagnosis does not launch or connect upstream");
    // Checked before any launch: a new Chrome needs a new approval too.
    if (s.noPrompt) throw new ApprovalNeededError(approvalNeededMessage(s, browserTarget(s)));
    const candidates = s.mode === "agent"
      ? [{ source: s.endpoint ? "endpoint" : "agent profile", ws: s.endpoint ?? await launchAgentChrome(s, { background: true }) }]
      : endpointCandidates(s);
    let lastErr: unknown;
    for (const c of candidates) {
      try {
        await startProxy(s, c.ws);
        if (s.mode === "personal" && c.source !== "cache") rememberEndpoint(s, c.ws);
        return await AgentBrowser.fromProxy(s, allow);
      } catch (e) { lastErr = e; }
    }
    // Chrome's instant refusal, and a prompt that nobody answered, are their own causes: remote debugging is on there, so the general help would mislead.
    const message = (lastErr as Error | undefined)?.message ?? "";
    if (/refused the connection without a prompt|until a person answers its/.test(message)) throw new ChromeUnreachableError(message, { cause: lastErr });
    throw new ChromeUnreachableError(`${chromeHelp(s)}${lastErr ? `\n(${message})` : ""}`, { cause: lastErr });
  }

  private static async fromProxy(s: Settings, allow: string[]): Promise<AgentBrowser> {
    const conn = await CDPConnection.connect(proxyUrl(s), 5_000);
    try {
      const v = await conn.send("Browser.getVersion", {}, undefined, 5_000);
      return new AgentBrowser(conn, s, allow, v.product);
    } catch (e) {
      await conn.close();
      throw e;
    }
  }

  get mode() { return this.settings.mode; }

  /** The tab scope this browser works in, or undefined: every tab. */
  get tabScope(): string | undefined { return this.settings.tabScope; }

  // --- the tab record (names and scopes), persisted across CLI invocations ---

  private readRegistry(): Registry {
    try { return JSON.parse(readFileSync(statePath(this.settings, REGISTRY_FILE), "utf8")); } catch { return {}; }
  }

  private readScopes(): ScopeRecord {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(statePath(this.settings, SCOPES_FILE), "utf8")); } catch { return {}; }
    const out: ScopeRecord = {};
    if (raw && typeof raw === "object" && !Array.isArray(raw)) for (const [id, e] of Object.entries(raw as Record<string, { scope?: unknown; name?: unknown }>))
      if (e && typeof e.scope === "string" && (e.name === null || typeof e.name === "string")) out[id] = { scope: e.scope, name: e.name };
    return out;
  }

  /**
   * Change the tab record under the state folder's lock (tabs.lock): several processes (CLI calls of
   * different sessions) write it, and a read-modify-write without the lock can lose another's change.
   * The entries of tabs that Chrome no longer has are dropped here. The target list is read inside the
   * lock, so a tab that another process recorded before this one took the lock is in it; when the list
   * cannot be read, nothing is dropped. Only a file that changed is written.
   */
  private async updateRecord(change: (registry: Registry, scopes: ScopeRecord) => void): Promise<void> {
    await withFileLock(statePath(this.settings, RECORD_LOCK), Date.now() + 10_000, async () => {
      const registry = this.readRegistry(), scopes = this.readScopes();
      const before = [JSON.stringify(registry), JSON.stringify(scopes)];
      change(registry, scopes);
      const live = await this.conn.send("Target.getTargets", {}, undefined, 5_000)
        .then(({ targetInfos }) => new Set((targetInfos as TargetInfo[]).map((t) => t.targetId)), () => undefined);
      if (live) {
        for (const [name, id] of Object.entries(registry)) if (!live.has(id)) delete registry[name];
        for (const id of Object.keys(scopes)) if (!live.has(id)) delete scopes[id];
      }
      if (JSON.stringify(registry) !== before[0]) writeJsonAtomic(statePath(this.settings, REGISTRY_FILE), registry);
      if (JSON.stringify(scopes) !== before[1]) writeJsonAtomic(statePath(this.settings, SCOPES_FILE), scopes);
    }, "the tab record lock");
  }

  // --- the pinned window: when pinned, nothing outside that one Chrome window is touched ---

  pinnedWindow(): number | undefined {
    try { return JSON.parse(readFileSync(statePath(this.settings, "window.json"), "utf8")).windowId; } catch { return undefined; }
  }

  pinWindow(windowId: number | undefined) {
    if (windowId === undefined) rmSync(statePath(this.settings, "window.json"), { force: true });
    else writeFileSync(statePath(this.settings, "window.json"), JSON.stringify({ windowId }, null, 2));
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
   * browser it is a background tab in the current window: a foreground tab activates Chrome, which
   * takes the operator's focus and Space (measured 2026-10-30); the agent browser's launch flags keep a
   * background tab rendering. In the operator's Chrome with no pin, it gets a window of its own, opened
   * behind theirs, and that window is pinned at once: without those flags a background *tab* is
   * throttled and trusted input stalls, while a separate window renders normally without stealing focus.
   */
  async open(url: string, opts: { name?: string; newWindow?: boolean; timeoutMs?: number } = {}): Promise<Tab> {
    assertAllowedUrl(url, this.allow);
    const win = this.pinnedWindow();
    const agent = this.mode === "agent";
    let targetId: string;
    if (win !== undefined) targetId = await this.openInWindow(win);
    else {
      if (!agent && opts.newWindow === false)
        throw new PinRequiredError("personal mode: no window is pinned, so a tab has no window of its own to open in; open without --tab to get one");
      targetId = (await this.conn.send("Target.createTarget", { url: "about:blank", background: true, newWindow: opts.newWindow ?? !agent })).targetId;
      if (!agent) this.pinWindow(await this.windowOf(targetId));
    }
    const tab = await this.attach(targetId);
    const scope = this.tabScope, name = opts.name;
    if (scope !== undefined) await this.updateRecord((_, scopes) => {
      // A name belongs to one tab of the scope: a tab that had it before keeps its place in the scope, without the name.
      if (name) for (const e of Object.values(scopes)) if (e.scope === scope && e.name === name) e.name = null;
      scopes[targetId] = { scope, name: name || null };
    });
    else if (name) await this.updateRecord((registry) => { registry[name] = targetId; });
    if (url !== "about:blank") await tab.goto(url, { timeoutMs: opts.timeoutMs });
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
    await opener.evaluate(() => { window.open("about:blank", "_blank"); });
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
   * matches, the error says so and names --any-scope, and never that tab's URL or title. With no scope,
   * or with anyScope, they look among every allowlisted tab (see match).
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
    try { outside = this.match(ref, await this.allowedPages({ anyScope: true }), reg) !== undefined; }
    catch (e) { if (!(e instanceof TabNotFoundError)) throw e; outside = true; } // a name of two other scopes: it matches outside too
    if (outside) throw new TabNotFoundError(`no tab of scope "${scope}" matches "${ref}", but a tab outside this scope does (another scope's, or one with no scope); pass --any-scope to reach it`);
    throw new TabNotFoundError(`no allowlisted tab of scope "${scope}" matches "${ref}" (see: ${cmd} tabs)`);
  }

  /**
   * The tab `ref` names among `pages`, first hit wins: a name (of this scope, then of a tab with no
   * scope, then of another scope, an error when two other scopes use it), a target-id prefix, a URL
   * substring.
   */
  private match(ref: string, pages: PageInfo[], reg: Registry): PageInfo | undefined {
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
      ?? pages.find((p) => p.url.includes(ref));
  }

  /** Find an allowlisted tab (see resolve) and attach to it. */
  async find(ref: string, opts: { anyScope?: boolean } = {}): Promise<Tab> {
    return this.attach((await this.resolve(ref, opts)).targetId);
  }

  async attach(targetId: string): Promise<Tab> {
    this.assertPinned();
    const existing = this.sessions.get(targetId);
    if (existing) return existing;
    const { targetInfos } = await this.conn.send("Target.getTargets");
    const info = (targetInfos as TargetInfo[]).find((t) => t.targetId === targetId);
    if (!info || info.type !== "page") throw new TabNotFoundError(`target ${targetId} is not an open page`);
    if (!isAllowedUrl(info.url, this.allow)) throw new NotAllowedError(info.url);
    if (!(await this.reachable(info))) throw new NotAllowedError(info.url, "refusing: that tab is outside the pinned window");
    const { sessionId } = await this.conn.send("Target.attachToTarget", { targetId, flatten: true });
    const tab = new Tab(this, targetId, sessionId);
    await tab.send("Page.enable");
    // Our injected code runs in an isolated world (see evaluate), so the Runtime domain stays off:
    // a page can tell the Runtime domain is enabled, and we never need its events.
    // Lets pages in unfocused windows / background tabs still accept trusted input.
    await tab.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    this.sessions.set(targetId, tab);
    return tab;
  }

  /** Drop a closed tab: its session, its name, and its place in a tab scope. */
  async forget(targetId: string): Promise<void> {
    this.sessions.delete(targetId);
    await this.updateRecord((registry, scopes) => {
      for (const [n, id] of Object.entries(registry)) if (id === targetId) delete registry[n];
      delete scopes[targetId];
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
  F2: { code: "F2", keyCode: 113 },
};

/** An exact page size for a screenshot or a recording: CSS pixels and a device pixel ratio. */
export type Viewport = { width: number; height: number; scale: number };

export class Tab {
  readonly browser: AgentBrowser;
  readonly targetId: string;
  readonly sessionId: string;

  constructor(browser: AgentBrowser, targetId: string, sessionId: string) {
    this.browser = browser;
    this.targetId = targetId;
    this.sessionId = sessionId;
  }

  private isolatedContextId?: number;
  private mainFrameId?: string;

  send<T = any>(method: string, params: object = {}, timeoutMs?: number): Promise<T> {
    return this.browser.conn.send<T>(method, params, this.sessionId, timeoutMs);
  }

  async url(): Promise<string> {
    return this.evaluate(() => location.href);
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
    const loaded = this.browser.conn.waitForEvent("Page.loadEventFired", {
      sessionId: this.sessionId,
      timeoutMs: opts.timeoutMs ?? 45_000,
    });
    const res = await this.send("Page.navigate", { url });
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
   * The function is serialised, so it cannot close over Node variables; pass them as args.
   */
  async evaluate<R, A extends unknown[] = []>(fn: ((...args: A) => R) | string, ...args: A): Promise<Awaited<R>> {
    const expression = typeof fn === "string" ? fn : `(${fn.toString()})(...${JSON.stringify(args)})`;
    for (let attempt = 0; ; attempt++) {
      const contextId = await this.isolatedWorld();
      let res: { exceptionDetails?: { exception?: { description?: string }; text?: string }; result: { value: Awaited<R> } };
      try {
        res = await this.send("Runtime.evaluate", { expression, contextId, awaitPromise: true, returnByValue: true, userGesture: true });
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

  /** Poll a page function until it returns a truthy value; returns that value. */
  async waitFor<R, A extends unknown[] = []>(
    fn: ((...args: A) => R) | string,
    opts: { timeoutMs?: number; intervalMs?: number; args?: A; what?: string } = {},
  ): Promise<Awaited<R>> {
    const { timeoutMs = 30_000, intervalMs = 250, args = [] as unknown as A } = opts;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = await this.evaluate(fn, ...args).catch(() => undefined);
      if (v) return v as Awaited<R>;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${opts.what ?? "condition"}`);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  waitForSelector(selector: string, timeoutMs?: number) {
    return this.waitFor((s: string) => {
      const el = document.querySelector(s) as HTMLElement | null;
      return !!el && el.getClientRects().length > 0;
    }, { args: [selector], timeoutMs, what: selector });
  }

  /** Move the mouse over an element (opens hover menus). */
  async hover(selector: string): Promise<void> {
    const pt = await this.centerOf(selector);
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pt.x, y: pt.y });
  }

  /** Trusted click at the centre of the first element matching a CSS selector. */
  async click(selector: string): Promise<void> {
    const pt = await this.centerOf(selector);
    await this.clickAt(pt.x, pt.y);
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

  /** Trusted click on the smallest visible element whose text matches exactly (case-insensitive, trimmed). */
  async clickText(text: string, opts: { within?: string } = {}): Promise<void> {
    await this.assertAllowed();
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
    await this.clickAt(pt.x, pt.y);
  }

  async clickAt(x: number, y: number): Promise<void> {
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
   * (Tab, Enter and characters), so "a\tb\tc\n" fills a row of cells.
   */
  async type(text: string, selector?: string): Promise<void> {
    await this.assertAllowed();
    if (selector) {
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
    const unchanged = async () => (await field())?.text === before.text;
    if (head) {
      if (!before.editable) await this.send("Input.insertText", { text: head });
      if (before.editable || await unchanged()) {
        for (const ch of head) await typeChar(this, ch);
        if (await unchanged()) throw new Error(`type: the text did not arrive: the focused field is unchanged after ${before.editable ? "" : "inserted text and after "}key events`);
      }
    }
    for (const ch of rest) await typeChar(this, ch);
  }

  async press(key: keyof typeof KEYS | string): Promise<void> {
    const k = KEYS[key];
    if (!k) throw new UsageError(`unsupported key ${key}; known: ${Object.keys(KEYS).join(", ")}`);
    await this.assertAllowed();
    const base = { key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode };
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...base, text: k.text });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  /** Put local files into an <input type=file>. */
  async setFiles(selector: string, files: string[]): Promise<void> {
    await this.assertAllowed();
    const { root } = await this.send("DOM.getDocument", { depth: 0 });
    const { nodeId } = await this.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error(`no element matches ${selector}`);
    await this.send("DOM.setFileInputFiles", { nodeId, files });
  }

  /**
   * A PNG of the tab. Read the page with outline or text first: a screenshot is the last resort.
   * With a viewport, the page is laid out at exactly that size for the shot (so the PNG is
   * width x scale by height x scale), and the override is cleared afterwards. A failure to clear it
   * never hides the shot's own error.
   */
  async screenshot(path: string, opts: { fullPage?: boolean; viewport?: Viewport; settleMs?: number } = {}): Promise<string> {
    await this.assertAllowed();
    if (!opts.viewport) return this.capture(path, !!opts.fullPage);
    const { width, height, scale } = opts.viewport;
    await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });
    let failure: unknown;
    try {
      await new Promise((r) => setTimeout(r, opts.settleMs ?? 500)); // the page lays itself out again at the new size
      await this.capture(path, !!opts.fullPage);
    } catch (e) { failure = e; }
    const cleanupErrors = await runCleanup([["clear the device metrics override", () => this.send("Emulation.clearDeviceMetricsOverride")]]);
    if (failure) throw withCleanupErrors(failure, cleanupErrors);
    if (cleanupErrors.length) throw new Error(`the screenshot was saved to ${path}, but the tab keeps the emulated size: ${cleanupErrors.join("; ")}`);
    return path;
  }

  private async capture(path: string, fullPage: boolean): Promise<string> {
    const params: Record<string, unknown> = { format: "png" };
    if (fullPage) {
      const { cssContentSize } = await this.send("Page.getLayoutMetrics");
      params.captureBeyondViewport = true;
      params.clip = { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 };
    }
    const { data } = await this.send("Page.captureScreenshot", params, 30_000);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(data, "base64"));
    return path;
  }

  /** Visible text of the page (or an element), for agents to read without screenshots. */
  async text(selector?: string): Promise<string> {
    await this.assertAllowed();
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
