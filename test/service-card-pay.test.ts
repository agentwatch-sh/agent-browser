// The service's option of the card payment, `--card-pay` (contract C11, the card payment; C12, the card payments; board
// ab-sta.7, the plan's Task 5b): off by default, and agentwatch does not pass it. With it, on Linux, the hello has the
// feature card_pay, and with the native link, the lists and the Chrome unit the MCP path lists browser_pay and
// browser_pay_status for a local admission; without it everything stays as before. The service runs over the fake unit
// world (test/fake-unit-world.ts): no Chrome starts. Every value here is a made-up TEST value.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseStat } from "../src/relay/peer.ts";
import { readAllowList } from "../src/service/mcp/allow-list.ts";
import { serviceFeatures, SERVICE_USAGE } from "../src/service/main.ts";
import { PAY_TEXT } from "../src/service/pay/texts.ts";
import { tempDir } from "./temp-dirs.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const BIN = join(ROOT, "bin/agent-browser.js");
const LIST = readAllowList();
const runNode = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
  execFile(process.execPath, args, { cwd: ROOT, timeout: 30_000 }, (e, stdout, stderr) => resolve({ code: e ? (e as any).code ?? 1 : 0, stdout, stderr }));
});
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-client", version: "0" } } };
async function post(url: string, body: unknown, sid: string | null, headers: Record<string, string>): Promise<{ sid: string | null; body: any }> {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(sid ? { "Mcp-Session-Id": sid } : {}), ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const text = await r.text();
  return { sid: r.headers.get("mcp-session-id"), body: text ? JSON.parse(text) : null };
}

test("--card-pay on the command line: off by default; service --hello --card-pay has the feature card_pay next to sign_ins on Linux; it does not go with --fake, and no other command takes it", async () => {
  assert.deepEqual(serviceFeatures("linux"), ["sign_ins"], "off by default");
  assert.deepEqual(serviceFeatures("linux", true), ["sign_ins", "card_pay"]);
  assert.deepEqual(serviceFeatures("darwin", true), ["sign_ins"], "the Mac has the store (board ab-v16.97.15), and no card payment");
  assert.match(SERVICE_USAGE, / \[--card-pay\] /);
  const plain = await runNode([BIN, "service", "--hello"]);
  assert.equal(plain.code, 0, plain.stderr);
  assert.ok(!JSON.parse(plain.stdout).features.includes("card_pay"), "no card_pay without the option");
  const on = await runNode([BIN, "service", "--hello", "--card-pay"]);
  if (process.platform === "linux") {
    assert.equal(on.code, 0, on.stderr);
    assert.deepEqual(JSON.parse(on.stdout).features, ["sign_ins", "card_pay"]);
  } else {
    assert.equal(on.code, 2);
    assert.match(on.stderr, /--card-pay works only on Linux/);
  }
  for (const [args, what] of [
    [["service", "--fake", "--card-pay", "--control-door", "/x/c.sock"], /--card-pay does not go with --fake/],
    [["commands", "--card-pay"], /--card-pay is only for service/],
  ] as const) {
    const r = await runNode([BIN, ...args]);
    assert.equal(r.code, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, what, args.join(" "));
  }
});

test("the service's wiring (service.ts, by behaviour): with the option, the hello has card_pay and the MCP path lists browser_pay and browser_pay_status for a local admission (no Chrome start); a request before the act's model is ready gets the readiness's text; without the option, neither tool, no card_pay, no payment part", { skip: process.platform !== "linux", timeout: 90_000 }, async () => {
  const { startService } = await import("../src/service/service.ts");
  const { FakeTools, World } = await import("./fake-unit-world.ts");
  const token = "abt1_" + Buffer.from("test, not a token: the card payment's wiring", "latin1").toString("base64url");
  const self = parseStat(readFileSync(`/proc/${process.pid}/stat`, "latin1"))!;
  const auth = { Authorization: `Bearer ${token}` };
  const DAEMON = { kind: "daemon", user: "ann", via: "daemon" };
  for (const withPay of [true, false]) {
    const w = new World();
    const tools = new FakeTools();
    const dir = tempDir("ab-card-pay-svc-");
    mkdirSync(join(dir, "lists"));
    writeFileSync(join(dir, "lists", "owner.repo.json"), JSON.stringify({ allow: ["a.example"], repo: "owner/repo" }));
    const s = await startService({
      agentDoor: join(dir, "cdp.sock"), controlDoor: join(dir, "control.sock"), daemonCommand: join(dir, "daemon-command.json"), log: () => {}, mainPid: async () => null,
      lists: { listsFolder: join(dir, "lists"), stateFolder: w.paths.state },
      unit: { paths: w.paths, owner: async () => ({ active: "active", sub: "running", mainPid: process.pid }), tools, procs: w.procs, part: { unit: w.deps(tools), firstCheckMs: 3_600_000, usePollMs: 5 } },
      link: { socket: join(dir, "link.sock"), pidfds: { failed: "none" }, xdotool: null, peer: async () => ({ ok: true, pid: 4242 }) },
      mcp: { listen: { port: 0 } },
      signIns: { protections: () => null },
      ...(withPay ? { payAct: {} } : {}),
    } as any);
    try {
      assert.deepEqual((s.state.hello as any).features.filter((f: string) => f === "sign_ins" || f === "card_pay"), withPay ? ["sign_ins", "card_pay"] : ["sign_ins"]);
      const part = (s.state as any).parts.find((p: any) => "pay" in p && "store" in p);
      assert.ok(part, "the stored sign-ins' part");
      assert.equal(part.pay !== null, withPay, "the payment requests only with the option");
      await s.state.handle({ t: "req", id: "c", op: "config", by: { kind: "daemon", user: "ann", via: "config" }, enabled: true, control: true, chrome_bin: "/usr/bin/chromium", chrome_args: [] } as any);
      await s.state.handle({ t: "req", id: "s", op: "set_sessions", by: DAEMON, sessions: [{ scope: "web-1", repo: "owner/repo", roots: [{ pid: process.pid, start: self.start }], cgroup: null, lifetime_id: null, mcp_token: createHash("sha256").update(token, "latin1").digest("hex") }], remote: [], box: { hosts: [], cookie_names: [] } } as any);
      const url = `http://${(s.state.status() as any).mcp.address}/mcp/web-1`;
      const first = await post(url, INIT, null, auth);
      await post(url, { jsonrpc: "2.0", method: "notifications/initialized" }, first.sid, auth);
      const names: string[] = (await post(url, { jsonrpc: "2.0", id: 2, method: "tools/list" }, first.sid, auth)).body.result.tools.map((t: any) => t.name);
      assert.ok(names.length >= Object.keys(LIST.tools).length);
      // Board ab-t30.34: the press and hold last (the agent door's model has the input stage).
      if (withPay) assert.deepEqual(names.slice(-6), ["browser_sign_in", "browser_sign_ins", "PageFetch", "browser_pay", "browser_pay_status", "browser_press_hold"], "the payment act reaches the MCP path");
      else assert.ok(!names.includes("browser_pay") && !names.includes("browser_pay_status"), "no payment tool without the option");
      assert.equal(w.named("chromium").length, 0, "tools/list starts no Chrome");
      if (withPay) {
        // The model is not ready (no receiver): C11's check 1 gives the readiness's text, and no request starts.
        const r = await part.pay.open({ card: "travel", origin: "https://a.example", amount: "1.00", currency: "USD", description: "a test" }, { scope: "web-1", admission: "local" });
        assert.equal(r.state, "stopped");
        assert.match(r.text, /^The agent browser is not ready: /);
        assert.notEqual(r.text, PAY_TEXT.noWindow);
      }
    } finally { await s.stop(); w.close(); rmSync(dir, { recursive: true, force: true }); }
  }
});
