// The pure rules of the sign-in act (contract C11, "The sign-in act"; the stored sign-ins design, sections 7.4 to 7.8;
// board ab-v16.97.4): the five forms of the password, the guard, the form rules, the open connections, the outcome, the
// window's place, the leak check and the move's payload, and the rate of the refusal ends (C12's vector). Every value
// here is a made-up TEST value.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ACT_TEXT, bodyOf, formPlan, guardDecision, holdsPassword, isCode, leaks, movePayload, openOutside, outcomeOf, outsideScreen,
  passwordForms, RefusalRate, REFUSAL_WINDOW_MS, REFUSALS_PER_MINUTE, type FieldRead, type PageRead,
} from "../src/service/signins/act-rules.ts";
import { checkPayload } from "../src/service/signin/payload.ts";

const control = JSON.parse(readFileSync(new URL("./vectors/control.json", import.meta.url), "utf8"));
const PASS = "Test-Pass word/+=ä_1";
const ORIGIN = "https://staging.example.com";
const SEND_TO = [ORIGIN, "https://auth.example.com:8443"];

test("the five forms: plain, URL-encoded (component and form body), JSON-escaped, base64 and base64url; each one is found in a longer text", () => {
  const forms = passwordForms(PASS);
  for (const f of [PASS, encodeURIComponent(PASS), new URLSearchParams({ x: PASS }).toString().slice(2), JSON.stringify(PASS).slice(1, -1),
    Buffer.from(PASS).toString("base64").replace(/=+$/, ""), Buffer.from(PASS).toString("base64url")]) {
    assert.ok(forms.includes(f), f);
    assert.ok(holdsPassword(`a=1&b=${f}&c=2`, PASS), `the form in a longer text: ${f}`);
  }
  assert.equal(new Set(forms).size, forms.length, "each form once");
  assert.deepEqual(passwordForms(""), [], "an empty value has no form");
  assert.equal(holdsPassword("nothing here", PASS), false);
  assert.equal(holdsPassword("", PASS), false);
  // A URL that Chrome percent-encoded: the decoded text holds it.
  assert.ok(holdsPassword(`https://t.example/?q=${encodeURIComponent(PASS).replace(/%2F/g, "%2f")}`, PASS));
  // A value whose base64 holds + and /: its base64url form differs, and each one is found.
  const odd = "Test>?Pass~~";
  assert.notEqual(Buffer.from(odd).toString("base64url"), Buffer.from(odd).toString("base64").replace(/=+$/, ""));
  for (const f of [Buffer.from(odd).toString("base64url"), Buffer.from(odd).toString("base64")]) assert.ok(holdsPassword(`https://t.example/i.gif?d=${f}&x=1`, odd), f);
  // A part of the value is no hit (the design's limit: the guard finds the whole value).
  assert.equal(holdsPassword(PASS.slice(0, 8), PASS), false);
});

test("the guard: a URL that holds the password fails on any origin; a body that holds it, or a body that Chrome does not give, fails off send_to; every other request continues", () => {
  for (const f of passwordForms(PASS)) {
    assert.equal(guardDecision({ url: `https://tracker.example.net/p?x=${f}` }, SEND_TO, PASS), "fail", `another origin, the URL holds the ${f} form`);
    assert.equal(guardDecision({ url: `${ORIGIN}/log?x=${f}` }, SEND_TO, PASS), "fail", `the site's own origin, the URL holds the ${f} form`);
    assert.equal(guardDecision({ url: "https://tracker.example.net/c", method: "POST", postData: `v=${f}`, hasPostData: true }, SEND_TO, PASS), "fail", `a body off send_to: ${f}`);
  }
  const b64url = Buffer.from(PASS).toString("base64url");
  assert.equal(guardDecision({ url: `https://img.example.net/i.gif?d=${b64url}` }, SEND_TO, PASS), "fail", "the base64url image URL of round 1");
  // A body that Chrome does not give: off send_to it fails; to send_to it continues.
  assert.equal(guardDecision({ url: "https://tracker.example.net/c", method: "POST", hasPostData: true }, SEND_TO, PASS), "fail");
  assert.equal(guardDecision({ url: `${ORIGIN}/login`, method: "POST", hasPostData: true }, SEND_TO, PASS), "continue");
  // The site's own sign-in POST to an origin of send_to holds the password in its body: it continues.
  assert.equal(guardDecision({ url: `${ORIGIN}/login`, method: "POST", postData: `password=${encodeURIComponent(PASS)}`, hasPostData: true }, SEND_TO, PASS), "continue");
  assert.equal(guardDecision({ url: "https://auth.example.com:8443/token", method: "POST", postData: JSON.stringify({ p: PASS }), hasPostData: true }, SEND_TO, PASS), "continue");
  // Another port or a subdomain of a send_to host is not its origin: a body there that holds it fails (rule D lets it pass by its host).
  assert.equal(guardDecision({ url: "https://auth.example.com/token", method: "POST", postData: `p=${PASS}`, hasPostData: true }, SEND_TO, PASS), "fail");
  assert.equal(guardDecision({ url: "https://x.staging.example.com/c", method: "POST", postData: `p=${PASS}`, hasPostData: true }, SEND_TO, PASS), "fail");
  // A request with no body, or a body without the value, continues everywhere.
  assert.equal(guardDecision({ url: "https://cdn.example.net/app.js" }, SEND_TO, PASS), "continue");
  assert.equal(guardDecision({ url: "https://tracker.example.net/c", method: "POST", postData: "a=1", hasPostData: true }, SEND_TO, PASS), "continue");
  // postDataEntries: the body's bytes.
  assert.equal(bodyOf({ url: "x", hasPostData: true, postDataEntries: [{ bytes: Buffer.from(`p=${PASS}`).toString("base64") }] }), `p=${PASS}`);
  assert.equal(guardDecision({ url: "https://tracker.example.net/c", hasPostData: true, postDataEntries: [{ bytes: Buffer.from(`p=${PASS}`).toString("base64") }] }, SEND_TO, PASS), "fail");
  assert.equal(bodyOf({ url: "x", hasPostData: true, postDataEntries: [{}] }), null, "an entry with no bytes: no body that Chrome gives");
});

// A page's read, as READ_PAGE gives it.
const field = (i: number, type: string, o: Partial<FieldRead> = {}): FieldRead => ({ i, type, visible: true, enabled: true, form: 0, autocomplete: "", name: "", id: "", maxLength: -1, box: { x: 10, y: 10 + 40 * i, w: 200, h: 30 }, ...o });
const page = (fields: FieldRead[], o: Partial<PageRead> = {}): PageRead => ({ href: `${ORIGIN}/login`, origin: ORIGIN, fields, forms: [{ method: "post", action: `${ORIGIN}/login` }], framePassword: false, ...o });
const REC = { origin: ORIGIN, send_to: SEND_TO };
const both = { username: true, stepDone: false };

test("form rule 1: the main frame's origin is the record's exact origin", () => {
  assert.deepEqual(formPlan(page([field(0, "text"), field(1, "password")], { origin: "https://evil.example.net", href: "https://evil.example.net/login" }), REC, both), { refused: "other_origin" });
  assert.deepEqual(formPlan(page([field(0, "text"), field(1, "password")], { origin: "https://staging.example.com:8443" }), REC, both), { refused: "other_origin" }, "another port");
  assert.deepEqual(formPlan(page([field(0, "text"), field(1, "password")], { origin: "http://staging.example.com" }), REC, both), { refused: "other_origin" }, "another scheme");
});

test("form rule 2: exactly one visible, enabled password field; none and one username field is a two-step sign-in; a hidden or disabled one does not count", () => {
  assert.deepEqual(formPlan(page([field(0, "email"), field(1, "password"), field(2, "password")]), REC, both), { refused: "password_fields" });
  assert.deepEqual(formPlan(page([field(0, "email")]), REC, both), { step: field(0, "email") });
  assert.deepEqual(formPlan(page([field(0, "email"), field(1, "text")]), REC, both), { refused: "no_form" }, "two username fields and no password field");
  assert.deepEqual(formPlan(page([]), REC, both), { refused: "no_form" });
  assert.deepEqual(formPlan(page([field(0, "email")], { framePassword: true }), REC, both), { refused: "no_form" }, "a password field in a frame: the first build reads only the main frame");
  assert.deepEqual(formPlan(page([field(0, "email")]), REC, { username: true, stepDone: true }), { refused: "no_form" }, "at most one step");
  const p = formPlan(page([field(0, "email"), field(1, "password"), field(2, "password", { visible: false }), field(3, "password", { enabled: false })]), REC, both);
  assert.ok("password" in p && p.password.i === 1, JSON.stringify(p));
});

test("form rule 3: the username field in the password field's form, before it; autocomplete username, then type email, first; none with an empty username or after the first step", () => {
  const fs = [field(0, "text", { form: null }), field(1, "text"), field(2, "email"), field(3, "text", { autocomplete: "username" }), field(4, "password"), field(5, "text")];
  let p = formPlan(page(fs), REC, both);
  assert.ok("user" in p && p.user?.i === 3, "autocomplete username first");
  p = formPlan(page(fs.filter((f) => f.i !== 3)), REC, both);
  assert.ok("user" in p && p.user?.i === 2, "then type email");
  p = formPlan(page([field(0, "text", { form: null }), field(1, "text"), field(2, "tel"), field(4, "password")]), REC, both);
  assert.ok("user" in p && p.user?.i === 2, "else the nearest one before it, in its form");
  p = formPlan(page([field(0, "text", { form: null }), field(4, "password"), field(5, "text")]), REC, both);
  assert.deepEqual(p, { refused: "no_form" }, "a field after it or outside its form is not the username field");
  p = formPlan(page([field(4, "password")]), REC, { username: false, stepDone: false });
  assert.ok("user" in p && p.user === null, "an empty username skips it");
  p = formPlan(page([field(4, "password")]), REC, { username: false, stepDone: true });
  assert.ok("user" in p && p.user === null, "after the first step");
});

test("form rule 4: a password field in a form needs the method post and an action's origin in send_to; one with no form goes on", () => {
  const fs = [field(0, "email"), field(1, "password")];
  assert.deepEqual(formPlan(page(fs, { forms: [{ method: "get", action: `${ORIGIN}/login` }] }), REC, both), { refused: "form_target" }, "a GET form gets no key");
  assert.deepEqual(formPlan(page(fs, { forms: [{ method: "post", action: "https://evil.example.net/steal" }] }), REC, both), { refused: "form_target" });
  assert.deepEqual(formPlan(page(fs, { forms: [{ method: "post", action: "https://auth.example.com/t" }] }), REC, both), { refused: "form_target" }, "the host of send_to on another port");
  assert.deepEqual(formPlan(page(fs, { forms: [{ method: "dialog", action: `${ORIGIN}/login` }] }), REC, both), { refused: "form_target" });
  const ok = formPlan(page(fs, { forms: [{ method: "POST", action: "https://auth.example.com:8443/t" }] }), REC, both);
  assert.ok("password" in ok && ok.form === 0);
  const script = formPlan(page([field(0, "email", { form: null }), field(1, "password", { form: null })], { forms: [] }), REC, both);
  assert.ok("password" in script && script.form === null && script.user?.i === 0, "a sign-in by script: the block and the guard are its checks");
});

test("form rule 6: an open WebSocket or WebTransport to a host outside send_to; the site's own and send_to's hosts pass", () => {
  assert.deepEqual(openOutside(["wss://staging.example.com/live", "wss://auth.example.com:8443/x"], SEND_TO), []);
  assert.deepEqual(openOutside(["wss://tracker.example.net/s", "wss://staging.example.com/a"], SEND_TO), ["tracker.example.net"]);
  assert.deepEqual(openOutside(["https://wt.example.net:4433/t"], SEND_TO), ["wt.example.net"]);
  assert.deepEqual(openOutside(["not a url"], SEND_TO), [""], "a URL that does not parse counts as outside");
});

test("the outcome: a host on no list (also an error page's unreachable host and about:blank), a password field, a field for a code, else signed in", () => {
  const list = ["example.com"];
  assert.equal(outcomeOf(page([], { href: `${ORIGIN}/home` }), list), "signed_in");
  assert.equal(outcomeOf(page([field(0, "password")], { href: `${ORIGIN}/login?e=1` }), list), "not_accepted");
  assert.equal(outcomeOf(page([field(0, "text", { autocomplete: "one-time-code" })], { href: `${ORIGIN}/2fa` }), list), "second_factor");
  assert.equal(outcomeOf(page([field(0, "text", { name: "otp", maxLength: 6 })], { href: `${ORIGIN}/2fa` }), list), "second_factor");
  assert.equal(outcomeOf(page([field(0, "text", { name: "promo_code", maxLength: 40 })], { href: `${ORIGIN}/home` }), list), "signed_in", "a code field longer than 10 is no second factor");
  assert.equal(outcomeOf(page([], { href: "https://elsewhere.example.net/" }), list), "off_list");
  assert.equal(outcomeOf(page([], { href: "about:blank" }), list), "off_list");
  assert.equal(outcomeOf(page([], { href: "chrome-error://chromewebdata/" }), list), "off_list");
  assert.ok(isCode(field(0, "number", { id: "mfa-code", maxLength: 6 })));
  assert.ok(!isCode(field(0, "number", { id: "mfa-code", maxLength: 6, visible: false })));
});

test("the window's place: outside the screen only when no pixel of it is on the screen", () => {
  const s = { width: 1280, height: 800 };
  assert.equal(outsideScreen({ left: 1480, top: 0, width: 1280, height: 800 }, s), true);
  assert.equal(outsideScreen({ left: 1280, top: 0, width: 1280, height: 800 }, s), true);
  assert.equal(outsideScreen({ left: 1279, top: 0, width: 1280, height: 800 }, s), false, "one column on the screen");
  assert.equal(outsideScreen({ left: 0, top: 0, width: 1280, height: 800 }, s), false);
  assert.equal(outsideScreen({ left: -1280, top: 0, width: 1280, height: 800 }, s), true);
  assert.equal(outsideScreen({ left: 0, top: 900, width: 1280, height: 800 }, s), true);
  assert.equal(outsideScreen({ left: "1480", top: 0, width: 1280, height: 800 }, s), false, "bounds that are not numbers are no proof");
  assert.equal(outsideScreen({}, s), false);
});

test("the leak check: a cookie value, a localStorage key or value that holds the password in one of its forms; else none", () => {
  const ck = (value: string) => ({ name: "sid", value, domain: "staging.example.com", hostOnly: true, path: "/", secure: true, httpOnly: true, sameSite: "lax", session: true });
  assert.equal(leaks([ck("test-session-1")], { token: "test-token-2" }, PASS), false);
  assert.equal(leaks([ck(Buffer.from(PASS).toString("base64"))], {}, PASS), true);
  assert.equal(leaks([], { remember: JSON.stringify({ p: PASS }) }, PASS), true);
  assert.equal(leaks([], { [encodeURIComponent(PASS)]: "1" }, PASS), true);
});

test("the move's payload is C2's: the credential's host, its origin, the origin with the path /, the cookies, localStorage; it passes stage 1c's check", () => {
  const cookies = control.signInScan ? [{ name: "test_session", value: "test-session-value-1", domain: "staging.example.com", hostOnly: true, path: "/", secure: true, httpOnly: true, sameSite: "lax", session: true },
    { name: "test_pref", value: "test-pref-value-2", domain: ".staging.example.com", hostOnly: false, path: "/", secure: true, httpOnly: false, sameSite: "no_restriction", session: false, expirationDate: 1893456000 }] : [];
  const p = movePayload(ORIGIN, cookies, { token: "test-local-token" });
  assert.deepEqual(p, { v: 1, domain: "staging.example.com", origin: ORIGIN, url: `${ORIGIN}/`, cookies, storage: { local: { token: "test-local-token" }, session: {}, idb: [], caches: [] } });
  const { state, dropped } = checkPayload(p, ["box.example.org"], ["aw_session"]);
  assert.equal(dropped, 0);
  assert.equal(state.domain, "staging.example.com");
  // The box's own cookie never moves (stage 1c's rule).
  const boxed = checkPayload(movePayload(ORIGIN, [...cookies, { ...cookies[0], name: "agentwatch_x" }], {}), ["box.example.org"], []);
  assert.equal(boxed.dropped, 1);
});

test("C11's texts of the act: one text for each result, no value of a page, no stop or start (I2)", () => {
  const texts = Object.values(ACT_TEXT);
  assert.equal(new Set(texts).size, texts.length);
  for (const t of texts) assert.doesNotMatch(t, /\b(stop|stops|stopped|start|starts|restart)\b/i, t);
});

test("the rate of the refusal ends (C12, vector refusalRate): at most 10 a scope in any 60 s; then one a minute with dropped; each scope on its own", () => {
  const v = control.refusalRate;
  assert.ok(v, "the vector");
  assert.equal(v.limit, REFUSALS_PER_MINUTE);
  assert.equal(v.window_ms, REFUSAL_WINDOW_MS);
  const rate = new RefusalRate();
  for (const step of v.steps) {
    const r = rate.take(step.scope, step.at_ms);
    assert.deepEqual({ send: r.send, dropped: r.dropped }, { send: step.send, dropped: step.dropped ?? 0 }, `${step.scope} at ${step.at_ms} ms`);
  }
});
