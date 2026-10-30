// The approver: mechanism selection, the commands it runs, the fail-safe macOS script, and the CLI
// flag round-trip. The real click cannot be unit-tested (the fake Chrome raises no native dialog),
// so these cover the contract and the safety property; taylor verified the Linux mechanism live.

import { test } from "node:test";
import assert from "node:assert/strict";
import { approveMechanism, makeApprover, macProcessName, osascriptApprove, type RunResult, type Runner } from "../src/approver.ts";
import { approveArgs } from "../src/proxy.ts";
import { optionsFromFlags } from "../src/cli.ts";
import { resolveOptions, validateApprove, type Settings } from "../src/options.ts";

const base = (approve: Settings["approve"]): Settings => resolveOptions({ stateDir: "/tmp/ab-approve-x", allow: ["example.org"], approve, log: () => {} });

function recorder(): { calls: { bin: string; args: string[] }[]; run: Runner } {
  const calls: { bin: string; args: string[] }[] = [];
  return { calls, run: async (bin, args) => { calls.push({ bin, args }); return { ok: true, detail: "clicked Allow" } as RunResult; } };
}

test("approveMechanism selects by spec and platform", () => {
  assert.equal(approveMechanism(undefined, "darwin"), undefined);
  assert.equal(approveMechanism(false, "linux"), undefined);
  assert.equal(approveMechanism(true, "darwin"), "osascript");
  assert.equal(approveMechanism(true, "linux"), "xdotool");
  assert.equal(approveMechanism("auto", "darwin"), "osascript");
  assert.equal(approveMechanism("osascript", "linux"), "osascript", "an explicit mechanism overrides the platform default");
  assert.equal(approveMechanism("xdotool", "darwin"), "xdotool");
  assert.equal(approveMechanism({ command: ["x"] }, "darwin"), "command");
});

test("no approver unless configured", () => {
  assert.equal(makeApprover(base(undefined)), undefined);
  assert.equal(makeApprover(base(false)), undefined);
  assert.ok(makeApprover(base(true), { platform: "darwin" }));
});

test("macOS approver clicks the button named Allow on the agent Chrome by pid, never Cancel or Turn off", async () => {
  const { calls, run } = recorder();
  const approver = makeApprover(base("osascript"), { platform: "darwin", run, chromeBin: "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta", pid: 4242 });
  assert.ok(approver);
  const r = await approver!();
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, "osascript");
  const script = calls[0].args[1];
  assert.match(script, /unix id is 4242/, "it targets the agent Chrome by pid, not by shared binary name");
  assert.doesNotMatch(script, /to activate/, "it does not activate a Chrome by app name (which could be the operator's)");
  assert.match(script, /\(name of e\) is "Allow"/);
  assert.match(script, /click e/);
  assert.doesNotMatch(script, /Cancel|Turn off/, "the script never targets Cancel or Turn off in settings");
});

test("without a pid the osascript falls back to the process name and activate", () => {
  assert.match(osascriptApprove("Google Chrome Beta"), /tell application "Google Chrome Beta" to activate/);
  assert.match(osascriptApprove("Google Chrome Beta", 77), /unix id is 77/);
});

test("macProcessName and osascriptApprove derive from the binary", () => {
  assert.equal(macProcessName("/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta"), "Google Chrome Beta");
  assert.equal(macProcessName("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"), "Google Chrome");
  assert.match(osascriptApprove("Google Chrome"), /tell application "Google Chrome" to activate/);
});

test("Linux approver scopes keys to the agent Chrome window (by pid) then Tab -> Allow, Return", async () => {
  const calls: { bin: string; args: string[] }[] = [];
  const run: Runner = async (bin, args) => { calls.push({ bin, args }); return { ok: true, detail: args[0] === "search" ? "900900" : "" }; };
  const approver = makeApprover(base("xdotool"), { platform: "linux", run, pid: 4242, sleep: async () => {} });
  assert.ok(approver);
  await approver!();
  assert.deepEqual(calls.map((c) => [c.bin, ...c.args]), [
    ["xdotool", "search", "--sync", "--onlyvisible", "--pid", "4242"],
    ["xdotool", "windowactivate", "--sync", "900900"],
    ["xdotool", "key", "--window", "900900", "--clearmodifiers", "Tab"],
    ["xdotool", "key", "--window", "900900", "--clearmodifiers", "Return"],
  ]);
});

test("a custom approve command runs verbatim", async () => {
  const { calls, run } = recorder();
  const approver = makeApprover(base({ command: ["/opt/approve.sh", "--once"] }), { platform: "linux", run });
  assert.ok(approver);
  await approver!();
  assert.deepEqual(calls, [{ bin: "/opt/approve.sh", args: ["--once"] }]);
});

test("validateApprove rejects bad specs", () => {
  for (const bad of ["yes", "", { command: [] }, { command: "x" }, { command: [1] }, {}] as unknown[])
    assert.throws(() => validateApprove(bad as never), /approve must be/);
  for (const ok of [true, false, "auto", "osascript", "xdotool", { command: ["x"] }] as unknown[])
    assert.doesNotThrow(() => validateApprove(ok as never));
});

test("approve is refused in personal mode (never auto-approve the operator's own Chrome)", () => {
  assert.throws(() => resolveOptions({ stateDir: "/tmp/ab-approve-p", allow: ["example.org"], mode: "personal", approve: true }), /only for the agent browser/);
  assert.throws(() => resolveOptions({ stateDir: "/tmp/ab-approve-p", allow: ["example.org"], mode: "personal", approve: "xdotool" }), /only for the agent browser/);
  assert.doesNotThrow(() => resolveOptions({ stateDir: "/tmp/ab-approve-p", allow: ["example.org"], mode: "personal", approve: false }));
  // defensive: makeApprover returns no approver for a personal-mode Settings even if one slipped through
  const personal = { ...base("osascript"), mode: "personal" as const };
  assert.equal(makeApprover(personal, { platform: "darwin" }), undefined);
});

test("approveArgs carries the setting to the proxy child, and the CLI parses it back", () => {
  assert.deepEqual(approveArgs(undefined), []);
  assert.deepEqual(approveArgs(false), []);
  assert.deepEqual(approveArgs(true), ["--approve", "auto"]);
  assert.deepEqual(approveArgs("xdotool"), ["--approve", "xdotool"]);
  assert.deepEqual(approveArgs({ command: ["x", "y"] }), ["--approve-command", '["x","y"]']);

  const parse = (flags: string[]) => optionsFromFlags(Object.fromEntries(flags.map((f, i, a) => f.startsWith("--") ? [f.slice(2), a[i + 1] ?? true] : [null, null]).filter(([k]) => k)) as Record<string, string | boolean>, () => {});
  assert.equal(parse(["--state-dir", "/tmp/ab-x", "--approve", "osascript"]).approve, "osascript");
  assert.equal(parse(["--state-dir", "/tmp/ab-x", "--approve", "auto"]).approve, "auto");
  assert.deepEqual(parse(["--state-dir", "/tmp/ab-x", "--approve-command", '["a","b"]']).approve, { command: ["a", "b"] });
  assert.equal(parse(["--state-dir", "/tmp/ab-x"]).approve, undefined);
  assert.throws(() => parse(["--state-dir", "/tmp/ab-x", "--approve", "nope"]), /--approve must be/);
});
