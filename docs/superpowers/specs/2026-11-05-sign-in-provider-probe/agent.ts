// Part "agent" of the sign-in provider probe (board task ab-v16.45). Not part of `npm test`. Where today's guards
// block each sign-in flow in agent mode: the receiver (agent/ of a chrome-extension checkout, unchanged: its DNR rules
// 1 to 5 of C5 as package 0.2.0 writes them), the relay of this checkout (its popup rule, C11), and agent-browser's own
// guard over the relay (--cdp-url, with PR #47's input guard). And what the sign-in beam (the receiver's import, C6)
// must send for a provider flow. Lists: L1 = [site.test] (the provider on no list), L2 = [site.test,
// tenant.auth0.test] (option c: the provider as a normal entry), L3 = [site.test, auth0.test] (a broad entry).
//
//   CHROME_EXTENSION=<a detached chrome-extension worktree> PLAYWRIGHT=<folder with node_modules/playwright-core> \
//     RUN=<empty folder> node agent.ts
//
// Environment: CHROMIUM, DISPLAY_N (default 145), PORT (default 8461), CASES (default pw,ab,beam). It starts its own
// Xvfb, Chromium (no debugging port or pipe), a stand-in daemon and the relay, and stops only those. It writes
// <RUN>/results.json.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { createRequire } from "node:module";
import { createServer, type Server, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DISPLAY_N, M, O, P, PORT, RUN, S, chromiumArgs, hitsSince, logLine, now, pids, sleep, startChromium, startXvfb, stopAll, track, xauth } from "./common.ts";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const EXT = resolve(process.env.CHROME_EXTENSION ?? "");
if (!process.env.CHROME_EXTENSION || !existsSync(join(EXT, "agent/manifest.json")) || !process.env.PLAYWRIGHT) {
  process.stderr.write("usage: CHROME_EXTENSION=<chrome-extension checkout> PLAYWRIGHT=<install folder> RUN=<empty folder> node agent.ts\n");
  process.exit(2);
}
const GROUPS = (process.env.CASES ?? "pw,ab,beam").split(",");
const pw = createRequire(join(resolve(process.env.PLAYWRIGHT), "package.json"))("playwright-core");
const RELAY_SOCK = join(RUN, "relay.sock"), DAEMON_SOCK = join(RUN, "daemon.sock");
const L1 = ["site.test"], L2 = ["site.test", "tenant.auth0.test"], L3 = ["site.test", "auth0.test"];
const results: Record<string, unknown> = { part: "agent", port: PORT };
const cases: any[] = [];

// ---------------------------------------------------------------- the stand-in daemon (C4, C10), as the orphan probe's

class Daemon {
  relay: ChildProcess | null = null;
  private server: Server | null = null;
  private host: Socket | null = null;
  bridgeUp = false;
  private nextId = 1;
  private readonly mainWait = new Map<string, (m: any) => void>();
  private readonly own = new Map<string, (m: any) => void>();
  private readonly toRelayPending = new Set<string>();
  allow: string[];
  blocked: { at: number; tab: number; host: string }[] = [];
  constructor(allow: string[]) { this.allow = allow; }
  listen(): Promise<void> {
    this.server = createServer((s) => this.onHost(s));
    const umask = process.umask(0o077);
    return new Promise<void>((r) => { try { this.server!.listen(DAEMON_SOCK, () => { chmodSync(DAEMON_SOCK, 0o600); r(); }); } finally { process.umask(umask); } });
  }
  startRelay(): void {
    const relay = track(spawn(process.execPath, [join(ROOT, "bin/agent-browser.js"), "relay", "--socket", RELAY_SOCK], { stdio: ["pipe", "pipe", "pipe"] }));
    this.relay = relay;
    createInterface({ input: relay.stdout! }).on("line", (line) => this.fromRelay(line));
    createInterface({ input: relay.stderr! }).on("line", (l) => logLine("relay.log", l));
  }
  private toRelay(msg: object | string): void { if (this.relay?.stdin?.writable) this.relay.stdin.write(`${typeof msg === "string" ? msg : JSON.stringify(msg)}\n`); }
  private toReceiver(ch: "main" | "bridge", msg: { id: string }): boolean {
    if (!this.host) return false;
    const bytes = Buffer.from(JSON.stringify(msg));
    const n = Math.max(1, Math.ceil(bytes.length / 700_000));
    for (let seq = 0; seq < n; seq++) this.host.write(`${JSON.stringify({ t: "part", ch, id: msg.id, seq, n, b64: bytes.subarray(seq * 700_000, (seq + 1) * 700_000).toString("base64") })}\n`);
    return true;
  }
  /** A main-channel request (set_allowlist, import); its answer. */
  main(op: string, fields: object, waitMs = 15_000): Promise<any> {
    const id = `m${this.nextId++}`;
    return new Promise((res) => {
      const timer = setTimeout(() => { this.mainWait.delete(id); res({ ok: false, error: "no answer (probe)" }); }, waitMs);
      this.mainWait.set(id, (m) => { clearTimeout(timer); res(m); });
      if (!this.toReceiver("main", { t: "req", id, op, ...fields } as any)) { clearTimeout(timer); this.mainWait.delete(id); res({ ok: false, error: "not connected" }); }
    });
  }
  async setAllowlist(domains: string[]): Promise<any> {
    this.allow = domains;
    const r = await this.main("set_allowlist", { domains });
    if (r.ok) this.toRelay({ t: "allowlist", domains });
    return r;
  }
  private fromRelay(line: string): void {
    let req: any;
    try { req = JSON.parse(line); } catch { return; }
    if (req?.t !== "req") return;
    if (!this.bridgeUp || !this.toReceiver("bridge", req)) { this.toRelay({ t: "res", ch: "bridge", id: req.id, ok: false, error: "not connected" }); return; }
    this.toRelayPending.add(req.id);
  }
  private readonly parts = new Map<string, string[]>();
  private onHost(sock: Socket): void {
    if (this.host) { sock.destroy(); return; }
    this.host = sock;
    createInterface({ input: sock, crlfDelay: Infinity }).on("line", (line) => {
      let m: any;
      try { m = JSON.parse(line); } catch { return; }
      if (m.t === "hello") {
        if (!Array.isArray(m.channels) || !m.channels.includes("bridge")) return;
        this.bridgeUp = true;
        this.toRelay({ t: "link", up: true, version: m.version });
        void this.setAllowlist(this.allow);
      } else if (m.t === "res" && m.ch === "bridge" && this.own.has(m.id)) { this.own.get(m.id)!(m); this.own.delete(m.id); }
      else if (m.t === "res" && m.ch === "bridge" && this.toRelayPending.delete(m.id)) this.toRelay(line);
      else if (m.t === "part" && m.ch === "bridge") {
        const got = this.parts.get(m.id) ?? [];
        got[m.seq] = m.b64;
        this.parts.set(m.id, got);
        if (got.filter((x) => x !== undefined).length === m.n) {
          this.parts.delete(m.id);
          const text = Buffer.concat(got.map((b) => Buffer.from(b, "base64"))).toString("utf8");
          if (this.toRelayPending.delete(m.id)) this.toRelay(text);
        }
      } else if (m.t === "res" && !m.ch && this.mainWait.has(m.id)) { this.mainWait.get(m.id)!(m); this.mainWait.delete(m.id); }
      else if (m.t === "ev" && m.ch === "bridge") this.toRelay(line);
      else if (m.t === "blocked") { this.blocked.push({ at: now(), tab: m.tab, host: m.host }); logLine("daemon.log", `blocked tab ${m.tab} ${m.host}`); }
    });
    sock.on("close", () => {
      if (this.host !== sock) return;
      this.host = null;
      for (const id of this.toRelayPending) this.toRelay({ t: "res", ch: "bridge", id, ok: false, error: "disconnected" });
      this.toRelayPending.clear();
      if (this.bridgeUp) this.toRelay({ t: "link", up: false });
      this.bridgeUp = false;
    });
  }
  ask(op: string, args: unknown[] = []): Promise<any> {
    const id = `probe-${this.nextId++}`;
    return new Promise((res, rej) => {
      this.own.set(id, (m) => (m.ok ? res(m.data ?? null) : rej(new Error(m.error))));
      if (!this.toReceiver("bridge", { t: "req", id, op, args, wait: 30_000 } as any)) { this.own.delete(id); rej(new Error("not connected")); }
    });
  }
  async stop(): Promise<void> {
    if (this.relay?.stdin?.writable) this.relay.stdin.end();
    await sleep(1000);
    this.host?.destroy();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}

// ---------------------------------------------------------------- setup

const manifest = JSON.parse(readFileSync(join(EXT, "agent/manifest.json"), "utf8"));
const hex = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32);
const EXT_ID = [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
cpSync(join(EXT, "agent"), join(RUN, "agent"), { recursive: true });
const PROFILE = join(RUN, "profile");
mkdirSync(join(PROFILE, "NativeMessagingHosts"), { recursive: true });
const hostSh = join(RUN, "host.sh");
writeFileSync(hostSh, `#!/bin/sh\nexec /usr/bin/python3 ${join(EXT, "test/live/host.py")} --socket ${DAEMON_SOCK} --log ${join(RUN, "logs/host.log")} "$@"\n`, { mode: 0o700 });
writeFileSync(join(PROFILE, "NativeMessagingHosts/sh.agentwatch.browser.json"),
  JSON.stringify({ name: "sh.agentwatch.browser", description: "probe", path: hostSh, type: "stdio", allowed_origins: [`chrome-extension://${EXT_ID}/`] }));
const git = (dir: string, ...a: string[]) => new Promise<string>((r) => execFile("git", ["-C", dir, ...a], (e, o) => r(e ? "?" : o.trim())));
results.env = { extension: { dir: EXT, commit: await git(EXT, "rev-parse", "HEAD"), version: manifest.version, id: EXT_ID }, agentBrowser: await git(ROOT, "rev-parse", "HEAD"), playwright: pw.chromium ? "playwright-core " + JSON.parse(readFileSync(join(resolve(process.env.PLAYWRIGHT), "node_modules/playwright-core/package.json"), "utf8")).version : "?" };

const daemon = new Daemon(L1);
await daemon.listen();
daemon.startRelay();
await startXvfb();
const chromium = startChromium(chromiumArgs(PROFILE, [`--load-extension=${join(RUN, "agent")}`]));
const status = (path: string) => new Promise<number>((r) => { get({ socketPath: RELAY_SOCK, path }, (res) => { res.resume(); r(res.statusCode ?? 0); }).once("error", () => r(0)); });
const endpoint = (scope: string) => `ws+unix://${RELAY_SOCK}:/devtools/browser/${scope}`;

/** One case: what it did, what it saw, and the site's hits and the receiver's blocked notices meanwhile. */
async function rec(group: string, list: string, name: string, fn: () => Promise<any>, ms = 30_000) {
  const at = now(), b0 = daemon.blocked.length;
  let detail: any, error: string | undefined;
  try { detail = await Promise.race([fn(), sleep(ms).then(() => { throw new Error(`no answer in ${ms / 1000} s`); })]); }
  catch (e) { error = String((e as Error)?.message ?? e).split("\n")[0].slice(0, 400); }
  const c = { group, list, case: name, ms: now() - at, detail, error, hits: hitsSince(at).map((h) => `${h.method} ${h.host}${h.path} sfs=${h.sfs} cookies=${h.cookies.join("+") || "-"}`),
    blocked: daemon.blocked.slice(b0).map((b) => b.host) };
  cases.push(c);
  console.log(`${group} ${list} ${name}: ${error ? "ERROR " + error : JSON.stringify(detail)} | blocked=${JSON.stringify(c.blocked)} hits=${c.hits.length}`.slice(0, 500));
  return c;
}

async function useList(name: string, domains: string[]) {
  const r = await daemon.setAllowlist(domains);
  logLine("daemon.log", `set_allowlist ${name} ${JSON.stringify(r)}`);
  return r;
}

/** Sign out at the site and, when the list allows it, at the provider (navigations; the relay refuses cookie calls). */
async function signOut(page: any, providerReachable: boolean) {
  await page.goto(S + "/logout").catch(() => {});
  if (providerReachable) await page.goto(P + "/logout").catch(() => {});
}

const where = async (page: any) => ({ url: page.url().replace(`:${PORT}`, ""), who: await page.locator("#who").textContent({ timeout: 1500 }).catch(() => null), status: await page.locator("#status").textContent({ timeout: 500 }).catch(() => null) });

try {
  let ready = 0;
  for (let i = 0; i < 120 && (ready = await status("/devtools/browser/probe")) !== 404; i++) await sleep(500);
  if (ready !== 404) throw new Error(`the relay did not get ready (HTTP ${ready})`);

  // ---------------------------------------------------------------- Playwright over the relay
  if (GROUPS.includes("pw")) {
    const browser = await pw.chromium.connectOverCDP(endpoint("pw"), { timeout: 20_000 });
    const context = browser.contexts()[0];
    for (const [ln, list] of [["L1", L1], ["L2", L2]] as const) {
      await useList(ln, list);
      const reach = ln === "L2";
      const page = await context.newPage();
      const G = "pw";
      // The relay's view: a CDP session on the page, Page events (what a client of the relay gets).
      const cdp = await context.newCDPSession(page);
      const seen: any[] = [];
      await cdp.send("Page.enable");
      for (const m of ["Page.frameRequestedNavigation", "Page.frameStartedNavigating"]) cdp.on(m, (p: any) => seen.push({ m: m.replace("Page.", ""), url: (p.url ?? "").replace(`:${PORT}`, ""), reason: p.reason, disposition: p.disposition, navigationType: p.navigationType }));
      const take = () => seen.splice(0, seen.length);
      await signOut(page, reach);
      take();

      await rec(G, ln, "the agent's goto of a listed URL whose site redirects to the provider (not signed in)", async () => {
        const r = await page.goto(S + "/app").then((x: any) => ({ status: x?.status() }), (e: any) => ({ error: String(e.message).split("\n")[0] }));
        return { ...r, ...(await where(page)), relaySees: take() };
      });
      await rec(G, ln, "the agent's goto of the provider itself", async () => {
        const r = await page.goto(`${P}/u/login`).then((x: any) => ({ status: x?.status() }), (e: any) => ({ error: String(e.message).split("\n")[0] }));
        return { ...r, ...(await where(page)), relaySees: take() };
      });
      await page.goto(S + "/");
      take();
      await rec(G, ln, "a click on the site's sign-in link (site -> /login -> 302 provider /authorize -> /u/login)", async () => {
        await page.locator("#signin-redirect").click();
        await page.waitForURL((u: URL) => !u.pathname.startsWith("/login"), { timeout: 5000 }).catch(() => {});
        await sleep(500);
        return { ...(await where(page)), frames: page.frames().map((f: any) => f.url().replace(`:${PORT}`, "")), relaySees: take() };
      });
      if (reach) {
        await rec(G, ln, "choose an account on the provider's page: a click, typing, a click (then 303, 302 back to the site)", async () => {
          await page.locator("#account-ada").click();
          await page.locator("#password").pressSequentially("pw");
          await page.locator("#submit").click();
          await page.waitForURL(`${S}/app`, { timeout: 5000 }).catch(() => {});
          return { ...(await where(page)), relaySees: take() };
        });
        await page.goto(S + "/logout");
        await page.goto(S + "/");
        take();
        await rec(G, ln, "a click on the sign-in link with the provider's session (a silent redirect chain)", async () => {
          await page.locator("#signin-redirect").click();
          await page.waitForURL(`${S}/app`, { timeout: 5000 }).catch(() => {});
          return { ...(await where(page)), relaySees: take() };
        });
        await page.goto(S + "/logout");
      }
      await page.goto(S + "/");
      take();
      await rec(G, ln, "a click on a sign-in link that goes straight to the provider", async () => {
        await page.locator("#signin-direct").click();
        await sleep(1500);
        return { ...(await where(page)), relaySees: take() };
      });
      await page.goto(S + "/");
      take();
      await rec(G, ln, "the frame's silent renew (prompt=none, web_message)", async () => {
        await page.locator("#silent").click();
        await page.waitForFunction(() => document.getElementById("status")!.textContent !== "", null, { timeout: 4000 }).catch(() => {});
        return { ...(await where(page)), frames: page.frames().map((f: any) => f.url().replace(`:${PORT}`, "")), relaySees: take() };
      });
      for (const [id, label] of [["#signin-popup", "a sign-in popup: window.open('') then location, prompt=select_account (auth0-spa-js)"], ["#signin-popup-url", "a sign-in popup: window.open(url)"]] as const) {
        await page.goto(S + "/");
        take();
        await rec(G, ln, label, async () => {
          const popupP = page.waitForEvent("popup", { timeout: 5000 }).catch((e: any) => ({ error: String(e.message).split("\n")[0] }));
          await page.locator(id).click();
          const popup: any = await popupP;
          if (popup.error) return { popup: popup.error, ...(await where(page)) };
          await popup.waitForLoadState("load", { timeout: 5000 }).catch(() => {});
          const pu = popup.isClosed() ? "closed" : popup.url().replace(`:${PORT}`, "");
          let drove: unknown = null;
          if (!popup.isClosed() && pu.includes("/u/login")) {
            drove = await (async () => {
              await popup.locator("#account-ada").click();
              await popup.locator("#password").pressSequentially("pw");
              await popup.locator("#submit").click();
              await page.waitForFunction(() => document.getElementById("status")!.textContent !== "", null, { timeout: 5000 }).catch(() => {});
              return "drove the provider's page in the popup";
            })().catch((e) => `input: ${String(e.message).split("\n")[0]}`);
          } else await page.waitForFunction(() => document.getElementById("status")!.textContent !== "", null, { timeout: 3000 }).catch(() => {});
          return { popupUrl: pu, drove, popupClosed: popup.isClosed(), ...(await where(page)), relaySees: take() };
        });
        if (reach) await page.goto(P + "/logout").catch(() => {});
      }
      await page.goto(S + "/");
      take();
      await rec(G, ln, "a SAML sign-in: the site's form POST to the provider, the provider's form POST back to the site's ACS", async () => {
        await page.locator("#saml").click();
        await sleep(1500);
        let drove: unknown = null;
        if (page.url().includes("/u/login")) {
          await page.locator("#account-ada").click();
          await page.locator("#password").pressSequentially("pw");
          await page.locator("#submit").click();
          await page.waitForURL(`${S}/app`, { timeout: 5000 }).catch(() => {});
          drove = "chose the account and typed";
        }
        return { drove, ...(await where(page)), relaySees: take() };
      });
      if (reach) {
        await page.goto(S + "/logout");
        await page.goto(`${P}/u/login`);
        take();
        await rec(G, ln, "a click on the provider page's link to other.test", async () => { await page.locator("#privacy").click(); await sleep(1200); return { ...(await where(page)), relaySees: take() }; });
        await page.goto(`${P}/u/login`);
        await rec(G, ln, "a click on the provider page's link to manage.auth0.test", async () => { await page.locator("#manage").click(); await sleep(1200); return { ...(await where(page)), relaySees: take() }; });
        await page.goto(P + "/logout").catch(() => {});
      }
      await page.goto(S + "/");
      take();
      await rec(G, ln, "the agent's script in the page: location.href = the provider", async () => {
        await page.evaluate((u: string) => { location.href = u; }, `${P}/u/login`);
        await sleep(1500);
        return { ...(await where(page)), relaySees: take() };
      });
      await page.goto(S + "/");
      await rec(G, ln, "the agent's goto through the site's open redirect to other.test", async () => {
        const r = await page.goto(`${S}/redirect?to=${encodeURIComponent(O + "/x")}`).then((x: any) => ({ status: x?.status() }), (e: any) => ({ error: String(e.message).split("\n")[0] }));
        return { ...r, ...(await where(page)), relaySees: take() };
      });
      await page.close().catch(() => {});
    }
    // A broad entry: auth0.test covers the provider and its sibling host.
    await useList("L3", L3);
    const page = await context.newPage();
    await rec("pw", "L3", "the agent's goto of the provider's sibling host (manage.auth0.test) under the entry auth0.test", async () => {
      const r = await page.goto(`${M}/`).then((x: any) => ({ status: x?.status() }), (e: any) => ({ error: String(e.message).split("\n")[0] }));
      return { ...r, url: page.url().replace(`:${PORT}`, ""), title: await page.title().catch(() => null) };
    });
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  // ---------------------------------------------------------------- agent-browser over the relay (--cdp-url)
  if (GROUPS.includes("ab")) {
    for (const [ln, list] of [["L1", L1], ["L2", L2]] as const) {
      await useList(ln, list);
      const state = join(RUN, `ab-state-${ln}`), allow = join(RUN, `allow-${ln}.json`);
      mkdirSync(state, { recursive: true });
      writeFileSync(allow, JSON.stringify({ allow: list }));
      const cli = (...args: string[]) => new Promise<any>((res) => {
        execFile(process.execPath, [join(ROOT, "bin/agent-browser.js"), ...args, "--cdp-url", endpoint(`ab-${ln}`), "--state-dir", state, "--allowlist", allow, "--no-launch", "--json"],
          { encoding: "utf8", env: { ...process.env, DISPLAY: `:${DISPLAY_N}`, XAUTHORITY: xauth } }, (e, stdout, stderr) => {
            try { res(JSON.parse(stdout)); } catch { res({ ok: false, raw: (stdout || stderr || e?.message || "").slice(0, 300) }); }
          });
      });
      const short = (r: any) => (r?.ok === false || r?.error ? { error: r.error?.message ?? r.error ?? r.raw } : r);
      const G = "ab";
      await cli("open", `${S}/logout`, "--name", "qq1");
      await rec(G, ln, "open site.test/ and click the sign-in link", async () => ({ open: short(await cli("goto", "qq1", `${S}/`)), click: short(await cli("click", "qq1", "#signin-redirect")) }));
      await sleep(1200);
      await rec(G, ln, "text of the tab after the click (the tab is on the provider's page)", async () => ({ text: short(await cli("text", "qq1")), tabs: short(await cli("tabs")) }));
      if (ln === "L2") {
        await rec(G, ln, "choose an account and type on the provider's page", async () => ({
          account: short(await cli("click", "qq1", "#account-ada")), type: short(await cli("type", "qq1", "pw", "--into", "#password")), submit: short(await cli("click", "qq1", "#submit")),
        }));
        await sleep(1200);
        await rec(G, ln, "text after the sign-in", async () => ({ text: short(await cli("text", "qq1")) }));
        await cli("goto", "qq1", `${S}/logout`);
        await cli("goto", "qq1", `${P}/logout`);
      } else {
        await cli("open", `${S}/`, "--name", "qq1");
      }
      await rec(G, ln, "goto site.test/app while signed out (the site redirects to the provider)", async () => ({ goto: short(await cli("goto", "qq1", `${S}/app`)) }));
      await rec(G, ln, "open the provider's page itself (the agent's own navigation)", async () => ({ open: short(await cli("open", `${P}/u/login`, "--name", "qq2")) }));
      await cli("open", `${S}/`, "--name", "qq1");
      await rec(G, ln, "eval location.href = the provider (the agent's script in the page)", async () => {
        const e = short(await cli("eval", "qq1", `location.href = ${JSON.stringify(`${P}/u/login`)}; 1`));
        await sleep(1200);
        return { eval: e, text: short(await cli("text", "qq1")) };
      });
      await cli("open", `${S}/`, "--name", "qq1");
      await rec(G, ln, "click the popup sign-in, then list the tabs", async () => {
        const c = short(await cli("click", "qq1", "#signin-popup"));
        await sleep(1500);
        return { click: c, tabs: short(await cli("tabs")) };
      });
      if (ln === "L2") {
        await rec(G, ln, "drive the popup on the provider's page (by its URL)", async () => ({
          account: short(await cli("click", "web_message", "#account-ada")), type: short(await cli("type", "web_message", "pw", "--into", "#password")), submit: short(await cli("click", "web_message", "#submit")),
        }));
        await sleep(1500);
        await rec(G, ln, "the opener's status after the popup", async () => ({ status: short(await cli("text", "qq1", "#status")) }));
        await cli("goto", "qq1", `${P}/logout`);
      }
      for (const t of ["qq1", "qq2"]) await cli("close", t).catch(() => {});
    }
  }

  // ---------------------------------------------------------------- the sign-in beam (C6 import) and a provider flow
  if (GROUPS.includes("beam")) {
    const browser = await pw.chromium.connectOverCDP(endpoint("beam"), { timeout: 20_000 });
    const context = browser.contexts()[0];
    const storage = { local: {}, session: {}, idb: [], caches: [] };
    const cookie = (name: string, value: string, domain: string, sameSite: string) => ({ name, value, domain, hostOnly: true, path: "/", secure: true, httpOnly: true, sameSite, session: true });
    // C6 step 4 sends the restore tab to the state's url: a url that redirects to the provider would start a sign-in
    // there. So a sign-out uses the host's logout page, and a send uses a page that does not redirect.
    const siteState = (cookies: object[]) => ({ v: 1, domain: "site.test", url: cookies.length ? `${S}/` : `${S}/logout`, origin: S, cookies, storage });
    const providerState = (cookies: object[]) => ({ v: 1, domain: "tenant.auth0.test", url: cookies.length ? `${P}/u/login` : `${P}/logout`, origin: P, cookies, storage });
    /** A new page for each step: an import closes the tabs of its origin (C6 step 1). */
    const fresh = async (fn: (page: any) => Promise<any>) => { const page = await context.newPage(); try { return await fn(page); } finally { await page.close().catch(() => {}); } };
    const gotoApp = (page: any) => page.goto(S + "/app").then((x: any) => ({ status: x?.status() }), (e: any) => ({ error: String(e.message).split("\n")[0] }));
    const silent = async (page: any) => {
      await page.goto(S + "/");
      await page.locator("#silent").click();
      await page.waitForFunction(() => document.getElementById("status")!.textContent !== "", null, { timeout: 4000 }).catch(() => {});
      return where(page);
    };
    const imp = (state: object) => daemon.main("import", { state }, 125_000).then((m: any) => (m.ok ? m.data : { error: m.error }));
    for (const [ln, list] of [["L1", L1], ["L2", L2]] as const) {
      await useList(ln, list);
      const G = "beam";
      await rec(G, ln, "import site.test with no cookie (signs the site out)", () => imp(siteState([])), 130_000);
      await rec(G, ln, "import tenant.auth0.test with no cookie (signs the provider out)", () => imp(providerState([])), 130_000);
      await rec(G, ln, "with neither sign-in: goto site.test/app", () => fresh(async (page) => ({ ...(await gotoApp(page)), ...(await where(page)) })));
      await rec(G, ln, "beam the site's sign-in only (site.test: site_session)", () => imp(siteState([cookie("site_session", "ada", "site.test", "lax")])), 130_000);
      await rec(G, ln, "with the site's cookie: goto site.test/app", () => fresh(async (page) => ({ ...(await gotoApp(page)), ...(await where(page)) })));
      await rec(G, ln, "with the site's cookie only: the frame's silent renew", () => fresh(silent));
      await rec(G, ln, "the site's session ends (import site.test with no cookie)", () => imp(siteState([])), 130_000);
      await rec(G, ln, "beam the provider's sign-in (a second send: tenant.auth0.test, auth0_session SameSite=None)", () => imp(providerState([cookie("auth0_session", "s1", "tenant.auth0.test", "no_restriction")])), 130_000);
      await rec(G, ln, "with the provider's cookie: goto site.test/app (the site redirects to the provider)", () => fresh(async (page) => { const r = await gotoApp(page); await sleep(800); return { ...r, ...(await where(page)) }; }));
      await rec(G, ln, "with the provider's cookie: the frame's silent renew", () => fresh(silent));
      if (ln === "L1") {
        // Did the failed import (step "restore page") leave the provider's cookie in the profile? With L2 the chain answers silently if so.
        await useList("L2", L2);
        await rec(G, "L1->L2", "after the failed L1 import of the provider: goto site.test/app under L2", () => fresh(async (page) => { const r = await gotoApp(page); await sleep(800); return { ...r, ...(await where(page)) }; }));
        await imp(siteState([]));
        await useList(ln, list);
      }
      await rec(G, ln, "the open tabs after the imports", async () => (await daemon.ask("tabs.query", [{}])).map((t: any) => (t.url ?? "").replace(`:${PORT}`, "")));
    }
    await browser.close().catch(() => {});
  }
} catch (e) {
  results.aborted = String((e as Error)?.stack ?? e);
  console.error(results.aborted);
} finally {
  results.cases = cases;
  results.pids = pids;
  results.chromiumExit = chromium.exitCode;
  writeFileSync(join(RUN, "results.json"), JSON.stringify(results, null, 2) + "\n");
  await daemon.stop();
  await stopAll();
  console.log(`wrote ${join(RUN, "results.json")}`);
  process.exit(0);
}
