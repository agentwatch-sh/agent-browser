// The sign-in act's flow (contract C11, "The sign-in act"; C12's `sign_in` event; the stored sign-ins design, section 7;
// board ab-v16.97.4) with fakes of the model's act port, the receiver, the X screen, the store and stage 1c's move
// (test/act-fakes.ts): the checks in C11's order with their texts, the act window and its hiding, the window's place
// before the first key, the form rules, the act's rules and their confirmation before the first key, the guard, the
// type watch, the open connection, the fill with the person's input, the outcome, the clean end's order, the leak check
// and the move, the events, the rate of the refusal ends, and no value in an answer, an event or a log line. Every value
// is a made-up TEST value.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ActRefusal } from "../src/service/signins/act.ts";
import { ACT_TEXT, passwordForms } from "../src/service/signins/act-rules.ts";
import { ActWorld, CANARIES, field, homePage, loginPage, ORIGIN, PASS_INSERT, PASS_KEYS, USER } from "./act-fakes.ts";
import { until } from "./fake-bridge.ts";

const LOCAL = { scope: "web-1", admission: "local" as const };
const refusal = (text: string) => (e: unknown) => e instanceof ActRefusal && e.message === `Not signed in: ${text}`;
/** No answer, event or log line holds a canary in any of its five forms (the scan's twin is the planted case below). */
function noCanary(w: ActWorld, extra: unknown[] = []): void {
  const texts = [...w.logs, ...w.events.map((e) => JSON.stringify(e)), ...extra.map((x) => JSON.stringify(x))];
  for (const c of CANARIES) for (const f of passwordForms(c)) for (const t of texts) assert.ok(!t.includes(f), `no canary in: ${t.slice(0, 120)}`);
}
const ends = (w: ActWorld) => w.events.filter((e) => e.phase === "end");

test("the scan of the act's texts finds a planted canary (the twin of each no-canary check)", () => {
  const w = new ActWorld();
  w.logs.push(`a line with ${Buffer.from(PASS_INSERT).toString("base64url")}`);
  assert.throws(() => noCanary(w));
});

test("a sign-in: the act window, its hidden tab, the place outside the screen, the form, the rules before the first key, the fill under the input lock, the submit, signed in, the clean end in its order, the move, the events and the log", async () => {
  const w = new ActWorld();
  const a = await w.act().signIn(LOCAL, { name: "staging" });
  assert.deepEqual(a, { signedIn: true, name: "staging", origin: ORIGIN });
  // The act window: incognito, the mark act, the caller's scope, no focus; its tab hidden from every client.
  const create = w.log.find((r) => r.what === "windows.create")!;
  assert.deepEqual(create.detail, [{ url: "about:blank", focused: false, incognito: true }, "web-1", "act"]);
  assert.ok(w.hidden.has(31));
  // The order (C11): the window, its place, the page, the form, the rules, the guard, the watch, then the keys.
  const at = (what: string) => w.first(what);
  for (const [x, y] of [["windows.create", "attach"], ["attach", "mark"], ["mark", "moveOff"], ["moveOff", "windows.get"], ["windows.get", "navigate"], ["navigate", "read"],
    ["read", "act_rules"], ["act_rules", "fetchOn"], ["fetchOn", "watch"], ["watch", "lock"], ["lock", "submit"], ["submit", "empty"], ["empty", "act_cookies"],
    ["act_cookies", "move"], ["move", "resetHistory"], ["resetHistory", "fetchOff"], ["fetchOff", "act_end"]] as const) {
    assert.ok(at(x) >= 0 && at(x) < at(y), `${x} before ${y}`);
  }
  for (const k of w.keys()) assert.ok(k.rules && k.outside && k.lock, "each key after the rules' confirmation and the place outside the screen, under the input lock");
  assert.equal(w.log.filter((r) => r.what === "act_end").length, 1, "act_end once, last");
  assert.ok(w.waits.length > 10 && w.waits.every((x) => x === 30_000), "each command of the act's own session waits at most 30 s (C10's wait), not the bridge's 600 s");
  assert.deepEqual(w.log.find((r) => r.what === "act_rules")!.detail, { tab: 31, origin: ORIGIN, send_to: [ORIGIN] });
  // The values reached only the act tab's Input calls: the username into its field, the password into its field.
  assert.equal(w.typed.size, 0, "the clean end emptied the inputs");
  // The move: C2's payload of the host's cookies and the origin's localStorage.
  assert.deepEqual(w.moved, [{ v: 1, domain: "login.localhost", origin: ORIGIN, url: `${ORIGIN}/`, cookies: w.cookies, storage: { local: { token: "test-local-token" }, session: {}, idb: [], caches: [] } }]);
  // The store: one act started and ended signed in; the buffers of the values are zeros.
  assert.deepEqual(w.store.started, ["c-0000000a"]);
  assert.deepEqual(w.store.ended, [["c-0000000a", "signed_in"]]);
  for (const b of w.store.zeroed) assert.ok(b.every((x) => x === 0), "the buffers are zeros");
  // The events: a start and an end with the same act id, counts, and no host.
  assert.deepEqual(w.events.map((e) => e.phase), ["start", "end"]);
  const [s, e] = w.events;
  assert.equal(s.act, e.act);
  assert.match(s.act, /^[0-9a-f]{16}$/);
  assert.deepEqual(Object.keys(s).sort(), ["act", "at", "ev", "id", "name", "origin", "phase", "repo", "scope", "t"]);
  assert.deepEqual({ result: e.result, id: e.id, name: e.name, origin: e.origin, repo: e.repo, scope: e.scope, blocked: e.blocked, guarded: e.guarded, stopped_now: e.stopped_now },
    { result: "signed_in", id: "c-0000000a", name: "staging", origin: ORIGIN, repo: "owner/repo", scope: "web-1", blocked: 0, guarded: 0, stopped_now: false });
  assert.equal(w.logs.filter((l) => l.startsWith("sign-in: act ")).length, 1, "one log line for the request");
  assert.match(w.logs.find((l) => l.startsWith("sign-in: act "))!, /scope web-1, repo owner\/repo, credential c-0000000a staging, origin http:\/\/login\.localhost:8080, result signed_in, \d+ ms, 0 blocked, 0 guarded/);
  noCanary(w, [a]);
});

test("the fill types the username and the password into their own fields: the generator's keys when each character has a US key, else Input.insertText", async () => {
  const keys = new ActWorld({ password: PASS_KEYS });
  const typed: string[] = [];
  keys.onInput = (m, p) => { if (m === "Input.dispatchKeyEvent" && p.type === "keyDown" && typeof p.text === "string" && keys.focused === 1) typed.push(p.text); };
  await keys.act().signIn(LOCAL, { name: "staging" });
  assert.equal(typed.join(""), PASS_KEYS, "the password's keys, one by one");
  assert.equal(keys.log.filter((r) => r.what === "Input.insertText").length, 1, "the username has a character with no US key (ü): one Input.insertText");
  const inserted = new ActWorld({ password: PASS_INSERT, username: "plainuser" });
  const ins: string[] = [];
  inserted.onInput = (m, p) => { if (m === "Input.insertText") ins.push(p.text); };
  await inserted.act().signIn(LOCAL, { name: "staging" });
  assert.deepEqual(ins, [PASS_INSERT], "ä has no US key: the password goes as one Input.insertText; the username as keys");
});

test("board ab-t30.19: the act never uses the clipboard (C11, the paste): the model's act port has no clipboard, and a long value (its typing plan above 10 s) goes as one Input.insertText, with no Control+V", async () => {
  const { Model } = await import("../src/relay/model.ts");
  const { Bridge } = await import("../src/relay/bridge.ts");
  const used: string[] = [];
  const model = new Model(new Bridge(() => {}), () => {}, { stage: true, clipboard: { hold: async () => { used.push("hold"); return true; }, clear: () => { used.push("clear"); } } });
  const port = model.actPort() as Record<string, unknown>;
  assert.ok(!Object.keys(port).some((k) => /clip|paste/i.test(k)), `the port's members: ${Object.keys(port).join(", ")}`);
  const LONG_PASS = "Test-Pass-Word-".repeat(16);
  const w = new ActWorld({ password: LONG_PASS, username: "plainuser" });
  const ins: string[] = [], chords: unknown[] = [];
  w.onInput = (m, p) => { if (m === "Input.insertText") ins.push(p.text); if (m === "Input.dispatchKeyEvent" && (p.modifiers ?? 0) & 2) chords.push(p); };
  await w.act().signIn(LOCAL, { name: "staging" });
  assert.deepEqual(ins, [LONG_PASS], "the long password as one Input.insertText");
  assert.deepEqual(chords, [], "no key with Control (no Control+V)");
  assert.deepEqual(used, [], "the stage's clipboard got no call");
});

test("check 1: a remote admission, then the readiness; the refusal names no credential, opens no window, and sends one end with no start", async () => {
  const w = new ActWorld();
  await assert.rejects(w.act().signIn({ scope: "web-1", admission: "remote" }, { name: "staging" }), refusal(ACT_TEXT.remote));
  w.notReady = "The agent browser is not ready: its extension is not connected.";
  await assert.rejects(w.act().signIn(LOCAL, { name: "staging" }), refusal(w.notReady));
  assert.equal(w.first("windows.create"), -1);
  assert.deepEqual(ends(w).map((e) => [e.result, e.id, e.name, e.origin]), [["remote", null, null, null], ["not_ready", null, null, null]]);
  assert.ok(w.events.every((e) => e.phase === "end"));
  assert.ok(w.logs.every((l) => l.includes("no credential")));
  assert.deepEqual(w.store.started, []);
  // AgentBrowser.signIns refuses only by check 1.
  assert.throws(() => w.act().signIns({ scope: "web-1", admission: "remote" }), refusal(ACT_TEXT.remote));
});

test("check 2: one text for no such name, a name whose host the scope's list does not cover, and an offer that waits; <name> as the scope pattern, JSON, or null", async () => {
  const w = new ActWorld();
  w.store.records.push({ v: 1, id: "c-0000000b", gen: 1, name: "offered", origin: ORIGIN, path: "/login", send_to: [ORIGIN], repos: null, by: "offer", approved: false });
  w.store.records.push({ v: 1, id: "c-0000000c", gen: 1, name: "other", origin: "https://other.example.org", path: "/login", send_to: ["https://other.example.org"], repos: null, by: "operator", approved: true });
  for (const name of ["missing", "offered", "other"]) await assert.rejects(w.act().signIn(LOCAL, { name }), refusal(ACT_TEXT.no_such_name.replace("<name>", name)), name);
  await assert.rejects(w.act().signIn(LOCAL, { name: "a b" }), refusal(ACT_TEXT.no_such_name.replace("<name>", "\"a b\"")));
  await assert.rejects(w.act().signIn(LOCAL, {}), refusal(ACT_TEXT.no_such_name.replace("<name>", "null")));
  await assert.rejects(w.act().signIn(LOCAL, { name: 5 }), refusal(ACT_TEXT.no_such_name.replace("<name>", "5")));
  assert.ok(ends(w).every((e) => e.result === "no_such_name" && e.id === null && e.name === null));
  assert.equal(w.first("windows.create"), -1);
});

test("check 3: a host of send_to that the scope's list does not cover", async () => {
  const w = new ActWorld();
  w.store.records[0].send_to = [ORIGIN, "https://auth.example.org"];
  await assert.rejects(w.act().signIn(LOCAL, { name: "staging" }), refusal("Not allowed: auth.example.org is not on the allowlist"));
  assert.deepEqual([ends(w)[0].result, ends(w)[0].id], ["not_allowed", "c-0000000a"]);
});

test("checks 4 to 6: locked, a record that does not open, stopped, the hour's limit; each refusal is no act (no start, no count)", async () => {
  const w = new ActWorld();
  w.store.st = "locked";
  await assert.rejects(w.act().signIn(LOCAL, { name: "staging" }), refusal(ACT_TEXT.locked));
  w.store.st = "open";
  w.store.open.set("c-0000000a", false);
  await assert.rejects(w.act().signIn(LOCAL, { name: "staging" }), refusal(ACT_TEXT.cannot_open));
  w.store.open.delete("c-0000000a");
  for (const l of ["stopped", "hour_limit"] as const) {
    w.store.limits.set("c-0000000a", l);
    await assert.rejects(w.act().signIn(LOCAL, { name: "staging" }), refusal(ACT_TEXT[l]));
  }
  assert.deepEqual(ends(w).map((e) => e.result), ["locked", "cannot_open", "stopped", "hour_limit"]);
  assert.deepEqual(w.store.started, []);
  assert.equal(w.first("windows.create"), -1);
  for (const b of w.store.zeroed) assert.ok(b.every((x) => x === 0), "an opened record's buffers are zeros after a refusal too");
});

test("check 7: one act at a time; a request waits for the act before it at most its limit, then gets busy", async () => {
  const w = new ActWorld();
  w.submitTo = null; // the first act waits for its outcome (the limit of 1.5 s here)
  const act = w.act();
  const first = act.signIn(LOCAL, { name: "staging" });
  await new Promise((r) => setTimeout(r, 50));
  await assert.rejects(act.signIn(LOCAL, { name: "staging" }), refusal(ACT_TEXT.busy));
  await assert.rejects(first, refusal(ACT_TEXT.timeout));
  assert.deepEqual(ends(w).map((e) => e.result), ["busy", "timeout"]);
});

test("the hello's features are a list: the act needs `act` in it (membership); a receiver with more features has it, one without gets no window", async () => {
  const more = new ActWorld();
  more.features = new Set(["later-feature", "act", "scopes"]);
  assert.equal((await more.act().signIn(LOCAL, { name: "staging" })).signedIn, true);
  const old = new ActWorld();
  old.features = new Set(["scopes"]);
  await assert.rejects(old.act().signIn(LOCAL, { name: "staging" }), refusal(ACT_TEXT.no_window));
  assert.equal(old.first("windows.create"), -1);
});

test("the act window: another private window, a receiver that cannot open one; no act_end without a window, and one after a late answer", async () => {
  const priv = new ActWorld();
  priv.windowCreate = () => ({ error: "another private window is open" });
  await assert.rejects(priv.act().signIn(LOCAL, { name: "staging" }), refusal(ACT_TEXT.private_window));
  assert.equal(priv.first("act_end"), -1);
  const no = new ActWorld();
  no.windowCreate = () => ({ error: "not allowed in incognito" });
  await assert.rejects(no.act().signIn(LOCAL, { name: "staging" }), refusal(ACT_TEXT.no_window));
  const late = new ActWorld();
  late.windowCreate = () => ({ error: "timeout" });
  await assert.rejects(late.act().signIn(LOCAL, { name: "staging" }), refusal(ACT_TEXT.no_window));
  assert.equal(late.log.filter((r) => r.what === "act_end").length, 1, "a window that may be open: act_end ends it");
  const notIncognito = new ActWorld();
  notIncognito.windowCreate = () => ({ id: 30, incognito: false, tabs: [{ id: 31 }] });
  await assert.rejects(notIncognito.act().signIn(LOCAL, { name: "staging" }), refusal(ACT_TEXT.no_window), "a window that is not incognito: no act there");
});

test("the window off the screen: no key while windows.get reports it on the screen; the act ends `window` and act_end closes it", async () => {
  const w = new ActWorld();
  w.movesOff = false;
  await assert.rejects(w.act().signIn(LOCAL, { name: "staging" }), refusal(ACT_TEXT.window));
  assert.equal(w.keys().length, 0);
  assert.equal(w.first("navigate"), -1, "the page never loads on the screen");
  assert.ok(w.first("act_end") > 0);
});

test("a sign-in page that never loads (Page.navigate gets no answer) ends the act `timeout` within the load's wait; the clean end and act_end follow", { timeout: 10_000 }, async () => {
  const w = new ActWorld();
  w.stall = true;
  await assert.rejects(w.act().signIn(LOCAL, { name: "staging" }), refusal(ACT_TEXT.timeout));
  assert.equal(w.keys().length, 0);
  assert.ok(w.first("act_end") > w.first("navigate"));
});

test("form rules before the first key: another origin, two password fields, a GET form and a form to another place get no key and no act_rules; act_end follows", async () => {
  const cases: [string, (w: ActWorld) => void][] = [
    [ACT_TEXT.other_origin, (w) => w.pages.set(`${ORIGIN}/login`, loginPage({ origin: "http://evil.localhost:8080", href: "http://evil.localhost:8080/login" }))],
    [ACT_TEXT.password_fields, (w) => w.pages.set(`${ORIGIN}/login`, loginPage({ fields: [field(0, "email"), field(1, "password"), field(2, "password")] }))],
    [ACT_TEXT.form_target, (w) => w.pages.set(`${ORIGIN}/login`, loginPage({ forms: [{ method: "get", action: `${ORIGIN}/login` }] }))],
    [ACT_TEXT.form_target, (w) => w.pages.set(`${ORIGIN}/login`, loginPage({ forms: [{ method: "post", action: "http://evil.localhost:8080/steal" }] }))],
    [ACT_TEXT.no_form, (w) => w.pages.set(`${ORIGIN}/login`, loginPage({ fields: [] }))],
  ];
  for (const [text, set] of cases) {
    const w = new ActWorld();
    set(w);
    await assert.rejects(w.act().signIn(LOCAL, { name: "staging" }), refusal(text), text);
    assert.equal(w.keys().length, 0, `${text}: no key`);
    assert.equal(w.first("act_rules"), -1, `${text}: no act_rules`);
    assert.ok(w.first("empty") > 0 && w.first("act_end") > w.first("empty"), `${text}: the clean end`);
  }
});

test("the act's rules: a refused act_rules, an empty answer and a late one end the act with no key; act_end follows each", { timeout: 20_000 }, async () => {
  for (const answer of [{ error: "rules not held" }, { rules: [] }, { late: true }]) {
    const w = new ActWorld();
    w.rulesAnswer = () => answer;
    await assert.rejects(w.act().signIn(LOCAL, { name: "staging" }), refusal(ACT_TEXT.rules), JSON.stringify(answer));
    assert.equal(w.keys().length, 0);
    assert.equal(w.first("fetchOn"), -1);
    assert.ok(w.first("act_end") > w.first("act_rules"), "act_end after a failed or late act_rules");
  }
});

test("form rule 6: an open WebSocket of the page to another host at the first key ends the act with no key; one to the site's own origin does not", async () => {
  const w = new ActWorld();
  const act = w.act();
  w.onInput = () => {};
  const orig = w.receiver.request;
  w.receiver.request = async (op, body, ms) => {
    if (op === "act_rules") w.cdpEvent("Network.webSocketCreated", { requestId: "ws1", url: "ws://tracker.localhost:8081/s" });
    return orig(op, body, ms);
  };
  await assert.rejects(act.signIn(LOCAL, { name: "staging" }), refusal(ACT_TEXT.open_connection));
  assert.equal(w.keys().length, 0);
  const own = new ActWorld();
  const o2 = own.receiver.request;
  own.receiver.request = async (op, body, ms) => {
    if (op === "act_rules") { own.cdpEvent("Network.webSocketCreated", { requestId: "ws1", url: "ws://login.localhost:8080/live" }); own.cdpEvent("Network.webSocketCreated", { requestId: "ws2", url: "ws://tracker.localhost:8081/s" }); own.cdpEvent("Network.webSocketClosed", { requestId: "ws2" }); }
    return o2(op, body, ms);
  };
  assert.equal((await own.act().signIn(LOCAL, { name: "staging" })).signedIn, true, "the site's own socket, and a closed one, pass");
});

test("form rule 7, the type watch: a change of the password field's type stops the keys at once; the act ends `type_watch` and empties the inputs", async () => {
  const w = new ActWorld({ password: PASS_KEYS });
  let keysAfter = 0;
  w.onInput = (m, p) => {
    if (m !== "Input.dispatchKeyEvent" || p.type !== "keyDown" || w.focused !== 1) return;
    if (w.watchHit) keysAfter++;
    w.watchHit = true; // the page shows the field as text after the first key of the password
  };
  await assert.rejects(w.act().signIn(LOCAL, { name: "staging" }), refusal(ACT_TEXT.type_watch));
  assert.ok(w.watchInstalled && w.first("watch") < w.first("lock"), "the watch before the first key");
  assert.equal(keysAfter, 0, "no key after the change");
  assert.ok(w.first("empty") > 0);
});

test("the guard: a paused request whose URL holds the password fails, also a body off send_to; the site's own request continues; a paused request too large for the link fails; the end counts them", async () => {
  const w = new ActWorld();
  const b64u = Buffer.from(PASS_INSERT).toString("base64url");
  let once = false;
  w.onInput = (m) => {
    if (m !== "Input.insertText" || once) return;
    once = true;
    w.cdpEvent("Fetch.requestPaused", { requestId: "f1", networkId: "n1", request: { url: `http://tracker.localhost:8081/i.gif?d=${b64u}`, method: "GET" } });
    w.cdpEvent("Fetch.requestPaused", { requestId: "f2", networkId: "n2", request: { url: "http://tracker.localhost:8081/c", method: "POST", hasPostData: true } });
    w.cdpEvent("Fetch.requestPaused", { requestId: "f3", networkId: "n3", request: { url: `${ORIGIN}/login`, method: "POST", postData: `p=${encodeURIComponent(PASS_INSERT)}`, hasPostData: true } });
    w.emit({ t: "ev", ch: "bridge", ev: "bridge.tooLarge", of: "debugger.onEvent", method: "Fetch.requestPaused", tabId: 31, requestId: "f4" });
    // The block's own stops: a request that Chrome blocked for an extension (and one that the guard failed, not counted twice).
    w.cdpEvent("Network.loadingFailed", { requestId: "n9", errorText: "net::ERR_BLOCKED_BY_CLIENT" });
    w.cdpEvent("Network.loadingFailed", { requestId: "n1", errorText: "net::ERR_BLOCKED_BY_CLIENT" });
  };
  await w.act().signIn(LOCAL, { name: "staging" });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(w.guardCalls.map((c) => [c.requestId, c.method]).sort(), [["f1", "Fetch.failRequest"], ["f2", "Fetch.failRequest"], ["f3", "Fetch.continueRequest"], ["f4", "Fetch.failRequest"]]);
  const e = ends(w)[0];
  assert.deepEqual([e.guarded, e.blocked], [3, 1]);
  noCanary(w);
});

test("the outcome: not accepted, a second factor, a host on no list, a timeout; the store gets each result", async () => {
  const cases: [string, string | null, (w: ActWorld) => void][] = [
    ["not_accepted", `${ORIGIN}/login?e=1`, (w) => w.pages.set(`${ORIGIN}/login?e=1`, loginPage({ href: `${ORIGIN}/login?e=1` }))],
    ["second_factor", `${ORIGIN}/2fa`, (w) => w.pages.set(`${ORIGIN}/2fa`, homePage({ href: `${ORIGIN}/2fa`, fields: [field(0, "text", { autocomplete: "one-time-code" })] }))],
    ["off_list", "http://elsewhere.localhost:9090/", () => {}],
    ["timeout", null, () => {}],
  ];
  for (const [result, to, set] of cases) {
    const w = new ActWorld();
    w.submitTo = to;
    set(w);
    await assert.rejects(w.act().signIn(LOCAL, { name: "staging" }), refusal(ACT_TEXT[result as keyof typeof ACT_TEXT]), result);
    assert.deepEqual(w.store.ended, [["c-0000000a", result]]);
    assert.equal(w.moved.length, 0, `${result}: no move`);
    assert.ok(w.first("act_end") > 0);
  }
});

test("the leak check: a localStorage value that holds the password ends the act `leak` with no move; a failed move ends it `move`", async () => {
  const w = new ActWorld();
  w.pages.set(`${ORIGIN}/home`, homePage({ local: { remember: Buffer.from(PASS_INSERT).toString("base64") } }));
  await assert.rejects(w.act().signIn(LOCAL, { name: "staging" }), refusal(ACT_TEXT.leak));
  assert.equal(w.moved.length, 0);
  assert.ok(w.first("act_end") > 0);
  const c = new ActWorld();
  c.cookies = [{ ...c.cookies[0], value: encodeURIComponent(PASS_INSERT) }];
  await assert.rejects(c.act().signIn(LOCAL, { name: "staging" }), refusal(ACT_TEXT.leak), "a cookie value");
  const m = new ActWorld();
  m.moveOk = false;
  await assert.rejects(m.act().signIn(LOCAL, { name: "staging" }), refusal(ACT_TEXT.move));
  assert.ok(m.first("act_end") > m.first("move"));
  // A page on another origin at the end: its localStorage is not the credential origin's, so the move holds none.
  const other = new ActWorld();
  other.submitTo = "http://app.login.localhost:8080/";
  other.entries = ["login.localhost"];
  other.pages.set("http://app.login.localhost:8080/", homePage({ href: "http://app.login.localhost:8080/", origin: "http://app.login.localhost:8080", local: { other: "x" } }));
  await other.act().signIn(LOCAL, { name: "staging" });
  assert.deepEqual(other.moved[0].storage.local, {});
});

test("a two-step sign-in: the username, the submit, the next page's password field, then the password (rules 1 to 4 again); at most one step", async () => {
  const w = new ActWorld();
  w.pages.set(`${ORIGIN}/login`, loginPage({ fields: [field(0, "email")], submit: null }));
  w.pages.set(`${ORIGIN}/step2`, loginPage({ href: `${ORIGIN}/step2`, fields: [field(0, "password")] }));
  w.submitTo = `${ORIGIN}/step2`;
  // The first step's Enter goes to the second page; the second page's submit button to the signed-in page.
  w.onInput = (m, p) => { if (m === "Input.dispatchKeyEvent" && p.type === "keyUp" && p.key === "Enter") w.submitTo = `${ORIGIN}/home`; };
  assert.equal((await w.act().signIn(LOCAL, { name: "staging" })).signedIn, true);
  assert.ok(w.keys().length >= 2 && w.keys().every((k) => k.rules && k.outside && k.lock), "the rules before the first key of the first step too");
  assert.equal(w.log.filter((r) => r.what === "act_rules").length, 1, "one act_rules for both steps");
  assert.equal(w.log.filter((r) => r.what === "submit").length, 2, "two submits: the step's and the sign-in's");
  // At most one step: a second page with no password field again is no form.
  const two = new ActWorld();
  two.pages.set(`${ORIGIN}/login`, loginPage({ fields: [field(0, "email")], submit: null }));
  two.pages.set(`${ORIGIN}/step2`, loginPage({ href: `${ORIGIN}/step2`, fields: [field(0, "email")], submit: null }));
  two.submitTo = `${ORIGIN}/step2`;
  await assert.rejects(two.act().signIn(LOCAL, { name: "staging" }), refusal(ACT_TEXT.timeout), "no password field on the next page in the time");
});

test("review-124 B2 and B3: an act popup that opens before the last key ends the act `popup` with no key after the service learns of it; the act's own session and guard on the popup; its X window moves by its own marker; act_end follows", async () => {
  const w = new ActWorld();
  let keysAfter = 0, opened = false;
  w.onInput = (m, p) => {
    if (m === "Input.dispatchMouseEvent" && p.type === "mousePressed" && !opened) { opened = true; w.openPopup(41, 40); return; }
    if (opened && (m === "Input.insertText" || (m === "Input.dispatchKeyEvent" && p.type !== "keyUp"))) keysAfter++;
  };
  await assert.rejects(w.act().signIn(LOCAL, { name: "staging" }), refusal(ACT_TEXT.popup));
  assert.equal(keysAfter, 0, "no key after the popup at the first click");
  assert.ok(w.hidden.has(41), "the popup is hidden from clients");
  const on41 = w.popupCalls.filter((c) => c.tab === 41).map((c) => c.method);
  for (const m of ["Network.enable", "Fetch.enable"]) assert.ok(on41.includes(m), `the popup's ${m}`);
  assert.ok(w.log.some((r) => r.what === "attach" && r.detail === 41), "the act's own session on the popup");
  await until(() => w.log.some((r) => r.what === "popupMoved" && r.detail === 40), "the popup's X window moves by its marker");
  assert.ok(w.first("act_end") > 0);
  assert.equal(ends(w)[0].result, "popup");
});

test("review-124 B2 and B3: a popup after the last key (at the submit): the act goes on, the guard covers the popup's requests that its session sees, its blocked requests count (N9); a popup's window that stays on the screen ends the act `window`", async () => {
  const w = new ActWorld();
  const b64u = Buffer.from(PASS_INSERT).toString("base64url");
  w.onInput = (m, p) => {
    if (m === "Input.dispatchMouseEvent" && p.type === "mousePressed" && p.y >= 220 && w.popupTabs.size === 0) {
      w.openPopup(41, 40);
      setTimeout(() => {
        w.emit({ t: "ev", ch: "bridge", ev: "debugger.onEvent", source: { tabId: 41 }, method: "Fetch.requestPaused", params: { requestId: "p1", networkId: "pn1", request: { url: `http://tracker.localhost:8081/p?d=${b64u}`, method: "GET" } } });
        w.emit({ t: "ev", ch: "bridge", ev: "debugger.onEvent", source: { tabId: 41 }, method: "Network.loadingFailed", params: { requestId: "pn9", errorText: "net::ERR_BLOCKED_BY_CLIENT" } });
      }, 5);
    }
  };
  assert.equal((await w.act().signIn(LOCAL, { name: "staging" })).signedIn, true);
  await until(() => w.popupCalls.some((c) => c.tab === 41 && c.method === "Fetch.failRequest"), "the guard fails the popup's request");
  const e = ends(w)[0];
  assert.ok(e.guarded >= 1 && e.blocked >= 1, `the popup's requests count: ${e.guarded} guarded, ${e.blocked} blocked`);
  const stay = new ActWorld();
  stay.movesPopups = false;
  stay.submitTo = null;
  stay.onInput = (m, p) => { if (m === "Input.dispatchMouseEvent" && p.type === "mousePressed" && p.y >= 220 && stay.popupTabs.size === 0) stay.openPopup(41, 40); };
  await assert.rejects(stay.act().signIn(LOCAL, { name: "staging" }), refusal(ACT_TEXT.window));
});

test("review-124 B4: an incognito tab whose opener is no tab of the act (the operator's private window) is no act popup: no attach, no move; a client's window with the same bounds as an act popup's never moves (the move is by the popup's own marker)", async () => {
  const w = new ActWorld();
  w.popupWindows.set(60, { bounds: { left: 10, top: 10, width: 400, height: 300 }, marker: null }); // a client's window, the popup's bounds
  w.onInput = (m, p) => {
    if (m === "Input.dispatchMouseEvent" && p.type === "mousePressed" && w.popupTabs.size === 0) w.openPopup(51, 50, { opener: null });
    if (m === "Input.dispatchMouseEvent" && p.type === "mousePressed" && p.y >= 220 && !w.popupTabs.has(41)) w.openPopup(41, 40);
  };
  assert.equal((await w.act().signIn(LOCAL, { name: "staging" })).signedIn, true, "the operator's private window does not end the act");
  await until(() => w.log.some((r) => r.what === "popupMoved" && r.detail === 40), "the act popup's window moves");
  assert.ok(!w.log.some((r) => r.what === "attach" && r.detail === 51), "no attach of the operator's tab");
  assert.ok(!w.hidden.has(51), "the act takes no tab that is not its own (the model hides it by its incognito flag)");
  assert.ok(!w.log.some((r) => r.what === "popupMoved" && (r.detail === 50 || r.detail === 60)), "neither the operator's window nor the client's window moved");
  assert.equal(w.popupWindows.get(60)!.bounds.left, 10);
  assert.equal(w.popupWindows.get(50)!.bounds.left, 10);
});

test("review-124b F1: a popup's event during the type watch's read stops the next key: no key goes after the service learns of the popup", async () => {
  const w = new ActWorld({ password: PASS_KEYS });
  let hits = 0, opened = false, keysAfter = 0;
  w.onHit = () => { if (++hits === 2 && !opened) { opened = true; w.openPopup(41, 40); } };
  w.onInput = (m, p) => { if (opened && m === "Input.dispatchKeyEvent" && p.type !== "keyUp") keysAfter++; };
  await assert.rejects(w.act().signIn(LOCAL, { name: "staging" }), refusal(ACT_TEXT.popup));
  assert.ok(opened, "the popup came during a read of the type watch");
  assert.equal(keysAfter, 0, "no key after it");
});

test("review-124b F2: a popup known only by webNavigation.onCreatedNavigationTarget (an act tab as its source, no act openerTabId) ends the act `popup` before the next key, gets the act's attach and Fetch, and moves by its own marker", async () => {
  const w = new ActWorld();
  let opened = false, keysAfter = 0;
  w.onInput = (m, p) => {
    if (m === "Input.dispatchMouseEvent" && p.type === "mousePressed" && !opened) {
      opened = true;
      w.popupTabs.set(41, { windowId: 40 });
      w.popupWindows.set(40, { bounds: { left: 10, top: 10, width: 400, height: 300 }, marker: null });
      // The receiver's order: the navigation target first (its opener by sourceTabId), then tabs.onCreated with the active tab as openerTabId.
      w.emit({ t: "ev", ch: "bridge", ev: "webNavigation.onCreatedNavigationTarget", details: { sourceTabId: 31, sourceFrameId: 0, tabId: 41, url: "about:blank" } });
      w.emit({ t: "ev", ch: "bridge", ev: "tabs.onCreated", tab: { id: 41, windowId: 40, incognito: true, openerTabId: 7, url: "" }, attached: false, held: false });
      return;
    }
    if (opened && (m === "Input.insertText" || (m === "Input.dispatchKeyEvent" && p.type !== "keyUp"))) keysAfter++;
  };
  await assert.rejects(w.act().signIn(LOCAL, { name: "staging" }), refusal(ACT_TEXT.popup));
  assert.equal(keysAfter, 0);
  assert.ok(w.log.some((r) => r.what === "attach" && r.detail === 41), "the act's own session on the popup");
  assert.ok(w.popupCalls.some((c) => c.tab === 41 && c.method === "Fetch.enable"), "the guard on the popup");
  await until(() => w.log.some((r) => r.what === "popupMoved" && r.detail === 40), "the popup's window moves by its marker");
});

test("review-124b F2: the added tab of an act popup's tabs.onReplaced is an act popup: the act ends `popup`, and the added tab gets the act's attach and Fetch and moves by its own marker", async () => {
  const w = new ActWorld();
  let opened = false;
  w.onInput = (m, p) => {
    if (m === "Input.dispatchMouseEvent" && p.type === "mousePressed" && !opened) {
      opened = true;
      w.openPopup(41, 40);
      w.popupTabs.set(42, { windowId: 44 });
      w.popupWindows.set(44, { bounds: { left: 30, top: 30, width: 400, height: 300 }, marker: null });
      w.emit({ t: "ev", ch: "bridge", ev: "tabs.onReplaced", addedTabId: 42, removedTabId: 41 });
    }
  };
  await assert.rejects(w.act().signIn(LOCAL, { name: "staging" }), refusal(ACT_TEXT.popup));
  assert.ok(w.log.some((r) => r.what === "attach" && r.detail === 42), "the act's own session on the added tab");
  assert.ok(w.popupCalls.some((c) => c.tab === 42 && c.method === "Fetch.enable"), "the guard on the added tab");
  await until(() => w.log.some((r) => r.what === "popupMoved" && r.detail === 44), "the added tab's window moves by its marker");
});

test("review-124b note d: a popup whose attach the receiver refuses ends the act `popup`, also after the password's last key (fail closed)", async () => {
  const w = new ActWorld();
  w.refuseAttach.add(41);
  w.submitTo = null;
  w.onInput = (m, p) => { if (m === "Input.dispatchMouseEvent" && p.type === "mousePressed" && p.y >= 220 && w.popupTabs.size === 0) w.openPopup(41, 40); };
  await assert.rejects(w.act().signIn(LOCAL, { name: "staging" }), refusal(ACT_TEXT.popup));
  assert.ok(w.first("act_end") > 0);
});

test("review-124b note b: a popup whose windows.get fails is not taken for a closed one: its window is not confirmed off the screen, and the act ends `window`", async () => {
  const w = new ActWorld();
  w.failWindowGet.add(40);
  w.submitTo = null;
  w.onInput = (m, p) => { if (m === "Input.dispatchMouseEvent" && p.type === "mousePressed" && p.y >= 220 && w.popupTabs.size === 0) w.openPopup(41, 40); };
  await assert.rejects(w.act().signIn(LOCAL, { name: "staging" }), refusal(ACT_TEXT.window));
});

test("the daemon lead's point 2: the X move's title is a new random value for each act and each act popup, which the service sets (aw-act- and 8 random bytes in hex)", async () => {
  const markers: string[] = [];
  for (let i = 0; i < 2; i++) {
    const w = new ActWorld();
    w.onInput = (m, p) => { if (m === "Input.dispatchMouseEvent" && p.type === "mousePressed" && p.y >= 220 && w.popupTabs.size === 0) w.openPopup(41, 40); };
    await w.act().signIn(LOCAL, { name: "staging" });
    await until(() => w.log.some((r) => r.what === "popupMoved"), "the popup's move");
    markers.push(...new Set(w.log.filter((r) => r.what === "moveOff").map((r) => r.detail as string)));
  }
  assert.ok(markers.length >= 4, markers.join(" "));
  for (const m of markers) assert.match(m, /^aw-act-[0-9a-f]{16}$/);
  assert.equal(new Set(markers).size, markers.length, "each act's and each popup's title is its own");
});

test("review-124 B1 and N2: requests that wait in check 7's queue are checked again at their turn: act 1 stops the credential, and the requests behind it are refused `stopped` with no act; the same for the hour's limit and for a lock during the wait; their values open only at the turn", async () => {
  // The lockout guard: 2 failed results in a row before; act 1 is not accepted (the third), so it stops the credential.
  const w = new ActWorld();
  w.store.fails.set("c-0000000a", 2);
  w.submitTo = `${ORIGIN}/login?e=1`;
  w.pages.set(`${ORIGIN}/login?e=1`, loginPage({ href: `${ORIGIN}/login?e=1` }));
  let held = -1;
  w.onInput = () => { if (held < 0) held = w.store.zeroed.filter((b) => b.some((x) => x !== 0)).length; };
  const act = w.act({ limits: { busyMs: 10_000, outcomeMs: 1500, settleMs: 40, receiverMs: 300, queueMs: 200, popupMs: 300 } });
  const all = await Promise.allSettled([act.signIn(LOCAL, { name: "staging" }), act.signIn(LOCAL, { name: "staging" }), act.signIn(LOCAL, { name: "staging" })]);
  assert.deepEqual(all.map((x) => x.status === "rejected" ? (x.reason as ActRefusal).result : "ok"), ["not_accepted", "stopped", "stopped"]);
  assert.deepEqual(w.store.started, ["c-0000000a"], "one act");
  assert.equal(w.events.filter((e) => e.phase === "start").length, 1);
  assert.equal(held, 2, "while act 1 typed, only its two buffers held values: the waiting requests' values were not open");
  // The hour's limit: one act left in the hour; the requests behind it are refused `hour_limit`.
  const h = new ActWorld();
  h.store.hourLimit = 1;
  const ha = h.act({ limits: { busyMs: 10_000, outcomeMs: 1500, settleMs: 40, receiverMs: 300, queueMs: 200, popupMs: 300 } });
  const hr = await Promise.allSettled([ha.signIn(LOCAL, { name: "staging" }), ha.signIn(LOCAL, { name: "staging" }), ha.signIn(LOCAL, { name: "staging" })]);
  assert.deepEqual(hr.map((x) => x.status === "rejected" ? (x.reason as ActRefusal).result : "ok"), ["ok", "hour_limit", "hour_limit"]);
  // A lock during the wait: the request behind gets `locked`.
  const l = new ActWorld();
  l.onInput = () => { l.store.st = "locked"; };
  const la = l.act({ limits: { busyMs: 10_000, outcomeMs: 1500, settleMs: 40, receiverMs: 300, queueMs: 200, popupMs: 300 } });
  const lr = await Promise.allSettled([la.signIn(LOCAL, { name: "staging" }), la.signIn(LOCAL, { name: "staging" })]);
  assert.equal(lr[1].status === "rejected" ? (lr[1].reason as ActRefusal).result : "ok", "locked");
  assert.deepEqual(l.store.started, ["c-0000000a"]);
  for (const b of [...w.store.zeroed, ...l.store.zeroed]) assert.ok(b.every((x) => x === 0), "every buffer is zeros at the end");
});

test("review-124 N3: a failed act_end is sent once more after 500 ms; two failures are logged", async () => {
  const w = new ActWorld();
  const orig = w.receiver.request;
  let ends2 = 0;
  w.receiver.request = async (op, body, ms) => { if (op === "act_end" && ++ends2 === 1) throw new Error("act not closed"); return orig(op, body, ms); };
  await w.act().signIn(LOCAL, { name: "staging" });
  assert.equal(w.log.filter((r) => r.what === "act_end").length, 1, "the second act_end reached the receiver");
  assert.equal(ends2, 2);
  const x = new ActWorld();
  const xo = x.receiver.request;
  x.receiver.request = async (op, body, ms) => { if (op === "act_end") throw new Error("act not closed"); return xo(op, body, ms); };
  await x.act().signIn(LOCAL, { name: "staging" }).catch(() => {});
  assert.ok(x.logs.some((l) => /act_end failed twice/.test(l)));
});

test("a lost act tab (its session detached) ends the act `lost`; a link that went down ends it with the readiness's text", async () => {
  const w = new ActWorld();
  w.submitTo = null;
  w.onInput = (m) => { if (m === "Input.insertText") setTimeout(() => w.emit({ t: "ev", ch: "bridge", ev: "debugger.onDetach", source: { tabId: 31 }, reason: "target_closed" }), 10); };
  await assert.rejects(w.act().signIn(LOCAL, { name: "staging" }), refusal(ACT_TEXT.lost));
  const d = new ActWorld();
  d.submitTo = null;
  d.onInput = (m) => { if (m === "Input.insertText") setTimeout(() => { d.notReady = "The agent browser is not ready: its extension is not connected."; d.emit({ t: "ev", ch: "bridge", ev: "debugger.onDetach", source: { tabId: 31 }, reason: "target_closed" }); }, 10); };
  await assert.rejects(d.act().signIn(LOCAL, { name: "staging" }), refusal("The agent browser is not ready: its extension is not connected."));
  assert.deepEqual([ends(d)[0].result, ends(d)[0].id, ends(d)[0].act], ["not_ready", "c-0000000a", d.events[0].act], "an act that started names its credential at its end");
});

test("the rate of the refusal ends: 12 refusals of one scope at once send 10 ends; each still gets its answer and its log line; another scope's go", async () => {
  const w = new ActWorld();
  let t = Date.parse("2026-11-12T10:00:00Z");
  const act = w.act({ now: () => t });
  for (let i = 0; i < 12; i++) await assert.rejects(act.signIn(LOCAL, { name: "missing" }));
  await assert.rejects(act.signIn({ scope: "web-2", admission: "local" }, { name: "missing" }));
  assert.equal(ends(w).filter((e) => e.scope === "web-1").length, 10);
  assert.equal(ends(w).filter((e) => e.scope === "web-2").length, 1);
  assert.equal(w.logs.filter((l) => l.startsWith("sign-in: act ")).length, 13);
  t += 60_000;
  await assert.rejects(act.signIn(LOCAL, { name: "missing" }));
  assert.equal(ends(w).at(-1).dropped, 2, "the next end carries the count of the ends that did not go");
});

test("AgentBrowser.signIns: the store's state and the approved names and origins that the scope's list covers (send_to too); names no value", () => {
  const w = new ActWorld();
  w.store.records.push({ v: 1, id: "c-0000000c", gen: 1, name: "other", origin: "https://other.example.org", path: "/login", send_to: ["https://other.example.org"], repos: null, by: "operator", approved: true });
  w.store.records.push({ v: 1, id: "c-0000000d", gen: 1, name: "wide", origin: ORIGIN, path: "/login", send_to: [ORIGIN, "https://auth.example.org"], repos: null, by: "operator", approved: true });
  w.store.records.push({ v: 1, id: "c-0000000e", gen: 1, name: "offered", origin: ORIGIN, path: "/login", send_to: [ORIGIN], repos: null, by: "offer", approved: false });
  assert.deepEqual(w.act().signIns(LOCAL), { state: "open", signIns: [{ name: "staging", origin: ORIGIN }] });
  w.store.st = "locked";
  assert.equal(w.act().signIns(LOCAL).state, "locked");
  assert.equal(w.events.length, 0, "it sends no sign_in event");
  assert.ok(!JSON.stringify(w.act().signIns(LOCAL)).includes(USER));
});
