// The test-only flag `--test-provider-origin` of `service --test --card-pay` (board ab-sta.8, the plan's Task 6: the live
// check of the card payment). The live check's service needs the test merchant's provider origin (`http://pay.localhost:
// <port>`, test/fixtures/pay-merchant/) in its PayRequests and its act; no flag set it before. It works only with --test
// and --card-pay, takes only a *.localhost origin, and never reaches the shipped list of provider origins.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { payActOption, SERVICE_USAGE, testProviderOrigin } from "../src/service/main.ts";
import { isProviderOrigin, PROVIDER_ORIGINS } from "../src/service/pay/providers.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const BIN = join(ROOT, "bin/agent-browser.js");
const runNode = (args: string[]) => new Promise<{ code: number | null; stderr: string }>((resolve) => {
  execFile(process.execPath, args, { cwd: ROOT, timeout: 30_000 }, (e, _stdout, stderr) => resolve({ code: e ? (e as any).code ?? 1 : 0, stderr }));
});

test("--test-provider-origin takes only an http or https origin of a host under .localhost, as the URL parser gives it", () => {
  for (const good of ["http://pay.localhost:8080", "https://pay.localhost", "http://a.b.localhost:41234"]) assert.equal(testProviderOrigin(good), good, good);
  for (const bad of ["", "pay.localhost", "http://localhost:8080", "http://.localhost", "https://js.stripe.com", "https://pay.localhost.example.com",
    "http://pay.localhost:8080/", "http://pay.localhost:8080/fields.html", "http://pay.localhost:8080?x=1", ["http://user", "pay.localhost:8080"].join("@") /* a user part */,
    "HTTP://PAY.localhost:8080", "ftp://pay.localhost", "http://127.0.0.1:8080", "http://pay.localhost:80"]) {
    assert.throws(() => testProviderOrigin(bad), /--test-provider-origin must be an origin of a host under \.localhost/, JSON.stringify(bad));
  }
  assert.match(SERVICE_USAGE, /\[--test-provider-origin ORIGIN\]\]/, "SERVICE_USAGE names it inside --test's part");
});

test("the payment act's option: the one test origin with the flag, none without it; the shipped list never holds it", () => {
  assert.deepEqual(payActOption(undefined), {});
  const o = payActOption("http://pay.localhost:8080");
  assert.deepEqual(o, { providerOrigins: ["http://pay.localhost:8080"] });
  assert.ok(Object.isFrozen(o.providerOrigins));
  assert.ok(!PROVIDER_ORIGINS.some((x) => x.includes("localhost")), "no test origin in the shipped list");
  assert.equal(isProviderOrigin("http://pay.localhost:8080"), false, "the shipped list alone does not take it");
  assert.equal(isProviderOrigin("http://pay.localhost:8080", o.providerOrigins), true, "the run's option does");
  // main.ts: the flag's origin only in --test with --card-pay, and only through payActOption into the payment act.
  const main = readFileSync(join(ROOT, "src/service/main.ts"), "utf8");
  assert.match(main, /const providerOrigin = test && cardPay && str\("test-provider-origin"\) !== undefined \? testProviderOrigin\(str\("test-provider-origin"\)!\) : undefined;/);
  assert.match(main, /\.\.\.\(cardPay && memory \? \{ payAct: payActOption\(providerOrigin\) \} : \{\}\),/);
});

test("--test-provider-origin on the command line: only with --test, only with --card-pay, only for service", async () => {
  for (const [args, what] of [
    [["service", "--agent-door", "/x/cdp.sock", "--card-pay", "--test-provider-origin", "http://pay.localhost:8080"], /--test-provider-origin goes with --test$/m],
    [["service", "--hello", "--card-pay", "--test-provider-origin", "http://pay.localhost:8080"], /--test-provider-origin goes with --test$/m],
    [["service", "--test", "--agent-door", "/x/cdp.sock", "--test-provider-origin", "http://pay.localhost:8080"], /--test-provider-origin goes with --card-pay$/m],
    [["commands", "--test-provider-origin", "http://pay.localhost:8080"], /--test-provider-origin is only for service/],
  ] as const) {
    const r = await runNode([BIN, ...args]);
    assert.equal(r.code, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, what, args.join(" "));
  }
});
