// A fake agentwatch daemon for the service's tests: a client of the control door (contract C12, docs/contracts/C12.md).
// It connects to control.sock, keeps every line that the service sends (parsed, and the raw bytes), and sends lines.

import { connect, type Socket } from "node:net";

export type DaemonClient = {
  /** Each line that the service sent, parsed. */
  readonly lines: any[];
  /** The bytes that the service sent, as they came. */
  readonly bytes: () => Buffer;
  readonly socket: Socket;
  /** Resolves when the service closed the connection (or it ended). */
  readonly closed: Promise<void>;
  isClosed(): boolean;
  /** Send an object as one compact line, a string as it is, or bytes. */
  send(x: object | string | Buffer): void;
  /** The first line that `want` takes, from the lines so far or the next ones. */
  next(want?: (l: any) => boolean, ms?: number): Promise<any>;
  /** The answer to the request `id`. */
  answer(id: string, ms?: number): Promise<any>;
  end(): void;
};

export const DAEMON_HELLO = { t: "hello", v: 1, side: "daemon", version: "0.9.0", features: [] };

export function daemonClient(path: string): Promise<DaemonClient> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    const lines: any[] = [];
    const chunks: Buffer[] = [];
    let rest = Buffer.alloc(0);
    let closed = false;
    const waiters: { want: (l: any) => boolean; done: (l: any) => void }[] = [];
    let onClose!: () => void;
    const closedP = new Promise<void>((r) => { onClose = r; });
    socket.on("data", (d: Buffer) => {
      chunks.push(d);
      rest = Buffer.concat([rest, d]);
      let i: number;
      while ((i = rest.indexOf(10)) >= 0) {
        const l = JSON.parse(rest.subarray(0, i).toString("utf8"));
        rest = rest.subarray(i + 1);
        lines.push(l);
        for (const w of [...waiters]) if (w.want(l)) { waiters.splice(waiters.indexOf(w), 1); w.done(l); }
      }
    });
    socket.on("close", () => { closed = true; onClose(); });
    socket.on("error", () => {});
    socket.once("connect", () => {
      const next = (want: (l: any) => boolean = () => true, ms = 5000) => {
        const hit = lines.find(want);
        if (hit) return Promise.resolve(hit);
        return new Promise<any>((done, fail) => {
          const w = { want, done: (l: any) => { clearTimeout(timer); done(l); } };
          waiters.push(w);
          const timer = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); fail(new Error(`no such line in ${ms} ms; lines: ${JSON.stringify(lines).slice(0, 2000)}`)); }, ms);
        });
      };
      resolve({
        lines, socket, closed: closedP, isClosed: () => closed,
        bytes: () => Buffer.concat(chunks),
        send: (x) => { socket.write(Buffer.isBuffer(x) ? x : typeof x === "string" ? x : JSON.stringify(x) + "\n"); },
        next,
        answer: (id, ms) => next((l) => l.t === "res" && l.id === id, ms),
        end: () => socket.end(),
      });
    });
    socket.once("error", reject);
  });
}

/** True when the connection closes within `ms`. */
export async function closesWithin(c: DaemonClient, ms = 2000): Promise<boolean> {
  return Promise.race([c.closed.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
