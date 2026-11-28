// The blanket scope's "*" (board ab-4wh.3): the host class (src/host-class.ts), agent-browser's client list
// (src/allowlist.ts: {"allow":["*"]} of agentwatch's list copy), the relay's parse of a blanket line (only the blanket
// Chrome's model takes "*"), its layer 1 (offList), and the endpoint's routing: the blanket scope reaches only the
// blanket Chrome's model and bridge, and no other scope ever reaches it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ANY_HOST, publicHost, publicUrl } from "../src/host-class.ts";
import { isAllowedUrl, loadAllowlist, validateAllowlist } from "../src/allowlist.ts";
import { covers, parseScopes, PUBLIC as STAR } from "../src/relay/scopes.ts";
import { BLANKET_TEXT, offList, outsideClass, TEXT } from "../src/relay/policy.ts";
import { BLANKET_NOT_READY } from "../src/relay/endpoint.ts";
import { NOT_READY } from "../src/relay/model.ts";
import { CDPConnection } from "../src/cdp.ts";
import { FakeReceiver, harness, raw, transportOf, until } from "./fake-bridge.ts";
import { tempDir } from "./temp-dirs.ts";
import { PeerGate } from "../src/relay/peer.ts";
import { Tickets } from "../src/service/mcp/ticket.ts";

const PUBLIC = ["example.com", "www.example.com", "a.b.example.co.uk", "xn--bcher-kva.example", "my-site.io", "example.com.", "a_b.example.org"];
const NOT_PUBLIC = ["localhost", "localhost.", "foo.localhost", "a.b.localhost", "printer.local", "local", "db.internal", "internal", "nas.home.arpa", "home.arpa",
  "localhost.localdomain", "box.localdomain", "localdomain", "a.123-456", "a.0x1f",
  "intranet", "com", "127.0.0.1", "10.0.0.1", "192.168.1.1", "0.0.0.0", "[::1]", "::1", "[fe80::1]", "1.2.3.4", "a.123", "a.0x7f", "", ".", "a..b", "exa mple.com", "*", "*.example.com"];

test("the blanket host class: a DNS name of two labels or more; no IP literal, localhost, *.localhost, single label, .local, .internal or .home.arpa", () => {
  for (const h of PUBLIC) assert.ok(publicHost(h), h);
  for (const h of NOT_PUBLIC) assert.ok(!publicHost(h), h);
  // The URL parser's forms: each IPv4 form is a dotted quad, an IPv6 literal keeps its brackets.
  for (const u of ["http://0x7f000001/", "http://2130706433/", "http://127.1/", "http://[::1]:8080/", "https://localhost:3000/", "http://foo.localhost/", "http://router.local/",
    "http://localhost.localdomain/", "http://0x7f.0x1/", "ftp://example.com/", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "chrome://settings", "blob:http://localhost/x", "about:blank"]) assert.ok(!publicUrl(u), u);
  for (const u of ["https://example.com/a?b", "http://news.example.org:8080/", "blob:https://example.com/0d1c"]) assert.ok(publicUrl(u), u);
});

test("the client: {\"allow\":[\"*\"]} is the blanket class alone; '*' with any other entry is refused", () => {
  assert.deepEqual(validateAllowlist([ANY_HOST]), [ANY_HOST]);
  for (const bad of [["*", "example.com"], ["example.com", "*"], ["*", "*"], ["*.example.com"], [" *"]]) assert.throws(() => validateAllowlist(bad), /allowlist/, JSON.stringify(bad));
  const dir = tempDir("ab-blanket-");
  try {
    const file = join(dir, "allowlist.json");
    writeFileSync(file, JSON.stringify({ allow: ["*"] }));
    const allow = loadAllowlist(file);
    assert.deepEqual(allow, ["*"]);
    for (const u of ["https://example.com/", "https://mail.google.com/mail", "http://news.example.org:8080/a", "about:blank"]) assert.ok(isAllowedUrl(u, allow), u);
    for (const u of ["http://localhost:3000/", "http://127.0.0.1/", "http://[::1]/", "http://intranet/", "http://printer.local/", "http://db.internal/", "http://nas.home.arpa/",
      "http://dev.localhost/", "file:///etc/passwd", "chrome://settings/", "javascript:1"]) assert.ok(!isAllowedUrl(u, allow), u);
    // A normal list keeps its own rules: "*" is no entry of it.
    assert.ok(!isAllowedUrl("https://other.example/", ["example.com"]));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the relay's parse (the receiver 0.3.16's rule, the pin's): a local scope's '*' only in a blanket-shaped object, with no entries; covers() of the blanket model's entries", () => {
  const line = { t: "allowlist", lists: {}, scopes: { bl: "*" }, default: null, operator: null };
  // The parse gives the scope PUBLIC and no entries, in every model: only the blanket model gives it hosts (model.ts).
  const set = parseScopes(line, { namedOnly: true, remote: true });
  assert.equal(set.listOf("bl"), STAR);
  assert.equal(set.entriesOf("bl"), null);
  assert.equal(set.refused, 0);
  assert.deepEqual([...set.lists.keys()], [], "the lists stay empty (the receiver's vector)");
  assert.deepEqual(set.union(), []);
  // "*" as a list name or an entry is refused.
  const named = parseScopes({ lists: { "*": ["a.example"], l: ["*", "b.example"] }, scopes: { s: "l" }, default: null }, { namedOnly: true });
  assert.deepEqual(named.entriesOf("s"), ["b.example"]);
  assert.equal(named.lists.has("*"), false);
  // A remote scope never gets "*" (C12: "blanket" of a remote item is ignored).
  assert.equal(parseScopes({ lists: {}, scopes: { "box/s": "*" }, default: null }, { namedOnly: true, remote: true }).listOf("box/s"), null);
  assert.equal(parseScopes({ ...line, exclude: ["mybox", "mybox.example.net"] }, { namedOnly: true }).listOf("bl"), STAR);
  // As the receiver 0.3.16 (C4): a "*" applies only in a blanket-shaped object with a good exclude; else the WHOLE "*"
  // applies as null (the scope has no list) and counts 1.
  const nine = Array.from({ length: 9 }, (_, i) => `n${i}.example.net`);
  const long = Array.from({ length: 3 }, (_, i) => `${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(55)}${i}.net`);
  for (const [why, m] of [
    ["a name with a space", { ...line, exclude: ["mybox", "Bad Name"] }], ["a number", { ...line, exclude: [5] }], ["no array", { ...line, exclude: "mybox" }],
    ["9 names", { ...line, exclude: nine }], ["more than 512 characters", { ...line, exclude: long }], ["a label that starts with -", { ...line, exclude: ["-box.example.net"] }],
    ["a label that ends with -", { ...line, exclude: ["box-.example.net"] }], ["a label of 64", { ...line, exclude: [`${"a".repeat(64)}.net`] }], ["upper case", { ...line, exclude: ["MyBox"] }],
    ["an IPv4 literal", { ...line, exclude: ["10.0.0.1"] }], ["a list", { ...line, lists: { a: ["b.example"] } }], ["a default", { ...line, default: "a" }],
    ["the operator's *", { ...line, operator: "*" }], ["two scopes", { ...line, scopes: { bl: "*", other: null } }],
  ] as const) {
    const bad = parseScopes(m, { namedOnly: true });
    assert.equal(bad.listOf("bl"), null, why);
    assert.ok(bad.refused >= 1, why);
  }
  assert.equal(long.join("").length > 512 && long.every((n) => n.length <= 253), true);
  assert.equal(parseScopes({ ...line, exclude: nine.slice(0, 8) }, { namedOnly: true }).listOf("bl"), STAR, "8 names pass");
  // The blanket model's entries of such a scope (model.ts, entriesOf): "*" and "!<name>" of each excluded name.
  const entries = [ANY_HOST, "!mybox", "!mybox.example.net"];
  assert.ok(covers([ANY_HOST], "example.com") && !covers([ANY_HOST], "localhost") && !covers([ANY_HOST], "10.0.0.1"));
  for (const h of ["mybox.example.net", "www.mybox.example.net", "MYBOX.example.net", "mybox.example.net."]) assert.ok(!covers(entries, h), h);
  for (const h of ["example.net", "other.example.net", "notmybox.example.net"]) assert.ok(covers(entries, h), h);
  assert.equal(offList("Target.createTarget", { url: "https://mybox.example.net:8443/" }, entries, undefined), "mybox.example.net");
  assert.equal(outsideClass("Network.loadNetworkResource", { url: "http://mybox.example.net/x" }, entries), "mybox.example.net");
  // A normal list never takes "!" (normalizeEntry refuses it).
  assert.deepEqual(parseScopes({ lists: { l: ["!example.com", "b.example"] }, scopes: { s: "l" }, default: null }, { namedOnly: true }).entriesOf("s"), ["b.example"]);
  assert.ok(covers([ANY_HOST], "example.com") && !covers([ANY_HOST], "localhost") && !covers([ANY_HOST], "10.0.0.1"));
  // Layer 1: a top-level navigation of the class passes; a local or IP host is refused with its host.
  assert.equal(offList("Page.navigate", { url: "https://example.com/" }, [ANY_HOST], null), null);
  assert.equal(offList("Target.createTarget", { url: "http://localhost:8080/" }, [ANY_HOST], undefined), "localhost");
  assert.equal(offList("Target.createTarget", { url: "http://192.168.0.1/" }, [ANY_HOST], undefined), "192.168.0.1");
  assert.equal(offList("Page.navigate", { url: "blob:http://dev.localhost/x" }, [ANY_HOST], null), "dev.localhost");
  // The blanket model's other calls that load a URL (outsideClass), on any frame.
  assert.equal(outsideClass("Page.navigate", { url: "http://10.1.2.3/", frameId: "F2" }), "10.1.2.3");
  assert.equal(outsideClass("Network.loadNetworkResource", { url: "http://intranet/x" }), "intranet");
  assert.equal(outsideClass("Fetch.continueRequest", { requestId: "1", url: "http://db.internal/" }), "db.internal");
  assert.equal(outsideClass("Fetch.continueRequest", { requestId: "1" }), null);
  assert.equal(outsideClass("Page.navigate", { url: "https://example.com/" }), null);
  assert.equal(outsideClass("Page.navigate", { url: "data:text/html,x" }), null);
  assert.equal(outsideClass("Runtime.evaluate", { url: "http://localhost/" }), null);
});

test("the routing: the blanket scope reaches only the blanket Chrome's model and bridge; another scope never does", { timeout: 30_000 }, async () => {
  const blanketFake = new FakeReceiver();
  let blanketScope: string | null = "bl";
  const checked: string[] = [];
  const addressCheck = async (host: string) => { checked.push(host); return host === "rebind.example.org" ? "rebind.example.org has a private address" : null; };
  const h = await harness({ blanket: { transport: transportOf(blanketFake), scope: () => blanketScope, addressCheck } } as any);
  const conns: CDPConnection[] = [];
  try {
    assert.ok(h.relay.blanketModel, "the relay has the blanket model");
    const bm = h.relay.blanketModel!;
    // One display, one pointer, one clipboard: the two models share the input stage's lock.
    assert.ok(bm.stageLock !== null && bm.stageLock === h.relay.model.stageLock, "one input lock");
    // The main line gives s1 a.example; the blanket scope is not ready while the blanket link is down.
    await h.ready({ t: "allowlist", lists: { a: ["a.example"] }, scopes: { s1: "a" }, default: null });
    const before = await raw(h.url("bl"));
    assert.deepEqual([before.status, before.body], [503, BLANKET_NOT_READY.link]);
    // The blanket link up, and its line: only "bl", with "*".
    blanketFake.line({ t: "link", up: true, version: "0.3.16" });
    blanketFake.line({ t: "allowlist", lists: {}, scopes: { bl: "*" }, default: null, operator: null, exclude: ["mybox", "mybox.example.net"] });
    await until(() => bm.notReady() === null, "the blanket model to be ready");
    const bl = await CDPConnection.connect(h.url("bl")); conns.push(bl);
    const s1 = await CDPConnection.connect(h.url("s1")); conns.push(s1);
    assert.equal(h.relay.model.connectionCount, 1);
    assert.equal(bm.connectionCount, 1);
    // Each model's own use: its agent's open connection, never the other model's (board ab-4wh.24).
    assert.equal(h.relay.blanketTraffic().agents, 1);
    assert.equal(h.relay.traffic().agents, 1);
    // The blanket scope opens a public host on the blanket Chrome only.
    const mainCreates = h.fake.sent("windows.create").length;
    await bl.send("Target.createTarget", { url: "https://news.example.org/" });
    assert.equal(blanketFake.sent("windows.create").length, 1, "the blanket Chrome's receiver made the tab");
    assert.equal(h.fake.sent("windows.create").length, mainCreates, "the main Chrome got nothing");
    // A local or IP host stays refused for the blanket scope.
    for (const [url, host] of [["http://localhost:3000/", "localhost"], ["http://10.0.0.2/", "10.0.0.2"], ["http://printer.local/", "printer.local"], ["https://mybox.example.net/", "mybox.example.net"],
      ["http://localhost.localdomain/", "localhost.localdomain"], ["https://rebind.example.org/", "rebind.example.org"]]) {
      const m = await bl.send("Target.createTarget", { url }).then(() => "no refusal", (e: Error) => e.message);
      assert.ok(m.endsWith(BLANKET_TEXT.notPublic(host)), `${url}: ${m}`);
    }
    // No prompt: the blanket model sends no daemon.blocked.
    assert.equal(blanketFake.daemonRequests.filter((r) => r.op === "daemon.blocked").length, 0);
    // The address rule with DNS: a public name whose address is private is refused, and the check ran for each URL load.
    assert.ok(checked.includes("rebind.example.org") && checked.includes("news.example.org"), checked.join(" "));
    // Each grant, with or without an origin, and the stored sign-ins, get the blanket texts.
    for (const params of [{ permissions: ["geolocation"] }, { permissions: ["geolocation"], origin: "https://news.example.org" }]) {
      const grant = await bl.send("Browser.grantPermissions", params).then(() => "no refusal", (e: Error) => e.message);
      assert.ok(grant.endsWith(BLANKET_TEXT.grants), grant);
    }
    assert.equal(BLANKET_TEXT.grants, "Not available in the agent browser: permission grants in a session with a blanket approval.");
    for (const method of ["AgentBrowser.signIn", "AgentBrowser.signIns"]) {
      const m = await bl.send(method, { host: "example.com" }).then(() => "no refusal", (e: Error) => e.message);
      assert.ok(m.endsWith(BLANKET_TEXT.signIns), `${method}: ${m}`);
    }
    // s1 keeps its list on the main Chrome; it never reaches the blanket bridge.
    const blanketCreates = blanketFake.sent("windows.create").length;
    const off = await s1.send("Target.createTarget", { url: "https://news.example.org/" }).then(() => "no refusal", (e: Error) => e.message);
    assert.match(off, new RegExp(TEXT.notAllowed("news.example.org").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    await s1.send("Target.createTarget", { url: "https://a.example/" });
    assert.equal(blanketFake.sent("windows.create").length, blanketCreates, "no request of s1 reached the blanket Chrome");
    // The main model gives "*" no host: a main line that gives s1 "*" (the parse's PUBLIC, with no entries) leaves every
    // navigation of s1 refused (fail closed); only the blanket model gives "*" its hosts.
    h.fake.line({ t: "allowlist", lists: {}, scopes: { s1: "*" }, default: null });
    await until(() => h.relay.model.sitesOf("s1") === null, "s1's \"*\" with no entries");
    const star = await s1.send("Target.createTarget", { url: "https://news.example.org/" }).then(() => "no refusal", (e: Error) => e.message);
    assert.match(star, /news\.example\.org is not on the allowlist/);
    // A scope that is no longer the blanket scope goes to the main model (which does not name it).
    blanketScope = null;
    const after = await raw(h.url("bl"));
    assert.deepEqual([after.status, after.body], [503, NOT_READY.noList]);
  } finally {
    for (const c of conns) await c.close().catch(() => {});
    blanketFake.input.end();
    await h.close();
  }
});

// The receiver 0.3.16's cases of "*" (chrome-extension 19e8e22, test/vectors/scopes.json, the cases whose `in` holds a
// "*"), copied here: the blanket model's parse gives the same lists and the same refused count.
const RECEIVER_STAR_CASES: { note: string; in: Record<string, unknown>; refused: number; listOf: Record<string, string | null> }[] = [
 {
  "note": "The operator field (choice 3): \"*\".",
  "in": {
   "lists": {
    "md": [
     "a.example"
    ]
   },
   "scopes": {},
   "default": null,
   "operator": "*"
  },
  "refused": 0,
  "listOf": {}
 },
 {
  "note": "The counts add up: a bad entry (1), a list that is not an array (1), a bad scope (1), a bad operator (1).",
  "in": {
   "lists": {
    "md": [
     "a.example",
     "A.example"
    ],
    "x": {}
   },
   "scopes": {
    "md-lead": "md",
    "-bad": "md"
   },
   "default": null,
   "operator": [
    "*"
   ]
  },
  "refused": 4,
  "listOf": {
   "md-lead": "md"
  }
 },
 {
  "note": "The blanket Chrome's set_scopes (board ab-4wh): one local scope with \"*\", no list, no default, no operator, and exclude: the box's own names, which the scope may not open. A scope that the object does not name has no list.",
  "in": {
   "lists": {},
   "scopes": {
    "web-blanket": "*"
   },
   "default": null,
   "operator": null,
   "exclude": [
    "box.example.net",
    "box"
   ]
  },
  "refused": 0,
  "listOf": {
   "web-blanket": "*",
   "web-other": null
  }
 },
 {
  "note": "A scope's \"*\" next to a list and the operator's \"*\" (board ab-4wh, review M6): a \"*\" applies only in a blanket-shaped object (no list, no default, no operator, one scope), so here it counts 1 and applies as null; the list and the operator's \"*\" apply.",
  "in": {
   "lists": {
    "md": [
     "a.example"
    ]
   },
   "scopes": {
    "md-lead": "md",
    "web-blanket": "*"
   },
   "default": "md",
   "operator": "*"
  },
  "refused": 1,
  "listOf": {
   "md-lead": "md",
   "web-blanket": null,
   "md-new": "md"
  }
 },
 {
  "note": "A bad exclude (board ab-4wh, review I1): a name that is not as C5 writes an entry (here a trailing dot) makes the object's \"*\" count 1 and apply as null (fail closed).",
  "in": {
   "lists": {},
   "scopes": {
    "web-blanket": "*"
   },
   "default": null,
   "operator": null,
   "exclude": [
    "box.example.net."
   ]
  },
  "refused": 1,
  "listOf": {
   "web-blanket": null
  }
 },
 {
  "note": "A default \"*\" (board ab-4wh, review M2): \"*\" is no valid name, so the default counts 1 and applies as null, and the object is no blanket shape, so the scope's \"*\" counts 1 and applies as null too.",
  "in": {
   "lists": {},
   "scopes": {
    "web-blanket": "*"
   },
   "default": "*",
   "operator": null
  },
  "refused": 2,
  "listOf": {
   "web-blanket": null,
   "web-other": null
  }
 },
 {
  "note": "A remote scope's \"*\" (board ab-4wh): the blanket profile is for local scopes only, so it counts 1 and applies as null (no list, no fall-back); a value that only looks like \"*\" is no valid name either.",
  "in": {
   "lists": {},
   "scopes": {
    "linux/web-1": "*",
    "web-2": "**",
    "web-3": " *"
   },
   "default": null
  },
  "refused": 3,
  "listOf": {
   "linux/web-1": null,
   "web-2": null,
   "web-3": null
  }
 }
];

test("the blanket model's parse agrees with the receiver 0.3.16's cases of \"*\" (the shape, the bad exclude, the default and the remote scope)", () => {
  assert.ok(RECEIVER_STAR_CASES.length >= 5);
  for (const c of RECEIVER_STAR_CASES) {
    const set = parseScopes(c.in, { remote: true });
    assert.equal(set.refused, c.refused, c.note);
    for (const [scope, list] of Object.entries(c.listOf)) assert.equal(set.listOf(scope), list, `${c.note}: ${scope}`);
  }
});

test("M3, ab-4wh.28: an MCP's own ticket connection is no use of the blanket model, neither by being open nor by its messages (C12, the use)", { timeout: 30_000 }, async () => {
  const uid = process.getuid!();
  // Every peer is the service's own pid (the MCP inside the service), with a live ticket: its connections are the MCP's own.
  const reader = { form: "stat", peer: () => ({ pid: 2900, uid, pidfd: null, start: 5 }), proc: () => ({ ppid: 1, start: 5, state: "S" }), cgroup: () => null,
    poll: () => 0, fdinfoPid: () => 0, close: () => {} } as any;
  const tickets = new Tickets({ pid: 2900 });
  const blanketFake = new FakeReceiver();
  const h = await harness({ peerCheck: new PeerGate({ reader, uid }), tickets, blanket: { transport: transportOf(blanketFake), scope: () => "bl" } } as any);
  let mcpConn: CDPConnection | null = null;
  try {
    await h.ready({ t: "allowlist", lists: {}, scopes: {}, default: null, roots: {} });
    blanketFake.line({ t: "link", up: true, version: "0.3.16" });
    blanketFake.line({ t: "allowlist", lists: {}, scopes: { bl: "*" }, default: null, operator: null, exclude: [], roots: {} });
    await until(() => h.relay.blanketModel!.notReady() === null, "the blanket model to be ready");
    assert.deepEqual(h.relay.blanketTraffic(), { agents: 0, busy: 0, quietFor: Infinity });
    mcpConn = await CDPConnection.connect(`${h.url("bl")}?ticket=${tickets.mint("bl")}`);
    assert.equal(h.relay.blanketModel!.connectionCount, 1, "the MCP's own connection is open");
    assert.equal(h.relay.blanketTraffic().agents, 0, "an open MCP connection is no use by itself");
    assert.equal(h.relay.blanketTraffic().quietFor, Infinity);
    await mcpConn.send("Browser.getVersion");
    assert.deepEqual(h.relay.blanketTraffic(), { agents: 0, busy: 0, quietFor: Infinity }, "its message is no use");
    blanketFake.op = ({ op }) => (op === "windows.create" || op === "tabs.create" ? new Promise(() => {}) : undefined);
    void mcpConn.send("Target.createTarget", { url: "https://news.example.org/" }).catch(() => {});
    await until(() => blanketFake.sent("windows.create").length + blanketFake.sent("tabs.create").length > 0, "the held bridge call");
    assert.deepEqual(h.relay.blanketTraffic(), { agents: 0, busy: 0, quietFor: Infinity }, "its message that runs is no use");
    // The main model's traffic is not the blanket model's.
    assert.equal(h.relay.traffic().agents, 0);
  } finally {
    await mcpConn?.close().catch(() => {});
    blanketFake.input.end();
    await h.close();
  }
});

test("ab-4wh.24: traffic() is the main model's use alone: the blanket scope's open connection and its messages count only in blanketTraffic(), and another scope's only in traffic()", { timeout: 30_000 }, async () => {
  const blanketFake = new FakeReceiver();
  const h = await harness({ blanket: { transport: transportOf(blanketFake), scope: () => "bl" } } as any);
  const conns: CDPConnection[] = [];
  const hold = (fr: FakeReceiver) => { fr.op = ({ op }) => (op === "windows.create" || op === "tabs.create" ? new Promise(() => {}) : undefined); };
  try {
    await h.ready({ t: "allowlist", lists: { a: ["a.example"] }, scopes: { s1: "a" }, default: null });
    blanketFake.line({ t: "link", up: true, version: "0.3.16" });
    blanketFake.line({ t: "allowlist", lists: {}, scopes: { bl: "*" }, default: null, operator: null, exclude: [] });
    await until(() => h.relay.blanketModel!.notReady() === null, "the blanket model to be ready");
    const bl = await CDPConnection.connect(h.url("bl")); conns.push(bl);
    // The blanket scope's open connection is the blanket model's use only.
    assert.deepEqual([h.relay.blanketTraffic().agents, h.relay.traffic().agents], [1, 0]);
    assert.equal(h.relay.traffic().quietFor, Infinity);
    // A message of the blanket scope, and one that runs (the blanket receiver holds its bridge call).
    await bl.send("Browser.getVersion");
    hold(blanketFake);
    void bl.send("Target.createTarget", { url: "https://news.example.org/" }).catch(() => {});
    await until(() => h.relay.blanketTraffic().busy === 1, "the blanket scope's message that runs");
    assert.ok(h.relay.blanketTraffic().quietFor < 5_000);
    assert.deepEqual(h.relay.traffic(), { agents: 0, busy: 0, quietFor: Infinity }, "no use of the main model");
    // Another scope's open connection and its message that runs are the main model's use only.
    const s1 = await CDPConnection.connect(h.url("s1")); conns.push(s1);
    assert.deepEqual([h.relay.traffic().agents, h.relay.blanketTraffic().agents], [1, 1]);
    hold(h.fake);
    void s1.send("Target.createTarget", { url: "https://a.example/" }).catch(() => {});
    await until(() => h.relay.traffic().busy === 1, "the main scope's message that runs");
    assert.ok(h.relay.traffic().quietFor < 5_000);
    assert.equal(h.relay.blanketTraffic().busy, 1, "the blanket model's own message runs on");
  } finally {
    for (const c of conns) await c.close().catch(() => {});
    blanketFake.input.end();
    await h.close();
  }
});

// The blanket profile's vectors (test/vectors/endpoint.json; board ab-4wh.7): step 4's two texts, and each refusal of
// blanketRefusals on a connection of the blanket scope, with its exact text. The relay runs with the blanket line of the
// vectors (here with no roots: this relay has no peer check; test/relay-peer.test.ts runs the blanket cases with it).
test("the vectors' blanketAnswers are the relay's texts, and each blanketRefusals call of the blanket scope gets its exact text", { timeout: 30_000 }, async () => {
  const V = JSON.parse(readFileSync(new URL("./vectors/endpoint.json", import.meta.url), "utf8"));
  assert.deepEqual(V.blanketAnswers.map((a: any) => a.body), [BLANKET_NOT_READY.link, BLANKET_NOT_READY.old]);
  assert.equal(V.blanketRefusals.find((r: any) => r.method === "Browser.grantPermissions").error, BLANKET_TEXT.grants);
  assert.equal(V.blanketRefusals.find((r: any) => r.method === "AgentBrowser.signIn").error, BLANKET_TEXT.signIns);
  const blanketFake = new FakeReceiver();
  const h = await harness({ blanket: { transport: transportOf(blanketFake), scope: () => "md-worker" } } as any);
  let c: CDPConnection | null = null;
  try {
    await h.ready({ ...V.lines.blanketMain, roots: undefined });
    const { roots, ...line } = V.lines.blanket;
    assert.ok(roots, "the vectors' line has roots");
    blanketFake.line({ t: "link", up: true, version: "0.3.16" });
    blanketFake.line(line);
    await until(() => h.relay.blanketModel!.notReady() === null, "the blanket model to be ready");
    c = await CDPConnection.connect(h.url("md-worker"));
    assert.equal(h.relay.blanketModel!.connectionCount, 1);
    for (const r of V.blanketRefusals) {
      // The client's error names the method first (as relay.test.ts reads the refusals).
      const got: string = await c.send(r.method, r.params).then(() => "no refusal", (e: Error) => e.message);
      assert.equal(got, `${r.method}: ${r.error}`, `${r.method} ${JSON.stringify(r.params)}`);
    }
    assert.equal(blanketFake.sent("windows.create").length + blanketFake.sent("tabs.create").length, 0, "no refusal reached the blanket Chrome");
    // A public host passes (the class), on the blanket Chrome.
    await c.send("Target.createTarget", { url: "https://news.example.org/" });
    assert.equal(blanketFake.sent("windows.create").length + blanketFake.sent("tabs.create").length, 1);
  } finally {
    await c?.close().catch(() => {});
    blanketFake.input.end();
    await h.close();
  }
});
