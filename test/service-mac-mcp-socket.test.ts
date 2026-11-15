// The MCP port's socket from launchd on the Mac (board ab-v16.94.30; C11, "The MCP path"; C12, the Mac's command), on
// fakes: this box runs no macOS call. A fake libSystem stands for launch_activate_socket(3), node:ffi's getInt32, free(3),
// ioctl(2) and fcntl(2), and records each call in order. Linux keeps systemd's socket (listen-fds.ts), unchanged.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EALREADY, ENOENT, ESRCH, F_GETFD, FD_CLOEXEC, FIOCLEX, launchdMcpListen, loadLaunchLib, MCP_SOCKET_KEY, takeLaunchdSocket, type LaunchLib,
} from "../src/service/mcp/launchd-socket.ts";
import { MCP_SOCKET_UNIT } from "../src/service/mcp/listen-fds.ts";

const ROOT = join(import.meta.dirname, "..");
const PTR = 0x7f00_1234_5670n;

/**
 * A fake libSystem. `err`: launch_activate_socket's answer (0: it writes `fds` and their count). `ptr` null: the array's
 * pointer is NULL. `mark`: what ioctl(FIOCLEX) does to an fd ("ok", "fails": -1, "no flag": 0 but no FD_CLOEXEC);
 * `getfd`: -1 makes F_GETFD fail. Each call goes into `calls`, in order.
 */
function fakeLib(o: { err?: number; fds?: number[]; count?: number; ptr?: null; mark?: Record<number, "fails" | "no flag">; getfd?: number[]; throwAt?: number; tick?: boolean }) {
  const calls: unknown[][] = [];
  const flags = new Map<number, number>();
  const fds = o.fds ?? [];
  const lib: LaunchLib = {
    launch_activate_socket(name, out, cnt) {
      calls.push(["activate", name.toString("latin1"), out.length, cnt.length]);
      // `tick`: a microtask queued at the call. It runs at the code's first await (or after its synchronous end), so its
      // place in `calls` shows whether the marks and the free come before any await.
      if (o.tick) queueMicrotask(() => calls.push(["tick"]));
      if (o.err) return o.err;
      out.writeBigUInt64LE(o.ptr === null ? 0n : PTR);
      cnt.writeBigUInt64LE(BigInt(o.count ?? fds.length));
      return 0;
    },
    getInt32(ptr, offset) {
      calls.push(["get", ptr, offset]);
      assert.equal(ptr, PTR);
      if (o.throwAt === offset) throw new Error("a read that fails");
      return fds[offset / 4];
    },
    free(ptr) { calls.push(["free", ptr]); },
    ioctl(fd, request) {
      calls.push(["ioctl", fd, request]);
      const m = o.mark?.[fd];
      if (m === "fails") return -1;
      if (m !== "no flag" && request === FIOCLEX) flags.set(fd, FD_CLOEXEC);
      return 0;
    },
    fcntl(fd, cmd) {
      calls.push(["fcntl", fd, cmd]);
      return o.getfd?.includes(fd) ? -1 : flags.get(fd) ?? 0;
    },
  };
  return { lib, calls, load: async () => lib };
}

test("board ab-v16.94.30: the key is agent-browser-mcp, the base name of Linux's socket unit; the Mac's errno values and FIOCLEX are the SDK's", () => {
  assert.equal(MCP_SOCKET_KEY, "agent-browser-mcp");
  assert.equal(`${MCP_SOCKET_KEY}.socket`, MCP_SOCKET_UNIT);
  // sys/errno.h of macOS (EALREADY is 114 on Linux, 37 on the Mac); sys/filio.h: FIOCLEX is _IO('f', 1).
  assert.deepEqual([ENOENT, ESRCH, EALREADY], [2, 3, 37]);
  assert.equal(FIOCLEX, (0x20000000 | ("f".charCodeAt(0) << 8) | 1) >>> 0);
  assert.equal(FIOCLEX, 0x20006601);
  assert.deepEqual([F_GETFD, FD_CLOEXEC], [1, 1]);
});

test("board ab-v16.94.30: one fd: the service takes it, marks it close-on-exec at once (FIOCLEX, then F_GETFD reads the mark back), and frees launchd's array", async () => {
  const f = fakeLib({ fds: [7], tick: true });
  assert.deepEqual(await takeLaunchdSocket(f.load), { fd: 7 });
  // The tick comes last: from the call to the free nothing awaits (C11: "at once").
  assert.deepEqual(f.calls, [
    ["activate", "agent-browser-mcp\0", 8, 8],
    ["get", PTR, 0],
    ["ioctl", 7, FIOCLEX],
    ["fcntl", 7, F_GETFD],
    ["free", PTR],
    ["tick"],
  ]);
});

test("board ab-v16.94.30: no fd gives no MCP port (failed); the array is freed when launchd gave one, and nothing is marked", async () => {
  let f = fakeLib({ fds: [], count: 0 });
  let got = await takeLaunchdSocket(f.load);
  assert.ok("failed" in got && /launchd gave 0 fds for agent-browser-mcp, not exactly one/.test(got.failed), JSON.stringify(got));
  assert.deepEqual(f.calls.map((c) => c[0]), ["activate", "free"]);
  // A NULL array: nothing to free.
  f = fakeLib({ ptr: null, count: 0 });
  got = await takeLaunchdSocket(f.load);
  assert.ok("failed" in got && /gave 0 fds/.test(got.failed), JSON.stringify(got));
  assert.deepEqual(f.calls.map((c) => c[0]), ["activate"]);
  // A count of one with a NULL array: no fd either.
  f = fakeLib({ ptr: null, count: 1 });
  got = await takeLaunchdSocket(f.load);
  assert.ok("failed" in got && /not exactly one/.test(got.failed), JSON.stringify(got));
  assert.deepEqual(f.calls.map((c) => c[0]), ["activate"]);
});

test("board ab-v16.94.30: two fds give no MCP port (failed), and both are marked close-on-exec before the count decides; the array is freed once", async () => {
  const f = fakeLib({ fds: [7, 8], tick: true });
  const got = await takeLaunchdSocket(f.load);
  assert.ok("failed" in got && /launchd gave 2 fds for agent-browser-mcp, not exactly one/.test(got.failed), JSON.stringify(got));
  assert.deepEqual(f.calls, [
    ["activate", "agent-browser-mcp\0", 8, 8],
    ["get", PTR, 0], ["ioctl", 7, FIOCLEX], ["fcntl", 7, F_GETFD],
    ["get", PTR, 4], ["ioctl", 8, FIOCLEX], ["fcntl", 8, F_GETFD],
    ["free", PTR],
    ["tick"],
  ]);
});

test("board ab-v16.94.30: each errno of launch_activate_socket: ENOENT and ESRCH give no socket (none), EALREADY and any other give failed; no read, no mark, no free", async () => {
  const cases: [number, "none" | "failed", RegExp][] = [
    [ENOENT, "none", /the service's launchd job has no Sockets entry agent-browser-mcp \(ENOENT\)/],
    [ESRCH, "none", /the service is not a launchd job \(ESRCH\)/],
    [EALREADY, "failed", /launch_activate_socket: the socket agent-browser-mcp was taken already \(EALREADY\)/],
    [22, "failed", /launch_activate_socket gave the error 22/],
  ];
  for (const [err, kind, text] of cases) {
    const f = fakeLib({ err });
    const got = await takeLaunchdSocket(f.load) as Record<string, string>;
    assert.deepEqual(Object.keys(got), [kind], `errno ${err}`);
    assert.match(got[kind], text);
    assert.deepEqual(f.calls.map((c) => c[0]), ["activate"], `errno ${err}`);
  }
});

test("board ab-v16.94.30: an fd that cannot be marked close-on-exec gives failed (fail closed); each other fd is still marked, and the array is freed", async () => {
  for (const [o, why] of [[{ mark: { 7: "fails" as const } }, "ioctl fails"], [{ mark: { 7: "no flag" as const } }, "F_GETFD shows no FD_CLOEXEC"], [{ getfd: [7] }, "F_GETFD fails"]] as const) {
    const f = fakeLib({ fds: [7, 8], ...o });
    const got = await takeLaunchdSocket(f.load);
    assert.ok("failed" in got && /fd 7 cannot be marked close-on-exec/.test(got.failed), `${why}: ${JSON.stringify(got)}`);
    assert.ok(f.calls.some((c) => c[0] === "ioctl" && c[1] === 8), `${why}: fd 8 is marked too`);
    assert.deepEqual(f.calls.at(-1), ["free", PTR], why);
  }
  // A negative fd is never marked: failed.
  const f = fakeLib({ fds: [-1] });
  const got = await takeLaunchdSocket(f.load);
  assert.ok("failed" in got && /fd -1 cannot be marked close-on-exec/.test(got.failed), JSON.stringify(got));
  assert.deepEqual(f.calls.map((c) => c[0]), ["activate", "get", "free"]);
});

test("board ab-v16.94.30: a read that throws still frees the array, and launchdMcpListen gives failed; a libSystem that does not load gives failed", async () => {
  const f = fakeLib({ fds: [7, 8], throwAt: 4 });
  await assert.rejects(takeLaunchdSocket(f.load), /a read that fails/);
  assert.deepEqual(f.calls.at(-1), ["free", PTR]);
  const lines: string[] = [];
  const got = await launchdMcpListen({ test: false, log: (l) => lines.push(l), load: fakeLib({ fds: [7, 8], throwAt: 4 }).load });
  assert.ok(got !== null && "failed" in got && /a read that fails/.test(got.failed), JSON.stringify(got));
  const none = await takeLaunchdSocket(async () => ({ failed: "dlopen of libSystem failed: no such file" }));
  assert.deepEqual(none, { failed: "the MCP port's socket: dlopen of libSystem failed: no such file" });
  // This box has no libSystem: the loader answers failed, it does not throw.
  if (process.platform !== "darwin") { const l = await loadLaunchLib(); assert.ok("failed" in l, JSON.stringify(l)); }
});

test("board ab-v16.94.30: launchdMcpListen: --test never asks launchd (its port, or none); the socket's fd; ENOENT and ESRCH: no MCP port and a log line; the rest: failed", async () => {
  let loads = 0;
  const never = async () => { loads++; return fakeLib({ fds: [7] }).lib; };
  const lines: string[] = [];
  const log = (l: string) => lines.push(l);
  assert.deepEqual(await launchdMcpListen({ test: true, testPort: 0, log, load: never }), { port: 0 });
  assert.equal(await launchdMcpListen({ test: true, log, load: never }), null);
  assert.equal(loads, 0, "--test loads no libSystem and takes no launchd socket");
  assert.deepEqual(lines, []);
  assert.deepEqual(await launchdMcpListen({ test: false, log, load: fakeLib({ fds: [9] }).load }), { fd: 9 });
  assert.deepEqual(lines, []);
  for (const err of [ENOENT, ESRCH]) {
    lines.length = 0;
    assert.equal(await launchdMcpListen({ test: false, log, load: fakeLib({ err }).load }), null);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^service: launchd gives the service no socket for the MCP port \(.*\), so it opens no MCP port$/);
  }
  for (const o of [{ err: EALREADY }, { fds: [] }, { fds: [7, 8] }, { fds: [7], mark: { 7: "fails" as const } }]) {
    lines.length = 0;
    const got = await launchdMcpListen({ test: false, log, load: fakeLib(o).load });
    assert.ok(got !== null && "failed" in got && /^the MCP port's socket: /.test(got.failed), JSON.stringify(got));
    assert.deepEqual(lines, [], "McpPart logs a failed take (mcp: the MCP port cannot open, ...)");
  }
});

test("board ab-v16.94.30: the ffi signatures pass no variadic argument (fcntl and ioctl with two arguments), and libSystem's free frees the array", () => {
  const src = readFileSync(join(ROOT, "src/service/mcp/launchd-socket.ts"), "utf8");
  assert.match(src, /dlopen\("\/usr\/lib\/libSystem\.B\.dylib"/);
  assert.match(src, /launch_activate_socket: \{ return: "int32", arguments: \["buffer", "buffer", "buffer"\] \}/);
  assert.match(src, /ioctl: \{ return: "int32", arguments: \["int32", "uint64"\] \}/);
  assert.match(src, /fcntl: \{ return: "int32", arguments: \["int32", "int32"\] \}/);
  assert.match(src, /free: \{ return: "void", arguments: \["pointer"\] \}/);
  assert.equal(src.match(/import\(\s*["']node:ffi["']\s*\)/g)?.length, 1);
});

test("board ab-v16.94.30: main.ts takes launchd's socket on the Mac only; Linux keeps systemd's socket through mcpListen, exactly as before", () => {
  const main = readFileSync(join(ROOT, "src/service/main.ts"), "utf8");
  assert.ok(main.includes("const listen = darwin\n    ? await launchdMcpListen({ test, testPort: test && testPort !== undefined ? testMcpPort(testPort) : undefined, log })\n    : await mcpListen({ test, testPort: test && testPort !== undefined ? testMcpPort(testPort) : undefined });"), "the Mac: launchd; else: systemd");
  assert.equal(main.match(/launchdMcpListen\(/g)?.length, 1);
  assert.equal(main.match(/await mcpListen\(/g)?.length, 1);
});
