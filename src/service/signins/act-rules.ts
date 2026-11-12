// The pure rules of the sign-in act (contract C11, "The sign-in act"; the stored sign-ins design,
// docs/superpowers/specs/2026-11-10-stored-sign-in-credentials-design.md, sections 7.4 to 7.8; board ab-v16.97.4, stage 1e
// part 2): the five forms of the password, the guard's decision for one paused request, the form rules on a read of the
// page, the outcome, the window's place, the move's payload (C2), and the rate of the refusal ends (C12's `sign_in`
// event). No function here logs, and no error text holds a value: the act (act.ts) gives only C11's texts.

import { coveredBy } from "../lists/hosts.ts";

/** C11's result codes and texts of the sign-in act (what the agent sees). `<name>` and `<host>` are filled in by the act. */
export const ACT_TEXT = {
  remote: "Stored sign-ins work only for sessions of this box.",
  no_such_name: "There is no stored sign-in named <name> for this repo.",
  not_allowed: "Not allowed: <host> is not on the allowlist",
  locked: "The stored sign-ins are locked. The operator unlocks them in the Browser pane.",
  cannot_open: "The stored sign-in cannot be opened. The operator adds it again.",
  stopped: "The site did not accept this stored sign-in three times. The operator checks it in the Browser pane.",
  hour_limit: "This stored sign-in was used often in the last hour. Try again later.",
  busy: "Another sign-in runs now. Try again in a minute.",
  private_window: "Another private window is open in the agent browser.",
  no_window: "The agent browser could not open the sign-in window.",
  other_origin: "The sign-in page is on another origin than the stored sign-in names.",
  password_fields: "The page has more than one password field.",
  no_form: "There is no sign-in form that the agent browser can fill.",
  form_target: "The sign-in form sends to another place than the stored sign-in names.",
  open_connection: "The sign-in page keeps a connection to another site open.",
  type_watch: "The page showed the password field as text, so the agent browser ended the sign-in.",
  rules: "The agent browser could not hold the sign-in's rules.",
  window: "The agent browser could not move the sign-in window off the screen.",
  not_accepted: "The site did not accept the stored sign-in.",
  second_factor: "The site asks for a second factor. The agent browser cannot answer it: ask the operator.",
  off_list: "The site went to a host on no list after the sign-in.",
  timeout: "The site did not finish the sign-in in 30 s.",
  lost: "The agent browser lost the sign-in window before the sign-in finished.",
  leak: "The site keeps the password where its pages can read it, so the agent browser did not keep the sign-in.",
  move: "The sign-in worked, but the agent browser could not move it to your tabs.",
} as const;
/** A refusal's result code (C11's table; `not_ready` gives the readiness's own text). */
export type ActResult = keyof typeof ACT_TEXT | "not_ready" | "signed_in";

/** The success's text for the CLI and the MCP tool (C11, what the agent sees). */
export const signedInText = (origin: string) => `Signed in to ${origin}. Your tabs of this site were closed for the sign-in; open the site again: it loads signed in.`;

// ---------------------------------------------------------------- the five forms of the password (design 7.6)

/**
 * The forms in which the guard and the leak check look for the password: plain, URL-encoded (as encodeURIComponent and
 * as a form body), JSON-escaped, base64 and base64url (with no padding, so a value inside a longer text matches too).
 * Each form once; an empty value has none.
 */
export function passwordForms(password: string): string[] {
  if (!password) return [];
  const b64 = Buffer.from(password, "utf8").toString("base64").replace(/=+$/, "");
  const b64u = Buffer.from(password, "utf8").toString("base64url");
  const form = new URLSearchParams({ x: password }).toString().slice(2);
  return [...new Set([password, encodeURIComponent(password), form, JSON.stringify(password).slice(1, -1), b64, b64u])].filter((s) => s.length > 0);
}

/** `text` holds the password in one of its five forms, also after a percent-decoding of `text` (a URL that Chrome encoded). */
export function holdsPassword(text: string, password: string): boolean {
  if (!text || !password) return false;
  const forms = passwordForms(password);
  if (forms.some((f) => text.includes(f))) return true;
  let decoded: string;
  try { decoded = decodeURIComponent(text.replace(/\+/g, " ")); } catch { return false; }
  return decoded !== text && forms.some((f) => decoded.includes(f));
}

// ---------------------------------------------------------------- the guard (design 7.6; C11, the block and the guard)

/** A request that Fetch paused at the request stage, as Fetch.requestPaused gives it. */
export type PausedRequest = { url: string; method?: string; postData?: string; hasPostData?: boolean; postDataEntries?: { bytes?: string }[] };

/** An origin of a URL, or null. */
export function originOf(url: string): string | null {
  try { const o = new URL(url).origin; return o === "null" ? null : o; } catch { return null; }
}

/** The body of a paused request as Chrome gives it: postData, else its entries joined; null when it has a body that Chrome does not give. */
export function bodyOf(r: PausedRequest): string | null {
  if (typeof r.postData === "string") return r.postData;
  if (Array.isArray(r.postDataEntries) && r.postDataEntries.length && r.postDataEntries.every((e) => typeof e?.bytes === "string")) {
    return r.postDataEntries.map((e) => Buffer.from(e.bytes!, "base64").toString("utf8")).join("");
  }
  return r.hasPostData ? null : "";
}

/**
 * The guard's decision for one paused request of the act tab: `fail` when its URL holds the password (any origin), or
 * when its origin is not in `send_to` and its body holds the password or Chrome does not give its body; else `continue`.
 */
export function guardDecision(r: PausedRequest, sendTo: readonly string[], password: string): "fail" | "continue" {
  if (holdsPassword(r.url, password)) return "fail";
  const origin = originOf(r.url);
  if (origin !== null && sendTo.includes(origin)) return "continue";
  const body = bodyOf(r);
  if (body === null || holdsPassword(body, password)) return "fail";
  return "continue";
}

// ---------------------------------------------------------------- the form rules (design 7.4; C11's form rules 1 to 4)

/** One input of the main frame as the act's read gives it (page.ts, READ_PAGE). `form`: the index of its form, or null. */
export type FieldRead = {
  i: number; type: string; visible: boolean; enabled: boolean; form: number | null; autocomplete: string; name: string; id: string;
  maxLength: number; box: { x: number; y: number; w: number; h: number };
};
/** The read of the page: the main frame's URL and origin, its inputs in document order, its forms, and whether a frame holds a password field. */
export type PageRead = { href: string; origin: string; fields: FieldRead[]; forms: { method: string; action: string }[]; framePassword: boolean };

const USER_TYPES = new Set(["text", "email", "tel"]);
export const isPassword = (f: FieldRead) => f.type === "password" && f.visible && f.enabled;
export const isUser = (f: FieldRead) => USER_TYPES.has(f.type) && f.visible && f.enabled;
/** A field for a code (design 7.7): autocomplete one-time-code, or a name or id with otp, totp, 2fa, mfa or code and a maxlength of 4 to 10. */
export const isCode = (f: FieldRead) => f.visible && f.enabled && f.type !== "password" && f.type !== "hidden"
  && (f.autocomplete.split(/\s+/).includes("one-time-code") || (/(otp|totp|2fa|mfa|code)/i.test(`${f.name} ${f.id}`) && f.maxLength >= 4 && f.maxLength <= 10));

/** The form rules' answer: a refusal, a two-step sign-in (its username field), or the fields to fill. */
export type FormPlan = { refused: "other_origin" | "password_fields" | "no_form" | "form_target" }
  | { step: FieldRead }
  | { user: FieldRead | null; password: FieldRead; form: number | null };

/**
 * C11's form rules 1 to 4 on a read: (1) the main frame's origin is the record's; (2) exactly one visible, enabled password
 * field, else with none and exactly one visible username field a two-step sign-in (when `stepDone` is false); (3) the
 * username field in the password field's form, before it, `autocomplete="username"` or `type="email"` first, else the
 * nearest one before it (none for an empty username, and none needed after the first step); (4) a password field in a
 * form: its method is post and its action's origin is in `send_to`. A password field in a frame only: no form.
 */
export function formPlan(read: PageRead, record: { origin: string; send_to: readonly string[] }, o: { username: boolean; stepDone: boolean }): FormPlan {
  if (read.origin !== record.origin) return { refused: "other_origin" };
  const passwords = read.fields.filter(isPassword);
  if (passwords.length > 1) return { refused: "password_fields" };
  if (passwords.length === 0) {
    const users = read.fields.filter(isUser);
    if (!o.stepDone && o.username && users.length === 1 && !read.framePassword) return { step: users[0] };
    return { refused: "no_form" };
  }
  const pw = passwords[0];
  let user: FieldRead | null = null;
  if (o.username && !o.stepDone) {
    const before = read.fields.filter((f) => isUser(f) && f.form === pw.form && f.i < pw.i);
    user = before.find((f) => f.autocomplete.split(/\s+/).includes("username")) ?? before.find((f) => f.type === "email") ?? before.at(-1) ?? null;
    if (!user) return { refused: "no_form" };
  }
  if (pw.form !== null) {
    const form = read.forms[pw.form];
    if (!form || form.method.toLowerCase() !== "post") return { refused: "form_target" };
    const action = originOf(form.action);
    if (action === null || !record.send_to.includes(action)) return { refused: "form_target" };
  }
  return { user, password: pw, form: pw.form };
}

/** A host of a ws:, wss: or WebTransport URL, or null. */
export function hostOf(url: string): string | null {
  try { return new URL(url).hostname || null; } catch { return null; }
}

/** C11's form rule 6: the hosts of the open WebSocket and WebTransport sessions that are outside the hosts of `send_to`. */
export function openOutside(urls: Iterable<string>, sendTo: readonly string[]): string[] {
  const hosts = new Set(sendTo.map(hostOf).filter((h): h is string => h !== null));
  const out: string[] = [];
  for (const u of urls) { const h = hostOf(u); if (h === null || !hosts.has(h)) out.push(h ?? ""); }
  return out;
}

// ---------------------------------------------------------------- the outcome (design 7.7)

/**
 * The outcome after the settle: a final host that the scope's list does not cover (also an error page of a blocked
 * navigation, whose unreachable URL counts, and about:blank, where the list's guard sends a page off its list), a visible
 * password field (not accepted), a field for a code with no password field (a second factor), else signed in.
 */
export function outcomeOf(read: PageRead, entries: readonly string[]): "signed_in" | "not_accepted" | "second_factor" | "off_list" {
  let host: string | null = null;
  try { const u = new URL(read.href); host = u.protocol === "http:" || u.protocol === "https:" ? u.hostname : null; } catch { host = null; }
  if (host === null || !coveredBy(entries, host)) return "off_list";
  if (read.fields.some(isPassword)) return "not_accepted";
  if (read.fields.some(isCode)) return "second_factor";
  return "signed_in";
}

// ---------------------------------------------------------------- the window's place (design 7.3)

/** The window lies wholly outside the screen's area: no pixel of it is on the screen. */
export function outsideScreen(w: { left?: unknown; top?: unknown; width?: unknown; height?: unknown }, screen: { width: number; height: number }): boolean {
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : NaN);
  const [l, t, wd, h] = [n(w.left), n(w.top), n(w.width), n(w.height)];
  if ([l, t, wd, h].some(Number.isNaN)) return false;
  return l >= screen.width || t >= screen.height || l + wd <= 0 || t + h <= 0;
}

// ---------------------------------------------------------------- the leak check and the move (design 7.8)

/** A cookie of C2 (C4's act_cookies answers in this form). */
export type C2Cookie = Record<string, unknown> & { name: string; value: string; domain: string };

/** The leak check: a cookie value or a localStorage value (or key) holds the password in one of its five forms. */
export function leaks(cookies: readonly C2Cookie[], local: Readonly<Record<string, string>>, password: string): boolean {
  return cookies.some((c) => holdsPassword(String(c.value), password))
    || Object.entries(local).some(([k, v]) => holdsPassword(k, password) || holdsPassword(v, password));
}

/** The move's C2 payload: the credential's host as `domain`, its origin, the origin with the path `/`, the cookies, and localStorage. */
export function movePayload(origin: string, cookies: readonly C2Cookie[], local: Readonly<Record<string, string>>): Record<string, unknown> {
  const host = new URL(origin).hostname;
  return { v: 1, domain: host, origin, url: `${origin}/`, cookies: cookies.map((c) => ({ ...c })), storage: { local: { ...local }, session: {}, idb: [], caches: [] } };
}

// ---------------------------------------------------------------- the rate of the refusal ends (C12; PR #112's open point 11)

/** The refusal ends of one scope in any 60 s, and the time between two ends past that. */
export const REFUSALS_PER_MINUTE = 10;
export const REFUSAL_WINDOW_MS = 60_000;

/**
 * The rate of the refusal ends (an `end` with no `start`): at most 10 for one scope in any 60 s. A further one is not
 * sent, and it is counted. The next refusal end of the scope that goes after such ones carries `dropped`, their number,
 * and it goes only when at least 60 s have passed since the scope's last refusal end that went. `take` answers whether
 * the end goes, and its `dropped` (0: no field).
 */
export class RefusalRate {
  private readonly scopes = new Map<string, { sent: number[]; dropped: number; last: number }>();
  take(scope: string, now: number): { send: boolean; dropped: number } {
    let s = this.scopes.get(scope);
    if (!s) this.scopes.set(scope, (s = { sent: [], dropped: 0, last: -Infinity }));
    s.sent = s.sent.filter((t) => now - t < REFUSAL_WINDOW_MS);
    const go = s.dropped === 0 ? s.sent.length < REFUSALS_PER_MINUTE : now - s.last >= REFUSAL_WINDOW_MS;
    if (!go) { s.dropped++; return { send: false, dropped: 0 }; }
    const dropped = s.dropped;
    s.dropped = 0; s.last = now; s.sent.push(now);
    // Keep the map small: a scope with nothing in its window and nothing dropped holds no state.
    for (const [k, v] of this.scopes) if (k !== scope && v.dropped === 0 && v.sent.every((t) => now - t >= REFUSAL_WINDOW_MS)) this.scopes.delete(k);
    return { send: true, dropped };
  }
}
