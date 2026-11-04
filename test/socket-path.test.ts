// A long state folder (ab-b84.12): when <stateDir>/chrome-proxy.sock passes MAX_SOCKET_PATH_BYTES (on
// macOS an agent session's scratchpad gave 142 bytes), the refusal names the way out: --socket (library
// option socketPath) with an example path that fits, in a folder that only this user can write. The
// example folder is the real path of $XDG_RUNTIME_DIR, then of $TMPDIR, each only when it is private;
// never the shared /tmp. The example's name comes from the state folder's real path.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { optionsFromFlags } from "../src/cli.ts";
import { MAX_SOCKET_PATH_BYTES, resolveOptions, socketPathExample } from "../src/options.ts";
import { cli } from "./helpers.ts";

let tmp: string, allowlist: string;
const uid = process.getuid!();
let n = 0;
/** A new folder of this test's own, with this mode. */
const folder = (mode = 0o700, name = `d${++n}`) => { const d = join(tmp, name); mkdirSync(d); chmodSync(d, mode); return d; };

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "ab-long-"));
  allowlist = join(tmp, "allow.json");
  writeFileSync(allowlist, JSON.stringify({ allow: ["example.org"] }));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

/** A state folder whose default socket <stateDir>/chrome-proxy.sock passes 103 bytes. */
const longState = (name: string) => join(tmp, "a-deep-agent-session-scratchpad-folder".repeat(3), name);
/** The real path of a path under tmp that need not exist yet. */
const real = (p: string) => join(realpathSync(tmp), relative(tmp, p));
/** The example the refusal gives: in the real path of `dir`, named from the state folder's real path. */
const exampleIn = (dir: string, stateDir: string) =>
  join(realpathSync(dir), `ab-${createHash("sha256").update(real(stateDir)).digest("hex").slice(0, 8)}.sock`);

/** Run `fn` with these environment values (undefined: unset), then restore them. */
async function withEnv<T>(env: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  const set = (vals: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(vals)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  };
  set(env);
  try { return await fn(); } finally { set(saved); }
}

/** The refusal of a long state folder, checked for what every refusal says; returns its example path or undefined. */
function refusal(stateDir: string): string | undefined {
  let message = "";
  assert.throws(() => resolveOptions({ stateDir }), (e: Error) => { message = e.message; return e.name === "UsageError"; });
  const inside = join(stateDir, "chrome-proxy.sock");
  assert.ok(message.includes(`${inside} is ${Buffer.byteLength(inside)} bytes`), message);
  assert.match(message, /Unix socket path holds at most 103 bytes \(the macOS limit\)/);
  assert.match(message, /--socket PATH \(library option socketPath, Python socket=\)/);
  assert.match(message, /only you can write \(mode 0700\)/);
  assert.match(message, /every caller of this state folder must give the same --socket/);
  assert.doesNotMatch(message, /\.agent-browser/);
  const example = message.match(/for example --socket (\/\S+?)[;,]? /)?.[1];
  if (example !== undefined) assert.ok(Buffer.byteLength(example) <= MAX_SOCKET_PATH_BYTES, example);
  return example;
}

test("a long state folder is refused, and the message names --socket and socketPath with an example under a private XDG_RUNTIME_DIR, then TMPDIR", async () => {
  const state = longState("a");
  assert.ok(Buffer.byteLength(join(state, "chrome-proxy.sock")) > MAX_SOCKET_PATH_BYTES);
  const xdg = folder(), tmpd = folder();
  assert.equal(await withEnv({ XDG_RUNTIME_DIR: xdg, TMPDIR: tmpd }, () => refusal(state)), exampleIn(xdg, state), "XDG_RUNTIME_DIR first");
  assert.equal(await withEnv({ XDG_RUNTIME_DIR: undefined, TMPDIR: tmpd }, () => refusal(state)), exampleIn(tmpd, state), "the macOS case: TMPDIR");
  // Only a private folder is an example: owned by this user, with no group or other write bit.
  const shared = folder(0o1777), group = folder(0o770), other = folder(0o002 | 0o700);
  for (const notPrivate of [shared, group, other, "/tmp", join(tmp, "missing"), "relative/run", ""])
    assert.equal(await withEnv({ XDG_RUNTIME_DIR: notPrivate, TMPDIR: tmpd }, () => refusal(state)), exampleIn(tmpd, state), `XDG_RUNTIME_DIR=${notPrivate}`);
  for (const notPrivate of [shared, "/tmp", undefined])
    assert.equal(await withEnv({ XDG_RUNTIME_DIR: undefined, TMPDIR: notPrivate }, () => refusal(state)), undefined, `TMPDIR=${notPrivate}: no example`);
  // A private folder whose example would not fit in 103 bytes is no example either.
  const deep = folder(0o700, "d".repeat(100));
  assert.equal(await withEnv({ XDG_RUNTIME_DIR: deep, TMPDIR: tmpd }, () => refusal(state)), exampleIn(tmpd, state));
  assert.equal(await withEnv({ XDG_RUNTIME_DIR: deep, TMPDIR: undefined }, () => refusal(state)), undefined);
  // Another user's folder is no example (the owner check, with another uid).
  assert.equal(socketPathExample(state, [xdg], uid + 1), undefined);
  assert.equal(socketPathExample(state, [xdg], uid), exampleIn(xdg, state));
  assert.equal(existsSync(state), false, "the refusal makes nothing");
  assert.deepEqual(readdirSync(xdg), []);
  assert.deepEqual(readdirSync(tmpd), []);
});

test("the example comes from real paths: a symlink to a private folder gives that folder, a symlink to a shared folder or a file gives none", async () => {
  const state = longState("real"), priv = folder(), shared = folder(0o1777), file = join(tmp, "a-file");
  writeFileSync(file, "");
  const toPriv = join(tmp, "to-priv"), toShared = join(tmp, "to-shared"), toFile = join(tmp, "to-file");
  symlinkSync(priv, toPriv);
  symlinkSync(shared, toShared);
  symlinkSync(file, toFile);
  const example = socketPathExample(state, [toPriv], uid);
  assert.equal(example, exampleIn(priv, state));
  assert.ok(!example!.startsWith(toPriv + "/"), "the symlink is not in the example");
  for (const none of [toShared, toFile, file]) assert.equal(socketPathExample(state, [none], uid), undefined, none);
  assert.equal(await withEnv({ XDG_RUNTIME_DIR: toPriv, TMPDIR: undefined }, () => refusal(state)), exampleIn(priv, state));
  assert.equal(await withEnv({ XDG_RUNTIME_DIR: toShared, TMPDIR: toFile }, () => refusal(state)), undefined);
  // Two spellings of one state folder (a symlink, or /tmp and /private/tmp on macOS) give one name.
  const realDir = folder(), spelled = join(tmp, "spelled"), tail = "s".repeat(100);
  symlinkSync(realDir, spelled);
  assert.equal(socketPathExample(join(spelled, tail, "state"), [priv], uid), socketPathExample(join(realDir, tail, "state"), [priv], uid));
  assert.deepEqual(readdirSync(priv), [], "the refusal makes nothing");
});

test("the CLI gives the same refusal: exit status 2, code usage", async () => {
  const state = longState("cli"), xdg = folder();
  await withEnv({ XDG_RUNTIME_DIR: xdg }, async () => {
    assert.throws(() => optionsFromFlags({ "state-dir": state }, () => {}), (e: Error) => e.message.includes(`--socket ${exampleIn(xdg, state)}`));
    const r = await cli(["tabs", "--state-dir", state, "--allowlist", allowlist, "--no-launch", "--json"]);
    assert.equal(r.status, 2, r.stdout);
    assert.equal(r.json?.error?.code, "usage");
    assert.ok(r.json.error.message.includes(`--socket ${exampleIn(xdg, state)}`), r.json.error.message);
  });
  assert.equal(existsSync(state), false, "the refusal makes nothing");
});

test("an explicit socketPath stays as it is: used with a long state folder, refused when too long, with the same way out and example", async () => {
  const mine = join(tmp, "mine.sock"), state = longState("explicit"), xdg = folder();
  assert.equal(resolveOptions({ stateDir: state, socketPath: mine }).socketPath, mine);
  assert.equal(optionsFromFlags({ "state-dir": state, socket: mine }, () => {}).socketPath, mine);
  const long = "/" + "x".repeat(MAX_SOCKET_PATH_BYTES);
  await withEnv({ XDG_RUNTIME_DIR: xdg }, () => {
    for (const f of [() => resolveOptions({ stateDir: state, socketPath: long }), () => optionsFromFlags({ "state-dir": state, socket: long }, () => {})])
      assert.throws(f, (e: Error) => e.name === "UsageError" && e.message.includes(`socketPath is ${MAX_SOCKET_PATH_BYTES + 1} bytes`)
        && /Unix socket path holds at most 103 bytes \(the macOS limit\)/.test(e.message) && e.message.includes(long)
        && /--socket PATH \(library option socketPath, Python socket=\)/.test(e.message) && e.message.includes(`--socket ${exampleIn(xdg, state)}`)
        && /every caller of this state folder must give the same --socket/.test(e.message));
  });
});

test("a short state folder keeps <stateDir>/chrome-proxy.sock", () => {
  assert.equal(resolveOptions({ stateDir: join(tmp, "short") }).socketPath, join(tmp, "short", "chrome-proxy.sock"));
  assert.equal(optionsFromFlags({ "state-dir": join(tmp, "short") }, () => {}).socketPath, join(tmp, "short", "chrome-proxy.sock"));
});
