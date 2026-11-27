// Errors with a stable `code`. The CLI prints the code in its JSON error document, and the Python
// adapter maps each code to its own exception class, so callers never match on English text.

export type ErrorCode =
  | "usage"
  | "not_allowed"
  | "read_first"
  | "tab_not_found"
  | "unreachable"
  | "dialog"
  | "error";

export class AgentBrowserError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.name = new.target.name;
  }
}

/** A command line or option that cannot run as given. */
export class UsageError extends AgentBrowserError {
  constructor(message: string) { super("usage", message); }
}

/** A URL or tab whose host is not on the allowlist. Only the host is ever named. */
export class NotAllowedError extends AgentBrowserError {
  /** The refused host (never the full URL); UNREAD_HOST for a URL with no host that agent-browser could read. */
  readonly host: string;
  /** The refused URL is about:blank: a redirect refusal says that the tab stays on a blank page (redirectError). */
  readonly blank: boolean;
  constructor(url: string, message = `refusing: ${safeHost(url)} is not on the allowlist`) {
    super("not_allowed", message);
    this.host = safeHost(url);
    this.blank = /^about:blank([?#]|$)/.test(url);
  }
}

/** Hosts and first labels of sign-in pages: a redirect there means the profile is not signed in. */
const SIGN_IN_HOSTS = ["accounts.google.com", "login.microsoftonline.com", "login.live.com", "appleid.apple.com", "signin.aws.amazon.com", "id.atlassian.com"];
const SIGN_IN_LABELS = ["login", "signin", "sign-in", "auth", "accounts", "sso"];

export function isSignInHost(host: string): boolean {
  const h = host.toLowerCase();
  return SIGN_IN_HOSTS.some((d) => h === d || h.endsWith("." + d)) || SIGN_IN_LABELS.includes(h.split(".")[0]);
}

/** The sign-in step of the agent browser behind agent mode's endpoint: the operator extension sends it. */
export function operatorSignIn(site: string): string {
  return `ask the operator to sign in to ${site} in their own Chrome and send that site's sign-in to the agent browser with the operator extension (agentwatch — operator mode)`;
}

/**
 * What to do about a sign-in page: agentwatch owns the agent browser, so the operator signs in to `site` (the
 * allowlisted site the tab came from) in their own Chrome and sends that site's sign-in with the operator extension
 * (the two-modes design).
 */
export function signInHint(host: string, site?: string): string {
  if (!isSignInHost(host)) return "";
  const where = site ?? "the site";
  return `; ${host} is a sign-in page, so the agent browser is not signed in to ${where}: ${operatorSignIn(where)}`;
}

/**
 * A navigation to an allowlisted URL that ended on a host off the allowlist (a redirect): name both
 * hosts, say where the tab is, and how to sign in when it is a sign-in page. Any other error is kept.
 * When the tab's URL names no host (board ab-nfn: the extension sends a blocked tab to about:blank), the refused host is
 * `blocked`, the host of the tab's last main-frame navigation off the list (Tab.blockedHost), which the operator's
 * prompt names too; with none known, the text says UNREAD_HOST.
 */
export function redirectError(e: unknown, requested: string, blocked?: string): unknown {
  if (!(e instanceof NotAllowedError)) return e;
  const host = e.host === UNREAD_HOST ? blocked ?? UNREAD_HOST : e.host, site = safeHost(requested);
  if (host === site) return e;
  // Where the tab is: on the named host, else (no host in the tab's URL) on a blank page or a page with no host.
  const where = e.host !== UNREAD_HOST ? "there" : e.blank ? "on a blank page" : `on a page whose host the agent browser could not read`;
  return new NotAllowedError(host === UNREAD_HOST ? "" : `https://${host}/`, `refusing: ${site} redirected the tab to ${host}, which is not on the allowlist${signInHint(host, site)}. The tab stays open ${where}; agent-browser does not touch it`);
}

/** A screenshot before the page was read with outline or text. */
export class ReadFirstError extends AgentBrowserError {
  constructor(message: string) { super("read_first", message); }
}

export class TabNotFoundError extends AgentBrowserError {
  constructor(message: string) { super("tab_not_found", message); }
}

/**
 * A JavaScript dialog (alert, confirm, prompt, beforeunload) opened during a command that gave it no answer (--dialog),
 * or a page that does not answer at the start of a command, which an earlier dialog most likely blocks (board ab-exa).
 */
export class DialogError extends AgentBrowserError {
  constructor(message: string) { super("dialog", message); }
}

/** Agent mode's endpoint did not answer. */
export class ChromeUnreachableError extends AgentBrowserError {
  constructor(message: string, options?: { cause?: unknown }) { super("unreachable", message, options); }
}

/**
 * What a refusal names when the URL has no host that agent-browser can read (about:blank, a data: URL, no URL at all):
 * plain words, never a placeholder such as "(no host)" (board ab-nfn).
 */
export const UNREAD_HOST = "a host that the agent browser could not read";

/** The host of a URL for a message, never the full URL: UNREAD_HOST when it has none or does not parse. */
export function safeHost(url: string): string {
  try { return new URL(url).hostname || UNREAD_HOST; } catch { return UNREAD_HOST; }
}

/** The stable code of any thrown value: an AgentBrowserError's own, else "error". */
export function errorCode(e: unknown): ErrorCode {
  return e instanceof AgentBrowserError ? e.code : "error";
}

/**
 * Run each cleanup step, even after one fails, and return the failures as messages. A cleanup
 * failure never replaces the error of the work it cleans up after: see withCleanupErrors.
 */
export async function runCleanup(steps: [what: string, step: (() => Promise<unknown>) | false | undefined][]): Promise<string[]> {
  const failed: string[] = [];
  for (const [what, step] of steps) {
    if (!step) continue;
    try { await step(); } catch (e) { failed.push(`${what}: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return failed;
}

/** The work's own error, with any cleanup failures added to its message (its code is kept). */
export function withCleanupErrors(error: unknown, cleanupErrors: string[]): unknown {
  if (!cleanupErrors.length) return error;
  const note = `; cleanup also failed: ${cleanupErrors.join("; ")}`;
  if (error instanceof Error) { error.message += note; return error; }
  return new Error(String(error) + note);
}
