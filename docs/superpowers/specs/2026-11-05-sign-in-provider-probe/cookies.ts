// Part "cookies" of the sign-in provider probe (board task ab-v16.45). Not part of `npm test`. A silent renew in a
// frame needs the provider's own cookie in a third-party context. Does the frame's request carry it, with Chromium's
// default settings, and with each way that an extension can allow it? The probe extension (ext/) signs in at the
// provider at the top level (the provider sets auth0_session, SameSite=None, Secure), then opens the site and its
// hidden frame to /authorize?prompt=none, and reads what the provider got and what the frame posted back.
//
//   RUN=<empty folder> node cookies.ts
//
// Environment: CHROMIUM, DISPLAY_N (default 145), PORT (default 8461). It starts its own Xvfb and Chromium (with
// --remote-debugging-pipe; no port) and stops only those. It writes <RUN>/results.json.

import { cpSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { P, PORT, Pipe, RUN, S, chromiumArgs, hitsSince, now, pids, sleep, startChromium, startXvfb, stopAll } from "./common.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const results: Record<string, unknown> = { part: "cookies", port: PORT };
const cases: any[] = [];
cpSync(join(HERE, "ext"), join(RUN, "ext"), { recursive: true });
await startXvfb();
const chromium = startChromium(chromiumArgs(join(RUN, "profile"), [`--load-extension=${join(RUN, "ext")}`, "--remote-debugging-pipe"]), { pipe: true });
const pipe = new Pipe(chromium);
try {
  let worker = "";
  for (let i = 0; i < 50 && !worker; i++) {
    const { targetInfos } = await pipe.send("Target.getTargets");
    const sw = targetInfos.find((t: any) => t.type === "service_worker" && t.url.endsWith("/sw.js"));
    if (sw) worker = (await pipe.send("Target.attachToTarget", { targetId: sw.targetId, flatten: true })).sessionId;
    else await sleep(200);
  }
  const E = (expr: string) => pipe.evaluate(worker, expr);
  results.env = { version: (await pipe.send("Browser.getVersion")).product };
  results.defaultThirdPartyCookies = await E("thirdPartyCookies()");

  /** Sign in at the provider (top level), then the site's silent renew in a frame. */
  async function renew(label: string) {
    await E("clearCookies()");
    const tab: number = await E(`newTab(${JSON.stringify(S + "/")})`);
    await sleep(600);
    await E(`attach(${tab})`);
    await E(`click(${tab}, "#signin-redirect")`);
    await sleep(1200);
    await E(`click(${tab}, "#account-ada")`);
    await E(`click(${tab}, "#password")`);
    await E(`typeText(${tab}, "pw")`);
    await E(`click(${tab}, "#submit")`);
    await sleep(1500);
    await E(`cmd(${tab}, "Page.navigate", {url: ${JSON.stringify(S + "/")}})`);
    await sleep(800);
    const at = now();
    await E(`click(${tab}, "#silent")`);
    await sleep(1500);
    const status = await E(`frameResult(${tab})`);
    const frame = hitsSince(at).filter((h) => h.host === "tenant.auth0.test").map((h) => `${h.method} ${h.path} cookies=${h.cookies.join("+") || "-"} sfs=${h.sfs}`);
    const c = { case: label, status, frame, cookies: await E("cookies()") };
    cases.push(c);
    console.log(JSON.stringify(c).slice(0, 400));
    await E(`closeTab(${tab})`);
  }

  // The rules: the site and the provider both allowed at the top level (option c), so the sign-in can run.
  await E(`setRules(${JSON.stringify([
    { id: 1, priority: 1, action: { type: "block" }, condition: { resourceTypes: ["main_frame"] } },
    { id: 2, priority: 2, action: { type: "allow" }, condition: { requestDomains: ["site.test", "tenant.auth0.test"], resourceTypes: ["main_frame"] } },
  ])})`);
  await renew("Chromium's default settings");
  await E(`cookieSetting({primaryPattern: "https://tenant.auth0.test/*", secondaryPattern: "https://site.test/*", setting: "allow"})`);
  await renew("contentSettings.cookies: allow, primary the provider, secondary the site");
  await E("cookieSettingClear()");
  await E(`cookieSetting({primaryPattern: "<all_urls>", secondaryPattern: "https://site.test/*", setting: "allow"})`);
  await renew("contentSettings.cookies: allow, primary any URL, secondary the site (the site may use third-party cookies)");
  await E("cookieSettingClear()");
  results.setThirdPartyCookiesTrue = await E("setThirdPartyCookies(true)");
  await renew("chrome.privacy.websites.thirdPartyCookiesAllowed = true");
  results.setThirdPartyCookiesFalse = await E("setThirdPartyCookies(false)");
  await renew("chrome.privacy.websites.thirdPartyCookiesAllowed = false");
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
