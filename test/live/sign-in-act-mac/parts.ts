// The pure parts of the Mac live check of the stored sign-ins (harness.ts; board ab-v16.97.17; the design note
// docs/superpowers/specs/2026-11-26-stored-sign-ins-mac-design.md, section 8, "The Mac live check"). No process, no file
// and no network here: test/sign-in-act-mac.test.ts runs them on Linux in `npm test`.

import { ACT_TEXT, passwordForms, signedInText } from "../../../src/service/signins/act-rules.ts";

export const HARNESS = "sign-in-act-mac";
export const VERSION = 1;
export const CREDENTIAL_NAME = "mac-live-test";
export const HOST = "login.localhost";
export const DEFAULT_PORT = 48731;
export const LOGIN_PATH = "/login";
export const HOME_PATH = "/home";
export const SEAT_PATH = "/seat";
export const STOP_PATH = "/harness/stop";
export const STOP_HEADER = "x-harness-token";
export const SESSION_COOKIE = "test_session";
export const RECORD_FIELD = "rec";
export const SERVE_MINUTES = 30;
export const SERVE_MINUTES_MAX = 120;
export const POST_MAX_BYTES = 64 * 1024;
export const SCAN_MAX_BYTES = 64 << 20;
// A hidden Chrome page gets no animation frame and at most one timer run a second; a visible one about 60 and 100.
export const RAF_RATE_MIN = 20, TICK_RATE_MIN = 40;
export const ACT_MS_MIN = 500;
export const ANSWER_FILE = "answer.txt", EXIT_FILE = "answer.exit", RUN_FILE = "run.json", SITE_FILE = "site.json";

export const originOf = (port: number) => `http://${HOST}:${port}`;

// ------------------------------------------------------------------ the test values

// Lowercase letters, digits and "-" only: each has a key with no Shift on the US layout, so the act types every
// character as one key (C11, the fill), and the page's key count is the two values' length. No "@": the privacy filter.
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
export type TestValues = { user: string; pass: string };

export function testValues(random: (n: number) => Uint8Array): TestValues {
  const hex = Buffer.from(random(6)).toString("hex");
  const b = random(16);
  const pass = Array.from(b, (x) => B32[x & 31]).join("");
  return { user: `test-user-${hex}`, pass: `test-pass-${pass}` };
}

export const valueForms = (v: TestValues): string[] => [...new Set([...passwordForms(v.user), ...passwordForms(v.pass)])];

export function holdsValue(text: string, v: TestValues): boolean {
  const forms = valueForms(v);
  if (forms.some((f) => text.includes(f))) return true;
  let decoded: string;
  try { decoded = decodeURIComponent(text.replace(/\+/g, " ")); } catch { return false; }
  return decoded !== text && forms.some((f) => decoded.includes(f));
}

// ------------------------------------------------------------------ the site

export const RECORDER_JS = `(() => {
  const s = { raf: 0, ticks: 0, visChanges: 0, focusEvents: 0, blurEvents: 0, keys: 0, keysUp: 0, inputs: 0, pointer: 0, untrusted: 0,
    keysVisible: 0, keysHidden: 0, keysFocus: 0, keysNoFocus: 0, first: null, rafFirst: 0, ticksFirst: 0 };
  const loop = () => { s.raf++; requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  setInterval(() => { s.ticks++; }, 10);
  document.addEventListener("visibilitychange", () => { s.visChanges++; });
  addEventListener("focus", () => { s.focusEvents++; });
  addEventListener("blur", () => { s.blurEvents++; });
  const form = document.getElementById("f");
  const mark = (e) => { if (!e.isTrusted) s.untrusted++; };
  form.addEventListener("keydown", (e) => {
    if (s.first === null) { s.first = performance.now(); s.rafFirst = s.raf; s.ticksFirst = s.ticks; }
    s.keys++; mark(e);
    if (document.visibilityState === "visible") s.keysVisible++; else s.keysHidden++;
    if (document.hasFocus()) s.keysFocus++; else s.keysNoFocus++;
  });
  form.addEventListener("keyup", (e) => { s.keysUp++; mark(e); });
  form.addEventListener("input", (e) => { s.inputs++; mark(e); });
  for (const t of ["mousedown", "mouseup", "click"]) form.addEventListener(t, (e) => { s.pointer++; mark(e); });
  form.addEventListener("submit", (e) => {
    const now = performance.now();
    document.getElementById("${RECORD_FIELD}").value = JSON.stringify({
      v: 1, vis: document.visibilityState, focus: document.hasFocus(), submitTrusted: e.isTrusted,
      keys: s.keys, keysUp: s.keysUp, inputs: s.inputs, pointer: s.pointer, untrusted: s.untrusted,
      keysVisible: s.keysVisible, keysHidden: s.keysHidden, keysFocus: s.keysFocus, keysNoFocus: s.keysNoFocus,
      visChanges: s.visChanges, focusEvents: s.focusEvents, blurEvents: s.blurEvents,
      actMs: s.first === null ? null : Math.round(now - s.first), actRaf: s.raf - s.rafFirst, actTicks: s.ticks - s.ticksFirst,
    });
  });
})();`;

const PAGE_HEAD = `<!doctype html><html><head><meta charset="utf-8"><title>agent-browser test sign-in</title><style>html,body{margin:0;background:#1d5c4a;color:#fff;font:16px sans-serif}main{margin:40px}input,button{display:block;margin:8px 0;font-size:16px}</style></head>`;

export const loginPage = (error = "") => `${PAGE_HEAD}<body><main><p>agent-browser test page: the Mac live check of the stored sign-ins. It takes a made-up test credential only.</p>
<form id="f" method="post" action="${LOGIN_PATH}"><p>${error}</p><input type="text" name="u" autocomplete="username"><input type="password" name="p" autocomplete="current-password"><input type="hidden" name="${RECORD_FIELD}" id="${RECORD_FIELD}" value=""><button type="submit">Sign in</button></form>
</main><script>${RECORDER_JS}</script></body></html>`;

export const statePage = (signedIn: boolean) => `${PAGE_HEAD}<body><main><p id="state">${signedIn ? "signed in" : "not signed in"}</p></main></body></html>`;

export type SiteRequest = { method: string; path: string; host: string | undefined; cookie: string | undefined; body: string; token: string | undefined };
export type SiteEvent =
  | { kind: "page" }
  | { kind: "post"; user: boolean; pass: boolean; record: PageRecord | null; session: boolean }
  | { kind: "home" | "seat"; signedIn: boolean }
  | { kind: "wrong host" }
  | { kind: "stop" };
export type SiteAnswer = { status: number; headers: Record<string, string>; body: string; event: SiteEvent | null };

const HTML = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" };

export function siteAnswer(r: SiteRequest, run: { port: number; token: string; values: TestValues }, sessions: Set<string>, newSession: () => string): SiteAnswer {
  const path = r.path.split("?")[0];
  if (r.host === `127.0.0.1:${run.port}` && path === STOP_PATH && r.method === "POST") {
    return r.token === run.token ? { status: 204, headers: {}, body: "", event: { kind: "stop" } } : { status: 403, headers: {}, body: "", event: null };
  }
  if (r.host !== `${HOST}:${run.port}`) return { status: 421, headers: {}, body: "", event: { kind: "wrong host" } };
  const sid = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([0-9a-f]{32})(?:;|$)`).exec(r.cookie ?? "")?.[1];
  const signedIn = sid !== undefined && sessions.has(sid);
  if (path === LOGIN_PATH && r.method === "POST") {
    const f = new URLSearchParams(r.body);
    const user = f.get("u") === run.values.user, pass = f.get("p") === run.values.pass;
    const record = parseRecord(f.get(RECORD_FIELD) ?? "");
    if (user && pass) {
      const id = newSession();
      sessions.add(id);
      return { status: 303, headers: { "Set-Cookie": `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax`, Location: HOME_PATH }, body: "", event: { kind: "post", user, pass, record, session: true } };
    }
    return { status: 200, headers: HTML, body: loginPage("not accepted"), event: { kind: "post", user, pass, record, session: false } };
  }
  if (r.method !== "GET") return { status: 405, headers: {}, body: "", event: null };
  if (path === LOGIN_PATH) return { status: 200, headers: HTML, body: loginPage(), event: { kind: "page" } };
  if (path === HOME_PATH || path === SEAT_PATH) return { status: 200, headers: HTML, body: statePage(signedIn), event: { kind: path === HOME_PATH ? "home" : "seat", signedIn } };
  return { status: 404, headers: {}, body: "", event: null };
}

// site.json holds no test value: only flags, counts and the page's records.
export type SiteState = { pages: number; posts: { at: number; user: boolean; pass: boolean; record: PageRecord | null; session: boolean }[]; homes: { at: number; signedIn: boolean }[]; seats: { at: number; signedIn: boolean }[]; wrongHost: number };
export const newSiteState = (): SiteState => ({ pages: 0, posts: [], homes: [], seats: [], wrongHost: 0 });

export function applyEvent(s: SiteState, e: SiteEvent | null, at: number): SiteState {
  if (!e) return s;
  switch (e.kind) {
    case "page": return { ...s, pages: s.pages + 1 };
    case "post": return { ...s, posts: [...s.posts, { at, user: e.user, pass: e.pass, record: e.record, session: e.session }] };
    case "home": return { ...s, homes: [...s.homes, { at, signedIn: e.signedIn }] };
    case "seat": return { ...s, seats: [...s.seats, { at, signedIn: e.signedIn }] };
    case "wrong host": return { ...s, wrongHost: s.wrongHost + 1 };
    default: return s;
  }
}

export function eventLine(e: SiteEvent): string | null {
  switch (e.kind) {
    case "page": return `site: GET ${LOGIN_PATH}: the sign-in page`;
    case "post": return `site: POST ${LOGIN_PATH}: the test username ${e.user ? "matches" : "does not match"}, the test password ${e.pass ? "matches" : "does not match"}, the page's record ${e.record ? "came" : "did not come"}${e.session ? "; signed in" : "; not accepted"}`;
    case "home": case "seat": return `site: GET ${e.kind === "home" ? HOME_PATH : SEAT_PATH}: ${e.signedIn ? "signed in" : "not signed in"}`;
    case "wrong host": return "site: a request with another Host (421)";
    case "stop": return "site: the stop";
  }
}

// ------------------------------------------------------------------ the page's record

export type PageRecord = {
  vis: "visible" | "hidden" | "other" | null; focus: boolean | null; submitTrusted: boolean | null;
  keys: number | null; keysUp: number | null; inputs: number | null; pointer: number | null; untrusted: number | null;
  keysVisible: number | null; keysHidden: number | null; keysFocus: number | null; keysNoFocus: number | null;
  visChanges: number | null; focusEvents: number | null; blurEvents: number | null;
  actMs: number | null; actRaf: number | null; actTicks: number | null;
};
const COUNTS = ["keys", "keysUp", "inputs", "pointer", "untrusted", "keysVisible", "keysHidden", "keysFocus", "keysNoFocus", "visChanges", "focusEvents", "blurEvents", "actMs", "actRaf", "actTicks"] as const;

export function parseRecord(text: string): PageRecord | null {
  if (!text || text.length > 4096) return null;
  let o: unknown;
  try { o = JSON.parse(text); } catch { return null; }
  if (!o || typeof o !== "object" || Array.isArray(o) || (o as { v?: unknown }).v !== 1) return null;
  const x = o as Record<string, unknown>;
  const n = (k: string) => (typeof x[k] === "number" && Number.isFinite(x[k]) && (x[k] as number) >= 0 ? Math.round(x[k] as number) : null);
  const b = (k: string) => (typeof x[k] === "boolean" ? (x[k] as boolean) : null);
  const vis = x.vis === "visible" || x.vis === "hidden" ? x.vis : x.vis === undefined ? null : "other";
  return { vis, focus: b("focus"), submitTrusted: b("submitTrusted"), ...Object.fromEntries(COUNTS.map((k) => [k, n(k)])) } as PageRecord;
}

// ------------------------------------------------------------------ the checks of step 3

// `ok` null is "not measured", never a pass. `why` holds fixed words and numbers only: no value and no "/" (checkResult).
export type Check = { ok: boolean | null; why: string | null };
const pass: Check = { ok: true, why: null };
const fail = (why: string): Check => ({ ok: false, why });
const notMeasured = (why: string): Check => ({ ok: null, why: `not measured: ${why}` });

export function answerCheck(output: string | null, exit: number | null, origin: string): Check {
  if (output === null || exit === null) return notMeasured("no answer file or exit file");
  if (exit === 0 && output.includes(signedInText(origin))) return pass;
  const code = (Object.entries(ACT_TEXT) as [string, string][]).find(([, t]) => output.includes(t))?.[0];
  if (code) return fail(`a refusal: ${code}`);
  if (/\bNot signed in\b/.test(output)) return fail("a refusal of another text");
  return fail(exit === 0 ? "exit 0 with no success text of this origin" : `exit ${exit} with no known text`);
}

export function pageCheck(rec: PageRecord | null, v: TestValues): Check {
  if (!rec) return notMeasured("the post held no record of the page");
  const missing = (["keys", "untrusted", "keysHidden", "actMs", "actRaf", "actTicks"] as const).filter((k) => rec[k] === null);
  if (rec.vis === null) missing.unshift("vis" as never);
  if (missing.length) return notMeasured(`the record has no ${missing.join(", ")}`);
  const why: string[] = [];
  const expected = v.user.length + v.pass.length;
  if (rec.vis !== "visible") why.push(`the page was ${rec.vis} at the submit`);
  if (rec.keysHidden! > 0) why.push(`${rec.keysHidden} keys came while the page was hidden`);
  if (rec.untrusted! > 0) why.push(`${rec.untrusted} events were not trusted`);
  if (rec.keys! < expected) why.push(`${rec.keys} of ${expected} keys came`);
  if (rec.actMs! < ACT_MS_MIN) why.push(`the act took ${rec.actMs} ms from its first key to the submit`);
  else {
    const raf = rate(rec.actRaf!, rec.actMs!), ticks = rate(rec.actTicks!, rec.actMs!);
    if (raf < RAF_RATE_MIN) why.push(`${raf} animation frames a second`);
    if (ticks < TICK_RATE_MIN) why.push(`${ticks} timer runs a second`);
  }
  return why.length ? fail(why.join("; ")) : pass;
}

export const rate = (count: number, ms: number) => (ms > 0 ? Math.round((count * 10_000) / ms) / 10 : 0);

export function postCheck(s: SiteState): Check {
  const p = s.posts.at(-1);
  if (!p) return notMeasured("the site got no post");
  if (p.user && p.pass) return pass;
  return fail([...(p.user ? [] : ["the post does not hold the test username"]), ...(p.pass ? [] : ["the post does not hold the test password"])].join("; "));
}

export function seatCheck(s: SiteState): Check {
  const signedAt = s.posts.find((p) => p.session)?.at;
  if (signedAt === undefined) return notMeasured("no sign-in at the site");
  const after = s.seats.filter((x) => x.at >= signedAt);
  if (!after.length) return notMeasured(`the seat did not open ${SEAT_PATH} after the sign-in`);
  return after.some((x) => x.signedIn) ? pass : fail(`the seat's tab of ${SEAT_PATH} did not load signed in`);
}

export type ScanText = { kind: "answer" | "scan"; text: string | null; why?: string };

export function scanCheck(texts: ScanText[], v: TestValues): Check {
  if (!holdsValue(`x${Buffer.from(v.pass).toString("base64url")}x`, v) || !holdsValue(`u=${encodeURIComponent(v.user)}`, v)) return fail("the scan's twin finds no planted value");
  const holding = texts.map((t, i) => (t.text !== null && holdsValue(t.text, v) ? `${t.kind === "answer" ? "the answer" : `scan text ${i}`}` : null)).filter((x): x is string => x !== null);
  if (holding.length) return fail(`a test value is in ${holding.join(", ")}`);
  const unread = texts.map((t, i) => (t.text === null ? `${t.kind === "answer" ? "the answer" : `scan text ${i}`} (${t.why ?? "not read"})` : null)).filter((x): x is string => x !== null);
  if (unread.length) return notMeasured(`${unread.join(", ")}`);
  if (texts.filter((t) => t.kind === "scan").length === 0) return notMeasured("no log or event text was given");
  return pass;
}

export type Answer = "yes" | "no" | "unsure";
export const ANSWERS: readonly Answer[] = ["yes", "no", "unsure"];

export function frontCheck(frontChanged: Answer | null): Check {
  if (frontChanged === "no") return pass;
  if (frontChanged === "yes") return fail("the operator saw the front app change");
  return notMeasured(frontChanged === "unsure" ? "the operator is not sure" : "the operator was not asked");
}

// ------------------------------------------------------------------ the result

export const CHECK_NAMES = ["answer", "page", "post", "seatTab", "scan", "front"] as const;
export type CheckName = (typeof CHECK_NAMES)[number];
export type Result = {
  harness: string; version: number; ok: boolean; os: string; port: number;
  checks: Record<CheckName, Check>;
  page: PageRecord | null; site: { pages: number; posts: number; homes: number; seats: number; wrongHost: number };
  operator: { window: Answer | null; frontChanged: Answer | null };
};

export function resultOf(o: { os: string; port: number; values: TestValues; site: SiteState; answer: string | null; exit: number | null; scans: ScanText[]; window: Answer | null; frontChanged: Answer | null }): Result {
  const last = o.site.posts.at(-1) ?? null;
  const checks: Record<CheckName, Check> = {
    answer: answerCheck(o.answer, o.exit, originOf(o.port)),
    page: pageCheck(last?.record ?? null, o.values),
    post: postCheck(o.site),
    seatTab: seatCheck(o.site),
    scan: scanCheck([{ kind: "answer", text: o.answer, why: "no answer file" }, ...o.scans], o.values),
    front: frontCheck(o.frontChanged),
  };
  return {
    harness: HARNESS, version: VERSION, ok: CHECK_NAMES.every((k) => checks[k].ok === true), os: o.os, port: o.port, checks,
    page: last?.record ?? null,
    site: { pages: o.site.pages, posts: o.site.posts.length, homes: o.site.homes.length, seats: o.site.seats.length, wrongHost: o.site.wrongHost },
    operator: { window: o.window, frontChanged: o.frontChanged },
  };
}

export function checkResult(r: Result, v: TestValues): string | null {
  const text = JSON.stringify(r);
  if (holdsValue(text, v)) return "the result holds a test value";
  if (/[/\\@]/.test(text)) return "the result holds a path or an address";
  return null;
}

// ------------------------------------------------------------------ the arguments and the operator's text

export type Args =
  | { cmd: "serve"; port: number; minutes: number }
  | { cmd: "check"; folder: string; scans: string[]; window: Answer | null; frontChanged: Answer | null; keep: boolean }
  | { error: string };

export function parseArgs(argv: readonly string[]): Args {
  const [cmd, ...rest] = argv;
  if (cmd !== "serve" && cmd !== "check") return { error: "the first argument is serve or check" };
  const values = new Map<string, string[]>();
  let keep = false;
  const single = cmd === "serve" ? ["--port", "--minutes"] : ["--folder", "--window", "--front-changed"];
  const multi = cmd === "check" ? ["--scan"] : [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (cmd === "check" && a === "--keep") { keep = true; continue; }
    if (!single.includes(a) && !multi.includes(a)) return { error: `an unknown argument for ${cmd}` };
    const val = rest[++i];
    if (val === undefined || val.startsWith("--")) return { error: `${a} needs a value` };
    if (single.includes(a) && values.has(a)) return { error: `${a} comes more than once` };
    values.set(a, [...(values.get(a) ?? []), val]);
  }
  const one = (k: string) => values.get(k)?.[0];
  if (cmd === "serve") {
    const port = one("--port") === undefined ? DEFAULT_PORT : Number(one("--port"));
    const minutes = one("--minutes") === undefined ? SERVE_MINUTES : Number(one("--minutes"));
    if (!Number.isInteger(port) || port < 0 || port > 65535) return { error: "--port is a whole number from 0 to 65535" };
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > SERVE_MINUTES_MAX) return { error: `--minutes is a whole number from 1 to ${SERVE_MINUTES_MAX}` };
    return { cmd, port, minutes };
  }
  const folder = one("--folder");
  if (!folder) return { error: "check needs --folder" };
  const answer = (k: string): Answer | null | "bad" => { const x = one(k); return x === undefined ? null : (ANSWERS as readonly string[]).includes(x) ? (x as Answer) : "bad"; };
  const window = answer("--window"), frontChanged = answer("--front-changed");
  if (window === "bad" || frontChanged === "bad") return { error: "--window and --front-changed take yes, no or unsure" };
  return { cmd, folder, scans: values.get("--scan") ?? [], window, frontChanged, keep };
}

export function setupText(o: { port: number; folder: string; values: TestValues; until: string; harness: string }): string {
  const origin = originOf(o.port);
  return [
    `${HARNESS}: the local login site serves ${origin}${LOGIN_PATH} on 127.0.0.1 only, until ${o.until} or the check's stop.`,
    "The operator, in the Browser pane (step 2):",
    `  1. the scope's list entry: ${HOST}`,
    "  2. Add a stored sign-in:",
    `     Name: ${CREDENTIAL_NAME}`,
    `     Origin of the site: ${origin}`,
    `     Sign-in path: ${LOGIN_PATH}`,
    `     Username: ${o.values.user}`,
    `     Password (and the password again): ${o.values.pass}`,
    "     More origins: none",
    "  These are made-up test values of this run, not a real credential.",
    "The seat (step 3), from this checkout, after the operator's step 2:",
    `  agentwatch browser sign-in ${CREDENTIAL_NAME} > ${o.folder}/${ANSWER_FILE} 2>&1; echo $? > ${o.folder}/${EXIT_FILE}`,
    `  then open ${origin}${SEAT_PATH} in the seat's agent browser tab, ask the operator the two questions, and run`,
    `  node ${o.harness} check --folder ${o.folder} --window <yes|no|unsure> --front-changed <yes|no|unsure> --scan <file> ...`,
    "",
  ].join("\n");
}
