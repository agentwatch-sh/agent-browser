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
 * Defuddle's options in each mode (C11). `main`: Defuddle's defaults (the main content). `whole`: the whole body, with no
 * removal of low-scoring blocks, of Defuddle's selector lists (menus, ads, footers) or of its content patterns. Both
 * modes keep the removal of hidden elements, and both give markdown with no call to a third party.
 */
export function defuddleOptions(url: string, whole: boolean): Record<string, unknown> {
  const base = { url, markdown: true, useAsync: false, removeHiddenElements: true };
  return whole ? { ...base, contentSelector: "body", removeLowScoring: false, removeExactSelectors: false, removePartialSelectors: false, removeContentPatterns: false } : base;
}

/** The conversion's answer. */
export type Converted = { title: string; url: string; content: string; whole: boolean; fallback: boolean };

/**
 * The conversion expression: Defuddle in the world, in `mode`; in `main`, a result with fewer than `fallbackChars`
 * characters (after trimming) is converted again in `whole`, and the answer says so.
 */
export function convertExpression(bundle: string, url: string, mode: "main" | "whole", fallbackChars: number): string {
  return `${FETCH_TAG("convert")} (() => {
  const module = { exports: {} }; const exports = module.exports;
  ${bundle}
  ;
  const D = module.exports && module.exports.default ? module.exports.default : module.exports;
  // Defuddle reads a copy of the document (its cloneNode), and a copy has no layout, so its own rule for hidden elements
  // sees only inline styles there. The copy that it takes carries the rendered page's hidden elements of the body as
  // inline styles (the live computed style: display none, visibility hidden, opacity 0, as Defuddle's own rule), so text
  // that a style sheet hides goes too. The live DOM stays as it is: the copy's function is an own property of this
  // world's document while Defuddle runs.
  const view = document.defaultView, cloneOf = document.cloneNode;
  const hiddenAs = (el) => { const c = view.getComputedStyle(el); return c.display === "none" ? "display:none" : c.visibility === "hidden" ? "visibility:hidden" : c.opacity === "0" ? "opacity:0" : ""; };
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
  const run = (whole) => { const r = new D(document, whole ? ${JSON.stringify(defuddleOptions(url, true))} : ${JSON.stringify(defuddleOptions(url, false))}).parse(); return { title: String(r.title || ""), content: String(r.content || "") }; };
  let whole = ${JSON.stringify(mode === "whole")}, fallback = false, out;
  document.cloneNode = markedCopy;
  try {
    out = run(whole);
    if (!whole && out.content.trim().length < ${Number(fallbackChars)}) { out = run(true); whole = true; fallback = true; }
  } finally { delete document.cloneNode; }
  return { title: out.title || String(document.title || ""), url: String(location.href), content: out.content, whole, fallback };
})()`;
}

let cached: string | null = null;
/** Defuddle's browser build of the pinned package (defuddle/full), read once. */
export function defuddleBundle(): string {
  if (cached === null) cached = readFileSync(createRequire(import.meta.url).resolve("defuddle/full"), "utf8");
  return cached;
}
