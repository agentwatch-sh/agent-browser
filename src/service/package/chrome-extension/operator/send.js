// Build the C2 payload from a tab, send it to a box, and report in plain
// words. It never touches the DOM: the service worker uses it. No text it
// builds holds a cookie value, a storage value or a response body.
import { normalizeEntry, covers, domainCandidates, fallbackDomain } from "./lib/domains.js";
import { dedupe, inScope } from "./lib/cookies.js";
import { readPageState } from "./read-page.js";

export const MAX_SEND_BYTES = 33554432;
const MIB = 1048576;

// The UTF-8 length of a string, without an encoded copy of it (the JSON can be 32 MiB). A lone
// surrogate counts 3 bytes, as TextEncoder writes U+FFFD for it.
export function byteLength(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00 && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i += 1;
    } else n += 3;
  }
  return n;
}
const mib = (n) => (n / MIB).toFixed(1);
const hostOf = (box) => {
  try {
    return new URL(box).host;
  } catch {
    return String(box);
  }
};
const loginLink = (box) => box + "/login?next=/browser";

// ---- the domain choice ----

// The host and its parents down to the last two labels (the fallback).
export function domainChoices(host) {
  if (host.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return [];
  return domainCandidates(host).filter((d) => d.includes("."));
}

// The domains the popup offers for a tab, and the one it preselects. The
// tab's partition key (cookies.getPartitionKey, Chrome 132) names the
// registrable domain from Chrome's public suffix list: the choices stop there,
// so a public suffix such as co.uk is never offered, and it is the default.
// Without a key, the host and its parents down to the fallback.
export async function domainOptions(chrome, tabId, host) {
  const all = domainChoices(host);
  try {
    const r = await chrome.cookies.getPartitionKey({ tabId, frameId: 0 });
    const site = r?.partitionKey?.topLevelSite;
    if (typeof site === "string") {
      const i = all.indexOf(new URL(site).hostname);
      if (i >= 0) return { choices: all.slice(0, i + 1), chosen: all[i] };
    }
  } catch {
    // No partition key: use the fallback.
  }
  return { choices: all, chosen: all.length > 0 ? fallbackDomain(host) : "" };
}

// ---- the box's own sign-in ----
//
// A box's web viewer keeps its login in a cookie of the box host. A send of a
// domain that covers a box host would move that login into the agent's
// Chrome, where any agent process can read it. So the sender refuses such a
// send before it reads anything, and no payload holds a cookie that a saved
// box host would receive.

export const BOX_TEXT = "This is an agentwatch box. Its sign-in is never sent.";

const bareHost = (h) => String(h).toLowerCase().replace(/\.$/, "");

// The hosts of the saved boxes (their origins).
export function boxHosts(boxes) {
  const out = [];
  for (const b of Array.isArray(boxes) ? boxes : []) {
    try {
      out.push(bareHost(new URL(b).hostname));
    } catch {
      // Not an origin: no host.
    }
  }
  return out;
}

// True when a send of `domain` from a tab on `tabHost` would reach a box's sign-in.
export function isBoxSite(domain, tabHost, hosts) {
  const tab = bareHost(tabHost);
  return hosts.some((h) => h === tab || covers(domain, h));
}

// True when a box host would receive the cookie (cookie domain-match): a
// host-only cookie whose domain is the box host, or a domain cookie whose
// domain covers it.
export function boxGetsCookie(c, hosts) {
  const d = bareHost(String(c.domain ?? "").replace(/^\./, ""));
  return hosts.some((h) => (c.hostOnly === true ? h === d : covers(d, h)));
}

// ---- the payload ----

function cleanCookie(c) {
  const out = {
    name: c.name, value: c.value, domain: c.domain, hostOnly: !!c.hostOnly, path: c.path,
    secure: !!c.secure, httpOnly: !!c.httpOnly, sameSite: c.sameSite ?? "unspecified", session: !!c.session,
  };
  if (!c.session) out.expirationDate = c.expirationDate;
  if (c.partitionKey) {
    out.partitionKey = { topLevelSite: c.partitionKey.topLevelSite };
    if (c.partitionKey.hasCrossSiteAncestor !== undefined) {
      out.partitionKey.hasCrossSiteAncestor = c.partitionKey.hasCrossSiteAncestor;
    }
  }
  return out;
}

// A stop with a fixed text for the operator. The text never holds a value.
export class SendStop extends Error {}

export const MOVED_TEXT = "The tab moved to another page. Send again.";

// The page's read, parsed. The reader's JSON string (up to MAX_SEND_BYTES) is not kept after this.
async function readTab(chrome, tabId, origin) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["lib/codec.js"] });
  const [injected] = await chrome.scripting.executeScript({
    target: { tabId }, func: readPageState, args: [MAX_SEND_BYTES, origin],
  });
  if (typeof injected?.result !== "string") throw new Error("no page read");
  return JSON.parse(injected.result);
}

// The C2 payload as its JSON string. The result holds only the string, not the payload object
// next to it, so a send keeps one copy of the state while its upload runs.
export async function buildPayload(chrome, { tabId, url, domain, boxes = [] }) {
  const origin = new URL(url).origin;
  const read = await readTab(chrome, tabId, origin);
  // The tab can show another page by the time the reader runs.
  if (read?.origin !== origin) throw new SendStop(MOVED_TEXT);
  if (read.tooLarge) throw new SendStop(readerTooLargeText(read.tooLarge));
  const { storage, skipped } = read;

  const hosts = boxHosts(boxes);
  const plain = await chrome.cookies.getAll({ domain });
  const partitioned = await chrome.cookies.getAll({ domain, partitionKey: {} });
  const cookies = dedupe([...plain, ...partitioned])
    .filter((c) => inScope(c, domain) && !boxGetsCookie(c, hosts))
    .map(cleanCookie);

  let largest = null;
  for (const db of storage.idb) {
    const n = byteLength(JSON.stringify(db));
    if (largest === null || n > largest.bytes) largest = { name: db.name, bytes: n };
  }
  const json = JSON.stringify({ v: 1, domain, url, origin, cookies, storage });
  return { json, bytes: byteLength(json), largest, skipped: skipped ?? [] };
}

export function tooLargeText(bytes, largest) {
  let t = `This site's state is too large to send (${mib(bytes)} MiB; the limit is ${MAX_SEND_BYTES / MIB} MiB).`;
  if (largest) t += ` The largest part is the database "${largest.name}" (${mib(largest.bytes)} MiB).`;
  return t;
}

// The text for the page reader's own stop (read-page.js).
export function readerTooLargeText(tl) {
  const limit = MAX_SEND_BYTES / MIB;
  if (tl?.stage === "estimate") {
    return `This site's state is too large to send (its databases hold ${mib(tl.bytes)} MiB; the limit is ${limit} MiB).`;
  }
  let t = `This site's state is too large to send (more than ${limit} MiB).`;
  const p = tl?.largest;
  if (p && typeof p.name === "string") {
    t += ` The largest part is the ${p.kind === "cache" ? "cache" : "database"} "${p.name}" (${mib(p.bytes)} MiB read).`;
  }
  return t;
}

// ---- the send ----

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function errorCode(j) {
  const c = j?.error_code ?? j?.data?.error_code;
  return typeof c === "string" ? c : "";
}

function findCounts(j) {
  for (const c of [j?.data?.counts, j?.counts, j?.data, j]) {
    if (c && typeof c === "object" && "cookies_set" in c) return c;
  }
  return null;
}

export function resultText(result, box) {
  const host = hostOf(box);
  const detail = result.detail ? ` ${result.detail}` : "";
  switch (result.kind) {
    case "ok": {
      const c = result.counts ?? {};
      const n = (v) => (Number.isFinite(v) ? v : 0);
      let t = `Sent ${result.domain ?? "the site"} to ${host}: ${n(c.cookies_set)} cookies, ` +
        `${n(c.local) + n(c.session)} storage keys, ${n(c.idb_databases)} databases ` +
        `(${n(c.idb_records)} records), ${n(c.cache_entries)} cache entries`;
      if (n(c.errors) > 0) t += `, ${c.errors} problems`;
      return t + ".";
    }
    case "password": return `Log in to ${host} with your password, then send again.`;
    case "login": return `Log in to ${host} first.`;
    case "too-large": return "The box refused the send: it is too large.";
    case "unsupported": return "This box's agentwatch has no agent browser yet.";
    case "receiver-missing": return `The agent browser on ${host} does not answer. Look at its Browser page.${detail}`;
    case "start-failed": return `The agent browser on ${host} does not start. Look at its Browser page.${detail}`;
    case "disabled": return `The agent browser is turned off on ${host}.${detail}`;
    case "malformed": return `The box refused the send as malformed.${detail}`;
    case "timeout": return "The box did not answer in time. The send may still finish: look at its Browser page.";
    case "import-failed": return `The agent browser on ${host} could not import the site. Look at its Browser page.${detail}`;
    case "config-invalid": return `The agent browser settings on ${host} are not valid. Look at its Browser page.${detail}`;
    case "daemon-disconnected": return `The daemon of this user on ${host} is not connected. Look at its Browser page.`;
    case "user-not-logged-in": return `This login on ${host} is not a login of that user. Log in as that user, then send again.`;
    case "user-required": return `This login on ${host} is for several users. Choose a user, then send again.`;
    case "unreachable": return `Cannot reach ${host}.`;
    default: return `The box refused the send (HTTP ${result.status}).`;
  }
}

// The C8 error codes with a text of their own (any HTTP status).
const CODE_KINDS = {
  browser_receiver_missing: "receiver-missing",
  browser_start_failed: "start-failed",
  browser_disabled: "disabled",
  browser_payload_invalid: "malformed",
  browser_import_failed: "import-failed",
  browser_config_invalid: "config-invalid",
  daemon_disconnected: "daemon-disconnected",
  user_not_logged_in: "user-not-logged-in",
  user_required: "user-required",
};

const MAX_DETAIL = 300;

// The gateway's own text (errmsg) for a browser_* code. It holds no sent value.
function gatewayText(j, code) {
  if (!code.startsWith("browser_")) return "";
  const t = j?.errmsg ?? j?.data?.errmsg;
  return typeof t === "string" ? t.trim().slice(0, MAX_DETAIL) : "";
}

export async function sendState(fetchImpl, { box, user, body, domain }) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  let res;
  try {
    // A redirect would carry the body to another address: never follow one.
    res = await fetchImpl(box + "/api/browser/send?user=" + encodeURIComponent(user), {
      method: "POST",
      credentials: "include",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: text,
    });
  } catch {
    return finish({ kind: "unreachable", status: 0, domain }, box);
  }
  const status = res.status;
  const j = await readJson(res);
  const code = errorCode(j);
  const result = { status, domain };
  if (status === 200) {
    const c = findCounts(j);
    result.kind = "ok";
    result.counts = c && { ...c, errors: Array.isArray(c.errors) ? c.errors.length : 0 };
  } else if (status === 403 && code === "password_login_required") {
    result.kind = "password";
  } else if (status === 401) {
    result.kind = "login";
  } else if (status === 413) {
    result.kind = "too-large";
  } else if (status === 409 && code === "browser_unsupported") {
    result.kind = "unsupported";
  } else if (Object.hasOwn(CODE_KINDS, code)) {
    result.kind = CODE_KINDS[code];
    const d = gatewayText(j, code);
    if (d) result.detail = d;
  } else if (status === 504 || status === 524) {
    result.kind = "timeout";
  } else {
    result.kind = "refused";
  }
  return finish(result, box);
}

function finish(result, box) {
  const out = { ...result, text: resultText(result, box) };
  if (result.kind === "password" || result.kind === "login" || result.kind === "user-not-logged-in") out.link = loginLink(box);
  return out;
}

// ---- the box's users ----

export const noBrowserText = (name) => `No agent browser on this box for ${name}.`;

// The users the popup lists: those with a password login. A user whose
// supported is false is listed but cannot be chosen.
export function userChoices(users) {
  return users.filter((u) => u.password_login).map((u) => (
    u.supported === false
      ? { name: u.name, disabled: true, reason: noBrowserText(u.name) }
      : { name: u.name, disabled: false, reason: "" }));
}

export async function fetchTargets(fetchImpl, box) {
  let res;
  try {
    res = await fetchImpl(box + "/api/browser/targets", { credentials: "include", redirect: "error" });
  } catch {
    return { kind: "unreachable", text: resultText({ kind: "unreachable" }, box) };
  }
  if (res.status === 401 || res.status === 403) {
    return { kind: "login", text: resultText({ kind: "login" }, box), link: loginLink(box) };
  }
  const j = await readJson(res);
  const users = j?.data?.users ?? j?.users;
  if (res.status !== 200 || !Array.isArray(users)) {
    return { kind: "refused", text: resultText({ kind: "refused", status: res.status }, box) };
  }
  return { kind: "ok", users };
}

// ---- the worker's job ----

export function readableSites(origins, boxes) {
  const boxPatterns = new Set(boxes.map((b) => b + "/*"));
  return origins.filter((o) => !boxPatterns.has(o));
}

async function say(chrome, scope, state, text, extra = {}) {
  await chrome.storage.session.set({ lastSend: { state, text, domain: scope.domain, at: Date.now(), ...extra } });
}

// Chrome stops an extension's service worker when one fetch takes more than
// 30 s, and a box may wait 45 s for the agent browser's first start. An
// extension API call every 20 s keeps the worker alive while a send runs.
export const KEEPALIVE_MS = 20000;

const realTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h),
};

export async function runSend(chrome, fetchImpl, msg, timers = realTimers) {
  const { tabId, url, domain, box, user } = msg ?? {};
  let keepalive = null;
  try {
    const { boxes = [] } = await chrome.storage.local.get("boxes");
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      // Falls through to the check below.
    }
    const entry = typeof domain === "string" ? normalizeEntry(domain) : { ok: false };
    if (!boxes.includes(box) || typeof user !== "string" || user === "" || !entry.ok ||
        entry.entry !== domain || !covers(domain, host) || !Number.isInteger(tabId)) {
      return await say(chrome, msg ?? {}, "error", "The send request is not valid.");
    }
    if (isBoxSite(domain, host, boxHosts(boxes))) {
      return await say(chrome, msg ?? {}, "error", BOX_TEXT);
    }
    keepalive = timers.setInterval(() => {
      Promise.resolve()
        .then(() => chrome.runtime.getPlatformInfo())
        .catch(() => {});
    }, KEEPALIVE_MS);
    await say(chrome, msg ?? {}, "reading", `Reading ${domain}...`);
    let built;
    try {
      built = await buildPayload(chrome, { tabId, url, domain, boxes });
    } catch (e) {
      const text = e instanceof SendStop ? e.message : "Could not read this page. Reload the tab and try again.";
      return await say(chrome, msg ?? {}, "error", text);
    }
    if (built.bytes > MAX_SEND_BYTES) {
      return await say(chrome, msg ?? {}, "error", tooLargeText(built.bytes, built.largest));
    }
    await say(chrome, msg ?? {}, "sending", `Sending ${domain} to ${hostOf(box)}...`);
    const result = await sendState(fetchImpl, { box, user, body: built.json, domain });
    const ok = result.kind === "ok";
    let text = result.text;
    if (ok && built.skipped.length > 0) text += ` Left out: ${built.skipped.join(", ")}.`;
    const extra = {};
    if (result.link) extra.link = result.link;
    if (result.counts) extra.counts = result.counts;
    await say(chrome, msg ?? {}, ok ? "done" : "error", text, extra);
  } catch {
    await say(chrome, msg ?? {}, "error", "The send failed.");
  } finally {
    if (keepalive !== null) timers.clearInterval(keepalive);
  }
}

// ---- the hand-off from the popup ----
//
// Chrome closes the popup when it shows its permission dialog, and a message
// from the closing popup to a stopped worker is lost (both measured on
// Chromium 156). So the popup writes the send to storage.session in the same
// task as permissions.request; that write reaches Chrome before the popup
// closes. The worker runs it when storage.onChanged or permissions.onAdded
// wakes it, once Chrome gives the access to the site. A send that waits
// longer than PENDING_MS is dropped.

export const PENDING_MS = 2 * 60 * 1000;

export function siteOrigins(domain) {
  return ["*://*." + domain + "/*"];
}

async function hasAccess(chrome, domain) {
  try {
    return await chrome.permissions.contains({ origins: siteOrigins(domain) });
  } catch {
    return false;
  }
}

// The popup's half: it must start before the click handler's first await.
export function queueSend(chrome, ctx) {
  const pendingSend = {
    tabId: ctx.tabId, url: ctx.url, domain: ctx.domain, box: ctx.box, user: ctx.user, at: Date.now(),
  };
  return chrome.storage.session.set({ pendingSend });
}

// True when the tab still shows the origin of the URL the send was asked
// for. A send can wait for Chrome's dialog, and by then the tab may show
// another site. A tab whose URL Chrome hides (no access) or a closed tab
// does not count.
async function tabShowsOrigin(chrome, tabId, url) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const shown = tab?.pendingUrl || tab?.url;
    return typeof shown === "string" && new URL(shown).origin === new URL(url).origin;
  } catch {
    return false;
  }
}

// The worker's half. Calls run one after another, so one pending send runs once.
let resumeChain = Promise.resolve();

export function resumeSend(chrome, fetchImpl, now) {
  const run = resumeChain.then(() => resumeOnce(chrome, fetchImpl, now ?? Date.now()));
  resumeChain = run.catch(() => {});
  return run;
}

async function resumeOnce(chrome, fetchImpl, now) {
  const { pendingSend: pending, lastSend: last } = await chrome.storage.session.get(["pendingSend", "lastSend"]);
  if (!pending || typeof pending !== "object") return;
  if (!(now - pending.at <= PENDING_MS)) {
    await chrome.storage.session.remove("pendingSend");
    return;
  }
  const { at, ...msg } = pending;
  if (typeof msg.domain !== "string" || !normalizeEntry(msg.domain).ok) {
    await chrome.storage.session.remove("pendingSend");
    await say(chrome, msg, "error", "The send request is not valid.");
    return;
  }
  if (!(await hasAccess(chrome, msg.domain))) {
    if (!(last && last.state === "waiting" && last.at === at && last.domain === msg.domain)) {
      await chrome.storage.session.set({
        lastSend: { state: "waiting", text: `Waiting for Chrome's access to ${msg.domain}...`, domain: msg.domain, at },
      });
    }
    return;
  }
  await chrome.storage.session.remove("pendingSend");
  if (!(await tabShowsOrigin(chrome, msg.tabId, msg.url))) {
    await say(chrome, msg, "error", MOVED_TEXT);
    return;
  }
  await runSend(chrome, fetchImpl, msg);
}

export const STALE_MS = 3 * 60 * 1000;

// What the popup shows for a stored lastSend on this tab's domain, or null.
export function visibleStatus(last, domain, now = Date.now()) {
  if (!last || last.domain !== domain) return null;
  if (last.state === "waiting" && now - last.at > PENDING_MS) {
    return { state: "error", text: `Chrome did not give access to ${domain}.` };
  }
  if ((last.state === "reading" || last.state === "sending") && now - last.at > STALE_MS) {
    return { state: "error", text: "The last send did not finish." };
  }
  return last;
}
