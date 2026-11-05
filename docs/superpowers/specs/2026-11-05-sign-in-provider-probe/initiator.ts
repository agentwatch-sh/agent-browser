// Part "initiator" of the sign-in provider probe (board task ab-v16.45). Not part of `npm test`. Can the agent's own
// navigation be told from a site's? A probe extension (ext/, not the agent package) logs who starts each main-frame
// and frame request (webRequest's initiator, also over redirects), the DNR rule that decides it, the webNavigation
// transition, and the chrome.debugger events that the relay would see. It applies, one after the other, today's
// rules (C5 as agent package 0.2.0 writes them) and the candidate rules of the design's options a, b and c, and runs
// each kind of navigation under each.
//
//   RUN=<empty folder> node initiator.ts
//
// Environment: CHROMIUM (default /usr/bin/chromium), DISPLAY_N (default 145), PORT (default 8461), REPS (default 2),
// SETS and KINDS (comma lists: run only these).
// It starts its own Xvfb and Chromium (with --remote-debugging-pipe, so the probe can call the probe extension's
// worker; no port) and stops only those. Hosts: site.test, tenant.auth0.test, manage.auth0.test, other.test, all
// mapped to 127.0.0.1. It writes <RUN>/results.json.

import { execFile } from "node:child_process";
import { cpSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { M, O, P, PORT, Pipe, RUN, S, chromiumArgs, hitsSince, now, pids, sleep, startChromium, startXvfb, stopAll, xenv } from "./common.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPS = Number(process.env.REPS ?? 2);
const results: Record<string, unknown> = { part: "initiator", port: PORT };
const trials: any[] = [];

cpSync(join(HERE, "ext"), join(RUN, "ext"), { recursive: true });
await startXvfb();
const chromium = startChromium(chromiumArgs(join(RUN, "profile"), [`--load-extension=${join(RUN, "ext")}`, "--remote-debugging-pipe"]), { pipe: true });
const pipe = new Pipe(chromium);
const xdo = (...args: string[]) => new Promise<string>((res, rej) => execFile("xdotool", args, { env: xenv() }, (e, out) => (e ? rej(e) : res(out.trim()))));

let worker = "";
try {
  for (let i = 0; i < 50 && !worker; i++) {
    const { targetInfos } = await pipe.send("Target.getTargets");
    const sw = targetInfos.find((t: any) => t.type === "service_worker" && t.url.endsWith("/sw.js"));
    if (sw) worker = (await pipe.send("Target.attachToTarget", { targetId: sw.targetId, flatten: true })).sessionId;
    else await sleep(200);
  }
  if (!worker) throw new Error("no probe extension worker");
  const E = (expr: string) => pipe.evaluate(worker, expr);
  const EXT_ID: string = await E("extId()");
  results.env = { chromium: chromium.spawnfile, extId: EXT_ID, version: (await pipe.send("Browser.getVersion")).product };

  // ---------------------------------------------------------------- the rule sets
  const block = [
    { id: 1, priority: 1, action: { type: "block" }, condition: { resourceTypes: ["main_frame"] } },
    { id: 3, priority: 1, action: { type: "block" }, condition: { resourceTypes: ["sub_frame", "object"] } },
  ];
  const list = (d: string[]) => [
    { id: 2, priority: 2, action: { type: "allow" }, condition: { requestDomains: d, resourceTypes: ["main_frame"] } },
    { id: 4, priority: 2, action: { type: "allow" }, condition: { topDomains: d, resourceTypes: ["sub_frame", "object"] } },
  ];
  const provider = (initiators: string[]) => [
    { id: 10, priority: 2, action: { type: "allow" }, condition: { requestDomains: ["tenant.auth0.test"], initiatorDomains: initiators, resourceTypes: ["main_frame"] } },
    { id: 11, priority: 2, action: { type: "allow" }, condition: { topDomains: ["tenant.auth0.test"], resourceTypes: ["sub_frame", "object"] } },
  ];
  const SETS: Record<string, object[]> = {
    today: [...block, ...list(["site.test"])],
    a: [...block, ...list(["site.test"]), ...provider(["site.test", "tenant.auth0.test"])],
    a_ext: [...block, ...list(["site.test"]), ...provider(["site.test", "tenant.auth0.test", EXT_ID])],
    b: [...block, ...list(["site.test"]), { id: 12, priority: 2, action: { type: "allow" }, condition: { initiatorDomains: ["site.test"], resourceTypes: ["main_frame"] } }],
    b_any: [...block, ...list(["site.test"]), { id: 13, priority: 2, action: { type: "allow" }, condition: { excludedInitiatorDomains: [EXT_ID], resourceTypes: ["main_frame"] } }],
    c: [...block, ...list(["site.test", "tenant.auth0.test"])],
  };
  results.sets = SETS;

  // ---------------------------------------------------------------- the kinds of navigation
  const auth = (extra = "") => `${P}/authorize?response_type=code&client_id=probe&redirect_uri=${encodeURIComponent(S + "/callback")}&state=st&response_mode=query${extra}`;
  const targetOf = async (tab: number) => (await E(`cmd(${tab}, "Target.getTargetInfo")`)).targetInfo.targetId as string;
  const login = async (tab: number) => {
    await E(`click(${tab}, "#account-ada")`);
    await E(`click(${tab}, "#password")`);
    await E(`typeText(${tab}, "pw")`);
    await E(`click(${tab}, "#submit")`);
  };
  type Kind = { name: string; who: "agent" | "site" | "agent-in-page"; what: string; run: (tab: number) => Promise<unknown>; wait?: number; start?: string };
  const KINDS: Kind[] = [
    { name: "ext-navigate-site", who: "agent", what: "chrome.debugger Page.navigate (the relay's path) to a listed URL", run: (t) => E(`cmd(${t}, "Page.navigate", {url: ${JSON.stringify(S + "/app")}})`) },
    { name: "ext-navigate-site-redirect", who: "agent", what: "chrome.debugger Page.navigate to site.test/login, which redirects to the provider", run: (t) => E(`cmd(${t}, "Page.navigate", {url: ${JSON.stringify(S + "/login")}})`) },
    { name: "ext-navigate-provider", who: "agent", what: "chrome.debugger Page.navigate straight to the provider", run: (t) => E(`cmd(${t}, "Page.navigate", {url: ${JSON.stringify(auth())}})`) },
    { name: "ext-navigate-open-redirect", who: "agent", what: "chrome.debugger Page.navigate to site.test/redirect?to=other.test", run: (t) => E(`cmd(${t}, "Page.navigate", {url: ${JSON.stringify(`${S}/redirect?to=${encodeURIComponent(O + "/x")}`)}})`) },
    { name: "tabs-update-provider", who: "agent", what: "chrome.tabs.update(tab, {url: provider})", run: (t) => E(`updateTab(${t}, ${JSON.stringify(auth())})`) },
    { name: "tabs-create-provider", who: "agent", what: "chrome.tabs.create({url: provider})", run: () => E(`newTab(${JSON.stringify(auth())})`) },
    { name: "pipe-createTarget-provider", who: "agent", what: "Target.createTarget with the provider's URL on the browser's own CDP (plain agent-browser, a direct Playwright)", run: () => pipe.send("Target.createTarget", { url: auth() }) },
    { name: "pipe-navigate-provider", who: "agent", what: "Page.navigate to the provider on the browser's own CDP", run: async (t) => {
      const { sessionId } = await pipe.send("Target.attachToTarget", { targetId: await targetOf(t), flatten: true });
      return pipe.send("Page.navigate", { url: auth() }, sessionId);
    } },
    { name: "typed-provider", who: "agent", what: "a typed URL (xdotool: ctrl+L, the URL, Return)", run: async () => {
      const ids = (await xdo("search", "--onlyvisible", "--class", "chromium")).split("\n").filter(Boolean);
      const win = ids[ids.length - 1];
      await xdo("windowfocus", "--sync", win).catch(() => xdo("windowfocus", win));
      await xdo("key", "--window", win, "ctrl+l");
      await sleep(200);
      await xdo("type", "--delay", "5", auth());
      await xdo("key", "Return");
    }, wait: 2500 },
    { name: "click-link-provider", who: "agent-in-page", what: "a CDP click on the site's link that goes straight to the provider", run: (t) => E(`click(${t}, "#signin-direct")`) },
    { name: "click-link-redirect", who: "agent-in-page", what: "a CDP click on the site's link to /login (302 to the provider)", run: (t) => E(`click(${t}, "#signin-redirect")`) },
    { name: "eval-location-provider", who: "agent-in-page", what: "Runtime.evaluate location.href = the provider (the agent's script in the page)", run: (t) => E(`cmd(${t}, "Runtime.evaluate", {expression: ${JSON.stringify(`location.href = ${JSON.stringify(auth())}`)}})`) },
    { name: "eval-location-other", who: "agent-in-page", what: "Runtime.evaluate location.href = other.test", run: (t) => E(`cmd(${t}, "Runtime.evaluate", {expression: ${JSON.stringify(`location.href = ${JSON.stringify(O + "/eval")}`)}})`) },
    { name: "click-open-redirect", who: "agent-in-page", what: "a CDP click on the site's link through its open redirect to other.test", run: (t) => E(`click(${t}, "#open-redirect")`) },
    { name: "click-offlist-link", who: "agent-in-page", what: "a CDP click on the site's link to other.test", run: (t) => E(`click(${t}, "#offlist")`) },
    { name: "saml-post", who: "site", what: "the site's auto-submitted SAML form (POST to the provider), after a click on its link", run: (t) => E(`click(${t}, "#saml")`), wait: 2000 },
    { name: "popup-blank-then-location", who: "site", what: "a popup: window.open('') and then popup.location (auth0-spa-js)", run: (t) => E(`click(${t}, "#signin-popup")`), wait: 2000 },
    { name: "popup-url", who: "site", what: "a popup: window.open(url, name, 'popup')", run: (t) => E(`click(${t}, "#signin-popup-url")`), wait: 2000 },
    { name: "frame-silent-renew", who: "site", what: "a frame: the site's hidden iframe to /authorize?prompt=none", run: (t) => E(`click(${t}, "#silent")`), wait: 1500 },
    { name: "provider-login-post", who: "site", what: "the provider's own form POST (choose an account, a password), its 303 and the 302 back to the site", start: "provider",
      run: (t) => login(t), wait: 2500 },
    { name: "provider-link-other", who: "agent-in-page", what: "a CDP click on the provider page's link to other.test", start: "provider", run: (t) => E(`click(${t}, "#privacy")`) },
    { name: "provider-link-manage", who: "agent-in-page", what: "a CDP click on the provider page's link to manage.auth0.test", start: "provider", run: (t) => E(`click(${t}, "#manage")`) },
    { name: "provider-reload", who: "agent", what: "chrome.debugger Page.reload on the provider page", start: "provider", run: (t) => E(`cmd(${t}, "Page.reload")`) },
    { name: "provider-back", who: "agent", what: "chrome.debugger Page.navigateToHistoryEntry back to the provider page (from the site)", start: "provider-then-site", run: async (t) => {
      const h = await E(`cmd(${t}, "Page.getNavigationHistory")`);
      return E(`cmd(${t}, "Page.navigateToHistoryEntry", {entryId: ${h.entries[h.currentIndex - 1].id}})`);
    } },
  ];

  const short = (u: string | undefined) => { if (!u) return u; try { const x = new URL(u); return x.protocol === "chrome-extension:" ? "ext" : `${x.hostname}${x.pathname}`; } catch { return u.slice(0, 40); } };
  const initShort = (i: string | null | undefined) => (i == null ? null : i.startsWith("chrome-extension://") ? (i.includes(EXT_ID) ? "ext" : i) : (() => { try { return new URL(i).hostname; } catch { return i; } })());

  /** The tab at its start page, attached with chrome.debugger and Page.enable. */
  async function setUp(start: string | undefined, setName: string): Promise<number | null> {
    await E("clearCookies()");
    const tab: number = await E(`newTab(${JSON.stringify(S + "/")})`);
    await sleep(700);
    await E(`attach(${tab})`);
    if (start === "provider" || start === "provider-then-site") {
      await E(`click(${tab}, "#signin-redirect")`);
      await sleep(1200);
      const url = (await E(`cmd(${tab}, "Runtime.evaluate", {expression: "location.href", returnByValue: true})`)).result.value as string;
      if (!url.startsWith(P + "/u/login")) return null;
      if (start === "provider-then-site") { await E(`cmd(${tab}, "Page.navigate", {url: ${JSON.stringify(S + "/")}})`); await sleep(800); }
    }
    return tab;
  }

  const onlySets = process.env.SETS?.split(","), onlyKinds = process.env.KINDS?.split(",");
  for (const [setName, rules] of Object.entries(SETS)) {
    if (onlySets && !onlySets.includes(setName)) continue;
    await E(`setRules(${JSON.stringify(rules)})`);
    for (const kind of KINDS) {
      if (onlyKinds && !onlyKinds.includes(kind.name)) continue;
      // The initiator does not depend on the rules: the "today" set gets more repetitions of each kind.
      for (let rep = 0; rep < (setName === "today" ? REPS + 1 : REPS); rep++) {
        let tab: number | null = null;
        const at = now();
        const out: any = { set: setName, kind: kind.name, who: kind.who, rep };
        try {
          tab = await setUp(kind.start, setName);
          if (tab === null) { out.setup = "the provider page did not load under this set (blocked)"; trials.push(out); await E("take()"); continue; }
          await E("take()");
          const tStart = now();
          const r = await Promise.race([kind.run(tab).then(() => "ok", (e) => `error: ${(e as Error).message}`), sleep(8000).then(() => "no answer in 8 s")]);
          out.call = r;
          await sleep(kind.wait ?? 1300);
          const ev: any[] = await E("take()");
          const tabs = new Set<number>([tab, ...ev.filter((e) => e.ev === "tab.created").map((e) => e.tabId)]);
          out.events = ev.filter((e) => e.ev !== "completed" || e.type === "main_frame").map((e) => ({
            ev: e.ev, tab: e.tabId === tab ? "T" : e.tabId, type: e.type, method: e.method, url: short(e.url), to: short(e.to), initiator: initShort(e.initiator),
            rule: e.rule, error: e.error, status: e.status, transitionType: e.transitionType, qualifiers: e.transitionQualifiers?.length ? e.transitionQualifiers : undefined,
            cdp: e.method && e.ev === "cdp" ? e.method : undefined, reason: e.reason, disposition: e.disposition, navigationType: e.navigationType, frame: e.ev === "cdp" ? (e.main ? "main" : "child") : undefined,
            source: e.sourceTabId !== undefined ? (e.sourceTabId === tab ? "T" : e.sourceTabId) : undefined,
          }));
          out.hits = hitsSince(tStart).map((h) => `${h.method} ${h.host}${h.path} sfs=${h.sfs} sfu=${h.sfu ?? "-"} cookies=${h.cookies.join("+") || "-"}`);
          out.mainRequests = ev.filter((e) => e.ev === "request" && e.type === "main_frame").map((e) => ({ url: short(e.url), initiator: initShort(e.initiator), method: e.method, tab: e.tabId === tab ? "T" : "new" }));
          out.redirects = ev.filter((e) => e.ev === "redirect" && e.type === "main_frame").map((e) => ({ from: short(e.url), to: short(e.to), initiator: initShort(e.initiator) }));
          out.blocked = ev.filter((e) => e.ev === "error" && e.error === "net::ERR_BLOCKED_BY_CLIENT").map((e) => ({ url: short(e.url), type: e.type, initiator: initShort(e.initiator) }));
          out.rules = ev.filter((e) => e.ev === "rule").map((e) => ({ rule: e.rule, url: short(e.url), type: e.type, initiator: initShort(e.initiator) }));
          out.committed = ev.filter((e) => e.ev === "nav.committed").map((e) => ({ tab: e.tabId === tab ? "T" : "new", frame: e.frameId === 0 ? "main" : "sub", url: short(e.url), transitionType: e.transitionType, qualifiers: e.transitionQualifiers }));
          out.relaySees = ev.filter((e) => e.ev === "cdp" && (e.method === "Page.frameRequestedNavigation" || e.method === "Page.frameStartedNavigating")).map((e) => ({ m: e.method.replace("Page.", ""), url: short(e.url), reason: e.reason, disposition: e.disposition, navigationType: e.navigationType, frame: e.main ? "main" : "child" }));
          for (const id of tabs) await E(`closeTab(${id})`);
          // Popups and pipe targets that the log did not name (Target.createTarget), closed too.
          for (const t of await E("tabsNow()")) if (t.url !== "about:blank" || t.openerTabId) await E(`closeTab(${t.id})`);
        } catch (e) {
          out.error = String((e as Error).message ?? e);
          if (tab !== null) await E(`closeTab(${tab})`).catch(() => {});
        }
        out.ms = now() - at;
        trials.push(out);
        console.log(`${setName.padEnd(6)} ${kind.name.padEnd(28)} ${rep} main=${JSON.stringify(out.mainRequests?.map((m: any) => `${m.url}<-${m.initiator}`) ?? out.setup ?? out.error).slice(0, 220)} blocked=${JSON.stringify(out.blocked?.map((b: any) => b.url) ?? [])}`);
      }
    }
  }
} catch (e) {
  results.aborted = String((e as Error)?.stack ?? e);
  console.error(results.aborted);
} finally {
  results.trials = trials;
  results.pids = pids;
  writeFileSync(join(RUN, "results.json"), JSON.stringify(results, null, 2) + "\n");
  await stopAll();
  console.log(`wrote ${join(RUN, "results.json")}`);
  process.exit(0);
}
