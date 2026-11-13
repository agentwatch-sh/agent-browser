// The X selection owner of the service's own display (board ab-t30.19; src/service/unit/clipboard.ts; C11, the paste): a
// small fake X server on a Unix socket in a temp folder of the test's own (removed at the end) speaks the core protocol's
// parts that the owner uses. The tests: the cookie of the display's X authority file, the setup, the ownership with a real
// server time, the targets (TARGETS, TIMESTAMP, UTF8_STRING, text/plain;charset=utf-8) and the refusals, the clear and a
// SelectionClear, an incremental transfer and its stall, the ends at a failure (no answer, a closed connection, a refused
// cookie, no display) with no cookie in a log line, a clear that wins over a hold in flight, the requestor's read, and the
// relay's door of the live rows.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cookieOf, readClipboard, relayTestClipboard, STAGE_CLIPBOARD_ENV, XClipboard } from "../src/service/unit/clipboard.ts";
import { xauthEntry } from "../src/service/unit/xauth.ts";
import { STAGE_TEST_ENV } from "../src/relay/stage.ts";

const pad4 = (n: number) => (4 - (n % 4)) % 4;
type Conn = { sock: Socket; seq: number; buf: Buffer; setup: boolean; windows: Set<number>; idBase: number };
/** A fake X server: its atoms, the CLIPBOARD owner, each property that a request set, each SendEvent, and hooks. */
class FakeX {
  readonly server: Server;
  readonly conns: Conn[] = [];
  readonly atoms = new Map<string, number>([["PRIMARY", 1], ["ATOM", 4], ["INTEGER", 19], ["STRING", 31]]);
  readonly owners = new Map<number, number>();
  readonly props = new Map<string, { type: number; format: number; data: Buffer; mode: number }[]>();
  readonly notifies: { requestor: number; target: number; property: number }[] = [];
  readonly masks = new Map<number, number>();
  readonly ownerTimes: number[] = [];
  stall = false;
  closeAfterSetup = false;
  time = 5000;
  readonly path: string;
  readonly cookie: Buffer;
  constructor(path: string, cookie: Buffer) {
    this.path = path; this.cookie = cookie;
    this.server = createServer((sock) => {
      const c: Conn = { sock, seq: 0, buf: Buffer.alloc(0), setup: false, windows: new Set(), idBase: 0x200000 * (this.conns.length + 1) };
      this.conns.push(c);
      sock.on("data", (d) => { c.buf = Buffer.concat([c.buf, d]); this.read(c); });
      sock.on("error", () => {});
    });
  }
  listen(): Promise<void> { return new Promise((r) => this.server.listen(this.path, () => r())); }
  close(): Promise<void> { for (const c of this.conns) c.sock.destroy(); return new Promise((r) => this.server.close(() => r())); }
  atom(name: string): number { let a = this.atoms.get(name); if (!a) this.atoms.set(name, (a = 100 + this.atoms.size)); return a; }
  private reply(c: Conn, extra = Buffer.alloc(24)): void { const b = Buffer.alloc(32); b[0] = 1; b.writeUInt16LE(c.seq, 2); extra.copy(b, 8); c.sock.write(b); }
  event(c: Conn, code: number, fields: number[]): void { const b = Buffer.alloc(32); b[0] = code; fields.forEach((f, i) => b.writeUInt32LE(f >>> 0, 4 + 4 * i)); c.sock.write(b); }
  /** The connection that owns a window. */
  ownerConn(win: number): Conn | undefined { return this.conns.find((c) => c.windows.has(win)); }
  private read(c: Conn): void {
    if (!c.setup) {
      if (c.buf.length < 12) return;
      const n = c.buf.readUInt16LE(6), d = c.buf.readUInt16LE(8), len = 12 + n + pad4(n) + d + pad4(d);
      if (c.buf.length < len) return;
      const data = c.buf.subarray(12 + n + pad4(n), 12 + n + pad4(n) + d);
      c.buf = c.buf.subarray(len);
      c.setup = true;
      if (!data.equals(this.cookie)) { const why = Buffer.from("Invalid MIT-MAGIC-COOKIE-1 key"); const b = Buffer.alloc(8 + why.length + pad4(why.length)); b[0] = 0; b[1] = why.length; b.writeUInt16LE((b.length - 8) / 4, 6); why.copy(b, 8); c.sock.write(b); return; }
      const vendor = Buffer.from("fake"), b = Buffer.alloc(8 + 32 + 4 + 40);
      b[0] = 1; b.writeUInt16LE(11, 2); b.writeUInt16LE((b.length - 8) / 4, 6);
      b.writeUInt32LE(c.idBase, 12); b.writeUInt32LE(0x1fffff, 16); b.writeUInt16LE(vendor.length, 24); b.writeUInt16LE(65535, 26); b[28] = 1; b[29] = 0;
      vendor.copy(b, 40); b.writeUInt32LE(0x100, 44);
      c.sock.write(b);
      if (this.closeAfterSetup) setTimeout(() => c.sock.destroy(), 5);
    }
    while (c.buf.length >= 4) {
      const len = c.buf.readUInt16LE(2) * 4;
      if (c.buf.length < len) return;
      const r = c.buf.subarray(0, len);
      c.buf = c.buf.subarray(len);
      c.seq = (c.seq + 1) & 0xffff;
      if (this.stall) continue;
      this.request(c, r);
    }
  }
  private request(c: Conn, r: Buffer): void {
    const op = r[0];
    if (op === 16) { const n = r.readUInt16LE(4), a = this.atom(r.subarray(8, 8 + n).toString("latin1")), x = Buffer.alloc(24); x.writeUInt32LE(a, 0); this.reply(c, x); return; }
    if (op === 1) { c.windows.add(r.readUInt32LE(4)); this.masks.set(r.readUInt32LE(4), r.readUInt32LE(32)); return; }
    if (op === 2) { this.masks.set(r.readUInt32LE(4), r.readUInt32LE(12)); return; }
    if (op === 18) {
      const win = r.readUInt32LE(4), prop = r.readUInt32LE(8), type = r.readUInt32LE(12), format = r[16], n = r.readUInt32LE(20) * (r[16] === 32 ? 4 : 1);
      const data = Buffer.from(r.subarray(24, 24 + n)), key = `${win}:${prop}`;
      if (r[1] === 0) this.props.set(key, [{ type, format, data, mode: 0 }]); else this.props.set(key, [...(this.props.get(key) ?? []), { type, format, data, mode: r[1] }]);
      // A property change on a window whose client asked for PropertyChangeMask: PropertyNotify (state 0).
      const oc = this.ownerConn(win);
      if (oc && ((this.masks.get(win) ?? 0) & 0x400000)) this.event(oc, 28, [win, prop, ++this.time, 0]);
      return;
    }
    if (op === 22) {
      const owner = r.readUInt32LE(4), sel = r.readUInt32LE(8), old = this.owners.get(sel);
      this.ownerTimes.push(r.readUInt32LE(12));
      if (old && old !== owner) { const oc = this.ownerConn(old); if (oc) this.event(oc, 29, [++this.time, old, sel]); }
      if (owner) this.owners.set(sel, owner); else this.owners.delete(sel);
      return;
    }
    if (op === 23) { const x = Buffer.alloc(24); x.writeUInt32LE(this.owners.get(r.readUInt32LE(4)) ?? 0, 0); this.reply(c, x); return; }
    if (op === 24) { const [req, sel, target, prop] = [4, 8, 12, 16].map((i) => r.readUInt32LE(i)); const owner = this.owners.get(sel); const oc = owner ? this.ownerConn(owner) : undefined; if (oc) this.event(oc, 30, [++this.time, owner!, req, sel, target, prop]); return; }
    if (op === 25) {
      const e = r.subarray(12, 44);
      if ((e[0] & 0x7f) === 31) {
        const requestor = e.readUInt32LE(8), n = { requestor, target: e.readUInt32LE(16), property: e.readUInt32LE(20) };
        this.notifies.push(n);
        const rc = this.ownerConn(requestor); if (rc) rc.sock.write(Buffer.from(e));
      }
      return;
    }
    if (op === 20) {
      const win = r.readUInt32LE(4), prop = r.readUInt32LE(8), v = this.props.get(`${win}:${prop}`) ?? [], data = Buffer.concat(v.map((x) => x.data));
      const b = Buffer.alloc(32 + data.length + pad4(data.length)); b[0] = 1; b[1] = 8; b.writeUInt16LE(c.seq, 2); b.writeUInt32LE((data.length + pad4(data.length)) / 4, 4); b.writeUInt32LE(v[0]?.type ?? 0, 8); b.writeUInt32LE(data.length, 16); data.copy(b, 32);
      c.sock.write(b);
      return;
    }
  }
  /** A requestor (a window of no client) asks the CLIPBOARD's owner for `target` into `property`. */
  request0(target: string, property = "XSEL_DATA", requestor = 0x900, selection = "CLIPBOARD"): void {
    const sel = this.atom(selection), owner = this.owners.get(sel) ?? this.owners.get(this.atom("CLIPBOARD"))!, oc = this.ownerConn(owner)!;
    this.event(oc, 30, [++this.time, owner, requestor, sel, this.atom(target), this.atom(property)]);
  }
  /** The requestor deleted a property: PropertyNotify (state 1) to the client that asked for its window's PropertyChangeMask. */
  deleted(win: number, property: string): void { if ((this.masks.get(win) ?? 0) & 0x400000) for (const c of this.conns) if (c.windows.size) this.event(c, 28, [win, this.atom(property), ++this.time, 1]); }
  propOf(win: number, property: string) { return this.props.get(`${win}:${this.atom(property)}`); }
}

const COOKIE = Buffer.from("0123456789abcdef");
async function world(o: { display?: number; cookie?: Buffer } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ab-x-"));
  const display = o.display ?? 7, xauth = join(dir, "xauth");
  writeFileSync(xauth, xauthEntry(display, o.cookie ?? COOKIE), { mode: 0o600 });
  const x = new FakeX(join(dir, `X${display}`), COOKIE);
  await x.listen();
  const logs: string[] = [];
  const clip = new XClipboard({ display: () => ({ display, xauth }), socketDir: dir, log: (l) => logs.push(l), waitMs: 150, incrWaitMs: 150, chunkBytes: 1000 });
  return { dir, x, clip, logs, xauth, display, end: async () => { clip.close(); await x.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const until = async (fn: () => boolean, ms = 2000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 2)); } };
const u32s = (b: Buffer) => Array.from({ length: b.length / 4 }, (_, i) => b.readUInt32LE(4 * i));

test("the cookie of the display's X authority file: the MIT-MAGIC-COOKIE-1 of its FamilyWild entry for that display, and none for another display", () => {
  const f = Buffer.concat([xauthEntry(5, Buffer.alloc(16, 1)), xauthEntry(7, COOKIE)]);
  assert.deepEqual(cookieOf(f, 7), COOKIE);
  assert.deepEqual(cookieOf(f, 5), Buffer.alloc(16, 1));
  assert.equal(cookieOf(f, 90), null);
  assert.equal(cookieOf(Buffer.from([0xff]), 7), null, "a cut file gives none");
});

test("hold: the owner takes CLIPBOARD with a real server time (a zero-length property change of its own window, never CurrentTime) and answers TARGETS, TIMESTAMP, UTF8_STRING and text/plain;charset=utf-8 with the text, and refuses STRING, MULTIPLE and another selection", async () => {
  const w = await world();
  try {
    assert.equal(await w.clip.hold("héllo wörld"), true);
    const clip = w.x.atom("CLIPBOARD");
    assert.equal(w.x.owners.get(clip), w.clip.window, "the owner's window owns CLIPBOARD");
    assert.ok(w.x.ownerTimes[0] > 5000, `a server time (${w.x.ownerTimes[0]}), not CurrentTime`);
    w.x.request0("TARGETS");
    await until(() => w.x.notifies.length === 1);
    const t = w.x.propOf(0x900, "XSEL_DATA")![0];
    assert.deepEqual([t.type, t.format, u32s(t.data)], [4, 32, ["TARGETS", "TIMESTAMP", "UTF8_STRING", "text/plain;charset=utf-8"].map((n) => w.x.atom(n))]);
    assert.equal(w.x.notifies[0].property, w.x.atom("XSEL_DATA"));
    for (const [i, target] of ["UTF8_STRING", "text/plain;charset=utf-8"].entries()) {
      w.x.request0(target, `P${i}`);
      await until(() => w.x.notifies.length === 2 + i);
      const p = w.x.propOf(0x900, `P${i}`)![0];
      assert.deepEqual([p.type, p.format, p.data.toString("utf8")], [w.x.atom(target), 8, "héllo wörld"], target);
    }
    w.x.request0("TIMESTAMP", "PT");
    await until(() => w.x.notifies.length === 4);
    assert.deepEqual(u32s(w.x.propOf(0x900, "PT")![0].data), [w.x.ownerTimes[0]]);
    for (const [k, target] of ["STRING", "MULTIPLE"].entries()) {
      w.x.request0(target, `R${k}`);
      await until(() => w.x.notifies.length === 5 + k);
      assert.equal(w.x.notifies.at(-1)!.property, 0, `${target}: refused (property None)`);
      assert.equal(w.x.propOf(0x900, `R${k}`), undefined);
    }
    w.x.request0("UTF8_STRING", "RP", 0x900, "PRIMARY");
    await until(() => w.x.notifies.length === 7);
    assert.equal(w.x.notifies.at(-1)!.property, 0, "another selection: refused");
    assert.equal(w.clip.counts.refusals, 3);
  } finally { await w.end(); }
});

test("clear: the selection goes (SetSelectionOwner None, with the time of its acquisition: ICCCM 2.3, review-126 note 5) and the text with it: a later request is refused; the owner's own clear is no take by another client; another client's take (a SelectionClear) clears the text too", async () => {
  const w = await world();
  try {
    await w.clip.hold("secret");
    w.clip.clear();
    await until(() => !w.x.owners.has(w.x.atom("CLIPBOARD")));
    const [took, gave] = w.x.ownerTimes.slice(-2);
    assert.ok(took > 0 && gave === took, `the selection taken at ${took} and given up with ${gave}`);
    assert.equal(w.clip.holding, false);
    assert.equal(w.clip.counts.takenByOther, undefined, "the owner's own clear");
    await w.clip.hold("secret two");
    // Another client takes CLIPBOARD (a page's copy in Chrome): the server tells the owner.
    w.x.owners.set(w.x.atom("CLIPBOARD"), 0x777);
    w.x.event(w.x.ownerConn(w.clip.window)!, 29, [9999, w.clip.window, w.x.atom("CLIPBOARD")]);
    await until(() => !w.clip.holding);
    assert.equal(w.clip.counts.takenByOther, 1);
  } finally { await w.end(); }
});

test("an incremental transfer (ICCCM 2.7.2, INCR): a text above one chunk goes as the type INCR with its size, then one chunk at each deletion of the property, then a chunk of 0 bytes; a requestor that does not read in incrWaitMs stops it", async () => {
  const w = await world();
  try {
    const text = "0123456789".repeat(350);
    await w.clip.hold(text);
    w.x.request0("UTF8_STRING", "BIG", 0x901);
    await until(() => w.x.notifies.length === 1);
    const first = w.x.propOf(0x901, "BIG")![0];
    assert.deepEqual([first.type, u32s(first.data)], [w.x.atom("INCR"), [3500]]);
    assert.ok((w.x.masks.get(0x901) ?? 0) & 0x400000, "the owner asks for the requestor's PropertyNotify");
    const parts: Buffer[] = [];
    for (let i = 0; i < 5; i++) {
      w.x.props.delete(`${0x901}:${w.x.atom("BIG")}`);
      w.x.deleted(0x901, "BIG");
      await until(() => !!w.x.propOf(0x901, "BIG"));
      parts.push(w.x.propOf(0x901, "BIG")![0].data);
    }
    assert.deepEqual(parts.map((p) => p.length), [1000, 1000, 1000, 500, 0]);
    assert.equal(Buffer.concat(parts).toString(), text);
    assert.equal(w.x.masks.get(0x901), 0, "the requestor's PropertyNotify off at the end");
    // A stall: no deletion in incrWaitMs.
    w.x.request0("UTF8_STRING", "SLOW", 0x902);
    await until(() => w.x.notifies.length === 2);
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(w.clip.counts.incrStalls, 1);
    assert.ok(w.logs.some((l) => /stopped an incremental transfer/.test(l)));
  } finally { await w.end(); }
});

test("the ends at a failure: an X server that does not answer (the hold ends false after waitMs and the connection ends), a server that closes the connection (false; the next hold opens a new one), a refused cookie (false; no cookie in a log line), no display (false); every end clears the text", async () => {
  const w = await world();
  try {
    w.x.stall = true;
    const t0 = Date.now();
    // Bounded here (review-126: mutation row 56 needs a named red test, not a file that never ends).
    const held = await Promise.race([w.clip.hold("abc"), new Promise((r) => setTimeout(() => r("no answer in 2 s"), 2000))]);
    assert.equal(held, false, "a request that waits for the X server has its limit");
    assert.ok(Date.now() - t0 < 1000, "the hold ends at its limit");
    assert.equal(w.clip.holding, false);
    w.x.stall = false;
    assert.equal(await w.clip.hold("abc"), true, "a new connection");
    w.x.conns.at(-1)!.sock.destroy();
    await until(() => (w.clip.counts.connectionEnds ?? 0) >= 1);
    assert.equal(w.clip.holding, false, "a lost connection clears the text");
    assert.equal(await w.clip.hold("def"), true, "the next hold opens a new connection");
  } finally { await w.end(); }
  const bad = await world({ cookie: Buffer.from("fedcba9876543210") });
  try {
    assert.equal(await bad.clip.hold("abc"), false);
    assert.ok(bad.logs.some((l) => /refused the connection/.test(l)));
    assert.ok(!bad.logs.some((l) => l.includes("fedcba9876543210") || l.includes(COOKIE.toString())), "no cookie in a log line");
  } finally { await bad.end(); }
  const none = new XClipboard({ display: () => null, log: () => {} });
  assert.equal(await none.hold("abc"), false);
});

test("a clear while a hold runs (the stage's limit, an end of the paste's plan) wins: the hold answers false and the selection has no owner of this client", async () => {
  const w = await world();
  try {
    await w.clip.hold("warm the connection");
    w.clip.clear();
    const p = w.clip.hold("late");
    w.clip.clear();
    assert.equal(await p, false);
    await new Promise((r) => setTimeout(r, 30));
    assert.notEqual(w.x.owners.get(w.x.atom("CLIPBOARD")), w.clip.window);
    assert.equal(w.clip.holding, false);
  } finally { await w.end(); }
});

test("review-126 note 12: one hold at a time: a second hold during the first one's wait for the server time makes the first take nothing, and starts after it; the connection stays and the second text is held", async () => {
  const w = await world();
  try {
    const a = w.clip.hold("one"), b = w.clip.hold("two");
    assert.deepEqual([await a, await b], [false, true]);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(w.clip.holding, true, "the second text is still held after the first hold's limit (waitMs 150)");
    assert.deepEqual([w.clip.counts.connectionEnds, w.clip.counts.holdFails], [undefined, undefined]);
    const r = await readClipboard({ display: w.display, xauth: w.xauth, socketDir: w.dir, waitMs: 500 });
    assert.equal(r.text, "two");
  } finally { await w.end(); }
});

test("readClipboard (the live rows' check that the clipboard is empty after a paste): no owner gives none; with the owner's text, the text", async () => {
  const w = await world();
  try {
    assert.deepEqual(await readClipboard({ display: w.display, xauth: w.xauth, socketDir: w.dir }), { owner: 0, text: null });
    await w.clip.hold("read me");
    const r = await readClipboard({ display: w.display, xauth: w.xauth, socketDir: w.dir, waitMs: 500 });
    assert.deepEqual([r.owner, r.text], [w.clip.window, "read me"]);
    w.clip.clear();
    await until(() => !w.x.owners.has(w.x.atom("CLIPBOARD")));
    assert.deepEqual(await readClipboard({ display: w.display, xauth: w.xauth, socketDir: w.dir }), { owner: 0, text: null });
  } finally { await w.end(); }
});

test("the relay's door of the live rows: only with the stage's test value and AGENT_BROWSER_STAGE_CLIPBOARD naming a display and its X authority file; display 0 (a desktop) and 90 (the operator's agent browser) are refused", () => {
  const logs: string[] = [];
  const env = (v: string | undefined, t = "test") => ({ [STAGE_TEST_ENV]: t, ...(v === undefined ? {} : { [STAGE_CLIPBOARD_ENV]: v }) });
  assert.equal(relayTestClipboard(env(undefined), (l) => logs.push(l)), null);
  assert.equal(relayTestClipboard(env("169:/tmp/x", "1"), (l) => logs.push(l)), null, "not the test value");
  // The display as a number (review-126 note 4): "00" and "090" are :0 and :90.
  for (const v of ["0:/tmp/x", "90:/tmp/x", "00:/tmp/x", "090:/tmp/x", "0090:/tmp/x", "169", "x:/tmp/x", "169:relative"]) assert.equal(relayTestClipboard(env(v), (l) => logs.push(l)), null, v);
  assert.ok(relayTestClipboard(env("169:/tmp/run/xauth"), (l) => logs.push(l)) instanceof XClipboard);
});
