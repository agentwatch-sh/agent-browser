// The pure helpers of the MCP port's live check (board ab-v16.94.13; test/live/mcp-live/measure.ts), with made-up lines.

import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptedAt, boundedGrowth, holdsTicket, refOf, rssKib, tcpListeners, unixSockets } from "./live/mcp-live/measure.ts";

test("unixSockets and acceptedAt: the listener and the connected server ends at a path; another path and a client end are not counted", () => {
  const text = [
    "Num       RefCount Protocol Flags    Type St Inode Path",
    "0000000000000000: 00000002 00000000 00010000 0001 01 1001 /tmp/run/cdp.sock",
    "0000000000000000: 00000003 00000000 00000000 0001 03 1002 /tmp/run/cdp.sock",
    "0000000000000000: 00000003 00000000 00000000 0001 03 1003 /tmp/run/cdp.sock",
    "0000000000000000: 00000003 00000000 00000000 0001 03 1004",
    "0000000000000000: 00000003 00000000 00000000 0001 03 1005 /tmp/run/control.sock",
    "0000000000000000: 00000002 00000000 00010000 0001 01 1006 @/tmp/.X11-unix/X171",
    "",
  ].join("\n");
  const socks = unixSockets(text);
  assert.equal(socks.length, 6);
  assert.deepEqual(socks[0], { inode: 1001, state: 1, listens: true, path: "/tmp/run/cdp.sock" });
  assert.deepEqual(socks[3], { inode: 1004, state: 3, listens: false, path: "" });
  assert.deepEqual(acceptedAt(socks, "/tmp/run/cdp.sock"), [1002, 1003]);
  assert.deepEqual(acceptedAt(socks, "/tmp/run/none.sock"), []);
});

test("tcpListeners: only state 0A, with the port, the uid and the inode", () => {
  const text = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 0100007F:A1B2 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 5551 1 0000000000000000 100 0 0 10 0",
    "   1: 0100007F:A1B2 0100007F:C3D4 01 00000000:00000000 00:00000000 00000000  1001        0 5552 1 0000000000000000 20 4 30 10 -1",
    "   2: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 5553 1 0000000000000000 100 0 0 10 0",
  ].join("\n");
  assert.deepEqual(tcpListeners(text), [
    { address: "0100007F", port: 0xa1b2, uid: 1001, inode: 5551 },
    { address: "00000000", port: 22, uid: 0, inode: 5553 },
  ]);
});

test("rssKib reads VmRSS in KiB, or null", () => {
  assert.equal(rssKib("Name:\tnode\nVmHWM:\t  200000 kB\nVmRSS:\t  123456 kB\nThreads:\t12\n"), 123456);
  assert.equal(rssKib("Name:\tnode\n"), null);
});

test("refOf finds the reference of an element by its role and its name, also with attributes after it", () => {
  const snap = [
    "- generic [ref=e1]:",
    "  - heading \"The live check's form\" [level=1] [ref=e2]",
    "  - button \"Press me\" [ref=e3] [cursor=pointer]",
    "  - generic [ref=e4]:",
    "    - text: Your text",
    "    - textbox \"Your text\" [ref=e5]",
    "  - button \"Press me too\" [ref=e6]",
  ].join("\n");
  assert.equal(refOf(snap, "button", "Press me"), "e3");
  assert.equal(refOf(snap, "textbox", "Your text"), "e5");
  assert.equal(refOf(snap, "button", "Your text"), null);
  assert.equal(refOf(snap, "link", "Press me"), null);
});

test("boundedGrowth: a growth that slows or stays small passes; a steady large growth fails", () => {
  const mb = (m: number) => m * 1024;
  // Flat after a first rise.
  assert.equal(boundedGrowth([mb(100), mb(200), mb(205)]).ok, true);
  // A steady growth of 10 MiB a round over 20 rounds: 100 MiB in each half.
  const steady = Array.from({ length: 21 }, (_, i) => mb(100 + 10 * i));
  assert.deepEqual(boundedGrowth(steady), { ok: false, first: 100, second: 100 });
  // A small second half passes even after no first growth.
  assert.equal(boundedGrowth([mb(300), mb(300), mb(340)]).ok, true);
  // Too few samples fail.
  assert.equal(boundedGrowth([mb(1), mb(2)]).ok, false);
});

test("holdsTicket finds the query key in any case, and nothing else", () => {
  assert.equal(holdsTicket("ws+unix:///run/cdp.sock:/devtools/browser/live-1?ticket=abc"), true);
  assert.equal(holdsTicket("TICKET=abc"), true);
  assert.equal(holdsTicket("a ticket of the scope"), false);
});
