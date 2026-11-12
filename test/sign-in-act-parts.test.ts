// The parts around the sign-in act (board ab-v16.97.4): the store's check 2 (one approved record of a name; two of one
// name break each other: PR #112's open point 4, C11's vector), stage 1c's import path for the move (no `error` event),
// the receiver's act requests on channel main and the hello's feature by membership, the X move of the act window, the
// CLI's sign-in and sign-ins, C12's `sign_in` end with `dropped`, and the receiver's shared act vector (chrome-extension
// main eda8df0, test/vectors/act.json) against the requests that the act builds. Every value is a made-up TEST value.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignInStore } from "../src/service/signins/store.ts";
import { Stage1c } from "../src/service/stage1c.ts";
import { ReceiverError, type ReceiverPort } from "../src/service/receiver.ts";
import { LinkReceiverPort } from "../src/service/link/link.ts";
import { geometryOf, OFF_SCREEN_GAP, xScreen } from "../src/service/signins/screen.ts";
import { eventFits } from "../src/service/control.ts";
import { main } from "../src/cli.ts";
import { harness, lineOf } from "./fake-bridge.ts";
import { ActWorld, ORIGIN } from "./act-fakes.ts";
import { PassThrough } from "node:stream";

const control = JSON.parse(readFileSync(new URL("./vectors/control.json", import.meta.url), "utf8"));
const actV = JSON.parse(readFileSync(new URL("./vectors/chrome-extension-eda8df0/act.json", import.meta.url), "utf8"));
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const rec = (id: string, name: string, o: Record<string, unknown> = {}) => ({ v: 1, id, gen: 1, name, origin: "https://staging.example.com", path: "/login", send_to: ["https://staging.example.com"], repos: null, by: "operator", approved: true,
  state: "usable", added: null, changed: null, sealed: { epk: "AA", iv: "AA", ct: "AA", tag: "AA" }, ...o });

test("check 2 (C11, vector checkTwo): the one approved record of a name; an offer that waits, a bad shape and two approved records of one name give none", () => {
  const dir = tmp("ab-act-store-");
  try {
    const s = new SignInStore({ stateFolder: dir, log: () => {}, protections: () => null });
    const v = control.checkTwo;
    assert.ok(v, "the vector");
    assert.deepEqual(s.handle({ t: "req", id: "a", op: "sign_ins", by: { kind: "daemon", user: "ann", via: "daemon" }, key: null, records: v.records } as any), { data: { records: v.records.length } });
    for (const c of v.cases) assert.equal(s.named(c.name)?.fields.id ?? null, c.id, `${c.name}: ${c.note}`);
    assert.deepEqual(s.usable().map((r) => r.name).sort(), v.usable);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the move through stage 1c's import path: C2's check and the box's rule, then C4's import; the import's log line with counts only, and no error event", async () => {
  const dir = tmp("ab-act-move-");
  try {
    const sent: any[] = [], logs: string[] = [], events: any[] = [];
    let answer: Record<string, unknown> = { cookies_removed: 0, cookies_set: 1, tabs_closed: 1, local: 1, session: 0, idb_databases: 0, idb_records: 0, cache_entries: 0, errors: [] };
    const port: ReceiverPort = { attach() {}, isUp: () => true, request: async (op, body) => { sent.push([op, body]); return answer; }, allowlist() {}, endScope() {} };
    const s1c = new Stage1c({ listsFolder: join(dir, "lists"), stateFolder: join(dir, "state"), receiver: port, log: (l) => logs.push(l) });
    s1c.attach((ev) => events.push(ev));
    s1c.setSessions({ t: "req", id: "s", op: "set_sessions", sessions: [], remote: [], box: { hosts: ["box.localhost"], cookie_names: ["aw_box"] } } as any);
    const cookie = { name: "sid", value: "test-session-value", domain: "login.localhost", hostOnly: true, path: "/", secure: false, httpOnly: true, sameSite: "lax", session: true };
    const payload = { v: 1, domain: "login.localhost", origin: ORIGIN, url: `${ORIGIN}/`, cookies: [cookie, { ...cookie, name: "aw_box" }], storage: { local: { token: "test-local" }, session: {}, idb: [], caches: [] } };
    assert.equal(await s1c.moveSignIn(payload), true);
    const imports = () => sent.filter((x) => x[0] === "import");
    assert.equal(imports().length, 1);
    assert.deepEqual(imports()[0][1].state.cookies.map((c: any) => c.name), ["sid"], "the box's cookie never moves");
    assert.ok(logs.some((l) => l === "signin: imported a sign-in for login.localhost: 1 cookies set, 1 box cookies dropped, 1 storage keys, 0 databases, 0 cache entries, 0 problems"));
    assert.ok(!logs.join("\n").includes("test-session-value") && !logs.join("\n").includes("test-local"), "no value in a line");
    // An import with problems is a failed move, and still no error event (the act's end event gives the result).
    answer = { ...answer, errors: ["sid: refused"] };
    assert.equal(await s1c.moveSignIn(payload), false);
    // A payload that C2 refuses: no request; a receiver that is down: no request.
    assert.equal(await s1c.moveSignIn({ ...payload, domain: "box.localhost", origin: "http://box.localhost:8080", url: "http://box.localhost:8080/" }), false);
    assert.equal(imports().length, 2, "no import of a refused payload");
    assert.deepEqual(events, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the receiver port of the act: the hello's features by membership (C4: a list); act_rules, act_cookies and act_end go on channel main with their wait; no link: down", async () => {
  const reqs: any[] = [];
  let connected = true, features = new Set(["later", "act", "scopes"]);
  const link = { connected: () => connected, scopesReady: () => true, features: () => features, attach() {}, request: async (op: string, body: object, ms: number) => { reqs.push([op, body, ms]); return { rules: [10] }; } };
  const port = new LinkReceiverPort(link as any, null);
  assert.ok(port.features().has("act"), "a receiver with more features than the service knows has the act");
  features = new Set(["scopes"]);
  assert.ok(!port.features().has("act"));
  assert.deepEqual(await port.act("act_rules", { tab: 31, origin: ORIGIN, send_to: [ORIGIN] }, 10_000), { rules: [10] });
  assert.deepEqual(reqs, [["act_rules", { tab: 31, origin: ORIGIN, send_to: [ORIGIN] }, 10_000]]);
  connected = false;
  await assert.rejects(port.act("act_end", {}, 10_000), (e) => e instanceof ReceiverError && e.kind === "down");
});

test("the receiver's shared act vector (chrome-extension eda8df0): the act's windows.create, act_rules, act_cookies and act_end are the vector's requests; its cookies make a C2 payload", async () => {
  const w = new ActWorld();
  w.store.records[0] = { ...w.store.records[0], origin: "https://staging.example.com", send_to: actV.rulesReq.send_to };
  w.entries = ["example.com"];
  w.pages = new Map([["https://staging.example.com/login", { href: "https://staging.example.com/login", origin: "https://staging.example.com", fields: [{ i: 0, type: "email", visible: true, enabled: true, form: 0, autocomplete: "username", name: "", id: "", maxLength: -1, box: { x: 100, y: 100, w: 240, h: 32 } }, { i: 1, type: "password", visible: true, enabled: true, form: 0, autocomplete: "", name: "", id: "", maxLength: -1, box: { x: 100, y: 150, w: 240, h: 32 } }], forms: [{ method: "post", action: "https://staging.example.com/login" }], framePassword: false, submit: { x: 100, y: 220, w: 120, h: 36 } }],
    ["https://staging.example.com/home", { href: "https://staging.example.com/home", origin: "https://staging.example.com", fields: [], forms: [], framePassword: false, local: {} }]]);
  w.submitTo = "https://staging.example.com/home";
  w.cookies = actV.cookiesRes.data.cookies;
  w.windowCreate = () => actV.actWindow.res.data;
  await w.act().signIn({ scope: actV.scope, admission: "local" }, { name: "staging" });
  const strip = (r: any) => { const { t, id, op, ...body } = r; void t; void id; void op; return body; };
  assert.deepEqual(w.log.find((r) => r.what === "windows.create")!.detail, actV.actWindow.req.args);
  assert.deepEqual(w.log.find((r) => r.what === "act_rules")!.detail, strip(actV.rulesReq));
  assert.deepEqual(w.log.find((r) => r.what === "act_cookies")!.detail, strip(actV.cookiesReq));
  assert.deepEqual(w.log.find((r) => r.what === "act_end")!.detail, strip(actV.endReq));
  assert.deepEqual(w.moved[0].cookies, actV.cookiesRes.data.cookies, "the act_cookies answer moves as it is (C2's form)");
  assert.ok(actV.features.includes("act"));
});

test("the X move: the act window by its title marker to the right of the screen; a popup's window by its bounds among the new windows; only DISPLAY and XAUTHORITY; no xdotool or no Xvfb moves nothing", async () => {
  const calls: string[][] = [];
  const geo: Record<string, string> = { "11": "Window 11\n  Position: 0,0 (screen: 0)\n  Geometry: 1280x800", "22": "Window 22\n  Position: 10,10 (screen: 0)\n  Geometry: 400x300", "33": "Window 33\n  Position: 10,10 (screen: 0)\n  Geometry: 400x300" };
  let visible = ["11", "33"];
  const run = () => async (args: string[]) => {
    calls.push(args);
    if (args[0] === "search" && args.includes("--onlyvisible")) return { code: 0, out: visible.join("\n") + "\n" };
    if (args[0] === "search") return { code: 0, out: "22\n" };
    if (args[0] === "getwindowgeometry") return { code: 0, out: geo[args[1]] };
    return { code: 0, out: "" };
  };
  const d = { display: ":171", xauth: "/x/auth", size: { width: 1280, height: 800 } };
  const s = xScreen({ display: () => d, xdotool: "/usr/bin/xdotool", run });
  await s.snapshot();
  assert.equal(await s.moveOff("aw-act-0123456789abcdef"), 1);
  assert.deepEqual(calls.find((c) => c[0] === "windowmove"), ["windowmove", "22", String(1280 + OFF_SCREEN_GAP), "0"]);
  assert.equal(await s.moveOff("not a marker; rm -rf"), 0, "only a marker of 16 hex digits");
  visible = ["11", "22", "33", "44"];
  geo["44"] = "Window 44\n  Position: 10,10 (screen: 0)\n  Geometry: 400x300";
  calls.length = 0;
  assert.equal(await s.movePopup({ left: 10, top: 10, width: 400, height: 300 }), 1, "33 was there before the act; 22 is the act window");
  assert.deepEqual(calls.filter((c) => c[0] === "windowmove"), [["windowmove", "44", "1480", "0"]]);
  assert.deepEqual(geometryOf(geo["44"]), { left: 10, top: 10, width: 400, height: 300 });
  assert.equal(await xScreen({ display: () => null, xdotool: "/usr/bin/xdotool", run }).moveOff("aw-act-0123456789abcdef"), 0);
  assert.equal(await xScreen({ display: () => d, xdotool: null }).moveOff("aw-act-0123456789abcdef"), 0);
});

test("C12's sign_in end: `dropped` only on an end, a positive count; every other field as before", () => {
  const end = control.events.find((e: any) => e.ev.ev === "sign_in" && e.ev.phase === "end" && e.ev.result === "no_such_name").ev;
  assert.ok(eventFits(end));
  assert.ok(eventFits({ ...end, dropped: 4 }));
  assert.ok(!eventFits({ ...end, dropped: 0 }));
  assert.ok(!eventFits({ ...end, dropped: "4" }));
  const start = control.events.find((e: any) => e.ev.ev === "sign_in" && e.ev.phase === "start").ev;
  assert.ok(!eventFits({ ...start, dropped: 1 }), "a start has no dropped");
  assert.ok(control.events.some((e: any) => e.ev.ev === "sign_in" && e.ev.dropped === 4), "the vector of an end past the rate");
});

async function cli(args: string[]): Promise<{ status: number | "serve"; out: string; err: string }> {
  const stdout = new PassThrough(), stderr = new PassThrough();
  let out = "", err = "";
  stdout.on("data", (d) => (out += d)); stderr.on("data", (d) => (err += d));
  const status = await main(args, { stdout, stderr, stdin: new PassThrough() });
  return { status, out, err };
}

test("the CLI: sign-in <name> and sign-ins send their method on the endpoint's root (the scope is the connection's); a refusal prints C11's text and exits 1; no --cdp-url is a usage error", async () => {
  const h = await harness();
  const dir = tmp("ab-act-cli-");
  try {
    await h.ready(lineOf(["login.localhost"]));
    const calls: any[] = [];
    h.relay.model.setSignIns({
      signIn: async (c, p) => { calls.push([c, p]); if (p.name !== "staging") throw new Error("Not signed in: There is no stored sign-in named other for this repo."); return { signedIn: true, name: "staging", origin: ORIGIN }; },
      signIns: (c) => { calls.push([c]); return { state: "open", signIns: [{ name: "staging", origin: ORIGIN }] }; },
    });
    const base = ["--state-dir", dir, "--cdp-url", h.url("web-1")];
    let r = await cli(["sign-in", "staging", ...base]);
    assert.equal(r.status, 0);
    assert.equal(r.out, `Signed in to ${ORIGIN}. Your tabs of this site were closed for the sign-in; open the site again: it loads signed in.\n`);
    r = await cli(["sign-in", "staging", ...base, "--json"]);
    assert.deepEqual(JSON.parse(r.out), { ok: true, command: "sign-in", signedIn: true, name: "staging", origin: ORIGIN, text: `Signed in to ${ORIGIN}. Your tabs of this site were closed for the sign-in; open the site again: it loads signed in.` });
    r = await cli(["sign-in", "other", ...base]);
    assert.equal(r.status, 1);
    assert.equal(r.err, "agent-browser: Not signed in: There is no stored sign-in named other for this repo.\n");
    r = await cli(["sign-ins", ...base, "--json"]);
    assert.deepEqual(JSON.parse(r.out), { ok: true, command: "sign-ins", state: "open", signIns: [{ name: "staging", origin: ORIGIN }] });
    assert.deepEqual(calls.map((c) => c[0]), Array(4).fill({ scope: "web-1", admission: "local" }));
    assert.equal((await cli(["sign-in", "--state-dir", dir])).status, 2, "a name is needed");
    assert.equal((await cli(["sign-in", "staging", "--state-dir", dir])).status, 2, "--cdp-url is needed");
    assert.equal((await cli(["sign-ins", "x", ...base])).status, 2);
  } finally { await h.close(); rmSync(dir, { recursive: true, force: true }); }
});
