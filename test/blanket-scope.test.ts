// The blanket scope's "*" (board ab-4wh.3): the host class (src/host-class.ts), agent-browser's client list
// (src/allowlist.ts: {"allow":["*"]} of agentwatch's list copy), the relay's parse of a blanket line (only the blanket
// Chrome's model takes "*"), its layer 1 (offList), and the endpoint's routing: the blanket scope reaches only the
// blanket Chrome's model and bridge, and no other scope ever reaches it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ANY_HOST, publicHost, publicUrl } from "../src/host-class.ts";
import { isAllowedUrl, loadAllowlist, validateAllowlist } from "../src/allowlist.ts";
import { BLANKET_LIST, covers, parseScopes } from "../src/relay/scopes.ts";
import { offList, outsideClass, TEXT } from "../src/relay/policy.ts";
import { BLANKET_NOT_READY, type RelayTransport } from "../src/relay/endpoint.ts";
import { NOT_READY } from "../src/relay/model.ts";
import { CDPConnection } from "../src/cdp.ts";
import { FakeReceiver, harness, raw, until } from "./fake-bridge.ts";
import { tempDir } from "./temp-dirs.ts";

const PUBLIC = ["example.com", "www.example.com", "a.b.example.co.uk", "xn--bcher-kva.example", "my-site.io", "example.com.", "a_b.example.org"];
const NOT_PUBLIC = ["localhost", "localhost.", "foo.localhost", "a.b.localhost", "printer.local", "local", "db.internal", "internal", "nas.home.arpa", "home.arpa",
  "intranet", "com", "127.0.0.1", "10.0.0.1", "192.168.1.1", "0.0.0.0", "[::1]", "::1", "[fe80::1]", "1.2.3.4", "a.123", "a.0x7f", "", ".", "a..b", "exa mple.com", "*", "*.example.com"];

test("the blanket host class: a DNS name of two labels or more; no IP literal, localhost, *.localhost, single label, .local, .internal or .home.arpa", () => {
  for (const h of PUBLIC) assert.ok(publicHost(h), h);
  for (const h of NOT_PUBLIC) assert.ok(!publicHost(h), h);
  // The URL parser's forms: each IPv4 form is a dotted quad, an IPv6 literal keeps its brackets.
  for (const u of ["http://0x7f000001/", "http://2130706433/", "http://127.1/", "http://[::1]:8080/", "https://localhost:3000/", "http://foo.localhost/", "http://router.local/",
    "ftp://example.com/", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "chrome://settings", "blob:http://localhost/x", "about:blank"]) assert.ok(!publicUrl(u), u);
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

test("the relay's parse: '*' is a scope value only in the blanket Chrome's model, and covers the class only", () => {
  const line = { t: "allowlist", lists: {}, scopes: { bl: "*" }, default: null, operator: "*" };
  // The main model (no `blanket`): the scope has no list, and the refusal counts it.
  const main = parseScopes(line, { namedOnly: true, remote: true });
  assert.equal(main.entriesOf("bl"), null);
  assert.equal(main.refused, 1);
  // "*" as a list name or an entry is refused in both.
  for (const blanket of [false, true]) {
    const set = parseScopes({ lists: { "*": ["a.example"], l: ["*", "b.example"] }, scopes: { s: "l" }, default: null }, { namedOnly: true, blanket });
    assert.deepEqual(set.entriesOf("s"), ["b.example"]);
    assert.equal(set.lists.has("*"), false);
  }
  const b = parseScopes(line, { namedOnly: true, blanket: true });
  assert.deepEqual(b.entriesOf("bl"), [ANY_HOST]);
  assert.equal(b.listOf("bl"), BLANKET_LIST);
  assert.equal(b.refused, 0);
  // A remote scope never gets "*" (C12: "blanket" of a remote item is ignored).
  assert.equal(parseScopes({ lists: {}, scopes: { "box/s": "*" }, default: null }, { namedOnly: true, remote: true, blanket: true }).entriesOf("box/s"), null);
  // The union of automatic downloads never holds "*".
  assert.deepEqual(b.union(), []);
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

/** The service's in-process bridge (RelayTransport) to a FakeReceiver: its lines are the transport's messages. */
function transportOf(fake: FakeReceiver): RelayTransport {
  return {
    send: (line) => { fake.output.write(`${line}\n`); },
    bind: (to) => {
      createInterface({ input: fake.input }).on("line", (l) => {
        if (!l.trim()) return;
        const m = JSON.parse(l);
        if (m?.t === "res") to.answer(m); else to.daemon(m);
      });
    },
  };
}

test("the routing: the blanket scope reaches only the blanket Chrome's model and bridge; another scope never does", { timeout: 30_000 }, async () => {
  const blanketFake = new FakeReceiver();
  let blanketScope: string | null = "bl";
  const h = await harness({ blanket: { transport: transportOf(blanketFake), scope: () => blanketScope } } as any);
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
    blanketFake.line({ t: "allowlist", lists: {}, scopes: { bl: "*" }, default: null, operator: "*" });
    await until(() => bm.notReady() === null, "the blanket model to be ready");
    const bl = await CDPConnection.connect(h.url("bl")); conns.push(bl);
    const s1 = await CDPConnection.connect(h.url("s1")); conns.push(s1);
    assert.equal(h.relay.model.connectionCount, 1);
    assert.equal(bm.connectionCount, 1);
    // The blanket scope opens a public host on the blanket Chrome only.
    const mainCreates = h.fake.sent("windows.create").length;
    await bl.send("Target.createTarget", { url: "https://news.example.org/" });
    assert.equal(blanketFake.sent("windows.create").length, 1, "the blanket Chrome's receiver made the tab");
    assert.equal(h.fake.sent("windows.create").length, mainCreates, "the main Chrome got nothing");
    // A local or IP host stays refused for the blanket scope.
    for (const [url, host] of [["http://localhost:3000/", "localhost"], ["http://10.0.0.2/", "10.0.0.2"], ["http://printer.local/", "printer.local"]]) {
      const m = await bl.send("Target.createTarget", { url }).then(() => "no refusal", (e: Error) => e.message);
      assert.ok(m.endsWith(TEXT.notPublic(host)), `${url}: ${m}`);
    }
    // No prompt: the blanket model sends no daemon.blocked.
    assert.equal(blanketFake.daemonRequests.filter((r) => r.op === "daemon.blocked").length, 0);
    // A grant with no origin, and the stored sign-ins, get the blanket texts.
    const grant = await bl.send("Browser.grantPermissions", { permissions: ["geolocation"] }).then(() => "no refusal", (e: Error) => e.message);
    assert.ok(grant.endsWith(TEXT.blanketGrant), grant);
    for (const method of ["AgentBrowser.signIn", "AgentBrowser.signIns"]) {
      const m = await bl.send(method, { host: "example.com" }).then(() => "no refusal", (e: Error) => e.message);
      assert.ok(m.endsWith(TEXT.blanketSignIns), `${method}: ${m}`);
    }
    // s1 keeps its list on the main Chrome; it never reaches the blanket bridge.
    const blanketCreates = blanketFake.sent("windows.create").length;
    const off = await s1.send("Target.createTarget", { url: "https://news.example.org/" }).then(() => "no refusal", (e: Error) => e.message);
    assert.match(off, new RegExp(TEXT.notAllowed("news.example.org").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    await s1.send("Target.createTarget", { url: "https://a.example/" });
    assert.equal(blanketFake.sent("windows.create").length, blanketCreates, "no request of s1 reached the blanket Chrome");
    // The main model never takes "*": a main line that gives s1 "*" leaves it with no list.
    h.fake.line({ t: "allowlist", lists: {}, scopes: { s1: "*" }, default: null });
    await until(() => h.relay.model.noList("s1"), "s1 to have no list");
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
