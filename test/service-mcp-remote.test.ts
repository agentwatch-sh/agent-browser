// The limits of a remote admission in the MCP path's transport (stage 5 T3, board ab-v16.94.7.4; the plan
// docs/superpowers/plans/2026-11-16-stage-5-remote-scopes.md, task T3; contract C11, "The MCP inside the service" and
// "The transport of the MCP path"; docs/contracts/mcp-allow-list.md). A request that the port admits as remote (the
// carrier of stage 5, or the test stand-in --test-mcp-remote-scope) names no file of this box, gets no answer of more
// than 16 MiB, and its scope, `<box>/<session>`, has its own folder `<state>/mcp-remote/<box>/<session>/`; at most 16 of
// the service's MCP sessions are remote. The transport tests run a test worker (test/fixtures/mcp-answer-worker.ts)
// with no Playwright and no browser; every folder is a temp folder of the test, and every token a made-up test value.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as AL from "../src/service/mcp/allow-list.ts";
import * as TR from "../src/service/mcp/transport.ts";

const LIST = AL.readAllowList();
const FIXTURE = new URL("./fixtures/mcp-answer-worker.ts", import.meta.url);
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-client", version: "0" } } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NA = "Not available in the agent browser";
/** The plan's -32602 text of a path argument of a remote admission (T3; C11, the path rule). */
const remotePath = (key: string) => ({ code: -32602, message: `${NA}: ${key} names a file, and a session of another box cannot name a file of this box.` });
/** The plan's tool error of an answer over the limit (T3; C11, the transport). */
const TOO_LARGE = "The answer is larger than the limit for a remote session; ask for a smaller part, for example one element's snapshot or a viewport screenshot.";
/** The transport's answer of the limit of remote MCP sessions (this PR's text, for the daemon lead's OK). */
const PER_REMOTE = "The agent browser has no free place for an MCP session of another box now: it serves at most 16 MCP sessions of other boxes, and at most 32 in all. Initialize again later.";

// ------------------------------------------------------------------ the path rule of a remote admission (checkCall)

/** Each tool of the list with a `paths` key, and each such key. */
const PATH_TOOLS = Object.entries(LIST.tools).filter(([, r]) => r.paths.length > 0).flatMap(([name, r]) => r.paths.map((key) => ({ name, key })));

test("T3: the list has tools with path keys (the remote rule below has something to refuse)", () => {
  assert.ok(PATH_TOOLS.length >= 9, JSON.stringify(PATH_TOOLS));
  assert.ok(PATH_TOOLS.some((p) => p.name === "browser_take_screenshot" && p.key === "filename"));
  assert.ok(PATH_TOOLS.some((p) => p.name === "browser_file_upload" && p.key === "paths"));
});

test("T3: a remote admission: each argument that the allow list marks as a path is refused with the plan's -32602, wherever it points (also inside the scope's folder, relative, or no string); the same call with no path key passes; a local admission keeps the folder rule", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-mcp-remote-path-"));
  try {
    const folder = `${join(dir, "mcp-remote", "box", "s1")}/`;
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    writeFileSync(join(folder, "in.txt"), "a file of the scope's folder");
    const check = (AL as any).checkCall as (...a: unknown[]) => unknown;
    for (const { name, key } of PATH_TOOLS) {
      const many = key === "paths";
      const values = [join(folder, "in.txt"), "in.txt", "/etc/hostname", "../x", folder];
      for (const v of values) {
        const args = { [key]: many ? [v] : v };
        assert.deepEqual(check(LIST, { name, arguments: args }, "remote", folder), remotePath(key), `${name} ${key}=${v}: refused for a remote admission`);
      }
      assert.deepEqual(check(LIST, { name, arguments: { [key]: 5 } }, "remote", folder), remotePath(key), `${name} ${key}: a value that is no string`);
      assert.equal(check(LIST, { name, arguments: {} }, "remote", folder), null, `${name} with no path key passes for a remote admission`);
      // A local admission: a path inside the folder passes, one outside gets the folder's -32602 (the rule of stage 1d).
      assert.equal(check(LIST, { name, arguments: { [key]: many ? [join(folder, "in.txt")] : join(folder, "in.txt") } }, "local", folder), null, `${name} ${key}: inside the folder, local`);
      assert.deepEqual(check(LIST, { name, arguments: { [key]: many ? ["/etc/hostname"] : "/etc/hostname" } }, "local", folder), AL.refusePath(key, folder), `${name} ${key}: outside the folder, local`);
    }
    // No admission word is remote (fail closed), as for the service's own tools.
    assert.deepEqual(check(LIST, { name: "browser_take_screenshot", arguments: { filename: "in.txt" } }, undefined, folder), remotePath("filename"));
    // The code's refusal is the plan's text.
    assert.deepEqual((AL as any).refuseRemotePath?.("filename"), remotePath("filename"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ the transport with the test worker

type Http = { url: (scope: string) => string; close: () => Promise<void> };
/**
 * A plain HTTP server in front of the transport, as the port is: the path's scope (encoded, so `a/b` and `../x` reach
 * it as they are) is the connection's scope, and `admission` gives each request its word.
 */
async function front(t: TR.McpTransport, admission: (scope: string) => "local" | "remote"): Promise<Http> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const scope = decodeURIComponent(/^\/mcp\/([^?]+)/.exec(req.url ?? "")?.[1] ?? "none");
    void t.request(req, res, scope, undefined, admission(scope));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { url: (scope) => `http://127.0.0.1:${port}/mcp/${encodeURIComponent(scope)}`, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}
type Reply = { status: number; sid: string | null; body: any; text: string };
async function post(url: string, body: unknown, sid?: string, signal?: AbortSignal): Promise<Reply> {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...(sid ? { "Mcp-Session-Id": sid } : {}) }, body: JSON.stringify(body), signal: signal ?? AbortSignal.timeout(30_000) });
  const text = await r.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch {}
  return { status: r.status, sid: r.headers.get("mcp-session-id"), body: parsed, text };
}
async function init(url: string): Promise<string> {
  const r = await post(url, INIT);
  assert.equal(r.status, 200, r.text);
  assert.match(r.sid ?? "", /^[0-9a-f]{32}$/);
  return r.sid!;
}
const call = (id: number, name: string, args: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

/** A scope with a `/` (stage 5's remote scope) or a name that starts with `r-` (a stand-in) has the remote admission. */
const byName = (scope: string) => (scope.includes("/") || scope.startsWith("r-") ? "remote" : "local");

async function withTransport(o: { perScope?: number; perService?: number; perRemote?: number; answerMax?: number; foldCase?: boolean; admission?: (scope: string) => "local" | "remote" }, f: (x: { t: TR.McpTransport; h: Http; dir: string; state: string; log: string[] }) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "ab-mcp-remote-"));
  const state = join(dir, "state");
  const log: string[] = [];
  const t = new TR.McpTransport({ list: LIST, stateFolder: state, ticketUrl: () => null, log: (l) => log.push(l), perScope: o.perScope, perService: o.perService, foldCase: o.foldCase, worker: { heapMb: 64, entry: FIXTURE }, ...({ perRemote: o.perRemote, answerMax: o.answerMax } as object) });
  const h = await front(t, o.admission ?? byName);
  try { await f({ t, h, dir, state, log }); } finally { await h.close(); await t.stop(); rmSync(dir, { recursive: true, force: true }); }
}
const mode = (p: string) => statSync(p).mode & 0o777;

test("T3: the first values: 16 remote MCP sessions of the 32, and an answer limit of 16777216 bytes for a remote admission", () => {
  assert.equal((TR as any).MCP_REMOTE_SESSIONS, 16);
  assert.equal(TR.MCP_SESSIONS_PER_SERVICE, 32);
  assert.equal((TR as any).MCP_REMOTE_ANSWER_MAX, 16777216);
  assert.equal((TR as any).MCP_REMOTE_TOO_LARGE, TOO_LARGE);
  assert.deepEqual((TR.MCP_ANSWERS as any).perRemote, { status: 200, code: -32000, text: PER_REMOTE }, "not a 503: HTTP 200 with the JSON-RPC error");
});

test("T3: a remote scope a/b gets the folder <state>/mcp-remote/a/b/ (each folder mode 0700) and the worker's folder (the MCP's outputDir) is that one; it never meets a local scope's folder; it goes at the scope's end with its files", { timeout: 60_000 }, async () => {
  await withTransport({}, async ({ t, h, state, log }) => {
    const sid = await init(h.url("a/b"));
    const folder = join(state, "mcp-remote", "a", "b");
    assert.ok(statSync(folder).isDirectory(), "the remote scope's folder");
    for (const p of [join(state, "mcp-remote"), join(state, "mcp-remote", "a"), folder]) assert.equal(mode(p), 0o700, p);
    assert.equal(existsSync(join(state, "mcp", "a")), false, "no local folder for a remote scope");
    const snap = await post(h.url("a/b"), call(2, "browser_snapshot"), sid);
    assert.equal(snap.body?.result?.content?.[0]?.text, `folder ${folder}/`, "the worker's folder (the MCP's outputDir) is the remote scope's folder");
    // A local scope named like the box has its own folder under <state>/mcp.
    const lsid = await init(h.url("a"));
    const lsnap = await post(h.url("a"), call(2, "browser_snapshot"), lsid);
    assert.equal(lsnap.body?.result?.content?.[0]?.text, `folder ${join(state, "mcp", "a")}/`);
    writeFileSync(join(folder, "download.bin"), "a download of the remote scope");
    mkdirSync(join(state, "mcp-remote", "a", "c"), { mode: 0o700 });
    // The scope's end (a set_sessions that names it no more, Q7): its MCP sessions end, its folder goes with its files.
    await t.keepScopes(new Set(["a", "a/c"]));
    assert.equal(existsSync(folder), false, "the remote scope's folder went with its files");
    assert.ok(existsSync(join(state, "mcp-remote", "a", "c")), "a named remote scope's folder stays");
    assert.ok(existsSync(join(state, "mcp", "a")), "the local scope's folder stays");
    assert.equal((await post(h.url("a/b"), { jsonrpc: "2.0", id: 3, method: "ping" }, sid)).status, 404, "the ended MCP session gets the 404");
    assert.ok(log.some((l) => l === "mcp: the folder of scope a/b is emptied (the sessions name it no more)"), log.join("\n"));
    // A drop of the last session of a box leaves no empty box folder; a local scope's drop leaves the remote folders.
    await t.dropScope("a/c", "its session ended");
    assert.equal(existsSync(join(state, "mcp-remote", "a")), false, "the empty box folder went too");
    await t.keepScopes(new Set([]));
    assert.equal(existsSync(join(state, "mcp", "a")), false);
    assert.ok(existsSync(join(state, "mcp-remote")));
  });
});

test("T3: a remote scope's folder refuses ../x, a link and (on the Mac's rule) a case twin: the initialize gets the 503 of an MCP session that the service cannot make, and nothing is made outside", { timeout: 60_000 }, async () => {
  await withTransport({}, async ({ t, h, dir, state, log }) => {
    for (const bad of ["../x", "a/../x", "a/b/c", ".a/b"]) {
      const r = await post(h.url(bad), INIT);
      assert.equal(r.status, 503, `${bad}: ${r.text}`);
      assert.equal(r.body?.error?.message, TR.MCP_ANSWER.notOpened, bad);
    }
    assert.deepEqual(readdirSync(dir).sort(), ["state"], "nothing made beside the state folder");
    assert.equal(existsSync(join(state, "x")), false);
    assert.deepEqual(TR.removeScopeFolder(state, "../x"), { removed: false, why: null }, "no removal of a name that is no scope");
    // A link at <state>/mcp-remote, at the box's folder and at the scope's folder.
    const outside = join(dir, "outside");
    mkdirSync(outside, { mode: 0o700 });
    mkdirSync(state, { recursive: true, mode: 0o700 });
    symlinkSync(outside, join(state, "mcp-remote"));
    let r = await post(h.url("l/one"), INIT);
    assert.equal(r.status, 503, r.text);
    assert.deepEqual(readdirSync(outside), [], "nothing made through the link");
    rmSync(join(state, "mcp-remote"));
    mkdirSync(join(state, "mcp-remote"), { mode: 0o700 });
    symlinkSync(outside, join(state, "mcp-remote", "l"));
    r = await post(h.url("l/two"), INIT);
    assert.equal(r.status, 503, r.text);
    assert.deepEqual(readdirSync(outside), [], "nothing made through the box's link");
    mkdirSync(join(state, "mcp-remote", "m"), { mode: 0o700 });
    symlinkSync(outside, join(state, "mcp-remote", "m", "s"));
    r = await post(h.url("m/s"), INIT);
    assert.equal(r.status, 503, r.text);
    // The scope's end removes a link as a link: its target stays; a box folder that is a link is never entered.
    writeFileSync(join(outside, "keep.txt"), "the link's target");
    await t.dropScope("m/s", "test");
    await t.dropScope("l/two", "test");
    assert.ok(existsSync(join(outside, "keep.txt")), "the target stays");
    assert.equal(lstatSync(join(state, "mcp-remote", "l")).isSymbolicLink(), true, "a box folder that is a link stays");
    assert.ok(log.some((l) => /^mcp: scope l\/one: an initialize refused \(.*\)$/.test(l)), log.join("\n"));
  });
  // On the Mac (APFS ignores case) a box or a session that differs from a folder of another only in case is refused.
  await withTransport({ foldCase: true }, async ({ h, state }) => {
    await init(h.url("Box/s1"));
    for (const twin of ["box/s1", "BOX/s2", "Box/S1"]) {
      const r = await post(h.url(twin), INIT);
      assert.equal(r.status, 503, `${twin}: ${r.text}`);
    }
    assert.deepEqual(readdirSync(join(state, "mcp-remote")), ["Box"], "no twin's folder");
    assert.deepEqual(readdirSync(join(state, "mcp-remote", "Box")), ["s1"]);
    await init(h.url("Box/s2"));
  });
});

test("T3: a remote scope always has the remote admission, also when the port gives the word local: a path argument is refused", { timeout: 60_000 }, async () => {
  await withTransport({ admission: () => "local" }, async ({ h }) => {
    const sid = await init(h.url("a/b"));
    const r = await post(h.url("a/b"), call(2, "browser_take_screenshot", { filename: "x.png" }), sid);
    assert.deepEqual(r.body?.error, remotePath("filename"));
    const l = await init(h.url("web-1"));
    const ok = await post(h.url("web-1"), call(2, "browser_take_screenshot", { filename: "x.png" }), l);
    assert.equal(ok.body?.error, undefined, "a local scope with the word local keeps the folder rule");
  });
});

test("T3: for a remote admission an answer of more than the limit is not sent: the call gets the plan's tool error, the MCP session stays open; a smaller answer and a local admission's answer pass", { timeout: 60_000 }, async () => {
  await withTransport({ answerMax: 2048 }, async ({ h, log }) => {
    const sid = await init(h.url("r-1"));
    const big = await post(h.url("r-1"), call(2, "browser_take_screenshot"), sid);
    assert.equal(big.status, 200);
    assert.deepEqual(big.body, { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: TOO_LARGE }], isError: true } });
    assert.equal((await post(h.url("r-1"), { jsonrpc: "2.0", id: 3, method: "ping" }, sid)).body?.result !== undefined, true, "the MCP session stays open");
    const small = await post(h.url("r-1"), call(4, "browser_snapshot"), sid);
    assert.match(small.body?.result?.content?.[0]?.text ?? "", /^folder /, "a smaller answer passes");
    assert.ok(log.includes("mcp: MCP session 1 (scope r-1): the answer of a tools/call refused (larger than the limit for a remote session)"), log.join("\n"));
    const l = await init(h.url("web-1"));
    const shot = await post(h.url("web-1"), call(2, "browser_take_screenshot"), l);
    assert.equal(shot.body?.result?.content?.[0]?.type, "image", "a local admission's answer passes whole");
  });
});

test("T3: at most 16 of the service's MCP sessions are remote (seam 2 of 4): one more remote initialize gets HTTP 200 with -32000 and the limit's text, never a 503; a local session is not refused because of remote sessions: it takes the place of the remote one with the oldest last message that has no request that waits", { timeout: 60_000 }, async () => {
  await withTransport({ perRemote: 2, perService: 4 }, async ({ t, h, log }) => {
    const r1 = await init(h.url("box/r1"));
    await sleep(5);
    const r2 = await init(h.url("box/r2"));
    const third = await post(h.url("box/r3"), INIT);
    assert.equal(third.status, 200, third.text);
    assert.deepEqual(third.body, { jsonrpc: "2.0", id: 1, error: { code: -32000, message: PER_REMOTE } });
    assert.equal(third.sid, null);
    assert.ok(log.includes("mcp: scope box/r3: an initialize refused (the remote MCP sessions are at their limit)"), log.join("\n"));
    // Local sessions are not counted against the remote limit.
    await init(h.url("l1"));
    await init(h.url("l2"));
    assert.equal(t.size(), 4);
    // At the service's limit a remote initialize gets the same answer (HTTP 200), never the 503.
    const atService = await post(h.url("box/r4"), INIT);
    assert.equal(atService.status, 200, atService.text);
    assert.equal(atService.body?.error?.message, PER_REMOTE);
    // A local initialize at the service's limit takes the place of the quiet remote session with the oldest last message.
    await post(h.url("box/r2"), { jsonrpc: "2.0", id: 5, method: "ping" }, r2);
    await init(h.url("l3"));
    assert.equal(t.size(), 4);
    assert.equal((await post(h.url("box/r1"), { jsonrpc: "2.0", id: 6, method: "ping" }, r1)).status, 404, "the remote session that gave its place gets the 404");
    assert.equal((await post(h.url("box/r2"), { jsonrpc: "2.0", id: 7, method: "ping" }, r2)).status, 200, "the other remote session goes on");
    assert.ok(log.includes("mcp: MCP session 1 of scope box/r1 ended: a local MCP session took its place"), log.join("\n"));
    // While each remote session has a request that waits, a local initialize at the service's limit gets the 503.
    const ctl = new AbortController();
    const waiting = post(h.url("box/r2"), call(8, "browser_wait_for", { time: 1 }), r2, ctl.signal).catch(() => null);
    await sleep(100);
    const full = await post(h.url("l4"), INIT);
    assert.equal(full.status, 503, full.text);
    assert.equal(full.body?.error?.message, TR.MCP_ANSWER.perService);
    ctl.abort();
    await waiting;
  });
});

// ------------------------------------------------------------------ the stand-in (--test-mcp-remote-scope) through the MCP part

test("T3 through the stand-in: the port's remote scope (the test switch of --test-mcp-remote-scope) gets the path refusal and the answer limit; the local scope does not", { skip: process.platform !== "linux", timeout: 60_000 }, async () => {
  const { McpPart } = await import("../src/service/mcp/part.ts");
  const { createHash } = await import("node:crypto");
  const { parseStat } = await import("../src/relay/peer.ts");
  const dir = mkdtempSync(join(tmpdir(), "ab-mcp-remote-part-"));
  const token = "abt1_" + Buffer.from("test, not a token: the remote stand-in", "latin1").toString("base64url");
  const fp = createHash("sha256").update(token, "latin1").digest("hex");
  const p = new McpPart({ listen: { port: 0 }, stateFolder: dir, log: () => {}, port: { remote: new Set(["t-rem"]) }, transport: { worker: { heapMb: 64, entry: FIXTURE }, ...({ answerMax: 2048 } as object) } });
  try {
    const self = parseStat(readFileSync(`/proc/${process.pid}/stat`, "latin1"))!;
    const roots = [{ pid: process.pid, start: self.start }];
    p.setSessions({ sessions: [{ scope: "t-rem", repo: null, roots, cgroup: null, lifetime_id: null, mcp_token: fp }, { scope: "t-loc", repo: null, roots, cgroup: null, lifetime_id: null, mcp_token: fp }] } as any);
    await p.open({ url: (s) => s, readiness: () => ({ controlOff: false, notReady: null, sites: 1 }) });
    const auth = (scope: string) => async (body: unknown, sid?: string) => {
      const r = await fetch(`http://127.0.0.1:${p.mcpPort!.port}/mcp/${scope}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(sid ? { "Mcp-Session-Id": sid } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
      return { status: r.status, sid: r.headers.get("mcp-session-id"), body: await r.json().catch(() => null) as any };
    };
    const rem = auth("t-rem"), loc = auth("t-loc");
    const rs = (await rem(INIT)).sid!, ls = (await loc(INIT)).sid!;
    assert.deepEqual((await rem(call(2, "browser_take_screenshot", { filename: "shot.png" }), rs)).body?.error, remotePath("filename"), "the stand-in's filename is refused");
    assert.deepEqual((await rem(call(3, "browser_take_screenshot"), rs)).body?.result, { content: [{ type: "text", text: TOO_LARGE }], isError: true }, "the stand-in's large answer is refused");
    assert.match((await rem(call(4, "browser_snapshot"), rs)).body?.result?.content?.[0]?.text ?? "", /^folder /, "an inline answer under the limit passes");
    assert.equal((await loc(call(2, "browser_take_screenshot", { filename: "shot.png" }), ls)).body?.error, undefined, "the local scope's filename in its folder passes");
    assert.equal((await loc(call(3, "browser_take_screenshot"), ls)).body?.result?.content?.[0]?.type, "image", "the local scope's answer passes whole");
  } finally { await p.close(); rmSync(dir, { recursive: true, force: true }); }
});

