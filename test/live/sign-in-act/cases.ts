// The pages and helpers of the design's live steps 2, 3 and 5 (board ab-v16.97.6; the stored sign-ins design,
// docs/superpowers/specs/2026-11-10-stored-sign-in-credentials-design.md, section 11, "The live check plan"), for
// check.ts only: the local site's pages of the refusals of section 7.9 (one record and one path for each), the agent's
// own pages of round 1's case K1 (a cache-first service worker at the sign-in path that reports each fetch of that path
// to the check's server, a page that sends each typed value by BroadcastChannel and by the storage event, and the page
// log that the agent's listeners keep), the screen's twin page, the WebSocket handshake of the open
// connection's page, and the framebuffer's capture (ffmpeg's x11grab, a tool of the box) with its count of the act
// page's colour. Test values only; every host is a *.localhost host of the check's own server.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

/** The act page's colour: the sign-in page's background, and the twin page's; no other page of the run shows it. */
export const ACT_COLOR = [201, 23, 177] as const;
export const COLOR_CSS = `<style>html,body{margin:0;min-height:100%;background:rgb(${ACT_COLOR.join(",")})}</style>`;

/** The values of the refusals' records: made up, named as test values; the slow case has the long ones. */
export const R_USER = "test-r-user-7k", R_PASS = "Test-R-Pass-9q-not-a-secret";
export const R_LONG_USER = "test-r-long-user.of.the.slow.case", R_LONG_PASS = "Test-R-Long-Pass-3Wd8-not-a-secret";

/** The texts of the design's section 7.9 (the table "What the agent sees"), as the design gives them: the check compares the act's answer with these. */
export const TEXT = {
  not_allowed: "Not allowed: offsend.localhost is not on the allowlist",
  locked: "The stored sign-ins are locked. The operator unlocks them in the Browser pane.",
  cannot_open: "The stored sign-in cannot be opened. The operator adds it again.",
  stopped: "The site did not accept this stored sign-in three times. The operator checks it in the Browser pane.",
  hour_limit: "This stored sign-in was used often in the last hour. Try again later.",
  busy: "Another sign-in runs now. Try again in a minute.",
  other_origin: "The sign-in page is on another origin than the stored sign-in names.",
  password_fields: "The page has more than one password field.",
  no_form: "There is no sign-in form that the agent browser can fill.",
  form_target: "The sign-in form sends to another place than the stored sign-in names.",
  open_connection: "The sign-in page keeps a connection to another site open.",
  popup: "The sign-in page opened another window, so the agent browser ended the sign-in.",
  type_watch: "The page showed the password field as text, so the agent browser ended the sign-in.",
  not_accepted: "The site did not accept the stored sign-in.",
  second_factor: "The site asks for a second factor. The agent browser cannot answer it: ask the operator.",
  off_list: "The site went to a host on no list after the sign-in.",
  timeout: "The site did not finish the sign-in in 30 s.",
  leak: "The site keeps the password where its pages can read it, so the agent browser did not keep the sign-in.",
} as const;
export type Result = keyof typeof TEXT;

/**
 * The refusals of section 7.9 that the local site makes: the record's name (its page is /r/<case>) and C11's result.
 * `send_to` is the record's origin only, except r-offsend's (a host off the list). r-twopw's seventh act gets the hour's
 * limit, and r-wrong's fourth gets stopped.
 */
export const REFUSALS = {
  offsend: { name: "r-offsend", result: "not_allowed" },
  broken: { name: "r-broken", result: "cannot_open" },
  other: { name: "r-other", result: "other_origin" },
  twopw: { name: "r-twopw", result: "password_fields" },
  noform: { name: "r-noform", result: "no_form" },
  target: { name: "r-target", result: "form_target" },
  socket: { name: "r-socket", result: "open_connection" },
  popup: { name: "r-popup", result: "popup" },
  type: { name: "r-type", result: "type_watch" },
  wrong: { name: "r-wrong", result: "not_accepted" },
  twofa: { name: "r-twofa", result: "second_factor" },
  offlist: { name: "r-offlist", result: "off_list" },
  leak: { name: "r-leak", result: "leak" },
  slow: { name: "r-slow", result: "timeout" },
  busy: { name: "r-busy", result: "busy" },
} as const satisfies Record<string, { name: string; result: Result }>;
export type Case = keyof typeof REFUSALS;

/** The sign-in form of a case: a text username and a password, posted to the case's own path. */
const form = (c: string, extra = "", action = `/r/${c}/post`) => `<!doctype html><title>aw-r-${c}</title>
<form method="post" action="${action}"><input type="text" name="u" autocomplete="username"><input type="password" name="p">${extra}<button type="submit">Sign in</button></form>`;
const HOME = `<!doctype html><title>aw-r-home</title><p id="state">signed in</p>`;

/** The agent's page that its service worker serves at the sign-in path (case K1): each typed value goes out twice. */
const K1_AGENT_PAGE = `<!doctype html><title>aw-k1-agent-page</title>
<form><input type="text" name="u"><input type="password" name="p"></form>
<script>
const bc = new BroadcastChannel("aw-k1");
for (const el of document.querySelectorAll("input")) el.addEventListener("input", () => { bc.postMessage(el.value); localStorage.setItem("aw-k1-typed", el.value); });
</script>`;
/**
 * The agent's cache-first service worker (scope /login): it serves the agent's page at /login and logs each fetch that
 * it sees in two places: on the check's server (/k1-sw-log, the check's record; board ab-v16.97.13, H2) and in Cache
 * Storage (the move's import clears it by design: the check only counts it, as a note).
 */
const K1_SW = `self.addEventListener("install", (e) => { self.skipWaiting(); e.waitUntil(caches.open("aw-k1").then((c) => c.add("/k1-agent-page"))); });
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (u.pathname !== "/login") return;
  e.waitUntil(fetch("/k1-sw-log?u=" + encodeURIComponent(u.pathname + u.search), { cache: "no-store" }).catch(() => {}));
  e.waitUntil(caches.open("aw-k1-log").then((c) => c.put("/k1-log/" + Date.now(), new Response(u.pathname))));
  e.waitUntil(self.clients.matchAll({ includeUncontrolled: true }).then((cs) => cs.forEach((c) => c.postMessage("sw:" + u.pathname))));
  e.respondWith(caches.open("aw-k1").then((c) => c.match("/k1-agent-page")).then((r) => r || fetch("/k1-agent-page")));
});`;

/** The K1 worker's log on the check's server: the time at which each report came, and the path (and query) that the worker saw. */
export const swLog: { at: number; url: string }[] = [];

/**
 * The page log of the agent's listeners (board ab-v16.97.13, H1): the relay refuses Runtime.addBinding in the main world
 * (its policy), so a listener keeps each message in a page variable (`awSay`), and the check reads the new ones with a
 * Runtime.evaluate that waits (`awSince(n, ms)`: the messages after the first n, at once when there are any, else after
 * at most ms). The move closes the agent's tabs of the site, so the check reads the log while the tab lives.
 */
export const PAGE_LOG = `window.awLog = []; window.awWake = null;
window.awSay = (s) => { window.awLog.push({ at: Date.now(), s: String(s) }); const w = window.awWake; window.awWake = null; if (w) w(); };
window.awSince = (n, ms) => new Promise((r) => { const done = () => r(JSON.stringify(window.awLog.slice(n))); if (window.awLog.length > n) return done(); window.awWake = done; setTimeout(done, ms); });`;

/** The held responses (the slow case): the check's end clears them. */
export const held = new Set<ReturnType<typeof setTimeout>>();
const hold = (ms: number, f: () => void) => { const t = setTimeout(() => { held.delete(t); try { f(); } catch { /* the act closed the request */ } }, ms); held.add(t); };
/** The open WebSockets of the open connection's page: the check's end destroys them. */
export const sockets = new Set<Duplex>();
/** The count of the WebSocket handshakes that the server answered (the open connection's case). */
export const stats = { handshakes: 0 };

/**
 * The routes of the cases on the check's server: login.localhost's /r/..., /k1..., /twin, and other.localhost (the other
 * origin). True when the route answered.
 */
export function caseRoute(host: string, req: IncomingMessage, res: ServerResponse, body: string, port: number): boolean {
  const url = req.url ?? "", post = req.method === "POST";
  const html = (s: string, status = 200) => { res.writeHead(status, { "Content-Type": "text/html", "Cache-Control": "no-store" }).end(s); return true; };
  const to = (where: string) => { res.writeHead(303, { Location: where }).end(); return true; };
  if (host === "other.localhost") return url === "/r/other" ? html(form("other")) : false;
  if (host !== "login.localhost") return false;
  if (url === "/twin") return html(`<!doctype html><title>aw-twin</title>${COLOR_CSS}<p>the screen's twin</p>`);
  if (url === "/k1") return html(`<!doctype html><title>aw-k1-listener</title><p>the agent's listener</p>`);
  if (url === "/k1-agent-page") return html(K1_AGENT_PAGE);
  if (url === "/k1-sw.js") { res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-store" }).end(K1_SW); return true; }
  if (url.startsWith("/k1-sw-log?")) { swLog.push({ at: Date.now(), url: new URLSearchParams(url.slice("/k1-sw-log?".length)).get("u") ?? "" }); res.writeHead(204, { "Cache-Control": "no-store" }).end(); return true; }
  const m = /^\/r\/([a-z0-9]+)(\/[a-z]+)?$/.exec(url);
  if (!m) return false;
  const [, c, sub] = m;
  const values = new URLSearchParams(body);
  const accepted = values.get("u") === R_USER && values.get("p") === R_PASS;
  if (c === "home") return html(HOME);
  if (c === "code") return html(`<!doctype html><title>aw-r-code</title><form method="post" action="/r/code/post"><input type="text" name="otp" autocomplete="one-time-code" maxlength="6"><button type="submit">Verify</button></form>`);
  if (!(c in REFUSALS)) return false;
  if (!post && !sub) {
    switch (c as Case) {
      case "other": res.writeHead(302, { Location: `http://other.localhost:${port}/r/other` }).end(); return true;
      case "twopw": return html(form(c, `<input type="password" name="p2">`));
      case "noform": return html(`<!doctype html><title>aw-r-noform</title><p>This page has no sign-in form.</p>`);
      case "target": return html(form(c, "", `http://tracker.localhost:${port}/r/target/post`));
      case "socket": return html(form(c, `<script>window.ws = new WebSocket("ws://tracker.localhost:" + location.port + "/ws");</script>`));
      case "popup": return html(form(c, `<script>addEventListener("keydown", () => { window.open("/r/home", "aw-r-popup", "popup,width=240,height=200"); }, { once: true, capture: true });</script>`));
      case "type": return html(form(c, `<script>const pw = document.querySelector("input[type=password]"); pw.addEventListener("input", () => { if (pw.value.length >= 3) pw.type = "text"; });</script>`));
      case "leak": return html(form(c, `<script>const pw = document.querySelector("input[type=password]"); pw.addEventListener("input", () => localStorage.setItem("aw-r-leak", pw.value));</script>`));
      // The slow case: an image of the page holds its load for 27 s, and the post never answers in the outcome's 30 s.
      case "slow": return html(form(c, `<img src="/r/slow/img" alt="">`));
      default: return html(form(c));
    }
  }
  if (c === "slow" && sub === "/img" && !post) { hold(27_000, () => res.writeHead(204).end()); return true; }
  if (!post || sub !== "/post") return false;
  switch (c as Case) {
    case "wrong": return html(form(c, `<p>not accepted</p>`));
    case "twofa": return accepted ? to("/r/code") : html(form(c, `<p>not accepted</p>`));
    case "offlist": return accepted ? to(`http://nolist.localhost:${port}/home`) : html(form(c, `<p>not accepted</p>`));
    case "slow": hold(45_000, () => html(form(c, `<p>late</p>`))); return true;
    default: return accepted ? to("/r/home") : html(form(c, `<p>not accepted</p>`));
  }
}

/** The WebSocket handshake of the open connection's page (tracker.localhost/ws): the socket stays open, and no frame goes. */
export function upgrade(req: IncomingMessage, socket: Duplex): void {
  socket.on("error", () => {});
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  const key = String(req.headers["sec-websocket-key"] ?? "");
  const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  stats.handshakes++;
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
}

/** One frame of the display's root window, as RGB bytes (ffmpeg's x11grab of the run's own Xvfb), or null. */
export function captureRoot(display: number, xauth: string, size: readonly [number, number]): Promise<Buffer | null> {
  const args = ["-hide_banner", "-loglevel", "error", "-f", "x11grab", "-draw_mouse", "0", "-video_size", `${size[0]}x${size[1]}`, "-i", `:${display}`,
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"];
  return new Promise((resolve) => {
    execFile("ffmpeg", args, { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", DISPLAY: `:${display}`, XAUTHORITY: xauth }, encoding: "buffer", maxBuffer: 16 << 20, timeout: 10_000 },
      (e, out) => resolve(e || out.length !== size[0] * size[1] * 3 ? null : out));
  });
}

/** The pixels of a frame within 4 of `rgb` in each channel. */
export function colorPixels(frame: Buffer, rgb: readonly number[] = ACT_COLOR): number {
  let n = 0;
  for (let i = 0; i + 2 < frame.length; i += 3) if (Math.abs(frame[i] - rgb[0]) <= 4 && Math.abs(frame[i + 1] - rgb[1]) <= 4 && Math.abs(frame[i + 2] - rgb[2]) <= 4) n++;
  return n;
}
