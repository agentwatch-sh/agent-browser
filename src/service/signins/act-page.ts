// The act's reads of the act tab's page (contract C11, the sign-in act's form rules; the stored sign-ins design, section
// 7.4): each one a function that the service evaluates in an isolated world of its own (Page.createIsolatedWorld), so
// the page's scripts cannot change what the service reads: the world has its own globals and its own prototypes, and a
// page that defines an input named `method` or `action` in its form does not change the form's method or action here.
// No function takes or returns a value that the act types: the values go to Chrome only in the act tab's Input calls.
// Each function's text starts with its tag, so a test's fake page can tell them apart.

/** The tag at the start of each function's text. */
export const PAGE_TAG = (name: string) => `/*aw-act:${name}*/`;

/** The read of the page (act-rules.ts, PageRead): the main frame's URL and origin, its inputs in document order, its forms, the viewport. */
export const READ_PAGE = `${PAGE_TAG("read")} () => {
  const get = (proto, key, el) => Object.getOwnPropertyDescriptor(proto, key).get.call(el);
  const vis = (el) => { const r = el.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return false; const cs = getComputedStyle(el); return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0; };
  const forms = [...document.forms];
  const inputs = [...document.querySelectorAll("input")];
  const fields = inputs.map((el, i) => {
    const r = el.getBoundingClientRect(), f = get(HTMLInputElement.prototype, "form", el);
    return { i, type: String(get(HTMLInputElement.prototype, "type", el) || "text").toLowerCase(), visible: vis(el), enabled: !get(HTMLInputElement.prototype, "disabled", el),
      form: f ? forms.indexOf(f) : null, autocomplete: String(el.getAttribute("autocomplete") || "").toLowerCase(), name: String(el.getAttribute("name") || "").toLowerCase(),
      id: String(el.getAttribute("id") || "").toLowerCase(), maxLength: Number(get(HTMLInputElement.prototype, "maxLength", el)), box: { x: r.left, y: r.top, w: r.width, h: r.height } };
  });
  let framePassword = false;
  for (const fr of document.querySelectorAll("iframe, frame")) { try { if (fr.contentDocument && fr.contentDocument.querySelector("input[type=password]")) framePassword = true; } catch (e) {} }
  return { href: location.href, origin: location.origin, fields,
    forms: forms.map((f) => ({ method: String(get(HTMLFormElement.prototype, "method", f)), action: String(get(HTMLFormElement.prototype, "action", f)) })),
    framePassword, viewport: { width: innerWidth, height: innerHeight } };
}`;

/** The box of input `i` after it scrolls into view (as a person scrolls to a field), or null when it is gone. */
export const FIELD_BOX = `${PAGE_TAG("box")} (i) => {
  const el = document.querySelectorAll("input")[i];
  if (!el) return null;
  el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}`;

/** The box of the visible submit button of form `f` after it scrolls into view, or null (the act then presses Enter in the password field). */
export const SUBMIT_BOX = `${PAGE_TAG("submit")} (f) => {
  const form = document.forms[f];
  if (!form) return null;
  const vis = (el) => { const r = el.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return false; const cs = getComputedStyle(el); return cs.visibility !== "hidden" && cs.display !== "none"; };
  for (const el of form.querySelectorAll("button, input")) {
    const type = String(el.getAttribute("type") || (el.tagName === "BUTTON" ? "submit" : "text")).toLowerCase();
    if ((type === "submit" || type === "image") && !el.disabled && vis(el)) {
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    }
  }
  return null;
}`;

/**
 * C11's form rule 7, the type watch: a MutationObserver on the `type` attribute of password field `i`. When the type
 * changes, its callback empties the field (before the page paints again) and marks the world's flag, which the act reads
 * before each key. The observer and the flag live in the act's world: no page script sees them.
 */
export const TYPE_WATCH = `${PAGE_TAG("watch")} (i) => {
  const el = document.querySelectorAll("input")[i];
  if (!el) return false;
  const flag = { hit: false };
  globalThis.__awActWatch = flag;
  const mo = new MutationObserver(() => { if (String(el.getAttribute("type") || "").toLowerCase() !== "password" || el.type !== "password") { el.value = ""; flag.hit = true; } });
  mo.observe(el, { attributes: true, attributeFilter: ["type"] });
  return true;
}`;

/** The type watch's flag: true after a change of the type, false before, null when the world has no watch (a new document). */
export const WATCH_HIT = `${PAGE_TAG("hit")} () => (globalThis.__awActWatch ? globalThis.__awActWatch.hit : null)`;

/** The clean end's first step: every input and textarea of the main frame is empty (hidden ones too: a page can copy a value there). */
export const EMPTY_INPUTS = `${PAGE_TAG("empty")} () => {
  let n = 0;
  const keep = new Set(["checkbox", "radio", "file", "submit", "button", "reset", "image"]);
  for (const el of document.querySelectorAll("input, textarea")) { if (el.tagName === "INPUT" && keep.has(String(el.type).toLowerCase())) continue; el.value = ""; n++; }
  return n;
}`;

/** The page's origin and its localStorage items (the leak check and the move read them for the credential's origin only). */
export const READ_LOCAL = `${PAGE_TAG("local")} () => {
  const items = {};
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k !== null) items[k] = String(localStorage.getItem(k)); } } catch (e) { return { origin: location.origin, items: null }; }
  return { origin: location.origin, items };
}`;

/** The act window's title marker (the X move finds its window by it): the page is about:blank, so no page sees it. */
export const MARK_TITLE = `${PAGE_TAG("mark")} (m) => { document.title = m; return document.title === m; }`;

/** The text of one evaluation of `fn` with JSON arguments (numbers and the marker only: never a value that the act types). */
export const call = (fn: string, ...args: (number | string)[]) => `(${fn})(${args.map((a) => JSON.stringify(a)).join(", ")})`;
