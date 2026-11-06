// The live check of the agent pointer design (board ab-v16.71; docs/superpowers/specs/2026-11-06-agent-pointer-move-design.md,
// section 7): the group `pointer` of the agent-mode live test (run.ts), in the harness's own private Xvfb, through the
// real relay and the stand-in daemon, whose daemon.movePointer plays each path with xdotool on that Xvfb only
// (pointer-ops.ts). Its pages are the anti-detect probe's page (test/live/anti-detect/probe.ts), which logs every
// pointer event with its movement, its screen point and its time. The cases:
//
// - agent-browser's commands over --cdp-url (the probe's `design`): two pages in two windows in turn, 3 rounds; and
//   `design-two`: two agents at once, one input lock, 3 commands each;
// - Playwright: one client, two pages in two windows in turn, 3 rounds;
// - review-63b's two-client case: client A clicks in its page while client B activates another page (A's page counted
//   apart: jumps, and presses away from the last move); a catch-up in the front page while another client activates
//   (review-63c B2); one client holds a press (3 s: the limit; 0.5 s) while the other activates; a page whose mousemove
//   handler opens a dialog (the step's limit, and a far catch-up that stops at 4 unanswered moves); an active tab's
//   Target.activateTarget;
// - a focused window under a newer unfocused window (does the raise bring it up; does a CDP press raise it);
// - the mapping and the clamp: a vertical and a horizontal scrollbar, a target near the display's edge, a popup of
//   another size, a moved window, a device-metrics override;
// - the counts in both pages and the measure of `xdotool sleep` (the dt that the page saw against the planned dt).
//
// The pass mark (section 7): after each page's first activation, 0 jumps and 0 unexplained changes in both pages of
// each activation, 0 zero-movement moves in each path, the leaving page's moves like the person's (each with movement,
// none over 50 px), and in the two-client case 0 jumps and 0 presses away from the last move in A's page. A position
// change in the activation of a step with no path is as today (one at most: section 5) and is counted apart.

import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { page as probePage, type Rec } from "../anti-detect/probe.ts";
import type { StandInDaemon } from "./daemon.ts";
import type { Played } from "./pointer-ops.ts";
import { leavingPages, movesOf, movesWhileHeld, noPath, pageCounts, played as playedStep, pressesAway, stats, stepLine, type StepLine } from "./pointer-measure.ts";

export type PointerContext = {
  daemon: StandInDaemon; url: (scope: string) => string; run: string; relayBin: string; pw: any; WebSocket: any;
  record: (r: { group: string; case: string; status: "pass" | "fail" | "skip"; ms: number; detail?: unknown; error?: string; why?: string }) => void;
  relayLines: { t: number; line: string }[]; display: string; xauth: string; tracked: (c: any) => any;
};

const G = "pointer";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The probe pages, with the probe's /log: /p (the probe page), /wide (a horizontal scrollbar too), /dialog (a mousemove handler that opens an alert once armed). */
function probeServer(log: Rec[]): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (req.method === "POST" && u.pathname === "/log") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => { try { log.push(JSON.parse(body)); } catch { /* not ours */ } res.writeHead(204).end(); });
      return;
    }
    const tab = u.searchParams.get("tab") ?? "x";
    const extra = u.pathname === "/wide" ? '<div style="position:absolute;left:0;top:30px;width:3200px;height:4px;background:#ccc"></div>'
      : u.pathname === "/dialog" ? "<script>document.addEventListener('mousemove', () => { if (window.__arm) { window.__arm = false; alert('hover'); } }, true);</script>" : "";
    if (!["/p", "/wide", "/dialog"].includes(u.pathname)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" }).end(probePage(tab) + extra);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, port: (server.address() as { port: number }).port })));
}

export async function pointerCases(o: PointerContext): Promise<void> {
  const log: Rec[] = [];
  const { server, port } = await probeServer(log);
  const P = `http://probe.a.localhost:${port}`;
  const pageUrl = (tab: string, kind = "p") => `${P}/${kind}?tab=${tab}`;
  const out: Record<string, unknown> = {};
  const loaded = async (tab: string) => {
    for (const end = Date.now() + 15_000; Date.now() < end; await sleep(100)) if (log.some((e) => e.tab === tab && e.ev === "load")) return;
    throw new Error(`page ${tab} did not load`);
  };
  const tabIds = new Map<string, number>();
  const tabIdOf = async (tab: string) => {
    if (!tabIds.has(tab)) {
      const t = (await o.daemon.ask("debugger.getTargets")).find((x: any) => String(x.url).includes(`tab=${tab}`));
      if (t) tabIds.set(tab, t.tabId);
    }
    return tabIds.get(tab);
  };
  const steps = () => o.relayLines.map((l) => stepLine(l.t, l.line)).filter((s): s is StepLine => !!s);
  const plays = (from: number, to: number) => o.daemon.played().filter((p) => p.startedAt >= from && p.startedAt <= to);
  /** The window under the X pointer, on the harness's own Xvfb only: its name (the page's title and the browser's). */
  const windowAtPointer = () => new Promise<string>((resolve) => {
    const env = { DISPLAY: o.display, XAUTHORITY: o.xauth };
    o.tracked(execFile("/usr/bin/xdotool", ["getmouselocation"], { env }, (e, out) => {
      const id = /window:(\d+)/.exec(String(out))?.[1];
      if (e || !id) { resolve(""); return; }
      o.tracked(execFile("/usr/bin/xdotool", ["getwindowname", id], { env }, (_e, name) => resolve(String(name).trim())));
    }));
  });
  const allDt: { seen: number; planned: number }[] = [];
  const caseOut: any[] = [];

  /**
   * The counts of a case over [t0, t1] for its pages (section 7), and the pass mark: each page is counted from the end of
   * its first activation on; an unexplained change right after a step with no path is as today and is counted apart.
   */
  const measure = async (name: string, pages: string[], t0: number, t1: number,
    o2: { twoClient?: string; own?: Record<string, { x: number; y: number }[]>; extra?: (d: any) => string[]; detail?: object } = {}) => {
    await sleep(800); // the probe's batches (250 ms) and the late beacons
    const all = steps();
    const per: Record<string, any> = {};
    const fails: string[] = [];
    const ps = plays(t0, t1);
    const leaving = leavingPages(log, pages, ps);
    for (const tab of pages) {
      const id = await tabIdOf(tab);
      const acts = all.filter((s) => s.tab === id);
      const first = acts[0];
      const from = Math.max(t0, (first?.t ?? t0) + 400);
      const c = pageCounts(log, tab, from, t1 + 300, acts.filter((s) => s.t >= from).map((s) => s.t - s.ms), ps.filter((p) => leaving.get(p) === tab), o2.own?.[tab] ?? []);
      // A jump or an unexplained change of a page in the second after its own step with no path: that activation is as
      // today (it enters at the X pointer; section 5), counted apart.
      const asToday = countAsToday(log, tab, from, t1 + 300, all.filter((s) => s.tab === id && noPath(s) && /no path/.test(s.what)), o2.own?.[tab] ?? []);
      per[tab] = { ...c, dt: undefined, asToday, activations: acts.filter((s) => s.t >= t0 && s.t <= t1 + 300).map((s) => `${s.kind} ${playedStep(s) ? "path" : s.what.replace(/^no path \((.*)\)$/, "no path: $1")} ${s.ms} ms`) };
      allDt.push(...c.dt);
      if (c.jumps - asToday.jumps > 0) fails.push(`${tab}: ${c.jumps - asToday.jumps} jumps`);
      if (c.unexplained - asToday.unexplained > 0) fails.push(`${tab}: ${c.unexplained - asToday.unexplained} unexplained changes`);
      if (c.zeroMovement) fails.push(`${tab}: ${c.zeroMovement} zero-movement moves in the paths that it saw`);
      if (o2.twoClient === tab) {
        per[tab].pressesAway = pressesAway(log, tab, from, t1 + 300);
        if (per[tab].pressesAway) fails.push(`${tab}: ${per[tab].pressesAway} presses away from the last move`);
      }
    }
    const okPlays = ps.filter((p) => p.answer === "ok");
    const stepsIn = all.filter((s) => s.t >= t0 && s.t <= t1 + 300 && (s.kind !== "input" || !/no page comes under the pointer/.test(s.what)));
    const detail = { pages: per, played: okPlays.length, playedOther: ps.length - okPlays.length, steps: stepsIn.length, stepsWithPath: stepsIn.filter(playedStep).length,
      stepMs: stats(stepsIn.map((s) => s.ms)), pathStepMs: stats(stepsIn.filter(playedStep).map((s) => s.ms)), ...(o2.detail ?? {}) };
    fails.push(...(o2.extra?.(detail) ?? []));
    caseOut.push({ name, ...detail });
    o.record({ group: G, case: name, status: fails.length ? "fail" : "pass", ms: t1 - t0, detail: { fails, played: detail.played, steps: detail.steps, stepsWithPath: detail.stepsWithPath,
      counts: Object.fromEntries(Object.entries(per).map(([k, v]) => [k, { jumps: v.jumps, unexplained: v.unexplained, asToday: v.asToday, ownRaw: v.ownRaw, zero: v.zeroMovement, pathMoves: v.pathMoves, maxMove: v.maxPathMovement }])) },
      ...(fails.length ? { why: fails.join("; ") } : {}) });
  };

  // ---------------------------------------------------------------- the cases
  const cliState = join(o.run, "ptr-state"), allow = join(o.run, "ptr-allow.json");
  writeFileSync(allow, JSON.stringify({ allow: ["a.localhost"] }));
  /** agent-browser's CLI over --cdp-url, with no DISPLAY (over the relay agent-browser reaches no X). */
  const cli = (scope: string, ...args: string[]) => new Promise<any>((resolve) => {
    const env = { ...process.env };
    delete env.DISPLAY; delete env.XAUTHORITY;
    o.tracked(execFile(process.execPath, [o.relayBin, ...args, "--cdp-url", o.url(scope), "--state-dir", cliState, "--allowlist", allow, "--no-launch", "--json"], { encoding: "utf8", env, timeout: 60_000 }, (e, stdout) => {
      try { resolve(JSON.parse(stdout)); } catch { resolve({ ok: false, error: { message: e?.message ?? "no output" } }); }
    }));
  });
  const must = async (what: string, p: Promise<any>) => { const r = await p; if (r?.ok === false) throw new Error(`${what}: ${JSON.stringify(r.error).slice(0, 200)}`); return r; };
  const guard = async (name: string, fn: () => Promise<void>) => {
    const t0 = Date.now();
    try { await fn(); } catch (e) { o.record({ group: G, case: name, status: "fail", ms: Date.now() - t0, error: String((e as Error)?.message ?? e).split("\n")[0].slice(0, 300) }); }
  };

  try {
    // agent-browser's commands (the probe's design): two pages in two windows in turn, 3 rounds, each command activates its page.
    await guard("agent-browser over --cdp-url (design): two pages in two windows in turn, 3 rounds", async () => {
      await must("open ab1", cli("ptr-ab", "open", pageUrl("AB1"), "--name", "ab1"));
      await must("open ab2", cli("ptr-ab", "open", pageUrl("AB2"), "--name", "ab2"));
      await loaded("AB1"); await loaded("AB2");
      const t0 = Date.now();
      for (let r = 0; r < 3; r++) for (const name of ["ab1", "ab2"]) {
        await must(`click ${name}`, cli("ptr-ab", "click", name, r === 1 ? "#r" : "#b"));
        await sleep(300);
      }
      await must("type ab1", cli("ptr-ab", "type", "ab1", "hi", "--into", "#f"));
      await must("type ab2", cli("ptr-ab", "type", "ab2", "hi", "--into", "#f"));
      const t1 = Date.now();
      await measure("agent-browser over --cdp-url (design): two pages in two windows in turn, 3 rounds", ["AB1", "AB2"], t0, t1,
        { extra: (d) => (d.stepsWithPath < 4 ? [`only ${d.stepsWithPath} steps with a path`] : []) });
    });
    await guard("agent-browser over --cdp-url (design-two): two agents at once, one input lock", async () => {
      await must("open tw1", cli("ptr-ab", "open", pageUrl("TW1"), "--name", "tw1"));
      await must("open tw2", cli("ptr-ab", "open", pageUrl("TW2"), "--name", "tw2"));
      await loaded("TW1"); await loaded("TW2");
      const t0 = Date.now();
      const agent = async (name: string, delay: number) => { await sleep(delay); for (let i = 0; i < 3; i++) { await must(`type ${name}`, cli("ptr-ab", "type", name, "ab", "--into", "#f")); await sleep(200 + Math.round(Math.random() * 300)); } };
      await Promise.all([agent("tw1", 0), agent("tw2", 400)]);
      const t1 = Date.now();
      await measure("agent-browser over --cdp-url (design-two): two agents at once, one input lock", ["TW1", "TW2"], t0, t1,
        { extra: (d) => (d.stepsWithPath < 3 ? [`only ${d.stepsWithPath} steps with a path`] : []) });
    });
    for (const name of ["ab1", "ab2", "tw1", "tw2"]) await cli("ptr-ab", "close", name);

    // Playwright: one client, two pages in two windows, in turn, 3 rounds (its own raw moves: one move to each target).
    await guard("Playwright: two pages in two windows in turn, 3 rounds", async () => {
      const browser = await o.pw.chromium.connectOverCDP(o.url("ptr-pw"), { timeout: 20_000 });
      try {
        const ctx = browser.contexts()[0];
        const p1 = await ctx.newPage(), p2 = await ctx.newPage();
        await p1.goto(pageUrl("PW1")); await p2.goto(pageUrl("PW2"));
        await loaded("PW1"); await loaded("PW2");
        const t0 = Date.now();
        // Each page's own points (Playwright's mouse.click: one raw move to the point, then the press that activates the page).
        const own = { PW1: [{ x: 70, y: 280 }, { x: 400, y: 200 }, { x: 600, y: 420 }], PW2: [{ x: 300, y: 350 }, { x: 120, y: 345 }, { x: 500, y: 150 }] };
        for (let r = 0; r < 3; r++) for (const [p, tab] of [[p1, "PW1"], [p2, "PW2"]] as const) { const q = own[tab][r]; await p.mouse.click(q.x, q.y); await sleep(300); }
        const t1 = Date.now();
        await measure("Playwright: two pages in two windows in turn, 3 rounds", ["PW1", "PW2"], t0, t1, { own, extra: (d) => (d.stepsWithPath < 4 ? [`only ${d.stepsWithPath} steps with a path`] : []) });
      } finally { await browser.close().catch(() => {}); }
    });

    // Two clients: A clicks in its page while B activates another page (review-63b); a catch-up in the front page while
    // the other client activates (review-63c B2); a held press; the hover dialog; an active tab's Target.activateTarget.
    const a = await o.pw.chromium.connectOverCDP(o.url("ptr-a"), { timeout: 20_000 });
    const b = await o.pw.chromium.connectOverCDP(o.url("ptr-b"), { timeout: 20_000 });
    try {
      const pa = await a.contexts()[0].newPage(), pb = await b.contexts()[0].newPage();
      await pa.goto(pageUrl("CA")); await pb.goto(pageUrl("CB"));
      await loaded("CA"); await loaded("CB");
      await guard("two clients: A clicks in its page while B activates another page (A's page: 0 jumps, 0 presses away from the last move)", async () => {
        const t0 = Date.now();
        const spots = [[70, 280], [400, 300], [120, 345], [600, 420]];
        await Promise.all([
          (async () => { for (let i = 0; i < 4; i++) { await pa.mouse.click(spots[i][0], spots[i][1]); await sleep(150 + Math.round(Math.random() * 300)); } })(),
          (async () => { await sleep(120); for (let i = 0; i < 4; i++) { await pb.mouse.click(spots[3 - i][0], spots[3 - i][1]); await sleep(150 + Math.round(Math.random() * 300)); } })(),
        ]);
        const t1 = Date.now();
        const own = Object.fromEntries(["CA", "CB"].map((t) => [t, spots.map(([x, y]) => ({ x, y }))]));
        await measure("two clients: A clicks in its page while B activates another page (A's page: 0 jumps, 0 presses away from the last move)", ["CA", "CB"], t0, t1, { twoClient: "CA", own });
      });
      await guard("a catch-up in the front page while another client activates (review-63c B2): the step waits for it", async () => {
        await pb.mouse.click(600, 420); // B's page in front
        await pa.bringToFront(); // a path from B's page to A's: A's point is an X record
        await sleep(300);
        const t0 = Date.now();
        await Promise.all([pa.mouse.move(1100, 650), (async () => { await sleep(150); await pb.mouse.click(300, 300); })()]);
        const t1 = Date.now();
        await measure("a catch-up in the front page while another client activates (review-63c B2): the step waits for it", ["CA", "CB"], t0, t1,
          { own: { CA: [{ x: 1100, y: 650 }], CB: [{ x: 300, y: 300 }, { x: 600, y: 420 }] } });
      });
      for (const holdMs of [3000, 500]) {
        const name = `one client holds a press for ${holdMs / 1000} s while the other activates: no real move between its mousedown and mouseup`;
        await guard(name, async () => {
          await pa.mouse.move(200, 300);
          await pa.mouse.down(); // A's page comes forward and holds its button
          const t0 = Date.now();
          await Promise.all([(async () => { await sleep(holdMs); await pa.mouse.up(); })(), (async () => { await sleep(200); await pb.mouse.click(500, 250); })()]);
          const t1 = Date.now();
          const held = movesWhileHeld(log, "CA", t0 - 500, t1 + 500);
          const cb = await tabIdOf("CB");
          const lines = steps().filter((s) => s.t >= t0 && s.t <= t1 + 300 && s.tab === cb);
          await measure(name, ["CA", "CB"], t0, t1, { own: { CA: [{ x: 200, y: 300 }], CB: [{ x: 500, y: 250 }, { x: 300, y: 300 }] }, detail: { movesWhileHeld: held, bStep: lines.map((s) => `${s.what} ${s.ms} ms`) },
            extra: () => [...(held ? [`${held} real moves between CA's mousedown and mouseup`] : []),
              ...(holdMs > 2000 && !lines.some((s) => /step 3 reached its limit/.test(s.what)) ? ["B's step did not end at step 3's limit"] : []),
              ...(holdMs < 2000 && !lines.some(playedStep) ? ["B's step played no path after A's release"] : [])] });
        });
      }
      await guard("an active tab's Target.activateTarget: no path", async () => {
        const n = o.daemon.played().length;
        const s = await a.contexts()[0].newCDPSession(pa);
        const { targetInfo } = await s.send("Target.getTargetInfo");
        await pa.mouse.click(200, 200); // A's page in front, its tab active
        const m = o.daemon.played().length;
        const raw = await rawCdp(o.WebSocket, o.url("ptr-a"));
        try { await raw.send("Target.activateTarget", { targetId: targetInfo.targetId }); } finally { raw.close(); }
        await sleep(300);
        const after = o.daemon.played().length;
        o.record({ group: G, case: "an active tab's Target.activateTarget: no path", status: after === m ? "pass" : "fail", ms: 0, detail: { playedBefore: n, beforeActivate: m, after } });
      });
      // The hover dialog: a page whose mousemove handler opens a dialog holds that move's answer while the dialog is open.
      await guard("a page whose mousemove handler opens a dialog: the step ends at its limit with no path; a far catch-up into it stops at 4 unanswered moves and lets the client close the dialog", async () => {
        const pd = await a.contexts()[0].newPage();
        await pd.goto(pageUrl("DLG", "dialog"));
        await loaded("DLG");
        let dialogs = 0;
        pd.on("dialog", async (d: any) => { dialogs++; await sleep(2600); await d.dismiss().catch(() => {}); });
        await pd.mouse.click(60, 60); // the dialog page in front
        await pd.evaluate(() => { (window as any).__arm = true; });
        const t0 = Date.now();
        const held = pd.mouse.move(80, 70); // its answer comes after the dialog closes
        await sleep(150);
        const tb = Date.now();
        await pb.mouse.click(400, 400); // B's step: the front page's move has no answer
        const bMs = Date.now() - tb;
        await held;
        const stepB = steps().filter((s) => s.t >= tb && s.tab === tabIds.get("CB")).at(0);
        // The far catch-up: the dialog page comes forward by a path (its point an X record), then a move 1000 px away.
        await pd.bringToFront();
        await pd.evaluate(() => { (window as any).__arm = true; });
        const stops0 = o.relayLines.filter((l) => /stopped at 4 unanswered moves/.test(l.line)).length;
        const tc = Date.now();
        await pd.mouse.move(1150, 700);
        const moveMs = Date.now() - tc;
        await sleep(500);
        const stops = o.relayLines.filter((l) => /stopped at 4 unanswered moves/.test(l.line)).length - stops0;
        const t1 = Date.now();
        const value = await pd.evaluate(() => 1).catch(() => null);
        o.record({ group: G, case: "a page whose mousemove handler opens a dialog: the step ends at its limit with no path; a far catch-up into it stops at 4 unanswered moves and lets the client close the dialog",
          // The far catch-up: Chromium answers the moves after the one whose handler opened the dialog, so it stops only when 4 have no answer.
          status: stepB && /pointer input in flight has no answer/.test(stepB.what) && bMs >= 1900 && dialogs === 2 && value === 1 && moveMs < 5000 ? "pass" : "fail", ms: t1 - t0,
          detail: { bStep: stepB ? `${stepB.what} ${stepB.ms} ms` : null, bClickMs: bMs, catchUpStops: stops, dialogs, farMoveMs: moveMs, pageAnswers: value === 1 } });
        await pd.close().catch(() => {});
      });
    } finally { await a.close().catch(() => {}); await b.close().catch(() => {}); }

    // A focused window under a newer unfocused window; and a CDP press into it with no activation (the stand-in's own bridge request).
    await guard("a focused window under a newer unfocused window: the raise brings it up", async () => {
      const c = await o.pw.chromium.connectOverCDP(o.url("ptr-raise"), { timeout: 20_000 });
      try {
        const r1 = await c.contexts()[0].newPage();
        await r1.goto(pageUrl("R1")); await loaded("R1");
        await r1.mouse.click(300, 300); // R1 focused and in front
        const r2 = await c.contexts()[0].newPage();
        await r2.goto(pageUrl("R2")); await loaded("R2");
        await sleep(500);
        const before = await windowAtPointer();
        await r1.mouse.click(320, 310); // R1 is focused, under R2's newer window
        await sleep(300);
        const after = await windowAtPointer();
        // A CDP press into R1 while a newer window R3 covers it, with no activation of the relay.
        const r3 = await c.contexts()[0].newPage();
        await r3.goto(pageUrl("R3")); await loaded("R3");
        await sleep(500);
        const under = await windowAtPointer();
        const id = await tabIdOf("R1");
        for (const type of ["mousePressed", "mouseReleased"]) await o.daemon.ask("debugger.sendCommand", [{ tabId: id }, "Input.dispatchMouseEvent", { type, x: 330, y: 320, button: "left", clickCount: 1 }]);
        await sleep(300);
        const cdpPress = await windowAtPointer();
        const raised = /probe R1/.test(after);
        o.record({ group: G, case: "a focused window under a newer unfocused window: the raise brings it up", status: /probe R2/.test(before) && raised ? "pass" : "fail", ms: 0,
          detail: { before, afterRaise: after, beforeCdpPress: under, afterCdpPressWithNoActivation: cdpPress, chromeRaisesForACdpPress: /probe R1/.test(cdpPress) } });
      } finally { await c.close().catch(() => {}); }
    });

    // The mapping and the clamp.
    await guard("the mapping and the clamp: scrollbars, the display's edge, a popup of another size, a moved window, a device-metrics override", async () => {
      const c = await o.pw.chromium.connectOverCDP(o.url("ptr-map"), { timeout: 20_000 });
      try {
        const ctx = c.contexts()[0];
        const v = await ctx.newPage(), w = await ctx.newPage();
        await v.goto(pageUrl("MV")); await w.goto(pageUrl("MW", "wide"));
        await loaded("MV"); await loaded("MW");
        // The content's size (innerWidth less the vertical scrollbar, innerHeight less the horizontal one).
        const size = (p: any) => p.evaluate(() => [document.documentElement.clientWidth, document.documentElement.clientHeight, innerWidth, innerHeight]);
        const vs = await size(v), ws = await size(w);
        const own: Record<string, { x: number; y: number }[]> = { MV: [], MW: [], MP: [] };
        const clickAt = async (p: any, tab: string, x: number, y: number) => { own[tab].push({ x, y }); await p.mouse.click(x, y); await sleep(300); };
        const t0 = Date.now();
        // A vertical scrollbar (the probe page is 7000 px high): a target 4 px left of it; a horizontal one (the wide page): 4 px above it.
        await clickAt(v, "MV", vs[0] - 4, 300);
        await clickAt(w, "MW", 300, ws[1] - 4);
        await clickAt(v, "MV", 300, 300);
        // Targets near the display's edge: 3 px inside the content's bottom right corner.
        await clickAt(w, "MW", ws[0] - 3, ws[1] - 3);
        await clickAt(v, "MV", vs[0] - 3, vs[1] - 3);
        await clickAt(w, "MW", 400, 300);
        // A popup of another size, at another place.
        const [pop] = await Promise.all([ctx.waitForEvent("page"), v.evaluate((u: string) => { window.open(u, "pp", "width=600,height=420,left=260,top=180"); }, pageUrl("MP"))]);
        await loaded("MP");
        await sleep(400);
        for (let i = 0; i < 2; i++) { await clickAt(pop, "MP", 150 + i * 40, 160); await clickAt(v, "MV", 500 - i * 60, 260); }
        const t1 = Date.now();
        await measure("the mapping and the clamp: scrollbars, the display's edge, a popup of another size", ["MV", "MW", "MP"], t0, t1,
          { own, detail: { content: { MV: vs, MW: ws } } });
        // A moved window: the front page is unknown after Browser.setWindowBounds; then the paths come back with the new geometry.
        const s = await ctx.newCDPSession(w);
        const { windowId } = await s.send("Browser.getWindowForTarget");
        await s.send("Browser.setWindowBounds", { windowId, bounds: { left: 150, top: 60, width: 1000, height: 700 } });
        await sleep(500);
        const t2 = Date.now();
        for (let i = 0; i < 2; i++) { await clickAt(w, "MW", 300 + i * 50, 300); await clickAt(v, "MV", 250, 250 + i * 40); }
        const t3 = Date.now();
        await measure("the mapping: a moved window (after Browser.setWindowBounds, the next activation has no path; then paths with its new place)", ["MV", "MW"], t2, t3,
          { own, extra: (d) => (d.stepsWithPath < 2 ? [`only ${d.stepsWithPath} steps with a path`] : []) });
        // A device-metrics override: no path into or out of that page.
        await v.setViewportSize({ width: 800, height: 500 });
        const t4 = Date.now();
        await w.mouse.click(320, 320); await sleep(300); await v.mouse.click(200, 200); await sleep(300); await w.mouse.click(340, 330); await sleep(300);
        const t5 = Date.now();
        const vid = await tabIdOf("MV");
        const withOverride = steps().filter((s) => s.t >= t4 && s.t <= t5 + 300);
        const bad = withOverride.filter((s) => playedStep(s));
        o.record({ group: G, case: "the mapping: a device-metrics override (Playwright's setViewportSize): no path into or out of that page", status: bad.length === 0 && withOverride.length >= 2 ? "pass" : "fail", ms: t5 - t4,
          detail: { steps: withOverride.map((x) => `${x.tab === vid ? "MV" : "MW"} ${x.what}`) } });
        await pop.close().catch(() => {});
      } finally { await c.close().catch(() => {}); }
    });
  } finally {
    server.close();
    // The measure of `xdotool sleep`: the dt that the page saw (the event times of the leaving page's moves) against the planned dt.
    const err = allDt.map((d) => d.seen - d.planned);
    const single = allDt.filter((d) => d.planned <= 40).map((d) => d.seen - d.planned);
    const plays: Played[] = o.daemon.played();
    const overhead = plays.filter((p) => p.answer === "ok").map((p) => p.endedAt - p.startedAt - p.path.reduce((s, q) => s + q.dt, 0));
    const dtMeasure = { pairs: allDt.length, errorMs: stats(err.map(Math.abs)), over2ms: err.filter((e) => Math.abs(e) > 2).length, signedErrorMs: { median: stats(err).median }, singleStepErrorMs: stats(single.map(Math.abs)),
      plannedMs: stats(allDt.map((d) => d.planned)), seenMs: stats(allDt.map((d) => d.seen)), playOverheadMs: stats(overhead), plays: plays.length, answers: o.daemon.pointerCounts() };
    o.record({ group: G, case: "the measure of xdotool sleep: the dt that the leaving page saw against the planned dt", status: allDt.length >= 20 ? "pass" : "fail", ms: 0, detail: dtMeasure });
    writeFileSync(join(o.run, "pointer.json"), JSON.stringify({ cases: caseOut, dt: dtMeasure, steps: steps(), log }, null, 1) + "\n");
    void noPath;
  }
}

/** The jumps and unexplained changes of a page in the second after its own step with no path (as today: section 5). */
function countAsToday(log: Rec[], tab: string, from: number, to: number, noPathSteps: StepLine[], own: { x: number; y: number }[]): { jumps: number; unexplained: number } {
  const moves = movesOf(log, tab, from, to);
  let jumps = 0, unexplained = 0;
  for (let i = 1; i < moves.length; i++) {
    const m = moves[i], p = moves[i - 1];
    const jump = Math.hypot(m.mx ?? 0, m.my ?? 0) > 100, un = Math.hypot(m.cx - p.cx - (m.mx ?? 0), m.cy - p.cy - (m.my ?? 0)) > 20;
    if ((!jump && !un) || own.some((q) => Math.abs(q.x - m.cx) <= 1 && Math.abs(q.y - m.cy) <= 1)) continue;
    if (!noPathSteps.some((s) => m.at >= s.t - s.ms && m.at <= s.t + 1000)) continue;
    if (jump) jumps++;
    if (un) unexplained++;
  }
  return { jumps, unexplained };
}

/** A raw CDP client on the endpoint. */
async function rawCdp(WebSocket: any, url: string) {
  const ws = new WebSocket(url);
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  let next = 1;
  const waits = new Map<number, (m: any) => void>();
  ws.on("message", (raw: Buffer) => { const m = JSON.parse(String(raw)); if (m.id !== undefined) { waits.get(m.id)?.(m); waits.delete(m.id); } });
  const send = (method: string, params: object = {}) => new Promise<any>((resolve, reject) => {
    const id = next++;
    waits.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { send, close: () => ws.close() };
}
