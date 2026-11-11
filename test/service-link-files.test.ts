// The parts of the native link (C4) and the host files that the agent Chrome reads (stage 1b part 2, board
// ab-v16.94.9): the cases of agentwatch's tests/daemon/browser/test_parts.py and test_host_files.py, ported, with the
// shared vectors of chrome-extension (test/vectors/chrome-extension-3d84667: parts.json and parts-bridge.json).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BIN, manifestPath, shimArgv, wrapperPath, wrapperText, writeHostFiles } from "../src/service/link/manifest.ts";
import { PART_BYTES, splitParts } from "../src/service/link/parts.ts";
import { RECEIVER_ID } from "../src/service/package/pins.ts";

const V = (f: string) => JSON.parse(readFileSync(new URL(`./vectors/chrome-extension-3d84667/${f}`, import.meta.url), "utf8"));
const tmp = (t: { after: (f: () => void) => void }) => { const d = mkdtempSync(join(tmpdir(), "ab-files-")); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const join64 = (parts: { b64: string }[]) => Buffer.concat(parts.map((p) => Buffer.from(p.b64, "base64")));

test("the parts vector: a main request in slices of part_bytes, with no ch", () => {
  const v = V("parts.json");
  assert.deepEqual(splitParts(v.id, v.request, undefined, v.part_bytes), v.parts);
});

test("the bridge parts vector: each part names its channel after t", () => {
  const v = V("parts-bridge.json");
  const parts = splitParts(v.id, v.request, v.ch, v.part_bytes);
  assert.deepEqual(parts, v.parts);
  assert.deepEqual(Object.keys(parts[0]), ["t", "ch", "id", "seq", "n", "b64"]);
  assert.deepEqual(Object.keys(splitParts("x", {})[0]), ["t", "id", "seq", "n", "b64"]);
});

test("PART_BYTES is 700000, and a large request goes in three parts, each line under 1,000,000 bytes", () => {
  assert.equal(PART_BYTES, 700_000);
  const parts = splitParts("big", { t: "req", id: "big", op: "import", state: "x".repeat(1_500_000) });
  assert.equal(parts.length, 3);
  for (const p of parts) assert.ok(Buffer.byteLength(JSON.stringify(p)) < 1_000_000);
  assert.equal(JSON.parse(join64(parts).toString("utf8")).state.length, 1_500_000);
});

test("non-ASCII goes as compact UTF-8, and a lone surrogate splits and comes back as the same string", () => {
  const req = { t: "req", id: "u", op: "import", s: "é漢\ud800x" };
  const parts = splitParts("u", req, undefined, 3);
  const back = join64(parts).toString("utf8");
  assert.equal(back, JSON.stringify(req));
  assert.ok(back.includes("é漢"), "UTF-8, not ASCII escapes");
  assert.ok(back.includes("\\ud800"), "the lone surrogate goes as an escape");
  assert.equal(JSON.parse(back).s, req.s);
});

test("the wrapper's text is exact: the socket and the profile in the environment, then exec of this Node's shim", () => {
  const text = wrapperText({ socket: "/run/x/link.sock", profile: "/s/profile", node: "/usr/bin/node", bin: "/opt/ab/bin/agent-browser.js" });
  assert.equal(text, "#!/bin/sh\nAGENT_BROWSER_LINK_SOCKET='/run/x/link.sock'\nexport AGENT_BROWSER_LINK_SOCKET\nAGENT_BROWSER_PROFILE='/s/profile'\nexport AGENT_BROWSER_PROFILE\nexec '/usr/bin/node' '--disable-sigusr1' '/opt/ab/bin/agent-browser.js' 'host' \"$@\"\n");
  assert.deepEqual(shimArgv({ node: "/usr/bin/node", bin: "/b" }), ["/usr/bin/node", "--disable-sigusr1", "/b", "host"]);
  assert.deepEqual(shimArgv(), [process.execPath, "--disable-sigusr1", BIN, "host"]);
});

test("the wrapper is 0700 and the manifest exact and 0600 in a 0700 folder, allowing only the receiver", (t) => {
  const d = tmp(t), state = join(d, "state"), profile = join(state, "profile");
  const r = writeHostFiles({ state, profile, socket: join(d, "link.sock") });
  assert.equal(r.wrapper, wrapperPath(state));
  assert.equal(r.manifest, join(profile, "NativeMessagingHosts", "sh.agentwatch.browser.json"));
  assert.equal(manifestPath(profile), r.manifest);
  assert.equal(statSync(r.wrapper).mode & 0o777, 0o700);
  assert.equal(statSync(r.manifest).mode & 0o777, 0o600);
  assert.equal(statSync(join(profile, "NativeMessagingHosts")).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(readFileSync(r.manifest, "utf8")), { name: "sh.agentwatch.browser", description: "agent-browser link", path: r.wrapper, type: "stdio", allowed_origins: [`chrome-extension://${RECEIVER_ID}/`] });
});

test("a rewrite narrows a loose wrapper and manifest", (t) => {
  const d = tmp(t), state = join(d, "state"), profile = join(state, "profile");
  mkdirSync(join(profile, "NativeMessagingHosts"), { recursive: true });
  writeFileSync(wrapperPath(state), "old", { mode: 0o777 });
  writeFileSync(manifestPath(profile), "old", { mode: 0o666 });
  chmodSync(join(profile, "NativeMessagingHosts"), 0o777);
  writeHostFiles({ state, profile, socket: "/s" });
  assert.equal(statSync(wrapperPath(state)).mode & 0o777, 0o700);
  assert.equal(statSync(manifestPath(profile)).mode & 0o777, 0o600);
  assert.equal(statSync(join(profile, "NativeMessagingHosts")).mode & 0o777, 0o700);
});

test("a quote or a line break in a path is refused, and an ID that is not 32 letters a to p, with nothing written", (t) => {
  const d = tmp(t), state = join(d, "state"), profile = join(state, "profile");
  for (const bad of [{ socket: "/a'b" }, { socket: "/a\nb" }, { profile: "/p'q" }, { node: "/n\rx" }, { bin: "/b\0" }]) {
    assert.throws(() => writeHostFiles({ state, profile, socket: "/s", ...bad }), /quote or a line break/, JSON.stringify(bad));
  }
  for (const id of ["abc", "A".repeat(32), "q".repeat(32), `${"a".repeat(31)}`]) assert.throws(() => writeHostFiles({ state, profile, socket: "/s", receiverId: id }), /32 letters a to p/);
  assert.equal(statSync(state, { throwIfNoEntry: false }), undefined);
});

test("the wrapper exports the socket and the profile to the program it runs", (t) => {
  const d = tmp(t), state = join(d, "state");
  // A stand-in for node that prints its environment's two variables and its arguments.
  const node = join(d, "node");
  writeFileSync(node, `#!/bin/sh\necho "$AGENT_BROWSER_LINK_SOCKET|$AGENT_BROWSER_PROFILE|$*"\n`, { mode: 0o755 });
  const { wrapper } = writeHostFiles({ state, profile: join(d, "a b", "profile"), socket: join(d, "link.sock"), node, bin: "/b.js" });
  const out = execFileSync(wrapper, ["chrome-extension://x/"], { env: {}, encoding: "utf8" });
  assert.equal(out, `${join(d, "link.sock")}|${join(d, "a b", "profile")}|--disable-sigusr1 /b.js host chrome-extension://x/\n`);
});
