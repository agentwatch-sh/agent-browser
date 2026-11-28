// The Mac live check of the stored sign-ins (test/live/sign-in-act-mac/; board ab-v16.97.17): its pure parts, the page's
// recorder in a stand-in DOM (node:vm), and on Linux the harness itself on loopback: serve, a stand-in of the act's
// requests, check, and the stops. No test here starts a Chrome or runs agentwatch.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { ACT_TEXT, signedInText } from "../src/service/signins/act-rules.ts";
import { tempDir, done } from "./temp-dirs.ts";
import {
  ACT_MS_MIN, ANSWER_FILE, CHECK_NAMES, CREDENTIAL_NAME, DEFAULT_PORT, EXIT_FILE, HOST, LOGIN_PATH, RECORD_FIELD, RECORDER_JS, RUN_FILE, SEAT_PATH, SESSION_COOKIE,
  SITE_FILE, STOP_HEADER, STOP_PATH,
  answerCheck, applyEvent, checkResult, eventLine, frontCheck, holdsValue, loginPage, newSiteState, originOf, pageCheck, parseArgs, parseRecord, postCheck,
  resultOf, scanCheck, seatCheck, setupText, siteAnswer, testValues, valueForms,
  type PageRecord, type SiteState, type TestValues,
} from "./live/sign-in-act-mac/parts.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const HARNESS = fileURLToPath(new URL("./live/sign-in-act-mac/harness.ts", import.meta.url));
const V: TestValues = { user: "test-user-0a1b2c3d4e5f", pass: "test-pass-abcdefgh23456789" };
const KEYS = V.user.length + V.pass.length;
const GOOD: PageRecord = {
  vis: "visible", focus: false, submitTrusted: true, keys: KEYS, keysUp: KEYS, inputs: KEYS, pointer: 9, untrusted: 0, keysVisible: KEYS, keysHidden: 0,
  keysFocus: 0, keysNoFocus: KEYS, visChanges: 0, focusEvents: 0, blurEvents: 0, actMs: 4000, actRaf: 240, actTicks: 400,
};

// ------------------------------------------------------------------ the test values and the scan

test("the test values: made up, new for each run, only keys with no Shift on the US layout, no @", () => {
  const a = testValues((n) => new Uint8Array(n).fill(7)), b = testValues((n) => new Uint8Array(n).map((_, i) => i * 37));
  assert.match(a.user, /^test-user-[0-9a-f]{12}$/);
  assert.match(a.pass, /^test-pass-[a-z2-7]{16}$/);
  assert.notEqual(a.user, b.user);
  assert.notEqual(a.pass, b.pass);
  for (const v of [a, b]) assert.ok(/^[a-z0-9-]+$/.test(v.user + v.pass) && v.pass.length <= 40 && v.user.length <= 40, JSON.stringify(v));
});

test("the scan: each test value in the act's five forms, also inside a percent-encoded text; not a near value", () => {
  for (const s of [V.user, V.pass, encodeURIComponent(V.pass), Buffer.from(V.pass).toString("base64").replace(/=+$/, ""), Buffer.from(V.user).toString("base64url"), JSON.stringify(V.pass)]) {
    assert.ok(holdsValue(`log line ${s} end`, V), s);
  }
  assert.ok(holdsValue(`u=${encodeURIComponent(V.user).replace(/-/g, "%2D")}`, V), "after a percent-decoding");
  assert.ok(!holdsValue(`${V.pass.slice(0, -1)} ${V.user.slice(1)}`, V), "a part of a value is no value");
  for (const x of [V.user, V.pass]) for (const f of [x, Buffer.from(x).toString("base64").replace(/=+$/, ""), Buffer.from(x).toString("base64url")]) assert.ok(valueForms(V).includes(f), f);
});

// ------------------------------------------------------------------ the site

test("the sign-in page: one form that posts to its own path, a username field, one password field, the hidden record, a submit button; no other host", () => {
  const p = loginPage();
  assert.equal((p.match(/<form /g) ?? []).length, 1);
  assert.match(p, new RegExp(`<form id="f" method="post" action="${LOGIN_PATH}">`));
  assert.equal((p.match(/type="password"/g) ?? []).length, 1);
  assert.match(p, /<input type="text" name="u" autocomplete="username">/);
  assert.match(p, new RegExp(`<input type="hidden" name="${RECORD_FIELD}" id="${RECORD_FIELD}" value="">`));
  assert.match(p, /<button type="submit">Sign in<\/button>/);
  assert.ok(p.includes(RECORDER_JS));
  assert.ok(!/https?:|\/\/[a-z]/i.test(p), "no URL of a host: the page sends only to its own origin");
  assert.match(loginPage("not accepted"), /<p>not accepted<\/p>/);
});

// The stand-in's rates follow Chrome: a frame each 16 ms and the 10 ms timer while visible; no frame and one timer run a second while hidden.
function page() {
  let now = 0;
  const rafs: (() => void)[] = [], timers: (() => void)[] = [];
  const target = () => { const m = new Map<string, ((e: object) => void)[]>(); return { addEventListener: (t: string, f: (e: object) => void) => m.set(t, [...(m.get(t) ?? []), f]), fire: (t: string, e: object) => { for (const f of m.get(t) ?? []) f(e); } }; };
  const win = target(), doc = target(), form = target();
  const rec = { value: "" };
  const st = { vis: "visible", focus: false };
  const document = { get visibilityState() { return st.vis; }, hasFocus: () => st.focus, addEventListener: doc.addEventListener, getElementById: (id: string) => (id === "f" ? form : id === RECORD_FIELD ? rec : null) };
  runInNewContext(RECORDER_JS, { document, addEventListener: win.addEventListener, requestAnimationFrame: (f: () => void) => rafs.push(f), setInterval: (f: () => void) => timers.push(f), performance: { now: () => now } });
  const p = {
    st, rec,
    advance(ms: number) {
      for (let i = 0; i < ms; i++) {
        now++;
        if (st.vis === "visible" ? now % 10 === 0 : now % 1000 === 0) for (const f of timers) f();
        if (st.vis === "visible" && now % 16 === 0) for (const f of rafs.splice(0)) f();
      }
    },
    type(n: number, o: { trusted?: boolean; gap?: number } = {}) {
      for (let i = 0; i < n; i++) {
        const e = { isTrusted: o.trusted ?? true };
        form.fire("keydown", e); form.fire("input", e); form.fire("keyup", e);
        p.advance(o.gap ?? 80);
      }
    },
    click() { for (const t of ["mousedown", "mouseup", "click"]) form.fire(t, { isTrusted: true }); },
    submit() { form.fire("submit", { isTrusted: true }); return parseRecord(rec.value); },
    visibility(v: "visible" | "hidden") { st.vis = v; doc.fire("visibilitychange", {}); },
  };
  return p;
}

test("the page's recorder (in a stand-in DOM): a visible act with trusted keys passes; its counts are what the site saw", () => {
  const p = page();
  p.advance(1000);
  p.click(); p.type(V.user.length); p.click(); p.type(V.pass.length); p.click();
  const r = p.submit()!;
  assert.deepEqual([r.vis, r.focus, r.submitTrusted, r.keys, r.keysUp, r.inputs, r.pointer, r.untrusted, r.keysVisible, r.keysHidden, r.keysFocus, r.keysNoFocus],
    ["visible", false, true, KEYS, KEYS, KEYS, 9, 0, KEYS, 0, 0, KEYS]);
  assert.equal(r.actMs, (KEYS - 1) * 80 + 80, "from the first key to the submit");
  assert.ok(r.actRaf! > 200 && r.actTicks! > 300, JSON.stringify(r));
  assert.deepEqual(pageCheck(r, V), { ok: true, why: null });
  assert.ok(!holdsValue(p.rec.value, V), "the record holds no test value");
});

test("the page's recorder: a key on a hidden page, an untrusted key, and too few keys each fail; no submit gives no record", () => {
  const hidden = page();
  hidden.type(10); hidden.visibility("hidden"); hidden.type(KEYS - 10, { gap: 200 }); hidden.visibility("visible");
  const h = hidden.submit()!;
  assert.equal(h.keysHidden, KEYS - 10);
  assert.equal(h.visChanges, 2);
  assert.match(pageCheck(h, V).why!, /keys came while the page was hidden; .*animation frames a second; .*timer runs a second/);
  const untrusted = page();
  untrusted.type(KEYS - 1); untrusted.type(1, { trusted: false });
  assert.equal(pageCheck(untrusted.submit(), V).why, "3 events were not trusted");
  const few = page();
  few.type(5);
  assert.equal(pageCheck(few.submit(), V).why, `5 of ${KEYS} keys came; the act took 400 ms from its first key to the submit`);
  const none = page();
  none.advance(500);
  assert.equal(none.rec.value, "");
  assert.deepEqual(pageCheck(parseRecord(none.rec.value), V), { ok: null, why: "not measured: the post held no record of the page" });
  const insert = page();
  insert.advance(500);
  const noKey = insert.submit()!;
  assert.equal(noKey.actMs, null, "no key: an Input.insertText fill");
  assert.match(pageCheck(noKey, V).why!, /^not measured: the record has no actMs/);
});

test("the record's parser: numbers, the visibility word and flags only; another text is no record", () => {
  assert.deepEqual(parseRecord(JSON.stringify({ v: 1, ...GOOD })), GOOD);
  const odd = parseRecord(JSON.stringify({ v: 1, vis: "prerender", keys: -1, actMs: 12.6, focus: "yes", extra: V.pass }))!;
  assert.deepEqual([odd.vis, odd.keys, odd.actMs, odd.focus], ["other", null, 13, null]);
  assert.ok(!JSON.stringify(odd).includes(V.pass), "an unknown field stays out");
  for (const t of ["", "x", "[]", "null", JSON.stringify({ v: 2 }), JSON.stringify({ v: 1, pad: "x".repeat(5000) })]) assert.equal(parseRecord(t), null, t);
});

const RUN = { port: 41234, token: "ab".repeat(16), values: V };
const SITE = `${HOST}:${RUN.port}`;
const ask = (method: string, path: string, o: { host?: string; cookie?: string; body?: string; token?: string } = {}, sessions = new Set<string>()) =>
  siteAnswer({ method, path, host: o.host ?? SITE, cookie: o.cookie, body: o.body ?? "", token: o.token }, RUN, sessions, () => "c".repeat(32));
const form = (u: string, p: string, rec = JSON.stringify({ v: 1, ...GOOD })) => new URLSearchParams({ u, p, [RECORD_FIELD]: rec }).toString();

test("the site: login.localhost on its port only; the page, the post with the test values (a session), a wrong post (not accepted), the state pages, the stop with the run's token", () => {
  assert.deepEqual(ask("GET", LOGIN_PATH, { host: `127.0.0.1:${RUN.port}` }).status, 421);
  assert.deepEqual(ask("GET", LOGIN_PATH, { host: `${HOST}:1` }).event, { kind: "wrong host" });
  const page = ask("GET", `${LOGIN_PATH}?x=1`);
  assert.deepEqual([page.status, page.event], [200, { kind: "page" }]);
  assert.equal(page.body, loginPage());
  const sessions = new Set<string>();
  const ok = ask("POST", LOGIN_PATH, { body: form(V.user, V.pass) }, sessions);
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.Location, "/home");
  assert.equal(ok.headers["Set-Cookie"], `${SESSION_COOKIE}=${"c".repeat(32)}; Path=/; HttpOnly; SameSite=Lax`);
  assert.deepEqual(ok.event, { kind: "post", user: true, pass: true, record: GOOD, session: true });
  assert.ok(!JSON.stringify(ok.event).includes(V.pass) && !JSON.stringify(ok.event).includes(V.user), "the event holds no test value");
  const wrong = ask("POST", LOGIN_PATH, { body: form(V.user, "test-pass-other", "") }, sessions);
  assert.deepEqual([wrong.status, wrong.event], [200, { kind: "post", user: true, pass: false, record: null, session: false }]);
  assert.match(wrong.body, /not accepted/);
  const cookie = `other=1; ${SESSION_COOKIE}=${"c".repeat(32)}`;
  assert.deepEqual(ask("GET", SEAT_PATH, { cookie }, sessions).event, { kind: "seat", signedIn: true });
  assert.match(ask("GET", SEAT_PATH, { cookie }, sessions).body, /<p id="state">signed in<\/p>/);
  assert.deepEqual(ask("GET", "/home", { cookie }, sessions).event, { kind: "home", signedIn: true });
  assert.deepEqual(ask("GET", SEAT_PATH, { cookie: `${SESSION_COOKIE}=${"d".repeat(32)}` }, sessions).event, { kind: "seat", signedIn: false });
  assert.deepEqual(ask("GET", SEAT_PATH).event, { kind: "seat", signedIn: false });
  assert.equal(ask("GET", "/favicon.ico").status, 404);
  assert.equal(ask("PUT", SEAT_PATH).status, 405);
  assert.deepEqual(ask("POST", STOP_PATH, { host: `127.0.0.1:${RUN.port}`, token: RUN.token }).event, { kind: "stop" });
  assert.deepEqual([ask("POST", STOP_PATH, { host: `127.0.0.1:${RUN.port}`, token: "x" }).status, ask("POST", STOP_PATH, { host: `127.0.0.1:${RUN.port}` }).event], [403, null]);
  assert.equal(ask("POST", STOP_PATH, { token: RUN.token }).status, 405, "no stop on the site's host");
  assert.equal(ask("GET", STOP_PATH, { host: `127.0.0.1:${RUN.port}`, token: RUN.token }).status, 421);
});

test("the site's state and its log lines: flags and counts only, no test value", () => {
  let s = newSiteState();
  for (const e of [{ kind: "page" }, { kind: "post", user: true, pass: true, record: GOOD, session: true }, { kind: "home", signedIn: true }, { kind: "seat", signedIn: true }, { kind: "wrong host" }, { kind: "stop" }] as const) {
    s = applyEvent(s, e, 5);
    assert.ok(eventLine(e) && !holdsValue(eventLine(e)!, V));
  }
  assert.deepEqual([s.pages, s.posts.length, s.homes.length, s.seats.length, s.wrongHost], [1, 1, 1, 1, 1]);
  assert.equal(eventLine({ kind: "post", user: true, pass: false, record: null, session: false }), "site: POST /login: the test username matches, the test password does not match, the page's record did not come; not accepted");
  assert.equal(applyEvent(s, null, 9), s);
});

// ------------------------------------------------------------------ the checks of step 3 and the result

const ORIGIN = originOf(RUN.port);

test("the answer: exit 0 with C11's success text of this origin; a refusal by its result code (never its text); no file is not measured", () => {
  assert.deepEqual(answerCheck(`${signedInText(ORIGIN)}\n`, 0, ORIGIN), { ok: true, why: null });
  assert.deepEqual(answerCheck(`${signedInText(originOf(1))}\n`, 0, ORIGIN), { ok: false, why: "exit 0 with no success text of this origin" });
  assert.deepEqual(answerCheck(`Not signed in: ${ACT_TEXT.locked}\n`, 1, ORIGIN), { ok: false, why: "a refusal: locked" });
  assert.deepEqual(answerCheck(`Not signed in: ${ACT_TEXT.no_such_name.replace("<name>", CREDENTIAL_NAME)}`, 1, ORIGIN), { ok: false, why: "a refusal of another text" });
  assert.deepEqual(answerCheck("", 127, ORIGIN), { ok: false, why: "exit 127 with no known text" });
  assert.equal(answerCheck(null, 0, ORIGIN).ok, null);
  assert.equal(answerCheck(signedInText(ORIGIN), null, ORIGIN).ok, null);
});

test("the page check's bounds: the act's time, the frames and the timer at a page's rate", () => {
  assert.deepEqual(pageCheck(GOOD, V), { ok: true, why: null });
  assert.equal(pageCheck({ ...GOOD, vis: "hidden" }, V).why, "the page was hidden at the submit");
  assert.equal(pageCheck({ ...GOOD, actMs: ACT_MS_MIN - 1 }, V).why, `the act took ${ACT_MS_MIN - 1} ms from its first key to the submit`);
  assert.equal(pageCheck({ ...GOOD, actRaf: 4, actTicks: 4 }, V).why, "1 animation frames a second; 1 timer runs a second");
  assert.equal(pageCheck({ ...GOOD, keys: KEYS + 2 }, V).ok, true, "a Shift or another key more is no failure");
  assert.equal(pageCheck({ ...GOOD, vis: null }, V).why, "not measured: the record has no vis");
});

const signed = (o: Partial<SiteState> = {}): SiteState => ({ ...newSiteState(), posts: [{ at: 100, user: true, pass: true, record: GOOD, session: true }], seats: [{ at: 200, signedIn: true }], ...o });

test("the post and the seat's tab: the last post holds both test values; a /seat after the sign-in loads signed in", () => {
  assert.deepEqual(postCheck(signed()), { ok: true, why: null });
  assert.equal(postCheck(newSiteState()).ok, null);
  assert.equal(postCheck(signed({ posts: [{ at: 1, user: false, pass: false, record: null, session: false }] })).why, "the post does not hold the test username; the post does not hold the test password");
  assert.deepEqual(seatCheck(signed()), { ok: true, why: null });
  assert.equal(seatCheck(signed({ seats: [{ at: 50, signedIn: false }] })).why, "not measured: the seat did not open /seat after the sign-in");
  assert.equal(seatCheck(signed({ seats: [{ at: 300, signedIn: false }] })).why, "the seat's tab of /seat did not load signed in");
  assert.equal(seatCheck(newSiteState()).ok, null);
});

test("the scan: a test value in the answer or in a given text fails; a text that was not read, or no log or event text, is not measured", () => {
  const ans = { kind: "answer" as const, text: signedInText(ORIGIN) };
  assert.deepEqual(scanCheck([ans, { kind: "scan", text: "service: sign-in: user live, scope s, result signed_in" }], V), { ok: true, why: null });
  assert.equal(scanCheck([ans, { kind: "scan", text: `x ${Buffer.from(V.pass).toString("base64")} x` }], V).why, "a test value is in scan text 1");
  assert.equal(scanCheck([{ kind: "answer", text: V.user }, { kind: "scan", text: "" }], V).why, "a test value is in the answer");
  assert.equal(scanCheck([ans, { kind: "scan", text: null, why: "ENOENT" }], V).why, "not measured: scan text 1 (ENOENT)");
  assert.equal(scanCheck([ans], V).why, "not measured: no log or event text was given");
  assert.equal(scanCheck([ans, { kind: "scan", text: "" }], { user: "", pass: "" }).why, "the scan's twin finds no planted value");
});

test("the operator's front answer: no holds, yes fails, unsure or no answer is not measured", () => {
  assert.deepEqual([frontCheck("no").ok, frontCheck("yes").ok, frontCheck("unsure").ok, frontCheck(null).ok], [true, false, null, null]);
});

test("the result: ok only when every check holds; the operator's two answers; no test value, no path, no address", () => {
  const base = { os: "darwin", port: RUN.port, values: V, site: signed(), answer: `${signedInText(ORIGIN)}\n`, exit: 0, scans: [{ kind: "scan" as const, text: "a log" }], window: "yes" as const, frontChanged: "no" as const };
  const r = resultOf(base);
  assert.deepEqual(Object.keys(r.checks), [...CHECK_NAMES]);
  assert.equal(r.ok, true, JSON.stringify(r.checks));
  assert.deepEqual(r.operator, { window: "yes", frontChanged: "no" });
  assert.deepEqual(r.site, { pages: 0, posts: 1, homes: 0, seats: 1, wrongHost: 0 });
  assert.equal(checkResult(r, V), null);
  assert.equal(resultOf({ ...base, window: "no" }).ok, true, "the window answer is a fact, no check");
  for (const [o, name] of [[{ frontChanged: "unsure" }, "front"], [{ exit: 1 }, "answer"], [{ scans: [] }, "scan"], [{ site: signed({ seats: [] }) }, "seatTab"]] as const) {
    const x = resultOf({ ...base, ...o } as typeof base);
    assert.equal(x.ok, false, name);
    assert.notEqual(x.checks[name].ok, true, name);
  }
  assert.equal(checkResult({ ...r, os: V.pass }, V), "the result holds a test value");
  assert.equal(checkResult({ ...r, os: "a/b" }, V), "the result holds a path or an address");
});

test("the arguments: serve with a port and minutes; check with its folder, the two answers, scans and keep", () => {
  assert.deepEqual(parseArgs(["serve"]), { cmd: "serve", port: DEFAULT_PORT, minutes: 30 });
  assert.deepEqual(parseArgs(["serve", "--port", "0", "--minutes", "5"]), { cmd: "serve", port: 0, minutes: 5 });
  assert.deepEqual(parseArgs(["check", "--folder", "f", "--window", "yes", "--front-changed", "no", "--scan", "a", "--scan", "b", "--keep"]), { cmd: "check", folder: "f", scans: ["a", "b"], window: "yes", frontChanged: "no", keep: true });
  assert.deepEqual(parseArgs(["check", "--folder", "f"]), { cmd: "check", folder: "f", scans: [], window: null, frontChanged: null, keep: false });
  for (const bad of [[], ["run"], ["serve", "--port", "70000"], ["serve", "--minutes", "0"], ["serve", "--minutes", "121"], ["serve", "--scan", "a"], ["serve", "--port"], ["check"], ["check", "--folder", "f", "--window", "maybe"], ["check", "--folder", "f", "--folder", "g"], ["check", "--folder", "--keep"]]) {
    assert.ok("error" in parseArgs(bad), bad.join(" "));
  }
});

test("the operator's text: the list entry, the credential's fields with the run's made-up values, the seat's command and the check", () => {
  const t = setupText({ port: RUN.port, folder: "F", values: V, until: "T", harness: "H" });
  for (const s of [`the scope's list entry: ${HOST}`, `Name: ${CREDENTIAL_NAME}`, `Origin of the site: ${ORIGIN}`, `Sign-in path: ${LOGIN_PATH}`, `Username: ${V.user}`, `Password (and the password again): ${V.pass}`,
    "made-up test values", `agentwatch browser sign-in ${CREDENTIAL_NAME} > F/${ANSWER_FILE} 2>&1; echo $? > F/${EXIT_FILE}`, `${ORIGIN}${SEAT_PATH}`, "node H check --folder F"]) assert.ok(t.includes(s), s);
});

// ------------------------------------------------------------------ the harness on Linux (loopback)

type Serve = { c: ChildProcess; out: () => string; head: { folder: string; port: number; origin: string; pid: number }; exit: Promise<number | null> };
function serve(env: NodeJS.ProcessEnv): Promise<Serve> {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [HARNESS, "serve", "--port", "0", "--minutes", "1"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const kill = setTimeout(() => c.kill("SIGKILL"), 50_000);
    const exit = new Promise<number | null>((r) => c.on("close", (code) => { clearTimeout(kill); r(code); }));
    c.stdout!.on("data", (d) => {
      out += d;
      const first = out.split("\n")[0];
      if (out.includes("\n") && !(c as { head?: unknown }).head) {
        try { const head = JSON.parse(first); (c as { head?: unknown }).head = head; resolve({ c, out: () => out, head, exit }); } catch (e) { reject(e); }
      }
    });
    c.stderr!.on("data", (d) => { err += d; });
    c.on("close", (code) => { if (!(c as { head?: unknown }).head) reject(new Error(`serve ended (${code}): ${err}`)); });
  });
}
const http = (port: number, method: string, path: string, headers: Record<string, string>, body = "") => new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
  const r = request({ host: "127.0.0.1", port, method, path, headers: { ...headers, ...(body ? { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": String(Buffer.byteLength(body)) } : {}) } }, (res) => {
    let b = "";
    res.on("data", (d) => { b += d; });
    res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
  });
  r.on("error", reject);
  r.end(body);
});
const check = (env: NodeJS.ProcessEnv, args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
  const c = spawn(process.execPath, [HARNESS, "check", ...args], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  c.stdout!.on("data", (d) => { stdout += d; });
  c.stderr!.on("data", (d) => { stderr += d; });
  const kill = setTimeout(() => c.kill("SIGKILL"), 30_000);
  c.on("close", (code) => { clearTimeout(kill); resolve({ code, stdout, stderr }); });
});

async function act(s: Serve, values: TestValues): Promise<void> {
  const host = { Host: `${HOST}:${s.head.port}` };
  const page = await http(s.head.port, "GET", LOGIN_PATH, host);
  assert.equal(page.status, 200);
  const rec = JSON.stringify({ v: 1, ...GOOD, keys: values.user.length + values.pass.length });
  const post = await http(s.head.port, "POST", LOGIN_PATH, host, new URLSearchParams({ u: values.user, p: values.pass, [RECORD_FIELD]: rec }).toString());
  assert.equal(post.status, 303);
  const cookie = String((post.headers["set-cookie"] as string[])[0]).split(";")[0];
  assert.match((await http(s.head.port, "GET", "/home", { ...host, Cookie: cookie })).body, /signed in/);
  assert.match((await http(s.head.port, "GET", SEAT_PATH, { ...host, Cookie: cookie })).body, /<p id="state">signed in/);
  assert.equal((await http(s.head.port, "GET", LOGIN_PATH, { Host: `localhost:${s.head.port}` })).status, 421);
}

test("the harness on loopback: serve prints its run and the operator's text, the act's stand-in signs in, check passes with the operator's answers, its stop ends serve, and the folder goes", { skip: process.platform !== "linux", timeout: 60_000 }, async () => {
  const tmp = tempDir("ab-sam-");
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp };
    const s = await serve(env);
    assert.equal(s.head.origin, originOf(s.head.port));
    assert.ok(s.head.folder.startsWith(tmp) && existsSync(join(s.head.folder, RUN_FILE)));
    await new Promise((r) => setTimeout(r, 100));
    const run = JSON.parse(readFileSync(join(s.head.folder, RUN_FILE), "utf8"));
    const values: TestValues = { user: run.user, pass: run.pass };
    assert.ok(s.out().includes(`Username: ${values.user}`) && s.out().includes(`Password (and the password again): ${values.pass}`), "serve prints the run's made-up values for the operator");
    await act(s, values);
    const site = JSON.parse(readFileSync(join(s.head.folder, SITE_FILE), "utf8"));
    assert.deepEqual([site.pages, site.posts.length, site.homes.length, site.seats.length, site.wrongHost], [1, 1, 1, 1, 1]);
    assert.ok(!holdsValue(readFileSync(join(s.head.folder, SITE_FILE), "latin1"), values), "site.json holds no test value");
    writeFileSync(join(s.head.folder, ANSWER_FILE), `${signedInText(s.head.origin)}\n`);
    writeFileSync(join(s.head.folder, EXIT_FILE), "0\n");
    const log = join(tmp, "service.log");
    writeFileSync(log, "service: sign-in: a log line with no value\n");
    const r = await check(env, ["--folder", s.head.folder, "--window", "yes", "--front-changed", "no", "--scan", log]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, true, JSON.stringify(j.checks));
    assert.deepEqual([j.harness, j.os, j.port, j.operator], ["sign-in-act-mac", "linux", s.head.port, { window: "yes", frontChanged: "no" }]);
    assert.ok(!holdsValue(r.stdout + r.stderr, values) && !r.stdout.includes(tmp), "check prints no test value and no path");
    assert.equal(await s.exit, 0, "the check's stop ends serve");
    assert.ok(!existsSync(s.head.folder), "the run's folder is gone");
    assert.match(s.out(), /site: POST \/login: the test username matches, the test password matches, the page's record came; signed in/);
    assert.ok(!holdsValue(s.out().split("\n").filter((l) => l.startsWith("site: ")).join("\n"), values), "the site's lines hold no test value");
  } finally { rmSync(tmp, { recursive: true, force: true }); done(tmp); }
});

test("the harness on loopback: a test value in a scanned text fails check (exit 1) and --keep leaves serve; SIGTERM ends serve and its folder goes; a folder of no run exits 2", { skip: process.platform !== "linux", timeout: 60_000 }, async () => {
  const tmp = tempDir("ab-sam-");
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp };
    const s = await serve(env);
    await new Promise((r) => setTimeout(r, 100));
    const run = JSON.parse(readFileSync(join(s.head.folder, RUN_FILE), "utf8"));
    await act(s, { user: run.user, pass: run.pass });
    writeFileSync(join(s.head.folder, ANSWER_FILE), `${signedInText(s.head.origin)}\n`);
    writeFileSync(join(s.head.folder, EXIT_FILE), "0\n");
    const leak = join(tmp, "events.jsonl");
    writeFileSync(leak, `{"ev":"sign_in","x":"${Buffer.from(run.pass).toString("base64url")}"}\n`);
    const r = await check(env, ["--folder", s.head.folder, "--window", "unsure", "--front-changed", "no", "--scan", leak, "--keep"]);
    assert.equal(r.code, 1, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.deepEqual([j.ok, j.checks.scan], [false, { ok: false, why: "a test value is in scan text 1" }]);
    assert.ok(!r.stdout.includes(run.pass), "the result names the text, never the value");
    assert.ok(existsSync(s.head.folder), "--keep: serve still runs");
    s.c.kill("SIGTERM");
    assert.equal(await s.exit, 143);
    assert.ok(!existsSync(s.head.folder), "the folder goes at SIGTERM");
    const none = await check(env, ["--folder", join(tmp, "none")]);
    assert.equal(none.code, 2);
    assert.match(none.stderr, /the folder holds no run of the harness/);
    const bad = await check(env, ["--folder", tmp, "--window", "maybe"]);
    assert.equal(bad.code, 2);
    assert.deepEqual(readdirSync(tmp).sort(), ["events.jsonl"]);
  } finally { rmSync(tmp, { recursive: true, force: true }); done(tmp); }
});
