// Board ab-v16.94.7.8 (stage 5: the service removes Chrome's own copy of a remote download; C11, the remote scope's
// folder). Chrome saves each download in the agent profile's downloads folder, also a download of a remote scope's page.
// For a connection of a remote admission the model reads Chrome's path of each completed download (downloads.search)
// and, at the end of its handling of that download, removes that file through the guard of chrome-downloads.ts. A local
// scope's download is untouched. Each refusal and each failed removal gets a log line with the scope and a reason or
// the error's code, never a path; a failed removal does not change what the client hears.
//
// The relay here is the service's: the MCP's tickets and a peer gate whose fake reader gives the service's own pid, so a
// ticket connection of a remote scope has the remote admission and one of a local scope the local admission (stage 5
// T2). No browser starts: the fake receiver answers downloads.search from its list.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CDPConnection } from "../src/cdp.ts";
import { ChromeDownloads, CHROME_COPY } from "../src/relay/chrome-downloads.ts";
import { PeerGate, type PeerReader } from "../src/relay/peer.ts";
import { Tickets } from "../src/service/mcp/ticket.ts";
import { startService } from "../src/service/service.ts";
import type { UnitState } from "../src/service/unit/owner.ts";
import { FakeTools, World } from "./fake-unit-world.ts";
import { harness, until, type Harness } from "./fake-bridge.ts";
import { tempDir } from "./temp-dirs.ts";

const UID = process.getuid!();
const SERVICE_PID = 2900;
const REMOTE = "box1/web-9", OTHER_REMOTE = "box2/web-1", LOCAL = "s1";
const LINE = { t: "allowlist", lists: { a: ["a.example"] }, scopes: { [LOCAL]: "a", [REMOTE]: "a", [OTHER_REMOTE]: "a" }, default: "a" };

/** A peer reader that gives the service's own pid for each accept (the stat form: no pidfd). */
const reader: PeerReader = {
  form: "stat",
  peer: () => ({ pid: SERVICE_PID, uid: UID, pidfd: null, start: 5 }),
  proc: () => null, cgroup: () => null, poll: () => 0, fdinfoPid: () => null, close: () => {},
};

type Rig = { h: Harness; dir: string; downloads: string; tickets: Tickets; conns: CDPConnection[]; connect(scope: string): Promise<CDPConnection> };

async function withRig(f: (r: Rig) => Promise<void>, o: { folder?: boolean } = {}): Promise<void> {
  const tickets = new Tickets({ pid: SERVICE_PID });
  const h = await harness({ peerCheck: new PeerGate({ reader, uid: UID }), tickets } as any);
  const dir = tempDir("ab-rdl-");
  const downloads = join(dir, "home", "Downloads");
  mkdirSync(downloads, { recursive: true, mode: 0o700 });
  const conns: CDPConnection[] = [];
  try {
    await h.ready(LINE);
    // The service sets the folder (service.ts); a model with no setter (before this task) runs on, so each test fails on its own assertions.
    const model = h.relay.model as unknown as { setChromeDownloads?: (d: ChromeDownloads | null) => void };
    if (o.folder !== false) model.setChromeDownloads?.(new ChromeDownloads(downloads));
    await f({ h, dir, downloads, tickets, conns, connect: async (scope) => { const c = await CDPConnection.connect(`${h.url(scope)}?ticket=${tickets.mint(scope)}`); conns.push(c); return c; } });
  } finally {
    for (const c of conns) await c.close().catch(() => {});
    await h.close();
    try { chmodSync(downloads, 0o700); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A tab of the connection (its owner): Target.createTarget, as Playwright makes one. */
async function tabOf(h: Harness, c: CDPConnection): Promise<number> {
  await c.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const attached = c.waitForEvent("Target.attachedToTarget");
  const { targetId } = await c.send("Target.createTarget", { url: "about:blank" });
  await attached;
  return [...h.fake.tabs.values()].find((t) => t.targetId === targetId)!.id;
}

/** Chrome's events of one download in a tab, and its item in chrome.downloads (complete, at `filename`). `tie`: emit downloads.onCreated. */
function download(h: Harness, tab: number, o: { guid: string; id: number; url: string; filename: string; tie?: boolean; complete?: boolean }): { begin(): void; created(): void; done(): void } {
  const ev = (method: string, params: object) => h.fake.emit("debugger.onEvent", { source: { tabId: tab }, method, params });
  return {
    begin: () => {
      h.fake.downloads.push({ id: o.id, url: o.url, filename: o.filename, state: "complete" });
      ev("Page.downloadWillBegin", { frameId: "F1", guid: o.guid, url: o.url, suggestedFilename: "f.txt" });
    },
    created: () => h.fake.emit("downloads.onCreated", { item: { id: o.id, url: o.url, state: "in_progress", danger: "safe" } }),
    done: () => ev("Page.downloadProgress", { guid: o.guid, totalBytes: 12, receivedBytes: 12, state: "completed" }),
  };
}

const removedLine = (scope: string) => `relay: Chrome's copy of a download of scope ${scope} is removed`;
const keptLine = (scope: string, why: string) => `relay: Chrome's copy of a download of scope ${scope} is not removed (${why})`;
/** No line of a download (the removal's lines, and the model's other download lines) holds a path. */
const noPath = (logs: string[], dir: string) => {
  const lines = logs.filter((l) => /download/i.test(l));
  assert.ok(!lines.some((l) => l.includes(dir) || /\/(home|tmp|Downloads)\b/.test(l)), `no download line holds a path:\n${lines.join("\n")}`);
};

// ------------------------------------------------------------------ the guard (chrome-downloads.ts)

test("ab-v16.94.7.8: the guard removes a regular file of the downloads folder (also in a folder of it) and nothing else", () => {
  const dir = tempDir("ab-rdg-");
  try {
    const folder = join(dir, "home", "Downloads");
    mkdirSync(join(folder, "sub"), { recursive: true, mode: 0o700 });
    const g = new ChromeDownloads(folder);
    writeFileSync(join(folder, "a.txt"), "a");
    writeFileSync(join(folder, "sub", "b.txt"), "b");
    assert.deepEqual(g.remove(join(folder, "a.txt")), { removed: true });
    assert.deepEqual(g.remove(join(folder, "sub", "b.txt")), { removed: true });
    assert.equal(existsSync(join(folder, "a.txt")), false);
    assert.equal(existsSync(join(folder, "sub", "b.txt")), false);
    assert.ok(existsSync(join(folder, "sub")), "the guard removes a file only, never a folder");
    // A file that is gone: the error's code.
    assert.deepEqual(g.remove(join(folder, "a.txt")), { removed: false, why: "ENOENT" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ab-v16.94.7.8: the guard refuses a path outside the downloads folder after realpath, a link, no regular file, a relative path and no string; a refused file stays", () => {
  const dir = tempDir("ab-rdg-");
  try {
    const folder = join(dir, "home", "Downloads"), outside = join(dir, "outside");
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    mkdirSync(outside, { mode: 0o700 });
    const g = new ChromeDownloads(folder);
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "not Chrome's");
    // Outside: a file of another folder, a path with .. out of the folder, the folder itself, and a folder of the downloads folder that is a link to outside.
    symlinkSync(outside, join(folder, "out"));
    for (const p of [secret, join(folder, "..", "..", "outside", "secret.txt"), folder, join(folder, "out", "secret.txt")]) {
      assert.deepEqual(g.remove(p), { removed: false, why: CHROME_COPY.outside }, p);
    }
    // A link in the folder (to a file outside): the link and its target stay.
    symlinkSync(secret, join(folder, "link.txt"));
    assert.deepEqual(g.remove(join(folder, "link.txt")), { removed: false, why: CHROME_COPY.link });
    assert.ok(lstatSync(join(folder, "link.txt")).isSymbolicLink());
    // No regular file: a folder in the folder.
    mkdirSync(join(folder, "d.txt"));
    assert.deepEqual(g.remove(join(folder, "d.txt")), { removed: false, why: CHROME_COPY.notAFile });
    assert.ok(existsSync(join(folder, "d.txt")));
    // A relative path and a value that is no string.
    writeFileSync(join(folder, "c.txt"), "c");
    for (const p of ["c.txt", "home/Downloads/c.txt", 7, null, undefined]) assert.deepEqual(g.remove(p), { removed: false, why: CHROME_COPY.outside }, String(p));
    assert.equal(readFileSync(secret, "utf8"), "not Chrome's");
    assert.ok(existsSync(join(folder, "c.txt")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ab-v16.94.7.8: the guard removes nothing while the downloads folder is a link or no folder of the service's user", () => {
  const dir = tempDir("ab-rdg-");
  try {
    const real = join(dir, "real");
    mkdirSync(real, { mode: 0o700 });
    mkdirSync(join(dir, "home"), { mode: 0o700 });
    symlinkSync(real, join(dir, "home", "Downloads"));
    writeFileSync(join(real, "a.txt"), "a");
    const g = new ChromeDownloads(join(dir, "home", "Downloads"));
    assert.deepEqual(g.remove(join(dir, "home", "Downloads", "a.txt")), { removed: false, why: CHROME_COPY.folderNotOurs });
    assert.deepEqual(g.remove(join(real, "a.txt")), { removed: false, why: CHROME_COPY.folderNotOurs });
    assert.ok(existsSync(join(real, "a.txt")));
    // Another user's folder (the uid seam): nothing goes.
    const own = join(dir, "own");
    mkdirSync(own, { mode: 0o700 });
    writeFileSync(join(own, "b.txt"), "b");
    assert.deepEqual(new ChromeDownloads(own, UID + 1).remove(join(own, "b.txt")), { removed: false, why: CHROME_COPY.folderNotOurs });
    assert.ok(existsSync(join(own, "b.txt")));
    // No folder at all: the error's code.
    assert.deepEqual(new ChromeDownloads(join(dir, "none")).remove(join(dir, "none", "c.txt")), { removed: false, why: "ENOENT" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ the model (model.ts, finish)

test("ab-v16.94.7.8: a remote scope's completed download leaves no Chrome copy in the downloads folder at the end of the model's handling; the client's copy in its folder stays", { timeout: 30_000 }, async () => {
  await withRig(async ({ h, dir, downloads, connect }) => {
    const c = await connect(REMOTE);
    const tab = await tabOf(h, c);
    const folder = join(dir, "mcp-remote", "box1", "web-9");
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    await c.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: folder, eventsEnabled: true });
    const chrome = join(downloads, "f.txt");
    writeFileSync(chrome, "file content");
    const d = download(h, tab, { guid: "g1", id: 3, url: "https://a.example/f.txt", filename: chrome });
    const done = c.waitForEvent("Browser.downloadProgress", { predicate: (p: any) => p.guid === "g1" && p.state !== "inProgress" });
    d.begin(); d.created(); d.done();
    assert.equal((await done).state, "completed", "the client hears completed");
    assert.equal(existsSync(chrome), false, "Chrome's copy is gone when the client hears the end");
    assert.equal(readFileSync(join(folder, "g1"), "utf8"), "file content", "the client's copy in its folder stays");
    assert.ok(h.logs.includes(removedLine(REMOTE)), h.logs.join("\n"));
    await c.close();
    await until(() => (h.relay.model as any).connectionCount === 0, "the close");
    assert.equal(readFileSync(join(folder, "g1"), "utf8"), "file content", "the model never removes the client's copy: it goes at the scope's end, with the scope's folder");
    noPath(h.logs, dir);
  });
});

test("ab-v16.94.7.8: the MCP's own connection (Playwright with noDefaults sets no download behavior): the model still reads Chrome's path and removes Chrome's copy; the client hears no download event", { timeout: 30_000 }, async () => {
  await withRig(async ({ h, dir, downloads, connect }) => {
    const c = await connect(REMOTE);
    const tab = await tabOf(h, c);
    const events: string[] = [];
    c.on("Browser.downloadWillBegin", () => events.push("begin"));
    c.on("Browser.downloadProgress", () => events.push("progress"));
    const chrome = join(downloads, "report.csv");
    writeFileSync(chrome, "a,b\n");
    const d = download(h, tab, { guid: "g2", id: 4, url: "https://a.example/report.csv", filename: chrome });
    d.begin(); d.created(); d.done();
    await until(() => h.logs.includes(removedLine(REMOTE)), "the removal's line");
    assert.equal(existsSync(chrome), false);
    assert.ok(h.fake.sent("downloads.search").some((r) => r.args[0].id === 4), "the search by the item's id");
    assert.deepEqual(events, [], "no Browser.download* event for a client that asked for none");
    noPath(h.logs, dir);
  });
});

test("ab-v16.94.7.8: a local scope's download is untouched (with or without a client folder) while a remote scope's download in the same relay loses Chrome's copy", { timeout: 30_000 }, async () => {
  await withRig(async ({ h, dir, downloads, connect }) => {
    const local = await connect(LOCAL), remote = await connect(REMOTE);
    assert.deepEqual([...(h.relay.model as any).conns].map((x: any) => [x.scope, x.admission]).sort(), [[REMOTE, "remote"], [LOCAL, "local"]]);
    const lt = await tabOf(h, local), rt = await tabOf(h, remote);
    const folder = join(dir, "client");
    mkdirSync(folder, { mode: 0o700 });
    await local.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: folder, eventsEnabled: true });
    const kept = join(downloads, "local.txt"), plainKept = join(downloads, "local-plain.txt"), gone = join(downloads, "remote.txt");
    for (const p of [kept, plainKept, gone]) writeFileSync(p, "x");
    const l1 = download(h, lt, { guid: "l1", id: 10, url: "https://a.example/local.txt", filename: kept });
    const done = local.waitForEvent("Browser.downloadProgress", { predicate: (p: any) => p.guid === "l1" && p.state !== "inProgress" });
    l1.begin(); l1.created(); l1.done();
    assert.equal((await done).state, "completed");
    assert.equal(readFileSync(join(folder, "l1"), "utf8"), "x", "the local client's copy");
    // A local client with no download behavior: no search, as before.
    await local.send("Browser.setDownloadBehavior", { behavior: "default" });
    const searches = h.fake.sent("downloads.search").length;
    const l2 = download(h, lt, { guid: "l2", id: 11, url: "https://a.example/local-plain.txt", filename: plainKept });
    l2.begin(); l2.created(); l2.done();
    const r1 = download(h, rt, { guid: "r1", id: 12, url: "https://a.example/remote.txt", filename: gone });
    r1.begin(); r1.created(); r1.done();
    await until(() => h.logs.includes(removedLine(REMOTE)), "the remote removal");
    assert.equal(existsSync(gone), false, "the remote scope's Chrome copy is gone");
    assert.ok(existsSync(kept) && existsSync(plainKept), "each Chrome copy of the local scope stays");
    assert.ok(!h.fake.sent("downloads.search").slice(searches).some((r) => r.args[0].id === 11 || r.args[0].url === "https://a.example/local-plain.txt"), "no search for a local client with no folder");
    assert.ok(!h.logs.some((l) => l.includes(`scope ${LOCAL}`) && l.includes("Chrome's copy")), "no line of a removal for the local scope");
    noPath(h.logs, dir);
  });
});

test("ab-v16.94.7.8: the guard in the model refuses and logs (the scope and the reason, no path) a path outside the downloads folder, a link, no regular file and another scope's download; each such file stays", { timeout: 30_000 }, async () => {
  await withRig(async ({ h, dir, downloads, connect }) => {
    const remote = await connect(REMOTE), local = await connect(LOCAL);
    const rt = await tabOf(h, remote), lt = await tabOf(h, local);
    const outside = join(dir, "outside");
    mkdirSync(outside, { mode: 0o700 });
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "not Chrome's");
    symlinkSync(secret, join(downloads, "link.txt"));
    mkdirSync(join(downloads, "dir.txt"));
    const cases = [
      { guid: "o1", id: 20, url: "https://a.example/o1", filename: secret, why: CHROME_COPY.outside },
      { guid: "o2", id: 21, url: "https://a.example/o2", filename: join(downloads, "link.txt"), why: CHROME_COPY.link },
      { guid: "o3", id: 22, url: "https://a.example/o3", filename: join(downloads, "dir.txt"), why: CHROME_COPY.notAFile },
    ];
    for (const k of cases) {
      const d = download(h, rt, k);
      d.begin(); d.created(); d.done();
      await until(() => h.logs.filter((l) => l === keptLine(REMOTE, k.why)).length >= 1, k.why);
    }
    assert.equal(readFileSync(secret, "utf8"), "not Chrome's");
    assert.ok(lstatSync(join(downloads, "link.txt")).isSymbolicLink());
    assert.ok(lstatSync(join(downloads, "dir.txt")).isDirectory());
    // Another scope's download of the same URL while the remote one runs: Chrome's item of each is tied by its URL, so the
    // two can swap (here they do: the local item comes first). Neither copy goes.
    const url = "https://a.example/shared.bin";
    const localCopy = join(downloads, "shared.bin"), remoteCopy = join(downloads, "shared (1).bin");
    writeFileSync(localCopy, "local"); writeFileSync(remoteCopy, "remote");
    const r = download(h, rt, { guid: "s-r", id: 31, url, filename: remoteCopy });
    const l = download(h, lt, { guid: "s-l", id: 30, url, filename: localCopy });
    r.begin(); l.begin();
    l.created(); r.created(); // the remote download takes the local item (30), the local one the remote item (31)
    r.done();
    await until(() => h.logs.includes(keptLine(REMOTE, CHROME_COPY.otherScope)), "the refusal of another scope's download");
    l.done();
    await sleep(150);
    assert.equal(readFileSync(localCopy, "utf8"), "local", "the local scope's Chrome copy stays");
    assert.equal(readFileSync(remoteCopy, "utf8"), "remote");
    assert.ok(!h.logs.includes(removedLine(REMOTE)), "no removal at all");
    noPath(h.logs, dir);
  });
});

test("ab-v16.94.7.8: a failed removal does not fail the call: the client hears completed and has its copy, and the line has the scope and the error's code", { timeout: 30_000 }, async () => {
  await withRig(async ({ h, dir, downloads, connect }) => {
    const c = await connect(REMOTE);
    const tab = await tabOf(h, c);
    const folder = join(dir, "client");
    mkdirSync(folder, { mode: 0o700 });
    await c.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: folder, eventsEnabled: true });
    const chrome = join(downloads, "locked.txt");
    writeFileSync(chrome, "file content");
    if (UID !== 0) {
      chmodSync(downloads, 0o500); // no write in the folder: the unlink fails with EACCES
      const d = download(h, tab, { guid: "f1", id: 40, url: "https://a.example/locked.txt", filename: chrome });
      const done = c.waitForEvent("Browser.downloadProgress", { predicate: (p: any) => p.guid === "f1" && p.state !== "inProgress" });
      d.begin(); d.created(); d.done();
      assert.equal((await done).state, "completed", "a failed removal does not fail the call");
      chmodSync(downloads, 0o700);
      assert.equal(readFileSync(join(folder, "f1"), "utf8"), "file content");
      assert.ok(existsSync(chrome));
      assert.ok(h.logs.includes(keptLine(REMOTE, "EACCES")), h.logs.join("\n"));
    }
    noPath(h.logs, dir);
  });
});

test("ab-v16.94.7.8: with no item in chrome.downloads within the wait, the model removes nothing and says so; the relay with no downloads folder (the old path) searches nothing for a remote client with no folder", { timeout: 30_000 }, async () => {
  await withRig(async ({ h, dir, connect }) => {
    (h.relay.model as any).downloadWaitMs = 300;
    const c = await connect(REMOTE);
    const tab = await tabOf(h, c);
    const ev = (method: string, params: object) => h.fake.emit("debugger.onEvent", { source: { tabId: tab }, method, params });
    ev("Page.downloadWillBegin", { frameId: "F1", guid: "n1", url: "https://a.example/none", suggestedFilename: "none" });
    ev("Page.downloadProgress", { guid: "n1", totalBytes: 1, receivedBytes: 1, state: "completed" });
    await until(() => h.logs.includes(keptLine(REMOTE, CHROME_COPY.noItem)), "the line of no complete item");
    noPath(h.logs, dir);
  });
  await withRig(async ({ h, downloads, connect }) => {
    const c = await connect(REMOTE);
    const tab = await tabOf(h, c);
    const chrome = join(downloads, "kept.txt");
    writeFileSync(chrome, "x");
    const d = download(h, tab, { guid: "k1", id: 50, url: "https://a.example/kept.txt", filename: chrome });
    d.begin(); d.created(); d.done();
    await sleep(200);
    assert.ok(existsSync(chrome));
    assert.equal(h.fake.sent("downloads.search").length, 0, "no search");
    assert.ok(!h.logs.some((l) => l.includes("Chrome's copy")));
  }, { folder: false });
});

// ------------------------------------------------------------------ the service (service.ts)

test("ab-v16.94.7.8: the service gives the model the Chrome unit's downloads folder (UnitPaths.downloads: Downloads in Chrome's HOME in the state folder); with no unit the model has none", { timeout: 30_000 }, async (t) => {
  const w = new World();
  const dir = tempDir("ab-rdl-svc-");
  t.after(() => { rmSync(dir, { recursive: true, force: true }); w.close(); });
  const tools = new FakeTools();
  const active: UnitState = { active: "active", sub: "running", mainPid: process.pid };
  const s = await startService({
    agentDoor: join(dir, "cdp.sock"), controlDoor: join(dir, "control.sock"), daemonCommand: join(dir, "daemon-command.json"), log: () => {}, mainPid: async () => null,
    lists: { listsFolder: join(dir, "lists"), stateFolder: w.paths.state },
    unit: { paths: w.paths, owner: async () => active, tools, procs: w.procs, part: { unit: w.deps(tools), firstCheckMs: 3_600_000 } },
  });
  try {
    const d = (s.agent as any).relay.model.chromeDownloads;
    assert.ok(d instanceof ChromeDownloads, "the model has the guard");
    assert.equal(d.folder, w.paths.downloads);
    assert.equal(w.paths.downloads, join(w.paths.state, "home", "Downloads"));
  } finally { await s.stop(); }
  const s2 = await startService({ agentDoor: join(dir, "cdp2.sock"), controlDoor: join(dir, "control2.sock"), daemonCommand: join(dir, "daemon-command.json"), log: () => {}, mainPid: async () => null });
  try { assert.equal((s2.agent as any)?.relay.model.chromeDownloads ?? null, null, "no unit: no folder, no removal"); } finally { await s2.stop(); }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
