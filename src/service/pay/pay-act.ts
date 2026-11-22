// The payment act after the operator's approval (contract C11, the card payment: the act, the table of what the agent
// sees, the keep; C12's `pay` event; the secure card checkout design, sections 8.4 to 8.8; board ab-sta.7, the plan's Task
// 5b). It is PayRequests' `act` (request.ts): it gets the request's context with the act window that the preparation
// holds (act.ts, PayActWindow), types the card's values into the provider frame's fields with the person's input, presses
// the pay button and reads the result. PayRequests ends the window (its clean end) at the request's end: the act does not.
//
// The order (C11):
//  1. The abort (the service's stop). The card's values from the store again (ctx.openCard: a locked store stops).
//  2. The page's order again (order.ts: readOrder, orderForRequest, orderHash): another hash than the approved one stops.
//  3. The guard on (guard.ts): a request whose URL holds the number fails everywhere; a body with it fails outside the
//     providers. A number that the guard finds before the press stops the act.
//  4. The card fields found again (fields.ts, findCardFields), only in provider frames; from here a new page of the act
//     tab or of a provider frame stops the act (the frame loaded again), and never a key goes into a frame that was not
//     found.
//  5. Before the first key: no popup and no other tab in the act window, and a read of its tabs that works (review-227
//     N5c, review-228 N5: else the lost window's text), no open WebSocket or WebTransport to a host outside the act's list
//     (review-227 N1, the sign-in act's form rule 6), no frame or worker where the guard could not start (review-228 N6:
//     both with the text of the act's rules), and a pay button on the page (else C11's text, with no key typed).
//  6. Under the browser's input lock: each save-card box near the card fields unticked (else C11's stop); C12's `pay`
//     start; each value typed with the person's input (the generator's keys, else Input.insertText), into the provider
//     frame's field after a person's click on it, each key on that frame's own session (board ab-sta.8: a key that races a
//     page script's focus reaches no field of the page); before each key the frame's own world still lives, its field has the
//     focus of its document, and the act page's own focus is on the provider frame (review-228 B1: an out-of-process
//     frame keeps its active field when the page takes the focus); the save-card boxes again (review-228 N3); the pay
//     button (the form's submit button, a button whose text says pay, buy or place order, or the agent's hint) and the
//     path to it; then the total and the save-card boxes read once more (review-228 N4), and C11's stops in their order:
//     the guard, a lock of the store, the act tab lost, the act's 5 minutes, the abort; then the keep's `unknown`
//     (ctx.keepUnknown: a write that fails stops), and the press at once. The keep's write comes last because it marks
//     the request as pressed: PayRequests turns each later end that is no result into Unknown.
//     A request that takes the card's number to a provider before the press (the page pays when the card is complete;
//     review-228 N8, the lead's call) writes the keep's `unknown` at once: each later end before the press is Unknown,
//     with the Unknown text, and a write that fails at that moment stops the act at once, also as Unknown.
//  7. After the press: the act's rules stay as they were at the fill, and the guard still decides each request (board
//     ab-sta.8: Chrome applies the act's rules before the act's Fetch sees a request, so the act cannot learn a new origin
//     after the press; the rules hold the act's provider's frame and API origins from the start, act.ts; a top-level GET
//     stays open, C5, so a confirmation on another host still loads). The result reader (result.ts) reads the page for
//     up to 60 s.
//  8. The end: each provider frame's fields empty (review-227 N5a), C12's `pay` end, the card's buffers filled with zeros
//     (review-227 N5b: here, in a finally, not by the window's hold alone).
//
// The log rule (C11): no log line holds a value of the card, the page's text, a URL path, a query or the host of a
// request that the guard or the block stopped.

import { randomBytes } from "node:crypto";
import { CdpPlayer } from "../../human/cdp-player.ts";
import { charKey, typingPace, type KeyEv } from "../../human/keys.ts";
import { planPath, startPoint, type Pt } from "../../human/path.ts";
import type { Person } from "../../human/person.ts";
import { holdMs, pauseMs, spreadPoint, type Box } from "../../human/press.ts";
import type { Random } from "../../human/random.ts";
import { openOutside } from "../signins/act-rules.ts";
import { call } from "../signins/act-page.ts";
import { PayActWindow, providerOfFields } from "./act.ts";
import type { CardView } from "./digits.ts";
import { findCardFields, PAY_TAG, type ActFrame, type CardFields, type CardRole, type FieldRead } from "./fields.ts";
import { payGuard } from "./guard.ts";
import { orderForRequest, orderHash, readOrder } from "./order.ts";
import { isProviderOrigin, providerHosts } from "./providers.ts";
import type { CardBuffers, PayActContext, PayActEnd } from "./request.ts";
import { baselineOf, READ_VIEW, readResult, RESULT_LIMITS, type Baseline, type FrameView } from "./result.ts";
import { PAY_TEXT } from "./texts.ts";

/** The first values (C11; the sign-in act's where C11 names none). */
export const PAY_FILL_LIMITS = {
  /** The act ends at most 5 minutes after its first key. */
  actMs: 5 * 60_000,
  /** The result window after the press. */
  resultMs: RESULT_LIMITS.resultMs,
  /** After a new page of the main frame, this long with no navigation before the result's read. */
  settleMs: 1_000,
  /** The turn of the result's reads. */
  pollMs: 250,
} as const;
export type PayFillLimits = { -readonly [K in keyof typeof PAY_FILL_LIMITS]: number };

/** What the model gives the act (model.ts, actPort): its bridge, its events, the browser's input lock and the scope's person. */
export interface PayActModel {
  call<T = any>(op: string, args?: unknown[], o?: { wait?: number }): Promise<T>;
  listen(fn: (ev: Record<string, any>) => void): () => void;
  inputLock<T>(fn: () => Promise<T>): Promise<T>;
  person(scope: string): Person;
  random: Random;
}
export type PayActOptions = {
  model: PayActModel;
  log: (line: string) => void;
  /** Tests only: the test merchant's provider origins, never in the shipped list. */
  providerOrigins?: readonly string[];
  /** Tests only: shorter waits. */
  limits?: Partial<PayFillLimits>;
};

// ---------------------------------------------------------------- the act's reads and writes (its own isolated worlds)

/** The box of field `i` of a frame (the `input, select` elements, as READ_FIELDS counts them) after it scrolls into view; with `label` 1 its label's box when the field has none. */
export const FIELD_AT = `${PAY_TAG("at")} (i, label) => {
  const el = document.querySelectorAll("input, select")[i];
  if (!el) return null;
  const rect = (n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? { x: r.left, y: r.top, w: r.width, h: r.height } : null; };
  el.scrollIntoView({ block: "center", inline: "center" });
  let b = rect(el);
  if (!b && label) { for (const l of el.labels || []) { l.scrollIntoView({ block: "center", inline: "center" }); b = rect(l); if (b) break; } }
  return b;
}`;
/** True when field `i` has the focus of its document (read before each key, in the world of the fill's start). */
export const FOCUS_ON = `${PAY_TAG("focus")} (i) => { const el = document.querySelectorAll("input, select")[i]; return !!el && document.activeElement === el; }`;
/** True when one of the fields `is` has the focus of its document (after a field's last key: the frame's own card fields; review-229 N8). */
export const FOCUS_IN = `${PAY_TAG("focusin")} (is) => { const all = document.querySelectorAll("input, select"); return is.some((i) => !!all[i] && document.activeElement === all[i]); }`;
/**
 * The act page's focus on a frame (review-228 B1), called on the frame's owner element in the act's own isolated world of
 * the main frame: true when the main document's active element is that owner (the frame has the page's focus).
 */
export const OWNER_FOCUS = `${PAY_TAG("owner")} function () { return document.activeElement === this; }`;
/** The checkboxes of a frame: their index, their state and their label's words (the save-card boxes). */
export const READ_SAVE = `${PAY_TAG("save")} () => {
  const text = (s) => String(s || "").replace(/\\s+/g, " ").trim().toLowerCase();
  const out = [];
  [...document.querySelectorAll("input, select")].slice(0, 300).forEach((el, i) => {
    if (el.tagName !== "INPUT" || String(el.type).toLowerCase() !== "checkbox") return;
    const parts = [];
    try { for (const l of el.labels || []) parts.push(l.textContent); } catch (e) {}
    parts.push(el.getAttribute("aria-label"), el.getAttribute("name"), el.getAttribute("id"));
    const near = el.closest("label, li, p, div");
    if (near) parts.push(near.textContent);
    out.push({ i, checked: !!el.checked, disabled: !!el.disabled, label: text(parts.filter(Boolean).join(" ")).slice(0, 300) });
  });
  return out;
}`;
const BUTTONS = "button, input[type=submit], input[type=button], input[type=image], [role=button]";
/** The buttons of a frame: their text, whether they submit a form, whether that form holds the card fields' frame or a card field. */
export const READ_BUTTONS = `${PAY_TAG("buttons")} () => {
  const vis = (el) => { const r = el.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return false; const cs = getComputedStyle(el); return cs.visibility !== "hidden" && cs.display !== "none"; };
  const text = (s) => String(s || "").replace(/\\s+/g, " ").trim().toLowerCase();
  return [...document.querySelectorAll(${JSON.stringify(BUTTONS)})].slice(0, 200).map((el, i) => {
    const tag = el.tagName.toLowerCase(), type = text(el.getAttribute("type") || (tag === "button" ? "submit" : ""));
    const f = el.form || el.closest("form");
    return { i, text: text(el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("title")).slice(0, 200),
      submit: (tag === "button" || tag === "input") && (type === "submit" || type === "image"),
      cardForm: !!f && !!f.querySelector("iframe, input[autocomplete*='cc-']"),
      visible: vis(el), enabled: !el.disabled && el.getAttribute("aria-disabled") !== "true" };
  });
}`;
/** The box of button `i` after it scrolls into view. */
export const BUTTON_AT = `${PAY_TAG("press")} (i) => {
  const el = document.querySelectorAll(${JSON.stringify(BUTTONS)})[i];
  if (!el) return null;
  el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
}`;
/** A select of the expiry's month or year: the option whose value or text is one of `wants` (JSON), with the page's events. */
export const SET_SELECT = `${PAY_TAG("select")} (i, wants) => {
  const el = document.querySelectorAll("input, select")[i];
  if (!el || el.tagName !== "SELECT") return false;
  const w = JSON.parse(wants);
  const opt = [...el.options].find((o) => w.includes(String(o.value).trim()) || w.includes(String(o.text).trim()));
  if (!opt) return false;
  el.value = opt.value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return el.value === opt.value;
}`;
/** The fields of a provider frame empty (the hidden ones too), each with the page's input and change events (design 8.8). */
export const EMPTY_CARD = `${PAY_TAG("clear")} () => {
  let n = 0;
  const keep = new Set(["checkbox", "radio", "file", "submit", "button", "reset", "image"]);
  for (const el of document.querySelectorAll("input, textarea")) {
    if (el.tagName === "INPUT" && keep.has(String(el.type).toLowerCase())) continue;
    if (el.value === "") continue;
    el.value = "";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    n++;
  }
  return n;
}`;

// ---------------------------------------------------------------- the pure rules

/** A save-card box's words: save, remember, keep or store the card (or the card saved for later). */
const SAVE_BOX = /\b(?:save|remember|keep|store)\b.*\b(?:card|payment|details|info(?:rmation)?|method)\b|\b(?:card|payment (?:details|method|info(?:rmation)?))\b.*\b(?:saved|remembered|kept|stored)\b|\bsave (?:it |this )?for (?:future|next|later)\b/i;
export const isSaveBox = (label: string) => SAVE_BOX.test(label);

/** One button as READ_BUTTONS gives it. */
export type ButtonRead = { i: number; text: string; submit: boolean; cardForm: boolean; visible: boolean; enabled: boolean };
/** A text that says pay, buy, place order or the like. */
const PAY_WORDS = /\b(?:pay|pay now|buy|buy now|place (?:my |your |the )?order|complete (?:my |your |the )?(?:purchase|order|payment|booking)|confirm (?:and pay|payment|purchase|order|booking)|submit (?:payment|order)|purchase|book now|order now)\b/i;
/** A wallet's button pays another way: never the press. */
const WALLET = /\b(?:paypal|apple pay|google pay|g ?pay|venmo|klarna|afterpay|affirm|amazon pay|shop pay|cash app|link)\b/i;

/**
 * The pay button (C11): the submit button of the form that holds the card fields, else a button whose text says pay,
 * buy, place order or the like, else a button whose text holds the agent's hint. Among several, the hint's one first,
 * then the first in the page's order. A wallet's button is none. `enabled`: only an enabled button (the press); else any
 * visible one (the check before the first key, while a page keeps its button off until the card is complete).
 */
export function payButton(list: readonly ButtonRead[], hint: string | null, enabled: boolean): ButtonRead | null {
  const ok = list.filter((b) => b && b.visible && (!enabled || b.enabled) && typeof b.text === "string" && !WALLET.test(b.text));
  const h = (hint ?? "").trim().toLowerCase();
  const pick = (xs: ButtonRead[]) => (h ? xs.find((b) => b.text.includes(h)) : undefined) ?? xs[0] ?? null;
  const form = ok.filter((b) => b.submit && b.cardForm);
  if (form.length) return pick([...form.filter((b) => PAY_WORDS.test(b.text)), ...form.filter((b) => !PAY_WORDS.test(b.text))]);
  const words = ok.filter((b) => PAY_WORDS.test(b.text));
  if (words.length) return pick([...words.filter((b) => b.cardForm), ...words.filter((b) => !b.cardForm)]);
  return h ? ok.find((b) => b.text.includes(h)) ?? null : null;
}

/** The roles in the order of the fill. */
const FILL_ORDER: readonly CardRole[] = ["number", "expiry", "expMonth", "expYear", "csc", "name", "postal"];
/** A year field of four digits: its label, name or placeholder says yyyy. */
const FOUR_DIGITS = /yyyy|\b4[\s-]?digit|full\s+year/i;

/** The value of one role from the card's buffers (the expiry is `MM/YY`). */
function valueOf(role: CardRole, v: CardBuffers, f: FieldRead | undefined): string {
  const exp = v.expiry.toString("latin1");
  switch (role) {
    case "number": return v.number.toString("latin1");
    case "expiry": return exp;
    case "expMonth": return exp.slice(0, 2);
    case "expYear": return f && FOUR_DIGITS.test(`${f.label} ${f.name} ${f.id}`) ? `20${exp.slice(3, 5)}` : exp.slice(3, 5);
    case "csc": return v.csc.toString("latin1");
    case "name": return v.holder.toString("utf8");
    case "postal": return v.postal.toString("utf8");
  }
}

/** The key fields of one planned key event (as the sign-in act sends them). */
function keyParams(ev: KeyEv): Record<string, unknown> {
  return { type: ev.type, key: ev.key, code: ev.code, windowsVirtualKeyCode: ev.keyCode, nativeVirtualKeyCode: ev.keyCode, modifiers: ev.modifiers,
    ...(ev.location ? { location: ev.location } : {}), ...(ev.type !== "keyUp" && ev.text ? { text: ev.text, unmodifiedText: ev.text } : {}) };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));
/** An error's kind for a log line: no URL, at most 120 characters. */
const whyOf = (e: unknown) => String((e as Error)?.message ?? e).replace(/[a-z][a-z0-9+.-]*:\/\/\S*/gi, "<a URL>").slice(0, 120);

/** One field to fill: its frame's session and id, its index in the frame, its tag and its read. */
type Target = { role: CardRole; key: string; session: string | undefined; frameId: string; index: number; tag: "input" | "select"; read: FieldRead | undefined };
/** A frame's key: its session and its frame id. */
const keyOf = (session: string | undefined, frameId: string) => `${session ?? "main"}|${frameId}`;

/** The payment act of the service: PayRequests' `act`. */
export class PayAct {
  private readonly o: PayActOptions;
  private readonly limits: PayFillLimits;
  constructor(o: PayActOptions) { this.o = o; this.limits = { ...PAY_FILL_LIMITS, ...o.limits }; }
  /** C11's act for one approved request: its end (the state and the text of C11's table). */
  act(ctx: PayActContext): Promise<PayActEnd> { return new PayRun(this.o, this.limits, ctx).run(); }
}

/** One act: its state from the approval to its end. */
class PayRun {
  private readonly o: PayActOptions;
  private readonly limits: PayFillLimits;
  private readonly ctx: PayActContext;
  private w: PayActWindow | null = null;
  private card: CardBuffers | null = null;
  private view: CardView | null = null;
  private off: (() => void) | null = null;
  /** The guard found the number before the press; its log line went. */
  private guardHit = false;
  private guardLogged = false;
  /** The keep's unknown is written and the press went. */
  private pressed = false;
  private firstKey: number | null = null;
  /** The frames that the fill types into (from the find on), and their sessions; a new page of one of them stops the fill. */
  private readonly watched = new Set<string>();
  private readonly watchedSessions = new Set<string>();
  private watching = false;
  private reloaded = false;
  /** Something was typed: the end empties the provider frames' fields. The number's first key went (the guard's `sent`). */
  private typed = false;
  private numberTyped = false;
  /** Before the press, a request took the number to a provider (review-228 N8): the keep's unknown went, or its write failed. */
  private sentEarly = false;
  private sentKeepFailed = false;
  /** The act ended: a request that takes the number to the provider after it writes no keep's unknown (review-228 N8). */
  private done = false;
  /** After the press: the main frame's new page and its time. */
  private moved = false;
  private navAt: number | null = null;
  private last: Pt | null = null;
  private blocked0 = 0;
  private guarded0 = 0;

  constructor(o: PayActOptions, limits: PayFillLimits, ctx: PayActContext) { this.o = o; this.limits = limits; this.ctx = ctx; }

  private get extra(): readonly string[] { return this.o.providerOrigins ?? []; }
  private get id(): string { return this.ctx.request.id; }
  private end(state: PayActEnd["state"], text: string): PayActEnd {
    const w = this.w;
    // After the number went to a provider before the press (review-228 N8), each stop is Unknown, never "Not paid".
    if (state === "stopped" && this.sentEarly && !this.pressed) { state = "unknown"; text = PAY_TEXT.unknown; }
    return { state, text, blocked: w ? w.blocked - this.blocked0 : 0, guarded: w ? w.guarded - this.guarded0 : 0 };
  }

  async run(): Promise<PayActEnd> {
    const p = this.ctx.prepared;
    if (!(p instanceof PayActWindow)) return this.end("stopped", PAY_TEXT.noWindow);
    const w = this.w = p;
    this.blocked0 = w.blocked;
    this.guarded0 = w.guarded;
    this.off = this.o.model.listen((ev) => this.onEvent(ev));
    try {
      return await this.steps(w);
    } catch (e) {
      if (this.pressed) return this.end("unknown", PAY_TEXT.unknown);
      this.o.log(`pay: request ${this.id}: the act stopped before the press (${whyOf(e)})`);
      return this.end("stopped", PAY_TEXT.lostBefore);
    } finally {
      this.done = true;
      // The provider frames' fields empty (review-227 N5a), before PayRequests ends the window.
      if (this.typed && !w.lost) await this.emptyFields().catch(() => {});
      this.ctx.pay("end");
      this.off?.();
      this.off = null;
      // The card's buffers go to zeros here (review-227 N5b); the guard then finds no number any more.
      const c = this.card;
      if (c) for (const b of [c.holder, c.number, c.expiry, c.csc, c.postal]) b.fill(0);
    }
  }

  // ---------------------------------------------------------------- the steps

  private async steps(w: PayActWindow): Promise<PayActEnd> {
    const req = this.ctx.request;
    // 1. The abort; the card's values again (a lock of the store stops).
    if (this.ctx.signal.aborted || w.lost) return this.end("stopped", PAY_TEXT.lostBefore);
    const opened = this.ctx.openCard();
    if ("stop" in opened) return this.end("stopped", opened.stop);
    const c = this.card = opened.values;
    w.hold(c.holder, c.number, c.expiry, c.csc, c.postal);
    const view: CardView = this.view = { number: c.number, expiry: c.expiry };
    // 2. The page's order again: another hash than the approved one stops.
    const page = await readOrder(w.session(), view).catch(() => null);
    if (w.lost) return this.end("stopped", PAY_TEXT.lostBefore);
    const order = page === null || "stop" in page ? null : orderForRequest(page, req, view);
    if (order === null || "stop" in order || orderHash(order) !== this.ctx.order) return this.end("stopped", PAY_TEXT.orderChanged);
    // 3. The guard on.
    w.guard = (r, session) => this.decide(r, session);
    // 4. The card fields again, only in provider frames; from here a new page of a found frame stops the fill.
    const frames = await w.readFrames();
    const found = findCardFields(frames, this.extra);
    if ("stop" in found) return this.end("stopped", found.stop);
    // The fields are in the frames of the provider of the act's rules (board ab-sta.8): another provider has no rule.
    const provider = providerOfFields(frames, found, this.extra, w.provider?.api ?? []);
    if (provider === null || w.provider === null || provider.name !== w.provider.name) return this.end("stopped", PAY_TEXT.fields);
    const targets = this.targets(frames, found);
    // A card field in a frame with no session of its own (an in-process subframe) would get its keys on the act tab's
    // session, where a key that races a page script's focus reaches the page (review-229 N7): the act stops before the
    // first key. A provider's hosted page (the act tab's main frame) has no other session.
    if (targets.some((t) => t.session === undefined && t.frameId !== w.frame)) return this.end("stopped", PAY_TEXT.fields);
    for (const t of targets) { this.watched.add(t.key); if (t.session) this.watchedSessions.add(t.session); }
    this.watching = true;
    // 5. Before the first key: a popup or another tab of the act window (review-227 N5c), an open connection outside the
    // act's list (review-227 N1), a pay button on the page.
    if (w.popup || (await this.otherTab(w))) return this.end("stopped", PAY_TEXT.lostBefore);
    if (openOutside(w.sockets.values(), w.sendToList()).length > 0) return this.end("stopped", PAY_TEXT.rules);
    if ((await this.button(w, frames, false)) === null) return this.end("stopped", PAY_TEXT.noButton);
    const early = this.flags();
    if (early) return this.end("stopped", early);
    // 6. The untick, the fill, the total, the press: under the browser's input lock.
    const stop = await this.o.model.inputLock(() => this.inputs(w, frames, targets));
    if (stop !== null) return this.end("stopped", stop);
    // 7. The result.
    return this.result(w);
  }

  /** The fields to fill, in the fill's order, each in its provider frame. */
  private targets(frames: readonly ActFrame[], found: CardFields): Target[] {
    const out: Target[] = [];
    for (const role of FILL_ORDER) {
      const at = found[role as keyof CardFields];
      if (!at) continue;
      const f = frames[at.frame];
      if (!f || typeof f.frameId !== "string") continue;
      const read = f.fields.find((x) => x.i === at.field);
      out.push({ role, key: keyOf(f.session, f.frameId), session: f.session, frameId: f.frameId, index: at.field, tag: read?.tag === "select" ? "select" : "input", read });
    }
    return out;
  }

  /** True when the act window has a tab other than the act tab (windows.get with its tabs). */
  private async otherTab(w: PayActWindow): Promise<boolean> {
    if (w.window === null) return true;
    const win = await this.o.model.call<any>("windows.get", [w.window, { populate: true }]).catch(() => null);
    // A read that fails, or one with no tabs, counts as another tab (review-228 N5: fail closed).
    if (!Array.isArray(win?.tabs)) return true;
    return (win.tabs as { id?: unknown }[]).some((t) => t?.id !== w.tab);
  }

  /** The stops that can come at any time before the press, in C11's order: the guard, the lost window, the act's 5 minutes, the abort. */
  private flags(): string | null {
    const w = this.w!;
    // The keep could not write when the number went to a provider (review-228 N8): the stop at once (end() makes it Unknown).
    if (this.sentKeepFailed) return PAY_TEXT.keepFailed;
    if (this.guardHit) return PAY_TEXT.guard;
    // A frame or a worker of the act tab where the guard could not start (review-228 N6).
    if (w.unguarded) return PAY_TEXT.rules;
    if (this.reloaded) return PAY_TEXT.frameLoaded;
    if (w.lost || w.popup) return PAY_TEXT.lostBefore;
    if (this.firstKey !== null && performance.now() - this.firstKey > this.limits.actMs) return PAY_TEXT.timeBefore;
    if (this.ctx.signal.aborted) return PAY_TEXT.lostBefore;
    return null;
  }

  /** The inputs under the lock: the untick, the `pay` start, the fill, the total, the press. A stop's text, or null after the press. */
  private async inputs(w: PayActWindow, frames: readonly ActFrame[], targets: Target[]): Promise<string | null> {
    const untick = await this.untick(w, frames);
    if (untick) return untick;
    const before = this.flags();
    if (before) return before;
    // C12's `pay` start right before the first key.
    this.ctx.pay("start");
    this.firstKey = performance.now();
    for (const t of targets) {
      const stop = await this.fill(w, t, targets.filter((x) => x.key === t.key).map((x) => x.index));
      if (stop) return stop;
    }
    // The save-card boxes again: a page can tick one again during the fill (review-228 N3).
    const again = await this.untick(w, frames);
    if (again) return again;
    const flags = this.flags();
    if (flags) return flags;
    // The pay button, enabled now.
    const now = await w.readFrames().catch(() => null);
    const button = now ? await this.button(w, now, true) : null;
    if (!button) return this.flags() ?? PAY_TEXT.noButton;
    const box = await this.boxAt(w, button.session, button.frameId, call(BUTTON_AT, button.i));
    if (!box) return this.flags() ?? PAY_TEXT.noButton;
    // The read of the page before the press: the result reader's baseline.
    const base = baselineOf(await this.views(w).catch(() => []));
    // After the path to the button, right before the press: the total and the save-card boxes once more (review-228 N4,
    // N3), then C11's stops and the press.
    return this.click(w, box, () => this.beforePress(base), () => this.lastReads(w, frames));
  }

  /** The total and the save-card boxes right before the press: another total, or a box that saves the card, stops. */
  private async lastReads(w: PayActWindow, frames: readonly ActFrame[]): Promise<string | null> {
    const page = await readOrder(w.session(), this.view!).catch(() => null);
    const order = page === null || "stop" in page ? null : orderForRequest(page, this.ctx.request, this.view!);
    if (order === null || "stop" in order) return this.flags() ?? PAY_TEXT.totalChanged;
    for (const f of this.savePlaces(frames)) {
      const boxes = await this.readSaves(w, f);
      if (boxes === null || boxes.some((b) => b.checked !== false)) return this.flags() ?? PAY_TEXT.keepsCard;
    }
    return null;
  }

  /** C11's stops right before the press, in their order; then the keep's unknown, and the press goes at once (null). */
  private beforePress(base: Baseline): string | null {
    if (this.guardHit) return PAY_TEXT.guard;
    // A lock of the store (or a store that no longer opens the card) stops.
    const again = this.ctx.openCard();
    if ("stop" in again) return again.stop;
    for (const b of [again.values.holder, again.values.number, again.values.expiry, again.values.csc, again.values.postal]) b.fill(0);
    const flags = this.flags();
    if (flags) return flags;
    if (!this.ctx.keepUnknown()) return PAY_TEXT.keepFailed;
    this.pressed = true;
    this.base = base;
    return null;
  }
  private base: Baseline = new Map();

  // ---------------------------------------------------------------- the untick and the fill

  /** Each checked save-card box of the main frame and of the provider frames: unticked by a person's click, else C11's stop. */
  private savePlaces(frames: readonly ActFrame[]): ActFrame[] {
    return frames.filter((f) => typeof f.frameId === "string" && (f.main || isProviderOrigin(f.origin, this.extra)));
  }
  /** A frame's save-card boxes (their label says save, remember or keep the card), or null when the read fails. */
  private async readSaves(w: PayActWindow, f: ActFrame): Promise<{ i: number; checked: boolean; disabled: boolean; label: string }[] | null> {
    const boxes = await w.evaluateIn<unknown>(f.session, f.frameId!, `(${READ_SAVE})()`).catch(() => null);
    return Array.isArray(boxes) ? (boxes as { i: number; checked: boolean; disabled: boolean; label: string }[]).filter((b) => b && Number.isInteger(b.i) && typeof b.label === "string" && isSaveBox(b.label)) : null;
  }
  private async untick(w: PayActWindow, frames: readonly ActFrame[]): Promise<string | null> {
    for (const f of this.savePlaces(frames)) {
      const read = () => this.readSaves(w, f);
      const boxes = await read();
      if (boxes === null) return this.flags() ?? PAY_TEXT.keepsCard;
      for (const b of boxes.filter((x) => x.checked === true)) {
        if (b.disabled) return PAY_TEXT.keepsCard;
        const box = await this.boxAt(w, f.session, f.frameId!, call(FIELD_AT, b.i, 1));
        if (!box) return this.flags() ?? PAY_TEXT.keepsCard;
        const stop = await this.click(w, box, () => this.flags());
        if (stop) return stop;
        const after = await read();
        if (after === null || after.some((x) => x.i === b.i && x.checked !== false)) return this.flags() ?? PAY_TEXT.keepsCard;
      }
    }
    return null;
  }

  /**
   * One field: a world of its frame for the checks before each key (a new page of the frame has none: the check fails),
   * a person's click on the field, then its value with the person's input: the generator's keys when each character has
   * a key on the US layout and the plan fits in the typing's time, else one Input.insertText. A select takes its option
   * in the act's world. Before each key: the flags, the frame's world, and the field's focus. After the field's last key
   * only: the focus may be on another card field of the same frame (`same`: the indices of the frame's fields that the act
   * fills), as a provider moves it to its next field when the number is complete (review-229 N8), with the page's focus
   * still on that frame.
   */
  private async fill(w: PayActWindow, t: Target, same: readonly number[] = [t.index]): Promise<string | null> {
    const first = this.flags();
    if (first) return first;
    const value = valueOf(t.role, this.card!, t.read);
    if (t.tag === "select") {
      const wants = t.role === "expMonth" ? [value, String(Number(value))] : [value, value.length === 2 ? `20${value}` : value.slice(2)];
      const ok = await w.evaluateIn<boolean>(t.session, t.frameId, call(SET_SELECT, t.index, JSON.stringify(wants))).catch(() => false);
      this.typed = true;
      return this.flags() ?? (ok === true ? null : PAY_TEXT.frameLoaded);
    }
    const world = await w.send("Page.createIsolatedWorld", { frameId: t.frameId, worldName: `aw-pay-${randomBytes(4).toString("hex")}`, grantUniversalAccess: false }, t.session).catch(() => null);
    const ctxId = Number.isInteger(world?.executionContextId) ? world.executionContextId as number : null;
    if (ctxId === null) return this.flags() ?? PAY_TEXT.frameLoaded;
    // The act page's focus on the provider frame (review-228 B1), from the act's own world of the main frame.
    const pageFocus = await this.ownerFocus(w, t);
    if (pageFocus === null) return this.flags() ?? PAY_TEXT.frameLoaded;
    const box = await this.boxAt(w, t.session, t.frameId, call(FIELD_AT, t.index, 0));
    if (!box) return this.flags() ?? PAY_TEXT.frameLoaded;
    const clicked = await this.click(w, box, () => this.flags());
    if (clicked) return clicked;
    const check = async (afterLast = false): Promise<string | null> => {
      const f = this.flags();
      if (f) return f;
      const expression = afterLast ? `(${FOCUS_IN})(${JSON.stringify(same.includes(t.index) ? same : [t.index, ...same])})` : call(FOCUS_ON, t.index);
      const v = await w.send("Runtime.evaluate", { expression, contextId: ctxId, returnByValue: true, awaitPromise: false }, t.session).catch(() => null);
      if (v?.result?.value !== true || v?.exceptionDetails) return this.flags() ?? PAY_TEXT.frameLoaded;
      if (!(await pageFocus())) return this.flags() ?? PAY_TEXT.frameLoaded;
      return this.flags();
    };
    const typing = () => { this.typed = true; if (t.role === "number") this.numberTyped = true; };
    const person = this.o.model.person(this.ctx.request.scope), random = this.o.model.random;
    const keyed = [...value].every((ch) => charKey(ch) !== undefined);
    const pace = keyed ? typingPace(value, person, random, person.params.keys.typeMaxMs, {}, false) : null;
    if (!pace) {
      const stop = await check();
      if (stop) return stop;
      typing();
      await w.send("Input.insertText", { text: value }, t.session);
      return check(true);
    }
    // The keys on the field's own frame session (board ab-sta.8, measured in Chromium 156): a key there reaches the frame's
    // active field while the frame has the page's focus, and no field once a page script took the focus, so a key that
    // races the focus check never reaches a field of the merchant's page (a key on the tab's own session does).
    const player = this.player(w, t.session);
    const t0 = performance.now();
    for (const ev of pace.plan.events) {
      await sleep(t0 + ev.t - performance.now());
      if (ev.type !== "keyUp") {
        const stop = await check();
        if (stop) return stop;
        typing();
      }
      await player.event("Input.dispatchKeyEvent", keyParams(ev));
    }
    return check(true);
  }

  /**
   * The check of the act page's focus on the frame of a field (review-228 B1): the frame's owner element (DOM.getFrameOwner)
   * resolved in a new isolated world of the main frame, and OWNER_FOCUS on it before each key. A field of the main frame
   * (a provider's hosted page) needs none: FOCUS_ON proves it. Null when the owner cannot be resolved.
   */
  private async ownerFocus(w: PayActWindow, t: Target): Promise<(() => Promise<boolean>) | null> {
    if (t.session === undefined && t.frameId === w.frame) return async () => true;
    const owner = await w.send("DOM.getFrameOwner", { frameId: t.frameId }).catch(() => null);
    if (!Number.isInteger(owner?.backendNodeId)) return null;
    const world = await w.send("Page.createIsolatedWorld", { frameId: w.frame, worldName: `aw-pay-${randomBytes(4).toString("hex")}`, grantUniversalAccess: false }).catch(() => null);
    if (!Number.isInteger(world?.executionContextId)) return null;
    const node = await w.send("DOM.resolveNode", { backendNodeId: owner.backendNodeId, executionContextId: world.executionContextId }).catch(() => null);
    const objectId = node?.object?.objectId;
    if (typeof objectId !== "string") return null;
    return async () => {
      const v = await w.send("Runtime.callFunctionOn", { objectId, functionDeclaration: OWNER_FOCUS, returnByValue: true }).catch(() => null);
      return v?.result?.value === true && !v?.exceptionDetails;
    };
  }

  /** The person's input player on the act tab's own session, or with `session` on a frame's own session (the keys of a field). */
  private player(w: PayActWindow, session?: string): CdpPlayer {
    return new CdpPlayer((method, params) => w.send(method, params, session), { latencyMs: [3, 5], wholeMs: process.platform !== "darwin", random: this.o.model.random, maxInFlight: 8 });
  }

  /**
   * A person's click on a box of the act page (the main frame's coordinates): a path from the last point, a pause, then
   * `before` (a stop's text ends the click before the press), the press and its hold.
   */
  private async click(w: PayActWindow, box: Box, before: () => string | null, ready?: () => Promise<string | null>): Promise<string | null> {
    const person = this.o.model.person(this.ctx.request.scope), random = this.o.model.random, player = this.player(w);
    const to = spreadPoint(box, person, random);
    const from = this.last ?? startPoint(1280, 800, random);
    const plan = planPath(from, to, Math.max(1, box.w), person, random);
    await player.moves(plan.samples);
    this.last = to;
    await sleep(pauseMs(person, random));
    // `ready`: the last reads right before the press; `before`: the checks with no wait before the press.
    if (ready) { const late = await ready(); if (late) return late; }
    const stop = before();
    if (stop) return stop;
    const at = { x: to.x, y: to.y, button: "left", clickCount: 1 };
    await player.event("Input.dispatchMouseEvent", { type: "mousePressed", ...at, buttons: 1, force: 0.5 });
    await sleep(holdMs(person, random));
    await player.event("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, buttons: 0 });
    return null;
  }

  /**
   * The box of an element of a frame in the act page's coordinates: the element's box in its frame (after it scrolls into
   * view), plus the frame's place in the main frame (DOM.getFrameOwner's box). A frame below a frame of a frame has no
   * place here: null.
   */
  private async boxAt(w: PayActWindow, session: string | undefined, frameId: string, expression: string): Promise<Box | null> {
    const b = await w.evaluateIn<Box | null>(session, frameId, expression).catch(() => null);
    if (!b || ![b.x, b.y, b.w, b.h].every(Number.isFinite) || b.w <= 0 || b.h <= 0) return null;
    if (session === undefined && frameId === w.frame) return b;
    const owner = await w.send("DOM.getFrameOwner", { frameId }).catch(() => null);
    if (!Number.isInteger(owner?.backendNodeId)) return null;
    const model = await w.send("DOM.getBoxModel", { backendNodeId: owner.backendNodeId }).catch(() => null);
    const q = model?.model?.content;
    if (!Array.isArray(q) || q.length < 2 || !Number.isFinite(q[0]) || !Number.isFinite(q[1])) return null;
    return { x: q[0] + b.x, y: q[1] + b.y, w: b.w, h: b.h };
  }

  /** The pay button: the main frame's first, then the provider frames'; with its frame. */
  private async button(w: PayActWindow, frames: readonly ActFrame[], enabled: boolean): Promise<(ButtonRead & { session: string | undefined; frameId: string }) | null> {
    const places = frames.filter((f) => typeof f.frameId === "string" && (f.main || isProviderOrigin(f.origin, this.extra)));
    for (const f of places) {
      const list = await w.evaluateIn<unknown>(f.session, f.frameId!, `(${READ_BUTTONS})()`).catch(() => null);
      if (!Array.isArray(list)) continue;
      const b = payButton(list as ButtonRead[], this.ctx.request.button, enabled);
      if (b) return { ...b, session: f.session, frameId: f.frameId! };
    }
    return null;
  }

  /** Each provider frame's fields empty (the frames that the page has now, also one that loaded again). */
  private async emptyFields(): Promise<void> {
    const w = this.w!;
    const frames = await w.readFrames().catch(() => [] as ActFrame[]);
    for (const f of frames) {
      if (typeof f.frameId !== "string" || !isProviderOrigin(f.origin, this.extra)) continue;
      await w.evaluateIn(f.session, f.frameId, `(${EMPTY_CARD})()`).catch(() => {});
    }
  }

  // ---------------------------------------------------------------- the guard

  /** The guard's decision for each paused request of the act tab, its frames and its workers. */
  private decide(p: Record<string, any>, session: string | undefined): "continue" | "fail" | Promise<"continue" | "fail"> {
    const c = this.card;
    if (!c) return "continue";
    const r = p.request ?? { url: "" };
    // A body with the number goes only to the act's provider (its frame and API origins; board ab-sta.8).
    const g = payGuard(r, c.number, this.w?.provider ? providerHosts(this.w.provider) : [], { typed: this.numberTyped });
    // The number went to a provider before the press (review-228 N8): the keep's unknown at once.
    if (g.sent && !this.pressed && !this.sentEarly && !this.done) {
      this.sentEarly = true;
      if (!this.ctx.keepUnknown()) this.sentKeepFailed = true;
      this.o.log(`pay: request ${this.id}: the card's number went to the provider before the press${this.sentKeepFailed ? "; the keep's write failed" : ""}`);
    }
    if (g.decision === "fail") {
      if (g.number) {
        if (!this.pressed) this.guardHit = true;
        // One line for each act (the request's log line counts each request that the guard failed).
        if (!this.guardLogged) { this.guardLogged = true; this.o.log(`pay: request ${this.id}: the guard failed a request that held the card's number`); }
      }
      return "fail";
    }
    // After the press the act's rules stay as they were at the fill (board ab-sta.8): the guard alone decides here.
    return "continue";
  }

  // ---------------------------------------------------------------- the result

  /** The result reader after the press: for up to 60 s (and within the act's 5 minutes), each turn's reads, else Unknown. */
  private async result(w: PayActWindow): Promise<PayActEnd> {
    const end = Math.min(performance.now() + this.limits.resultMs, (this.firstKey ?? performance.now()) + this.limits.actMs);
    while (performance.now() < end) {
      if (w.lost || this.ctx.signal.aborted) break;
      if (this.navAt === null || performance.now() - this.navAt >= this.limits.settleMs) {
        const frames = await this.views(w).catch(() => null);
        if (w.lost) break;
        if (frames && (this.navAt === null || performance.now() - this.navAt >= this.limits.settleMs)) {
          const r = readResult({ request: this.ctx.request, card: this.view!, moved: this.moved, frames, before: this.base });
          if (r) return this.end(r.state, r.text);
        }
      }
      await sleep(this.limits.pollMs);
    }
    return this.end("unknown", PAY_TEXT.unknown);
  }

  /** The act page's frames as READ_VIEW reads them: the act tab's own frame tree, then each out-of-process frame. */
  private async views(w: PayActWindow): Promise<FrameView[]> {
    const out: FrameView[] = [];
    const walk = async (node: any, session: string | undefined, main: boolean): Promise<void> => {
      const f = node?.frame;
      if (typeof f?.id !== "string") return;
      const v = await w.evaluateIn<any>(session, f.id, `(${READ_VIEW})()`).catch(() => null);
      if (v && typeof v === "object" && typeof v.url === "string" && Array.isArray(v.lines)) {
        const origin = URL.canParse(v.url) ? new URL(v.url).origin : "null";
        out.push({ key: keyOf(session, f.id), main, provider: isProviderOrigin(origin, this.extra), url: v.url, title: typeof v.title === "string" ? v.title : "",
          lines: (v.lines as unknown[]).filter((l): l is string => typeof l === "string"),
          alerts: Array.isArray(v.alerts) ? (v.alerts as unknown[]).filter((l): l is string => typeof l === "string") : [], code: v.code === true });
      }
      for (const c of Array.isArray(node.childFrames) ? node.childFrames : []) await walk(c, session, false);
    };
    await walk((await w.send("Page.getFrameTree"))?.frameTree, undefined, true);
    for (const [session, child] of [...w.children]) {
      if (child.type !== "iframe") continue;
      const tree = await w.send("Page.getFrameTree", {}, session).catch(() => null);
      await walk(tree?.frameTree, session, false);
    }
    return out;
  }

  // ---------------------------------------------------------------- the act tab's events

  private onEvent(ev: Record<string, any>): void {
    const w = this.w;
    if (!w || ev.ev !== "debugger.onEvent" || ev.source?.tabId !== w.tab) return;
    const session = typeof ev.source?.sessionId === "string" ? ev.source.sessionId as string : undefined;
    const p = ev.params ?? {};
    switch (ev.method) {
      case "Page.frameNavigated": {
        const f = p.frame ?? {};
        const top = session === undefined && !f.parentId;
        if (top && this.pressed) { this.moved = true; this.navAt = performance.now(); return; }
        // Before the press: a new page of the act tab, or of a found frame, is a frame that loaded again.
        if (this.watching && !this.pressed && (top || (typeof f.id === "string" && this.watched.has(keyOf(session, f.id))) || (session !== undefined && this.watchedSessions.has(session) && !f.parentId))) this.reloaded = true;
        return;
      }
      case "Page.navigatedWithinDocument":
        if (session === undefined && this.pressed && p.frameId === w.frame) this.navAt = performance.now();
        return;
      case "Target.detachedFromTarget":
        if (this.watching && !this.pressed && typeof p.sessionId === "string" && this.watchedSessions.has(p.sessionId)) this.reloaded = true;
        return;
    }
  }
}
