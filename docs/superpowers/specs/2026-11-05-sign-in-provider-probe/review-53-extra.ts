// review-53's extra cases for the sign-in provider probe (PR #53). It uses the probe's common.ts, site.ts and ext/.
// Cases: navigations to the provider from pages with an opaque or extension-made origin, a meta refresh, a sandboxed
// frame's top navigation, and the receiver-style tabs.reload retry of a blocked popup. Each under today's rules and a_ext.
//   RUN=<empty folder> DISPLAY_N=... PORT=... node review-53-extra.ts
import { cpSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// The probe folder (review-53 ran it from its own worktree of this folder, with the same files).
const PROBE = fileURLToPath(new URL(".", import.meta.url));
const { O, P, PORT, Pipe, RUN, S, chromiumArgs, now, pids, sleep, startChromium, startXvfb, stopAll } = await import(join(PROBE, "common.ts"));

const results: Record<string, unknown> = { part: "review-53 extra", port: PORT };
const trials: any[] = [];
cpSync(join(PROBE, "ext"), join(RUN, "ext"), { recursive: true });
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
  const EXT_ID: string = await E("extId()");
  results.env = { version: (await pipe.send("Browser.getVersion")).product, extId: EXT_ID };
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
    a_ext: [...block, ...list(["site.test"]), ...provider(["site.test", "tenant.auth0.test", EXT_ID])],
  };
  const auth = `${P}/authorize?response_type=code&client_id=probe&redirect_uri=${encodeURIComponent(S + "/callback")}&state=st&response_mode=query`;
  const ev = (t: number, expr: string) => E(`cmd(${t}, "Runtime.evaluate", {expression: ${JSON.stringify(expr)}})`);
  const short = (u?: string) => { if (!u) return u; try { const x = new URL(u); return `${x.hostname}${x.pathname}`; } catch { return u.slice(0, 40); } };
  const initShort = (i?: string | null) => (i == null ? null : i.includes(EXT_ID) ? "ext" : i);

  type K = { name: string; setup: () => Promise<number>; run: (t: number) => Promise<unknown>; wait?: number; between?: () => Promise<void> };
  const KINDS: K[] = [
    { name: "data-page-script", setup: async () => { const t = await E(`newTab("about:blank")`); await sleep(400); await E(`attach(${t})`);
        await E(`cmd(${t}, "Page.navigate", {url: ${JSON.stringify("data:text/html,<p>data page</p>")}})`); await sleep(500); return t; },
      run: (t) => ev(t, `location.href = ${JSON.stringify(auth)}`) },
    { name: "blank-tab-script", setup: async () => { const t = await E(`newTab("about:blank")`); await sleep(400); await E(`attach(${t})`); return t; },
      run: (t) => ev(t, `location.href = ${JSON.stringify(auth)}`) },
    { name: "blank-window-script", setup: async () => { const w = await E(`newWindow("about:blank")`); await sleep(400); await E(`attach(${w.tabId})`); return w.tabId; },
      run: (t) => ev(t, `location.href = ${JSON.stringify(auth)}`) },
    { name: "listed-meta-refresh", setup: async () => { const t = await E(`newTab(${JSON.stringify(S + "/")})`); await sleep(700); await E(`attach(${t})`); return t; },
      run: (t) => ev(t, `(() => { const m = document.createElement("meta"); m.httpEquiv = "refresh"; m.content = "0;url=" + ${JSON.stringify(auth)}; document.head.appendChild(m); })()`), wait: 2000 },
    { name: "sandboxed-frame-top-nav", setup: async () => { const t = await E(`newTab(${JSON.stringify(S + "/")})`); await sleep(700); await E(`attach(${t})`); return t; },
      run: (t) => ev(t, `(() => { const f = document.createElement("iframe"); f.setAttribute("sandbox", "allow-scripts allow-top-navigation"); f.srcdoc = "<script>top.location.href = " + JSON.stringify(${JSON.stringify(auth)}) + "</scr" + "ipt>"; document.body.appendChild(f); })()`), wait: 2000 },
  ];

  for (const [setName, rules] of Object.entries(SETS)) {
    await E(`setRules(${JSON.stringify(rules)})`);
    for (const k of KINDS) {
      const out: any = { set: setName, kind: k.name };
      let tab: number | null = null;
      try {
        await E("clearCookies()");
        tab = await k.setup();
        await E("take()");
        out.call = await Promise.race([k.run(tab).then((r: any) => (r?.exceptionDetails ? `exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}` : "ok"), (e: Error) => `error: ${e.message}`), sleep(8000).then(() => "no answer")]);
        await sleep(k.wait ?? 1500);
        const evs: any[] = await E("take()");
        out.mainRequests = evs.filter((e) => e.ev === "request" && e.type === "main_frame").map((e) => `${short(e.url)} <- ${initShort(e.initiator)}`);
        out.blocked = evs.filter((e) => e.ev === "error" && e.error === "net::ERR_BLOCKED_BY_CLIENT").map((e) => `${e.type} ${short(e.url)}`);
        out.rules = evs.filter((e) => e.ev === "rule").map((e) => `${e.rule} ${short(e.url)} <- ${initShort(e.initiator)}`);
        out.committed = evs.filter((e) => e.ev === "nav.committed" && e.frameId === 0).map((e) => `${short(e.url)} ${e.transitionType}`);
        out.navErrors = evs.filter((e) => e.ev === "nav.error").map((e) => `${e.frameId} ${short(e.url)} ${e.error}`);
      } catch (e) { out.error = String((e as Error).message); }
      for (const t of await E("tabsNow()")) if (t.url !== "about:blank" || t.id === tab) await E(`closeTab(${t.id})`);
      trials.push(out);
      console.log(JSON.stringify(out));
    }
  }

  // The retry: a popup's first request blocked under today's rules, then the rules change to a_ext, then tabs.reload.
  for (const which of ["#signin-popup-url", "#signin-popup"]) {
    const out: any = { set: "today -> a_ext, then tabs.reload", kind: `retry ${which}` };
    await E(`setRules(${JSON.stringify(SETS.today)})`);
    await E("clearCookies()");
    const t = await E(`newTab(${JSON.stringify(S + "/")})`);
    await sleep(700);
    await E(`attach(${t})`);
    await E("take()");
    await E(`click(${t}, ${JSON.stringify(which)})`);
    await sleep(1500);
    const first: any[] = await E("take()");
    const popup = first.find((e) => e.ev === "tab.created")?.tabId;
    out.first = first.filter((e) => (e.ev === "request" || e.ev === "error") && e.type === "main_frame").map((e) => `${e.ev} ${short(e.url)} <- ${initShort(e.initiator)} ${e.error ?? ""}`);
    await E(`setRules(${JSON.stringify(SETS.a_ext)})`);
    if (popup !== undefined) {
      await E(`chrome.tabs.reload(${popup}).then(() => true)`);
      await sleep(1500);
      const second: any[] = await E("take()");
      out.reload = second.filter((e) => (e.ev === "request" || e.ev === "error") && e.type === "main_frame").map((e) => `${e.ev} ${short(e.url)} <- ${initShort(e.initiator)} ${e.error ?? ""}`);
      out.reloadCommitted = second.filter((e) => e.ev === "nav.committed" && e.frameId === 0).map((e) => `${short(e.url)} ${e.transitionType}`);
      out.reloadRules = second.filter((e) => e.ev === "rule").map((e) => `${e.rule} ${short(e.url)} <- ${initShort(e.initiator)}`);
    } else out.reload = "no popup";
    for (const x of await E("tabsNow()")) if (x.url !== "about:blank" || x.id === t) await E(`closeTab(${x.id})`);
    trials.push(out);
    console.log(JSON.stringify(out));
  }

  // The content setting pattern forms of the design's C5 text (choice 2 a): does the API take them, and does the frame's
  // silent renew then carry the provider's cookie?
  await E(`setRules(${JSON.stringify([...block, ...list(["site.test", "tenant.auth0.test"])])})`);
  results.defaultThirdPartyCookies = await E("thirdPartyCookies()");
  const { hitsSince } = await import(join(PROBE, "common.ts"));
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
    const frame = hitsSince(at).filter((h: any) => h.host === "tenant.auth0.test").map((h: any) => `${h.method} ${h.path} cookies=${h.cookies.join("+") || "-"}`);
    const c = { kind: "cookies", case: label, status, frame };
    trials.push(c);
    console.log(JSON.stringify(c));
    await E(`closeTab(${tab})`);
  }
  await renew("default");
  for (const [pp, sp] of [["https://[*.]tenant.auth0.test/*", "https://[*.]site.test/*"], ["https://*.tenant.auth0.test/*", "https://*.site.test/*"], ["https://*.auth0.test/*", "https://*.site.test/*"]]) {
    await E("cookieSettingClear()");
    const set = await E(`chrome.contentSettings.cookies.set({primaryPattern: ${JSON.stringify(pp)}, secondaryPattern: ${JSON.stringify(sp)}, setting: "allow"}).then(() => "ok", (e) => "error: " + e.message)`);
    trials.push({ kind: "cookies-pattern", primary: pp, secondary: sp, set });
    console.log(JSON.stringify({ primary: pp, secondary: sp, set }));
    await renew(`pattern ${pp} / ${sp}: ${set}`);
  }
  await E("cookieSettingClear()");
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
