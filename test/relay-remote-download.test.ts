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
import { DOWNLOAD_ITEM_SLACK_MS } from "../src/relay/model.ts";
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

/**
 * Chrome's events of one download in a tab, and its item in chrome.downloads (complete, at `filename`, started now).
 * `url`: CDP's URL (after every redirect, Chrome's `finalUrl`); `original`: chrome.downloads' `url` (before the redirects;
 * by default `url`). `item`: more fields of the item in the search (for example an old `startTime`).
 */
function download(h: Harness, tab: number, o: { guid: string; id: number; url: string; filename: string; original?: string; item?: Record<string, unknown> }): { begin(): void; created(): void; done(): void } {
  const ev = (method: string, params: object) => h.fake.emit("debugger.onEvent", { source: { tabId: tab }, method, params });
  const original = o.original ?? o.url;
  return {
    begin: () => {
      h.fake.downloads.push({ id: o.id, url: original, finalUrl: o.url, filename: o.filename, state: "complete", startTime: new Date().toISOString(), ...o.item });
      ev("Page.downloadWillBegin", { frameId: "F1", guid: o.guid, url: o.url, suggestedFilename: "f.txt" });
    },
    created: () => h.fake.emit("downloads.onCreated", { item: { id: o.id, url: original, finalUrl: o.url, state: "in_progress", danger: "safe" } }),
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
    // The path with `..` parts is a string (path.join would take them out): the guard reads its folder with realpath.
    for (const p of [secret, `${folder}/../../outside/secret.txt`, folder, join(folder, "out", "secret.txt")]) {
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

// ------------------------------------------------------------------ the fix round of review-204 (B1: only the download's own item)

test("ab-v16.94.7.8 fix round, B1: a redirected remote download takes only its own item (tied by its finalUrl): an older complete item of another scope whose url is the final URL keeps its file; with no tied item nothing goes", { timeout: 30_000 }, async () => {
  await withRig(async ({ h, dir, downloads, connect }) => {
    const remote = await connect(REMOTE);
    const rt = await tabOf(h, remote);
    const final = "https://a.example/files/r.pdf";
    // A local scope's earlier download of the final URL, ended: its item is complete, and Chrome keeps its copy.
    const localCopy = join(downloads, "r.pdf");
    writeFileSync(localCopy, "local");
    h.fake.downloads.push({ id: 60, url: final, finalUrl: final, filename: localCopy, state: "complete", startTime: new Date(Date.now() - 60_000).toISOString() });
    // The remote download: a click on another URL that the server redirects to the final URL (CDP gives the final URL,
    // chrome.downloads' url is the URL before the redirect).
    const remoteCopy = join(downloads, "r (1).pdf");
    writeFileSync(remoteCopy, "remote");
    const r = download(h, rt, { guid: "rd1", id: 61, url: final, original: "https://a.example/get?id=r", filename: remoteCopy });
    r.begin(); r.created(); r.done();
    await until(() => h.logs.some((l) => l.startsWith(`relay: Chrome's copy of a download of scope ${REMOTE}`)), "the removal's line");
    assert.equal(readFileSync(localCopy, "utf8"), "local", "the other scope's file stays");
    assert.equal(existsSync(remoteCopy), false, "the remote download's own copy goes: its item is tied by its finalUrl");
    assert.ok(h.logs.includes(removedLine(REMOTE)), h.logs.join("\n"));
    assert.ok(!h.fake.sent("downloads.search").some((q) => q.args[0].url !== undefined), "no search by URL for a removal");
    // The same redirect with no downloads.onCreated (no tied item): nothing goes, and the line says why.
    (h.relay.model as any).downloadWaitMs = 300;
    const remoteCopy2 = join(downloads, "r (2).pdf");
    writeFileSync(remoteCopy2, "remote 2");
    const r2 = download(h, rt, { guid: "rd2", id: 62, url: final, original: "https://a.example/get?id=r2", filename: remoteCopy2 });
    r2.begin(); r2.done();
    await until(() => h.logs.includes(keptLine(REMOTE, CHROME_COPY.noItem)), "the line of no item of its own");
    assert.equal(readFileSync(localCopy, "utf8"), "local");
    assert.ok(existsSync(remoteCopy2));
    assert.ok(!h.fake.sent("downloads.search").some((q) => q.args[0].url !== undefined), "still no search by URL");
    noPath(h.logs, dir);
  });
});

test("ab-v16.94.7.8 fix round: an item that is not the download's own gets no removal: another URL, a start before the download (or none), an incognito item, an item of the act, an item that another download holds; each file stays and the line gives the reason", { timeout: 30_000 }, async () => {
  await withRig(async ({ h, dir, downloads, connect }) => {
    (h.relay.model as any).downloadWaitMs = 500;
    const c = await connect(REMOTE);
    const tab = await tabOf(h, c);
    const notOwn = () => h.logs.filter((l) => l === keptLine(REMOTE, CHROME_COPY.notOwn)).length;
    const cases: { name: string; item?: Record<string, unknown>; act?: boolean }[] = [
      { name: "another URL", item: { url: "https://a.example/elsewhere", finalUrl: "https://a.example/elsewhere" } },
      { name: "a start an hour before the download", item: { startTime: new Date(Date.now() - 3_600_000).toISOString() } },
      { name: "no start", item: { startTime: undefined } },
      { name: "an incognito item", item: { incognito: true } },
      { name: "an item of the act", act: true },
    ];
    let id = 80;
    for (const k of cases) {
      const p = join(downloads, `not-own-${id}.bin`);
      writeFileSync(p, k.name);
      const d = download(h, tab, { guid: `n-${id}`, id, url: `https://a.example/n-${id}`, filename: p, item: k.item });
      // The act's incognito download of the same item id came first: the model keeps it hidden (hiddenDownloads).
      if (k.act) h.fake.emit("downloads.onCreated", { item: { id, url: "https://a.example/act", incognito: true, state: "in_progress" } });
      const before = notOwn();
      d.begin(); d.created(); d.done();
      await until(() => notOwn() > before, k.name);
      assert.equal(readFileSync(p, "utf8"), k.name, `${k.name}: the file stays`);
      id++;
    }
    // Two downloads that hold the same item (a second downloads.onCreated of item 90): the later one's end removes nothing.
    const url = "https://a.example/held.bin";
    const held = join(downloads, "held.bin");
    writeFileSync(held, "held");
    const a = download(h, tab, { guid: "h-a", id: 90, url, filename: held });
    const b = download(h, tab, { guid: "h-b", id: 91, url, filename: join(downloads, "held (1).bin") });
    a.begin(); b.begin();
    a.created(); a.created(); // item 90 twice: the first ties h-a, the second h-b
    const before = notOwn();
    b.done();
    await until(() => notOwn() > before, "an item that another download holds");
    assert.equal(readFileSync(held, "utf8"), "held");
    assert.ok(!h.logs.includes(removedLine(REMOTE)), "no removal in this test");
    noPath(h.logs, dir);
  });
});

// ------------------------------------------------------------------ board ab-v16.94.7.10 (recheck-204 N1: no other download's item, also in a race)

/** The removal's line of the scope (removed or not). */
const copyLine = (h: Harness, scope: string) => h.logs.find((l) => l.startsWith(`relay: Chrome's copy of a download of scope ${scope}`));

test("ab-v16.94.7.10, case b: a local download that the server redirected (url X, finalUrl Y) and a remote download of X at the same moment, the local item first: the remote download does not take the local item (only an item whose finalUrl is its URL), and the local scope's Chrome copy stays", { timeout: 30_000 }, async () => {
  await withRig(async ({ h, dir, downloads, connect }) => {
    const local = await connect(LOCAL), remote = await connect(REMOTE);
    const lt = await tabOf(h, local), rt = await tabOf(h, remote);
    const x = "https://a.example/get?id=x", y = "https://a.example/files/y.pdf";
    const localCopy = join(downloads, "y.pdf"), remoteCopy = join(downloads, "x.bin");
    writeFileSync(localCopy, "local"); writeFileSync(remoteCopy, "remote");
    // The local scope asks for X and the server redirects it to Y: CDP gives Y, chrome.downloads url X and finalUrl Y.
    const l = download(h, lt, { guid: "b-l", id: 70, url: y, original: x, filename: localCopy });
    // The remote scope gets X directly.
    const r = download(h, rt, { guid: "b-r", id: 71, url: x, filename: remoteCopy });
    l.begin(); r.begin();
    l.created(); r.created(); // the local item first
    const tied = await until(() => (h.relay.model as any).downloads.get("b-r")?.item, "the remote download's tie");
    r.done();
    await until(() => copyLine(h, REMOTE), "the removal's line");
    assert.equal(readFileSync(localCopy, "utf8"), "local", "the local scope's Chrome copy stays");
    assert.equal(tied, 71, "the remote download took its own item (its finalUrl), not the local one (its url only)");
    // The local item's url is X and it started in the remote download's time: Chrome's other item of the URL, so nothing goes.
    assert.equal(copyLine(h, REMOTE), keptLine(REMOTE, CHROME_COPY.sameUrl));
    assert.equal(readFileSync(remoteCopy, "utf8"), "remote");
    l.done();
    await sleep(150);
    assert.equal(readFileSync(localCopy, "utf8"), "local");
    noPath(h.logs, dir);
  });
});

test("ab-v16.94.7.10, case a: the item of a download that the model does not follow (a tab with no client) has the remote download's final URL and comes first, so the remote download takes it; Chrome's other item of the URL in the download's time stops the removal, and that tab's copy stays", { timeout: 30_000 }, async () => {
  await withRig(async ({ h, dir, downloads, connect }) => {
    const remote = await connect(REMOTE);
    const rt = await tabOf(h, remote);
    const url = "https://a.example/a.zip";
    const otherCopy = join(downloads, "a.zip"), remoteCopy = join(downloads, "a (1).zip");
    writeFileSync(otherCopy, "other"); writeFileSync(remoteCopy, "remote");
    const r = download(h, rt, { guid: "a-r", id: 73, url, filename: remoteCopy });
    r.begin();
    // The other download: only its item reaches the model (no Page.downloadWillBegin of a tab with a client).
    h.fake.downloads.push({ id: 72, url, finalUrl: url, filename: otherCopy, state: "complete", startTime: new Date().toISOString() });
    h.fake.emit("downloads.onCreated", { item: { id: 72, url, finalUrl: url, state: "in_progress", danger: "safe" } });
    r.created();
    assert.equal(await until(() => (h.relay.model as any).downloads.get("a-r")?.item, "the tie"), 72, "the race: the remote download took the other item");
    r.done();
    await until(() => copyLine(h, REMOTE), "the removal's line");
    assert.equal(readFileSync(otherCopy, "utf8"), "other", "the other download's Chrome copy stays");
    assert.equal(copyLine(h, REMOTE), keptLine(REMOTE, CHROME_COPY.sameUrl));
    assert.ok(existsSync(remoteCopy));
    noPath(h.logs, dir);
  });
});

test("ab-v16.94.7.10: a plain remote download still removes its own copy: Chrome's item of the same URL that started more than 10 s before the download, and an item of another URL in its time, do not stop it; the search is one search by the start, never by the URL", { timeout: 30_000 }, async () => {
  await withRig(async ({ h, dir, downloads, connect }) => {
    const remote = await connect(REMOTE);
    const rt = await tabOf(h, remote);
    const url = "https://a.example/p.txt";
    const old = join(downloads, "p.txt"), elsewhere = join(downloads, "q.txt"), chrome = join(downloads, "p (1).txt");
    for (const f of [old, elsewhere, chrome]) writeFileSync(f, f);
    h.fake.downloads.push({ id: 74, url, finalUrl: url, filename: old, state: "complete", startTime: new Date(Date.now() - DOWNLOAD_ITEM_SLACK_MS - 5_000).toISOString() });
    h.fake.downloads.push({ id: 75, url: "https://a.example/q.txt", finalUrl: "https://a.example/q.txt", filename: elsewhere, state: "complete", startTime: new Date().toISOString() });
    const before = Date.now();
    const r = download(h, rt, { guid: "p-r", id: 76, url, filename: chrome });
    r.begin(); r.created(); r.done();
    await until(() => copyLine(h, REMOTE), "the removal's line");
    assert.equal(copyLine(h, REMOTE), removedLine(REMOTE), h.logs.join("\n"));
    assert.equal(existsSync(chrome), false, "its own copy goes");
    assert.ok(existsSync(old) && existsSync(elsewhere), "the other items' files stay");
    const byStart = h.fake.sent("downloads.search").filter((q) => q.args[0].startedAfter !== undefined);
    assert.equal(byStart.length, 1, "one search by the start");
    assert.deepEqual(Object.keys(byStart[0].args[0]), ["startedAfter"], "by the start only, never by the URL");
    const after = Date.parse(byStart[0].args[0].startedAfter);
    assert.ok(after >= before - DOWNLOAD_ITEM_SLACK_MS - 1 && after <= Date.now() - DOWNLOAD_ITEM_SLACK_MS, `the start: 10 s before Page.downloadWillBegin (${byStart[0].args[0].startedAfter})`);
    noPath(h.logs, dir);
  });
});

test("ab-v16.94.7.10: a failed search for Chrome's other items of the URL removes nothing; the client still hears completed and has its copy", { timeout: 30_000 }, async () => {
  await withRig(async ({ h, dir, downloads, connect }) => {
    const c = await connect(REMOTE);
    const tab = await tabOf(h, c);
    const folder = join(dir, "client");
    mkdirSync(folder, { mode: 0o700 });
    await c.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: folder, eventsEnabled: true });
    h.fake.op = ({ op, args }) => (op === "downloads.search" && args[0]?.startedAfter !== undefined ? { error: "Invalid query." } : undefined);
    const chrome = join(downloads, "s.txt");
    writeFileSync(chrome, "file content");
    const d = download(h, tab, { guid: "sf", id: 77, url: "https://a.example/s.txt", filename: chrome });
    const done = c.waitForEvent("Browser.downloadProgress", { predicate: (p: any) => p.guid === "sf" && p.state !== "inProgress" });
    d.begin(); d.created(); d.done();
    assert.equal((await done).state, "completed");
    assert.equal(readFileSync(join(folder, "sf"), "utf8"), "file content");
    assert.equal(readFileSync(chrome, "utf8"), "file content", "Chrome's copy stays");
    assert.equal(copyLine(h, REMOTE), keptLine(REMOTE, CHROME_COPY.searchFailed));
    noPath(h.logs, dir);
  });
});

test("ab-v16.94.7.10: a local download is unchanged: its item ties by its url (an item whose finalUrl only is its URL does not), the copy searches as before, no search by the start, and Chrome's copy stays", { timeout: 30_000 }, async () => {
  await withRig(async ({ h, dir, downloads, connect }) => {
    const local = await connect(LOCAL);
    const lt = await tabOf(h, local);
    const folder = join(dir, "client");
    mkdirSync(folder, { mode: 0o700 });
    await local.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: folder, eventsEnabled: true });
    const model = h.relay.model as any;
    // A plain download: tied by its url, the copy by the item's id.
    const plain = join(downloads, "u.txt");
    writeFileSync(plain, "plain");
    const u = download(h, lt, { guid: "u1", id: 78, url: "https://a.example/u.txt", filename: plain });
    const done = local.waitForEvent("Browser.downloadProgress", { predicate: (p: any) => p.guid === "u1" && p.state !== "inProgress" });
    u.begin(); u.created();
    assert.equal(await until(() => model.downloads.get("u1")?.item, "the tie"), 78);
    u.done();
    assert.equal((await done).state, "completed");
    assert.equal(readFileSync(join(folder, "u1"), "utf8"), "plain");
    assert.ok(h.fake.sent("downloads.search").some((q) => q.args[0].id === 78), "the copy's search by the item's id");
    // A redirected download (chrome.downloads url X, finalUrl the CDP URL): no tie, as before; the copy searches by the URL.
    const v = download(h, lt, { guid: "v1", id: 79, url: "https://a.example/files/v.txt", original: "https://a.example/get?id=v", filename: join(downloads, "v.txt") });
    v.begin(); v.created();
    await sleep(100);
    assert.equal(model.downloads.get("v1")?.item, undefined, "a local download takes no item by its finalUrl");
    model.downloadWaitMs = 300;
    const vDone = local.waitForEvent("Browser.downloadProgress", { predicate: (p: any) => p.guid === "v1" && p.state !== "inProgress" });
    v.done();
    await vDone;
    assert.ok(h.fake.sent("downloads.search").some((q) => q.args[0].url === "https://a.example/files/v.txt"), "the copy's search by the URL, as before");
    assert.ok(!h.fake.sent("downloads.search").some((q) => q.args[0].startedAfter !== undefined), "no search by the start for a local download");
    assert.ok(existsSync(plain), "the local scope's Chrome copy stays");
    assert.ok(!h.logs.some((l) => l.includes("Chrome's copy")), "no line of a removal");
    noPath(h.logs, dir);
  });
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
