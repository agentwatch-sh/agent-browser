// Board ab-v16.97.17: the Mac live check of the stored sign-ins (test/live/sign-in-act-mac/).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { ACT_TEXT, signedInText } from "../src/service/signins/act-rules.ts";
import { tempDir, done } from "./temp-dirs.ts";
import {
  ACT_MS_MIN, ANSWER_FILE, CHECK_NAMES, CREDENTIAL_NAME, DEFAULT_PORT, EXIT_FILE, HOST, LOGIN_PATH, RECORD_FIELD, RECORDER_JS, RUN_FILE, SEAT_PATH, SESSION_COOKIE,
  SITE_FILE, STOP_HEADER, STOP_PATH,
  answerCheck, applyEvent, checkResult, eventLine, frontCheck, holdsValue, isAscii, loginPage, namesOrigin, newSiteState, originOf, pageCheck, parseArgs, parseRecord, postCheck,
  resultOf, scanCheck, scanFrom, seatCheck, setupText, siteAnswer, testValues, valueForms,
  type Check, type PageRecord, type Result, type ScanText, type SiteState, type TestValues,
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
  assert.ok(holdsValue(`100% done; u=${encodeURIComponent(V.user).replace(/-/g, "%2D")}; 5%`, V), "a stray % does not stop the decode");
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
  assert.deepEqual(answerCheck(`Not signed in: ${ACT_TEXT.no_such_name.replace("<name>", CREDENTIAL_NAME)}`, 1, ORIGIN), { ok: false, why: "a refusal: no_such_name" });
  assert.deepEqual(answerCheck(`Not signed in: ${ACT_TEXT.not_allowed.replace("<host>", HOST)}`, 1, ORIGIN), { ok: false, why: "a refusal: not_allowed" });
  assert.deepEqual(answerCheck("Not signed in: a text of a later build", 1, ORIGIN), { ok: false, why: "a refusal of another text" });
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

test("the post and the seat's tab: the last post holds both test values; the seat page after the sign-in loads signed in", () => {
  assert.deepEqual(postCheck(signed()), { ok: true, why: null });
  assert.equal(postCheck(newSiteState()).ok, null);
  assert.equal(postCheck(signed({ posts: [{ at: 1, user: false, pass: false, record: null, session: false }] })).why, "the post does not hold the test username; the post does not hold the test password");
  assert.deepEqual(seatCheck(signed()), { ok: true, why: null });
  assert.equal(seatCheck(signed({ seats: [{ at: 50, signedIn: false }] })).why, "not measured: the seat did not open the seat page after the sign-in");
  assert.equal(seatCheck(signed({ seats: [{ at: 300, signedIn: false }] })).why, "the seat page did not load signed in");
  assert.equal(seatCheck(newSiteState()).ok, null);
});

const ANS: ScanText = { kind: "the answer", text: signedInText(ORIGIN) };
const ACT_LINE = `service: sign-in: act 0123456789abcdef: user live, scope s, repo none, credential c-0a1b2c3d ${CREDENTIAL_NAME}, origin ${ORIGIN}, result signed_in, 4100 ms, 0 blocked, 0 guarded`;
const LOGS = (service: string | null, signIn: string | null, why?: string): ScanText[] => [ANS, { kind: "the service log", text: service, why }, { kind: "the sign-in log", text: signIn, why }];

test("the scan: a test value in the answer or in a log fails; both logs must be read and name this run's act, else not measured", () => {
  const ring = JSON.stringify({ acts: [{ name: CREDENTIAL_NAME, origin: ORIGIN, result: "signed_in" }] });
  assert.deepEqual(scanCheck(LOGS(ACT_LINE, ring), V, ORIGIN), { ok: true, why: null });
  assert.equal(scanCheck(LOGS(`${ACT_LINE}\nx ${Buffer.from(V.pass).toString("base64")} x`, ring), V, ORIGIN).why, "a test value is in the service log");
  assert.equal(scanCheck(LOGS(ACT_LINE, `${ring} ${V.user}`), V, ORIGIN).why, "a test value is in the sign-in log");
  assert.equal(scanCheck([{ kind: "the answer", text: V.user }, ...LOGS(ACT_LINE, ring).slice(1)], V, ORIGIN).why, "a test value is in the answer");
  assert.equal(scanCheck(LOGS(null, null, "ENOENT"), V, ORIGIN).why, "not measured: the service log (ENOENT), the sign-in log (ENOENT)");
  assert.equal(scanCheck([ANS, { kind: "the service log", text: ACT_LINE }], V, ORIGIN).why, "not measured: the sign-in log: not given");
  assert.equal(scanCheck([ANS], V, ORIGIN).why, "not measured: the service log, the sign-in log: not given");
  assert.equal(scanCheck(LOGS("", ring), V, ORIGIN).why, "not measured: the service log does not name this run's origin");
  assert.equal(scanCheck(LOGS(ACT_LINE.replace(`${CREDENTIAL_NAME}, origin ${ORIGIN}`, "c-1, origin http://login.localhost:1"), "{}"), V, ORIGIN).why,
    "not measured: the service log, the sign-in log does not name this run's origin");
  const earlier = JSON.stringify({ acts: [{ name: CREDENTIAL_NAME, origin: originOf(RUN.port + 1) }] });
  assert.equal(scanCheck(LOGS(ACT_LINE, earlier), V, ORIGIN).why, "not measured: the sign-in log does not name this run's origin", "an earlier run's log with the same credential name does not pass");
  assert.equal(scanCheck(LOGS(`origin ${ORIGIN}`, `origin ${ORIGIN}`), V, ORIGIN).ok, true);
  assert.equal(scanCheck(LOGS(ACT_LINE, ring), { user: "", pass: "" }, ORIGIN).why, "the scan's twin finds no planted value");
});

test("namesOrigin: the origin ends at a non-digit, so an earlier run's longer port does not pass", () => {
  assert.equal(namesOrigin(`a ${originOf(1234)}5 b`, originOf(1234)), false);
  assert.equal(namesOrigin(`a ${originOf(1234)}5 b ${originOf(1234)}`, originOf(1234)), true);
  assert.equal(namesOrigin(`${originOf(1234)}`, originOf(1234)), true);
  assert.equal(namesOrigin("", originOf(1234)), false);
});

test("scanFrom: the part after serve's start only for the same file that only grew; a truncation that regrew, a rotation or a shorter file reads whole", () => {
  const mark = { ino: "7", size: 30, headLen: 30, head: "h1" };
  const at = (o: Partial<{ ino: string; size: number; head: string | null }>) => scanFrom(mark, { ino: o.ino ?? "7", size: o.size ?? 90, headOf: () => (o.head === undefined ? "h1" : o.head) });
  assert.equal(at({}), 30);
  assert.equal(at({ head: "h2" }), 0, "the same inode with other first bytes: a copytruncate");
  assert.equal(at({ head: null }), 0);
  assert.equal(at({ ino: "8" }), 0);
  assert.equal(at({ size: 29 }), 0);
  assert.equal(scanFrom({ ino: null, size: 0, headLen: 0, head: null }, { ino: "7", size: 5, headOf: () => null }), 0, "no file at the start");
  assert.equal(scanFrom({ ino: "7", size: 0, headLen: 0, head: null }, { ino: "7", size: 5, headOf: () => null }), 0, "an empty file at the start");
});

test("the test values must be ASCII: the scan fails on another value", () => {
  assert.ok(isAscii(V.user + V.pass));
  assert.equal(isAscii("caf\u00e9"), false);
  const bad = { user: "test-user-caf\u00e9", pass: V.pass };
  assert.deepEqual(scanCheck(LOGS(ACT_LINE, "{}"), bad, ORIGIN), { ok: false, why: "a test value is not ASCII" });
});

test("the operator's front answer: no holds, yes fails, unsure or no answer is not measured", () => {
  assert.deepEqual([frontCheck("no").ok, frontCheck("yes").ok, frontCheck("unsure").ok, frontCheck(null).ok], [true, false, null, null]);
});

const RING = JSON.stringify({ acts: [{ name: CREDENTIAL_NAME, origin: ORIGIN, result: "signed_in" }] });

test("the result: ok only when every check holds; the operator's two answers; no test value, no path, no address", () => {
  const base = { os: "darwin", port: RUN.port, values: V, site: signed(), answer: `${signedInText(ORIGIN)}\n`, exit: 0, scans: LOGS(ACT_LINE, RING).slice(1), window: "yes" as const, frontChanged: "no" as const };
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
    assert.equal(checkResult(x, V), null, `${name}: its why passes the result's check`);
  }
  assert.equal(checkResult({ ...r, os: V.pass }, V), "the result holds a test value");
  assert.equal(checkResult({ ...r, os: "a/b" }, V), "the result holds a path or an address");
});

test("every why of every check passes the result's check (the review's I1: the seat check's why held a path)", () => {
  const rec = (o: Partial<PageRecord>) => ({ ...GOOD, ...o });
  const checks: Check[] = [
    answerCheck(`${signedInText(ORIGIN)}\n`, 0, ORIGIN), answerCheck(signedInText(originOf(1)), 0, ORIGIN), answerCheck(null, 0, ORIGIN), answerCheck("", 3, ORIGIN),
    answerCheck("Not signed in: x", 1, ORIGIN), ...Object.values(ACT_TEXT).map((t) => answerCheck(`Not signed in: ${t.replace("<name>", CREDENTIAL_NAME).replace("<host>", HOST)}`, 1, ORIGIN)),
    pageCheck(null, V), pageCheck(rec({ vis: null }), V), pageCheck(rec({ actMs: null }), V), pageCheck(rec({ vis: "other", keysHidden: 2, untrusted: 1, keys: 3, actMs: 100 }), V),
    pageCheck(rec({ actRaf: 1, actTicks: 1 }), V), pageCheck(GOOD, V),
    postCheck(newSiteState()), postCheck(signed()), postCheck(signed({ posts: [{ at: 1, user: false, pass: false, record: null, session: false }] })),
    seatCheck(newSiteState()), seatCheck(signed()), seatCheck(signed({ seats: [] })), seatCheck(signed({ seats: [{ at: 300, signedIn: false }] })),
    scanCheck(LOGS(ACT_LINE, RING), V, ORIGIN), scanCheck(LOGS(`${ACT_LINE} ${V.pass}`, `${RING} ${V.user}`), V, ORIGIN), scanCheck([ANS], V, ORIGIN),
    scanCheck(LOGS(null, null, "EACCES"), V, ORIGIN), scanCheck(LOGS("", ""), V, ORIGIN), scanCheck(LOGS(ACT_LINE, RING), { user: "", pass: "" }, ORIGIN),
    frontCheck("no"), frontCheck("yes"), frontCheck("unsure"), frontCheck(null),
  ];
  assert.ok(checks.filter((c) => c.ok === false).length >= 8 && checks.filter((c) => c.ok === null).length >= 8);
  for (const c of checks) {
    const r = resultOf({ os: "darwin", port: RUN.port, values: V, site: signed(), answer: null, exit: null, scans: [], window: null, frontChanged: null });
    const one: Result = { ...r, checks: { ...r.checks, answer: c } };
    assert.equal(checkResult(one, V), null, String(c.why));
  }
});

test("the arguments: serve with both logs, a port and minutes; check with its folder, the two answers and keep", () => {
  const logs = ["--service-log", "s.log", "--sign-in-log", "i.json"];
  assert.deepEqual(parseArgs(["serve", ...logs]), { cmd: "serve", port: DEFAULT_PORT, minutes: 30, serviceLog: "s.log", signInLog: "i.json" });
  assert.deepEqual(parseArgs(["serve", "--port", "0", "--minutes", "5", ...logs]), { cmd: "serve", port: 0, minutes: 5, serviceLog: "s.log", signInLog: "i.json" });
  assert.deepEqual(parseArgs(["check", "--folder", "f", "--window", "yes", "--front-changed", "no", "--keep"]), { cmd: "check", folder: "f", window: "yes", frontChanged: "no", keep: true });
  assert.deepEqual(parseArgs(["check", "--folder", "f"]), { cmd: "check", folder: "f", window: null, frontChanged: null, keep: false });
  for (const bad of [[], ["run"], ["serve"], ["serve", "--service-log", "s.log"], ["serve", "--sign-in-log", "i.json"], ["serve", ...logs, "--service-log", "t.log"], ["serve", ...logs, "--port", "70000"],
    ["serve", ...logs, "--minutes", "0"], ["serve", ...logs, "--minutes", "121"], ["serve", ...logs, "--scan", "a"], ["serve", ...logs, "--port"], ["check"], ["check", "--folder", "f", "--scan", "a"],
    ["check", "--folder", "f", "--window", "maybe"], ["check", "--folder", "f", "--folder", "g"], ["check", "--folder", "--keep"]]) {
    assert.ok("error" in parseArgs(bad), bad.join(" "));
  }
});

test("the operator's text: the list entry, the credential's fields with the run's made-up values, the seat's command and the check", () => {
  const t = setupText({ port: RUN.port, folder: "F", values: V, until: "T", harness: "H" });
  for (const s of [`the scope's list entry: ${HOST}`, `Name: ${CREDENTIAL_NAME}`, `Origin of the site: ${ORIGIN}`, `Sign-in path: ${LOGIN_PATH}`, `Username: ${V.user}`, `Password (and the password again): ${V.pass}`,
    "made-up test values", `agentwatch browser sign-in ${CREDENTIAL_NAME} > F/${ANSWER_FILE} 2>&1; echo $? > F/${EXIT_FILE}`, `${ORIGIN}${SEAT_PATH}`, "node H check --folder F --window <yes|no|unsure> --front-changed <yes|no|unsure>\n"]) assert.ok(t.includes(s), s);
});

// ------------------------------------------------------------------ the harness on Linux (loopback)

type Serve = { c: ChildProcess; out: () => string; head: { folder: string; port: number; origin: string; pid: number }; exit: Promise<number | null> };
function serve(env: NodeJS.ProcessEnv, logs: string[]): Promise<Serve> {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [HARNESS, "serve", "--port", "0", "--minutes", "1", ...logs], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", head: Serve["head"] | null = null;
    const kill = setTimeout(() => c.kill("SIGKILL"), 50_000);
    const exit = new Promise<number | null>((r) => c.on("close", (code) => { clearTimeout(kill); r(code); }));
    c.stdout!.on("data", (d) => {
      out += d;
      if (head || !out.includes(" check --folder ")) return;
      try { head = JSON.parse(out.split("\n")[0]); resolve({ c, out: () => out, head: head!, exit }); } catch (e) { reject(e); }
    });
    c.stderr!.on("data", (d) => { err += d; });
    c.on("close", (code) => { if (!head) reject(new Error(`serve ended (${code}): ${err}`)); });
  });
}
const stopServe = (s: Serve | null) => { if (s && s.c.exitCode === null && s.c.signalCode === null) s.c.kill("SIGKILL"); };
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
const actLine = (origin: string) => `service: sign-in: act 0123456789abcdef: user live, scope s, repo none, credential c-0a1b2c3d ${CREDENTIAL_NAME}, origin ${origin}, result signed_in, 4100 ms, 0 blocked, 0 guarded\n`;

test("the harness on loopback: serve prints its run and the operator's text, the act's stand-in signs in, check passes with the operator's answers and the part of the service log after serve's start, its stop ends serve, and the folder goes", { skip: process.platform !== "linux", timeout: 60_000 }, async () => {
  const tmp = tempDir("ab-sam-");
  let s: Serve | null = null;
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp };
    const serviceLog = join(tmp, "agent-browser.log"), signInLog = join(tmp, "sign-in-log.json");
    // An older act of the same name, before serve: check reads only the part after serve's start.
    writeFileSync(serviceLog, `${actLine("http://login.localhost:1")}service: an older line 100% done\n`);
    s = await serve(env, ["--service-log", serviceLog, "--sign-in-log", signInLog]);
    assert.equal(s.head.origin, originOf(s.head.port));
    assert.ok(s.head.folder.startsWith(tmp) && existsSync(join(s.head.folder, RUN_FILE)));
    const run = JSON.parse(readFileSync(join(s.head.folder, RUN_FILE), "utf8"));
    const values: TestValues = { user: run.user, pass: run.pass };
    assert.ok(s.out().includes(`Username: ${values.user}`) && s.out().includes(`Password (and the password again): ${values.pass}`), "serve prints the run's made-up values for the operator");
    await act(s, values);
    const site = JSON.parse(readFileSync(join(s.head.folder, SITE_FILE), "utf8"));
    assert.deepEqual([site.pages, site.posts.length, site.homes.length, site.seats.length, site.wrongHost], [1, 1, 1, 1, 1], "site.json is written before each answer");
    assert.ok(!holdsValue(readFileSync(join(s.head.folder, SITE_FILE), "latin1"), values), "site.json holds no test value");
    writeFileSync(join(s.head.folder, ANSWER_FILE), `${signedInText(s.head.origin)}\n`);
    writeFileSync(join(s.head.folder, EXIT_FILE), "0\n");
    const kept = await check(env, ["--folder", s.head.folder, "--window", "yes", "--front-changed", "no", "--keep"]);
    assert.equal(kept.code, 1);
    assert.deepEqual(JSON.parse(kept.stdout).checks.scan, { ok: null, why: "not measured: the sign-in log (ENOENT)" });
    writeFileSync(signInLog, JSON.stringify({ acts: [{ name: CREDENTIAL_NAME, origin: s.head.origin, result: "signed_in" }] }));
    const old = await check(env, ["--folder", s.head.folder, "--window", "yes", "--front-changed", "no", "--keep"]);
    assert.deepEqual(JSON.parse(old.stdout).checks.scan, { ok: null, why: "not measured: the service log does not name this run's origin" }, "only the part after serve's start");
    appendFileSync(serviceLog, actLine(s.head.origin));
    const r = await check(env, ["--folder", s.head.folder, "--window", "yes", "--front-changed", "no"]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, true, JSON.stringify(j.checks));
    assert.deepEqual([j.harness, j.os, j.port, j.operator], ["sign-in-act-mac", "linux", s.head.port, { window: "yes", frontChanged: "no" }]);
    assert.ok(!holdsValue(r.stdout + r.stderr, values) && !r.stdout.includes(tmp), "check prints no test value and no path");
    assert.equal(await s.exit, 0, "the check's stop ends serve");
    assert.ok(!existsSync(s.head.folder), "the run's folder is gone");
    assert.match(s.out(), /site: POST \/login: the test username matches, the test password matches, the page's record came; signed in/);
    assert.ok(!holdsValue(s.out().split("\n").filter((l) => l.startsWith("site: ")).join("\n"), values), "the site's lines hold no test value");
  } finally { stopServe(s); rmSync(tmp, { recursive: true, force: true }); done(tmp); }
});

test("the harness on loopback: a test value in a log fails check (exit 1), a rotated service log is read whole, --keep leaves serve; SIGTERM ends serve and its folder goes; a damaged folder or a folder of no run exits 2 with a fixed text", { skip: process.platform !== "linux", timeout: 60_000 }, async () => {
  const tmp = tempDir("ab-sam-");
  let s: Serve | null = null;
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp };
    const serviceLog = join(tmp, "agent-browser.log"), signInLog = join(tmp, "sign-in-log.json");
    writeFileSync(serviceLog, "service: an older line\n");
    s = await serve(env, ["--service-log", serviceLog, "--sign-in-log", signInLog]);
    const run = JSON.parse(readFileSync(join(s.head.folder, RUN_FILE), "utf8"));
    await act(s, { user: run.user, pass: run.pass });
    writeFileSync(join(s.head.folder, ANSWER_FILE), `${signedInText(s.head.origin)}\n`);
    writeFileSync(join(s.head.folder, EXIT_FILE), "0\n");
    writeFileSync(signInLog, JSON.stringify({ acts: [{ name: CREDENTIAL_NAME, origin: s.head.origin }] }));
    // A copytruncate: the same file, cut to zero, regrown past its size at serve's start, with this run's origin in the part that the old size would skip.
    writeFileSync(serviceLog, `origin ${s.head.origin}\n${"x".repeat(80)}\n`);
    const cut = await check(env, ["--folder", s.head.folder, "--window", "unsure", "--front-changed", "no", "--keep"]);
    assert.deepEqual(JSON.parse(cut.stdout).checks.scan, { ok: true, why: null }, "a regrown copytruncate is read whole");
    writeFileSync(signInLog, JSON.stringify({ acts: [{ name: CREDENTIAL_NAME, origin: s.head.origin, x: Buffer.from(run.pass).toString("base64url") }] }));
    // A rotation: a new file at the same path.
    writeFileSync(join(tmp, "rotated.log"), actLine(s.head.origin).slice(0, 10));
    renameSync(join(tmp, "rotated.log"), serviceLog);
    appendFileSync(serviceLog, actLine(s.head.origin).slice(10));
    const r = await check(env, ["--folder", s.head.folder, "--window", "unsure", "--front-changed", "no", "--keep"]);
    assert.equal(r.code, 1, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.deepEqual([j.ok, j.checks.scan], [false, { ok: false, why: "a test value is in the sign-in log" }]);
    assert.ok(!r.stdout.includes(run.pass), "the result names the text, never the value");
    writeFileSync(signInLog, JSON.stringify({ acts: [{ name: CREDENTIAL_NAME, origin: s.head.origin }] }));
    const rotated = await check(env, ["--folder", s.head.folder, "--window", "unsure", "--front-changed", "no", "--keep"]);
    assert.deepEqual(JSON.parse(rotated.stdout).checks.scan, { ok: true, why: null }, "the rotated log is read whole");
    assert.ok(existsSync(s.head.folder), "--keep: serve still runs");
    const runText = readFileSync(join(s.head.folder, RUN_FILE), "utf8");
    writeFileSync(join(s.head.folder, RUN_FILE), JSON.stringify({ ...JSON.parse(runText), user: "test-user-caf\u00e9" }));
    const nonAscii = await check(env, ["--folder", s.head.folder]);
    assert.deepEqual([nonAscii.code, nonAscii.stdout], [2, ""], "a test value that is not ASCII: no run of the harness");
    writeFileSync(join(s.head.folder, RUN_FILE), runText.slice(0, -3));
    const damaged = await check(env, ["--folder", s.head.folder]);
    assert.deepEqual([damaged.code, damaged.stdout, damaged.stderr], [2, "", "sign-in-act-mac: the folder holds no run of the harness\n"], "a fixed text: never a part of run.json");
    s.c.kill("SIGTERM");
    assert.equal(await s.exit, 143);
    assert.ok(!existsSync(s.head.folder), "the folder goes at SIGTERM");
    const none = await check(env, ["--folder", join(tmp, "none")]);
    assert.deepEqual([none.code, none.stderr], [2, "sign-in-act-mac: the folder holds no run of the harness\n"]);
    const bad = await check(env, ["--folder", tmp, "--window", "maybe"]);
    assert.equal(bad.code, 2);
    assert.deepEqual(readdirSync(tmp).sort(), ["agent-browser.log", "sign-in-log.json"]);
  } finally { stopServe(s); rmSync(tmp, { recursive: true, force: true }); done(tmp); }
});
