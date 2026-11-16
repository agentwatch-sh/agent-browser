// PageFetch's reads of the fetch tab's page (contract C11, "PageFetch"; the PageFetch design, sections 5.5 and 5.6;
// board ab-v16.102). Each one runs in a new isolated world of the tab (Page.createIsolatedWorld, grantUniversalAccess
// false): the world has its own globals, so the page's scripts cannot see the reads, change them or change their result.
//
// The conversion is Defuddle's own browser build of the pinned package (defuddle/full: dist/index.full.js, which carries
// its markdown step), read once from the installed package and wrapped in a function that gives it a `module` of its own,
// so it sets no global, also not in the world. Defuddle reads a copy of the document; the live DOM stays as it is.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

/** The tag at the start of each read's text, so that a test's fake page can tell them apart. */
export const FETCH_TAG = (name: string) => `/*aw-fetch:${name}*/`;

/**
 * The challenge marks that the check read looks for (C11: from the challenge vendors' public documentation, never from a
 * live probe). A click mark needs a person's click, drag or hold: the fetch ends `blocked` at once. A check mark is a
 * check page that can pass with no input (a proof of work, a JavaScript check): the fetch waits for its navigation, and a
 * page that is still a check page at the ready limit ends `blocked`.
 */
export const CHALLENGES = {
  /** The frames of a check that needs a click: [a part of the frame's URL, the check's name]. */
  clickFrames: [
    ["hcaptcha.com", "hCaptcha"],
    ["/recaptcha/api2/anchor", "reCAPTCHA"],
    ["/recaptcha/enterprise/anchor", "reCAPTCHA"],
    ["captcha-delivery.com", "DataDome"],
    ["arkoselabs.com", "Arkose Labs"],
    ["funcaptcha.com", "Arkose Labs"],
  ],
  /** The elements of a check that needs a click: [a CSS selector, the check's name]. */
  clickMarks: [
    ["#px-captcha", "HUMAN (PerimeterX)"],
    [".h-captcha", "hCaptcha"],
    ["#captcha-container[data-awswaf], awswaf-captcha", "AWS WAF"],
  ],
  /** The texts of a check that needs a click: [a part of the page's text, the check's name]. */
  clickTexts: [
    ["Verify you are human by completing the action below", "Cloudflare"],
    ["Press & Hold", "HUMAN (PerimeterX)"],
    ["Press and hold the button", "HUMAN (PerimeterX)"],
  ],
  /** The elements of a check page that can pass with no input. */
  checkMarks: [
    ["#challenge-running, #challenge-stage, #challenge-form, #cf-challenge-running", "Cloudflare"],
    ["#anubis_challenge, script[src*='/.within.website/x/cmd/anubis/']", "Anubis"],
  ],
  /** The titles of a check page that can pass with no input (the whole title, any case). */
  checkTitles: [
    ["just a moment...", "Cloudflare"],
    ["making sure you're not a bot!", "Anubis"],
    ["ddos-guard", "DDoS-Guard"],
    ["vercel security checkpoint", "Vercel"],
  ],
} as const;

/** The check read's answer (CHECK_READ). */
export type CheckRead = { title: string; text: string; frames: { src: string; visible: boolean }[]; marks: { click: string[]; check: string[] } };

/** The read of the page for the challenge check: its title, the start of its text, its frames and the marks it holds. */
export const CHECK_READ = `${FETCH_TAG("check")} (click, check) => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const has = (sel) => { try { return !!document.querySelector(sel); } catch (e) { return false; } };
  return {
    title: String(document.title || ""),
    text: String(document.body ? document.body.innerText : "").slice(0, 4000),
    frames: [...document.querySelectorAll("iframe, frame")].slice(0, 50).map((f) => ({ src: String(f.getAttribute("src") || ""), visible: vis(f) })),
    marks: { click: click.filter(has), check: check.filter(has) },
  };
}`;

/** The challenge of a page: a click check (`blocked` at once), a check page (wait), or none. `frameUrls`: the URLs of the tab's frames that CDP gives. */
export function challengeOf(read: CheckRead, frameUrls: readonly string[]): { click: string } | { check: string } | null {
  const frames = [...read.frames.filter((f) => f.visible).map((f) => f.src), ...frameUrls];
  for (const [part, name] of CHALLENGES.clickFrames) {
    // reCAPTCHA's invisible form needs no click.
    if (frames.some((u) => u.includes(part) && !u.includes("size=invisible"))) return { click: name };
  }
  for (const [sel, name] of CHALLENGES.clickMarks) if (read.marks.click.includes(sel)) return { click: name };
  for (const [part, name] of CHALLENGES.clickTexts) if (read.text.includes(part)) return { click: name };
  for (const [sel, name] of CHALLENGES.checkMarks) if (read.marks.check.includes(sel)) return { check: name };
  const title = read.title.trim().toLowerCase();
  for (const [t, name] of CHALLENGES.checkTitles) if (title === t) return { check: name };
  return null;
}

/** The argument list of CHECK_READ. */
export const checkArgs = (): [string[], string[]] => [CHALLENGES.clickMarks.map(([s]) => s), CHALLENGES.checkMarks.map(([s]) => s)];

/**
 * A bot check page that the site answers with an error status (board ab-v16.107): the answer stays `ok` (an error page can
 * say why), and its header gets CHECK_PAGE_NOTE. PageFetch never clicks, never waits for such a check to pass and never
 * tries again. A page is one when its status is one of CHECK_PAGE_STATUSES and its title (the check read's, the whole
 * title in any case, its spaces collapsed) is one of CHECK_PAGE_TITLES.
 */
export const CHECK_PAGE_STATUSES: readonly number[] = [401, 403, 429, 503];
export const CHECK_PAGE_NOTE = "Note: the page looks like a bot check page; its content is the check, not the page.";
/**
 * The titles of the check pages: [the title in lower case, its source]. DataDome and AWS WAF have no fixed title (a
 * DataDome page's title is the site's own name; AWS WAF documents none); the check read finds their checks by their
 * frames and elements (CHALLENGES), and the fetch ends `blocked`.
 */
export const CHECK_PAGE_TITLES: readonly (readonly [string, string])[] = [
  // Cloudflare: its challenge page (Cloudflare's documentation, "Challenge pages"; also a check title of CHALLENGES).
  ["just a moment...", "Cloudflare"],
  // Cloudflare: its block page (for example error 1020, a WAF rule; Cloudflare's documentation of its error pages).
  ["attention required! | cloudflare", "Cloudflare"],
  // Cloudflare: the interstitial of its "I'm Under Attack" mode before the managed challenge.
  ["please wait... | cloudflare", "Cloudflare"],
  // Cloudflare: the line of its challenge page ("Verifying you are human. This may take a few seconds."); the lead's
  // list (board ab-v16.107) names it as a check title.
  ["verifying you are human", "Cloudflare"],
  // A check page that answered 401 on the real-page check of 2026-11-15 (board ab-v16.107; vendor not named).
  ["security verification", "a site's check page"],
  // Akamai: its edge's deny page ("You don't have permission to access ..." with a reference number).
  ["access denied", "Akamai"],
  // HUMAN (PerimeterX): the titles of its enforcers' block and captcha templates (PerimeterX/perimeterx-java-sdk,
  // block_template.mustache and captcha_template.mustache).
  ["access to this page has been denied.", "HUMAN (PerimeterX)"],
  ["access to this page has been denied", "HUMAN (PerimeterX)"],
  // Imperva (Incapsula): the block page of its Advanced Bot Protection (formerly Distil Networks).
  ["pardon our interruption", "Imperva"],
  // DDoS-Guard: its check page (also a check title of CHALLENGES).
  ["ddos-guard", "DDoS-Guard"],
  // Vercel: its Security Checkpoint, answered with 429 (also a check title of CHALLENGES).
  ["vercel security checkpoint", "Vercel"],
  // Anubis: its proof-of-work page (also a check title of CHALLENGES).
  ["making sure you're not a bot!", "Anubis"],
  // Sucuri: the block page of its website firewall.
  ["sucuri website firewall - access denied", "Sucuri"],
];

/** Whether a page with this status and this title looks like a bot check page (CHECK_PAGE_NOTE). */
export function looksLikeCheckPage(status: number | null, title: string): boolean {
  if (status === null || !CHECK_PAGE_STATUSES.includes(status)) return false;
  const t = title.replace(/\s+/g, " ").trim().toLowerCase();
  return CHECK_PAGE_TITLES.some(([x]) => x === t);
}

/**
 * The roots of the common consent managers' layers (board ab-v16.107). The copy of the document that Defuddle reads drops
 * each one with its content, in both modes: a consent manager's partner list is no part of the page, and a person sees it
 * only after opening the consent layer (the real-page check of 2026-11-15: 833,174 characters of a partner list in place
 * of a museum's object record). A root matches by a whole id, a whole class name, or (Sourcepoint) its id prefix with a
 * number after it; never by a part of a name, so a page's own `consent-article` stays. Each source: the markup that the
 * vendor's public script adds (the names that its documentation gives for custom styles).
 */
export const CONSENT_ROOTS: readonly { vendor: string; ids?: readonly string[]; classes?: readonly string[]; numberedIds?: readonly string[] }[] = [
  // OneTrust: the root of its banner script (otBannerSdk.js), the banner, the preference center and its backdrop.
  { vendor: "OneTrust", ids: ["onetrust-consent-sdk", "onetrust-banner-sdk", "onetrust-pc-sdk"], classes: ["onetrust-pc-dark-filter"] },
  // Cookiebot (Usercentrics): the dialog of its script (consent.cookiebot.com/uc.js), its underlay and its reopen widget.
  { vendor: "Cookiebot", ids: ["CybotCookiebotDialog", "CybotCookiebotDialogBodyUnderlay", "CookiebotWidget"] },
  // Didomi: the host element of its web SDK (sdk.privacy-center.org).
  { vendor: "Didomi", ids: ["didomi-host"] },
  // Usercentrics: the roots of its browser UI, version 2 and version 3 (app.usercentrics.eu, web.cmp.usercentrics.eu).
  { vendor: "Usercentrics", ids: ["usercentrics-root", "usercentrics-cmp-ui"] },
  // Sourcepoint: the container of each message of its script (wrapperMessagingWithoutDetection.js): its id is
  // `sp_message_container_` and the message's number.
  { vendor: "Sourcepoint", numberedIds: ["sp_message_container_"] },
  // Quantcast Choice: the container of its CMP 2 script (cmp2.js).
  { vendor: "Quantcast Choice", ids: ["qc-cmp2-container"], classes: ["qc-cmp2-container"] },
  // TrustArc: the banner and the overlays of its notice script (consent.trustarc.com/notice).
  { vendor: "TrustArc", ids: ["consent_blackbar", "truste-consent-track"], classes: ["truste_box_overlay", "truste_overlay"] },
  // Osano: the window of its consent manager (cmp.osano.com), its dialog and its info dialog.
  { vendor: "Osano", classes: ["osano-cm-window", "osano-cm-dialog", "osano-cm-info-dialog"] },
  // iubenda: the banner and the preference frame of its Cookie Solution (cdn.iubenda.com/cs).
  { vendor: "iubenda", ids: ["iubenda-cs-banner", "iubenda-iframe"] },
  // CookieYes: the banner, the preference modal and the overlay of its script (cdn-cookieyes.com); the bar and the
  // settings popup of its older WordPress plugin (CookieLawInfo).
  { vendor: "CookieYes", ids: ["cookie-law-info-bar", "cliSettingsPopup"], classes: ["cky-consent-container", "cky-modal", "cky-overlay"] },
  // Complianz: the banner of its WordPress plugin.
  { vendor: "Complianz", ids: ["cmplz-cookiebanner-container"], classes: ["cmplz-cookiebanner"] },
  // consentmanager.net: the wrapper, the box and the backdrop of its script (cdn.consentmanager.net).
  { vendor: "consentmanager.net", ids: ["cmpwrapper", "cmpbox", "cmpbox2"] },
  // Google Funding Choices (Privacy & messaging): the roots of its consent and its CCPA messages.
  { vendor: "Google Funding Choices", classes: ["fc-consent-root", "fc-ccpa-root"] },
  // Borlabs Cookie: the box, its wrapper and its reopen widget (its WordPress plugin).
  { vendor: "Borlabs Cookie", ids: ["BorlabsCookieBox", "BorlabsCookieBoxWrap", "BorlabsCookieWidget"] },
  // Termly: the container of its consent banner (app.termly.io).
  { vendor: "Termly", ids: ["termly-code-snippet-support"] },
  // Ketch: the root of its Smart Tag's UI (global.ketchcdn.com).
  { vendor: "Ketch", ids: ["lanyard_root"] },
  // Axeptio: the overlay and the mount of its SDK (static.axept.io).
  { vendor: "Axeptio", ids: ["axeptio_overlay"], classes: ["axeptio_mount"] },
  // Klaro: its root element (its documentation: the default `elementID`, "klaro").
  { vendor: "Klaro", ids: ["klaro"] },
  // Civic Cookie Control: its root element (cc.cdn.civiccomputing.com).
  { vendor: "Civic Cookie Control", ids: ["ccc"] },
  // Cookie Information: the overlay and the template wrapper of its script (policy.app.cookieinformation.com).
  { vendor: "Cookie Information", ids: ["coiOverlay", "cookie-information-template-wrapper"] },
];

/** The consent roots for the conversion: every id, class name and numbered id prefix. */
export const consentArgs = (): { ids: string[]; classes: string[]; numbered: string[] } => ({
  ids: CONSENT_ROOTS.flatMap((r) => r.ids ?? []),
  classes: CONSENT_ROOTS.flatMap((r) => r.classes ?? []),
  numbered: CONSENT_ROOTS.flatMap((r) => r.numberedIds ?? []),
});

/**
 * The header's note for a page whose consent layer the safety rule kept (board ab-v16.109; the conversion's
 * `consentLayer`): the page's own content may need a consent. The answer stays `ok`: PageFetch never clicks, never waits
 * for a consent and never tries again.
 */
export const CONSENT_LAYER_NOTE = "Note: the page shows a consent layer; its content may need a consent, which PageFetch never gives.";

/**
 * Defuddle's options in each mode (C11). `main`: Defuddle's defaults (the main content). `whole`: the whole body, with no
 * removal of low-scoring blocks, of Defuddle's selector lists (menus, ads, footers) or of its content patterns. Both
 * modes keep the removal of hidden elements, and both give markdown with no call to a third party.
 */
export function defuddleOptions(url: string, whole: boolean): Record<string, unknown> {
  const base = { url, markdown: true, useAsync: false, removeHiddenElements: true };
  return whole ? { ...base, contentSelector: "body", removeLowScoring: false, removeExactSelectors: false, removePartialSelectors: false, removeContentPatterns: false } : base;
}

/** The conversion's answer; `consentLayer`: the safety rule kept a consent manager's root (CONSENT_LAYER_NOTE). */
export type Converted = { title: string; url: string; content: string; whole: boolean; fallback: boolean; consentLayer: boolean };

/**
 * The conversion expression: Defuddle in the world, in `mode`; in `main`, a result with fewer than `fallbackChars`
 * characters (after trimming) is converted again in `whole`, and the answer says so. In both modes the copy that Defuddle
 * reads has no element that the rendered page hides (board ab-v16.110), and no consent manager's layer (CONSENT_ROOTS),
 * unless the page has fewer than `fallbackChars` characters of text outside it: then only the layer's visible part
 * stays, and the answer's `consentLayer` says so.
 */
export function convertExpression(bundle: string, url: string, mode: "main" | "whole", fallbackChars: number): string {
  return `${FETCH_TAG("convert")} (() => {
  const module = { exports: {} }; const exports = module.exports;
  ${bundle}
  ;
  const D = module.exports && module.exports.default ? module.exports.default : module.exports;
  // Defuddle reads a copy of the document (its cloneNode), and a copy has no layout, so its own rule for hidden elements
  // sees only inline styles there. The copy that it takes carries the rendered page's hidden elements of the body as
  // inline styles (the live computed style: display none or visibility hidden), so text that a style sheet hides goes
  // too. Opacity 0 is not a sign of hidden text: many pages fade a section in as the reader scrolls to it (review-171 N1). The live DOM stays as it is: the copy's function is an own property of this
  // world's document while Defuddle runs.
  const view = document.defaultView, cloneOf = document.cloneNode;
  const hiddenAs = (el) => { const c = view.getComputedStyle(el); return c.display === "none" ? "display:none" : c.visibility === "hidden" ? "visibility:hidden" : ""; };
  const markedCopy = function (deep) {
    const copy = cloneOf.call(document, deep);
    try {
      if (view && typeof view.getComputedStyle === "function" && document.body && copy.body) {
        const live = document.body.querySelectorAll("*"), dead = copy.body.querySelectorAll("*");
        if (live.length === dead.length) for (let i = 0; i < live.length; i++) { const h = hiddenAs(live[i]); if (h) dead[i].setAttribute("style", h); }
      }
    } catch (e) {}
    return copy;
  };
  // No hidden element (board ab-v16.110): each copy that Defuddle reads loses each element that it marks hidden (above),
  // in both modes, so no retry of Defuddle brings one back: its retries for little content (with no removal of hidden
  // elements, and with its largest hidden block), its schema.org retry, its index retry, and main's fallback to whole
  // (the museum's object page: a closed partner list that no consent root matches gave 833,174 characters in main). It
  // runs where the drop of the consent layer runs, before it: after Defuddle's flattening of shadow roots, which pairs
  // the live elements with the copy's by their order. A mark of display none takes the element with its content.
  // Visibility is inherited, so in an element that visibility hidden marks, each element of the copy (\`before\`: the
  // copy's elements before the flattening) with no mark is one that the page shows again (visibility visible): that
  // element stays without its own text and without its mark (else Defuddle's own rule takes it), so the shown text
  // stays; an element with no shown element in it goes. The flattening's own elements (a shadow root's content, the div
  // that replaces a custom-element host) have no mark of their own and never count as shown (review-183 B2); a host's
  // mark goes to its replacement (markedReplace, below). A class alone (hidden, invisible) is no mark: Tailwind's
  // "hidden md:block" shows at a wide window (review note N4).
  const dropHidden = (copy, before) => {
    try {
      if (!copy || !copy.body) return;
      for (const el of copy.body.querySelectorAll('[style="display:none"]')) el.remove();
      const ghosts = [...copy.body.querySelectorAll('[style="visibility:hidden"]')];
      const shownIn = (g) => { for (const el of g.querySelectorAll(':not([style="visibility:hidden"])')) if (before.has(el)) return true; return false; };
      for (let i = ghosts.length - 1; i >= 0; i--) {
        const g = ghosts[i];
        if (!shownIn(g)) { g.remove(); continue; }
        g.removeAttribute("style");
        for (const n of [...g.childNodes]) if (n.nodeType === 3) n.remove();
      }
    } catch (e) {}
  };
  // The consent layer (board ab-v16.107): each copy drops the consent managers' roots (CONSENT_ROOTS) with their content,
  // after Defuddle's flattening of shadow roots, which pairs the live elements with the copy's by their order (a drop
  // before it would put a shadow root's content into another element), and which brings a layer in a shadow host into
  // the copy. In the layer, each element whose aria-hidden is "true" or that has the hidden attribute goes too. The
  // safety rule: when the copy has fewer than ${Number(fallbackChars)} characters of text outside the roots (a page whose content is
  // the consent layer), the roots stay, and only those hidden parts of the layer go: each element of the layer that the
  // copy marked hidden went before, with the copy's other hidden elements (dropHidden; board ab-v16.109 found that
  // Defuddle's retries for little content take a partner list that a style sheet closes). Outside the roots the drop
  // touches nothing. Then the answer says that the page shows a consent layer (consentLayer).
  const consent = ${JSON.stringify(consentArgs())};
  const ids = new Set(consent.ids), classes = new Set(consent.classes);
  const digits = (s) => s.length > 0 && [...s].every((c) => c >= "0" && c <= "9");
  const isRoot = (el) => {
    const id = el.getAttribute("id") || "";
    if (id && (ids.has(id) || consent.numbered.some((p) => id.startsWith(p) && digits(id.slice(p.length))))) return true;
    return (el.getAttribute("class") || "").split(/[ \\t\\n\\r\\f]+/).some((c) => classes.has(c));
  };
  const unseen = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
  let consentLayer = false;
  const textOutside = (body, roots, limit) => {
    let n = 0;
    for (const stack = [body]; stack.length && n < limit;) {
      const node = stack.pop();
      if (node.nodeType === 3) { n += String(node.data).split(/[ \\t\\n\\r\\f]+/).join(" ").trim().length; continue; }
      if (node.nodeType !== 1 || roots.has(node) || unseen.has(String(node.tagName).toUpperCase()) || node.hasAttribute("hidden")) continue;
      for (let c = node.lastChild; c; c = c.previousSibling) stack.push(c);
    }
    return n;
  };
  const dropConsent = (copy) => {
    try {
      if (!copy || !copy.body) return;
      const roots = [];
      for (const el of copy.body.querySelectorAll("*")) if (isRoot(el) && !roots.some((r) => r.contains(el))) roots.push(el);
      if (roots.length === 0) return;
      for (const r of roots) for (const el of [r, ...r.querySelectorAll('[aria-hidden="true"], [hidden]')]) if (el.getAttribute("aria-hidden") === "true" || el.hasAttribute("hidden")) el.remove();
      if (textOutside(copy.body, new Set(roots), ${Number(fallbackChars)}) >= ${Number(fallbackChars)}) { for (const r of roots) r.remove(); return; }
      if (roots.some((r) => copy.body.contains(r))) consentLayer = true;
    } catch (e) {}
  };
  // Defuddle's flattening replaces a custom-element host with a new div that has no attribute: the host's mark goes to
  // that div, so a host that the page hides stays hidden in the copy (review-183 B2).
  const markedReplace = (replace) => function (el, html, doc) {
    const mark = el && el.getAttribute ? el.getAttribute("style") : null, parent = el && el.parentNode, next = el && el.nextSibling;
    const r = replace.call(this, el, html, doc);
    try {
      if ((mark === "display:none" || mark === "visibility:hidden") && parent && el.parentNode !== parent) {
        const div = next ? next.previousSibling : parent.lastChild;
        if (div && div.nodeType === 1) div.setAttribute("style", mark);
      }
    } catch (e) {}
    return r;
  };
  const run = (whole) => {
    const d = new D(document, whole ? ${JSON.stringify(defuddleOptions(url, true))} : ${JSON.stringify(defuddleOptions(url, false))});
    // defuddle/full's class holds the core parser as its \`defuddle\`.
    const core = [d.defuddle, d].find((x) => x && typeof x.flattenShadowRoots === "function");
    if (core) {
      const flatten = core.flattenShadowRoots;
      core.flattenShadowRoots = function (live, copy) {
        const before = new Set(copy && copy.body ? copy.body.querySelectorAll("*") : []);
        try { return flatten.call(this, live, copy); } finally { dropHidden(copy, before); dropConsent(copy); }
      };
      if (typeof core.replaceShadowHost === "function") core.replaceShadowHost = markedReplace(core.replaceShadowHost);
    }
    const r = d.parse();
    return { title: String(r.title || ""), content: String(r.content || "") };
  };
  let whole = ${JSON.stringify(mode === "whole")}, fallback = false, out;
  document.cloneNode = markedCopy;
  try {
    out = run(whole);
    if (!whole && out.content.trim().length < ${Number(fallbackChars)}) { out = run(true); whole = true; fallback = true; }
  } finally { delete document.cloneNode; }
  return { title: out.title || String(document.title || ""), url: String(location.href), content: out.content, whole, fallback, consentLayer };
})()`;
}

let cached: string | null = null;
/** Defuddle's browser build of the pinned package (defuddle/full), read once. */
export function defuddleBundle(): string {
  if (cached === null) cached = readFileSync(createRequire(import.meta.url).resolve("defuddle/full"), "utf8");
  return cached;
}
