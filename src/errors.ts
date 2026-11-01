// Errors with a stable `code`. The CLI prints the code in its JSON error document, and the Python
// adapter maps each code to its own exception class, so callers never match on English text.

export type ErrorCode =
  | "usage"
  | "not_allowed"
  | "pin_required"
  | "read_first"
  | "tab_not_found"
  | "unreachable"
  | "approval_needed"
  | "notify_failed"
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
  /** The refused host (never the full URL). */
  readonly host: string;
  constructor(url: string, message = `refusing: ${safeHost(url)} is not on the allowlist`) {
    super("not_allowed", message);
    this.host = safeHost(url);
  }
}

/** Hosts and first labels of sign-in pages: a redirect there means the profile is not signed in. */
const SIGN_IN_HOSTS = ["accounts.google.com", "login.microsoftonline.com", "login.live.com", "appleid.apple.com", "signin.aws.amazon.com", "id.atlassian.com"];
const SIGN_IN_LABELS = ["login", "signin", "sign-in", "auth", "accounts", "sso"];

export function isSignInHost(host: string): boolean {
  const h = host.toLowerCase();
  return SIGN_IN_HOSTS.some((d) => h === d || h.endsWith("." + d)) || SIGN_IN_LABELS.includes(h.split(".")[0]);
}

/** What to do about a sign-in page, for the operator: sign in by hand, in the agent browser. */
export function signInHint(host: string, s: { mode: string; commandName: string }): string {
  if (!isSignInHost(host)) return "";
  return s.mode === "agent"
    ? `; ${host} is a sign-in page, so this profile is not signed in: run \`${s.commandName} launch --login\` and sign in by hand in the agent browser`
    : `; ${host} is a sign-in page: sign in by hand in that window`;
}

/**
 * A navigation to an allowlisted URL that ended on a host off the allowlist (a redirect): name both
 * hosts, say where the tab is, and how to sign in when it is a sign-in page. Any other error is kept.
 */
export function redirectError(e: unknown, requested: string, s: { mode: string; commandName: string }): unknown {
  if (!(e instanceof NotAllowedError) || e.host === safeHost(requested)) return e;
  return new NotAllowedError(`https://${e.host}/`, `refusing: ${safeHost(requested)} redirected the tab to ${e.host}, which is not on the allowlist${signInHint(e.host, s)}. The tab stays open there; agent-browser does not touch it`);
}

/** Personal mode acts only inside the caller's own pinned window. */
export class PinRequiredError extends AgentBrowserError {
  constructor(message: string) { super("pin_required", message); }
}

/** A screenshot before the page was read with outline or text. */
export class ReadFirstError extends AgentBrowserError {
  constructor(message: string) { super("read_first", message); }
}

export class TabNotFoundError extends AgentBrowserError {
  constructor(message: string) { super("tab_not_found", message); }
}

/** No Chrome endpoint answered, and no proxy could be started. */
export class ChromeUnreachableError extends AgentBrowserError {
  constructor(message: string, options?: { cause?: unknown }) { super("unreachable", message, options); }
}

/**
 * No approved connection is up, and the caller asked never to open a new one (noPrompt): a new one
 * waits on Chrome's "Allow remote debugging?" prompt, which only a person can answer.
 */
export class ApprovalNeededError extends AgentBrowserError {
  constructor(message: string) { super("approval_needed", message); }
}

export function safeHost(url: string): string {
  try { return new URL(url).hostname || "(no host)"; } catch { return "(invalid url)"; }
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
