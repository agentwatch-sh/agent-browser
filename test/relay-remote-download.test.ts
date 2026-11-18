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
import { DOWNLOAD_ITEM_LATE_MS, DOWNLOAD_ITEM_SLACK_MS } from "../src/relay/model.ts";
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

/** The searches other than by the start only (ab-v16.94.37: the copy by the tied item's id also reads Chrome's items of the download's time). */
const notByStart = (h: Harness) => h.fake.sent("downloads.search").map((q) => q.args[0]).filter((q) => Object.keys(q).join() !== "startedAfter");

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
    // The removal's search fails (it comes after the client's copy; ab-v16.94.37: the copy's own search by the start comes before it).
    h.fake.op = ({ op, args }) => (op === "downloads.search" && args[0]?.startedAfter !== undefined && existsSync(join(folder, "sf")) ? { error: "Invalid query." } : undefined);
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

test("ab-v16.94.7.10, ab-v16.94.36: a plain local download is unchanged: its item ties (its url and its finalUrl are its URL), the copy searches by the item's id only, and Chrome's copy stays", { timeout: 30_000 }, async () => {
  await withRig(async ({ h, dir, downloads, connect }) => {
    const local = await connect(LOCAL);
    const lt = await tabOf(h, local);
    const folder = join(dir, "client");
    mkdirSync(folder, { mode: 0o700 });
    await local.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: folder, eventsEnabled: true });
    const model = h.relay.model as any;
    // A plain download: tied, the copy by the item's id.
    const plain = join(downloads, "u.txt");
    writeFileSync(plain, "plain");
    const u = download(h, lt, { guid: "u1", id: 78, url: "https://a.example/u.txt", filename: plain });
    const done = local.waitForEvent("Browser.downloadProgress", { predicate: (p: any) => p.guid === "u1" && p.state !== "inProgress" });
    u.begin(); u.created();
    assert.equal(await until(() => model.downloads.get("u1")?.item, "the tie"), 78);
    u.done();
    assert.equal((await done).state, "completed");
    assert.equal(readFileSync(join(folder, "u1"), "utf8"), "plain");
    assert.deepEqual(notByStart(h), [{ id: 78 }], "the copy reads its item by the item's id only (ab-v16.94.37: also one search by the start), never by the URL");
    assert.ok(existsSync(plain), "the local scope's Chrome copy stays");
    assert.ok(!h.logs.some((l) => l.includes("Chrome's copy")), "no line of a removal");
    noPath(h.logs, dir);
  });
});

// ------------------------------------------------------------------ board ab-v16.94.36 (a redirected download of a local scope)

// Measured (one run, /usr/bin/chromium 156 on the Linux server, 2026-11-17): for a download that the server redirected
// from X to Y, chrome.downloads.search({ url: Y }) gives no item, search({ url: X }) and search({ finalUrl: Y }) give it.
// The fake's search by `url` is the same: it matches the item's url, the URL before the redirects.

/** A local client with a folder (allowAndName), as agent-browser's download command and Playwright with a downloadPath. */
async function localClient(r: Rig): Promise<{ c: CDPConnection; tab: number; folder: string }> {
  const c = await r.connect(LOCAL);
  const tab = await tabOf(r.h, c);
  const folder = join(r.dir, "client");
  mkdirSync(folder, { mode: 0o700 });
  await c.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: folder, eventsEnabled: true });
  return { c, tab, folder };
}

const ended = (c: CDPConnection, guid: string) => c.waitForEvent("Browser.downloadProgress", { predicate: (p: any) => p.guid === guid && p.state !== "inProgress" });

test("ab-v16.94.36: a redirected local download reaches the client's folder: its item ties by its finalUrl (its url is the URL before the redirect), the copy searches by the item's id only, and Chrome's copy stays", { timeout: 30_000 }, async () => {
  await withRig(async (r) => {
    const { h, dir, downloads } = r;
    const { c, tab, folder } = await localClient(r);
    (h.relay.model as any).downloadWaitMs = 1000;
    const chrome = join(downloads, "v.txt");
    writeFileSync(chrome, "redirected");
    const v = download(h, tab, { guid: "v1", id: 100, url: "https://a.example/files/v.txt", original: "https://a.example/get?id=v", filename: chrome });
    const done = ended(c, "v1");
    v.begin(); v.created(); v.done();
    assert.equal((await done).state, "completed", "the client hears completed");
    assert.equal(readFileSync(join(folder, "v1"), "utf8"), "redirected", "the file is in the client's folder");
    assert.deepEqual(notByStart(h), [{ id: 100 }], "the copy reads its item by the tied item's id only (ab-v16.94.37: also one search by the start), never by the URL");
    assert.equal(readFileSync(chrome, "utf8"), "redirected", "the local scope's Chrome copy stays");
    assert.ok(!h.logs.some((l) => l.includes("Chrome's copy")), "no line of a removal");
    noPath(h.logs, dir);
  });
});

test("ab-v16.94.36: with no tied item (no downloads.onCreated), the copy takes the local download's own item by its finalUrl among Chrome's items of the download's time (one search by the start, never by the URL); a redirected and a plain download reach the client's folder", { timeout: 30_000 }, async () => {
  await withRig(async (r) => {
    const { h, dir, downloads } = r;
    const { c, tab, folder } = await localClient(r);
    (h.relay.model as any).downloadWaitMs = 1000;
    // Another URL's item of the same time, and an item of the URL that started more than 10 s before the download: neither is taken, neither stops the copy.
    const elsewhere = join(downloads, "q.txt"), old = join(downloads, "w-old.txt");
    writeFileSync(elsewhere, "elsewhere"); writeFileSync(old, "old");
    h.fake.downloads.push({ id: 101, url: "https://a.example/q.txt", finalUrl: "https://a.example/q.txt", filename: elsewhere, state: "complete", startTime: new Date().toISOString() });
    h.fake.downloads.push({ id: 102, url: "https://a.example/w.txt", finalUrl: "https://a.example/w.txt", filename: old, state: "complete", startTime: new Date(Date.now() - DOWNLOAD_ITEM_SLACK_MS - 5_000).toISOString() });
    const cases = [
      { guid: "w1", id: 103, url: "https://a.example/files/w.txt", original: "https://a.example/get?id=w", content: "redirected" },
      { guid: "w2", id: 104, url: "https://a.example/w.txt", content: "plain" },
    ];
    for (const k of cases) {
      const chrome = join(downloads, `${k.guid}.chrome`);
      writeFileSync(chrome, k.content);
      const d = download(h, tab, { ...k, filename: chrome });
      const done = ended(c, k.guid);
      const before = h.fake.sent("downloads.search").length;
      d.begin(); d.done();
      assert.equal((await done).state, "completed", `${k.content}: the client hears completed`);
      assert.equal(readFileSync(join(folder, k.guid), "utf8"), k.content, `${k.content}: its own file is in the client's folder`);
      const searches = h.fake.sent("downloads.search").slice(before).map((q) => q.args[0]);
      assert.ok(searches.length >= 1 && searches.every((q) => Object.keys(q).join() === "startedAfter"), `${k.content}: by the start only, never by the URL: ${JSON.stringify(searches)}`);
      assert.equal(readFileSync(chrome, "utf8"), k.content, `${k.content}: the local scope's Chrome copy stays`);
    }
    noPath(h.logs, dir);
  });
});

test("ab-v16.94.36: two downloads of the same final URL in the download's time give the local client no wrong file: with no tied item it takes nothing and hears canceled; an item whose url only is the download's URL never ties", { timeout: 30_000 }, async () => {
  await withRig(async (r) => {
    const { h, dir, downloads } = r;
    const { c, tab, folder } = await localClient(r);
    (h.relay.model as any).downloadWaitMs = 400;
    const y = "https://a.example/files/y.pdf";
    // 1. The local download asks for X and the server redirects it to Y; a download of Y of a tab with no client (its url
    // is Y) is in the same time, and the local download has no tied item. The other download's file never reaches the client.
    const own1 = join(downloads, "y.pdf"), other1 = join(downloads, "y (1).pdf");
    writeFileSync(own1, "own 1"); writeFileSync(other1, "other 1");
    const l1 = download(h, tab, { guid: "t1", id: 110, url: y, original: "https://a.example/get?id=y", filename: own1 });
    l1.begin();
    h.fake.downloads.push({ id: 111, url: y, finalUrl: y, filename: other1, state: "complete", startTime: new Date().toISOString() });
    let done = ended(c, "t1");
    l1.done();
    assert.equal((await done).state, "canceled", "1: the client hears canceled");
    assert.equal(existsSync(join(folder, "t1")), false, "1: no file in the client's folder, never the other download's");
    // 2. A plain local download of Y2 with no tied item, and another download that the server redirected to Y2 (its url
    // is Z) in the same time: two items whose finalUrl is Y2, so the copy takes neither.
    const y2 = "https://a.example/files/y2.pdf";
    const own2 = join(downloads, "y2.pdf"), other2 = join(downloads, "y2 (1).pdf");
    writeFileSync(own2, "own 2"); writeFileSync(other2, "other 2");
    const l2 = download(h, tab, { guid: "t2", id: 112, url: y2, filename: own2 });
    l2.begin();
    h.fake.downloads.push({ id: 113, url: "https://a.example/get?id=z", finalUrl: y2, filename: other2, state: "complete", startTime: new Date().toISOString() });
    done = ended(c, "t2");
    l2.done();
    assert.equal((await done).state, "canceled", "2: the client hears canceled");
    assert.equal(existsSync(join(folder, "t2")), false, "2: no file in the client's folder");
    // 3. The tie: a local download of P, and Chrome's item of another download that asked for P and that the server
    // redirected elsewhere (url P, finalUrl Q) comes first. The local download takes only its own item (finalUrl P).
    const p = "https://a.example/p.bin";
    const other3 = join(downloads, "q.bin"), own3 = join(downloads, "p.bin");
    writeFileSync(other3, "other 3"); writeFileSync(own3, "own 3");
    const l3 = download(h, tab, { guid: "t3", id: 115, url: p, filename: own3 });
    l3.begin();
    h.fake.downloads.push({ id: 114, url: p, finalUrl: "https://a.example/q.bin", filename: other3, state: "complete", startTime: new Date().toISOString() });
    h.fake.emit("downloads.onCreated", { item: { id: 114, url: p, finalUrl: "https://a.example/q.bin", state: "in_progress", danger: "safe" } });
    l3.created();
    assert.equal(await until(() => (h.relay.model as any).downloads.get("t3")?.item, "the tie"), 115, "3: the local download took its own item, not the one whose url only is its URL");
    done = ended(c, "t3");
    l3.done();
    assert.equal((await done).state, "completed");
    assert.equal(readFileSync(join(folder, "t3"), "utf8"), "own 3", "3: its own file, not the other download's");
    for (const [f, s] of [[own1, "own 1"], [other1, "other 1"], [own2, "own 2"], [other2, "other 2"], [own3, "own 3"], [other3, "other 3"]]) assert.equal(readFileSync(f, "utf8"), s, "each Chrome copy stays");
    noPath(h.logs, dir);
  });
});

test("ab-v16.94.36: a redirected remote download with a client folder and no tied item reaches the client's folder by the copy's search, but the removal never takes that item: Chrome's copy stays (no item of its own)", { timeout: 30_000 }, async () => {
  await withRig(async ({ h, dir, downloads, connect }) => {
    (h.relay.model as any).downloadWaitMs = 500;
    const c = await connect(REMOTE);
    const tab = await tabOf(h, c);
    const folder = join(dir, "mcp-remote", "box1", "web-9");
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    await c.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: folder, eventsEnabled: true });
    const chrome = join(downloads, "r.pdf");
    writeFileSync(chrome, "remote");
    const d = download(h, tab, { guid: "rr1", id: 120, url: "https://a.example/files/r.pdf", original: "https://a.example/get?id=r", filename: chrome });
    const done = ended(c, "rr1");
    d.begin(); d.done();
    assert.equal((await done).state, "completed");
    assert.equal(readFileSync(join(folder, "rr1"), "utf8"), "remote", "the client's copy");
    assert.equal(readFileSync(chrome, "utf8"), "remote", "Chrome's copy stays");
    assert.equal(copyLine(h, REMOTE), keptLine(REMOTE, CHROME_COPY.noItem));
    assert.ok(!h.fake.sent("downloads.search").some((q) => q.args[0].url !== undefined), "no search by URL");
    noPath(h.logs, dir);
  });
});

// ------------------------------------------------------------------ board ab-v16.94.37 (review-207 N1-N4: the tie and the cancel never take another download's item)

/** Later than the download's begin by more than DOWNLOAD_ITEM_LATE_MS: an item that started then is a later download's. */
const LATER_MS = DOWNLOAD_ITEM_LATE_MS + 3_000;
/** A time (ISO 8601) `ms` from now, for an item's startTime or endTime. */
const at = (ms: number) => new Date(Date.now() + ms).toISOString();
const cancels = (h: Harness) => h.fake.sent("downloads.cancel").map((q) => q.args[0]);

test("ab-v16.94.37, N1: Browser.cancelDownload cancels only the download's own item: a redirected download with no tied item, the one item of its time; never another download's item of its final URL, also when the tie took that item; the answer is CDP's {}", { timeout: 30_000 }, async () => {
  await withRig(async (r) => {
    const { h, dir, downloads } = r;
    const { c, tab } = await localClient(r);
    const running = { state: "in_progress" };
    // 1. No tied item, redirected (url X, finalUrl Y; CDP gives Y): its own item is the one item of Y in its time.
    const c1 = download(h, tab, { guid: "c1", id: 130, url: "https://a.example/files/c1.bin", original: "https://a.example/get?id=c1", filename: join(downloads, "c1.bin"), item: running });
    c1.begin();
    assert.deepEqual(await c.send("Browser.cancelDownload", { guid: "c1" }), {}, "1: CDP's answer");
    assert.deepEqual(cancels(h), [130], "1: the download's own item, by its finalUrl");
    // 2. No tied item, redirected to Y2, and another download's item whose url is Y2 (a tab with no client) in the same
    // time: two items of Y2, so the model cancels no item; the answer is still {}.
    const y2 = "https://a.example/files/c2.bin";
    const c2 = download(h, tab, { guid: "c2", id: 131, url: y2, original: "https://a.example/get?id=c2", filename: join(downloads, "c2.bin"), item: running });
    c2.begin();
    h.fake.downloads.push({ id: 132, url: y2, finalUrl: y2, filename: join(downloads, "c2 (1).bin"), state: "in_progress", startTime: at(0) });
    assert.deepEqual(await c.send("Browser.cancelDownload", { guid: "c2" }), {}, "2: CDP's answer");
    assert.deepEqual(cancels(h), [130], "2: no item at all, never the other download's item 132");
    // 3. The tie took the item of a tab with no client (same final URL, its downloads.onCreated first): the download's
    // own item is in its time and no download holds it, so the tied item may be the other one's, and no item is canceled.
    const y3 = "https://a.example/c3.bin";
    const c3 = download(h, tab, { guid: "c3", id: 134, url: y3, filename: join(downloads, "c3.bin"), item: running });
    c3.begin();
    h.fake.downloads.push({ id: 133, url: y3, finalUrl: y3, filename: join(downloads, "c3 (1).bin"), state: "in_progress", startTime: at(0) });
    h.fake.emit("downloads.onCreated", { item: { id: 133, url: y3, finalUrl: y3, state: "in_progress", danger: "safe" } });
    c3.created();
    assert.equal(await until(() => (h.relay.model as any).downloads.get("c3")?.item, "the tie"), 133, "3: the race: the tie took the other item");
    assert.deepEqual(await c.send("Browser.cancelDownload", { guid: "c3" }), {});
    assert.deepEqual(cancels(h), [130], "3: never the other download's item 133");
    // 4. A plain tied download: its tied item, as before.
    const c4 = download(h, tab, { guid: "c4", id: 135, url: "https://a.example/c4.bin", filename: join(downloads, "c4.bin"), item: running });
    c4.begin(); c4.created();
    await until(() => (h.relay.model as any).downloads.get("c4")?.item, "the tie");
    assert.deepEqual(await c.send("Browser.cancelDownload", { guid: "c4" }), {});
    assert.deepEqual(cancels(h), [130, 135], "4: the tied item");
    assert.ok(!h.fake.sent("downloads.search").some((q) => q.args[0].url !== undefined), "no search by URL");
    noPath(h.logs, dir);
  });
});

test("ab-v16.94.37, N2: the copy by the tied item's id gives no file while Chrome has another item of its final URL in its time that no download of its scope holds (a tab with no client, another scope's download, a failed search): the client hears canceled", { timeout: 30_000 }, async () => {
  await withRig(async (r) => {
    const { h, dir, downloads } = r;
    const { c, tab, folder } = await localClient(r);
    (h.relay.model as any).downloadWaitMs = 400;
    // a. #206 case a for the copy: the item of a tab with no client (same final URL) comes first and ties the download.
    const ua = "https://a.example/n1.bin";
    const own1 = join(downloads, "n1.bin"), other1 = join(downloads, "n1 (1).bin");
    writeFileSync(own1, "own 1"); writeFileSync(other1, "other 1");
    const n1 = download(h, tab, { guid: "n1", id: 140, url: ua, filename: own1 });
    n1.begin();
    h.fake.downloads.push({ id: 141, url: ua, finalUrl: ua, filename: other1, state: "complete", startTime: at(0) });
    h.fake.emit("downloads.onCreated", { item: { id: 141, url: ua, finalUrl: ua, state: "in_progress", danger: "safe" } });
    n1.created();
    assert.equal(await until(() => (h.relay.model as any).downloads.get("n1")?.item, "the tie"), 141, "a: the race: the tie took the other item");
    let done = ended(c, "n1");
    n1.done();
    assert.equal((await done).state, "canceled", "a: the client hears canceled");
    assert.equal(existsSync(join(folder, "n1")), false, "a: never the other download's file");
    // b. A swap with another scope's download of the same URL: each tie takes the other's item.
    const remote = await r.connect(REMOTE);
    const rt = await tabOf(h, remote);
    const ub = "https://a.example/n2.bin";
    const own2 = join(downloads, "n2.bin"), other2 = join(downloads, "n2 (1).bin");
    writeFileSync(own2, "own 2"); writeFileSync(other2, "remote 2");
    const n2 = download(h, tab, { guid: "n2", id: 142, url: ub, filename: own2 });
    const r2 = download(h, rt, { guid: "r2", id: 143, url: ub, filename: other2 });
    n2.begin(); r2.begin();
    r2.created(); n2.created(); // the remote item first: it ties the local download (the first one), the local item the remote one
    assert.equal(await until(() => (h.relay.model as any).downloads.get("n2")?.item, "the tie"), 143, "b: the swap");
    done = ended(c, "n2");
    n2.done();
    assert.equal((await done).state, "canceled", "b: the client hears canceled");
    assert.equal(existsSync(join(folder, "n2")), false, "b: never the other scope's file");
    r2.done();
    await until(() => copyLine(h, REMOTE), "the remote download's end");
    // c. A failed search for Chrome's items of the download's time: no file (the copy fails closed).
    const own3 = join(downloads, "n3.bin");
    writeFileSync(own3, "own 3");
    h.fake.op = ({ op, args }) => (op === "downloads.search" && args[0]?.startedAfter !== undefined ? { error: "Invalid query." } : undefined);
    const n3 = download(h, tab, { guid: "n3", id: 144, url: "https://a.example/n3.bin", filename: own3 });
    done = ended(c, "n3");
    n3.begin(); n3.created(); n3.done();
    assert.equal((await done).state, "canceled", "c: the client hears canceled");
    assert.equal(existsSync(join(folder, "n3")), false, "c: no file");
    h.fake.op = () => undefined;
    for (const [f, s] of [[own1, "own 1"], [other1, "other 1"], [own2, "own 2"], [other2, "remote 2"], [own3, "own 3"]]) assert.equal(readFileSync(f, "utf8"), s, "each Chrome copy stays");
    noPath(h.logs, dir);
  });
});

test("ab-v16.94.37, N2: the copy by the tied item's id is unchanged for the items of its own scope and for items of other times: two downloads of one scope and one URL (also after one ended, also swapped), an earlier item of the URL that ended before the download began, and a later one", { timeout: 30_000 }, async () => {
  await withRig(async (r) => {
    const { h, dir, downloads } = r;
    const { c, tab, folder } = await localClient(r);
    (h.relay.model as any).downloadWaitMs = 1000;
    const file = (name: string, s: string) => { const p = join(downloads, name); writeFileSync(p, s); return p; };
    // Two downloads of one scope and one URL, each tied to its own item; the first ends before the second.
    const u6 = "https://a.example/g.bin";
    const g1 = download(h, tab, { guid: "g1", id: 170, url: u6, filename: file("g1.bin", "g 1") });
    const g2 = download(h, tab, { guid: "g2", id: 171, url: u6, filename: file("g2.bin", "g 2") });
    g1.begin(); g2.begin(); g1.created(); g2.created();
    let done = ended(c, "g1");
    g1.done();
    assert.equal((await done).state, "completed");
    done = ended(c, "g2");
    g2.done();
    assert.equal((await done).state, "completed", "the item of the scope's own download that ended stops nothing");
    assert.deepEqual([readFileSync(join(folder, "g1"), "utf8"), readFileSync(join(folder, "g2"), "utf8")], ["g 1", "g 2"]);
    // Two downloads of one scope and one URL that swap their items: same scope, same URL, so each copy comes.
    const u7 = "https://a.example/s.bin";
    const g3 = download(h, tab, { guid: "g3", id: 172, url: u7, filename: file("g3.bin", "s") });
    const g4 = download(h, tab, { guid: "g4", id: 173, url: u7, filename: file("g4.bin", "s") });
    g3.begin(); g4.begin(); g4.created(); g3.created();
    done = ended(c, "g3");
    g3.done();
    assert.equal((await done).state, "completed");
    done = ended(c, "g4");
    g4.done();
    assert.equal((await done).state, "completed");
    // A plain download whose URL has an earlier item that ended before it began (a repeat), and a later item of the URL
    // (a download that began more than 2 s after it, of a tab with no client): neither stops the copy.
    const u8 = "https://a.example/p.bin";
    h.fake.downloads.push({ id: 176, url: u8, finalUrl: u8, filename: file("p-old.bin", "old"), state: "complete", startTime: at(-3_000), endTime: at(-2_000) });
    const g5 = download(h, tab, { guid: "g5", id: 174, url: u8, filename: file("p.bin", "p") });
    g5.begin(); g5.created();
    h.fake.downloads.push({ id: 175, url: u8, finalUrl: u8, filename: file("p-later.bin", "later"), state: "in_progress", startTime: at(LATER_MS) });
    done = ended(c, "g5");
    g5.done();
    assert.equal((await done).state, "completed");
    assert.equal(readFileSync(join(folder, "g5"), "utf8"), "p", "its own file");
    noPath(h.logs, dir);
  });
});

test("ab-v16.94.37, N3: a repeat download of the same URL with no tied item takes its own item: an earlier item of the URL that ended before the download began is not counted; one that ended after it began still is", { timeout: 30_000 }, async () => {
  await withRig(async (r) => {
    const { h, dir, downloads } = r;
    const { c, tab, folder } = await localClient(r);
    (h.relay.model as any).downloadWaitMs = 400;
    const u = "https://a.example/repeat.csv";
    const earlier = join(downloads, "repeat.csv"), own = join(downloads, "repeat (1).csv");
    writeFileSync(earlier, "earlier"); writeFileSync(own, "own");
    // The first download of the URL started 3 s ago and ended 2 s ago (its download is no longer the model's).
    h.fake.downloads.push({ id: 150, url: u, finalUrl: u, filename: earlier, state: "complete", startTime: at(-3_000), endTime: at(-2_000) });
    const d = download(h, tab, { guid: "rp1", id: 151, url: u, filename: own });
    let done = ended(c, "rp1");
    d.begin(); d.done();
    assert.equal((await done).state, "completed", "the client hears completed");
    assert.equal(readFileSync(join(folder, "rp1"), "utf8"), "own", "its own file, not the earlier one");
    // An item of the URL that ended after the download began may be its own: two items, so none is taken.
    const u2 = "https://a.example/repeat2.csv";
    const other2 = join(downloads, "repeat2.csv"), own2 = join(downloads, "repeat2 (1).csv");
    writeFileSync(other2, "other"); writeFileSync(own2, "own 2");
    h.fake.downloads.push({ id: 152, url: u2, finalUrl: u2, filename: other2, state: "complete", startTime: at(-3_000), endTime: at(LATER_MS) });
    const d2 = download(h, tab, { guid: "rp2", id: 153, url: u2, filename: own2 });
    done = ended(c, "rp2");
    d2.begin(); d2.done();
    assert.equal((await done).state, "canceled");
    assert.equal(existsSync(join(folder, "rp2")), false);
    noPath(h.logs, dir);
  });
});

test("ab-v16.94.37, N4: with no tied item the copy takes no item that started more than 2 s after the download began: not when its own item is older than its time, and such an item does not stop its own", { timeout: 30_000 }, async () => {
  await withRig(async (r) => {
    const { h, dir, downloads } = r;
    const { c, tab, folder } = await localClient(r);
    (h.relay.model as any).downloadWaitMs = 400;
    // 1. Its own item started 15 s before the model got Page.downloadWillBegin (outside its time), and a later download
    // of the same final URL (a tab with no client) started after it began: the later item is never taken.
    const u = "https://a.example/late.zip";
    const own = join(downloads, "late.zip"), later = join(downloads, "late (1).zip");
    writeFileSync(own, "own"); writeFileSync(later, "later");
    const d = download(h, tab, { guid: "l4", id: 160, url: u, filename: own, item: { startTime: at(-DOWNLOAD_ITEM_SLACK_MS - 5_000) } });
    let done = ended(c, "l4");
    d.begin();
    h.fake.downloads.push({ id: 161, url: u, finalUrl: u, filename: later, state: "complete", startTime: at(LATER_MS) });
    d.done();
    assert.equal((await done).state, "canceled", "1: the client hears canceled");
    assert.equal(existsSync(join(folder, "l4")), false, "1: never the later download's file");
    // 2. Its own item in its time and a later item of the same final URL: its own file.
    const u2 = "https://a.example/late2.zip";
    const own2 = join(downloads, "late2.zip"), later2 = join(downloads, "late2 (1).zip");
    writeFileSync(own2, "own 2"); writeFileSync(later2, "later 2");
    const d2 = download(h, tab, { guid: "l5", id: 162, url: u2, filename: own2 });
    done = ended(c, "l5");
    d2.begin();
    h.fake.downloads.push({ id: 163, url: u2, finalUrl: u2, filename: later2, state: "complete", startTime: at(LATER_MS) });
    d2.done();
    assert.equal((await done).state, "completed", "2: the client hears completed");
    assert.equal(readFileSync(join(folder, "l5"), "utf8"), "own 2", "2: its own file");
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
