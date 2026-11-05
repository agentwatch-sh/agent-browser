// What the endpoint refuses, where each call goes, and what it changes on the way (contract C11 in
// chrome-extension's docs/protocol.md, the master; the two-modes design, sections 4.3 and 8). Every refusal is
// answered before any bridge request, with the same text on every Chrome version, so a refused call never reaches
// Chrome.

import { BridgeError, REQUEST_TOO_LARGE } from "./bridge.ts";

/** The one browser context: every target names it, also in Chrome's answers and events that the model passes on. */
export const DEFAULT_CONTEXT = "agentwatch-default";
export const COOKIE_MARKER = "(hidden)";

const NA = "Not available in the agent browser: ";
const APPROVAL = ". It needs Chrome's remote-debugging approval. Agent mode never asks for it.";
export const TEXT = {
  newContext: `${NA}a new browser context (Target.createBrowserContext). Use the default context: browser.contexts()[0].`,
  noContext: "No browser context with given id found",
  noTarget: "No target with given id found",
  inUse: "The tab is in use by another connection of this scope",
  noWindow: "Browser window not found",
  noSession: "Session with given id not found.",
  mainWorldScript: `${NA}init scripts in the page's main world (Page.addScriptToEvaluateOnNewDocument). addInitScript, exposeFunction, exposeBinding and tracing snapshots put names on the page that a site can see.`,
  mainWorldBinding: `${NA}bindings in the page's main world (Runtime.addBinding). exposeFunction and exposeBinding put names on the page that a site can see.`,
  generic: (method: string) => `${NA}${method}.`,
  cookies: (method: string) => `${NA}cookies (${method}). The browser sends its cookies to sites itself. Programs cannot read, set or remove them.`,
  scheme: (scheme: string, method: string) => `${NA}${scheme} URLs (${method}). Agent mode opens web pages only.`,
  notAllowed: (host: string) => `Not allowed: ${host} is not on the allowlist`,
  permission: (name: string) => `${NA}the permission ${name}`,
};

/** The calls that the model answers on the root and on a browser session (the design, section 4.3). */
export const MODEL_SET = new Set(["Browser.getVersion", "Browser.close", "Browser.setDownloadBehavior", "Browser.cancelDownload",
  "Browser.grantPermissions", "Browser.resetPermissions", "Browser.getWindowForTarget", "Browser.getWindowBounds", "Browser.setWindowBounds",
  "Target.setAutoAttach", "Target.setDiscoverTargets", "Target.getTargets", "Target.getTargetInfo", "Target.createTarget", "Target.closeTarget",
  "Target.activateTarget", "Target.attachToTarget", "Target.detachFromTarget", "Target.attachToBrowserTarget", "Target.getBrowserContexts"]);
/** The calls that the model answers on a page session (Playwright sends the window calls there). */
export const PAGE_MODEL_SET = new Set([...MODEL_SET].filter((m) => (m.startsWith("Target.") && m !== "Target.setAutoAttach") || m.includes("Window")));

// Cookies: no cookie calls by default (the operator's answer to board ab-8mf). The browser sends and stores its
// cookies itself, so sites work; programs cannot read, set or remove them through the endpoint.
// TODO(cookie grant): the operator: "Make a note in the code to add a cookie grant in the future if we run into a
// use-case that needs cookie access." A grant would lift these refusals for the granted (allowlisted) sites only,
// stop hiding their cookie headers (hideCookies below), and add cookies.* ops to the bridge (C10). The probe's
// filter in docs/superpowers/specs/2026-11-03-two-modes-probe/relay.mjs (allowlisted domains only) is a start.
const COOKIE_CALLS = new Set(["Storage.getCookies", "Storage.setCookies", "Storage.clearCookies", "Network.getCookies", "Network.getAllCookies",
  "Network.setCookie", "Network.setCookies", "Network.deleteCookies", "Network.clearBrowserCookies"]);
const COOKIE = /^cookie$/i, SET_COOKIE = /^set-cookie$/i, ANY_COOKIE = /^(set-)?cookie$/i;

/** A header object or a list of {name, value} has a header whose name matches. */
function hasHeader(headers: unknown, name: RegExp): boolean {
  if (Array.isArray(headers)) return headers.some((h) => name.test(String(h?.name)));
  return !!headers && typeof headers === "object" && Object.keys(headers).some((n) => name.test(n));
}

/** Fetch's binaryResponseHeaders: base64 of name\0value\0 pairs. */
function hasBinaryHeader(b64: unknown, name: RegExp): boolean {
  if (typeof b64 !== "string") return false;
  return Buffer.from(b64, "base64").toString("latin1").split("\0").some((part, i) => i % 2 === 0 && name.test(part));
}

function cookieRefusal(method: string, p: any): string | null {
  if (COOKIE_CALLS.has(method)) return TEXT.cookies(method);
  if (method === "Storage.clearDataForOrigin" || method === "Storage.clearDataForStorageKey") {
    const types = String(p.storageTypes ?? "").split(",").map((t) => t.trim());
    if (types.includes("cookies") || types.includes("all")) return TEXT.cookies(method);
  }
  if (method === "Network.setExtraHTTPHeaders" && hasHeader(p.headers, COOKIE)) return TEXT.cookies(method);
  if (method === "Fetch.continueRequest" && hasHeader(p.headers, COOKIE)) return TEXT.cookies(method);
  if ((method === "Fetch.fulfillRequest" || method === "Fetch.continueResponse") &&
    (hasHeader(p.responseHeaders, SET_COOKIE) || hasBinaryHeader(p.binaryResponseHeaders, SET_COOKIE))) return TEXT.cookies(method);
  return null;
}

/** A URL's scheme with its colon, or "relative" for a URL with no scheme. */
export function schemeOf(url: string): string {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(url);
  return m ? `${m[1].toLowerCase()}:` : "relative";
}

function urlRefusal(method: string, p: any): string | null {
  if (method === "Page.navigate" && typeof p.url === "string" && p.url !== "about:blank") {
    const s = schemeOf(p.url);
    if (!["http:", "https:", "data:", "blob:"].includes(s)) return TEXT.scheme(s, method);
    // A blob: URL passes only with an http(s) inner origin (C11); blob:chrome-extension://, blob:null/ and blob:file:// do not.
    if (s === "blob:" && !/^blob:https?:\/\//i.test(p.url)) return TEXT.scheme(s, method);
  }
  // A new tab opens only about:blank or an http(s) URL (C10's newTab); a client navigates it to a data: or blob: URL after.
  if (method === "Target.createTarget" && p.url && p.url !== "about:blank") {
    const s = schemeOf(String(p.url));
    if (s !== "http:" && s !== "https:") return TEXT.scheme(s, method);
  }
  return null;
}

/** The refusal text of a call on any session, or null. `onPage` is true for a page session (a tab or a child of it). */
export function refusal(method: string, params: any, onPage: boolean): string | null {
  const p = params ?? {};
  const domain = method.split(".")[0];
  if (method === "Target.createBrowserContext") return TEXT.newContext;
  // Chrome's approval path (board ab-jzg Q2: never): these need "Allow remote debugging?", which Chrome refuses to an extension.
  if (domain === "Profiler") return `${NA}JS coverage and profiling (${method})${APPROVAL}`;
  if (domain === "HeapProfiler") return `${NA}heap profiling and page.requestGC() (${method})${APPROVAL}`;
  if (method === "Security.setIgnoreCertificateErrors") return `${NA}ignoreHTTPSErrors (${method})${APPROVAL}`;
  if (domain === "ServiceWorker") return `${NA}service workers (${method})${APPROVAL}`;
  if (domain === "SystemInfo") return `${NA}system information (${method})${APPROVAL}`;
  if (domain === "Tracing" && !onPage) return `${NA}browser-wide tracing (${method}). Trace a page: browser.startTracing(page).`;
  if (domain === "Extensions" || method === "Target.exposeDevToolsProtocol" || method === "Network.setRequestInterception") return TEXT.generic(method);
  const cookies = cookieRefusal(method, p);
  if (cookies) return cookies;
  const url = urlRefusal(method, p);
  if (url) return url;
  // Page marks (board ab-jzg Q3: refuse), in the page's main world only: an isolated world (a worldName or an
  // executionContextName that is not empty) passes, because Playwright sends its utility world's script on every
  // frame. An executionContextId alone is refused: the model cannot tell which world it names.
  if (method === "Page.addScriptToEvaluateOnNewDocument" && !p.worldName) return TEXT.mainWorldScript;
  if (method === "Runtime.addBinding" && !p.executionContextName) return TEXT.mainWorldBinding;
  return null;
}

export type Route = "model" | "chrome" | { refused: string };

/**
 * The call that the model answers itself, on a page session, when each page has a window of its own (Linux; the
 * anti-detect design, docs/research/2026-11-05-anti-detect-drive.md, step 2). A page in a window draws without focus
 * emulation, and focus emulation makes a page report "visible" and the focus that it does not have. Playwright sends
 * it for each page unless it connects with noDefaults.
 */
export const FOCUS_EMULATION = "Emulation.setFocusEmulationEnabled";

/**
 * Where a call goes. `child`: the call is a Target.detachFromTarget of a child session (a frame or a worker) of the
 * page's tab. `windowPerPage`: each page has a window of its own (Linux), and the model answers FOCUS_EMULATION.
 */
export function route(method: string, params: any, onPage: boolean, o: { child?: boolean; windowPerPage?: boolean } = {}): Route {
  const refused = refusal(method, params, onPage);
  if (refused) return { refused };
  // A page call on the root or a browser session names no tab.
  if (!onPage) return MODEL_SET.has(method) ? "model" : { refused: TEXT.generic(method) };
  if (o.windowPerPage && method === FOCUS_EMULATION) return "model";
  if (method === "Target.setAutoAttach" || (method === "Target.getTargetInfo" && !params?.targetId) || (method === "Target.detachFromTarget" && o.child)) return "chrome";
  if (PAGE_MODEL_SET.has(method)) return "model";
  if (method.startsWith("Browser.") || method.startsWith("Target.")) return { refused: TEXT.generic(method) };
  return "chrome";
}

const HEADER_KEYS = new Set(["headers", "requestHeaders", "responseHeaders"]);
const COOKIE_LISTS = new Set(["associatedCookies", "blockedCookies", "exemptedCookies"]);
const COOKIE_LINE = /^((?:set-)?cookie):[^\r\n]*/gim;

/** The domains whose events and results carry cookie values. */
export const hidesCookies = (method: string) => /^(Network|Fetch|Audits)\./.test(method);

/** A copy of a Network, Fetch or Audits event or result with every cookie value replaced by the marker, at any depth. */
export function hideCookies(v: any): any {
  if (Array.isArray(v)) return v.map(hideCookies);
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (HEADER_KEYS.has(k) && Array.isArray(x)) out[k] = x.map((h) => (h && ANY_COOKIE.test(String(h.name)) ? { ...h, value: COOKIE_MARKER } : h));
    else if (HEADER_KEYS.has(k) && x && typeof x === "object") out[k] = Object.fromEntries(Object.entries(x).map(([n, val]) => [n, ANY_COOKIE.test(n) ? COOKIE_MARKER : val]));
    else if ((k === "headersText" || k === "requestHeadersText") && typeof x === "string") out[k] = x.replace(COOKIE_LINE, `$1: ${COOKIE_MARKER}`);
    else if (k === "rawCookieLine") out[k] = COOKIE_MARKER;
    else if (COOKIE_LISTS.has(k)) out[k] = [];
    else out[k] = hideCookies(x);
  }
  return out;
}

/** A CDP mouse press reports pointer pressure 0, a real mouse 0.5 (the Chrome comparison, section 3): a press with no force gets 0.5. */
export function withForce(method: string, params: any): any {
  if (method !== "Input.dispatchMouseEvent" || !params || params.force !== undefined) return params;
  if (params.type === "mousePressed" || (params.type === "mouseMoved" && params.buttons)) return { ...params, force: 0.5 };
  return params;
}

/** Playwright's utility-script function that focuses an element (startsAction): its whole text, as Playwright sends it. */
export const PLAYWRIGHT_FOCUS = /^\(\[injected\b[^\]]*\]\)\s*=>\s*injected\.focusNode\([^)]*\)\s*$/;

/**
 * An input that starts an action, as a person's press or key does: before it the model brings the page's window
 * forward (Linux; the anti-detect design, step 5). On Linux Chrome raises a window for a press in it, but not for
 * keys: a key into a window that is not focused gives its page the focus while another page keeps it. Moves, wheel
 * events, releases and key-ups follow the start and need no window of their own.
 *
 * Playwright's focus of an element counts too: its injected focusNode (Playwright 1.64.1: locator.pressSequentially,
 * press and type; focus calls it too) moves the caret of an input to its start when document.hasFocus() is false, so
 * it would type at the start of a field whose window lost the focus. Playwright sends the text of its utility-script
 * function, `([injected, node, ...]) => injected.focusNode(...)`, as a string argument of Runtime.callFunctionOn
 * (PLAYWRIGHT_FOCUS). The rule depends on those internal names: if Playwright renames them, the caret moves to the
 * start again, and nothing else changes.
 */
export function startsAction(method: string, params: any): boolean {
  if (method === "Input.insertText") return true;
  if (method === "Runtime.callFunctionOn") return Array.isArray(params?.arguments) && params.arguments.some((a: any) => typeof a?.value === "string" && PLAYWRIGHT_FOCUS.test(a.value));
  if (method === "Input.dispatchMouseEvent") return params?.type === "mousePressed";
  if (method === "Input.dispatchKeyEvent") return params?.type === "keyDown" || params?.type === "rawKeyDown" || params?.type === "char";
  if (method === "Input.dispatchTouchEvent") return params?.type === "touchStart";
  return false;
}

/** A command that waits for a promise: after a timeout the model leaves its tab attached (C10). */
export const awaitsPromise = (method: string, params: any) =>
  method === "Runtime.awaitPromise" || ((method === "Runtime.evaluate" || method === "Runtime.callFunctionOn") && params?.awaitPromise === true);

export const isTimeout = (e: unknown) => e instanceof BridgeError && e.message === "timeout";

/** The CDP error for a failed bridge request of a client's call: C11's texts for the bridge's own errors, else Chrome's error. */
export function cdpError(method: string, e: unknown): { code: number; message: string } {
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof BridgeError) {
    if (message === "timeout") return { code: -32000, message: `The agent browser did not answer ${method} in ${e.wait / 1000} s.` };
    if (message === "too large") return { code: -32000, message: `The answer of ${method} is larger than the agent browser's link allows (128 MiB).` };
    if (message === REQUEST_TOO_LARGE) return { code: -32000, message: `The command is too large for the agent browser: ${method}.` };
    // chrome.debugger gives a CDP error as its JSON text.
    try {
      const j = JSON.parse(message);
      if (typeof j?.message === "string") return { code: typeof j.code === "number" ? j.code : -32000, message: j.message };
    } catch { /* plain text */ }
  }
  return { code: -32000, message };
}

/** The model's action for an event that was too large for the link (C10's bridge.tooLarge), so that the page never waits for an answer. */
export function tooLargeAction(ev: { of?: string; method?: string; requestId?: string }): [string, object] | null {
  if (ev.of !== "debugger.onEvent") return null;
  if (ev.method === "Fetch.requestPaused") return ["Fetch.continueRequest", { requestId: ev.requestId }];
  if (ev.method === "Fetch.authRequired") return ["Fetch.continueWithAuth", { requestId: ev.requestId, authChallengeResponse: { response: "CancelAuth" } }];
  if (ev.method === "Page.javascriptDialogOpening") return ["Page.handleJavaScriptDialog", { accept: false }];
  return null;
}
