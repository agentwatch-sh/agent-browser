// Part "plain" of the sign-in provider probe (board task ab-v16.45). Not part of `npm test`. Where agent-browser's
// own guard blocks each sign-in flow without agent mode: no receiver (no DNR rules), no relay. agent-browser of this
// checkout drives a Chromium of the probe's own through its proxy (--endpoint). That Chromium has a debugging port on
// 127.0.0.1 in place of the operator's approval at chrome://inspect: the transport changes no guard of agent-browser
// (src/allowlist.ts, src/browser.ts: open, goto, the check before each command, PR #47's input guard).
//
//   RUN=<empty folder> node plain.ts
//
// Environment: CHROMIUM, DISPLAY_N (default 145), PORT (default 8461), DEBUG_PORT (default 9461). It starts its own
// Xvfb and Chromium, and agent-browser's proxy (stopped with agent-browser stop), and stops only those. It writes
// <RUN>/results.json.

import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DISPLAY_N, O, P, PORT, RUN, S, chromiumArgs, hitsSince, now, pids, sleep, startChromium, startXvfb, stopAll, xauth } from "./common.ts";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const DEBUG_PORT = Number(process.env.DEBUG_PORT ?? 9461);
const results: Record<string, unknown> = { part: "plain", port: PORT };
const cases: any[] = [];
const L1 = ["site.test"], L2 = ["site.test", "tenant.auth0.test"];

await startXvfb();
const PROFILE = join(RUN, "profile");
startChromium(chromiumArgs(PROFILE, [`--remote-debugging-port=${DEBUG_PORT}`, "--remote-debugging-address=127.0.0.1"]));
let ws = "";
for (let i = 0; i < 50 && !ws; i++) {
  try { const [port, path] = readFileSync(join(PROFILE, "DevToolsActivePort"), "utf8").trim().split("\n"); if (port && path) ws = `ws://127.0.0.1:${port}${path}`; } catch { /* not yet */ }
  if (!ws) await sleep(200);
}

async function rec(list: string, name: string, fn: () => Promise<any>) {
  const at = now();
  let detail: any, error: string | undefined;
  try { detail = await fn(); } catch (e) { error = String((e as Error)?.message ?? e).slice(0, 400); }
  const c = { group: "plain", list, case: name, ms: now() - at, detail, error, hits: hitsSince(at).map((h) => `${h.method} ${h.host}${h.path} sfs=${h.sfs} cookies=${h.cookies.join("+") || "-"}`) };
  cases.push(c);
  console.log(`plain ${list} ${name}: ${error ?? JSON.stringify(detail)}`.slice(0, 500));
}

try {
  if (!ws) throw new Error("no DevToolsActivePort");
  for (const [ln, list] of [["L1", L1], ["L2", L2]] as const) {
    const state = join(RUN, `ab-state-${ln}`), allow = join(RUN, `allow-${ln}.json`);
    mkdirSync(state, { recursive: true });
    writeFileSync(allow, JSON.stringify({ allow: list }));
    const cli = (...args: string[]) => new Promise<any>((res) => {
      execFile(process.execPath, [join(ROOT, "bin/agent-browser.js"), ...args, "--endpoint", ws, "--state-dir", state, "--allowlist", allow, "--proxy-idle-ms", "600000", "--json"],
        { encoding: "utf8", env: { ...process.env, DISPLAY: `:${DISPLAY_N}`, XAUTHORITY: xauth } }, (e, stdout, stderr) => {
          try { res(JSON.parse(stdout)); } catch { res({ ok: false, raw: (stdout || stderr || e?.message || "").slice(0, 300) }); }
        });
    });
    const short = (r: any) => (r?.ok === false || r?.error ? { error: r.error?.message ?? r.error ?? r.raw } : { ok: true, url: r?.tab?.url?.replace(`:${PORT}`, ""), text: r?.text, value: r?.value, tabs: r?.tabs?.map((t: any) => t.url.replace(`:${PORT}`, "")) });
    await cli("open", `${S}/logout`, "--name", "s");
    await rec(ln, "open site.test/ and click the sign-in link", async () => ({ goto: short(await cli("goto", "s", `${S}/`)), click: short(await cli("click", "s", "#signin-redirect")) }));
    await sleep(1200);
    await rec(ln, "text of the tab after the click (the tab is on the provider's page)", async () => ({ text: short(await cli("text", "s")), tabs: short(await cli("tabs")) }));
    await rec(ln, "choose an account and type on the provider's page", async () => ({
      account: short(await cli("click", "s", "#account-ada")), type: short(await cli("type", "s", "pw", "--into", "#password")), submit: short(await cli("click", "s", "#submit")),
    }));
    await sleep(1200);
    await rec(ln, "text after the sign-in", async () => ({ text: short(await cli("text", "s")) }));
    if (ln === "L1") {
      // The provider's session from a sign-in that the probe makes itself (agent-browser cannot drive it under L1): a
      // second consumer with L2 signs in, in the same Chromium, so that L1's silent redirect chain can be measured.
      const st2 = join(RUN, "ab-state-L1-helper"), al2 = join(RUN, "allow-helper.json");
      mkdirSync(st2, { recursive: true });
      writeFileSync(al2, JSON.stringify({ allow: L2 }));
      const helper = (...args: string[]) => new Promise<any>((res) => execFile(process.execPath, [join(ROOT, "bin/agent-browser.js"), ...args, "--endpoint", ws, "--state-dir", st2, "--allowlist", al2, "--proxy-idle-ms", "600000", "--json"],
        { encoding: "utf8", env: { ...process.env, DISPLAY: `:${DISPLAY_N}`, XAUTHORITY: xauth } }, (e, out) => { try { res(JSON.parse(out)); } catch { res({ ok: false }); } }));
      await rec(ln, "(helper, list L2) sign in at the provider so that its session exists", async () => {
        await helper("open", `${S}/login`, "--name", "h");
        await helper("click", "h", "#account-ada"); await helper("type", "h", "pw", "--into", "#password"); await helper("click", "h", "#submit");
        await sleep(1200);
        const t = short(await helper("text", "h"));
        await helper("goto", "h", `${S}/logout`);
        await helper("close", "h");
        await helper("stop");
        return t;
      });
      await rec(ln, "with the provider's session: click the sign-in link (a silent redirect chain through the provider)", async () => {
        const c = short(await cli("click", "s", "#signin-redirect").then(async (r) => (r?.ok === false ? (await cli("goto", "s", `${S}/`), cli("click", "s", "#signin-redirect")) : r)));
        await sleep(1500);
        return { click: c, text: short(await cli("text", "s")) };
      });
      await cli("goto", "s", `${S}/logout`);
    }
    await rec(ln, "goto site.test/app while signed out (the site redirects to the provider)", async () => ({ goto: short(await cli("goto", "s", `${S}/app`)), text: short(await cli("text", "s")) }));
    await cli("open", `${S}/`, "--name", "s");
    await rec(ln, "open the provider's page itself (the agent's own navigation)", async () => ({ open: short(await cli("open", `${P}/u/login`, "--name", "p")) }));
    await rec(ln, "eval location.href = the provider (the agent's script in the page)", async () => {
      const e = short(await cli("eval", "s", `location.href = ${JSON.stringify(`${P}/u/login`)}; 1`));
      await sleep(1200);
      return { eval: e, text: short(await cli("text", "s")) };
    });
    await cli("open", `${S}/`, "--name", "s");
    await rec(ln, "eval location.href = other.test (the agent's script in the page)", async () => {
      const e = short(await cli("eval", "s", `location.href = ${JSON.stringify(`${O}/eval`)}; 1`));
      await sleep(1200);
      return { eval: e, text: short(await cli("text", "s")) };
    });
    await cli("open", `${S}/`, "--name", "s");
    await rec(ln, "click the popup sign-in, then list the tabs", async () => {
      const c = short(await cli("click", "s", "#signin-popup"));
      await sleep(1500);
      return { click: c, tabs: short(await cli("tabs")) };
    });
    await rec(ln, "drive the popup on the provider's page (by its URL)", async () => ({
      account: short(await cli("click", "web_message", "#account-ada")), type: short(await cli("type", "web_message", "pw", "--into", "#password")), submit: short(await cli("click", "web_message", "#submit")),
    }));
    await sleep(1500);
    await rec(ln, "the opener's status after the popup", async () => ({ status: short(await cli("text", "s", "#status")) }));
    await rec(ln, "the agent's goto through the site's open redirect to other.test", async () => ({ goto: short(await cli("goto", "s", `${S}/redirect?to=${encodeURIComponent(O + "/x")}`)), text: short(await cli("text", "s")) }));
    await cli("open", `${S}/`, "--name", "s");
    await rec(ln, "a click on the site's link to other.test", async () => { const c = short(await cli("click", "s", "#offlist")); await sleep(1000); return { click: c, text: short(await cli("text", "s")) }; });
    await cli("open", `${P}/logout`, "--name", "x").catch(() => {});
    await rec(ln, "stop this consumer's proxy", async () => short(await cli("stop")));
  }
} catch (e) {
  results.aborted = String((e as Error)?.stack ?? e);
  console.error(results.aborted);
} finally {
  results.cases = cases;
  results.pids = pids;
  writeFileSync(join(RUN, "results.json"), JSON.stringify(results, null, 2) + "\n");
  await stopAll();
  console.log(`wrote ${join(RUN, "results.json")}`);
  process.exit(0);
}
