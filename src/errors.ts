// Errors with a stable `code`. The CLI prints the code in its JSON error document, and the Python
// adapter maps each code to its own exception class, so callers never match on English text.

export type ErrorCode =
  | "usage"
  | "not_allowed"
  | "pin_required"
  | "read_first"
  | "tab_not_found"
  | "unreachable"
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

/** A URL or tab whose host is not on the allowlist (or is a mail, account or admin host). Only the host is ever named. */
export class NotAllowedError extends AgentBrowserError {
  constructor(url: string, message = `refusing: ${safeHost(url)} is not on the allowlist`) {
    super("not_allowed", message);
  }
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

export function safeHost(url: string): string {
  try { return new URL(url).hostname || "(no host)"; } catch { return "(invalid url)"; }
}

/** The stable code of any thrown value: an AgentBrowserError's own, else "error". */
export function errorCode(e: unknown): ErrorCode {
  return e instanceof AgentBrowserError ? e.code : "error";
}
