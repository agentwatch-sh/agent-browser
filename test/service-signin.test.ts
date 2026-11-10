// Stage 1c of the self-contained agent browser (board ab-v16.94.4): the sign-in import's payload check (C2) and the
// box's own sign-in rule (agentwatch's Ruling 26, with the hosts and cookie names that agentwatch gives in
// set_sessions' `box`), and the Browser pane's texts of a send (C4 choice 6, C6 step 5). The cases are agentwatch's
// reference cases (tests/daemon/browser/test_payload.py and the send-text cases of test_service.py), ported. Every
// payload is a test payload made here: no real sign-in and no real cookie. A refusal names the field, never a value.

import { test } from "node:test";
import assert from "node:assert/strict";
import { BOX_COOKIE_PREFIX, checkBoxHosts, checkPayload, MAX_SEND_BYTES, PayloadError, TooLargeError } from "../src/service/signin/payload.ts";
import { RECEIVER_MISSING_TEXT, SEND_DOMAIN_SHOWN, SEND_STEP_SWAP, SEND_STEPS_AFTER_SWAP, SEND_STEPS_BEFORE_SWAP, SEND_TEXT_MAX, sendText, NOT_CONNECTED_TEXT } from "../src/service/signin/send-text.ts";

const SENTINEL = "s3cr3t-SENTINEL-cookie-value-7f3a";
const STORAGE_SENTINEL = "s3cr3t-SENTINEL-storage-value-91c2";
const BOX = ["box.localhost"];
const NAMES = ["__Host-session", "__Host-status"];
const noSecret = (t: string) => { assert.ok(!t.includes(SENTINEL), t); assert.ok(!t.includes(STORAGE_SENTINEL), t); };

const cookie = (over: Record<string, unknown> = {}): Record<string, any> => ({
  name: "sid", value: SENTINEL, domain: ".site.localhost", hostOnly: false, path: "/", secure: true, httpOnly: true, sameSite: "lax", session: false, expirationDate: 1893456000.5, ...over,
});
function valid(): Record<string, any> {
  const hostOnly = cookie({ name: "pref", domain: "www.site.localhost", hostOnly: true, session: true, sameSite: "unspecified" });
  delete hostOnly.expirationDate;
  return {
    v: 1, domain: "site.localhost", url: "https://www.site.localhost/app?x=1#top", origin: "https://www.site.localhost",
    cookies: [cookie(), hostOnly, cookie({ name: "part", sameSite: "no_restriction", partitionKey: { topLevelSite: "https://site.localhost", hasCrossSiteAncestor: false } }), cookie({ name: "strict", sameSite: "strict" })],
    storage: {
      local: { token: STORAGE_SENTINEL }, session: { tab: "1" },
      idb: [{ name: "db", version: 3, stores: [
        { name: "s", keyPath: null, autoIncrement: false, indexes: [{ name: "i", keyPath: "a", unique: false, multiEntry: true }, { name: "j", keyPath: ["a", "b"], unique: true, multiEntry: false }],
          records: [{ key: { t: "j", v: 1 }, value: { t: "j", v: STORAGE_SENTINEL } }] },
        { name: "t", keyPath: ["x", "y"], autoIncrement: true, indexes: [], records: [] }] }],
      caches: [{ name: "c", entries: [{ url: "https://www.site.localhost/x", status: 200, headers: [["content-type", "text/plain"]], body: "aGk=" }] }],
    },
  };
}
const DELETE = Symbol("delete");
const set = (path: (string | number)[], value: unknown) => (p: any) => {
  let t = p;
  for (const k of path.slice(0, -1)) t = t[k];
  if (value === DELETE) delete t[path.at(-1)!]; else t[path.at(-1)!] = value;
};
const urlAndOrigin = (origin: string) => (p: any) => { p.origin = origin; p.url = origin + "/app"; };
const refusal = (p: unknown, hosts: unknown = BOX): PayloadError => {
  try { checkPayload(p, hosts, NAMES); } catch (e) { assert.ok(e instanceof PayloadError, String(e)); return e; }
  assert.fail("no refusal");
};

test("a valid payload is taken whole; the result holds C2's keys only", () => {
  const p = valid();
  const { state, dropped } = checkPayload(p, BOX, NAMES);
  assert.equal(dropped, 0);
  assert.deepEqual(state, p);
  const q = { ...valid(), extra: { anything: STORAGE_SENTINEL }, box_hosts: ["other.localhost"] };
  assert.deepEqual(Object.keys(checkPayload(q, BOX, NAMES).state).sort(), ["cookies", "domain", "origin", "storage", "url", "v"]);
  assert.equal(MAX_SEND_BYTES, 33_554_432);
});

test("the size limit: a payload of exactly MAX_SEND_BYTES (compact JSON, as the control line holds it) is taken; one byte more is too large", () => {
  const p = valid();
  const size = Buffer.byteLength(JSON.stringify(p));
  p.storage.local.pad = "x".repeat(MAX_SEND_BYTES - size - ',"pad":""'.length);
  assert.equal(Buffer.byteLength(JSON.stringify(p)), MAX_SEND_BYTES);
  assert.equal(checkPayload(p, BOX, NAMES).state.domain, "site.localhost");
  p.storage.local.pad += "x";
  assert.throws(() => checkPayload(p, BOX, NAMES), (e: any) => e instanceof TooLargeError && e.message === `a sign-in send is at most ${MAX_SEND_BYTES} bytes`);
});

const REFUSALS: [string, (p: any) => void, string][] = [
  ["cookie of another domain", set(["cookies", 0, "domain"], ".other.localhost"), "cookies[0].domain"],
  ["cookie domain a parent of the domain", set(["cookies", 1, "domain"], "localhost"), "cookies[1].domain"],
  ["origin outside the domain", urlAndOrigin("https://www.other.localhost"), "origin"],
  ["origin with a path", set(["origin"], "https://www.site.localhost/"), "origin"],
  ["origin with a user", set(["origin"], "https://u@www.site.localhost"), "origin"],
  ["origin not http", set(["origin"], "ftp://www.site.localhost"), "origin"],
  ["origin javascript", set(["origin"], "javascript:alert(1)"), "origin"],
  ["origin upper case", set(["origin"], "https://WWW.site.localhost"), "origin"],
  ["origin a number", set(["origin"], 5), "origin"],
  ["origin host with a space", urlAndOrigin("https://a b.site.localhost"), "origin"],
  ["url of another origin", set(["url"], "https://api.site.localhost/app"), "url"],
  ["url of another scheme", set(["url"], "http://www.site.localhost/app"), "url"],
  ["url of another port", set(["url"], "https://www.site.localhost:8443/app"), "url"],
  ["url missing", set(["url"], DELETE), "url"],
  ["url with a backslash", set(["url"], "https://evil.localhost\\@www.site.localhost/app"), "url"],
  ["url with a user", set(["url"], "https://u:p@www.site.localhost/app"), "url"],
  ["url with a user name only", set(["url"], "https://u@www.site.localhost/app"), "url"],
  ["url with a tab", set(["url"], "https://www.site.localhost/a\tb"), "url"],
  ["url with a newline in the host", set(["url"], "https://www.site\n.localhost/app"), "url"],
  ["url with a NUL", set(["url"], "https://www.site.localhost/\x00"), "url"],
  ["url with DEL", set(["url"], "https://www.site.localhost/\x7f"), "url"],
  ["v 2", set(["v"], 2), "v"],
  ["v true", set(["v"], true), "v"],
  ["v text", set(["v"], "1"), "v"],
  ["domain not normalized", set(["domain"], "Site.localhost"), "domain"],
  ["domain with a scheme", set(["domain"], "https://site.localhost"), "domain"],
  ["domain a number", set(["domain"], 7), "domain"],
  ["bad sameSite", set(["cookies", 0, "sameSite"], "none"), "cookies[0].sameSite"],
  ["sameSite a list", set(["cookies", 0, "sameSite"], ["lax"]), "cookies[0].sameSite"],
  ["value not text", set(["cookies", 0, "value"], 5), "cookies[0].value"],
  ["httpOnly not a boolean", set(["cookies", 2, "httpOnly"], "yes"), "cookies[2].httpOnly"],
  ["no expiry on a lasting cookie", set(["cookies", 0, "expirationDate"], DELETE), "cookies[0].expirationDate"],
  ["expiry a boolean", set(["cookies", 0, "expirationDate"], true), "cookies[0].expirationDate"],
  ["partitionKey not an object", set(["cookies", 2, "partitionKey"], "x"), "cookies[2].partitionKey"],
  ["partitionKey site not text", set(["cookies", 2, "partitionKey", "topLevelSite"], 1), "cookies[2].partitionKey"],
  ["cookie not an object", set(["cookies", 3], "sid=1"), "cookies[3]"],
  ["cookies not a list", set(["cookies"], {}), "cookies"],
  ["storage missing", set(["storage"], DELETE), "storage"],
  ["local value not text", set(["storage", "local", "token"], 1), "storage.local"],
  ["session not a map", set(["storage", "session"], ["a"]), "storage.session"],
  ["idb not a list", set(["storage", "idb"], {}), "storage.idb"],
  ["idb version text", set(["storage", "idb", 0, "version"], "3"), "storage.idb[0].version"],
  ["keyPath a number", set(["storage", "idb", 0, "stores", 0, "keyPath"], 5), "storage.idb[0].stores[0].keyPath"],
  ["keyPath a list with a number", set(["storage", "idb", 0, "stores", 1, "keyPath"], ["a", 1]), "storage.idb[0].stores[1].keyPath"],
  ["index unique not a boolean", set(["storage", "idb", 0, "stores", 0, "indexes", 0, "unique"], 0), "storage.idb[0].stores[0].indexes[0].unique"],
  ["record without a value", set(["storage", "idb", 0, "stores", 0, "records", 0, "value"], DELETE), "storage.idb[0].stores[0].records[0].value"],
  ["caches not a list", set(["storage", "caches"], null), "storage.caches"],
  ["cache headers not pairs", set(["storage", "caches", 0, "entries", 0, "headers"], [["a"]]), "storage.caches[0].entries[0].headers"],
  ["cache status text", set(["storage", "caches", 0, "entries", 0, "status"], "200"), "storage.caches[0].entries[0].status"],
  ["cache body not text", set(["storage", "caches", 0, "entries", 0, "body"], null), "storage.caches[0].entries[0].body"],
  ["a number that is not finite (1e400 in the line)", set(["storage", "idb", 0, "stores", 0, "records", 0, "key", "v"], Infinity), "body"],
];

test("each refusal names the field and never a value (C2)", () => {
  for (const [name, edit, field] of REFUSALS) {
    const p = valid();
    edit(p);
    const e = refusal(p);
    assert.equal(e.message, `the sign-in send is not valid (field ${field})`, name);
    assert.equal(e.field, field, name);
    noSecret(e.message);
    noSecret(String(e.stack));
    assert.equal(e.cause, undefined, `${name}: nothing chained`);
  }
});

test("a session cookie needs no expiry; the default port is the same origin; an http origin with a port", () => {
  let p = valid();
  p.cookies = [cookie({ session: true })];
  delete p.cookies[0].expirationDate;
  assert.equal(checkPayload(p, BOX, NAMES).state.cookies[0].session, true);
  p = valid();
  p.url = "https://www.site.localhost:443/app";
  assert.equal(checkPayload(p, BOX, NAMES).state.url, p.url);
  p = valid();
  p.origin = "http://www.site.localhost:8080";
  p.url = "http://www.site.localhost:8080/x";
  assert.equal(checkPayload(p, BOX, NAMES).state.origin, "http://www.site.localhost:8080");
});

// ------------------------------------------------------------------ the box's own sign-in (Ruling 26)

test("a domain that covers a box host is refused (field domain); a sibling box host is not covered", () => {
  for (const box of ["site.localhost", "www.site.localhost", "a.b.site.localhost", "SITE.localhost."]) assert.equal(refusal(valid(), [box]).field, "domain", box);
  const { state, dropped } = checkPayload(valid(), ["box.localhost", "other.site2.localhost"], NAMES);
  assert.equal(dropped, 0);
  assert.equal(state.cookies.length, 4);
});

test("the box's own cookies are dropped and counted, never named: the names that agentwatch gives, a name with agentwatch's prefix, and a cookie that a box host would get", () => {
  assert.equal(BOX_COOKIE_PREFIX, "agentwatch");
  const p = valid();
  p.cookies.push(cookie({ name: "__Host-session", domain: "www.site.localhost", hostOnly: true }), cookie({ name: "agentwatch_board" }), cookie({ name: "agentwatch" }),
    cookie({ name: "wide", domain: ".localhost" }), cookie({ name: "hostonly-box", domain: "box.localhost", hostOnly: true }), cookie({ name: "__Host-status" }));
  const { state, dropped } = checkPayload(p, BOX, NAMES);
  assert.equal(dropped, 6);
  assert.deepEqual(state.cookies.map((c: any) => c.name), ["sid", "pref", "part", "strict"]);
  // The names come from set_sessions' box: with no names given, only the prefix and the hosts drop a cookie.
  const q = valid();
  q.cookies.push(cookie({ name: "__Host-session" }));
  assert.equal(checkPayload(q, BOX, []).dropped, 0);
  assert.equal(checkPayload(q, BOX, ["__Host-session"]).dropped, 1);
});

test("a host-only cookie of another host is no box cookie", () => {
  const p = valid();
  p.cookies = [cookie({ name: "h", domain: "www.site.localhost", hostOnly: true })];
  const { state, dropped } = checkPayload(p, ["site2.localhost"], NAMES);
  assert.equal(dropped, 0);
  assert.equal(state.cookies.length, 1);
});

test("the box hosts are a list of one bare host or more; each is normalized; any other value is refused (field box_hosts)", () => {
  for (const v of [null, [], [""], ["  "], [5], "box.localhost", { a: 1 }, ["box.localhost", null], undefined]) assert.throws(() => checkBoxHosts(v), (e: any) => e instanceof PayloadError && e.field === "box_hosts", JSON.stringify(v));
  for (const [raw, host] of [["Box.Localhost.", "box.localhost"], [" b.localhost ", "b.localhost"], ["box.localhost:8081", "box.localhost"], ["BOX.localhost.:443", "box.localhost"],
    ["localhost", "localhost"], ["localhost:8081", "localhost"], ["127.0.0.1:8081", "127.0.0.1"], ["[::1]:8081", "::1"], ["[::1]", "::1"], ["::1", "::1"], ["[FE80::1]", "fe80::1"]]) {
    assert.deepEqual(checkBoxHosts([raw]), [host], raw);
  }
  for (const raw of ["http://box.localhost", "box.localhost/x", "a b.localhost", "box.localhost:", "box.localhost:123456", "box.localhost:http", "[zz]", "[1.2.3.4]", "bücher.localhost",
    "user@box.localhost", "box..localhost", ".", "box.localhost..", "[::1]:x"]) {
    assert.throws(() => checkBoxHosts(["ok.localhost", raw]), (e: any) => e.field === "box_hosts", raw);
  }
  assert.equal(refusal(valid(), []).field, "box_hosts", "the payload check checks the box hosts too");
  assert.equal(refusal(valid(), null).field, "box_hosts", "no set_sessions yet: no box hosts");
});

test("box cookies match a box host given with a port; a send of the box's domain is refused whatever form the box host has", () => {
  const p = valid();
  p.cookies.push(cookie({ name: "upper", domain: "BOX.localhost", hostOnly: true }), cookie({ name: "dot", domain: "box.localhost.", hostOnly: true }),
    cookie({ name: "lead", domain: ".box.localhost", hostOnly: true }), cookie({ name: "dom", domain: ".box.localhost" }), cookie({ name: "dom-upper", domain: ".BOX.Localhost" }));
  const { state, dropped } = checkPayload(p, ["box.localhost:8081"], NAMES);
  assert.equal(dropped, 5);
  assert.deepEqual(state.cookies.map((c: any) => c.name), ["sid", "pref", "part", "strict"]);
  for (const box of ["box.localhost:8081", "BOX.localhost.", "box.localhost.:8081"]) {
    const q = { v: 1, domain: "box.localhost", url: "https://box.localhost:8081/x", origin: "https://box.localhost:8081", cookies: [cookie({ name: "x", domain: "box.localhost", hostOnly: true })], storage: { local: {}, session: {}, idb: [], caches: [] } };
    assert.equal(refusal(q, [box]).field, "domain", box);
  }
});

test("the check leaves its input as it is", () => {
  const p = valid();
  p.cookies.push(cookie({ name: "agentwatch_x" }));
  const before = JSON.stringify(p);
  checkPayload(p, BOX, NAMES);
  assert.equal(JSON.stringify(p), before);
});

// ------------------------------------------------------------------ the texts of a send (C4 choice 6, C6 step 5)

const SENT = (d: string) => `The sign-in for ${d} was sent. It is on no repo's list: add the site to the lists of the repos whose agents need it.`;

test("the send texts: sent, a step after the cookie swap (sent), the swap, a step before it, a timeout, and another error", () => {
  assert.deepEqual(SEND_STEPS_BEFORE_SWAP, ["close tabs"]);
  assert.equal(SEND_STEP_SWAP, "cookies");
  assert.deepEqual(SEND_STEPS_AFTER_SWAP, ["open tab", "rules", "attach", "fetch enable", "restore page", "codec", "write storage", "detach", "navigate", "end rules"]);
  assert.deepEqual(sendText("x.example", null), { sent: true, text: SENT("x.example") });
  for (const step of SEND_STEPS_AFTER_SWAP) {
    assert.deepEqual(sendText("x.example", step), { sent: true, text: `The sign-in for x.example was sent, but the import did not complete: the step "${step}" failed after the cookies were set, so the site's page storage can be missing.` });
  }
  assert.deepEqual(sendText("x.example", "close tabs"), { sent: false, text: 'The sign-in for x.example was not sent: the step "close tabs" failed (a page of the site stayed open). Nothing changed.' });
  assert.deepEqual(sendText("x.example", "cookies"), { sent: false, text: 'The sign-in for x.example failed during the step "cookies": its cookies in the agent browser can be partly replaced. Send it again.' });
  assert.deepEqual(sendText("x.example", "timeout"), { sent: false, text: "The agent browser did not answer the sign-in for x.example in time: it can be sent in part or in full." });
  assert.equal(sendText("x.example", "invalid state").text, "The sign-in for x.example was not sent: invalid state.");
  assert.equal(sendText("x.example", "Xvfb not found on PATH.").text, "The sign-in for x.example was not sent: Xvfb not found on PATH.");
  assert.equal(sendText("x.example", "").text, "The sign-in for x.example was not sent.");
});

test("a wrapped error that starts with The, A or An starts lowercase; another first word keeps its case", () => {
  assert.equal(sendText("site.localhost", RECEIVER_MISSING_TEXT).text, "The sign-in for site.localhost was not sent: the agent extension of the agent browser did not connect in 45 s.");
  assert.equal(sendText("site.localhost", NOT_CONNECTED_TEXT).text, "The sign-in for site.localhost was not sent: the agent extension is not connected.");
  assert.equal(sendText("site.localhost", "A thing failed").text, "The sign-in for site.localhost was not sent: a thing failed.");
  assert.equal(sendText("site.localhost", "Google Chrome is not installed").text, "The sign-in for site.localhost was not sent: Google Chrome is not installed.");
});

test("every send text fits the sender's cut (300 UTF-16 units), also for a long domain: the domain shows as … and its last 63 characters", () => {
  assert.equal(SEND_TEXT_MAX, 300);
  assert.equal(SEND_DOMAIN_SHOWN, 64);
  const long = Array(4).fill("a".repeat(60)).join(".") + ".example";
  assert.equal(long.length, 251);
  for (const error of [null, "write storage", "cookies", "close tabs", "timeout", RECEIVER_MISSING_TEXT, NOT_CONNECTED_TEXT, "x".repeat(400), "\u{1F600}".repeat(200)]) {
    const { sent, text } = sendText(long, error);
    assert.ok(text.length <= SEND_TEXT_MAX, `${String(error).slice(0, 20)}: ${text.length}`);
    assert.equal(sent, sendText("x.example", error).sent);
    assert.ok(text.includes("…" + long.slice(-63)), String(error).slice(0, 20));
    assert.ok(!text.includes(long));
    assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(text), "no half of a surrogate pair");
    const short = sendText("x.example", error).text;
    if (error === null || error.length < 250) assert.ok(!short.includes("…"), String(error));
  }
});
