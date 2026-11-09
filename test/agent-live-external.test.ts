// The external mode of the agent-mode live suite (test/live/agent-mode/run.ts, board ab-v16.60): its guard, which
// refuses the live daemon's agent browser (the operator's) before the suite connects or starts anything, and the
// answer of its control command. The suite itself drives a browser, so it is not part of `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { controlAnswer, controlSocket, externalMode, wsPathKept, wsUrl } from "./live/agent-mode/external.ts";
import { ROOT, suiteStandIn } from "./helpers.ts";

const UID = 1001;
const LIVE_DIR = `/run/user/${UID}/agentwatch`;
const LIVE = `${LIVE_DIR}/browser-cdp.sock`;
/** Paths that the ws+unix URL parse changes: a space and a non-ASCII letter are percent-encoded, %2e%2e is "..", a TAB
 *  is removed. Each is a socket on the box below. */
const ODD = ["/tmp/a b.sock", "/tmp/é.sock", `/tmp/x/%2e%2e/%2e%2e${LIVE}`, "/tmp/a\tb.sock"];
/** The sockets that exist on the box below (their real paths). */
const SOCKETS = new Set([LIVE, "/tmp/t/run/browser-cdp.sock", `/run/user/${UID}/agentwatch-test/run/browser-cdp.sock`, "/tmp/hard.sock", "/tmp/hard2.sock", "/tmp/c:d.sock", ...ODD]);
/** A box where /tmp/link is a link to the live daemon's folder (with no none.sock in it), /tmp/l.sock a link to the
 *  live socket, /tmp/dead.sock a link to a live socket that is gone (so it has no real path), /tmp/t.sock a link to
 *  /tmp/t/run/browser-cdp.sock, /tmp/colon.sock a link to /tmp/c:d.sock, /tmp/hard.sock a hard link to the live
 *  socket (the same device and inode), /tmp/hard2.sock one to the live socket of uid 1002, /tmp/file a plain file, /tmp/gone does not exist, and /tmp/ctl is the only
 *  executable. */
const box = {
  uid: UID,
  home: "/example/u",
  realpath: (p: string) => {
    if (p === "/tmp/link/none.sock" || p === "/tmp/dead.sock" || p.startsWith("/tmp/gone")) return null;
    if (p === "/tmp/l.sock") return LIVE;
    if (p === "/tmp/t.sock") return "/tmp/t/run/browser-cdp.sock";
    if (p === "/tmp/colon.sock") return "/tmp/c:d.sock";
    return p.startsWith("/tmp/link") ? p.replace("/tmp/link", LIVE_DIR) : p;
  },
  socket: (p: string) => { const r = box.realpath(p); return r !== null && SOCKETS.has(r); },
  id: (p: string) => {
    const r = box.realpath(p);
    if (r === null) return null;
    return r === LIVE || r === "/tmp/hard.sock" ? "1:10" : r === "/run/user/1002/agentwatch/browser-cdp.sock" || r === "/tmp/hard2.sock" ? "1:20" : `1:${r}`;
  },
  entries: (d: string) => (d === LIVE_DIR ? [LIVE, `${LIVE_DIR}/browser.sock`, `${LIVE_DIR}/hooks.sock`]
    : d === "/run/user/1002/agentwatch" ? ["/run/user/1002/agentwatch/browser-cdp.sock"] : d === "/run/user" ? [`/run/user/${UID}`, "/run/user/1002"] : []),
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
  assert.match(refused({ RELAY_SOCK: "/tmp/t/run/browser-cdp.sock:/devtools/browser/pw", CONTROL: "/tmp/ctl" }), /the ws\+unix URL/);
  // A plain file is no socket.
  assert.match(refused({ RELAY_SOCK: "/tmp/file", CONTROL: "/tmp/ctl" }), /is no socket that exists/);
  assert.deepEqual(externalMode({ RELAY_SOCK: "/tmp/t.sock", CONTROL: "/tmp/ctl" }, box), { ok: true, socket: "/tmp/t/run/browser-cdp.sock", control: "/tmp/ctl" });
});

test("the external mode refuses a path that the ws+unix URL changes, and a hard link to a live socket", () => {
  // A ':' in the real path only, and each path that the URL parse changes (review-62b, B3).
  assert.match(refused({ RELAY_SOCK: "/tmp/colon.sock", CONTROL: "/tmp/ctl" }), /the ws\+unix URL/);
  for (const sock of ODD) assert.match(refused({ RELAY_SOCK: sock, CONTROL: "/tmp/ctl" }), /the ws\+unix URL/, JSON.stringify(sock));
  // The same device and inode as a socket of the live folder (review-62b, B4).
  assert.match(refused({ RELAY_SOCK: "/tmp/hard.sock", CONTROL: "/tmp/ctl" }), /^refused: .* is the same file as a socket of the live daemon/);
  assert.match(refused({ RELAY_SOCK: "/tmp/hard2.sock", CONTROL: "/tmp/ctl" }), /^refused: .* is the same file as a socket of the live daemon/);
  // agentwatch's other socket folders: the gateway's, and the macOS one (runtime_paths.py).
  assert.match(refused({ RELAY_SOCK: "/run/agentwatch/x.sock", CONTROL: "/tmp/ctl" }), /^refused: .* live daemon's socket folder/);
  assert.match(refused({ RELAY_SOCK: "/example/u/.cache/agentwatch/run/browser-cdp.sock", CONTROL: "/tmp/ctl" }), /^refused: .* live daemon's socket folder/);
});

test("a socket path is kept by the ws+unix URL only when it has plain characters and the URL gives it back", () => {
  assert.equal(wsUrl("/tmp/t/run/browser-cdp.sock", "s1"), "ws+unix:///tmp/t/run/browser-cdp.sock:/devtools/browser/s1");
  for (const p of ["/tmp/t/run/relay.sock", "/tmp/ab-agent-live-Xy_9.z/relay.sock", "/tmp/.../relay.sock"]) assert.equal(wsPathKept(p), true, p);
  for (const p of [...ODD, "/tmp/c:d.sock", "/tmp/a#b.sock", "/tmp/a?b.sock", "/tmp/a\nb.sock", "relative.sock", "/tmp/../x.sock"]) assert.equal(wsPathKept(p), false, JSON.stringify(p));
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
    env: { PATH: process.env.PATH, HOME: process.env.HOME, RUN: run, RELAY_SOCK: `/run/user/${uid}/agentwatch/browser-cdp.sock`, CONTROL: "/bin/true", SITE_PORT: "0" },
  });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /^refused: .* is in the live daemon's socket folder/);
  assert.equal(existsSync(run), false);
});

test("the own mode refuses a RUN that the ws+unix URL changes, before it makes the run folder", () => {
  // The own mode first needs CHROME_EXTENSION with agent/manifest.json and test/live/host.py: a stand-in folder.
  const dir = mkdtempSync(join(tmpdir(), "ab-run-check-"));
  try {
    const ext = join(dir, "ext");
    mkdirSync(join(ext, "agent"), { recursive: true });
    mkdirSync(join(ext, "test/live"), { recursive: true });
    writeFileSync(join(ext, "agent/manifest.json"), "{}");
    writeFileSync(join(ext, "test/live/host.py"), "");
    const run = join(dir, "a b", "run");
    const r = spawnSync(process.execPath, [join(ROOT, "test/live/agent-mode/run.ts")], {
      encoding: "utf8", timeout: 30_000, env: { PATH: process.env.PATH, HOME: process.env.HOME, CHROME_EXTENSION: ext, RUN: run, SITE_PORT: "0" },
    });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /^RUN=".*\/a b\/run": use a path of letters, digits and \._-\/ only/);
    assert.equal(existsSync(join(dir, "a b")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the run's clients connect to the real path that the guard checked, not to RELAY_SOCK as given", async () => {
  // RELAY_SOCK is a link: the env line's endpoint (url() of scope s1) must name the link's real path.
  const s = await suiteStandIn();
  try {
    const r = await s.run({ RUN: join(s.dir, "run") });
    assert.equal(r.status, 1, r.stderr);
    const env = JSON.parse(r.stdout.split("\n")[1]);
    assert.equal(env.endpoint, wsUrl(s.real, "s1"));
    assert.notEqual(s.real, s.link);
    assert.equal(env.external.socket, s.real);
  } finally { await s.remove(); }
});

// The comparison must resolve both paths, reject a failed status even with valid JSON, and fail closed on bad data.
for (const kind of ["same", "symlink", "other", "missing-file", "missing-field", "empty-field", "non-string", "bad-json", "bad-shape", "failure", "timeout", "status-false", "missing-ok"] as const) {
  test(`CONTROL socket check: ${kind}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "ab-control-"));
    try {
      const socket = join(dir, "relay.sock"), alias = join(dir, "alias.sock"), other = join(dir, "other.sock");
      writeFileSync(socket, "");
      writeFileSync(other, "");
      symlinkSync(socket, alias);
      const paths = { same: socket, symlink: alias, other, "missing-file": join(dir, "missing.sock") };
      let answer: unknown = { ok: true, socket: paths[kind as keyof typeof paths] ?? socket };
      if (kind === "missing-field") answer = { ok: true };
      if (kind === "missing-ok") answer = { socket };
      if (kind === "empty-field") answer = { ok: true, socket: "" };
      if (kind === "non-string") answer = { ok: true, socket: 42 };
      if (kind === "bad-shape") answer = [{ socket }];
      if (kind === "status-false") answer = { ok: false, socket, error: "status failed" };
      const stdout = kind === "bad-json" ? "not JSON" : JSON.stringify(answer);
      const exit = kind === "failure" ? 1 : kind === "timeout" ? "ETIMEDOUT" : 0;
      const result = controlSocket(stdout, exit, socket, realpathSync);
      assert.equal(result.ok, kind === "same" || kind === "symlink", JSON.stringify(result));
      if (!result.ok) {
        assert.match(result.message, /refused:.*CONTROL status/);
        if (kind === "empty-field" || kind === "non-string") assert.match(result.message, /needs a nonempty socket field/);
        if (kind === "missing-ok") assert.match(result.message, /ok.*true/);
        assert.ok(result.message.includes(socket), result.message);
        if (kind === "other" || kind === "missing-file") assert.ok(result.message.includes(paths[kind]), result.message);
      }
      // The expected socket can also be a link, or can disappear after the environment guard.
      if (kind === "same") {
        assert.equal(controlSocket(stdout, 0, alias, realpathSync).ok, true);
        assert.equal(controlSocket(stdout, 0, join(dir, "gone.sock"), realpathSync).ok, false);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

for (const kind of ["other", "missing-field", "bad-json", "failure", "status-false", "missing-file", "timeout", "missing-ok"] as const) {
  test(`external run refuses CONTROL ${kind} before any connection, end-scope or restart-relay`, async () => {
    const s = await suiteStandIn();
    try {
      const other = join(s.dir, "other.sock"), run = join(s.dir, "run");
      writeFileSync(other, "");
      const output = kind === "bad-json" ? "not JSON" : JSON.stringify(kind === "missing-field" ? { ok: true }
        : kind === "missing-ok" ? { socket: s.real }
        : { ok: kind !== "status-false", socket: kind === "other" ? other : kind === "missing-file" ? join(s.dir, "gone.sock") : s.real });
      // A single Node process implements CONTROL. A timed-out status leaves no shell child behind.
      writeFileSync(join(s.dir, "control"), `#!${process.execPath}
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(join(s.dir, "control.calls"))}, process.argv.slice(2).join(" ") + "\\n");
if (${JSON.stringify(kind)} === "timeout") setTimeout(() => {}, 60_000);
else { console.log(${JSON.stringify(output)}); process.exit(${kind === "failure" ? 1 : 0}); }
`, { mode: 0o755 });
      const r = await s.run({ RUN: run });
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /refused:.*CONTROL status/);
      assert.ok(r.stderr.includes(s.real), r.stderr);
      if (kind === "other") assert.ok(r.stderr.includes(other), r.stderr);
      assert.deepEqual(s.calls(), ["status"]);
      assert.equal(existsSync(run), false, "refusal happens before the run folder or its clients exist");
    } finally { await s.remove(); }
  });
}

for (const port of ["abc", "8782", "-1"]) {
  test(`the suite refuses SITE_PORT=${port} before CONTROL or run-folder creation`, async () => {
    const s = await suiteStandIn();
    try {
      const run = join(s.dir, "run");
      const r = await s.run({ RUN: run, SITE_PORT: port });
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /SITE_PORT.*8781.*0/);
      assert.deepEqual(s.calls(), []);
      assert.equal(existsSync(run), false);
    } finally { await s.remove(); }
  });
}
