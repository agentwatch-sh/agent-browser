// Reading a page cheaply: `outline` numbers the interactive elements on screen, so an agent can
// click `#N` without a screenshot; `net` logs a tab's fetch/XHR and WebSocket traffic, redacted.

import type { Tab } from "./browser.ts";

/** The attribute `outline` writes on each numbered element; `#N` refers to it. */
export const IDX_ATTR = "data-agent-browser-idx";

/** `#N` from outline becomes a selector for that element; anything else is a CSS selector already. */
export function idx(sel: string): string {
  return /^#\d+$/.test(sel) ? `[${IDX_ATTR}="${sel.slice(1)}"]` : sel;
}

export type OutlineElement = { index: number; role: string; type: string | null; label: string; href: string | null };

/** Number the interactive elements on screen (all of them with `all`), in document order. */
export async function outline(tab: Tab, all: boolean): Promise<OutlineElement[]> {
  await tab.assertAllowed();
  return tab.evaluate((all: boolean, attr: string) => {
    document.querySelectorAll(`[${attr}]`).forEach((e) => e.removeAttribute(attr));
    const sel = "a[href], button, input, textarea, select, [role=button], [role=link], [role=menuitem], [role=tab], [role=checkbox], [role=switch], [role=option], [contenteditable=true]";
    const vw = innerWidth, vh = innerHeight;
    const out: { index: number; role: string; type: string | null; label: string; href: string | null }[] = [];
    let n = 0;
    for (const el of document.querySelectorAll<HTMLElement>(sel)) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (!all && (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw)) continue;
      const st = getComputedStyle(el);
      if (st.visibility === "hidden" || st.display === "none") continue;
      el.setAttribute(attr, String(++n));
      const label = (el.getAttribute("aria-label") || el.innerText || (el as HTMLInputElement).placeholder
        || el.getAttribute("title") || (el as HTMLInputElement).value || "").trim().replace(/\s+/g, " ").slice(0, 80);
      out.push({
        index: n,
        role: el.getAttribute("role") ?? el.tagName.toLowerCase(),
        type: el instanceof HTMLInputElement ? el.type : null,
        label,
        href: el instanceof HTMLAnchorElement ? (el.getAttribute("href") ?? "").slice(0, 200) : null,
      });
    }
    return out;
  }, all, IDX_ATTR);
}

/** One line per element, as the human CLI prints it: `#3 button "Save"`. */
export function outlineText(elements: OutlineElement[]): string {
  return elements.map((e) => `#${e.index} ${e.role}${e.type ? ` type=${e.type}` : ""} "${e.label}"${e.href !== null ? ` -> ${e.href.slice(0, 60)}` : ""}`).join("\n");
}

/** Mask JWTs and token/key-looking JSON fields so logs can be shared with agents safely. */
export function redact(s: string): string {
  return s
    .replace(/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, "<jwt>")
    .replace(/("(?:[\w-]*(?:token|secret|password|api_?key|authorization|cookie|session)[\w-]*)"\s*:\s*")[^"]*(")/gi, "$1<redacted>$2")
    .replace(/([?&](?:key|token|api_key|access_token)=)[^&\s"]+/gi, "$1<redacted>");
}

export type NetEntry =
  | { kind: "http"; method: string; url: string; body: string | null; status: number | null; mime: string | null; resp: string | null }
  | { kind: "ws"; direction: "recv" | "sent"; data: string | null };

/** Log the tab's fetch/XHR/EventSource and WebSocket traffic for `seconds`. Never headers; bodies redacted and clipped at `max`. */
export async function netLog(tab: Tab, seconds: number, match: string | undefined, max: number, onEntry: (e: NetEntry) => void = () => {}): Promise<NetEntry[]> {
  await tab.assertAllowed();
  const conn = tab.browser.conn;
  const entries: NetEntry[] = [];
  const emit = (e: NetEntry) => { entries.push(e); onEntry(e); };
  const reqs = new Map<string, { method: string; url: string; body: string | null; status: number | null; mime: string | null }>();
  const clip = (x: string | undefined): string | null => {
    if (!x) return null;
    x = redact(x);
    return x.length > max ? x.slice(0, max) + `…(+${x.length - max})` : x;
  };
  const mine = (sid?: string) => sid === tab.sessionId;
  const offs = [
    conn.on("Network.requestWillBeSent", (p, sid) => {
      if (!mine(sid) || !["Fetch", "XHR", "EventSource"].includes(p.type)) return;
      if (match && !p.request.url.includes(match)) return;
      reqs.set(p.requestId, { method: p.request.method, url: redact(p.request.url), body: clip(p.request.postData), status: null, mime: null });
    }),
    conn.on("Network.responseReceived", (p, sid) => {
      const r = mine(sid) && reqs.get(p.requestId);
      if (r) { r.status = p.response.status; r.mime = p.response.mimeType; }
    }),
    conn.on("Network.loadingFinished", async (p, sid) => {
      const r = mine(sid) && reqs.get(p.requestId);
      if (!r) return;
      reqs.delete(p.requestId);
      let resp: string | null = null;
      try {
        const { body, base64Encoded } = await tab.send("Network.getResponseBody", { requestId: p.requestId });
        resp = base64Encoded ? `(${body.length} b64 chars)` : clip(body);
      } catch { /* streamed or evicted */ }
      emit({ kind: "http", ...r, resp });
    }),
    conn.on("Network.webSocketFrameReceived", (p, sid) => {
      if (mine(sid)) emit({ kind: "ws", direction: "recv", data: clip(p.response.payloadData) });
    }),
    conn.on("Network.webSocketFrameSent", (p, sid) => {
      if (mine(sid)) emit({ kind: "ws", direction: "sent", data: clip(p.response.payloadData) });
    }),
  ];
  try {
    await tab.send("Network.enable", { maxPostDataSize: 65536 });
    await new Promise((r) => setTimeout(r, seconds * 1000));
  } finally {
    for (const off of offs) off();
  }
  return entries;
}
