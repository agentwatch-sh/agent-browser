// The X selection owner of the unit's own Xvfb (board ab-t30.19; the operator's answer on board item ab-8fu, 2026-11-12:
// "can we do a simulated copy/paste for long text input? and we use a person typing for short input only?"; C11, the
// input stage, the paste). The input stage pastes a long text as a person does: it puts the text on the CLIPBOARD
// selection of the service's own display, presses Control+V with a person's timing, and Chrome reads the selection from
// this owner. The owner holds the selection only for one paste and gives it up, with the text cleared, at once after it.
//
// No dependency (taylor has no xclip or xsel, and package.json gets none): a small client of the X11 core protocol over
// the display's Unix socket, with the MIT-MAGIC-COOKIE-1 of the display's X authority file. It speaks only what an owner
// of a selection needs: the connection setup, InternAtom, CreateWindow (one InputOnly window of its own),
// SetSelectionOwner, GetSelectionOwner, ChangeProperty, ChangeWindowAttributes (a requestor's PropertyChangeMask for an
// incremental transfer) and SendEvent (SelectionNotify); and the events SelectionRequest, SelectionClear and
// PropertyNotify (ICCCM, sections 2.2 to 2.7).
//
// The rules (C11, the paste):
// - Only the display that `display()` names: the service gives its unit's own Xvfb (xDisplay(): its display and its X
//   authority file). The owner reaches no other display: without the cookie of a display's own authority file its X
//   server refuses the connection.
// - hold(text) takes CLIPBOARD with a real server time (a zero-length property change on its own window gives it). It
//   answers TARGETS, TIMESTAMP, UTF8_STRING and text/plain;charset=utf-8 (the forms that Chrome asks for; it asks for
//   UTF8_STRING first), refuses every other target (MULTIPLE too), and answers the text forms only while it holds a text.
//   A text above one request's size goes as an incremental transfer (INCR, ICCCM 2.7.2), one chunk at each deletion of the
//   property by the requestor.
// - clear() gives the selection up (SetSelectionOwner None) and overwrites the text's bytes with zeros at once. Another
//   client that takes the selection (SelectionClear: a page's copy in Chrome) clears the text too.
// - How it ends at a failure: each request that waits for a reply (the setup, InternAtom, GetSelectionOwner, the server
//   time) has a limit (`waitMs`); at the limit, at an error of the connection, or when the server closes it, the
//   connection ends, the text is cleared, every incremental transfer stops, and hold() answers false (the stage then
//   sends the text as Input.insertText). The next hold() opens a new connection to the display that `display()` names
//   then. An incremental transfer whose requestor does not delete the property within `incrWaitMs` stops (the requestor's
//   own wait then ends its read). The owner never waits for a requestor. When the connection ends in any way, the X
//   server gives up the selection (the selection of a closed connection has no owner).
// - No log line holds the text, a point or the cookie.

import { connect, type Socket } from "node:net";
import { readFileSync } from "node:fs";
import { STAGE_TEST_ENV, type StageClipboard } from "../../relay/stage.ts";

/** The X11 core protocol's request opcodes, events and atoms that the owner uses. */
export const OP = { CreateWindow: 1, ChangeWindowAttributes: 2, InternAtom: 16, ChangeProperty: 18, SetSelectionOwner: 22, GetSelectionOwner: 23, ConvertSelection: 24, SendEvent: 25 } as const;
export const EV = { PropertyNotify: 28, SelectionClear: 29, SelectionRequest: 30, SelectionNotify: 31 } as const;
export const ATOM = { ATOM: 4, INTEGER: 19, STRING: 31 } as const;
const PROPERTY_CHANGE_MASK = 0x400000, CW_EVENT_MASK = 0x800, INPUT_ONLY = 2;
const MODE_REPLACE = 0, MODE_APPEND = 2;
/** The names of the atoms that the owner interns. */
export const NAMES = ["CLIPBOARD", "TARGETS", "TIMESTAMP", "UTF8_STRING", "text/plain;charset=utf-8", "INCR", "MULTIPLE", "AGENT_BROWSER_TIME", "AGENT_BROWSER_READ"] as const;
/** The waits of the owner (ms): a reply of the X server; a requestor's deletion of the property in an incremental transfer. */
export const CLIPBOARD_WAIT_MS = 500;
export const INCR_WAIT_MS = 2000;
/** At most this many bytes of the text in one ChangeProperty (and less than one request's size): a longer text goes as INCR. */
export const CHUNK_BYTES = 65536;

const pad4 = (n: number) => (4 - (n % 4)) % 4;

/**
 * The MIT-MAGIC-COOKIE-1 of display `display` in an X authority file (FamilyWild 0xffff or FamilyLocal 256, with the
 * display's number), or null. The file's fields: a family (2 bytes), then the address, the number, the name and the data,
 * each as a length (2 bytes, big-endian) and its bytes.
 */
export function cookieOf(file: Buffer, display: number): Buffer | null {
  let i = 0;
  const field = (): Buffer | null => { if (i + 2 > file.length) return null; const n = file.readUInt16BE(i); i += 2; if (i + n > file.length) return null; const b = file.subarray(i, i + n); i += n; return b; };
  while (i + 2 <= file.length) {
    const family = file.readUInt16BE(i); i += 2;
    const addr = field(), num = field(), name = field(), data = field();
    if (!addr || !num || !name || !data) return null;
    if ((family === 0xffff || family === 256) && num.toString() === String(display) && name.toString() === "MIT-MAGIC-COOKIE-1") return Buffer.from(data);
  }
  return null;
}

/** The connection setup request (little-endian, protocol 11.0) with an authorization. */
export function setupRequest(name: string, data: Buffer): Buffer {
  const n = Buffer.from(name, "latin1");
  const b = Buffer.alloc(12 + n.length + pad4(n.length) + data.length + pad4(data.length));
  b.write("l", 0, "latin1");
  b.writeUInt16LE(11, 2); b.writeUInt16LE(0, 4); b.writeUInt16LE(n.length, 6); b.writeUInt16LE(data.length, 8);
  n.copy(b, 12); data.copy(b, 12 + n.length + pad4(n.length));
  return b;
}

export type Setup = { idBase: number; idMask: number; maxRequestBytes: number; root: number };
/** The server's answer to the setup: its length when it is complete (8 + 4 * its length field), else 0. */
export function setupLength(b: Buffer): number { return b.length < 8 ? 0 : b.length >= 8 + 4 * b.readUInt16LE(6) ? 8 + 4 * b.readUInt16LE(6) : 0; }
/** The setup's answer: the resource ids, the largest request (bytes) and the first screen's root window; an error text when it failed. */
export function parseSetup(b: Buffer): Setup | { error: string } {
  if (b[0] !== 1) return { error: b[0] === 0 ? `the X server refused the connection: ${b.subarray(8, 8 + b[1]).toString("latin1")}` : "the X server asks for another authorization" };
  const vendor = b.readUInt16LE(24), formats = b[29];
  const at = 40 + vendor + pad4(vendor) + 8 * formats;
  return { idBase: b.readUInt32LE(12), idMask: b.readUInt32LE(16), maxRequestBytes: 4 * b.readUInt16LE(26), root: b.readUInt32LE(at) };
}

/** A request of `units` 4-byte units: the opcode, the byte of its detail, its length. */
function req(op: number, detail: number, bytes: number): Buffer {
  const b = Buffer.alloc(bytes);
  b[0] = op; b[1] = detail; b.writeUInt16LE(bytes / 4, 2);
  return b;
}
export function internAtom(name: string): Buffer {
  const n = Buffer.from(name, "latin1"), b = req(OP.InternAtom, 0, 8 + n.length + pad4(n.length));
  b.writeUInt16LE(n.length, 4); n.copy(b, 8);
  return b;
}
export function createWindow(wid: number, parent: number): Buffer {
  const b = req(OP.CreateWindow, 0, 36);
  b.writeUInt32LE(wid, 4); b.writeUInt32LE(parent, 8); b.writeUInt16LE(1, 16); b.writeUInt16LE(1, 18);
  b.writeUInt16LE(INPUT_ONLY, 22); b.writeUInt32LE(CW_EVENT_MASK, 28); b.writeUInt32LE(PROPERTY_CHANGE_MASK, 32);
  return b;
}
export function changeWindowEvents(wid: number, mask: number): Buffer {
  const b = req(OP.ChangeWindowAttributes, 0, 16);
  b.writeUInt32LE(wid, 4); b.writeUInt32LE(CW_EVENT_MASK, 8); b.writeUInt32LE(mask, 12);
  return b;
}
/** ChangeProperty: `data` in units of `format` bits (8 or 32). */
export function changeProperty(mode: number, wid: number, prop: number, type: number, format: 8 | 32, data: Buffer): Buffer {
  const b = req(OP.ChangeProperty, mode, 24 + data.length + pad4(data.length));
  b.writeUInt32LE(wid, 4); b.writeUInt32LE(prop, 8); b.writeUInt32LE(type, 12); b[16] = format;
  b.writeUInt32LE(format === 32 ? data.length / 4 : data.length, 20); data.copy(b, 24);
  return b;
}
export function setSelectionOwner(owner: number, selection: number, time: number): Buffer {
  const b = req(OP.SetSelectionOwner, 0, 16);
  b.writeUInt32LE(owner, 4); b.writeUInt32LE(selection, 8); b.writeUInt32LE(time >>> 0, 12);
  return b;
}
export function getSelectionOwner(selection: number): Buffer { const b = req(OP.GetSelectionOwner, 0, 8); b.writeUInt32LE(selection, 4); return b; }
export function convertSelection(requestor: number, selection: number, target: number, prop: number, time: number): Buffer {
  const b = req(OP.ConvertSelection, 0, 24);
  b.writeUInt32LE(requestor, 4); b.writeUInt32LE(selection, 8); b.writeUInt32LE(target, 12); b.writeUInt32LE(prop, 16); b.writeUInt32LE(time >>> 0, 20);
  return b;
}
/** SendEvent of a SelectionNotify to the requestor (no event mask: the requestor's own client gets it). `prop` 0: a refusal. */
export function selectionNotify(time: number, requestor: number, selection: number, target: number, prop: number): Buffer {
  const b = req(OP.SendEvent, 0, 44);
  b.writeUInt32LE(requestor, 4); b.writeUInt32LE(0, 8);
  const e = 12;
  b[e] = EV.SelectionNotify; b.writeUInt32LE(time >>> 0, e + 4); b.writeUInt32LE(requestor, e + 8); b.writeUInt32LE(selection, e + 12); b.writeUInt32LE(target, e + 16); b.writeUInt32LE(prop, e + 20);
  return b;
}
const u32s = (xs: number[]) => { const b = Buffer.alloc(4 * xs.length); xs.forEach((x, i) => b.writeUInt32LE(x >>> 0, 4 * i)); return b; };

/** One event of the server, decoded (only the fields that the owner reads). */
export type XEvent =
  | { type: "request"; time: number; owner: number; requestor: number; selection: number; target: number; property: number }
  | { type: "clear"; time: number; owner: number; selection: number }
  | { type: "property"; window: number; atom: number; time: number; deleted: boolean }
  | { type: "notify"; time: number; requestor: number; selection: number; target: number; property: number }
  | { type: "other"; code: number };
export function decodeEvent(b: Buffer): XEvent {
  const code = b[0] & 0x7f;
  if (code === EV.SelectionRequest) return { type: "request", time: b.readUInt32LE(4), owner: b.readUInt32LE(8), requestor: b.readUInt32LE(12), selection: b.readUInt32LE(16), target: b.readUInt32LE(20), property: b.readUInt32LE(24) };
  if (code === EV.SelectionClear) return { type: "clear", time: b.readUInt32LE(4), owner: b.readUInt32LE(8), selection: b.readUInt32LE(12) };
  if (code === EV.PropertyNotify) return { type: "property", window: b.readUInt32LE(4), atom: b.readUInt32LE(8), time: b.readUInt32LE(12), deleted: b[16] === 1 };
  if (code === EV.SelectionNotify) return { type: "notify", time: b.readUInt32LE(4), requestor: b.readUInt32LE(8), selection: b.readUInt32LE(12), target: b.readUInt32LE(16), property: b.readUInt32LE(20) };
  return { type: "other", code };
}

/**
 * One connection to an X server: the setup, the requests with their sequence numbers, the replies of those that wait
 * for one (each with the limit `waitMs`), and the events. An error of a request that waits rejects it; an error of any
 * other request goes to `onError` (its code and the opcode, never a value). The connection ends at a socket error, at
 * the server's close, or at close().
 */
export class XConn {
  private buf = Buffer.alloc(0);
  private seq = 0;
  private readonly waiting = new Map<number, { ok: (b: Buffer) => void; fail: (e: Error) => void; timer: NodeJS.Timeout }>();
  setup: Setup | null = null;
  ended = false;
  onEvent: (ev: XEvent, raw: Buffer) => void = () => {};
  onError: (code: number, opcode: number) => void = () => {};
  onEnd: (why: string) => void = () => {};
  private nextId = 1;
  private readonly sock: Socket;
  private readonly waitMs: number;
  private constructor(sock: Socket, waitMs: number) { this.sock = sock; this.waitMs = waitMs; }

  /** Open the display's Unix socket (`<socketDir>/X<n>`), send the setup with the display's cookie, and wait for the answer (at most `waitMs`). */
  static open(o: { display: number; xauth: string; socketDir?: string; waitMs?: number }): Promise<XConn> {
    const waitMs = o.waitMs ?? CLIPBOARD_WAIT_MS;
    let cookie: Buffer | null;
    try { cookie = cookieOf(readFileSync(o.xauth), o.display); } catch (e) { return Promise.reject(new Error(`the X authority file cannot be read: ${(e as NodeJS.ErrnoException).code ?? "error"}`)); }
    if (!cookie) return Promise.reject(new Error(`the X authority file has no cookie for display :${o.display}`));
    const sock = connect(`${o.socketDir ?? "/tmp/.X11-unix"}/X${o.display}`);
    const c = new XConn(sock, waitMs);
    return new Promise<XConn>((resolve, reject) => {
      let done = false;
      const fail = (e: Error) => { if (done) return; done = true; clearTimeout(timer); sock.destroy(); reject(e); };
      const timer = setTimeout(() => fail(new Error(`no setup answer from display :${o.display} in ${waitMs} ms`)), waitMs);
      sock.once("error", (e) => fail(new Error(`the X connection failed: ${(e as NodeJS.ErrnoException).code ?? "error"}`)));
      sock.once("close", () => fail(new Error("the X server closed the connection")));
      sock.on("data", function first(d: Buffer) {
        c.buf = Buffer.concat([c.buf, d]);
        const n = setupLength(c.buf);
        if (!n) return;
        sock.off("data", first);
        const s = parseSetup(c.buf.subarray(0, n));
        c.buf = c.buf.subarray(n);
        cookie!.fill(0);
        if ("error" in s) return fail(new Error(s.error));
        done = true; clearTimeout(timer);
        c.setup = s;
        sock.removeAllListeners("error"); sock.removeAllListeners("close");
        sock.on("data", (x: Buffer) => c.data(x));
        sock.on("error", () => c.end("the X connection failed"));
        sock.on("close", () => c.end("the X server closed the connection"));
        resolve(c);
      });
      sock.write(setupRequest("MIT-MAGIC-COOKIE-1", cookie!));
    });
  }

  /** A new resource id of this connection. */
  id(): number { return (this.setup!.idBase | (this.nextId++ & this.setup!.idMask)) >>> 0; }
  /** A request that waits for no reply. */
  send(b: Buffer): number { if (this.ended) return 0; this.seq = (this.seq + 1) & 0xffff; this.sock.write(b); return this.seq; }
  /** A request that waits for its reply (at most `waitMs`): the reply's bytes. */
  call(b: Buffer): Promise<Buffer> {
    if (this.ended) return Promise.reject(new Error("the X connection ended"));
    const seq = this.send(b);
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => { this.waiting.delete(seq); fail(new Error(`no answer of the X server in ${this.waitMs} ms`)); this.end("the X server did not answer"); }, this.waitMs);
      this.waiting.set(seq, { ok, fail, timer });
    });
  }
  private data(d: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (this.buf.length >= 32) {
      const kind = this.buf[0];
      const len = kind === 1 ? 32 + 4 * this.buf.readUInt32LE(4) : 32;
      if (this.buf.length < len) return;
      const m = this.buf.subarray(0, len);
      this.buf = this.buf.subarray(len);
      if (kind === 0 || kind === 1) {
        const seq = m.readUInt16LE(2), w = this.waiting.get(seq);
        if (w) { this.waiting.delete(seq); clearTimeout(w.timer); if (kind === 1) w.ok(Buffer.from(m)); else w.fail(new Error(`X error ${m[1]} of request ${m[10]}`)); }
        else if (kind === 0) this.onError(m[1], m[10]);
        continue;
      }
      this.onEvent(decodeEvent(m), m);
    }
  }
  /** The end of the connection: every wait fails, and `onEnd` hears why. */
  end(why: string): void {
    if (this.ended) return;
    this.ended = true;
    this.sock.destroy();
    for (const w of this.waiting.values()) { clearTimeout(w.timer); w.fail(new Error(why)); }
    this.waiting.clear();
    this.onEnd(why);
  }
}

/** The display of the owner: its number and its X authority file (the unit's own Xvfb), or null (no display now). */
export type ClipboardDisplay = { display: number; xauth: string };
export type ClipboardOptions = {
  display: () => ClipboardDisplay | null;
  log: (line: string) => void;
  /** The folder of the X sockets (default /tmp/.X11-unix; a test's fake server). */
  socketDir?: string;
  waitMs?: number;
  incrWaitMs?: number;
  chunkBytes?: number;
  /** Each request of a requestor, for the probe and the tests: its target's name and whether the owner gave the text. */
  onRequest?: (target: string, gave: boolean) => void;
};

type Transfer = { requestor: number; property: number; type: number; data: Buffer; at: number; timer: NodeJS.Timeout };

/** The owner of the CLIPBOARD selection of the service's own display (see the file's head). */
export class XClipboard implements StageClipboard {
  private conn: XConn | null = null;
  private opening: Promise<XConn> | null = null;
  private display: ClipboardDisplay | null = null;
  private win = 0;
  private atoms: Record<(typeof NAMES)[number], number> | null = null;
  private text: Buffer | null = null;
  private since = 0;
  private readonly transfers = new Map<string, Transfer>();
  private timeWait: ((t: number) => void) | null = null;
  /** The hold that runs now: clear() makes any earlier one stale. */
  private token = 0;
  /** The counts: holds, refusals of a target, incremental transfers, ends of the connection (the live rows). */
  readonly counts: Record<string, number> = {};
  private readonly o: ClipboardOptions;
  constructor(o: ClipboardOptions) { this.o = o; }
  private count(k: string): void { this.counts[k] = (this.counts[k] ?? 0) + 1; }

  /** The display that the owner reaches now (the tests: the service gives its unit's own Xvfb). */
  target(): ClipboardDisplay | null { return this.o.display(); }
  /** Whether the owner holds a text now (the tests and the live rows). */
  get holding(): boolean { return this.text !== null; }

  async hold(text: string): Promise<boolean> {
    this.clear();
    // A clear() while this hold runs (the stage's limit, an end of the paste's plan) wins: the hold then takes nothing.
    const token = ++this.token;
    try {
      const c = await this.connection();
      const A = this.atoms!;
      const time = await this.serverTime(c);
      if (token !== this.token) return false;
      this.text = Buffer.from(text, "utf8");
      this.since = time;
      c.send(setSelectionOwner(this.win, A.CLIPBOARD, time));
      const r = await c.call(getSelectionOwner(A.CLIPBOARD));
      if (token !== this.token) return false;
      if (r.readUInt32LE(8) !== this.win) { this.count("holdRefused"); this.clear(); return false; }
      this.count("holds");
      return true;
    } catch (e) {
      this.count("holdFails");
      this.o.log(`service: the clipboard owner could not take the selection: ${(e as Error).message}`);
      this.clear();
      return false;
    }
  }

  clear(): void {
    this.token++;
    for (const t of this.transfers.values()) clearTimeout(t.timer);
    this.transfers.clear();
    const had = this.text !== null;
    if (this.text) { this.text.fill(0); this.text = null; }
    if (had && this.conn && !this.conn.ended && this.atoms) this.conn.send(setSelectionOwner(0, this.atoms.CLIPBOARD, 0));
    else if (had) this.count("clearedWithNoConnection");
  }

  /** The owner of CLIPBOARD on the display now (0: none): the live rows' check that the clipboard is empty after a paste. */
  async owner(): Promise<number> {
    const c = await this.connection();
    return (await c.call(getSelectionOwner(this.atoms!.CLIPBOARD))).readUInt32LE(8);
  }
  /** This owner's window (the live rows: an owner that is not 0 and not this window is another client's). */
  get window(): number { return this.win; }

  close(): void { this.clear(); this.conn?.end("closed"); this.conn = null; }

  /** The connection to the display that `display()` names now: the open one, or a new one (with its atoms and its window). */
  private async connection(): Promise<XConn> {
    const d = this.o.display();
    if (!d) throw new Error("no display");
    if (this.conn && !this.conn.ended && this.display && this.display.display === d.display && this.display.xauth === d.xauth) return this.conn;
    if (this.opening) return this.opening;
    this.conn?.end("another display");
    this.conn = null;
    this.opening = (async () => {
      const c = await XConn.open({ display: d.display, xauth: d.xauth, socketDir: this.o.socketDir, waitMs: this.o.waitMs });
      try {
        c.onEvent = (ev) => this.event(c, ev);
        c.onError = (code, op) => this.o.log(`service: the clipboard owner got X error ${code} of request ${op}`);
        c.onEnd = (why) => { if (this.conn === c) { this.conn = null; this.count("connectionEnds"); this.clear(); this.o.log(`service: the clipboard owner's X connection ended: ${why}`); } };
        const atoms = await Promise.all(NAMES.map((n) => c.call(internAtom(n)).then((r) => r.readUInt32LE(8))));
        this.atoms = Object.fromEntries(NAMES.map((n, i) => [n, atoms[i]])) as Record<(typeof NAMES)[number], number>;
        this.win = c.id();
        c.send(createWindow(this.win, c.setup!.root));
        this.conn = c; this.display = d;
        return c;
      } catch (e) { c.end("the setup failed"); throw e; }
    })();
    try { return await this.opening; } finally { this.opening = null; }
  }

  /** A real server time: a zero-length append to a property of the owner's own window, and the time of its PropertyNotify. */
  private serverTime(c: XConn): Promise<number> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.timeWait = null; reject(new Error(`no server time in ${this.o.waitMs ?? CLIPBOARD_WAIT_MS} ms`)); c.end("the X server did not answer"); }, this.o.waitMs ?? CLIPBOARD_WAIT_MS);
      this.timeWait = (t) => { clearTimeout(timer); this.timeWait = null; resolve(t); };
      c.send(changeProperty(MODE_APPEND, this.win, this.atoms!.AGENT_BROWSER_TIME, ATOM.STRING, 8, Buffer.alloc(0)));
    });
  }

  private name(atom: number): string { const A = this.atoms!; for (const n of NAMES) if (A[n] === atom) return n; return `atom ${atom}`; }

  private event(c: XConn, ev: XEvent): void {
    const A = this.atoms;
    if (!A) return;
    if (ev.type === "property") {
      if (ev.window === this.win && ev.atom === A.AGENT_BROWSER_TIME && !ev.deleted) { this.timeWait?.(ev.time); return; }
      if (ev.deleted) this.nextChunk(c, ev.window, ev.atom);
      return;
    }
    // A SelectionClear: another client took CLIPBOARD (a page's copy in Chrome), or the owner's own clear() (the server
    // tells the old owner of every change; then no text is held any more).
    if (ev.type === "clear") { if (ev.selection === A.CLIPBOARD && ev.owner === this.win && this.text) { this.count("takenByOther"); this.text.fill(0); this.text = null; } return; }
    if (ev.type !== "request") return;
    const prop = ev.property || ev.target;
    const refuse = () => { this.count("refusals"); c.send(selectionNotify(ev.time, ev.requestor, ev.selection, ev.target, 0)); };
    const target = this.name(ev.target);
    if (ev.selection !== A.CLIPBOARD || ev.owner !== this.win || !this.text) { this.o.onRequest?.(target, false); return refuse(); }
    const texts = [A.UTF8_STRING, A["text/plain;charset=utf-8"]];
    if (ev.target === A.TARGETS) {
      c.send(changeProperty(MODE_REPLACE, ev.requestor, prop, ATOM.ATOM, 32, u32s([A.TARGETS, A.TIMESTAMP, ...texts])));
    } else if (ev.target === A.TIMESTAMP) {
      c.send(changeProperty(MODE_REPLACE, ev.requestor, prop, ATOM.INTEGER, 32, u32s([this.since])));
    } else if (texts.includes(ev.target)) {
      const chunk = Math.min(this.o.chunkBytes ?? CHUNK_BYTES, (c.setup?.maxRequestBytes ?? 262140) - 64);
      if (this.text.length <= chunk) c.send(changeProperty(MODE_REPLACE, ev.requestor, prop, ev.target, 8, this.text));
      else {
        // ICCCM 2.7.2: the type INCR with the size, then one chunk at each deletion of the property, then a chunk of 0.
        c.send(changeWindowEvents(ev.requestor, PROPERTY_CHANGE_MASK));
        const key = `${ev.requestor}:${prop}`, old = this.transfers.get(key);
        if (old) clearTimeout(old.timer);
        this.transfers.set(key, { requestor: ev.requestor, property: prop, type: ev.target, data: this.text, at: 0, timer: this.stall(key) });
        c.send(changeProperty(MODE_REPLACE, ev.requestor, prop, A.INCR, 32, u32s([this.text.length])));
        this.count("incrTransfers");
      }
    } else { this.o.onRequest?.(target, false); return refuse(); }
    this.o.onRequest?.(target, texts.includes(ev.target));
    c.send(selectionNotify(ev.time, ev.requestor, ev.selection, ev.target, prop));
  }

  /** An incremental transfer stops when its requestor does not delete the property within `incrWaitMs`. */
  private stall(key: string): NodeJS.Timeout {
    return setTimeout(() => { if (this.transfers.delete(key)) { this.count("incrStalls"); this.o.log("service: the clipboard owner stopped an incremental transfer: the requestor did not read it in time"); } }, this.o.incrWaitMs ?? INCR_WAIT_MS);
  }
  /** The requestor deleted the property of a transfer: the next chunk, or the chunk of 0 bytes at the end. */
  private nextChunk(c: XConn, window: number, atom: number): void {
    const key = `${window}:${atom}`, t = this.transfers.get(key);
    if (!t) return;
    clearTimeout(t.timer);
    // The text was cleared (the paste ended): the transfer stops with no more data.
    if (!this.text || this.text !== t.data) { this.transfers.delete(key); return; }
    const chunk = Math.min(this.o.chunkBytes ?? CHUNK_BYTES, (c.setup?.maxRequestBytes ?? 262140) - 64);
    const part = t.data.subarray(t.at, t.at + chunk);
    c.send(changeProperty(MODE_APPEND, t.requestor, t.property, t.type, 8, part));
    t.at += part.length;
    if (!part.length) { this.transfers.delete(key); c.send(changeWindowEvents(t.requestor, 0)); return; }
    t.timer = this.stall(key);
  }
}

/**
 * Read the CLIPBOARD selection of a display as a requestor (the probe and the live rows only: "the clipboard is empty
 * after a paste"): the owner (0: none) and, with an owner, its UTF8_STRING (up to one property; null when it refused).
 */
export async function readClipboard(o: { display: number; xauth: string; socketDir?: string; waitMs?: number }): Promise<{ owner: number; text: string | null }> {
  const c = await XConn.open(o);
  try {
    const at = async (n: string) => (await c.call(internAtom(n))).readUInt32LE(8);
    const [clip, utf8, prop] = [await at("CLIPBOARD"), await at("UTF8_STRING"), await at("AGENT_BROWSER_READ")];
    const owner = (await c.call(getSelectionOwner(clip))).readUInt32LE(8);
    if (!owner) return { owner, text: null };
    const win = c.id();
    c.send(createWindow(win, c.setup!.root));
    const notified = new Promise<XEvent>((resolve) => { c.onEvent = (ev) => { if (ev.type === "notify") resolve(ev); }; });
    c.send(convertSelection(win, clip, utf8, prop, 0));
    const ev = await Promise.race([notified, new Promise<null>((r) => setTimeout(() => r(null), o.waitMs ?? CLIPBOARD_WAIT_MS))]);
    if (!ev || ev.type !== "notify" || !ev.property) return { owner, text: null };
    // GetProperty (20): delete false, the property, any type, from 0, up to 1 MB.
    const b = req(20, 0, 24);
    b.writeUInt32LE(win, 4); b.writeUInt32LE(prop, 8); b.writeUInt32LE(0, 12); b.writeUInt32LE(0, 16); b.writeUInt32LE(262144, 20);
    const r = await c.call(b);
    const n = r.readUInt32LE(16);
    return { owner, text: r.subarray(32, 32 + n).toString("utf8") };
  } finally { c.end("done"); }
}

/** The live rows' door to the paste (board ab-t30.19): `<display>:<the X authority file of that display>`. */
export const STAGE_CLIPBOARD_ENV = "AGENT_BROWSER_STAGE_CLIPBOARD";
/**
 * The relay's clipboard for the live rows only: with the stage's test value (AGENT_BROWSER_INPUT_STAGE=test) and
 * AGENT_BROWSER_STAGE_CLIPBOARD naming the run's own Xvfb and its X authority file, an owner on that display; else none
 * (the relay's display is the daemon's: the relay pastes nothing, and a long text goes as Playwright's own input). Display
 * 0 (a desktop) and 90 (the operator's agent browser on taylor) are refused.
 */
export function relayTestClipboard(env: NodeJS.ProcessEnv, log: (line: string) => void): XClipboard | null {
  const v = env[STAGE_CLIPBOARD_ENV];
  if (env[STAGE_TEST_ENV] !== "test" || !v) return null;
  const m = /^([0-9]{1,5}):(\/.+)$/.exec(v);
  if (!m || m[1] === "0" || m[1] === "90") { log(`relay: ${STAGE_CLIPBOARD_ENV} is ignored: it must name the run's own display and its X authority file`); return null; }
  const display = Number(m[1]), xauth = m[2];
  log(`relay: the input stage's paste uses display :${display} (the live rows' door)`);
  return new XClipboard({ display: () => ({ display, xauth }), log });
}
