// The external mode of the agent-mode live suite (test/live/agent-mode/run.ts, board ab-v16.60): its guard, which
// refuses the live daemon's agent browser (the operator's) before the suite connects or starts anything, and the
// answer of its control command. The suite itself drives a browser, so it is not part of `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { controlAnswer, externalMode } from "./live/agent-mode/external.ts";
import { ROOT } from "./helpers.ts";

const UID = 1001;
const LIVE = `/run/user/${UID}/agentwatch/browser-cdp.sock`;
/** The sockets that exist on the box below (their real paths). */
const SOCKETS = new Set([LIVE, "/tmp/t/run/browser-cdp.sock", `/run/user/${UID}/agentwatch-test/run/browser-cdp.sock`]);
/** A box where /tmp/link is a link to the live daemon's folder (with no none.sock in it), /tmp/l.sock a link to the
 *  live socket, /tmp/dead.sock a link to a live socket that is gone (so it has no real path), /tmp/t.sock a link to
 *  /tmp/t/run/browser-cdp.sock, /tmp/gone does not exist, and /tmp/ctl is the only executable. */
const box = {
  uid: UID,
  realpath: (p: string) => {
    if (p === "/tmp/link/none.sock" || p === "/tmp/dead.sock" || p.startsWith("/tmp/gone")) return null;
    if (p === "/tmp/l.sock") return LIVE;
    if (p === "/tmp/t.sock") return "/tmp/t/run/browser-cdp.sock";
    return p.startsWith("/tmp/link") ? p.replace("/tmp/link", `/run/user/${UID}/agentwatch`) : p;
  },
  socket: (p: string) => { const r = box.realpath(p); return r !== null && SOCKETS.has(r); },
  executable: (p: string) => p === "/tmp/ctl",
};
/** The same box, where the live daemon's folder is itself a link to /srv/aw. */
const linkedLive = {
  ...box,
  realpath: (p: string) => (p.startsWith(`/run/user/${UID}/agentwatch/`) || p === `/run/user/${UID}/agentwatch` ? p.replace(`/run/user/${UID}/agentwatch`, "/srv/aw") : p),
  socket: (p: string) => p === "/srv/aw/browser-cdp.sock",
};
const refused = (env: Record<string, string>, o = box) => { const r = externalMode(env, o); assert.equal(r.ok, false, JSON.stringify(env)); return (r as { message: string }).message; };

test("without RELAY_SOCK the suite runs in its own mode", () => {
  assert.deepEqual(externalMode({ CONTROL: "/tmp/ctl" }, box), { ok: true, socket: null });
});

test("the external mode refuses every socket of the live daemon's folder, also through a link or $XDG_RUNTIME_DIR", () => {
  for (const sock of [`/run/user/${UID}/agentwatch/browser-cdp.sock`, `/run/user/${UID}/agentwatch`, `/run/user/${UID}/agentwatch/x/../browser-cdp.sock`, "/tmp/link/browser-cdp.sock"])
    assert.match(refused({ RELAY_SOCK: sock, CONTROL: "/tmp/ctl" }), /^refused: .* is in the live daemon's socket folder/, sock);
  assert.match(refused({ RELAY_SOCK: "/xdg/agentwatch/browser-cdp.sock", CONTROL: "/tmp/ctl", XDG_RUNTIME_DIR: "/xdg" }), /^refused: /);
  // A missing socket in a linked folder: the folder's real path counts.
  assert.match(refused({ RELAY_SOCK: "/tmp/link/none.sock", CONTROL: "/tmp/ctl" }), /^refused: /);
  // A link in another folder to the live socket: the socket's real path counts.
  assert.match(refused({ RELAY_SOCK: "/tmp/l.sock", CONTROL: "/tmp/ctl" }), /^refused: /);
  // The path is resolved before the check: as text, this one starts outside the live folder.
  assert.match(refused({ RELAY_SOCK: `/tmp/../run/user/${UID}/agentwatch/browser-cdp.sock`, CONTROL: "/tmp/ctl" }), /^refused: /);
  // The live folder of another user (a run as root), and the real path of a live folder that is a link.
  assert.match(refused({ RELAY_SOCK: "/run/user/0/agentwatch/browser-cdp.sock", CONTROL: "/tmp/ctl" }), /^refused: /);
  assert.match(refused({ RELAY_SOCK: "/srv/aw/browser-cdp.sock", CONTROL: "/tmp/ctl" }, linkedLive), /^refused: /);
  // Another folder whose name only starts the same way is not the live one.
  assert.deepEqual(externalMode({ RELAY_SOCK: `/run/user/${UID}/agentwatch-test/run/browser-cdp.sock`, CONTROL: "/tmp/ctl" }, box),
    { ok: true, socket: `/run/user/${UID}/agentwatch-test/run/browser-cdp.sock`, control: "/tmp/ctl" });
});

test("the external mode needs a socket that exists, with no ':' in its path, and connects to its real path", () => {
  // A link to a live socket that is gone has no real path: the relay could come back at it during the ready wait.
  assert.match(refused({ RELAY_SOCK: "/tmp/dead.sock", CONTROL: "/tmp/ctl" }), /is no socket that exists/);
  assert.match(refused({ RELAY_SOCK: "/tmp/gone/browser-cdp.sock", CONTROL: "/tmp/ctl" }), /is no socket that exists/);
  // ws takes a unix socket's path only up to its first ':', so the guard would check another path than the run uses.
  assert.match(refused({ RELAY_SOCK: "/tmp/t/run/browser-cdp.sock:/devtools/browser/pw", CONTROL: "/tmp/ctl" }), /contains ':'/);
  assert.deepEqual(externalMode({ RELAY_SOCK: "/tmp/t.sock", CONTROL: "/tmp/ctl" }, box), { ok: true, socket: "/tmp/t/run/browser-cdp.sock", control: "/tmp/ctl" });
});

test("the external mode needs an executable CONTROL, and refuses the group peer, which needs the stand-in daemon", () => {
  assert.match(refused({ RELAY_SOCK: "/tmp/t/run/browser-cdp.sock" }), /^usage: RELAY_SOCK=<socket> CONTROL=/);
  assert.match(refused({ RELAY_SOCK: "/tmp/t/run/browser-cdp.sock", CONTROL: "/tmp/other" }), /^usage: /);
  assert.match(refused({ RELAY_SOCK: "/tmp/t/run/browser-cdp.sock", CONTROL: "/tmp/ctl", CASES: "peer" }), /group peer .* own mode only/);
  // The live folder's refusal comes first, also with no CONTROL, and also before the group peer's.
  assert.match(refused({ RELAY_SOCK: `/run/user/${UID}/agentwatch/browser-cdp.sock` }), /^refused: /);
  assert.match(refused({ RELAY_SOCK: `/run/user/${UID}/agentwatch/browser-cdp.sock`, CONTROL: "/tmp/ctl", CASES: "peer" }), /^refused: /);
  assert.deepEqual(externalMode({ RELAY_SOCK: "/tmp/t/run/browser-cdp.sock", CONTROL: "/tmp/ctl", CASES: "playwright,link-up" }, box),
    { ok: true, socket: "/tmp/t/run/browser-cdp.sock", control: "/tmp/ctl" });
});

test("the control's answer is the JSON object in its output, or a failed answer that says why", () => {
  assert.deepEqual(controlAnswer('{"ok": true, "scope": "s1"}\n', 0), { ok: true, scope: "s1" });
  assert.deepEqual(controlAnswer('the test browser: end_scope s1\n{\n  "ok": true\n}\n', 0), { ok: true });
  assert.deepEqual(controlAnswer("Traceback (most recent call last):\n", 1), { ok: false, error: "no JSON answer (exit 1)" });
  assert.deepEqual(controlAnswer("[1, 2]", 0), { ok: false, error: "no JSON answer (exit 0)" });
});

test("the suite refuses the live daemon's socket before it makes its run folder or connects", () => {
  const run = join(tmpdir(), `ab-external-guard-${process.pid}-${Date.now()}`);
  const uid = process.getuid!();
  const r = spawnSync(process.execPath, [join(ROOT, "test/live/agent-mode/run.ts")], {
    encoding: "utf8", timeout: 30_000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, RUN: run, RELAY_SOCK: `/run/user/${uid}/agentwatch/browser-cdp.sock`, CONTROL: "/bin/true" },
  });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /^refused: .* is in the live daemon's socket folder/);
  assert.equal(existsSync(run), false);
});
