// The input stage (boards ab-t30.9, the pointer part, ab-t30.10, the keys and the text, and ab-t30.11, the scroll and the
// wheel; the input design, docs/superpowers/specs/2026-11-10-vanilla-playwright-human-input-design.md, sections 4 to 8, and
// build tasks 5 to 7 of its section 14; contract C11 "The input stage (board ab-t30.6)", the master, with
// test/vectors/stage.json). A client writes plain Playwright, and the stage turns its input into a person's input: a path
// from the page's last point at a
// device's rate, a pause, a press of a person's length, a person's gap between the presses of a double click, the hover's
// path around Playwright's hit-target check, the frame mapping, the recovery after a miss of that check, and the spread of
// the press point; keys with a person's holds, gaps and rollover, a real Shift key for a capital or a symbol, chords, the
// typed keys of a fill where the typing rule allows them, and a click on a text field in place of Playwright's script
// focus. It keeps what each call asks for (the point, the button, the click count, the modifiers, the keys, the text).
//
// The stage is a module of the model (model.ts), between the tab's gate and the bridge: the model gives it each call that
// it takes (arrive), runs the call's step in the tab's gate (step), gives it the answers of the calls that pass (saw) and
// Chrome's events (event), and asks it before each other call of the tab (other: a call that is not a key ends the tab's
// key run, and it waits until the run's planned releases have gone). The stage sends its events and reads through its
// host (StagePage), so the input harness can run it on a pipe of its own. It uses the generator of src/human/ (no second
// generator) with the scope's person.
//
// The build switch (C11, the build switch): the stage stays off in the default path until board tasks ab-t30.9 to
// ab-t30.12, ab-t30.19, ab-t30.21 and ab-t30.22 are all merged. STAGE_BUILD_ON is false; only the tests (the model's `stage` option) and the live rows (the
// relay's environment variable STAGE_TEST_ENV with the value "test") turn the stage on.
//
// The scroll and the wheel (board ab-t30.11): mouse.wheel as a person's notches with the page's residual, at the page's
// last point, until its column would bring a form control, a canvas, a frame, another scroller or a listener of the
// wheel that is not passive under the point (then the rest as one event); DOM.scrollIntoViewIfNeeded on every session
// translated into notches at a wheel point (no such element under it or in its column), round by round, the outermost
// scroller first, up through frames (same-origin and cross-origin), with the end after a round that does not move its
// scroller and the counted fallbacks (a box that no wheel moves, a button held down); the focus click's notches into
// view; the Mac's pass.
//
// The paste and the collected keys (board ab-t30.19; the operator's answer on board item ab-8fu, 2026-11-12: "can we do a
// simulated copy/paste for long text input? and we use a person typing for short input only?"): a text whose typing plan
// fits in what is left of the key run's STAGE_TYPE_MAX_MS is typed; a longer one goes as a person's paste (the text on
// the CLIPBOARD selection of the service's own display, through its owner, src/service/unit/clipboard.ts; Control+V with
// a person's timing; the selection given up at once after the paste's keyDown), and Playwright's own input of the text
// when the page refuses the paste. The printable keys of a key run (pressSequentially, type, keyboard.type) are
// collected: each such call gets its answer at once, and the collected part goes, typed or pasted, at the run's next call
// or RUN_IDLE_MS after its last call; the tab's gate holds the client's next call until the part's events have gone.
// The key run's time with a person's timing is at most STAGE_TYPE_MAX_MS; after it the rest of the run goes as the client
// sends it. On the Mac there is no paste (Chrome there shares the operator's own clipboard): the open point of stage 4.
//
// Not in these parts (C11 names them; its board task builds them): the calls that only a script makes (ab-t30.12: a move
// with a button down, the drag, select text, the file chooser).
//
// No log line and no count holds a point, a key or a text (C10's log rule).

import { CdpPlayer, systemClock, linuxStamp, macStamp, type Clock } from "../human/cdp-player.ts";
import { planLine, planPath, startPoint, type Pt, type Sample } from "../human/path.ts";
import type { Person } from "../human/person.ts";
import { doubleClickGapMs, force, holdMs, modifierAfterMs, pauseMs, pressPoint, type Box, type ElementKind } from "../human/press.ts";
import { ALT, charKey, CONTROL, KeyStream, macCommands, META, SHIFT, typingPace, type Key, type KeyEv, type StreamOptions } from "../human/keys.ts";
import { draw, uniform, type Random } from "../human/random.ts";
import { notches, notchGapMs, Wheel, wheelPlan } from "../human/wheel.ts";
import { GEOMETRY_WAIT_MS } from "./pointer.ts";
import { PLAYWRIGHT_FOCUS, SECRET_INPUT, startsAction } from "./policy.ts";

// ------------------------------------------------------------------ the switch and the constants (C11)

/** The build switch: off until board tasks ab-t30.9 to ab-t30.12, ab-t30.19, ab-t30.21 and ab-t30.22 are all merged ("don't do this half baked"). */
export const STAGE_BUILD_ON = false;
/** The environment variable of a relay process that the live rows set to "test" (the tests' door to the switch). */
export const STAGE_TEST_ENV = "AGENT_BROWSER_INPUT_STAGE";
/** Whether the stage is on: the model's option (the tests), else the build switch, else the live rows' variable. */
export function stageOn(option?: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  if (option !== undefined) return option;
  return STAGE_BUILD_ON || env[STAGE_TEST_ENV] === "test";
}

/** C11's constants (first values). The rate, the latency and the in-flight bound are the person's (the parameter files). */
export const STAGE_MOVE_MS = 8;
export const STAGE_LATENCY_MS = [3, 5] as const;
export const STAGE_EVENT_WAIT_MS = 2000;
export const STAGE_MOVES_IN_FLIGHT = 8;
export const STAGE_NOTCH_PX = 120;
export const STAGE_TYPE_MAX_MS = 10000;
export const STAGE_ACTION_MAX_MS = 25000;
export const STAGE_SCROLL_ROUNDS = 4;
/** The recovery (C11, the hit-target check): the exit point is this far outside the boxes; the way around widens the kept box by this much. */
export const RECOVERY_EXIT_PX = 15;
export const AROUND_MARGIN_PX = 10;
/** At most this many recoveries in one action: the setups of one node, each within RETRY_MARK_MS of a miss of that node. */
export const RECOVERIES_MAX = 2;
/** A miss marks the tab for the next setup of its node within this time (Playwright retries at most 500 ms after a miss). */
export const RETRY_MARK_MS = 2000;
/** The kept quads and handles of a tab (a navigation of its main frame clears them). */
export const KEPT_MAX = 64;
/** A hover's action ends at Playwright's move: with no pointer input of the tab this long after the setup's answer, the rest goes and the lock is free. */
export const HOVER_WAIT_MS = 1000;
/** The default width of a target for Fitts's law when the stage knows no target (a plain mouse.move): input.ts's moveTo. */
const DEFAULT_WIDTH = 24;
/** A key run ends 1 s after its last key when no key is held (C11, the input lock: a key run). */
export const RUN_IDLE_MS = 1000;
/** The focus click's caret (C11, the focus click): a caret in the middle of a text up to this long is set with the arrow keys, a longer one by a script. */
export const CARET_KEYS_MAX = 64;
/** The text types of an input (C11, the typing rule 1 and the focus click; Playwright's kInputTypesToTypeInto). */
export const TEXT_TYPES = ["text", "search", "email", "url", "tel", "password", "number"];
/** The paste (C11, the paste): the stage waits this long for the clipboard's owner to hold the text, else the text goes as Playwright's own input. */
export const CLIPBOARD_HOLD_MS = 500;
/**
 * The paste's read after V's answer (C11, the paste, rule 6; board ab-t30.21): the stage waits at most this long for the
 * page's answer of that read. At the limit the paste path stays closed, as after an error answer of V, until V's tab ends
 * or its main frame navigates (fail closed).
 */
export const V_READ_MAX_MS = 10_000;
/** The key of a person's paste on Linux: Control+V (a rawKeyDown with no text, as a keyboard gives it and as Playwright's press('Control+V') sends it). */
export const PASTE_KEY: Key = { key: "v", code: "KeyV", keyCode: 86, modifiers: CONTROL, type: "rawKeyDown" };
/** A collected part that goes as the client's own keys: at most this many of its events without an answer (C10's limit of a tab is far above it). */
export const PLAIN_IN_FLIGHT = 8;
/**
 * The flush of a collected part (C11, the collected keys; review-126 B3): before a close of the tab and at the end of its
 * client's last session, the close waits at most this long for the rest of the part: the answers of its sent events
 * (STAGE_EVENT_WAIT_MS), the rest as one Input.insertText (STAGE_EVENT_WAIT_MS), and 1 s for the stage's reads of the
 * field. The flush waits for no other tab's lock (review-126b R1).
 */
export const STAGE_FLUSH_MS = 2 * STAGE_EVENT_WAIT_MS + 1000;

// ------------------------------------------------------------------ Playwright's utility calls and the recognizers

/** Playwright's utility-script call: `(utilityScript, ...args) => utilityScript.evaluate(...args)`. */
export const UTILITY_CALL = /^\(utilityScript,\s*\.\.\.args\)\s*=>\s*utilityScript\.evaluate\(\.\.\.args\)$/;
/** C11's table of the recognizers: each pattern matches the whole text of Playwright's function. */
export const RECOGNIZERS: Record<string, RegExp> = {
  "hit-target check": /^\(\[injected\b[^\]]*\]\)\s*=>\s*injected\.setupHitTargetInterceptor\([^)]*\)\s*$/,
  "the check's stop": /^\(([A-Za-z_$][\w$]*)\)\s*=>\s*\1\.stop\(\)\s*$/,
  focus: PLAYWRIGHT_FOCUS,
  fill: /^async\s*\(\[injected\b[^\]]*\]\)\s*=>\s*\{[\s\S]*\breturn\s+injected\.fill\(node,\s*[\w$]+\);?\s*\}\s*$/,
  "select text": /^async\s*\(\[injected\b[^\]]*\]\)\s*=>\s*\{[\s\S]*\breturn\s+injected\.selectText\(node\);?\s*\}\s*$/,
  "retry scroll": /^\(\[injected\b[^\]]*\]\)\s*=>\s*\{[\s\S]*\bnode\.scrollIntoView\(\{\s*\.\.\.[\w$]+,\s*behavior:\s*"instant"\s*\}\);[\s\S]*\}\s*$/,
  blur: /^\(\[injected\b[^\]]*\]\)\s*=>\s*injected\.blurNode\([^)]*\)\s*$/,
  "select option": /^async\s*\(\[injected\b[^\]]*\]\)\s*=>\s*\{[\s\S]*\breturn\s+injected\.selectOptions\(node,\s*[\w$]+\);?\s*\}\s*$/,
  "set files": /^\(\[injected\b[^\]]*\]\)\s*=>\s*injected\.setInputFiles\([^)]*\)\s*$/,
};
/** The recognizer whose pattern matches the whole text, or null. */
export function recognize(fn: string): string | null {
  for (const [name, re] of Object.entries(RECOGNIZERS)) if (re.test(fn)) return name;
  return null;
}

/** A handle of the serialized argument: the objectId of Chrome's remote object. */
export type Handle = { handle: string | undefined };
/**
 * Playwright's serialized argument (`serializeAsCallArgument`): a string, a number or a boolean is itself, `undefined`
 * and `null` (and the special numbers) are `{"v": ...}`, a handle is `{"h": <index into the handles>}`, an array is
 * `{"a": [...]}`, an object is `{"o": [{"k": <key>, "v": <value>}]}`. Other forms (a date, a URL, a cycle) read as undefined.
 */
export function decodeArg(v: unknown, handles: readonly (string | undefined)[]): unknown {
  if (v === null || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  if ("v" in o) return ({ null: null, NaN: NaN, Infinity: Infinity, "-Infinity": -Infinity, "-0": -0 } as Record<string, unknown>)[String(o.v)];
  if ("h" in o) return { handle: handles[o.h as number] } satisfies Handle;
  if ("a" in o && Array.isArray(o.a)) return o.a.map((x) => decodeArg(x, handles));
  if ("o" in o && Array.isArray(o.o)) return Object.fromEntries((o.o as { k: string; v: unknown }[]).map((e) => [e.k, decodeArg(e.v, handles)]));
  return undefined;
}
/** A utility call: its function's text, its decoded arguments and its handles. */
export type Utility = { fn: string; name: string | null; args: unknown[]; handles: (string | undefined)[] };
/**
 * A Runtime.callFunctionOn of Playwright's utility script, decoded: its arguments are the utility script, two flags, the
 * text of Playwright's function, the count of arguments, that many serialized arguments, and then the handles. Null for
 * any other call.
 */
export function utilityCall(method: string, params: any): Utility | null {
  if (method !== "Runtime.callFunctionOn" || typeof params?.functionDeclaration !== "string" || !UTILITY_CALL.test(params.functionDeclaration.trim())) return null;
  const a: any[] = Array.isArray(params.arguments) ? params.arguments : [];
  const fn = a[3]?.value, count = a[4]?.value;
  if (typeof fn !== "string" || !Number.isInteger(count) || count < 0) return null;
  const handles = a.slice(5 + count).map((x) => (typeof x?.objectId === "string" ? x.objectId : undefined));
  return { fn, name: recognize(fn), args: a.slice(5, 5 + count).map((x) => decodeArg(x?.value, handles)), handles };
}

// ------------------------------------------------------------------ the stage's reads

/**
 * The frame mapping's read, in Playwright's utility world on the node's own handle: for each same-origin frame level up
 * to the top of its process, the frame element's box plus its border and padding (the sum of Playwright's
 * _checkFrameIsHitTarget), and the node's box with that sum. `top`: the sum reached the top page (no cross-origin frame
 * above it); `flat`: no frame element on the way has a transform (else the mapping is not a sum).
 */
export const NODE_GEO = "function () { let x = 0, y = 0, flat = true, w = this.ownerDocument.defaultView; while (w !== w.top && w.frameElement) { const fe = w.frameElement, r = fe.getBoundingClientRect(), cs = w.parent.getComputedStyle(fe); if (cs.transform && cs.transform !== 'none') flat = false; x += r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft); y += r.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop); w = w.parent; } const b = this.getBoundingClientRect(); return { ox: x, oy: y, top: w === w.top, flat, box: { x0: b.left + x, y0: b.top + y, x1: b.right + x, y1: b.bottom + y } }; }";
/**
 * The recovery's read at the hit point, in Playwright's utility world on the target's handle: the element at the point
 * when it is not the target or inside it, and its highest ancestor that does not hold the target; as an array of the
 * two (a handle that the stage keeps until its second read), or null.
 */
export const OBSTACLE_FIND = "function (x, y) { const t = this, el = t.ownerDocument.elementFromPoint(x, y); if (!el || el === t || t.contains(el)) return null; let o = el; while (o.parentElement && !o.parentElement.contains(t)) o = o.parentElement; return [o, el]; }";
/** The union of the boxes of the obstacle and the element at the point (the first read). */
export const OBSTACLE_BOTH = "function () { const a = this[0].getBoundingClientRect(), b = this[1].getBoundingClientRect(); return { x0: Math.min(a.left, b.left), y0: Math.min(a.top, b.top), x1: Math.max(a.right, b.right), y1: Math.max(a.bottom, b.bottom) }; }";
/** Two frames of the page (the recovery's wait after the pointer left the obstacle). */
export const TWO_FRAMES = "function () { return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))); }";
/** The obstacle's box again (the second read): the panel has closed, so it is the trigger's box. */
export const OBSTACLE_AGAIN = "function () { const a = this[0].getBoundingClientRect(); return { x0: a.left, y0: a.top, x1: a.right, y1: a.bottom }; }";
/** The focused element of a document (its shadow roots and its same-origin frames followed), as the typing rule reads it: a cross-origin frame stops the read. */
const FOCUS_BODY = (doc: string) => `const TT = ${JSON.stringify(TEXT_TYPES)}; let el = ${doc}.activeElement; for (let i = 0; el && i < 16; i++) { if (el.shadowRoot && el.shadowRoot.activeElement) { el = el.shadowRoot.activeElement; continue; } if (el.localName === 'iframe' || el.localName === 'frame') { let d = null; try { d = el.contentDocument; } catch (x) {} if (!d) return { frame: true }; el = d.activeElement; continue; } break; } if (!el || el.localName === 'body' || el.localName === 'html') return null; globalThis.__agentBrowserStageField = el; const tag = el.localName, type = tag === 'input' ? String(el.type || 'text').toLowerCase() : undefined, typing = (tag === 'input' && TT.includes(type)) || tag === 'textarea'; let s = null, e = null; if (typing) { try { s = el.selectionStart; e = el.selectionEnd; } catch (x) {} } return { tag, type, editable: !!el.isContentEditable, typing, ac: typing ? String(el.getAttribute('autocomplete') || '') : null, value: typing ? String(el.value) : null, s, e };`;
/** The typing rule's read of the focused element (C11, the typing rule 1), in the stage's own isolated world on the top page; it marks that element (a global of the world, which no page script sees) for FIELD_STILL. */
export const FOCUSED_FIELD = `() => { ${FOCUS_BODY("document")} }`;
/** The same read in a cross-origin frame, on a node's handle of that frame (Playwright's utility world): `away` when that frame's document does not have the focus. */
export const FOCUSED_IN = `function () { if (!this.ownerDocument.hasFocus()) return { away: true }; ${FOCUS_BODY("this.ownerDocument")} }`;
/** The deep focused element of a document (its shadow roots and its same-origin frames followed), or null; a cross-origin frame stops it. */
const DEEP_ACTIVE = (doc: string) => `let a = ${doc}.activeElement; for (let i = 0; a && i < 16; i++) { if (a.shadowRoot && a.shadowRoot.activeElement) { a = a.shadowRoot.activeElement; continue; } if (a.localName === 'iframe' || a.localName === 'frame') { let d = null; try { d = a.contentDocument; } catch (x) {} if (!d) { a = null; break; } a = d.activeElement; continue; } break; }`;
/** review-119 P1: the field that the last focus read marked still has the focus (sentence 13's test: the deep active element, and its document has the focus). */
export const FIELD_STILL = `() => { const el = globalThis.__agentBrowserStageField; if (!el || !el.isConnected) return false; ${DEEP_ACTIVE("document")} return a === el && el.ownerDocument.hasFocus(); }`;
/**
 * The paste's read after V's answer (C11, the paste, rule 6; board ab-t30.21): it reads nothing of the page. The
 * document that ran V's default action (the paste) answers it only after that default action, also when the start of a
 * navigation answered V early (measured); at a navigation to another site the new document answers it, after
 * Page.frameNavigated. V_READ in the stage's own isolated world on the top page; V_READ_IN on the node of the focus
 * read (the typing rule's read at V's time) on a cross-origin frame's own session, where V's default action runs.
 */
export const V_READ = "() => true";
/**
 * The stage's read after the client's Page.disable while it waits for a dialog's close (point 2 of board ab-t30.17): it
 * reads nothing of the page, and Chrome answers it only when the page runs again, after the dialog's close (measured).
 */
export const DIALOG_READ = "() => 0";
export const V_READ_IN = "function () { return true; }";
/** The same in a cross-origin frame, on a node's handle of that frame (Playwright's utility world). */
export const FIELD_STILL_IN = `function () { const el = globalThis.__agentBrowserStageField; if (!el || !el.isConnected) return false; ${DEEP_ACTIVE("this.ownerDocument")} return a === el && el.ownerDocument.hasFocus(); }`;
/** Playwright's retarget for fill (follow-label): the control of a label, the field itself otherwise (playwright-core 1.65.0, injected retarget). */
const RETARGET = "let el = this.nodeType === 1 ? this : this.parentElement; if (!el) return null; if (follow) { if (!el.matches('input, textarea, select') && !el.isContentEditable) el = el.closest('button, [role=button], [role=checkbox], [role=radio]') || el; if (!el.matches('a, input, textarea, button, select, option, optgroup, [role=link], [role=button], [role=checkbox], [role=radio]') && !el.isContentEditable) { const l = el.closest('label'); if (l && l.control) el = l.control; } }";
/** The parent of a node in the flat tree: a slotted node's slot, else its parent element, else a shadow root's host (review-122 note 5). */
const UP = "const up = (n) => n.assignedSlot || n.parentElement || (n.parentNode && n.parentNode.nodeType === 11 ? n.parentNode.host : null);";
/**
 * The field's widget signs (board ab-t30.18, the operator's answer on board item ab-pf8; C11, the focus click), in
 * FIELD_STATE: the role combobox (a token of the field's role, or of the role of an element around it in the flat tree:
 * the pattern of ARIA 1.1), aria-haspopup with a value of ARIA's other than false, aria-expanded true or false,
 * aria-autocomplete list or both, an input whose list names a datalist. The first that holds, in this order, or null.
 */
const WIDGET = "const A = (n, q = el) => String(q.getAttribute(n) || '').trim().toLowerCase(), hp = A('aria-haspopup'), ex = A('aria-expanded'), ac = A('aria-autocomplete'), combo = (q) => A('role', q).split(/\\s+/).includes('combobox'); let around = false; for (let p = up(el), i = 0; p && p.nodeType === 1 && i < 64; p = up(p), i++) if (combo(p)) { around = true; break; } const widget = combo(el) ? 'combobox' : ['true', 'menu', 'listbox', 'tree', 'grid', 'dialog'].includes(hp) ? 'haspopup' : ex === 'true' || ex === 'false' ? 'expanded' : ac === 'list' || ac === 'both' ? 'autocomplete' : tag === 'input' && el.list ? 'list' : around ? 'comboboxAround' : null;";
/**
 * The focus click's read of the field (C11, the focus click), in Playwright's utility world on the node's own handle: its
 * kind, whether it has the focus (Playwright's _activelyFocused), the length of its text, its caret, its widget sign
 * (WIDGET), and its box with the sum of its same-origin frames (as NODE_GEO).
 */
export const FIELD_STATE = `function (follow) { ${RETARGET} const TT = ${JSON.stringify(TEXT_TYPES)}; const tag = el.localName, type = tag === 'input' ? String(el.type || 'text').toLowerCase() : undefined; const kind = tag === 'textarea' ? 'textarea' : tag === 'input' && TT.includes(type) ? 'input' : el.isContentEditable ? 'editable' : 'other'; ${UP} ${WIDGET} const d = el.ownerDocument, active = el.getRootNode().activeElement === el, focused = active && d.hasFocus(); const len = kind === 'input' || kind === 'textarea' ? String(el.value).length : (el.textContent || '').length; let s = null, e = null; if (kind === 'input' || kind === 'textarea') { try { s = el.selectionStart; e = el.selectionEnd; } catch (x) {} } let x = 0, y = 0, flat = true, w = d.defaultView; while (w !== w.top && w.frameElement) { const fe = w.frameElement, r = fe.getBoundingClientRect(), cs = w.parent.getComputedStyle(fe); if (cs.transform && cs.transform !== 'none') flat = false; x += r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft); y += r.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop); w = w.parent; } const b = el.getBoundingClientRect(); return { kind, type, disabled: !!el.disabled || el.matches(':disabled'), readOnly: !!el.readOnly, active, focused, len, s, e, widget, ox: x, oy: y, top: w === w.top, flat, box: { x0: b.left + x, y0: b.top + y, x1: b.right + x, y1: b.bottom + y } }; }`;
/** The focus click's hit test (C11, the focus click), on the node's handle: the element at the point of the field's own document is the field or inside it. */
export const FIELD_HIT = `function (x, y, follow) { ${RETARGET} const r = el.getRootNode(), h = (typeof r.elementFromPoint === 'function' ? r : el.ownerDocument).elementFromPoint(x, y); if (!h || !(h === el || el.contains(h))) return false; let w = el.ownerDocument.defaultView; while (w !== w.top && w.frameElement) { const fe = w.frameElement, b = fe.getBoundingClientRect(), cs = w.parent.getComputedStyle(fe); x += b.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft); y += b.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop); const fr = fe.getRootNode(), fh = (typeof fr.elementFromPoint === 'function' ? fr : fe.ownerDocument).elementFromPoint(x, y); if (fh !== fe) return false; w = w.parent; } return true; }`;
/** A caret in the middle of a long text (C11, the focus click): set by the field's own setSelectionRange, as Hands' focusField does. */
export const CARET_SET = `function (s, e, follow) { ${RETARGET} el.setSelectionRange(s, e); return true; }`;
/**
 * The events whose listener on a field is a widget sign (board ab-t30.18; C11, the focus click): a listener of the page's
 * own scripts on the field itself for one of these gets no focus click. Only `click`: the live rows measured a field
 * whose page counts its presses with a `mousedown` listener (as an analytics or a bot check's script can), which opens
 * nothing; with `mousedown`, `mouseup`, `pointerdown` and `pointerup` too, that field lost its focus click.
 */
export const WIDGET_LISTENERS = ["click"];
/**
 * A listener's handler that is an empty function (review-123 B1: a framework's no-op on an element whose click its root
 * handles): no sign. The text is the description of Chrome's remote object of the handler (its source), which
 * DOMDebugger.getEventListeners gives on a handle that has an object group.
 */
export const EMPTY_HANDLER = /^\s*(?:async\s+)?(?:function\b[^(]*\([^)]*\)|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)\s*\{\s*\}\s*$/;
/** The field's element (fill's retarget), as a handle of Playwright's utility world: the read of its listeners resolves it into the page's main world. */
export const FIELD_ELEMENT = `function (follow) { ${RETARGET} return el; }`;

// ---------------------------------------------------------------- the script calls (C11, the script calls; board ab-t30.12.1)

/**
 * The read of a select before Playwright's selectOption (C11, the script calls), in Playwright's utility world on the node's
 * handle: whether it is a select, a list box (multiple, or a size above 1), disabled (also by a fieldset), its selected
 * index, and each option's value, label, disabled (also by its optgroup) and hidden (no box in the popup); then for each
 * option handle of the client's call, its index (-1: not an option of this select).
 */
export const SELECT_STATE = `function (follow, ...hs) { ${RETARGET} if (el.localName !== 'select') return { select: false }; const o = Array.from(el.options, (x) => { const g = x.parentElement; return { v: x.value, l: x.label, d: !!(x.disabled || (g && g.localName === 'optgroup' && g.disabled)), h: !!(x.hidden || getComputedStyle(x).display === 'none') }; }); return { select: true, list: el.multiple || el.size > 1, disabled: el.matches(':disabled'), sel: el.selectedIndex, o, hs: hs.map((h) => Array.prototype.indexOf.call(el.options, h)) }; }`;
/**
 * The read of a range input before its fill (C11, the script calls), in Playwright's utility world on the node's handle:
 * its minimum, maximum and step as the browser takes them (0, 100 and 1 when not given; a step of `any` null), its value,
 * and whether it runs from right to left or up and down.
 */
export const RANGE_STATE = `function (follow) { ${RETARGET} const n = (x, d) => { const v = parseFloat(x); return Number.isFinite(v) ? v : d; }; const cs = getComputedStyle(el); const step = String(el.step).trim().toLowerCase() === 'any' ? null : n(el.step, 1) > 0 ? n(el.step, 1) : 1; return { min: n(el.min, 0), max: n(el.max, 100), step, value: Number(el.value), turned: cs.direction === 'rtl' || !String(cs.writingMode || 'horizontal-tb').startsWith('horizontal') || /vertical/.test(String(cs.appearance || cs.webkitAppearance || '')) }; }`;
/** A range input's default thumb in Chrome (C11, the script calls; measured: a click at 80% of a 300 px range of 0 to 100 gave 82). */
export const RANGE_THUMB_PX = 16;
/** A range input (C11, the script calls): at most this many arrow keys after the click. */
export const RANGE_KEYS_MAX = 10;
/** The read after the stage's click (C11, the script calls; review-132 B2): the field is the active element of its document. */
export const FIELD_ACTIVE = `function (follow) { ${RETARGET} return el.getRootNode().activeElement === el; }`;
/**
 * Playwright's own state checks of the client's call (C11, the script calls; review-132 note a), on the call's own handle
 * of Playwright's injected script: its checkElementStates with the states that the call's function names. Falsy when the
 * states hold, else Playwright's error string.
 */
export const PLAYWRIGHT_STATES = `function (node, states, frameVisible) { return this.checkElementStates(node, states, frameVisible); }`;
/** The read after the stage's input (C11, the script calls): the select's selected index, or the input's value. */
export const SCRIPT_VALUE = `function (follow) { ${RETARGET} return el.localName === 'select' ? el.selectedIndex : String(el.value); }`;
/**
 * The client's utility call of a translated selectOption or fill (C11, the script calls): Playwright's own function in a
 * wrapper. The function runs as it is, in Playwright's utility world; while it runs, its own `input` and `change` events on
 * the field (Playwright's retarget of the node) are skipped when the field's value is still the value that it had when the
 * call began (the stage's input made those events, as a person's). When Playwright's function changes the value, its
 * events go. The wrapper changes only the prototype of Playwright's own world, for the time of the call; the page's world
 * never sees it.
 */
export const SKIP_EVENTS = (fn: string) => `async (...args) => { const n = Array.isArray(args[0]) ? args[0][1] : null; const el = n && typeof n === 'object' && typeof n.nodeType === 'number' ? (function (follow) { ${RETARGET} return el; }).call(n, true) : null; const key = (x) => x.localName === 'select' ? Array.from(x.options, (o) => (o.selected ? '1' : '0')).join('') : String(x.value); const was = el ? key(el) : null; const E = EventTarget.prototype, d = E.dispatchEvent; if (el) E.dispatchEvent = function (ev) { if (this === el && ev && !ev.isTrusted && (ev.type === 'input' || ev.type === 'change') && key(el) === was) return true; return d.call(this, ev); }; try { return await (${fn})(...args); } finally { if (el) E.dispatchEvent = d; } }`;
/** The client's call with Playwright's function in SKIP_EVENTS: the same call, with only the text of the function changed. */
export function skipEvents(params: any): any {
  const a = Array.isArray(params?.arguments) ? params.arguments.slice() : [];
  if (typeof a[3]?.value !== "string") return params;
  a[3] = { ...a[3], value: SKIP_EVENTS(a[3].value) };
  return { ...params, arguments: a };
}
/** Playwright's normalizeWhiteSpace (its option label match). */
const normalWhite = (s: string) => s.replace(/​/g, "").trim().replace(/\s+/g, " ");
/** One option of SELECT_STATE: its value, its label, disabled, hidden. */
export type SelectOption = { v: string; l: string; d: boolean; h: boolean };
/**
 * The option that Playwright's selectOptions selects in a select that is not a list box: the first option that one of the
 * client's options to select matches (an option handle by its index; else each of valueOrLabel, value, label and index that
 * the client gives), as Playwright's filter does. Null when no option matches.
 */
export function selectTarget(want: unknown[], o: readonly SelectOption[], hs: readonly number[]): number | null {
  let h = 0;
  const filters = want.map((w) => (w && typeof w === "object" && "handle" in (w as object) ? { idx: hs[h++] ?? -1 } : (w ?? {}) as Record<string, unknown>));
  const label = (want: unknown, l: string) => typeof want === "string" && (want === l || normalWhite(want) === normalWhite(l));
  for (let i = 0; i < o.length; i++) {
    const hit = filters.some((f: any) => {
      if ("idx" in f) return f.idx === i;
      let m = true;
      if (f.valueOrLabel !== undefined) m &&= f.valueOrLabel === o[i].v || label(f.valueOrLabel, o[i].l);
      if (f.value !== undefined) m &&= f.value === o[i].v;
      if (f.label !== undefined) m &&= label(f.label, o[i].l);
      if (f.index !== undefined) m &&= f.index === i;
      return m;
    });
    if (hit) return i;
  }
  return null;
}
/** The inputs whose fill the stage types field by field (C11, the script calls); a range input gets a click and arrow keys, a color input passes. */
export const PICKER_TYPES = ["date", "time", "datetime-local", "month", "week"];
/** A select's popup (C11, the script calls): at most this many arrow keys to the client's option (a long run of arrow keys missed in the probe). */
export const SELECT_KEYS_MAX = 8;
/** A select's popup (C11, the script calls): at most this many typed letters of the option's label. */
export const SELECT_TYPE_MAX = 12;
const K_DOWN: Key = { key: "ArrowDown", code: "ArrowDown", keyCode: 40, modifiers: 0 };
const K_UP: Key = { key: "ArrowUp", code: "ArrowUp", keyCode: 38, modifiers: 0 };
const K_ENTER: Key = { key: "Enter", code: "Enter", keyCode: 13, text: "\r", modifiers: 0 };
const K_RIGHT: Key = { key: "ArrowRight", code: "ArrowRight", keyCode: 39, modifiers: 0 };
const K_HOME: Key = { key: "Home", code: "Home", keyCode: 36, modifiers: 0 };
const K_LEFT: Key = { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37, modifiers: 0 };
const K_END: Key = { key: "End", code: "End", keyCode: 35, modifiers: 0 };
/**
 * The keys in a select's popup from the selected option to the client's, then Enter (C11, the script calls; measured: the
 * popup takes CDP keys, its arrow keys skip a disabled or a hidden option and start at the selected option, also a
 * disabled one, or before the first option when none is selected; Home and End go to the first and the last; typed
 * letters go to the first option from the selected one whose label starts with them, in any case). The shortest of: the
 * arrow keys, Home or End and the arrow keys (at most SELECT_KEYS_MAX arrow keys), or the shortest start of the option's
 * label that no other option's label has (each character a key of the US layout; a start whose first two characters are
 * the same is one longer, as Chrome then cycles at the second). Null when no way reaches the option, or the selected
 * option is hidden.
 */
export function selectKeys(o: readonly SelectOption[], from: number, to: number): Key[] | null {
  const nav = (i: number) => i >= 0 && i < o.length && !o[i].d && !o[i].h;
  if (from < -1 || from >= o.length || (from >= 0 && o[from].h) || !nav(to) || from === to) return null;
  const N = o.map((_, i) => i).filter(nav), at = N.indexOf(to);
  // The arrow keys from the selected option (a disabled one too: the popup starts there).
  const dir = to > from ? 1 : -1;
  let n = 0;
  for (let i = from + dir; i !== to + dir; i += dir) if (nav(i)) n++;
  const ways: Key[][] = [];
  if (n <= SELECT_KEYS_MAX) ways.push(Array(n).fill(dir > 0 ? K_DOWN : K_UP));
  if (at <= SELECT_KEYS_MAX) ways.push([K_HOME, ...Array(at).fill(K_DOWN)]);
  if (N.length - 1 - at <= SELECT_KEYS_MAX) ways.push([K_END, ...Array(N.length - 1 - at).fill(K_UP)]);
  // Typed letters: the shortest start of the label that no other option's label has.
  const fold = (x: string) => x.replace(/^\s+/, "").toLowerCase(), mine = fold(o[to].l), others = o.filter((_, i) => i !== to).map((x) => fold(x.l));
  for (let k = 1; k <= Math.min(mine.length, SELECT_TYPE_MAX); k++) {
    const p = mine.slice(0, k);
    if (others.some((x) => x.startsWith(p)) || (k === 2 && p[0] === p[1])) continue;
    const keys = [...p].map((ch) => charKey(ch));
    if (keys.every((x) => x && !(x.modifiers & SHIFT))) ways.push(keys as Key[]);
    break;
  }
  if (!ways.length) return null;
  const best = ways.reduce((a, b) => (b.length < a.length ? b : a));
  return [...best, K_ENTER];
}
/** A digit's key, or a lower-case letter's (the AM/PM field's first letter). */
const digitKeys = (s: string): Key[] => [...s].map((ch) => charKey(ch)!);
/** The ISO weeks of a year: 53 when the year starts on a Thursday, or on a Wednesday in a leap year; else 52. */
const isoWeeks = (y: number) => { const d = new Date(Date.UTC(y, 0, 1)).getUTCDay(), leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; return d === 4 || (leap && d === 3) ? 53 : 52; };
/**
 * The keys that type a picker input's value field by field (C11, the script calls; review-132 B1): for each field of the
 * input, in its order on the screen, the value's digits with zeros in front (a year 4, the others 2); an hour of a 12-hour
 * field 1 to 12 and its AM/PM field `a` or `p`. The value's form must be the one that the typed fields give: a time holds
 * a second exactly when the input has a second field, and that second is not 00; it holds no millisecond, and the input
 * has no millisecond field. The value must be a valid one (a year from 0001, a month 1 to 12, a day of that month, a week
 * of that year, an hour 0 to 23, a minute and a second 0 to 59), as Playwright's script otherwise fails with no event. Null
 * in every other case: the call then passes.
 */
export function pickerKeys(type: string, value: string, fields: readonly string[]): Key[] | null {
  const D = "(\\d{4})-(\\d{2})-(\\d{2})", T = "(\\d{2}):(\\d{2})(?::(\\d{2}))?";
  const forms: Record<string, [RegExp, string[]]> = {
    date: [new RegExp(`^${D}$`), ["year", "month", "day"]],
    month: [/^(\d{4})-(\d{2})$/, ["year", "month"]],
    week: [/^(\d{4})-W(\d{2})$/, ["year", "week"]],
    time: [new RegExp(`^${T}$`), ["hour", "minute", "second"]],
    "datetime-local": [new RegExp(`^${D}T${T}$`), ["year", "month", "day", "hour", "minute", "second"]],
  };
  const form = forms[type];
  const m = form ? form[0].exec(value) : null;
  if (!form || !m) return null;
  const part: Record<string, string | undefined> = {};
  form[1].forEach((name, i) => { part[name] = m[i + 1]; });
  // The form: a second exactly with a second field, and not 00; no millisecond field.
  if (fields.includes("millisecond")) return null;
  if (form[1].includes("second") && (part.second !== undefined) !== fields.includes("second")) return null;
  if (part.second === "00") return null;
  // A valid value.
  const n = (k: string) => (part[k] === undefined ? 0 : Number(part[k]));
  if (part.year !== undefined && n("year") < 1) return null;
  if (part.month !== undefined && (n("month") < 1 || n("month") > 12)) return null;
  if (part.day !== undefined && (n("day") < 1 || n("day") > new Date(Date.UTC(n("year"), n("month"), 0)).getUTCDate())) return null;
  if (part.week !== undefined && (n("week") < 1 || n("week") > isoWeeks(n("year")))) return null;
  if (n("hour") > 23 || n("minute") > 59 || n("second") > 59) return null;
  const ampm = fields.includes("ampm"), H = n("hour");
  const keys: Key[] = [];
  for (const f of fields) {
    if (f === "ampm") { keys.push(...digitKeys(H < 12 ? "a" : "p")); continue; }
    if (!form[1].includes(f) || part[f] === undefined) return null;
    let s = part[f]!;
    if (f === "hour" && ampm) s = String(H % 12 || 12);
    keys.push(...digitKeys(s.padStart(f === "year" ? 4 : 2, "0")));
    // A year field does not move on after its 4 digits (a year can have 6), nor the month field of a month input (it holds
    // the month's name; measured): ArrowRight goes to the next field.
    if ((f === "year" || (f === "month" && type === "month")) && f !== fields[fields.length - 1]) keys.push(K_RIGHT);
  }
  return keys.length ? keys : null;
}
/** The area near a field of the cover read (board ab-t30.18): its box widened by this much across and down and up, in px. */
export const COVER_AREA_PX = [40, 240] as const;
/** The points of the cover read's grid over that area: across, down. */
export const COVER_GRID = [9, 25] as const;
/**
 * The cover read before the focus click (board ab-t30.18; C11, the focus click), in Playwright's utility world on the
 * node's own handle: the area near the field (COVER_AREA_PX, within the viewport of its own document) at a grid of
 * COVER_GRID points, and every element at each point (elementsFromPoint), kept in the world for COVER_AFTER. The count
 * of the points (0: no area).
 */
export const COVER_BEFORE = `function (follow) { ${RETARGET} const d = el.ownerDocument, w = d.defaultView, b = el.getBoundingClientRect(); delete globalThis.__agentBrowserStageCover; const x0 = Math.max(0, b.left - ${COVER_AREA_PX[0]}), x1 = Math.min(w.innerWidth - 1, b.right + ${COVER_AREA_PX[0]}), y0 = Math.max(0, b.top - ${COVER_AREA_PX[1]}), y1 = Math.min(w.innerHeight - 1, b.bottom + ${COVER_AREA_PX[1]}); if (!(x1 >= x0 && y1 >= y0)) return 0; const pts = []; for (let i = 0; i < ${COVER_GRID[0]}; i++) for (let j = 0; j < ${COVER_GRID[1]}; j++) pts.push([x0 + ((x1 - x0) * i) / ${COVER_GRID[0] - 1}, y0 + ((y1 - y0) * j) / ${COVER_GRID[1] - 1}]); const seen = new Set(); for (const p of pts) for (const q of d.elementsFromPoint(p[0], p[1])) seen.add(q); globalThis.__agentBrowserStageCover = { el, d, pts, seen }; return pts.length; }`;
/**
 * The cover read after the focus click (board ab-t30.18), two frames after the release: the new elements that cover the
 * area, as a count. A new element is the top element at a point of the grid that was at no point of it before, that is
 * not the field, inside it or around it; each counts once, with its highest ancestor that was at no point before (a
 * panel with its cells). Null with no kept read. The world lets go of the kept read.
 */
export const COVER_AFTER = "function () { const C = globalThis.__agentBrowserStageCover; delete globalThis.__agentBrowserStageCover; if (!C) return null; return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => { const roots = new Set(); for (const p of C.pts) { const t = C.d.elementFromPoint(p[0], p[1]); if (!t || C.seen.has(t) || t === C.el || C.el.contains(t) || t.contains(C.el)) continue; let a = t; while (a.parentElement && !C.seen.has(a.parentElement)) a = a.parentElement; roots.add(a); } r(roots.size); }))); }";
/** The world lets go of a kept cover read (the focus click's plan ended before its release). */
export const COVER_CLEAR = "function () { delete globalThis.__agentBrowserStageCover; return true; }";

/** A scroller of the scroll's reads: an element whose overflow on an axis is auto, scroll or overlay, with more content than its box on that axis ([x, y]): the wheel moves it. */
const SCROLLS = "const scrolls = (p, cs) => [/(auto|scroll|overlay)/.test(cs.overflowX) && p.scrollWidth > p.clientWidth + 1, /(auto|scroll|overlay)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 1];";
/** A box that clips its content with overflow hidden or clip, with more content than its box on that axis ([x, y]): no wheel moves it (review-122 B2). */
const CLIPS = "const clips = (p, cs) => [/(hidden|clip)/.test(cs.overflowX) && p.scrollWidth > p.clientWidth + 1, /(hidden|clip)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 1];";
/** Whether `b` is `a` or inside it in the flat tree (a composed containment test: review-122 B1). */
const INSIDE = "const inside = (a, b) => { for (let p = b, i = 0; p && i < 4096; p = up(p), i++) if (p === a) return true; return false; };";
/** The element at a point of a document, into its open shadow roots. */
const DEEP = "const deep = (doc, x, y) => { let e = doc.elementFromPoint(x, y); for (let i = 0; e && e.shadowRoot && i < 16; i++) { const f = e.shadowRoot.elementFromPoint(x, y); if (!f || f === e) break; e = f; } return e; };";
/** Rule 1's elements (C11, the wheel point). */
const BADS = "const BAD = ['input', 'select', 'textarea', 'canvas', 'embed', 'object', 'video', 'audio', 'iframe', 'frame']; const bad = (p) => BAD.includes(p.localName) || p.isContentEditable;";
/**
 * Each element under a root, into the open shadow roots of each element (review-122 B1) and the elements assigned to each
 * slot (`assignedElements({ flatten: true })`, review-122b R2: a shadow root's scroller around a slot moves light DOM
 * content that its own tree does not hold), each once, at most 50,000.
 */
const EACH = "const each = (root, fn) => { const st = [root], seen = new Set([root]); let n = 0; const add = (r) => { if (r && !seen.has(r)) { seen.add(r); st.push(r); } }; add(root.shadowRoot); while (st.length && n < 50000) { const r = st.pop(); for (const e of r.querySelectorAll('*')) { n++; fn(e); add(e.shadowRoot); if (e.localName === 'slot' && e.assignedElements) for (const a of e.assignedElements({ flatten: true })) if (!seen.has(a) && !(root.contains && root.contains(a))) { n++; fn(a); add(a); add(a.shadowRoot); } } } };";
/** A box's four sides of a computed style (scroll-padding, scroll-margin: review-122 note 4), left, top, right, bottom; `auto` is 0. */
const SIDES = "const sides = (cs, k) => ['Left', 'Top', 'Right', 'Bottom'].map((s) => { const v = parseFloat(cs[k + s]); return Number.isFinite(v) ? v : 0; });";
/**
 * The roots of rule 2 under a root: the root itself, the open shadow roots under it (review-122 B1), and the elements
 * assigned to each slot that the root's own tree does not hold (review-122b R2), each once, at most `max`
 * (WHEEL_ROOTS_MAX): rule 2 reads each one's listeners with its subtree.
 */
const ROOTS = "const rootsOf = (r0, max) => { const out = [r0], st = [r0], seen = new Set([r0]); const add = (r) => { if (r && !seen.has(r) && out.length < max) { seen.add(r); out.push(r); st.push(r); } }; add(r0.shadowRoot); while (st.length && out.length < max) { const r = st.pop(); for (const e of r.querySelectorAll('*')) { add(e.shadowRoot); if (e.localName === 'slot' && e.assignedElements) for (const a of e.assignedElements({ flatten: true })) if (!(r0.contains && r0.contains(a))) { add(a); add(a.shadowRoot); } } } return out; };";
/**
 * The scroll's read (C11, the scroll and the wheel), in Playwright's utility world on the node's own handle (or, with
 * `owner`, in the relay's own world on a cross-origin frame's owner): the target's box (the node's border box, or the
 * client's `rect` in it) with its scroll-margin, and its scrollers, innermost first, up through its same-origin frames, in
 * the flat tree: each one's visible box (its client box; a document's: its viewport), its scroll position, its scroll
 * range ([x, y]), the axes that the wheel moves, and its scroll-padding. A box that clips with overflow hidden or clip is a
 * level that the wheel does not move; the scrollers above an element with `position: fixed` do not move it. All in the
 * points of the top of its process (`top`: the top page). The world keeps the scrollers for WHEEL_POINTS and WHEEL_ROOTS.
 */
export const SCROLL_STATE = `function (rx, ry, rw, rh, follow, owner) { ${RETARGET} if (!el.isConnected) return null; ${SCROLLS} ${CLIPS} ${UP} ${SIDES} const b = el.getBoundingClientRect(); if (!owner && !el.getClientRects().length) return { none: true }; const t = typeof rx === 'number' ? [b.left + rx, b.top + ry, b.left + rx + rw, b.top + ry + rh] : [b.left, b.top, b.right, b.bottom]; const mg = owner ? [0, 0, 0, 0] : sides(el.ownerDocument.defaultView.getComputedStyle(el), 'scrollMargin'); const L = [], marks = [], wins = [], fes = [], offs = []; let w = el.ownerDocument.defaultView, n = el, flat = true, d = 0; for (; d < 8; d++) { wins[d] = w; const doc = w.document, html = doc.documentElement, se = doc.scrollingElement || html, hs = w.getComputedStyle(html); let fixed = w.getComputedStyle(n).position === 'fixed'; for (let p = fixed ? null : up(n); p && p !== html; p = up(p)) { if (p === se) continue; const cs = w.getComputedStyle(p), s = scrolls(p, cs), c = clips(p, cs); if ((s[0] || s[1] || c[0] || c[1]) && !(p === doc.body && hs.overflowX === 'visible' && hs.overflowY === 'visible')) { const r = p.getBoundingClientRect(); L.push({ d, r: [r.left + p.clientLeft, r.top + p.clientTop, r.left + p.clientLeft + p.clientWidth, r.top + p.clientTop + p.clientHeight], s: [p.scrollLeft, p.scrollTop], m: [s[0] || c[0] ? p.scrollWidth - p.clientWidth : 0, s[1] || c[1] ? p.scrollHeight - p.clientHeight : 0], doc: false, wheel: [s[0], s[1]], pad: sides(cs, 'scrollPadding') }); marks.push(p); } if (cs.position === 'fixed') { fixed = true; break; } } if (!fixed) { const bs = doc.body ? w.getComputedStyle(doc.body) : hs, ov = (k) => (hs[k] !== 'visible' ? hs[k] : bs[k]), q = doc.compatMode === 'BackCompat' && doc.body ? doc.body : html, vw = q.clientWidth, vh = q.clientHeight, mx = Math.max(0, se.scrollWidth - vw), my = Math.max(0, se.scrollHeight - vh); L.push({ d, r: [0, 0, vw, vh], s: [w.scrollX, w.scrollY], m: [mx, my], doc: true, wheel: [mx > 0 && !/(hidden|clip)/.test(ov('overflowX')), my > 0 && !/(hidden|clip)/.test(ov('overflowY'))], pad: sides(hs, 'scrollPadding') }); marks.push(doc); } if (w === w.top || !w.frameElement) break; const fe = w.frameElement, fr = fe.getBoundingClientRect(), fcs = w.parent.getComputedStyle(fe); if (fcs.transform && fcs.transform !== 'none') flat = false; fes[d] = fe; offs[d] = [fr.left + parseFloat(fcs.borderLeftWidth) + parseFloat(fcs.paddingLeft), fr.top + parseFloat(fcs.borderTopWidth) + parseFloat(fcs.paddingTop)]; n = fe; w = w.parent; } const cum = []; cum[d] = [0, 0]; for (let i = d - 1; i >= 0; i--) cum[i] = [cum[i + 1][0] + offs[i][0], cum[i + 1][1] + offs[i][1]]; globalThis.__agentBrowserStageScroll = { el, marks, depth: L.map((l) => l.d), wins, fes, cum, owner: !!owner }; return { t: [t[0] + cum[0][0], t[1] + cum[0][1], t[2] + cum[0][0], t[3] + cum[0][1]], mg, levels: L.map((l) => ({ r: [l.r[0] + cum[l.d][0], l.r[1] + cum[l.d][1], l.r[2] + cum[l.d][0], l.r[3] + cum[l.d][1]], s: l.s, m: l.m, doc: l.doc, wheel: l.wheel, pad: l.pad })), top: w === w.top, flat, ox: cum[0][0], oy: cum[0][1] }; }`;
/**
 * The wheel point's rules 1, 3 and 4 (C11, the wheel point), on the handle of the last SCROLL_STATE, for the scroller `k` of
 * that read and the points `pts` (in that read's points), in their order: at each frame level above the scroller the
 * element at the point is the frame's element; in the scroller's document, the element at the point and each ancestor
 * up to the scroller in the flat tree is not an input, select, textarea, contenteditable, canvas, embed, object, video,
 * audio or frame, and no other scroller comes first (rules 1 and 3); and with the round's move `mv` ([dx, dy] px), the
 * point's column, the line from the point along the move as the page's content is now, also into open shadow roots,
 * meets no element of rule 1 and no other scroller with a range on the moved axis (rule 4). The elements around the
 * element and inside it (in the flat tree) and elements with `position: fixed` do not count; the element itself counts
 * when it is a canvas, an embed, an object, a video, an audio or a frame, or has the focus (review-122 note 3). The
 * indexes of the points that pass.
 */
export const WHEEL_POINTS = `function (k, pts, mv) { const S = globalThis.__agentBrowserStageScroll; if (!S || !S.marks[k]) return null; ${SCROLLS} ${UP} ${INSIDE} ${DEEP} ${BADS} ${EACH} const m = S.marks[k], dk = S.depth[k], D = S.wins.length - 1, w = S.wins[dk], doc = w.document, html = doc.documentElement, se = doc.scrollingElement || html, ox = S.cum[dk][0], oy = S.cum[dk][1]; const segs = (q) => { const x = q[0] - ox, y = q[1] - oy, out = []; if (mv && mv[1]) out.push([x, Math.min(y, y + mv[1]), x, Math.max(y, y + mv[1])]); if (mv && mv[0]) out.push([Math.min(x, x + mv[0]), y + (mv[1] || 0), Math.max(x, x + mv[0]), y + (mv[1] || 0)]); return out; }; const meets = (r, g) => r[0] <= g[2] && r[2] > g[0] && r[1] <= g[3] && r[3] > g[1]; const all = pts.map(segs), col = []; if (mv && (mv[0] || mv[1])) { const root = m.nodeType === 9 ? doc.body || html : m, anc = dk === 0 ? S.el : S.fes[dk - 1], cs = new Map(), style = (e) => { let c = cs.get(e); if (!c) cs.set(e, (c = w.getComputedStyle(e))); return c; }; let act = doc.activeElement; for (let i = 0; act && act.shadowRoot && act.shadowRoot.activeElement && i < 16; i++) act = act.shadowRoot.activeElement; const self = dk === 0 && !S.owner && (['canvas', 'embed', 'object', 'video', 'audio', 'iframe', 'frame'].includes(anc.localName) || (bad(anc) && anc === act)); const fixedUp = (e) => { for (let p = e; p && p !== root; p = up(p)) if (style(p).position === 'fixed') return true; return false; }; each(root, (e) => { if (e === anc ? !self : inside(e, anc) || inside(anc, e)) return; const b = e.getBoundingClientRect(), r = [b.left, b.top, b.right, b.bottom]; if (!(b.width > 0 || b.height > 0) || !all.some((g) => g.some((x) => meets(r, x)))) return; const s = scrolls(e, style(e)); if (!(bad(e) || (e !== m && ((mv[0] && s[0]) || (mv[1] && s[1]))))) return; if (!fixedUp(e)) col.push(r); }); } const pass = []; for (let i = 0; i < pts.length; i++) { const px = pts[i][0], py = pts[i][1]; let ok = true; for (let j = D; j > dk && ok; j--) if (deep(S.wins[j].document, px - S.cum[j][0], py - S.cum[j][1]) !== S.fes[j - 1]) ok = false; if (!ok) continue; const e = deep(doc, px - ox, py - oy); if (!e) continue; let found = false; for (let p = e; p; p = up(p)) { if (p === m || p === html) { found = p === m || m === doc; break; } if (bad(p)) break; if (p !== se && p !== doc.body) { const s = scrolls(p, w.getComputedStyle(p)); if (s[0] || s[1]) break; } } if (!found || col.some((r) => all[i].some((g) => meets(r, g)))) continue; pass.push(i); } return pass; }`;
/** The open shadow roots under the scroller `k` of the last SCROLL_STATE (the html element for a document), with the scroller first, at most `max`: their count; WHEEL_ROOT gives each one as a handle. */
export const WHEEL_ROOTS = `function (k, max) { const S = globalThis.__agentBrowserStageScroll, m = S && S.marks[k]; if (!m) return 0; ${ROOTS} S.roots = rootsOf(m.nodeType === 9 ? m.documentElement : m, max); return S.roots.length; }`;
/** The root `i` of the last WHEEL_ROOTS, as a handle: rule 2 resolves it into the page's main world and reads its listeners and those of every element inside it. */
export const WHEEL_ROOT = "function (i) { const S = globalThis.__agentBrowserStageScroll; return S && S.roots ? S.roots[i] || null : null; }";
/** A cross-origin frame's level (C11, the scroll in a frame): at each point of the top page, the element is the frame's owner (on its handle, after SCROLL_STATE with `owner`). */
export const OWNER_AT = `function (pts) { const S = globalThis.__agentBrowserStageScroll; if (!S || S.el !== this) return null; ${DEEP} const D = S.wins.length - 1; return pts.map((q) => { for (let j = D; j > 0; j--) if (deep(S.wins[j].document, q[0] - S.cum[j][0], q[1] - S.cum[j][1]) !== S.fes[j - 1]) return false; return deep(S.wins[0].document, q[0] - S.cum[0][0], q[1] - S.cum[0][1]) === this; }); }`;
/** The end of a scroll's or a wheel call's reads: the world lets go of the elements and windows of its last read (review-122 note 9). */
export const SCROLL_CLEAR = "function () { delete globalThis.__agentBrowserStageScroll; delete globalThis.__agentBrowserStageWheel; return true; }";
/** The same in the stage's own world on the top page (mouse.wheel's column). */
export const WHEEL_CLEAR = "() => { delete globalThis.__agentBrowserStageWheel; return true; }";
/**
 * mouse.wheel's column (C11, `mouseWheel`; review-122 option b), in the stage's own world on the top page at the page's
 * last point (x, y), for `ny` and `nx` signed notches of `px`: the element under the point (into open shadow roots and
 * same-origin frames; a cross-origin frame: `frame`), and on each axis (the vertical first) the scroller that the point's
 * chain scrolls first in the call's direction (a frame's document chains to its owner's), its range left, and the
 * distance along the move to the near edge of the first element of its content that the notches would bring under the
 * point: an element of rule 1, or another scroller with a range on that axis (also into open shadow roots). The element
 * under the point, the elements around it, the elements inside it when it is an element of rule 1 (an editor's own
 * content), and elements with `position: fixed` do not count (the body under the point would leave out the whole page). Each axis's
 * column in the top page's points (rule 2's boxes meet them). `again`: the same read after a plan's end; `same` is false
 * when the element under the point (a cross-origin frame's owner too) or the scroller of an axis is not the one of the
 * call's first read. The world keeps the scrollers for WHEEL_ROOTS_AT.
 */
export const WHEEL_COLUMN = `(x, y, ny, nx, px, again) => { ${SCROLLS} ${UP} ${INSIDE} ${DEEP} ${BADS} ${EACH} const lv = [{ doc: document, fe: null, ox: 0, oy: 0 }]; let e = deep(document, x, y); for (let i = 0; e && (e.localName === 'iframe' || e.localName === 'frame') && i < 8; i++) { let cd = null; try { cd = e.contentDocument; } catch (z) {} if (!cd) { const K = globalThis.__agentBrowserStageWheel; if (!again) globalThis.__agentBrowserStageWheel = { e, m: [null, null], roots: [] }; return { frame: true, same: !again || (!!K && K.e === e) }; } const r = e.getBoundingClientRect(), cs = e.ownerDocument.defaultView.getComputedStyle(e), top = lv[lv.length - 1]; const o = { doc: cd, fe: e, ox: top.ox + r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft), oy: top.oy + r.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop) }; lv.push(o); e = deep(cd, x - o.ox, y - o.oy); } if (!e) return { none: true }; const find = (ax, dir) => { let n = e; for (let i = lv.length - 1; i >= 0; i--) { const L = lv[i], doc = L.doc, w = doc.defaultView, html = doc.documentElement, se = doc.scrollingElement || html; let fixed = false; for (let p = n; p && p !== html; p = up(p)) { if (p === se) continue; const cs = w.getComputedStyle(p), s = scrolls(p, cs); if (s[ax]) { const at = ax ? p.scrollTop : p.scrollLeft, max = ax ? p.scrollHeight - p.clientHeight : p.scrollWidth - p.clientWidth, left = dir > 0 ? max - at : at; if (left > 0.5) return { m: p, L, left }; } if (cs.position === 'fixed') { fixed = true; break; } } if (!fixed) { const hs = w.getComputedStyle(html), bs = doc.body ? w.getComputedStyle(doc.body) : hs, ov = (k) => (hs[k] !== 'visible' ? hs[k] : bs[k]); if (!/(hidden|clip)/.test(ov(ax ? 'overflowY' : 'overflowX'))) { const vq = doc.compatMode === 'BackCompat' && doc.body ? doc.body : html, at = ax ? w.scrollY : w.scrollX, max = ax ? se.scrollHeight - vq.clientHeight : se.scrollWidth - vq.clientWidth, left = dir > 0 ? max - at : at; if (left > 0.5) return { m: doc, L, left }; } } if (!L.fe) break; n = L.fe; } return null; }; const fam = new Set(lv.map((l) => l.fe).filter(Boolean)); const eBad = bad(e), exempt = (q) => q === e || fam.has(q) || inside(q, e) || (eBad && inside(e, q)); const K = globalThis.__agentBrowserStageWheel, out = { k: [0, 0], left: [0, 0], col: [null, null], same: !again || !!K }, keep = { e, m: [null, null], roots: [] }; let shift = 0; const chainOk = (m, d) => { for (let p = e, i = 0; p && i < 4096; i++) { if (p === m || p === d.documentElement) return true; if (bad(p) && !fam.has(p)) return false; p = up(p) || (p.ownerDocument !== d && p.ownerDocument && p.ownerDocument.defaultView ? p.ownerDocument.defaultView.frameElement : null); } return false; }; for (const ax of [1, 0]) { const n = ax ? ny : nx; if (!n) continue; const dir = Math.sign(n), f = find(ax, dir), N = Math.abs(n); keep.m[ax] = f ? f.m : null; if (again && (!K || K.m[ax] !== keep.m[ax] || (K.e !== e && f && !chainOk(f.m, f.L.doc)))) out.same = false; if (!f) { out.k[ax] = N; continue; } keep.roots.push(f.m.nodeType === 9 ? f.m.documentElement : f.m); const D = Math.min(N * px, f.left), lx = x - f.L.ox, ly = y - f.L.oy + (ax ? 0 : shift), g = ax ? [lx, Math.min(ly, ly + dir * D), lx, Math.max(ly, ly + dir * D)] : [Math.min(lx, lx + dir * D), ly, Math.max(lx, lx + dir * D), ly]; out.col[ax] = [g[0] + f.L.ox, g[1] + f.L.oy, g[2] + f.L.ox, g[3] + f.L.oy]; out.left[ax] = f.left; const w = f.L.doc.defaultView, root = f.m.nodeType === 9 ? f.m.body || f.m.documentElement : f.m, cs = new Map(), style = (q) => { let c = cs.get(q); if (!c) cs.set(q, (c = w.getComputedStyle(q))); return c; }; const fixedUp = (q) => { for (let p = q; p && p !== root; p = up(p)) if (style(p).position === 'fixed') return true; return false; }; let dmin = Infinity; each(root, (q) => { if (exempt(q)) return; const b = q.getBoundingClientRect(); if (!(b.width > 0 || b.height > 0) || !(b.left <= g[2] && b.right > g[0] && b.top <= g[3] && b.bottom > g[1])) return; const s = scrolls(q, style(q)); if (!(bad(q) || (q !== f.m && s[ax]))) return; if (fixedUp(q)) return; const dd = ax ? (dir > 0 ? b.top - ly : ly - b.bottom) : (dir > 0 ? b.left - lx : lx - b.right); dmin = Math.min(dmin, Math.max(0, dd)); }); out.k[ax] = dmin === Infinity ? N : Math.min(N, Math.max(0, Math.ceil(dmin / px) - 1)); if (ax) shift = dir * Math.min(out.k[ax] * px, f.left); } if (!again) globalThis.__agentBrowserStageWheel = keep; else if (K) K.roots = keep.roots; return out; }`;
/** The open shadow roots under the scrollers of the last WHEEL_COLUMN (with each scroller first), at most `max`: their count; WHEEL_ROOT_AT gives each one as a handle. */
export const WHEEL_ROOTS_AT = `(max) => { const S = globalThis.__agentBrowserStageWheel; if (!S) return 0; ${ROOTS} const all = []; for (const r of S.roots || []) for (const q of rootsOf(r, max)) if (all.length < max && !all.includes(q)) all.push(q); S.all = all; return all.length; }`;
/** The root `i` of the last WHEEL_ROOTS_AT, as a handle (the stage's own world). */
export const WHEEL_ROOT_AT = "(i) => { const S = globalThis.__agentBrowserStageWheel; return S && S.all ? S.all[i] || null : null; }";
/** The wait for the smooth scroll of a round to end (C11: 350 ms, a first value; the vectors' scrollWaitMs). */
export const SCROLL_WAIT_MS = 350;
/** The group of the stage's own handles of a wheel point's read (released after it). */
export const STAGE_GROUP = "agent-browser-stage";
/** Rule 2 reads the boxes of at most this many elements with a wheel listener that is not passive; with more, the read fails open. */
export const WHEEL_LISTENERS_MAX = 64;
/** Rule 2 reads the listeners of at most this many roots (the scroller and the open shadow roots inside it); the others stay out of the read (review-122 B1). */
export const WHEEL_ROOTS_MAX = 32;
/** All of rule 2's reads for one wheel point end within this time, else the read fails open (review-122 note 13). */
export const WHEEL_LISTENERS_WAIT_MS = 1000;

/** Condition 3 of the press point, in the stage's own isolated world: the element at the client's point. */
export const ELEMENT_KIND = "(x, y) => { const el = document.elementFromPoint(x, y); if (!el) return null; return { tag: el.localName, type: el.getAttribute('type') ?? undefined, role: el.getAttribute('role') ?? undefined, href: el.localName === 'a' && el.hasAttribute('href'), usemap: el.localName === 'img' && el.hasAttribute('usemap'), editable: el.isContentEditable }; }";
/** Condition 4 of the press point, in the stage's own isolated world: the element at the spread point is the one at the client's point. */
export const SAME_ELEMENT = "(x1, y1, x2, y2) => { const a = document.elementFromPoint(x1, y1); return !!a && a === document.elementFromPoint(x2, y2); }";

// ------------------------------------------------------------------ the host

/** A client's answer: Chrome's result, or an error. */
export type Body = { result?: unknown; error?: { code: number; message: string } };
/** A rectangle of CSS px of the top page, both ends inside. */
export type Rect = { x0: number; y0: number; x1: number; y1: number };

/** What the stage needs of the model for one tab. */
export type StagePage = {
  /** The tab (the key of its state). */
  readonly id: number;
  /** The scope's person (C11: each scope gets one person, drawn once for the life of the scope). */
  readonly person: Person;
  /** One command to Chrome for the stage itself (an event or a read) on the tab's session (child undefined) or a child session. */
  send(child: string | undefined, method: string, params: Record<string, unknown>): Promise<any>;
  /** A client's call as the model sends it (resolves when it is sent); `answer` gets Chrome's answer, as the client's. */
  pass(child: string | undefined, method: string, params: any, answer: (body: Body) => void): Promise<void>;
  /** The client's error body of a refused command. */
  error(method: string, e: unknown): { code: number; message: string };
  /** A read in the stage's own isolated world (the relay's world): `fn` called with `args` (numbers only), by value. */
  ownRead(fn: string, args: number[]): Promise<unknown>;
  /** The activation before the first event of an action (C11, "The window comes forward for input"). */
  activate(): Promise<void>;
  /** A step of the stage's own in the tab's gate (the end of a plan with no client call left): the tab's later calls wait for it. */
  inGate(fn: () => Promise<void>): void;
  /** The page's last point as the model keeps it, with `x11` true for the X record of an activation; or null. */
  point(): { x: number; y: number; x11: boolean } | null;
  /** The X pointer's place mapped into the page (Linux, with the pointer paths on), or null (outside the page, unknown, the Mac). */
  xPoint?(): Promise<{ x: number; y: number } | null>;
  /** A node of the top page resolved into the stage's own isolated world (DOM.resolveNode by its backendNodeId): the objectId of its handle, or null. */
  ownNode?(backendNodeId: number): Promise<string | null>;
  /** A handle of the stage's own isolated world on the top page (`fn` called with `args`, numbers only; the stage's object group): its objectId, or null (mouse.wheel's column, rule 2). */
  ownObject?(fn: string, args: number[]): Promise<string | null>;
  /** Whether a connection holds a grant of the clipboard (C11, the paste: then a page could read it, and the stage pastes nothing). */
  clipboardGranted?(): boolean;
};

/**
 * The clipboard of the service's own display, for the paste (C11, the paste; src/service/unit/clipboard.ts): hold a text
 * for one paste, and give it up with the text cleared. The relay has none (its display is the daemon's).
 */
export interface StageClipboard {
  /** Take the CLIPBOARD selection with `text` for one paste: true when the owner holds it (the X server confirmed it). */
  hold(text: string): Promise<boolean>;
  /** Give the selection up and clear the text, at once. */
  clear(): void;
}

/** The stage's clock: the player's (now, sleep) and a timer that can be cancelled. A test gives a fake one. */
export type StageClock = Clock & { timer(ms: number, fn: () => void): () => void };
export const stageClock: StageClock = { ...systemClock, timer: (ms, fn) => { const t = setTimeout(fn, Math.max(0, ms)); return () => clearTimeout(t); } };

export type StageOptions = {
  log: (line: string) => void;
  random: Random;
  /** "linux": whole px and whole-ms timestamps; "mac": both with their fractions. */
  platform: "linux" | "mac";
  clock?: StageClock;
  /** The epoch time (ms) of an event's send (the player's stamp). */
  stamp?: () => number;
  /** A log line for each hit-target setup and each end of an action (counts and times, never a point): the live rows. */
  trace?: boolean;
  /** The clipboard of the service's own display (the paste), or none. */
  clipboard?: StageClipboard | null;
};

// ------------------------------------------------------------------ the state

type Kind = "mouse" | "key" | "text" | "setup" | "field" | "select" | "scroll" | "childInput" | "mark";
/** A client call that the stage took: its step runs in the tab's gate. */
export type Entry = {
  readonly child: string | undefined; readonly method: string; readonly params: any; readonly answer: (body: Body) => void;
  readonly kind: Kind; readonly util: Utility | null;
  /** Its plan ended (a dialog, STAGE_EVENT_WAIT_MS, STAGE_ACTION_MAX_MS) before its step: its own event goes at once. */
  ended?: boolean;
  /** Its plan failed: the client gets this error, with no event. */
  failedWith?: { code: number; message: string };
  /** The tab's state when the call arrived: its step runs on that state, also after the model dropped the tab. */
  readonly st: TabState;
};
type EndWhy = "dialog" | "wait" | "limit" | "drop";
/**
 * How the model dropped a tab (C11, dialogs: the end of the wait for a close). "tab": its target ended, it closed, or
 * Chrome detached it. "session": the client's session or connection ended (also a C10 timeout's detach, which ends the
 * client's sessions of the tab, and the end of the relay's link, which closes every connection).
 */
export type DropWhy = "tab" | "session";
/** The error of a held call at a navigation of the main frame (C11, dialogs: the held events never reach the new document). */
/** The kinds of Page.frameStartedNavigating that keep the document. */
const SAME_DOCUMENT = new Set(["sameDocument", "historySameDocument"]);
export const CONTEXT_GONE = { code: -32000, message: "Execution context was destroyed: the page navigated while a dialog was open, and the input stage sent none of the held input" };
/** A translated action: the lock, the plan's latency and its end. */
class Action {
  ended: EndWhy | null = null;
  failed = false;
  /** The error of the plan's refused event, for the client calls of the plan that come later. */
  failBody: { code: number; message: string } | undefined;
  /** The time of the plan's end (a key whose answer came after it, while a dialog was open, did not reach the page). */
  endedAt = Infinity;
  readonly endSignal: Promise<void>;
  private fireEnd!: () => void;
  readonly unanswered = new Set<{ t: number }>();
  watchdog: (() => void) | null = null;
  limit: (() => void) | null = null;
  readonly latency: number;
  readonly release: () => void;
  readonly started: number;
  events = 0;
  constructor(release: () => void, latency: number, started: number) {
    this.release = release; this.latency = latency; this.started = started;
    this.endSignal = new Promise((r) => (this.fireEnd = r));
  }
  fire(): void { this.fireEnd(); }
  get over(): boolean { return this.ended !== null || this.failed; }
}
type Setup = { node: string | undefined; child: string | undefined; action: string; hit: Pt | null; trial: boolean; used: boolean };
/**
 * A planned key event of the run: the stream's event, and for a client's own key its params and its call (`e`; null when
 * the call was answered early). `typed`: a key of a typed text or of the stage's own keys (no client call asked for it
 * alone). `sent`: Chrome's answer, once it went.
 */
type KeyItem = { ev: KeyEv; client?: any; e?: Entry | null; typed?: { commands?: string[] }; sent?: Promise<any>; answeredAt?: number;
  /** A character with no US key in a typed part: it goes as Input.insertText at its time. */
  insert?: string;
  /**
   * A paste's V keyDown: its send closes the paste path until its answer (review-126 B4), then until the page answers the
   * stage's read after it (board ab-t30.21); `via`: the field's route (null: the top page), where the read goes.
   */
  pasteV?: { via: FocusVia };
  /** A client's paste key: the route of its read after its answer, from the focus read before it (review-131b N3). */
  vRoute?: VRoute };
/**
 * A collected call of a key run (C11, the collected keys): a printable key with its keyDown and, when it came, its keyUp
 * (the client's own params and the arrival of its keyDown), or a text of Input.insertText.
 */
type ColItem = { ch: string; down: any; downAt: number; up?: any } | { text: string; params: any };
/** The collected part of a key run: its calls, the key that is down (its keyUp has not come), the arrival of its last call, and the least hold of the client (a client's delay). */
type Collect = { items: ColItem[]; down: (ColItem & { down: any }) | null; lastAt: number; holdMin: number };
const textOf = (items: ColItem[]) => items.map((i) => ("text" in i ? i.text : i.ch)).join("");
type Press = { at: number; hold: number; client: Pt; point: Pt; button: string };
class TabState {
  readonly pending: Entry[] = [];
  /** The client's mark of a secret (C11, the paste, rule 8): no text of the tab pastes while it holds. */
  secret = false;
  /** The point of the stage's last pointer event in the page. */
  last: Pt | null = null;
  lastWasMove = false;
  lastMoveAt = -Infinity;
  releasedAt = -Infinity;
  press: Press | null = null;
  /** The buttons that the stage's events hold down, each with the clickCount of its press, and the keys (by their code; `own`: a key of the stage's own, its Shift or a chord's modifier; `merged`: a Shift of the stage's own that a client's press of Shift took). */
  readonly buttons = new Map<string, number>();
  readonly keys = new Map<string, { at: number; params: any; own?: boolean; merged?: boolean }>();
  /**
   * The key run (C11, the input lock and the keys): the tab's key stream (the scope's person; it lives with the tab, so the
   * drift of the person's speed goes on from run to run), whether a run is open, the planned key events that have not
   * gone (an early-answered release, the Shift's release), the timer of the next one, and the run's end 1 s after its
   * last key. `runPlain`: after STAGE_ACTION_MAX_MS the rest of the run goes as the client sends it.
   */
  ks: KeyStream | null = null;
  runOpen = false;
  runPlain = false;
  /** The collected part of the key run (C11, the collected keys), or null. */
  col: Collect | null = null;
  /** The key run's time with a person's timing so far (its steps' time, ms): at STAGE_TYPE_MAX_MS the rest of the run goes as the client sends it. */
  runSpent = 0;
  /** A paste's text is on the clipboard: every end of its plan gives it up at once. */
  pasting = false;
  /** A collected part's events go now (the tests wait for them: no client call does). */
  parting = false;
  /** A flush of the part runs (a close of the tab or its session's end): the rest of the part goes as one Input.insertText. */
  flushing = false;
  /** The action of a running part that the flush ended: it keeps the lock until the part's rest has gone (review-126b R1). */
  flushKept: Action | null = null;
  /** A part's step that waits for the lock: the flush ends the wait (review-126b R1). */
  flushWake: (() => void) | null = null;
  kq: KeyItem[] = [];
  kTimer: (() => void) | null = null;
  runTimer: (() => void) | null = null;
  /** The field of the tab's last focus or fill recognizer, and the last node of each child session (the typing rule's reads in a cross-origin frame). */
  field: { child: string | undefined; node: string; follow: boolean } | null = null;
  /** The next Input.insertText is fill's (its script selected the field's text): the value check wants the text alone. */
  fillNext = false;
  /** A typed text's plan that runs: a navigation of the main frame stops it (review-119 N3). */
  typing: { navigated: boolean } | null = null;
  readonly childNodes = new Map<string, string>();
  /** The buttons and keys ("key:<code>") that the stage released at the end of a plan: the client's own release gets no event. */
  readonly released = new Set<string>();
  action: Action | null = null;
  running = false;
  /** The lock that an ended plan's events took again (C11: every end of a plan frees the lock; its later events take it again). */
  tail: (() => void) | null = null;
  tailActive = false;
  /** The limit of that lock (STAGE_ACTION_MAX_MS); after it the plan's next ended call takes the lock again (review-126b note 3). */
  tailLimit: (() => void) | null = null;
  /** The model dropped the tab (C11, dialogs: the end of the wait for a close). */
  gone: DropWhy | null = null;
  /** A navigation of the main frame ended the wait for a close: each held call gets this error, with no event. */
  heldGone: { code: number; message: string } | null = null;
  /** The host of the tab's last call (the releases at a drop). */
  page: StagePage | null = null;
  setup: Setup | null = null;
  /** The handles that the tab's hit-target setups returned (the stop recognizer's first handle), each with its node; at most KEPT_MAX. */
  readonly handles = new Map<string, string | undefined>();
  /** The answers of the client's own DOM.getContentQuads, by the node's objectId (condition 2 of the press point). */
  readonly quads = new Map<string, Box>();
  miss = false;
  missAt = -Infinity;
  /** The node of the last miss: a miss marks its node (C11, the recoveries). */
  missNode: string | undefined = undefined;
  recov: { node: string | undefined; n: number; limited?: boolean } | null = null;
  /** After the limit of recoveries: the rest of the action goes as Playwright sends it. */
  plain = false;
  avoid: Rect | null = null;
  rest: { to: Pt; from: Pt; samples: Sample[] } | null = null;
  /** The end of a kept rest (HOVER_WAIT_MS after the setup's answer). */
  restTimer: (() => void) | null = null;
  /**
   * A move run (N9 of PR #116; C11, the input lock): the tab's last step was a move with no button down, and its action
   * stays open for the tab's next call (a step of mouse.move with steps comes only after the answer of the one before).
   * `moveTimer` ends the run RUN_IDLE_MS after that step.
   */
  lastMove = false;
  moveTimer: (() => void) | null = null;
  spread: { client: Pt; point: Pt } | null = null;
  readonly flight = { n: 0 };
  /** The child sessions of the tab's cross-origin frames: the frame's id and its parent session. */
  readonly frames = new Map<string, { frameId: string; parent: string | undefined }>();
  /** An open dialog of the tab: the ended plan's events wait for its close (Chrome drops the input that it gets while it is open). */
  dialog: { closed: Promise<void>; close: () => void; beforeunload: boolean; frameId: string | undefined; reading?: boolean } | null = null;
  /** The id of the tab's main frame (from Page.frameNavigated with no parent), and the time of the start of its cross-document navigation that has not ended. */
  mainFrame: string | undefined = undefined;
  navStart: number | null = null;
  /**
   * Chrome's answers of the ended press and key press events that went (note D of PR #116): such an event can open a
   * dialog of its own, and Chrome answers it only after that dialog's close; the end's releases wait for these answers.
   */
  endedDowns: Promise<unknown>[] = [];
  /** The page's residual of each axis of its wheel calls (C11, the scroll and the wheel), and the time of its last notch. */
  wheel: Wheel | null = null;
  lastNotchAt = -Infinity;
  /** The count of the main frame's navigations: one stops the notches of a wheel call and of a scroll (review-122 note 6). */
  navs = 0;
}

/** The input lock: one for all pages of the agent browser, in the order of arrival. */
export class InputLock {
  private tail: Promise<void> = Promise.resolve();
  held = 0;
  acquire(): Promise<() => void> {
    let open!: () => void;
    const next = new Promise<void>((r) => (open = r));
    const prev = this.tail;
    this.tail = prev.then(() => next);
    return prev.then(() => {
      this.held++;
      let done = false;
      return () => { if (!done) { done = true; this.held--; open(); } };
    });
  }
}

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta"]);
const MODIFIER_BIT: Record<string, number> = { Alt: ALT, Control: CONTROL, Meta: META, Shift: SHIFT };
/**
 * The key of a client's key event for the stream: what it types, and the modifiers that it needs: Shift for a shifted
 * character of the US layout that comes with no Shift (Playwright's capital or symbol), the client's own Shift, and the
 * client's Control, Alt or Meta when the client holds that key (`held`; a bit that the client sets with no key down goes
 * on the event as it is, with no press of the stage's own).
 */
export function keyOf(p: any, held: number): Key {
  const text = typeof p?.text === "string" && p.text !== "" ? p.text : undefined;
  const shift = (text !== undefined ? charKey(text)?.modifiers ?? 0 : 0) & SHIFT;
  const mods = Number(p?.modifiers ?? 0);
  return {
    key: String(p?.key ?? ""), code: String(p?.code ?? ""), keyCode: Number(p?.windowsVirtualKeyCode ?? p?.nativeVirtualKeyCode ?? 0),
    ...(text !== undefined ? { text } : {}), modifiers: shift | (mods & SHIFT) | (mods & held & (ALT | CONTROL | META)),
    ...(p?.type === "keyDown" || p?.type === "rawKeyDown" ? { type: p.type } : {}),
  };
}
/** The typing rule's read of the focused element (FOCUSED_FIELD, FOCUSED_IN); `ac`: a text field's autocomplete attribute. */
type FocusRead = { tag: string; type?: string; editable: boolean; typing: boolean; ac?: string | null; value: string | null; s: number | null; e: number | null };
/** The autocomplete tokens of a secret's field (C11, the paste, rule 7; board ab-t30.22). */
const SECRET_TOKENS = ["current-password", "new-password", "one-time-code", "cc-number", "cc-csc"];
/** The field rule: a password field, or a field whose autocomplete has a token of a secret (in any case). */
export const secretField = (f: FocusRead): boolean => f.type === "password" || String(f.ac ?? "").toLowerCase().split(/\s+/).some((t) => SECRET_TOKENS.includes(t));
/** Where that read ran: null for the top page (the stage's own world), else a node of a cross-origin frame's session. */
type FocusVia = { child: string; node: string } | null;
/**
 * A key event that Chrome takes as a paste on Linux (review-131 note 1, review-131b N1; C11, the paste, rule 6), from
 * Chromium's editing key table (editing_behavior.cc: Control+V, Control+Shift+V, Shift+Insert by the key code, the DOM key
 * Paste), wider where the table matches its modifiers exactly (fail closed): a keyDown or rawKeyDown with the Control
 * modifier (and any other) and the key v in any case, the code KeyV or the key code 86, whatever its key text; with the
 * Shift modifier (and any other) and Insert (its key, its code or the key code 45); the key Paste; and any key event whose
 * commands hold a command that starts with paste.
 */
export const pasteKey = (p: Record<string, unknown>): boolean => {
  if (p.type !== "keyDown" && p.type !== "rawKeyDown") return false;
  if (Array.isArray(p.commands) && p.commands.some((c) => /^paste/i.test(String(c)))) return true;
  const m = Number(p.modifiers) || 0, key = String(p.key ?? ""), code = String(p.code ?? ""), kc = Number(p.windowsVirtualKeyCode ?? 0);
  if ((m & CONTROL) !== 0 && (key.toLowerCase() === "v" || code === "KeyV" || kc === 86)) return true;
  if ((m & SHIFT) !== 0 && (key === "Insert" || code === "Insert" || kc === 45)) return true;
  return key === "Paste";
};
/** A paste's V in the closed set (C11, the paste, rule 6): `reading` from V's answer, while the stage waits for its read (board ab-t30.21). */
type VWait = { reading: boolean; cancel: () => void };
/** The route of the read after a client's paste key, from the focus read before the key (review-131b N3). */
type VRoute = { via: FocusVia };
/** The focus click's read of a field (FIELD_STATE), with its box and offset in the top page's points; lox, loy: the same-origin sum alone. */
type FieldRead = { kind: "input" | "textarea" | "editable" | "other"; type?: string; disabled: boolean; readOnly: boolean; active: boolean; focused: boolean; len: number; s: number | null; e: number | null;
  /** The field's widget sign (WIDGET; board ab-t30.18), or null. */
  widget?: string | null; box: Rect; ox: number; oy: number; lox: number; loy: number;
  /** The cross-origin levels above the field, innermost first: the parent's session, the owner's node, its content box in the parent's points. */
  levels: { parent: string | undefined; owner: number; r: Rect }[] };
const TIMEOUT = Symbol("timeout");
/** The typing rule's decision for a text (C11, the typing rule and the paste). */
type Rule = { how: "typed"; plan: ReturnType<typeof typingPace> & {}; before: FocusRead; via: FocusVia } | { how: "paste"; before: FocusRead; via: FocusVia } | { how: "asIs"; why: string; noPaste?: string };
/** A paste of a text: its call (a collected part's stand-in), the field's read before it, the value that a paste gives, and the collected part's calls (its fallback: the client's own keys), or null (the client's Input.insertText). */
type PasteJob = { e: Entry; text: string; via: FocusVia; t0: number; before: FocusRead; want: string | null; fallback: ColItem[] | null };
const same = (a: Pt | null | undefined, b: Pt | null | undefined) => !!a && !!b && a.x === b.x && a.y === b.y;
const near = (a: Pt, b: Pt, d: number) => Math.hypot(a.x - b.x, a.y - b.y) <= d;
/** A point inside a box (the hit test of a pixel: the right and the bottom edges are outside, as for getBoundingClientRect). */
const inside = (p: Pt, r: Rect) => p.x >= r.x0 && p.x < r.x1 && p.y >= r.y0 && p.y < r.y1;
/** Whether the segment a-b meets the rectangle (Liang-Barsky). */
export function crosses(a: Pt, b: Pt, r: Rect): boolean {
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  for (const [p, q] of [[-dx, a.x - r.x0], [dx, r.x1 - a.x], [-dy, a.y - r.y0], [dy, r.y1 - a.y]]) {
    if (p === 0) { if (q < 0) return false; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return t0 <= t1;
}
/** A quad (8 numbers) as a rectangle, or null when it is not one (a transform). */
export function quadRect(q: unknown): Rect | null {
  if (!Array.isArray(q) || q.length !== 8 || !q.every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
  const r = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  for (let i = 0; i < 4; i++) if ((xs[i] !== r.x0 && xs[i] !== r.x1) || (ys[i] !== r.y0 && ys[i] !== r.y1)) return null;
  return r;
}

/** The handle on which a scroller's reads run: its session, its objectId, the offset of its points in the top page, and (a cross-origin frame's levels) the handle of the frame's owner in the stage's own world. */
type Reader = { child: string | undefined; obj: string; ox: number; oy: number; owner?: string };
/** A scroller of the scroll's read, in the top page's points: its visible box (unclipped), its scroll position and range ([x, y]), its reader and its index there. */
type Level = { r: Rect; s: [number, number]; m: [number, number]; doc: boolean; rd: Reader; k: number; w: [boolean, boolean]; pad: Sides };
/**
 * The scroll's read: the target and its scroll-margin, its scrollers (innermost first; also the boxes with overflow hidden
 * or clip, whose `w` is false: no wheel moves them), and the visible part of each (its box within the viewport and within
 * each scroller around it).
 */
type ScrollView = { t: Rect; mg: Sides; levels: Level[]; vis: Rect[]; owner?: string };
/** A box's four sides of a computed style (scroll-padding, scroll-margin: review-122 note 4): left, top, right, bottom. */
type Sides = [number, number, number, number];
const sidesOf = (q: unknown): Sides => (Array.isArray(q) && q.length === 4 && q.every((v) => typeof v === "number" && Number.isFinite(v)) ? [q[0], q[1], q[2], q[3]] : [0, 0, 0, 0]);
/** A box grown by sides (scroll-margin), or shrunk (scroll-padding: `sign` -1). */
const grow = (r: Rect, d: Sides, sign = 1): Rect => ({ x0: r.x0 - sign * d[0], y0: r.y0 - sign * d[1], x1: r.x1 + sign * d[2], y1: r.y1 + sign * d[3] });
/** A notch, or the rest of a wheel call as one event (review-122 option b): its time in the plan, its deltas, the notches that it holds, and when it went and Chrome answered it. */
type WheelItem = { t: number; dx: number; dy: number; n: { x: number; y: number }; one?: boolean; sent?: Promise<unknown>; answeredAt?: number };
/** mouse.wheel's column (WHEEL_COLUMN and rule 2): the notches of each axis that go, whether the point is the first read's, and whether it is over a cross-origin frame. */
type Column = { k: { x: number; y: number }; same: boolean; frame: boolean };
const shift = (r: Rect, x: number, y: number): Rect => ({ x0: r.x0 + x, y0: r.y0 + y, x1: r.x1 + x, y1: r.y1 + y });
const meet = (a: Rect, b: Rect): Rect => ({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });
const rectOf = (q: unknown): Rect | null => (Array.isArray(q) && q.length === 4 && q.every((v) => typeof v === "number" && Number.isFinite(v)) ? { x0: q[0], y0: q[1], x1: q[2], y1: q[3] } : null);
/** C11's in-view rule on one axis: all of it inside the view, or its middle in the middle share of the view (60% vertically, 80% across). */
const axisIn = (lo: number, hi: number, vlo: number, vhi: number, share: number) => vhi > vlo && ((lo >= vlo && hi <= vhi) || Math.abs((lo + hi) / 2 - (vlo + vhi) / 2) <= ((vhi - vlo) * share) / 2);
/** An element is in view (C11, the scroll and the wheel) of the visible part of its nearest scroller (the viewport for an element with no inner scroller). */
export const inView = (t: Rect, v: Rect) => axisIn(t.x0, t.x1, v.x0, v.x1, 0.8) && axisIn(t.y0, t.y1, v.y0, v.y1, 0.6);

// ------------------------------------------------------------------ the stage

export class Stage {
  private readonly o: StageOptions;
  private readonly clock: StageClock;
  private readonly tabs = new Map<number, TabState>();
  private readonly players = new Map<number, CdpPlayer>();
  readonly lock = new InputLock();
  /** The counts of the harness (C11, the log and the counts): each case of no change and each end of a plan. */
  readonly counts: Record<string, number> = {};
  /** The clipboard of the service's own display (C11, the paste): the service sets it; with none a long text goes as Playwright's own input. */
  clipboard: StageClipboard | null;
  /**
   * The paste's V keyDowns that close the paste path, by tab (C11, the paste, rule 6): each from its send until its answer
   * (review-126 B4: Chrome reads the selection in V's default action, before V's answer), then until the page answers the
   * stage's read that goes after that answer (board ab-t30.21: the start of a navigation of the main frame answers V at
   * once, while the page's handler runs; the page answers the read only after V's default action). No paste puts a text on
   * the clipboard while one of them is in the set. Page.frameNavigated of the tab's main frame ends the read's wait; a
   * tab's end drops its own.
   */
  private readonly pendingV = new Map<number, Set<VWait>>();
  /**
   * The tabs whose paste V got an error answer (review-126b note 2): an error is not V's answer, because Chrome can still
   * run V's paste in the page, so the paste path stays closed until the tab ends or its main frame navigates (C11, rule 6).
   */
  private readonly failedV = new Set<number>();
  /**
   * The tabs that the stage dropped while their V, its read or their closed path was in the closed set, and whose page
   * can still run (review-131 B1): Chrome's detach of the debugger, a tab that leaves the model (an orphan, C5), a
   * replaced tab. The paste path stays closed for V_READ_MAX_MS after such a drop (each value cancels its timer); a close
   * of the tab (`ended`: its page ended) ends it.
   */
  private readonly droppedV = new Map<number, () => void>();

  constructor(o: StageOptions) {
    this.o = o;
    this.clock = o.clock ?? stageClock;
    this.clipboard = o.clipboard ?? null;
  }

  private count(k: string, n = 1): void { this.counts[k] = (this.counts[k] ?? 0) + n; }
  /** Whether a paste's V keyDown of any tab is in the closed set (its answer or its read's answer has not come: review-126 B4, board ab-t30.21), or the path stays closed after an error or the read's limit (review-126b note 2). */
  private vPending(): boolean { if (this.failedV.size || this.droppedV.size) return true; for (const s of this.pendingV.values()) if (s.size) return true; return false; }
  /**
   * A paste's V in the closed set (C11, the paste, rule 6): until its answer; then until the page answers the stage's read
   * (V_READ, or V_READ_IN on `via`, the field's node of a cross-origin frame, where V's default action runs), which goes
   * at V's answer (board ab-t30.21). An error answer of V, an error of the read and the read's limit (V_READ_MAX_MS) each
   * keep the path closed until the tab ends or its main frame navigates (failedV: fail closed).
   */
  private trackV(page: StagePage, sent: Promise<unknown>, via: FocusVia): void {
    const id = page.id;
    let s = this.pendingV.get(id);
    if (!s) this.pendingV.set(id, (s = new Set()));
    const set = s, w: VWait = { reading: false, cancel: () => {} };
    set.add(w);
    // After the tab's end (its set is gone), or after the end of the read's wait (a navigation), a late answer or error changes nothing.
    const live = () => this.pendingV.get(id) === set && set.has(w);
    const closed = (count: string, why: string) => {
      set.delete(w);
      this.failedV.add(id);
      this.count(count);
      this.o.log(`relay: the input stage: tab ${id}: ${why}; the paste path stays closed until the tab ends or its main frame navigates`);
    };
    sent.then(() => {
      if (!live()) return;
      w.reading = true;
      const read = via ? page.send(via.child, "Runtime.callFunctionOn", { objectId: via.node, functionDeclaration: V_READ_IN, returnByValue: true }) : page.ownRead(V_READ, []);
      const limit = new Promise<{ limit: true }>((r) => { w.cancel = this.clock.timer(V_READ_MAX_MS, () => r({ limit: true })); });
      void Promise.race([read.then(() => ({ ok: true as const }), (error: unknown) => ({ error })), limit]).then((r) => {
        w.cancel();
        if (!live()) return;
        if ("ok" in r) { set.delete(w); return; }
        if ("limit" in r) return closed("vReadLimits", `no answer of the paste's read after V's answer in ${V_READ_MAX_MS} ms`);
        closed("vReadErrors", `an error of the paste's read after V's answer (${String((r.error as Error)?.message ?? r.error).slice(0, 120)})`);
      });
    }, (err) => {
      if (!live()) return;
      closed("vErrors", `an error answer of the paste's V (${String((err as Error)?.message ?? err).slice(0, 120)})`);
    });
  }
  private st(page: StagePage): TabState {
    let s = this.tabs.get(page.id);
    if (!s) this.tabs.set(page.id, (s = new TabState()));
    s.page = page;
    return s;
  }
  /** What the stage keeps of a tab (the tests; no client sees it). */
  state(id: number) {
    const s = this.tabs.get(id);
    return s ? { last: s.last, buttons: [...s.buttons.keys()], keys: [...s.keys.keys()], action: !!s.action, miss: s.miss, avoid: s.avoid, plain: s.plain, recoveries: s.recov?.n ?? 0, pending: s.pending.length,
      quads: s.quads.size, handles: s.handles.size, dialog: !!s.dialog, run: s.runOpen, runPlain: s.runPlain, planned: s.kq.length + (s.ks?.ownShift && s.action && !s.action.over ? 1 : 0) + (s.col?.items.length ?? 0) + (s.parting ? 1 : 0) + (s.moveTimer ? 1 : 0),
      residual: s.wheel ? [s.wheel.x, s.wheel.y] : [0, 0], collected: s.col?.items.length ?? 0, runSpent: s.runSpent, pasting: s.pasting } : null;
  }
  private linux(): boolean { return this.o.platform === "linux"; }
  /** A client's point as the stage sends it: whole CSS px on Linux (round half up), as it is on the Mac. */
  private fit(p: { x: number; y: number }): Pt { return this.linux() ? { x: Math.round(p.x), y: Math.round(p.y) } : { x: p.x, y: p.y }; }

  private player(page: StagePage, st: TabState): CdpPlayer {
    let pl = st.gone ? undefined : this.players.get(page.id);
    if (!pl) {
      const dev = page.person.params.device;
      pl = new CdpPlayer((method, params) => this.sendEvent(page, st, undefined, method, params), {
        clock: this.clock, stamp: this.o.stamp ?? (this.linux() ? linuxStamp : macStamp), latencyMs: dev.latencyMs, wholeMs: this.linux() && dev.wholeMsTimestamps,
        random: this.o.random, maxInFlight: dev.movesInFlight,
      });
      if (!st.gone) this.players.set(page.id, pl);
    }
    return pl;
  }

  // ---------------------------------------------------------------- the model's calls

  /**
   * A client's call arrives (before the tab's gate): the entry of a call that the stage takes, or null. On the tab's own
   * session the stage takes Input.dispatchMouseEvent, Input.dispatchKeyEvent and Input.insertText, and on every session
   * the hit-target setup, the focus and fill recognizers and DOM.scrollIntoViewIfNeeded (the other recognizers of C11's
   * table belong to the later part, and pass; a retry's script scroll passes, counted).
   */
  arrive(page: StagePage, child: string | undefined, method: string, params: any, answer: (body: Body) => void): Entry | null {
    let kind: Kind | null = null, util: Utility | null = null;
    if (!child && method === "Input.dispatchMouseEvent") kind = "mouse";
    else if (!child && method === "Input.dispatchKeyEvent") kind = "key";
    else if (!child && method === "Input.insertText") kind = "text";
    // The client's mark of a secret (C11, the paste; board ab-t30.22): a step of the tab's gate, which the stage answers.
    else if (!child && method === SECRET_INPUT) kind = "mark";
    // An input call on a frame's own session (review-126 note 3): under the input lock, as the client sent it.
    else if (child && method.startsWith("Input.")) kind = "childInput";
    else if (method === "DOM.scrollIntoViewIfNeeded") kind = "scroll";
    else if (method === "Runtime.callFunctionOn" && (util = utilityCall(method, params))) {
      if (util.name === "hit-target check") kind = "setup";
      else if (util.name === "focus" || util.name === "fill" || util.name === "select text") kind = "field";
      // Playwright's selectOption (C11, the script calls; board ab-t30.12.1): a person's click, keys and Enter, where they give its result.
      else if (util.name === "select option") kind = "select";
      // A retry's script scroll passes in the first build, and the stage counts it (C11, the scroll and the wheel).
      else if (util.name === "retry scroll") this.count("retryScrolls");
      // blur passes, and the stage counts it (C11, the script calls).
      else if (util.name === "blur") this.count("blurs");
    }
    if (!kind) return null;
    const st = this.st(page);
    const e: Entry = { child, method, params: params ?? {}, answer, kind, util, st };
    st.pending.push(e);
    return e;
  }

  /** The step of a taken call, in the tab's gate: it ends when the call's events have gone and Chrome answered them (or the plan ended). */
  async step(page: StagePage, e: Entry): Promise<void> {
    const st = e.st;
    const i = st.pending.indexOf(e);
    if (i >= 0) st.pending.splice(i, 1);
    st.running = true;
    this.stopKeyTimer(st);
    // The tab's next call goes in the action of a move run (N9); the run goes on only when this step is a move too.
    this.stopMoveRun(st);
    st.lastMove = e.kind === "mouse" && !e.ended && e.params.type === "mouseMoved" && !e.params.buttons && (e.params.button ?? "none") === "none";
    let t0 = this.clock.now();
    try {
      if (st.gone) return await this.goneStep(page, st, e);
      // The collected keys (C11): a printable key of a key run, its release and a text in the run get their answers at
      // once; any other call first sends the collected part, typed or pasted.
      if (this.joins(st, e)) return this.collect(page, st, e);
      if (st.col) { await this.endPart(page, st); t0 = this.clock.now(); }
      if (e.failedWith) { e.answer({ error: e.failedWith }); return; }
      // A call that is not a key ends the tab's key run (C11, the input lock): the run's planned releases go first, and an
      // action that holds nothing then ends (the next action takes the lock and runs the activation again).
      if (e.kind !== "key" && e.kind !== "text" && st.runOpen) {
        await this.endRun(page, st);
        if (st.action && !st.action.over && !st.buttons.size && !st.keys.size && !st.rest) this.close(st, page.id);
      }
      // The client's mark of a secret: after the tab's key run ended (its part went with the mark as it was).
      if (e.kind === "mark") { st.secret = e.params.enabled === true; e.answer({ result: {} }); return; }
      // fill's text is the next Input.insertText only when no other call comes between.
      if (e.kind !== "text" && e.kind !== "field") st.fillNext = false;
      if (e.kind === "setup") return await this.setupStep(page, st, e);
      if (e.kind === "field") return await this.fieldStep(page, st, e);
      if (e.kind === "select") return await this.selectStep(page, st, e);
      if (e.kind === "scroll") return await this.scrollStep(page, st, e);
      if (e.kind === "childInput") return await this.childInputStep(page, st, e);
      if (e.ended) return await this.endedEvent(page, st, e);
      if (e.kind === "mouse") {
        const t = e.params.type;
        if (t === "mouseMoved" && !e.params.buttons && (e.params.button ?? "none") === "none") return await this.moveStep(page, st, e);
        if (t === "mouseWheel") return await this.wheelStep(page, st, e);
        if (t === "mousePressed") return await this.pressStep(page, st, e);
        if (t === "mouseReleased") return await this.releaseStep(page, st, e);
        this.count("plainMouse");
        return await this.plainStep(page, st, e);
      }
      if (e.kind === "key") return await this.keyStep(page, st, e);
      return await this.textStep(page, st, e);
    } catch (err) {
      this.o.log(`relay: the input stage: a step of tab ${page.id} failed: ${(err as Error).message}`);
      if (!st.action?.failed) e.answer({ error: page.error(e.method, err) });
    } finally {
      // The key run's time with a person's timing (C11, the time of a key run): its key and text steps.
      if ((e.kind === "key" || e.kind === "text") && st.runOpen) { st.runSpent += this.clock.now() - t0; this.budget(page, st); }
      st.running = false;
      await this.afterStep(page, st);
    }
  }

  /** At STAGE_TYPE_MAX_MS of the key run's time with a person's timing, the rest of the run goes as the client sends it (counted). */
  private budget(page: StagePage, st: TabState): void {
    if (st.runPlain || st.runSpent < STAGE_TYPE_MAX_MS) return;
    st.runPlain = true;
    this.count("runBudgetEnds");
    this.o.log(`relay: the input stage: a key run of tab ${page.id} took ${STAGE_TYPE_MAX_MS} ms with a person's timing; the rest of the run goes as the client sends it`);
  }

  /** The answer of a call that passed (the stage watches the client's DOM.getContentQuads and the check's stop). */
  saw(page: StagePage, child: string | undefined, method: string, params: any, result: any): void {
    const st = this.st(page);
    if (method === "DOM.getContentQuads" && typeof params?.objectId === "string") {
      const r = quadRect(result?.quads?.[0]);
      if (r) { st.quads.delete(params.objectId); st.quads.set(params.objectId, { x: r.x0, y: r.y0, w: r.x1 - r.x0, h: r.y1 - r.y0 }); }
      while (st.quads.size > KEPT_MAX) st.quads.delete(st.quads.keys().next().value!);
      return;
    }
    const u = utilityCall(method, params);
    if (u?.name === "the check's stop" && u.handles[0] && st.handles.has(u.handles[0])) {
      // The stop ends its attempt: the plain mode after the recoveries' limit covers that attempt only.
      st.plain = false;
      const v = result?.result?.value;
      if (v !== undefined && v !== "done") { st.miss = true; st.missAt = this.clock.now(); st.missNode = st.handles.get(u.handles[0]); this.count("stopMisses"); }
    }
  }

  /** Whether the tab's ended plan waits for a dialog's close (the model sends a client's Page.disable before the tab's gate then). */
  waitsForClose(page: StagePage): boolean { return !!this.tabs.get(page.id)?.dialog; }

  /** A Chrome event of the tab that goes to the client: a dialog ends the plan; the frames' sessions for the mapping. */
  event(page: StagePage, child: string | undefined, method: string, params: any): void {
    const st = this.st(page);
    if (method === "Page.javascriptDialogOpening") {
      if (!st.dialog) {
        let close!: () => void; const closed = new Promise<void>((r) => (close = r));
        st.dialog = { closed, close, beforeunload: !child && params?.type === "beforeunload", frameId: typeof params?.frameId === "string" ? params.frameId : undefined };
      }
      return this.end(page, st, "dialog");
    }
    // A cross-document navigation of the main frame under way (point 1 of board ab-t30.17): Chrome closes an open dialog
    // at the navigation's start, before its Page.frameNavigated (measured on Chromium 156: Page.frameStartedNavigating,
    // then Page.javascriptDialogClosed with no frameNavigated before it); a navigation that starts before a dialog opens
    // commits after its close. The main frame: its id from Page.frameNavigated, else the open dialog's frame. The
    // navigation ends at its Page.frameNavigated or Page.frameStoppedLoading.
    if (!child && method === "Page.frameStartedNavigating" && !SAME_DOCUMENT.has(params?.navigationType)
      && params?.frameId !== undefined && params.frameId === (st.mainFrame ?? st.dialog?.frameId)) st.navStart = this.clock.now();
    if (!child && method === "Page.frameStoppedLoading" && params?.frameId !== undefined && params.frameId === st.mainFrame) st.navStart = null;
    // The signals that end a dialog's wait (C11, dialogs): its close, Chrome's answer to the client's
    // Page.handleJavaScriptDialog (the model sends it as a Closed event), the client's Page.disable (then the stage's own
    // read, below), a navigation of the tab's main frame, a crash; and the tab's detach or removal (drop).
    const mainNav = method === "Page.frameNavigated" && !child && !params?.frame?.parentId;
    if (mainNav) { if (typeof params?.frame?.id === "string") st.mainFrame = params.frame.id; st.navStart = null; }
    // A close that a navigation of the main frame made, or that it follows (point 1 of board ab-t30.17), in either order of
    // Chrome's events: the close while that navigation is under way (it started at most STAGE_ACTION_MAX_MS before), and
    // the accepted close of a beforeunload dialog (it starts the navigation: the daemon lead's point).
    const a = st.action;
    const navClose = method === "Page.javascriptDialogClosed" && !!st.dialog
      && ((st.dialog.beforeunload && params?.result === true) || (st.navStart !== null && this.clock.now() - st.navStart <= STAGE_ACTION_MAX_MS));
    // A navigation of the main frame while an ended plan of a dialog waits for the close, or after the close while its held
    // calls wait for the lock: no held move, press or key press reaches the new document. Each held call gets the error that
    // the context is gone; only the releases of what the plan holds go.
    if ((navClose || (mainNav && (st.dialog || a?.ended === "dialog"))) && a?.over && !st.gone && !st.heldGone) {
      st.heldGone = CONTEXT_GONE;
      for (const x of st.pending) if (x.ended) x.failedWith = CONTEXT_GONE;
      this.count("navigationDrops");
    }
    if (method === "Page.javascriptDialogClosed" || method === "Inspector.targetCrashed" || mainNav) { st.dialog?.close(); st.dialog = null; }
    // The client's Page.disable (point 2 of board ab-t30.17; the model gives it after Chrome's answer): no Closed event can
    // come, and the dialog can still be open (Chrome's dialog manager keeps it: measured). The wait for the close ends at
    // the answer of the stage's own read of the page, which Chrome gives only after the close, at its error, or at
    // STAGE_ACTION_MAX_MS (then the held events go, and Chrome drops those that it gets while the dialog is open).
    if (method === "Page.disable" && st.dialog && !st.dialog.reading) {
      const d = st.dialog;
      d.reading = true;
      let cancel = () => {};
      const end = (limit: boolean) => {
        cancel();
        if (st.dialog !== d) return;
        if (limit) { this.count("disableLimits"); this.o.log(`relay: the input stage: tab ${page.id}: no close of the dialog in ${STAGE_ACTION_MAX_MS} ms after the client's Page.disable; the held events go`); }
        d.close(); st.dialog = null;
      };
      cancel = this.clock.timer(STAGE_ACTION_MAX_MS, () => end(true));
      page.ownRead(DIALOG_READ, []).then(() => end(false), () => end(false));
    }
    // The residual belongs to a page (review-122 note 12); a navigation stops the notches (note 6).
    if (mainNav) { st.quads.clear(); st.handles.clear(); if (st.typing) st.typing.navigated = true; st.navs++; st.wheel = null; }
    // The old document is gone: a V of it that got an error closes the paste path no longer (review-126b note 2; the measure: C11, rule 6).
    // The old document is gone: a paste's read after V's answer that has no answer yet closes the path no longer (board ab-t30.21).
    if (mainNav) { this.failedV.delete(page.id); const vs = this.pendingV.get(page.id); if (vs) for (const w of vs) if (w.reading) { w.cancel(); vs.delete(w); } }
    if (method === "Page.javascriptDialogClosed" || method === "Page.disable" || method === "Inspector.targetCrashed" || mainNav) return;
    if (method === "Target.attachedToTarget" && params?.targetInfo?.type === "iframe" && typeof params.sessionId === "string")
      st.frames.set(params.sessionId, { frameId: String(params.targetInfo.targetId), parent: child });
    if (method === "Target.detachedFromTarget" && typeof params?.sessionId === "string") st.frames.delete(params.sessionId);
  }

  /**
   * The model dropped the tab (C11, dialogs: the end of the wait for a close): its plan ends, the wait for a close ends,
   * and the lock that the tab holds is free at once (also the lock that its ended events took again). The tab's calls
   * that have not gone run on its old state: at the tab's end each goes to Chrome as the client sent it, with no lock, and
   * gets Chrome's answer or error; at a session's end none goes and nothing goes back, and only the release of each
   * button and key that the plan holds goes, now (before the model's detach), so nothing stays down.
   */
  drop(id: number, why: DropWhy = "tab", o: { ended?: boolean } = {}): void {
    // The tab's close (`ended`: its page ended): its V that has no answer, its read and its closed path no longer close
    // the paste path (review-126 B4 and review-126b note 2), also when the stage keeps no state of the tab (an earlier
    // end of the client's session). A tab's end where the page can still run (no `ended`: Chrome's detach, an orphan, a
    // replaced tab) keeps the path closed for V_READ_MAX_MS while the tab held it (review-131 B1); a close ends that
    // bound too. At a session's end the page stays, and its V closes the path until Chrome or the bridge answers it.
    if (why === "tab") {
      const vs = this.pendingV.get(id), held = !!vs?.size || this.failedV.has(id);
      for (const w of vs ?? []) w.cancel();
      this.pendingV.delete(id); this.failedV.delete(id);
      if (o.ended) { this.droppedV.get(id)?.(); this.droppedV.delete(id); }
      else if (held) {
        this.droppedV.get(id)?.();
        const cancel: () => void = this.clock.timer(V_READ_MAX_MS, () => { if (this.droppedV.get(id) === cancel) this.droppedV.delete(id); });
        this.droppedV.set(id, cancel);
        this.count("vDropHolds");
        this.o.log(`relay: the input stage: tab ${id}: a drop that is no close (Chrome's detach, an orphan or a replaced tab; a close may follow) while its paste's V, its read or its closed path was in the set; the paste path stays closed for ${V_READ_MAX_MS} ms, or until a close of the tab`);
      }
    }
    const st = this.tabs.get(id);
    this.tabs.delete(id);
    if (!st) { this.players.delete(id); return; }
    st.gone = why;
    this.count(why === "session" ? "sessionDrops" : "tabDrops");
    this.stopKeyTimer(st); st.kq = [];
    // A collected part of a dropped tab goes nowhere (its calls have their answers); a paste's text leaves the clipboard.
    if (st.col) { this.count("collectedDropped"); st.col = null; }
    this.unpaste(st);
    st.dialog?.close();
    st.dialog = null;
    const a = st.action;
    if (a && !a.over) { a.ended = "drop"; a.fire(); }
    this.dropRest(st); st.spread = null;
    const releases = why === "session" || (!st.running && !st.pending.length);
    if (releases && st.page) this.releaseHeld(st.page, st);
    this.players.delete(id);
    this.freeTail(st);
    this.close(st, id);
  }

  /**
   * Before a close of the tab (Target.closeTarget) and at the end of its client's last session on it (C11, the collected
   * keys; review-126 B3): the client has the answers of a collected part, so its text must be in the page as with
   * Playwright's own input. A part whose plan runs ends as at STAGE_ACTION_MAX_MS (the rest goes at once) and keeps the
   * lock until its rest has gone; a part whose step waits for the lock goes on at once with no lock, so it goes as the
   * flush; a collected part that has not gone goes as one Input.insertText of its text, in the tab's gate, after the
   * tab's calls before it, with no lock (review-126b R1). The promise ends when the part has gone (the model waits for it
   * at most STAGE_FLUSH_MS); null: no part.
   */
  flush(page: StagePage): Promise<void> | null {
    const st = this.tabs.get(page.id);
    if (!st || st.gone || (!st.col && !st.parting)) return null;
    this.count("partFlushes");
    st.flushing = true;
    // A running part (it has the lock) ends as at the limit and keeps the lock until its rest has gone, so no other tab's
    // action takes the window's focus before the rest's focus check (review-126b R1).
    if (st.parting && st.action && !st.action.over) { st.flushKept = st.action; this.end(page, st, "limit"); }
    // A part's step that waits for the lock goes on at once with no lock: the part goes as this flush (review-126b R1).
    st.flushWake?.();
    return new Promise<void>((resolve) => {
      page.inGate(async () => {
        try { await this.flushStep(page, st); } finally { st.flushing = false; st.flushKept = null; resolve(); }
      });
    });
  }

  /**
   * The flush's step in the tab's gate: a collected part that has not gone goes as one Input.insertText. It takes no lock
   * and makes no activation (review-126b R1): the call uses no clipboard and no pointer, and it waits for no other tab.
   */
  private async flushStep(page: StagePage, st: TabState): Promise<void> {
    if (st.gone || st.running || !st.col) return;
    st.running = true;
    this.stopKeyTimer(st);
    const c = st.col;
    st.col = null;
    try {
      const text = c.items.map((it) => ("text" in it ? it.text : it.ch)).join("");
      let failed: unknown = null;
      const pr = this.sendEvent(page, st, undefined, "Input.insertText", { text }).then(() => {}, (err) => { failed = err ?? new Error("no answer"); });
      await this.within(pr, STAGE_EVENT_WAIT_MS);
      if (failed !== null) { this.o.log(`relay: the input stage: tab ${page.id}: the flush of a collected part failed: ${(failed as Error)?.message ?? failed}`); this.count("partFlushErrors"); return; }
      this.count("partsFlushed");
    } finally { st.running = false; await this.afterStep(page, st); }
  }

  /**
   * The lock for a step of a collected part, or null at a flush (review-126b R1): the flush waits for no other tab's
   * lock. A wait that the flush ends gives the lock back at once when it comes. Other steps wait for the lock as before.
   */
  private async partLock(st: TabState): Promise<(() => void) | null> {
    if (!st.parting) return this.lock.acquire();
    if (st.flushing) return null;
    const got = this.lock.acquire();
    let wake!: () => void;
    const woke = new Promise<null>((r) => { wake = () => r(null); });
    st.flushWake = wake;
    const r = await Promise.race([got, woke]);
    if (st.flushWake === wake) st.flushWake = null;
    if (r === null) { this.count("partLockFlushed"); void got.then((release) => release()); }
    return r;
  }

  /** At a flush, a part's step with no lock of its own (review-126b R1): it has no focus check (no activation, so the window's focus is not known). */
  private flushNoLock(st: TabState): boolean {
    return st.flushing && st.parting && !st.tail && !(st.flushKept && st.action === st.flushKept);
  }

  /** A call of a dropped tab: at a session's end nothing goes and nothing goes back; at the tab's end it goes to Chrome as the client sent it, with no lock. */
  private async goneStep(page: StagePage, st: TabState, e: Entry): Promise<void> {
    if (st.gone === "session") return;
    if (e.failedWith) { e.answer({ error: e.failedWith }); return; }
    // The client's mark of a gone tab never reaches Chrome: no text of the tab is left to mark.
    if (e.kind === "mark") { e.answer({ result: {} }); return; }
    // The client's own release goes: the stage's release after the last call is only for what the client did not release.
    if (e.kind === "mouse" && e.params.type === "mouseReleased") st.buttons.delete(e.params.button);
    if (e.kind === "key" && e.params.type === "keyUp") st.keys.delete(e.params.code);
    await page.pass(e.child, e.method, e.params, e.answer);
  }

  // ---------------------------------------------------------------- the action, the lock and the end of a plan

  /** The action of the tab: the lock (in the order of arrival), then the activation before its first event. */
  private async begin(page: StagePage, st: TabState): Promise<Action> {
    if (st.action && !st.action.over) return st.action;
    const release = await this.partLock(st);
    // The model dropped the tab while its step waited for the lock: an ended plan, with the lock free.
    if (st.gone) { release?.(); const a = new Action(() => {}, 0, this.clock.now()); a.ended = "drop"; return a; }
    // A flush of a part whose step waits for the lock, or comes before it (review-126b R1): an ended plan with no lock and
    // no activation, so the part goes as the flush (one Input.insertText) and never types or pastes later.
    if (!release) { const a = new Action(() => {}, 0, this.clock.now()); a.ended = "limit"; a.endedAt = this.clock.now(); return a; }
    const dev = page.person.params.device;
    const a = new Action(release, uniform(this.o.random, dev.latencyMs[0], dev.latencyMs[1]), this.clock.now());
    st.action = a;
    a.limit = this.clock.timer(STAGE_ACTION_MAX_MS, () => {
      if (st.action !== a || a.over) return;
      this.o.log(`relay: the input stage: an action of tab ${page.id} held the input lock ${STAGE_ACTION_MAX_MS} ms; the rest goes at once`);
      this.end(page, st, "limit");
    });
    try { await page.activate(); } catch (err) { this.o.log(`relay: the input stage: the activation of tab ${page.id} failed: ${(err as Error).message}`); }
    return a;
  }

  /** At the end of a step: a live action with nothing held and no input waiting frees the lock; an ended one, once its client calls have gone. */
  private async afterStep(page: StagePage, st: TabState): Promise<void> {
    // A dropped tab: after its last call, at the tab's end, the release of each button and key that its plan holds.
    if (st.gone) {
      if (!st.running && !st.pending.length) { if (st.gone === "tab" && st.page) this.releaseHeld(st.page, st); this.freeTail(st); }
      return;
    }
    const a = st.action;
    // No action (the plan failed): an ended event's lock goes with its last ended call. A collected part waits for its end.
    if (!a) { if (!st.pending.some((x) => x.ended || x.failedWith)) this.freeTail(st); if (st.col && !st.running) this.kick(page, st); return; }
    if (a.over) { if (!st.pending.some((x) => x.ended || x.failedWith)) await this.finish(page, st, a); if (st.col && !st.running) this.kick(page, st); return; }
    // A key run stays open (C11, the input lock): its planned events, the stream's Shift, then 1 s after its last key.
    if (st.runOpen) { this.kick(page, st); return; }
    if (!st.buttons.size && !st.keys.size && !st.rest && !st.pending.some((x) => x.kind !== "setup")) {
      // A move run (N9; C11, the input lock): after a move, the action and its lock stay for the tab's next call, so no
      // other tab's action comes between two steps of mouse.move with steps. It ends at the tab's next call that the stage
      // does not take (other), RUN_IDLE_MS after the move, or at the action's limit STAGE_ACTION_MAX_MS.
      if (st.lastMove) {
        st.lastMove = false;
        st.moveTimer = this.clock.timer(RUN_IDLE_MS, () => { st.moveTimer = null; if (!st.running && st.action === a && !a.over) void this.afterStep(page, st); });
        return;
      }
      this.close(st, page.id);
    }
  }
  private stopMoveRun(st: TabState): void { st.moveTimer?.(); st.moveTimer = null; st.lastMove = false; }

  /** The hover's rest is kept for Playwright's move: with none in HOVER_WAIT_MS, it goes, and an action with nothing else frees the lock. */
  private keepRest(page: StagePage, st: TabState): void {
    st.restTimer?.();
    st.restTimer = this.clock.timer(HOVER_WAIT_MS, () => {
      st.restTimer = null;
      if (!st.rest) return;
      st.rest = null;
      this.count("hoverRestsDropped");
      if (!st.running) void this.afterStep(page, st);
    });
  }
  private dropRest(st: TabState): void { st.rest = null; st.restTimer?.(); st.restTimer = null; }

  private close(st: TabState, id?: number): void {
    const a = st.action;
    if (!a) return;
    st.action = null;
    st.heldGone = null;
    st.endedDowns = [];
    this.stopMoveRun(st);
    st.plain = false; // the end of the stage's action ends a plain attempt (the recoveries' limit)
    // The action's end ends its key run; after STAGE_ACTION_MAX_MS the plain run goes on until its own end.
    this.stopKeyTimer(st); st.kq = [];
    if (!st.runPlain && !st.col) { st.runOpen = false; st.runSpent = 0; }
    if (this.o.trace && id !== undefined) this.o.log(`relay: the input stage: tab ${id}: an action of ${a.events} events in ${Math.round(this.clock.now() - a.started)} ms${a.ended ? ` (ended: ${a.ended})` : a.failed ? " (failed)" : ""}`);
    this.dropRest(st);
    a.watchdog?.(); a.limit?.();
    a.release();
  }

  /**
   * The end of a plan (C11, dialogs): at a dialog, at STAGE_EVENT_WAIT_MS and at STAGE_ACTION_MAX_MS. The plan's own events
   * that no client call asked for are dropped (the rest of the path, the pauses); each client call that arrived goes at
   * once, in order, as the client sent it; then the release of each button and key that the plan holds, and the lock is free.
   */
  private end(page: StagePage, st: TabState, why: EndWhy): void {
    const a = st.action;
    if (!a || a.over) return;
    a.ended = why;
    a.endedAt = this.clock.now();
    a.fire();
    // Every end of a paste's plan gives the clipboard up at once (C11, the paste).
    this.unpaste(st);
    this.count(why === "dialog" ? "dialogEnds" : why === "wait" ? "waitEnds" : "limitEnds");
    if (why !== "limit") this.o.log(`relay: the input stage: a plan of tab ${page.id} ended (${why === "dialog" ? "a dialog" : `no answer in ${STAGE_EVENT_WAIT_MS} ms`})`);
    // The tab's later calls are calls of the plan, except during a collected part's plan: they are not the part's.
    if (!st.parting) for (const x of st.pending) if (x.kind !== "setup" && x.kind !== "field" && x.kind !== "scroll") x.ended = true;
    this.dropRest(st);
    // The key run: at a dialog and at STAGE_EVENT_WAIT_MS its planned events are dropped (the end's releases cover the keys
    // that the plan holds); at STAGE_ACTION_MAX_MS its planned releases go at the end, and the rest of the run goes as the
    // client sends it. The stream starts again (it learns the keys that are down).
    this.stopKeyTimer(st);
    if (why === "limit") { if (st.runOpen) st.runPlain = true; } else st.kq = [];
    st.ks = null;
    // Every end of a plan frees the lock at once. The plan's client events that go later (at a dialog: after its close)
    // take the lock again, in the order of arrival, with the activation before an ended press or key press. A running
    // part that the flush ended keeps the lock until its rest has gone (review-126b R1): its close frees it.
    if (st.flushKept !== a) a.release();
    // With no client call left, the end's own step (the releases) goes in the tab's gate: later calls wait for it.
    if (!st.running && !st.pending.some((x) => x.ended)) page.inGate(() => this.finish(page, st, a));
    // A collected part keeps its limit (review-126 note 6): its gap goes again, so it ends RUN_IDLE_MS after its last call.
    if (st.col && !st.running) this.kick(page, st);
  }

  /**
   * After an ended plan's client calls: the releases of what it holds (at a dialog or STAGE_EVENT_WAIT_MS; at the limit the
   * client still holds its button, and its own release goes later), under the lock that the ended events took again, after
   * the dialog's close; then the lock is free, and the tab's gate opens when this step ends.
   */
  private async finish(page: StagePage, st: TabState, a: Action): Promise<void> {
    if (st.action !== a) { this.freeTail(st); return; }
    if (a.ended === "limit" && !a.failed && (st.kq.length || [...st.keys.values()].some((k) => k.own))) {
      // At STAGE_ACTION_MAX_MS: the planned releases (an early-answered one, the stream's Shift) at once, and the release of
      // each key of the stage's own that is down; the client's own keys stay down until its own keyUp.
      await this.retake(page, st, false);
      for (const it of st.kq.splice(0)) if (it.ev.type === "keyUp" && st.keys.has(it.ev.code)) this.sendKey(page, st, { ...it, e: null });
      for (const [code, k] of [...st.keys]) if (k.own) this.sendKey(page, st, { ev: { t: 0, type: "keyUp", key: k.params.key, code, keyCode: k.params.windowsVirtualKeyCode, location: k.params.location ?? 0, modifiers: 0, own: true }, typed: {} });
    } else if (a.ended !== "limit" && !a.failed && (st.buttons.size || st.keys.size)) {
      await this.downsAnswered(st);
      await this.dialogGone(st);
      await this.retake(page, st, false);
      this.releaseHeld(page, st);
    }
    this.freeTail(st);
    this.close(st, page.id);
    // A collected part keeps its limit (review-126 note 6): the close stopped its gap, which goes again.
    if (st.col && !st.running) this.kick(page, st);
  }

  /** The lock again for an ended plan's events (the order of arrival), and the activation before its first press or key press. */
  private async retake(page: StagePage, st: TabState, activate: boolean): Promise<void> {
    // A dropped tab: its remaining ended calls go as endedSend sends them (none at a session's end).
    if (st.gone) return;
    if (!st.tail) {
      // At a flush a part's events take no lock again and make no activation (review-126b R1): a running part's action
      // that the flush ended keeps its lock; with no lock, they wait for no other tab (also a wait that the flush ends).
      const release = await this.partLock(st);
      if (!release) return;
      if (st.gone) { release(); return; }
      st.tail = release;
      // The taken lock has the limit STAGE_ACTION_MAX_MS (C11, the input lock): then it is free, and the next ended call
      // takes it again in the order of arrival, with the same limit, so no input event goes with no lock while another
      // tab's paste could have its text on the selection (review-126b note 3).
      st.tailLimit = this.clock.timer(STAGE_ACTION_MAX_MS, () => {
        st.tailLimit = null;
        this.o.log(`relay: the input stage: the ended events of tab ${page.id} held the input lock ${STAGE_ACTION_MAX_MS} ms; the rest takes it again in the order of arrival`);
        this.count("tailLimits");
        const t = st.tail; st.tail = null; st.tailActive = false; t?.();
      });
    }
    if (activate && !st.tailActive) {
      st.tailActive = true;
      try { await page.activate(); } catch (err) { this.o.log(`relay: the input stage: the activation of tab ${page.id} failed: ${(err as Error).message}`); }
    }
  }
  private freeTail(st: TabState): void { const t = st.tail; st.tail = null; st.tailActive = false; st.tailLimit?.(); st.tailLimit = null; t?.(); }

  /**
   * A client's event of an ended plan: after the dialog's close (when the stage knows of a dialog), with the lock taken
   * again and the activation before a press or a key press; its timestamp from the send. The send's answer comes later.
   * `child`: a frame's own session (review-126b R2), whose call goes as the client sent it.
   */
  private async endedSend(page: StagePage, st: TabState, e: Entry, params: Record<string, unknown>, child?: string): Promise<{ sent: Promise<any> } | null> {
    // null: no event (a session's end: nothing goes back; a navigation: the call has its error).
    const held = (): { sent: Promise<any> } | null | undefined => {
      if (st.gone === "session") return null;
      if (st.heldGone) { e.answer({ error: st.heldGone }); return null; }
      if (st.gone) return { sent: page.send(child, e.method, params) };
      return undefined;
    };
    await this.dialogGone(st);
    let h = held();
    if (h !== undefined) return h;
    await this.retake(page, st, startsAction(e.method, params));
    h = held();
    if (h !== undefined) return h;
    if (e.kind !== "text" && child === undefined) params.timestamp = this.stamp(page, st);
    return { sent: this.sendEvent(page, st, child, e.method, params) };
  }

  /**
   * Chrome drops an input event that it gets while a dialog is open (measured: board ab-t30.9, open point 5), and keeps
   * the events that it got before. So an ended plan's client events wait for the dialog's close.
   */
  private async dialogGone(st: TabState): Promise<void> { if (st.dialog) await st.dialog.closed; }

  /**
   * Note D (PR #116): an ended press or key press that went can open a second dialog, and Chrome answers it only after
   * that dialog's close. The end's releases wait for those answers, at most STAGE_EVENT_WAIT_MS; then the wait for a close
   * (dialogGone) covers a dialog that is still open. So Chrome never drops the stage's release while that dialog is open.
   */
  private async downsAnswered(st: TabState): Promise<void> {
    const downs = st.endedDowns.splice(0);
    if (downs.length) await this.within(Promise.all(downs.map((p) => p.catch(() => {}))), STAGE_EVENT_WAIT_MS);
  }

  /** The release of each button and key that the stage's events hold, at once, with no wait for the answers. */
  private releaseHeld(page: StagePage, st: TabState): void {
    const at = st.last ?? { x: 0, y: 0 };
    for (const [b, clickCount] of [...st.buttons]) {
      void this.sendEvent(page, st, undefined, "Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: b, buttons: 0, clickCount, timestamp: this.stamp(page, st) }).catch(() => {});
      st.released.add(b);
    }
    st.buttons.clear();
    for (const [code, k] of [...st.keys]) {
      const p = k.params;
      void this.sendEvent(page, st, undefined, "Input.dispatchKeyEvent", { type: "keyUp", key: p.key, code: p.code, windowsVirtualKeyCode: p.windowsVirtualKeyCode, location: p.location ?? 0, modifiers: 0, timestamp: this.stamp(page, st) }).catch(() => {});
      st.released.add(`key:${code}`);
      // A client's modifier that merged into the stage's own of the other side: the client's later release has its own code (review-119b R2).
      if (k.merged) st.released.add(`mod:${p.key}`);
    }
    st.keys.clear();
    st.press = null;
    st.kq = []; st.ks = null;
  }

  /**
   * An error of an event (C11, the answers): the plan stops; first the release of each button and key that it holds;
   * the client call of the refused event gets Chrome's error, and each other client call of the plan whose events did not
   * go gets the same error.
   */
  private fail(page: StagePage, st: TabState, e: Entry, err: unknown): void {
    // A plan that an error of an event stopped already (a key event that no call waited for): its error, once.
    const body = st.action?.failed && st.action.failBody ? st.action.failBody : this.stopPlan(page, st, e.method, err);
    e.answer({ error: body });
    this.freeTail(st);
    this.close(st, page.id);
  }

  /**
   * The plan stops at a refused event: no more of its events, the release of each button and key that it holds first,
   * and each client call of the plan whose events did not go gets the same error. A sample that the stage sends before a
   * hit-target setup (the hover's samples outside the target, a recovery's move out) belongs to no client call that has
   * come: the plan stops in the same way, and the setup goes as the client sent it.
   */
  private stopPlan(page: StagePage, st: TabState, method: string, err: unknown): { code: number; message: string } {
    const body = page.error(method, err);
    const a = st.action;
    if (a) { a.failed = true; a.fire(); }
    this.unpaste(st);
    this.count("eventErrors");
    this.stopKeyTimer(st);
    if (!st.parting) for (const x of st.pending) if (x.kind !== "setup" && x.kind !== "field" && x.kind !== "scroll") x.failedWith = body;
    this.dropRest(st); st.spread = null;
    this.releaseHeld(page, st);
    return body;
  }

  // ---------------------------------------------------------------- sending

  /** A timestamp of the action's latency before the send (whole ms on Linux). */
  private stamp(page: StagePage, st: TabState): number {
    return this.player(page, st).timestamp(st.action?.latency ?? STAGE_LATENCY_MS[0]);
  }

  /**
   * The route of the read after a client's paste key (review-131b N3; C11, the paste, rule 6): a focus read at the key's
   * time, before the key goes, as at the stage's own V (the field's node on a cross-origin frame's own session when the
   * focus is there, also for a key on the top session); when that read gives no field, the key's own session (keyVia).
   * Undefined for a key that does not paste, or with no clipboard. Its cost: one focus read for each client paste key.
   */
  private async pasteRoute(page: StagePage, st: TabState, p: Record<string, unknown>, child: string | undefined): Promise<VRoute | undefined> {
    if (!this.clipboard || !pasteKey(p)) return undefined;
    this.count("pasteKeyReads");
    const f = await this.focused(page, st);
    return { via: f ? f.via : this.keyVia(st, child) };
  }
  /** The read's route by the key's own session: a node of a frame's session that the client's calls named, else the top page. */
  private keyVia(st: TabState, child: string | undefined): FocusVia {
    const node = child ? st.childNodes.get(child) : undefined;
    return child && node ? { child, node } : null;
  }

  /**
   * One event of the stage to Chrome: its bookkeeping (the last point, the move's time, the unanswered events of the plan
   * for STAGE_EVENT_WAIT_MS).
   */
  private sendEvent(page: StagePage, st: TabState, child: string | undefined, method: string, params: Record<string, unknown>, route?: VRoute | "own"): Promise<any> {
    const p = page.send(child, method, params);
    // The client's own paste key is a V too (review-131 note 1, review-131b N1; C11, the paste, rule 6): it joins the
    // closed set as the stage's V does. Its read goes where the focus read before the key found the field (`route`,
    // review-131b N3), else on a node of the key's frame session that the client's calls named, else on the top page.
    // Only with a clipboard: with none the stage never pastes.
    if (route !== "own" && this.clipboard && method === "Input.dispatchKeyEvent" && (route !== undefined || pasteKey(params))) {
      this.trackV(page, p, route ? route.via : this.keyVia(st, child));
    }
    if (method === "Input.dispatchMouseEvent" && typeof params.x === "number" && typeof params.y === "number" && !child) {
      st.last = { x: params.x, y: params.y as number };
      st.lastWasMove = params.type === "mouseMoved";
      if (st.lastWasMove) st.lastMoveAt = this.clock.now();
    }
    const a = st.action;
    if (a) a.events++;
    if (a && !a.over) {
      const rec = { t: this.clock.now() };
      a.unanswered.add(rec);
      const done = () => { a.unanswered.delete(rec); };
      p.then(done, done);
      this.arm(page, st, a);
    }
    return p;
  }

  /** STAGE_EVENT_WAIT_MS, counted from the oldest event of the plan that has no answer: at the limit the plan ends as at a dialog. */
  private arm(page: StagePage, st: TabState, a: Action): void {
    if (a.watchdog || a.over || !a.unanswered.size) return;
    const oldest = Math.min(...[...a.unanswered].map((r) => r.t));
    a.watchdog = this.clock.timer(oldest + STAGE_EVENT_WAIT_MS - this.clock.now(), () => {
      a.watchdog = null;
      if (st.action !== a || a.over || !a.unanswered.size) return;
      const o = Math.min(...[...a.unanswered].map((r) => r.t));
      // A margin for the clock's float sums (a timer of 1e-13 ms would fire again and again at the same time).
      if (this.clock.now() - o >= STAGE_EVENT_WAIT_MS - 1e-6) this.end(page, st, "wait");
      else this.arm(page, st, a);
    });
  }

  /** A promise's end within `ms` on the stage's clock: true when it settled first (its answer or its error), false at the bound. */
  private async within(p: Promise<unknown>, ms: number): Promise<boolean> {
    let cancel = () => {};
    const r = await Promise.race([p.then(() => true, () => true), new Promise<boolean>((res) => { cancel = this.clock.timer(ms, () => res(false)); })]);
    cancel();
    return r;
  }

  /** Wait until `t` on the stage's clock, or until the plan ends. */
  private async until(a: Action, t: number): Promise<void> {
    const ms = t - this.clock.now();
    if (ms <= 0 || a.over) return;
    let cancel = () => {};
    await Promise.race([new Promise<void>((r) => { cancel = this.clock.timer(ms, r); }), a.endSignal]);
    cancel();
  }

  /** Chrome's answer of an event, or the end of the plan first (then the answer still comes to the client when Chrome gives it). */
  private async settle(a: Action, p: Promise<any>): Promise<{ ok: true; value: any } | { ok: false; error: unknown } | { ended: true }> {
    const r = await Promise.race([p.then((value) => ({ ok: true as const, value }), (error) => ({ ok: false as const, error })), a.endSignal.then(() => ({ ended: true as const }))]);
    return r;
  }

  /** The client's answer: Chrome's own answer of its event, when it comes. */
  private answerWith(page: StagePage, e: Entry, p: Promise<any>): void {
    p.then((r) => e.answer({ result: r ?? {} }), (err) => e.answer({ error: page.error(e.method, err) }));
  }

  /** A read of the stage, at most GEOMETRY_WAIT_MS (C11; or `ms`, less): its value, or TIMEOUT (a failed read too; then the stage fails open). */
  private async read<T>(p: Promise<T>, ms = GEOMETRY_WAIT_MS): Promise<T | typeof TIMEOUT> {
    let cancel = () => {};
    const r = await Promise.race([p.catch(() => TIMEOUT), new Promise<typeof TIMEOUT>((res) => { cancel = this.clock.timer(Math.min(ms, GEOMETRY_WAIT_MS), () => res(TIMEOUT)); })]);
    cancel();
    if (r === TIMEOUT) this.count("readFails");
    return r;
  }

  // ---------------------------------------------------------------- the paths

  /** Where the path starts: an X record of the activation (the catch-up's merge), else the stage's last point, else the model's. */
  private from(page: StagePage, st: TabState): Pt | null {
    const m = page.point();
    if (m && (m.x11 || !st.last)) return this.fit(m);
    return st.last;
  }

  /** A page with no last point: a random point of the viewport's middle (30% to 70%), from the stage's read of the viewport. */
  private async startOf(page: StagePage): Promise<Pt | null> {
    // C11: the X pointer's place mapped into the page (Linux, at an activation): the page got a real event there.
    const x = page.xPoint ? await this.read(page.xPoint()) : null;
    if (x && x !== TIMEOUT) { this.count("startsAtXPointer"); return this.fit(x); }
    const lm = await this.read(page.send(undefined, "Page.getLayoutMetrics", {}));
    const v = lm === TIMEOUT ? null : (lm as any)?.cssLayoutViewport;
    if (!v || !(v.clientWidth > 0) || !(v.clientHeight > 0)) return null;
    return this.fit(startPoint(v.clientWidth, v.clientHeight, this.o.random, page.person.params.path.start.middle));
  }

  /** The samples of a move from `from` to `to`: a short move (the client's line) up to `short.maxPx`, else a path (around a kept box). */
  private plan(page: StagePage, st: TabState, from: Pt, to: Pt, width: number): Sample[] {
    const P = page.person;
    if (Math.hypot(to.x - from.x, to.y - from.y) <= P.params.path.short.maxPx) return planLine(from, to, P, this.o.random).samples;
    const r = st.avoid;
    st.avoid = null;
    if (r) {
      const R = { x0: r.x0 - AROUND_MARGIN_PX, y0: r.y0 - AROUND_MARGIN_PX, x1: r.x1 + AROUND_MARGIN_PX, y1: r.y1 + AROUND_MARGIN_PX };
      const inner = { x0: R.x0 + 1, y0: R.y0 + 1, x1: R.x1 - 1, y1: R.y1 - 1 };
      if (crosses(from, to, inner)) {
        const len = (c: Pt) => Math.hypot(c.x - from.x, c.y - from.y) + Math.hypot(to.x - c.x, to.y - c.y);
        const corner = [{ x: R.x0, y: R.y0 }, { x: R.x1, y: R.y0 }, { x: R.x0, y: R.y1 }, { x: R.x1, y: R.y1 }]
          .filter((c) => !crosses(from, c, inner) && !crosses(c, to, inner)).sort((a, b) => len(a) - len(b))[0];
        if (corner) {
          this.count("pathsAround");
          const c = this.fit(corner), one = this.pathAvoiding(P, from, c, DEFAULT_WIDTH, r), two = this.pathAvoiding(P, c, to, width, r);
          const t0 = one.length ? one[one.length - 1].t : 0;
          return [...one, ...two.map((s) => ({ ...s, t: s.t + t0 }))];
        }
      }
    }
    return planPath(from, to, width, P, this.o.random).samples;
  }

  /** A path that does not enter the box `r` (a few draws of the generator; else the last draw). */
  private pathAvoiding(P: Person, from: Pt, to: Pt, width: number, r: Rect): Sample[] {
    let s: Sample[] = [];
    for (let i = 0; i < 8; i++) {
      s = Math.hypot(to.x - from.x, to.y - from.y) <= P.params.path.short.maxPx ? planLine(from, to, P, this.o.random).samples : planPath(from, to, width, P, this.o.random).samples;
      if (!s.some((q) => inside(q, r))) return s;
    }
    return s;
  }

  /**
   * Play the samples (at the device's rate, each move with no wait for the answer of the one before, at most
   * STAGE_MOVES_IN_FLIGHT of the tab without an answer). The first sample goes one sample time after the start, as a hand
   * that starts to move. `stopped`: the bound, or the end of the plan; `error`: Chrome refused a move.
   */
  private async play(page: StagePage, st: TabState, a: Action, samples: Sample[], extra: Record<string, unknown>): Promise<{ stopped: boolean; error?: unknown }> {
    if (!samples.length) return { stopped: false };
    const rate = page.person.params.device.rateMs, shift = samples[0].t - rate;
    const s = shift > 0 ? samples.map((q) => ({ ...q, t: q.t - shift })) : samples;
    try {
      const r = await this.player(page, st).moves(s, extra, { latency: a.latency, inFlight: st.flight, stop: () => a.over, until: a.endSignal });
      if (r.stopped && !r.ended) {
        this.count("inFlightStops");
        this.o.log(`relay: the input stage: a path of tab ${page.id} stopped at ${STAGE_MOVES_IN_FLIGHT} moves without an answer`);
      }
      return { stopped: r.stopped };
    } catch (error) { return { stopped: true, error }; }
  }

  /** The width of the target for Fitts's law: the smaller side of the setup's quad, else the default. */
  private widthOf(st: TabState): number {
    const q = st.setup?.node ? st.quads.get(st.setup.node) : undefined;
    return q ? Math.max(1, Math.min(q.w, q.h)) : DEFAULT_WIDTH;
  }

  // ---------------------------------------------------------------- the steps

  /**
   * The key of a client's modifier release that is down (review-119b R2): a client's Shift that merged into the stage's
   * own Shift of the other side is that Shift, so its release goes with that key's code, as keyParams sends it on the
   * planned path, also after STAGE_ACTION_MAX_MS and at an ended plan.
   */
  private downKey(st: TabState, e: Entry): Record<string, unknown> {
    const p = e.params;
    if (e.kind !== "key" || p.type !== "keyUp" || st.keys.has(p.code) || !MODIFIER_KEYS.has(p.key)) return {};
    for (const [code, k] of st.keys) if (k.merged && k.params.key === p.key) return { key: k.params.key, code, windowsVirtualKeyCode: k.params.windowsVirtualKeyCode, location: k.params.location ?? 0 };
    return {};
  }

  /** An event of an ended plan: the client's own event at once (C11, dialogs), and Chrome's own answer when it comes. */
  private async endedEvent(page: StagePage, st: TabState, e: Entry): Promise<void> {
    const p = e.params, params: Record<string, unknown> = { ...p, ...this.downKey(st, e) };
    if (e.kind === "mouse") {
      const pr = p.type === "mouseReleased" && st.press?.button === p.button ? st.press : null;
      const pt = pr && same(pr.client, this.fit(p)) ? pr.point : this.fit(p);
      params.x = pt.x; params.y = pt.y;
    }
    const r = await this.endedSend(page, st, e, params);
    if (!r) return;
    const { sent } = r;
    if ((e.kind === "mouse" && p.type === "mousePressed") || (e.kind === "key" && (p.type === "keyDown" || p.type === "rawKeyDown"))) st.endedDowns.push(sent);
    if (e.kind === "mouse" && p.type === "mousePressed") st.buttons.set(p.button, p.clickCount ?? 1);
    if (e.kind === "mouse" && p.type === "mouseReleased") { st.buttons.delete(p.button); st.press = null; }
    if (e.kind === "key") { if (p.type === "keyUp") st.keys.delete(String(params.code)); else if (p.type !== "char") st.keys.set(p.code, { at: this.clock.now(), params: p }); }
    this.answerWith(page, e, sent);
  }

  /**
   * An input call on a frame's own session (review-126 note 3: an out-of-process frame's session, which Playwright does not
   * use for input): as the client sent it, in the tab's action under the input lock, so that no key of a frame goes
   * while another page's paste has its text on the clipboard; Chrome's answer within STAGE_EVENT_WAIT_MS (the action's
   * watchdog). A call of an ended plan, and one that waits for the lock when the model drops the tab, goes as an ended
   * plan's events go (review-126b R2): after the dialog's close, with the lock taken again (endedSend); at a session's end
   * nothing goes and nothing goes back. An error fails only that call, as with no stage (review-126b note 4).
   */
  private async childInputStep(page: StagePage, st: TabState, e: Entry): Promise<void> {
    this.count("childInputs");
    if (e.ended) return this.endedChild(page, st, e);
    const a = await this.begin(page, st);
    if (a.over) return this.endedChild(page, st, e);
    const route = await this.pasteRoute(page, st, e.params, e.child);
    if (a.over) return this.endedChild(page, st, e);
    const pr = this.sendEvent(page, st, e.child, e.method, { ...e.params }, route);
    const r = await this.settle(a, pr);
    if ("ended" in r) { this.answerWith(page, e, pr); return; }
    if (!r.ok) { e.answer({ error: page.error(e.method, r.error) }); return; }
    e.answer({ result: r.value ?? {} });
  }
  /** An ended or dropped input call on a frame's own session: as the client sent it, sent as endedSend sends one. */
  private async endedChild(page: StagePage, st: TabState, e: Entry): Promise<void> {
    const r = await this.endedSend(page, st, e, { ...e.params }, e.child);
    if (r) this.answerWith(page, e, r.sent);
  }

  /** A call that goes as the client sent it, with the stage's timestamp, in the lock (the cases of no change). */
  private async plainStep(page: StagePage, st: TabState, e: Entry): Promise<void> {
    const a = await this.begin(page, st);
    if (a.over) return this.endedEvent(page, st, e);
    const route = await this.pasteRoute(page, st, e.params, undefined);
    if (a.over) return this.endedEvent(page, st, e);
    const p = e.params, params: Record<string, unknown> = { ...p, ...this.downKey(st, e) };
    if (e.kind === "mouse" && typeof p.x === "number" && typeof p.y === "number") { const q = this.fit(p); params.x = q.x; params.y = q.y; }
    if (e.kind !== "text") params.timestamp = this.stamp(page, st);
    if (e.kind === "mouse" && p.type === "mousePressed") st.buttons.set(p.button, p.clickCount ?? 1);
    if (e.kind === "mouse" && p.type === "mouseReleased") st.buttons.delete(p.button);
    if (e.kind === "key") { if (p.type === "keyUp") st.keys.delete(String(params.code)); else if (p.type !== "char") st.keys.set(p.code, { at: this.clock.now(), params }); }
    if (e.kind === "key" || e.kind === "text") st.runOpen = true;
    const pr = this.sendEvent(page, st, undefined, e.method, params, route);
    const r = await this.settle(a, pr);
    if ("ended" in r) { this.answerWith(page, e, pr); return; }
    if (!r.ok) { if (e.kind === "mouse" && p.type === "mousePressed") st.buttons.delete(p.button); return this.fail(page, st, e, r.error); }
    e.answer({ result: r.value ?? {} });
  }

  /** mouseMoved with no button down: no event to the last point; the client's line for a short move; else a path (C11, the pointer). */
  private async moveStep(page: StagePage, st: TabState, e: Entry): Promise<void> {
    const p = e.params, to = this.fit(p);
    if (st.plain) { this.count("plainAfterRecoveries"); return this.plainStep(page, st, e); }
    // A move to the page's last point sends nothing: it takes no lock and runs no activation.
    if (!st.rest && same(this.from(page, st), to) && !st.action?.over) { st.setup = st.setup && { ...st.setup, used: true }; e.answer({ result: {} }); this.count("sameMoves"); return; }
    const a = await this.begin(page, st);
    if (a.over) return this.endedEvent(page, st, e);
    const extra = { modifiers: p.modifiers ?? 0 };
    let from = this.from(page, st);
    // The hover's last leg: the samples of its path from the first one inside the target, at Playwright's move.
    const rest = st.rest;
    this.dropRest(st);
    let samples: Sample[] | null = null;
    if (rest && near(rest.to, to, 1.5) && same(from, rest.from)) { samples = rest.samples; this.count("hoverLastLegs"); }
    if (!samples) {
      if (same(from, to)) { st.setup = st.setup && { ...st.setup, used: true }; e.answer({ result: {} }); this.count("sameMoves"); return; }
      from ??= await this.startOf(page);
      if (!from) { this.count("plainNoStart"); return this.plainStep(page, st, e); }
      const spread = await this.spreadFor(page, st, p, to);
      const target = spread ?? to;
      samples = this.plan(page, st, from, target, this.widthOf(st));
      if (!samples.length) { e.answer({ result: {} }); return; }
    }
    const r = await this.play(page, st, a, samples, extra);
    if (r.error !== undefined) return this.fail(page, st, e, r.error);
    if (r.stopped) {
      // The bound or the end of the plan: the client's own move (its point), with Chrome's own answer.
      st.spread = null;
      if (a.over) { const r = await this.endedSend(page, st, e, { ...p, x: to.x, y: to.y }); if (r) this.answerWith(page, e, r.sent); return; }
      const params = { ...p, x: to.x, y: to.y, timestamp: this.stamp(page, st) };
      const pr = this.sendEvent(page, st, undefined, e.method, params);
      const s = await this.settle(a, pr);
      if ("ended" in s) { this.answerWith(page, e, pr); return; }
      if (!s.ok) return this.fail(page, st, e, s.error);
      e.answer({ result: s.value ?? {} });
      return;
    }
    e.answer({ result: {} });
  }

  /**
   * The spread point (C11, the pointer): only for a locator click (a hit-target setup of the action mouse, with the press
   * of clickCount 1 already here and no press of clickCount 2 or 3 in the action), at the middle of the element's content
   * quad (the client's own DOM.getContentQuads), on an element whose effect does not depend on the point, and where the
   * stage's own hit test at the spread point gives the same element. Else null: the press is at the client's point.
   */
  private async spreadFor(page: StagePage, st: TabState, p: any, to: Pt): Promise<Pt | null> {
    st.spread = null;
    const setup = st.setup;
    if (!setup || setup.used || setup.action !== "mouse" || setup.trial || !setup.node || !setup.hit) return null;
    setup.used = true;
    const presses = st.pending.filter((x) => x.kind === "mouse" && x.params.type === "mousePressed");
    if (!presses.length || presses[0].params.clickCount !== 1 || presses.some((x) => (x.params.clickCount ?? 1) >= 2)) return null;
    if (Math.abs(setup.hit.x - p.x) > 0.5 || Math.abs(setup.hit.y - p.y) > 0.5) return null; // a frame's point (not the top page's), or not this click's
    const quad = st.quads.get(setup.node);
    if (!quad) return null;
    const kind = await this.read(page.ownRead(ELEMENT_KIND, [p.x, p.y]));
    const r = await pressPoint({
      point: { x: p.x, y: p.y }, locatorClick: true, clickCount: 1, multiClick: false, quad,
      element: kind === TIMEOUT ? null : (kind as ElementKind | null),
      sameElementAt: async (q) => (await this.read(page.ownRead(SAME_ELEMENT, [p.x, p.y, q.x, q.y]))) === true,
    }, page.person, this.o.random);
    if (!r.spread) return null;
    this.count("spreadPresses");
    st.spread = { client: to, point: this.fit(r.point) };
    return st.spread.point;
  }

  /**
   * mousePressed: a pause when the press follows a path (one gap of a double click after the release before it for
   * clickCount 2 or 3), then the press with the client's button, buttons, clickCount and modifiers and force 0.5, at the
   * client's point rounded or at the spread point. The hold counts from the press's send.
   */
  private async pressStep(page: StagePage, st: TabState, e: Entry): Promise<void> {
    const p = e.params, client = this.fit(p);
    this.dropRest(st);
    if (st.plain) { this.count("plainAfterRecoveries"); return this.plainStep(page, st, e); }
    const a = await this.begin(page, st);
    if (a.over) return this.endedEvent(page, st, e);
    const P = page.person;
    const point = st.spread && same(st.spread.client, client) ? st.spread.point : client;
    let from = this.from(page, st);
    if (!same(from, point)) {
      // A press away from the last point (a client that pressed with no move): a path there first.
      from ??= await this.startOf(page);
      if (from && !same(from, point)) {
        const r = await this.play(page, st, a, this.plan(page, st, from, point, DEFAULT_WIDTH), { modifiers: p.modifiers ?? 0 });
        if (r.error !== undefined) return this.fail(page, st, e, r.error);
      }
    }
    if ((p.clickCount ?? 1) >= 2 && st.releasedAt > -Infinity) await this.until(a, st.releasedAt + doubleClickGapMs(P, this.o.random));
    else if (st.lastWasMove) await this.until(a, st.lastMoveAt + pauseMs(P, this.o.random));
    // A press with no path after the client's modifier press (the pointer was there already): a chord's time after it.
    const mods = [...st.keys.values()].filter((k) => !k.own && MODIFIER_KEYS.has(k.params.key)).map((k) => k.at);
    if (mods.length) await this.until(a, Math.max(...mods) + draw(this.o.random, P.params.keys.chord.beforeMs));
    if (a.over) {
      const r = await this.endedSend(page, st, e, { ...p, x: point.x, y: point.y, force: force(P) });
      if (!r) return;
      const { sent } = r;
      st.buttons.set(p.button, p.clickCount ?? 1);
      st.press = { at: this.clock.now(), hold: 0, client, point, button: p.button };
      this.answerWith(page, e, sent);
      return;
    }
    const params = { ...p, x: point.x, y: point.y, force: force(P), timestamp: this.stamp(page, st) };
    const at = this.clock.now();
    const pr = this.sendEvent(page, st, undefined, e.method, params);
    st.buttons.set(p.button, p.clickCount ?? 1);
    st.press = { at, hold: holdMs(P, this.o.random), client, point, button: p.button };
    if (a.over) { this.answerWith(page, e, pr); return; }
    const r = await this.settle(a, pr);
    if ("ended" in r) { this.answerWith(page, e, pr); return; }
    if (!r.ok) { st.buttons.delete(p.button); st.press = null; return this.fail(page, st, e, r.error); }
    e.answer({ result: r.value ?? {} });
  }

  /** mouseReleased: at the later of its arrival and the press's send plus the hold, at the press's point. */
  private async releaseStep(page: StagePage, st: TabState, e: Entry): Promise<void> {
    const p = e.params, client = this.fit(p);
    this.dropRest(st);
    // A release of a button that the stage released at the end of a plan: no event (a button that is up cannot go up).
    if (st.released.delete(p.button) && !st.buttons.has(p.button)) { this.count("releasedAlready"); e.answer({ result: {} }); return; }
    if (st.plain) { this.count("plainAfterRecoveries"); return this.plainStep(page, st, e); }
    const a = await this.begin(page, st);
    if (a.over) return this.endedEvent(page, st, e);
    const pr0 = st.press && st.press.button === p.button ? st.press : null;
    const point = pr0 && same(pr0.client, client) ? pr0.point : client;
    if (pr0) await this.until(a, pr0.at + pr0.hold);
    if (a.over) {
      const r = await this.endedSend(page, st, e, { ...p, x: point.x, y: point.y });
      if (!r) return;
      const { sent } = r;
      st.buttons.delete(p.button); st.releasedAt = this.clock.now(); st.press = null; st.spread = null;
      this.answerWith(page, e, sent);
      return;
    }
    const params = { ...p, x: point.x, y: point.y, timestamp: this.stamp(page, st) };
    const pr = this.sendEvent(page, st, undefined, e.method, params);
    st.buttons.delete(p.button);
    st.releasedAt = this.clock.now();
    st.press = null; st.spread = null;
    if (a.over) { this.answerWith(page, e, pr); return; }
    const r = await this.settle(a, pr);
    if ("ended" in r) { this.answerWith(page, e, pr); return; }
    if (!r.ok) return this.fail(page, st, e, r.error);
    e.answer({ result: r.value ?? {} });
  }

  // ---------------------------------------------------------------- the scroll and the wheel (board ab-t30.11)

  /** A call as the client sent it (C11, the cases of no change), counted by `k` and its reason: an input call with the stage's timestamp, in the lock; a scroll as it is. */
  private asIs(page: StagePage, st: TabState, e: Entry, k: string, why: string): Promise<void> {
    this.count(k); this.count(`${k}:${why}`);
    if (this.o.trace) this.o.log(`relay: the input stage: tab ${page.id}: ${e.kind === "scroll" ? "a scroll into view" : "a wheel call"} as the client sent it (${why})`);
    return e.kind === "scroll" ? page.pass(e.child, e.method, e.params, e.answer) : this.plainStep(page, st, e);
  }

  /**
   * mouseWheel (C11, the scroll and the wheel). On Linux: notches of STAGE_NOTCH_PX in the direction of the call, on each
   * axis (the vertical first), at the page's last point, with a person's gaps; their count with the page's residual of
   * each axis (src/human/wheel.ts). A call that earlier notches have given gets no event, no lock and its answer at once;
   * a call of delta 0 on both axes gets one event, as Playwright's own input sends it (review-122 note 8). With no last
   * point, a path to the client's point first. Before the notches, the call's column (wheelColumn, review-122 option b):
   * the notches go until the next one would bring an element of rules 1, 2 or 4 under the point, and the rest goes as one
   * wheel event at the same point, one person's gap later. The call is answered after Chrome answered its last event. An
   * end of the plan: wheelEnded. On the Mac the call goes as it is.
   */
  private async wheelStep(page: StagePage, st: TabState, e: Entry): Promise<void> {
    if (!this.linux()) return this.asIs(page, st, e, "wheelAsIs", "mac");
    if (st.plain) { this.count("plainAfterRecoveries"); return this.plainStep(page, st, e); }
    const p = e.params, px = page.person.params.wheel.notchPx, W = (st.wheel ??= new Wheel(px));
    this.dropRest(st);
    if (!Number(p.deltaX) && !Number(p.deltaY)) { this.count("wheelZero"); return this.plainStep(page, st, e); }
    const nx = notches(Number(p.deltaX) || 0, W.x, px), ny = notches(Number(p.deltaY) || 0, W.y, px);
    if (!nx.count && !ny.count) { W.x = nx.residual; W.y = ny.residual; this.count("wheelNoNotch"); e.answer({ result: {} }); return; }
    const a = await this.begin(page, st);
    if (a.over) return this.endedEvent(page, st, e);
    W.x = nx.residual; W.y = ny.residual;
    if (!this.from(page, st)) {
      // A page with no last point: a path to the client's point first (as a press does).
      const client = this.fit(p), from = await this.startOf(page);
      if (from && !same(from, client)) {
        const r = await this.play(page, st, a, this.plan(page, st, from, client, DEFAULT_WIDTH), { modifiers: p.modifiers ?? 0 });
        if (r.error !== undefined) return this.fail(page, st, e, r.error);
      }
    }
    const at = this.from(page, st) ?? this.fit(p), count = { x: nx.count, y: ny.count };
    this.count("wheelCalls");
    try {
      // A navigation from the start of the column read stops the notches (review-122b R5).
      const nav = st.navs;
      const col = await this.wheelColumn(page, st, at, count, false);
      if (!col || col.frame) this.count(`wheelNoColumn:${col ? "frame" : "readFails"}`);
      const go = col && !col.frame ? col.k : count, one = { x: count.x - go.x, y: count.y - go.y };
      if (this.o.trace) this.o.log(`relay: the input stage: tab ${page.id}: a wheel call: ${Math.abs(go.x) + Math.abs(go.y)} notches${one.x || one.y ? ", then the rest as one event" : ""}`);
      const r = await this.notchesAt(page, st, a, at, go, { ...p }, one, nav);
      if (r.error !== undefined) return this.fail(page, st, e, r.error);
      if (a.over || r.navigated) return await this.wheelEnded(page, st, a, e, r.items, count, at, r.navigated, !!col?.frame);
      e.answer({ result: {} });
    } finally {
      void page.ownRead(WHEEL_CLEAR, []).catch(() => {});
    }
  }

  /**
   * The end of a wheel call's plan (C11, the end of a wheel plan; the daemon lead's P1): a dialog, STAGE_EVENT_WAIT_MS,
   * STAGE_ACTION_MAX_MS, a drop, or a navigation of the main frame. A notch is gone when Chrome answered it; at a dialog
   * also the first one with no answer at the end (it opened the dialog), and no later one (Chrome dropped it: review-122
   * note 1, the keys' rule). At STAGE_EVENT_WAIT_MS and at the limit, the stage first waits for the answers, at most one
   * more STAGE_EVENT_WAIT_MS; with none, the call gets an error with the count of the notches that may not have gone. The
   * notches that did not go go as one wheel event (after the dialog's close, with the lock again) only when the page's
   * last point is still a wheel point of the call's scroller (wheelColumn again: the same element under the point and the
   * same scroller, and a column with no element of rules 1, 2 or 4 for the rest); else, and at a navigation, no rest
   * goes, and the call gets an error that names the end and the count of the notches that did not go.
   */
  private async wheelEnded(page: StagePage, st: TabState, a: Action, e: Entry, items: WheelItem[], count: { x: number; y: number }, at: Pt, navigated: boolean, frame: boolean): Promise<void> {
    if (a.failed) { e.answer({ error: a.failBody ?? { code: -32000, message: "the input stage stopped the plan at an error of an event" } }); return; }
    this.count("wheelEnds");
    const end = a.over ? a.endedAt : this.clock.now(), sent = items.filter((x) => x.sent);
    const answers = Promise.all(sent.map((x) => x.sent!.catch(() => {})));
    const why = navigated ? "a navigation of the main frame" : a.ended === "dialog" ? "a dialog" : a.ended === "wait" ? `no answer in ${STAGE_EVENT_WAIT_MS} ms` : a.ended === "limit" ? `the limit of ${STAGE_ACTION_MAX_MS} ms` : "the end of the tab";
    const size = (q: { x: number; y: number }) => Math.abs(q.x) + Math.abs(q.y);
    const queued = !navigated && (a.ended === "wait" || a.ended === "limit");
    if (queued && !(await this.within(answers, STAGE_EVENT_WAIT_MS))) {
      if (st.gone === "session") return;
      this.count("wheelEndsUnanswered");
      const left = size(count) - items.filter((x) => x.answeredAt !== undefined).reduce((n, x) => n + size(x.n), 0);
      e.answer({ error: { code: -32000, message: `The input stage ended a wheel call at ${why}, and ${left} notches may not have gone: the page did not answer.` } });
      return;
    }
    const held = a.ended === "dialog" && !navigated ? items.findIndex((x) => x.sent && !(x.answeredAt !== undefined && x.answeredAt <= end)) : -1;
    const gone = { x: 0, y: 0 };
    items.forEach((x, i) => { if (x.sent && (held < 0 || i <= held)) { gone.x += x.n.x; gone.y += x.n.y; } });
    const rest = { x: count.x - gone.x, y: count.y - gone.y }, px = page.person.params.wheel.notchPx;
    if (!rest.x && !rest.y) { this.answerWith(page, e, Promise.all(sent.map((x) => x.sent!)).then(() => ({}))); return; }
    const cut = async (because: string) => {
      this.count("wheelRestsCut");
      // The error after Chrome's answers of the notches that went, or after STAGE_EVENT_WAIT_MS when they do not come.
      await this.within(answers, STAGE_EVENT_WAIT_MS);
      e.answer({ error: { code: -32000, message: `The input stage ended a wheel call at ${why}, and ${size(rest)} notches did not go: ${because}.` } });
    };
    if (navigated) return cut("the page navigated");
    if (a.over) await this.dialogGone(st);
    if (st.gone === "session") return;
    if (st.heldGone) { e.answer({ error: st.heldGone }); return; }
    if (!st.gone) {
      await this.retake(page, st, false);
      const c = await this.wheelColumn(page, st, at, rest, true);
      if (!c || !c.same || c.frame !== frame || c.k.x !== rest.x || c.k.y !== rest.y) return cut("the page's last point is no longer a wheel point of its scroller");
    }
    this.count("wheelRests");
    const er = await this.endedSend(page, st, e, { ...e.params, x: at.x, y: at.y, deltaX: rest.x * px, deltaY: rest.y * px });
    if (er) this.answerWith(page, e, er.sent);
  }

  /**
   * mouse.wheel's column (C11, `mouseWheel`; review-122 option b), read from the page's last point in the stage's own
   * world (WHEEL_COLUMN: rules 1 and 4, also into open shadow roots; `again`: the read after an end of the plan), then rule
   * 2 on its scrollers (columnListeners): the notches of each axis that go before the next one would bring such an element
   * under the point. The boxes of rule 2 that hold the point (the element under it and the elements around it) do not
   * count. When rule 2 cuts the vertical notches, the horizontal ones go in the rest too (their column was read after all
   * the vertical ones). `frame`: the point is over a cross-origin frame (all the notches); null: a read failed.
   */
  private async wheelColumn(page: StagePage, st: TabState, at: Pt, n: { x: number; y: number }, again: boolean): Promise<Column | null> {
    const px = page.person.params.wheel.notchPx;
    const r = await this.read(page.ownRead(WHEEL_COLUMN, [at.x, at.y, n.y, n.x, px, again ? 1 : 0]));
    const v = r === TIMEOUT ? null : (r as any);
    if (!v || typeof v !== "object") return null;
    if (v.frame) return { k: { ...n }, same: v.same !== false, frame: true };
    if (!Array.isArray(v.k) || !Array.isArray(v.col) || !v.k.every((x: unknown) => Number.isInteger(x) && (x as number) >= 0)) return null;
    const k = { x: Math.sign(n.x) * Math.min(Math.abs(n.x), v.k[0]), y: Math.sign(n.y) * Math.min(Math.abs(n.y), v.k[1]) };
    const cols = [rectOf(v.col[0]), rectOf(v.col[1])];
    if (cols.some((c) => c)) {
      const boxes = await this.columnListeners(page);
      if (boxes === TIMEOUT) return null;
      const holds = (b: Rect) => at.x >= b.x0 && at.x <= b.x1 && at.y >= b.y0 && at.y <= b.y1;
      const meets = (b: Rect, g: Rect) => b.x0 <= g.x1 && b.x1 > g.x0 && b.y0 <= g.y1 && b.y1 > g.y0;
      const ky = k.y;
      for (const ax of [1, 0] as const) {
        const g = cols[ax], N = ax ? n.y : n.x;
        if (!g || !N) continue;
        let d = Infinity;
        for (const b of boxes) {
          if (holds(b) || !meets(b, g)) continue;
          const dd = ax ? (N > 0 ? b.y0 - at.y : at.y - b.y1) : (N > 0 ? b.x0 - at.x : at.x - b.x1);
          d = Math.min(d, Math.max(0, dd));
        }
        if (d === Infinity) continue;
        const kk = Math.max(0, Math.ceil(d / px) - 1);
        if (ax) k.y = Math.sign(N) * Math.min(Math.abs(k.y), kk); else k.x = Math.sign(N) * Math.min(Math.abs(k.x), kk);
      }
      if (k.y !== ky) k.x = 0;
    }
    return { k, same: v.same !== false, frame: false };
  }

  /**
   * Rule 2's boxes for mouse.wheel's column: the scrollers of the last WHEEL_COLUMN and the open shadow roots inside them
   * (at most WHEEL_ROOTS_MAX), as handles of the stage's own world (WHEEL_ROOTS_AT, WHEEL_ROOT_AT), then as rule 2 reads them
   * (listenerBoxes). The handles are of the stage's own group, which it releases.
   */
  private async columnListeners(page: StagePage): Promise<Rect[] | typeof TIMEOUT> {
    if (!page.ownObject) return TIMEOUT;
    const until = this.clock.now() + WHEEL_LISTENERS_WAIT_MS, left = () => until - this.clock.now();
    try {
      const n = await this.read(page.ownRead(WHEEL_ROOTS_AT, [WHEEL_ROOTS_MAX]), left());
      if (n === TIMEOUT || typeof n !== "number") return TIMEOUT;
      const ids: string[] = [];
      for (let i = 0; i < n; i++) {
        const h = left() > 0 ? await this.read(page.ownObject(WHEEL_ROOT_AT, [i]), left()) : TIMEOUT;
        if (h === TIMEOUT || typeof h !== "string") return TIMEOUT;
        ids.push(h);
      }
      return await this.listenerBoxes(page, undefined, ids, until);
    } finally {
      void page.send(undefined, "Runtime.releaseObjectGroup", { objectGroup: STAGE_GROUP }).catch(() => {});
    }
  }

  /**
   * Notches at a point (a signed count on each axis, the vertical first), each at its time with no wait for the answer of
   * the one before, as a wheel's events: the first at the later of now and one person's gap after the page's last notch
   * or the end of the path before it (a hand that stops, then turns the wheel); then `one`, the rest of a wheel call as one
   * event, one person's gap after the last notch (review-122 option b). An end of the plan, a refused event or a navigation
   * of the main frame stops them (a navigation since `nav`, the count of navigations when the caller's reads began). `items`: each notch (and the rest), with its send and the time of Chrome's answer; `all`:
   * Chrome's answers of those that went; `error`: a refused one (the plan sends no more).
   */
  private async notchesAt(page: StagePage, st: TabState, a: Action, at: Pt, count: { x: number; y: number }, base: Record<string, unknown>, one = { x: 0, y: 0 }, nav = st.navs):
    Promise<{ items: WheelItem[]; all: Promise<unknown>; sent: number; navigated: boolean; error?: unknown }> {
    const P = page.person, px = P.params.wheel.notchPx, plan = wheelPlan(count, P, this.o.random);
    const t0 = Math.max(this.clock.now(), Math.max(st.lastNotchAt, st.lastWasMove ? st.lastMoveAt : -Infinity) + notchGapMs(P, this.o.random));
    const items: WheelItem[] = plan.map((n) => ({ t: n.t, dx: n.dx, dy: n.dy, n: n.dy ? { x: 0, y: Math.sign(n.dy) } : { x: Math.sign(n.dx), y: 0 } }));
    if (one.x || one.y) items.push({ t: plan.length ? plan[plan.length - 1].t + notchGapMs(P, this.o.random) : 0, dx: one.x * px, dy: one.y * px, n: { ...one }, one: true });
    let error: unknown;
    for (const it of items) {
      await this.until(a, t0 + it.t);
      if (a.over || error !== undefined || st.navs !== nav) break;
      const pr = this.sendEvent(page, st, undefined, "Input.dispatchMouseEvent", { ...base, type: "mouseWheel", x: at.x, y: at.y, deltaX: it.dx, deltaY: it.dy, timestamp: this.stamp(page, st) });
      st.lastNotchAt = this.clock.now();
      it.sent = pr;
      pr.then(() => { it.answeredAt = this.clock.now(); }, (x) => { it.answeredAt = this.clock.now(); if (error === undefined) error = x; });
      if (it.one) this.count("wheelRestAsOne");
    }
    const sent = items.filter((x) => x.sent).map((x) => x.sent!);
    const all = Promise.all(sent);
    all.catch(() => {});
    if (error === undefined && !a.over && st.navs === nav) { const s = await this.settle(a, all); if (!("ended" in s) && !s.ok) error = s.error; }
    return { items, all, sent: sent.length, navigated: st.navs !== nav, ...(error !== undefined ? { error } : {}) };
  }

  /**
   * DOM.scrollIntoViewIfNeeded (C11, the scroll and the wheel), on every session. On Linux: the element in view gets {}
   * with no event; else notches into view (intoView), then {}. When it cannot (no wheel point, a round that does not move
   * the scroller, STAGE_SCROLL_ROUNDS, a box that no wheel moves, a read that fails, the end of the plan), the client's
   * call goes as it is (a script scroll), logged and counted. While the stage holds a button (dragTo's scroll of its drop
   * target), the call goes as it is, counted (review-122 B3: a path with no button would end the drag; ab-t30.12 decides
   * the drag). On the Mac the call goes as it is.
   */
  private async scrollStep(page: StagePage, st: TabState, e: Entry): Promise<void> {
    const p = e.params, node = typeof p.objectId === "string" ? p.objectId : null;
    if (!this.linux()) return this.asIs(page, st, e, "scrollAsIs", "mac");
    if (!node || st.action?.over) return this.asIs(page, st, e, "scrollAsIs", node ? "ended" : "noHandle");
    if (st.buttons.size) return this.asIs(page, st, e, "scrollAsIs", "held");
    const q = p.rect, rect = q && [q.x, q.y, q.width, q.height].every((v) => typeof v === "number" && Number.isFinite(v)) ? { x: q.x, y: q.y, w: q.width, h: q.height } : null;
    const r = await this.intoView(page, st, null, e.child, node, false, rect);
    if (r.ok) {
      this.count(r.notched ? "scrollNotched" : "scrollInView");
      if (this.o.trace) this.o.log(`relay: the input stage: tab ${page.id}: a scroll into view: ${r.notched ? `${r.notched} notches in ${r.rounds} rounds` : "in view"}`);
      e.answer({ result: {} });
      return;
    }
    if (r.why === "error") return this.fail(page, st, e, r.error);
    this.o.log(`relay: the input stage: a scroll into view of tab ${page.id} went as the client sent it (${r.why})`);
    return this.asIs(page, st, e, "scrollAsIs", r.why);
  }

  /**
   * Notches into view (C11, the scroll and the wheel; the focus click's notches): the element (grown by its scroll-margin)
   * is in view when it is in view of the visible part of its nearest level (shrunk by its scroll-padding). Else each round
   * finds the outermost scroller that must move (the plan of scrollPlan; a box that no wheel moves ends them), a wheel
   * point over its visible part (wheelPoint), a path there when the pointer is not there, the notches that bring the
   * element's middle to the middle of that scroller, the wait for the smooth scroll (SCROLL_WAIT_MS), and the read again;
   * at most STAGE_SCROLL_ROUNDS rounds, and a round that does not move its scroller ends them. On the Mac the read alone
   * (no notch). The action is the caller's (`a`), else one that it begins at its first event. At the end the world lets
   * go of what its reads kept (review-122 note 9).
   */
  private async intoView(page: StagePage, st: TabState, a: Action | null, child: string | undefined, node: string, follow: boolean, rect: { x: number; y: number; w: number; h: number } | null):
    Promise<{ ok: true; view: ScrollView; notched: number; rounds: number } | { ok: false; why: string; error?: unknown }> {
    const owners: string[] = [];
    const read = async () => { const v = await this.scrollRead(page, st, child, node, follow, rect); if (v && typeof v === "object" && v.owner) owners.push(v.owner); return v; };
    try {
      let view = await read(), rounds = 0, notched = 0;
      for (;;) {
        if (view === null) return { ok: false, why: "readFails" };
        if (view === "none") return { ok: false, why: "noBox" };
        if (view === "deep") return { ok: false, why: "frameDeep" };
        if (inView(grow(view.t, view.mg), grow(view.vis[0], view.levels[0]?.pad ?? [0, 0, 0, 0], -1))) return { ok: true, view, notched, rounds };
        if (!this.linux()) return { ok: false, why: "mac" };
        if (rounds >= STAGE_SCROLL_ROUNDS) return { ok: false, why: "rounds" };
        const plan = this.scrollPlan(view);
        if (!plan) return { ok: false, why: "noRange" };
        if (plan === "hidden") return { ok: false, why: "hidden" };
        // At least one notch on each axis that must move 1 px or more (review-122 note 7).
        const px = page.person.params.wheel.notchPx, n = (d: number) => (Math.abs(d) < 1 ? 0 : Math.sign(d) * Math.max(1, Math.round(Math.abs(d) / px)));
        const count = { x: n(plan.d[0]), y: n(plan.d[1]) };
        const at = await this.wheelPoint(page, st, view, plan.k, [count.x * px, count.y * px]);
        if (at === TIMEOUT) return { ok: false, why: "readFails" };
        if (!at) return { ok: false, why: "noWheelPoint" };
        a ??= await this.begin(page, st);
        if (a.over) return { ok: false, why: "ended" };
        // The pointer goes to the wheel point with a path when it is not there (the way to a wheel point: C11, one window per page).
        const from = this.from(page, st) ?? (await this.startOf(page));
        if (from && !same(from, at)) {
          const r = await this.play(page, st, a, this.plan(page, st, from, at, DEFAULT_WIDTH), { modifiers: this.clientBits(st) });
          if (r.error !== undefined) return { ok: false, why: "error", error: r.error };
          if (a.over) return { ok: false, why: "ended" };
          // The in-flight bound stopped the path while the plan is live (review-122 note 11).
          if (r.stopped) return { ok: false, why: "inFlight" };
        }
        const before = view.levels[plan.k].s;
        const r = await this.notchesAt(page, st, a, at, count, { modifiers: this.clientBits(st) });
        if (r.error !== undefined) return { ok: false, why: "error", error: r.error };
        if (a.over) return { ok: false, why: "ended" };
        if (r.navigated) return { ok: false, why: "navigated" };
        rounds++; notched += r.sent;
        this.count("scrollRounds");
        // The smooth scroll of the round ends (a first value), then the read again.
        await this.until(a, st.lastNotchAt + SCROLL_WAIT_MS);
        if (a.over) return { ok: false, why: "ended" };
        const next = await read();
        // A round that does not move its scroller ends the notches: no notch goes to a page that does not scroll with it.
        if (next && typeof next === "object" && next.levels.length === view.levels.length && next.levels[plan.k].s[0] === before[0] && next.levels[plan.k].s[1] === before[1]) return { ok: false, why: "noMove" };
        view = next;
      }
    } finally {
      void page.send(child, "Runtime.callFunctionOn", { objectId: node, functionDeclaration: SCROLL_CLEAR, returnByValue: true }).catch(() => {});
      for (const o of owners) {
        void page.send(undefined, "Runtime.callFunctionOn", { objectId: o, functionDeclaration: SCROLL_CLEAR, returnByValue: true }).catch(() => {});
        void page.send(undefined, "Runtime.releaseObject", { objectId: o }).catch(() => {});
      }
    }
  }

  /**
   * The scroll's read (SCROLL_STATE on the node's handle): the target and its levels in the top page's points. For a node
   * of a cross-origin frame (a child session), its frame's levels get the frame mapping's offset, and the top page's
   * levels come from the same read on the frame's owner in the stage's own world (one cross-origin level only; "deep": a
   * cross-origin frame inside another one). Then the visible part of each level, from the viewport (Page.getLayoutMetrics)
   * inward. "none": the node has no box; null: a read failed (the stage fails open).
   */
  private async scrollRead(page: StagePage, st: TabState, child: string | undefined, node: string, follow: boolean, rect: { x: number; y: number; w: number; h: number } | null): Promise<ScrollView | "none" | "deep" | null> {
    const args = rect ? [rect.x, rect.y, rect.w, rect.h] : [null, null, null, null];
    const r = await this.read(page.send(child, "Runtime.callFunctionOn", { objectId: node, functionDeclaration: SCROLL_STATE, arguments: [...args.map((value) => ({ value })), { value: follow }, { value: false }], returnByValue: true }));
    const v = r === TIMEOUT ? null : (r as any)?.result?.value;
    if (v?.none) return "none";
    const t = rectOf(v?.t);
    if (!v || !t || !Array.isArray(v.levels) || v.flat === false) return null;
    const lv = (list: any[], rd: Reader, x: number, y: number): Level[] | null => {
      const out: Level[] = [];
      for (const [k, l] of list.entries()) {
        const b = rectOf(l?.r);
        if (!b || !Array.isArray(l.s) || !Array.isArray(l.m)) return null;
        const w: [boolean, boolean] = Array.isArray(l.wheel) ? [l.wheel[0] === true, l.wheel[1] === true] : [true, true];
        out.push({ r: shift(b, x, y), s: [Number(l.s[0]) || 0, Number(l.s[1]) || 0], m: [Number(l.m[0]) || 0, Number(l.m[1]) || 0], doc: !!l.doc, rd, k, w, pad: sidesOf(l.pad) });
      }
      return out;
    };
    let ox = 0, oy = 0, outer: Level[] = [], owner: string | undefined;
    if (!v.top) {
      // A cross-origin frame: one level of it (its owner on the top page), else the stage fails open.
      if (!child || !page.ownNode) return null;
      const m = await this.mapped(page, st, child, { ox: v.ox, oy: v.oy, top: false, flat: true, box: t });
      if (!m) return null;
      if (m.levels.length !== 1 || m.levels[0].parent !== undefined) return "deep";
      ox = m.ox - v.ox; oy = m.oy - v.oy;
      const o = await this.read(page.ownNode(m.levels[0].owner));
      if (o === TIMEOUT || typeof o !== "string") return null;
      owner = o;
      const w = await this.read(page.send(undefined, "Runtime.callFunctionOn", { objectId: o, functionDeclaration: SCROLL_STATE, arguments: [{ value: null }, { value: null }, { value: null }, { value: null }, { value: false }, { value: true }], returnByValue: true }));
      const u = w === TIMEOUT ? null : (w as any)?.result?.value;
      const ol = u && u.top && u.flat !== false && Array.isArray(u.levels) ? lv(u.levels, { child: undefined, obj: o, ox: 0, oy: 0 }, 0, 0) : null;
      if (!ol) { void page.send(undefined, "Runtime.releaseObject", { objectId: o }).catch(() => {}); return null; }
      outer = ol;
    }
    const inner = lv(v.levels, { child, obj: node, ox, oy, owner }, ox, oy);
    if (!inner) return null;
    const levels = [...inner, ...outer];
    const lm = await this.read(page.send(undefined, "Page.getLayoutMetrics", {}));
    const vp = lm === TIMEOUT ? null : (lm as any)?.cssLayoutViewport;
    const port: Rect | null = vp?.clientWidth > 0 && vp?.clientHeight > 0 ? { x0: 0, y0: 0, x1: vp.clientWidth, y1: vp.clientHeight } : levels.at(-1)?.r ?? null;
    if (!port) return null;
    const vis: Rect[] = [];
    let V = port;
    for (let i = levels.length - 1; i >= 0; i--) vis[i] = V = meet(levels[i].r, V);
    return { t: shift(t, ox, oy), mg: sidesOf(v.mg), levels, vis: levels.length ? vis : [port], owner };
  }

  /**
   * The plan of a round (as Chromium's own scroll into view, innermost first): for each level, the move on each axis that
   * brings the element's middle (grown by its scroll-margin; clipped to the level inside it, after that one's move) to the
   * middle of its box (shrunk by its scroll-padding), unless it is in view there already, within its scroll range. The
   * round is the outermost scroller that must move, so that the scrollers inside it come into view before their own
   * notches. "hidden": a level that must move is a box that no wheel moves (overflow hidden or clip: review-122 B2); null:
   * no level can move it.
   */
  private scrollPlan(v: ScrollView): { k: number; d: [number, number] } | "hidden" | null {
    let thing = grow(v.t, v.mg);
    const ds: [number, number][] = [];
    for (const L of v.levels) {
      const R = grow(L.r, L.pad, -1), d: [number, number] = [0, 0];
      for (const ax of [0, 1] as const) {
        const [lo, hi, vlo, vhi] = ax ? [thing.y0, thing.y1, R.y0, R.y1] : [thing.x0, thing.x1, R.x0, R.x1];
        if (axisIn(lo, hi, vlo, vhi, ax ? 0.6 : 0.8)) continue;
        d[ax] = Math.max(-L.s[ax], Math.min(L.m[ax] - L.s[ax], (lo + hi) / 2 - (vlo + vhi) / 2));
      }
      ds.push(d);
      const moved = shift(thing, -d[0], -d[1]), cut = meet(moved, L.r);
      thing = cut.x1 >= cut.x0 && cut.y1 >= cut.y0 ? cut : moved;
    }
    if (ds.some((d, i) => (Math.abs(d[0]) >= 1 && !v.levels[i].w[0]) || (Math.abs(d[1]) >= 1 && !v.levels[i].w[1]))) return "hidden";
    for (let i = ds.length - 1; i >= 0; i--) if (Math.abs(ds[i][0]) >= 1 || Math.abs(ds[i][1]) >= 1) return { k: i, d: ds[i] };
    return null;
  }

  /**
   * The wheel point of a scroller for a round's move `mv` (C11, the wheel point): the page's last point first, then the
   * points of a 5 x 5 grid over the scroller's visible part, the nearest to the last point first; the first that passes
   * rules 1, 3 and 4 (WHEEL_POINTS on the scroller's reader: the point's own chain and its column, the content that the
   * notches move under it), the frame's owner at the point on the top page for a cross-origin frame's scroller
   * (OWNER_AT), and rule 2 (no box of an element with a listener of `wheel` or `mousewheel` that is not passive holds the
   * point or meets its column). Null: no point passes; TIMEOUT: a read failed.
   */
  private async wheelPoint(page: StagePage, st: TabState, view: ScrollView, k: number, mv: [number, number]): Promise<Pt | null | typeof TIMEOUT> {
    const L = view.levels[k], V = view.vis[k];
    if (!(V.x1 - V.x0 >= 1 && V.y1 - V.y0 >= 1)) return null;
    const inV = (q: Pt) => q.x >= V.x0 && q.y >= V.y0 && q.x < V.x1 && q.y < V.y1;
    const last = this.from(page, st), cands: Pt[] = last && inV(last) ? [last] : [], grid: Pt[] = [];
    for (let i = 0; i < 25; i++) {
      const q = this.fit({ x: V.x0 + (V.x1 - V.x0) * (0.5 + ((i % 5) - 2) * 0.18), y: V.y0 + (V.y1 - V.y0) * (0.5 + (Math.floor(i / 5) - 2) * 0.18) });
      if (inV(q) && !cands.some((c) => same(c, q)) && !grid.some((c) => same(c, q))) grid.push(q);
    }
    const o = last ?? { x: (V.x0 + V.x1) / 2, y: (V.y0 + V.y1) / 2 };
    grid.sort((p, q) => Math.hypot(p.x - o.x, p.y - o.y) - Math.hypot(q.x - o.x, q.y - o.y));
    cands.push(...grid);
    const rd = L.rd;
    const r = await this.read(page.send(rd.child, "Runtime.callFunctionOn", { objectId: rd.obj, functionDeclaration: WHEEL_POINTS, arguments: [{ value: L.k }, { value: cands.map((q) => [q.x - rd.ox, q.y - rd.oy]) }, { value: mv }], returnByValue: true }));
    let pass: number[] | null = r === TIMEOUT ? null : (r as any)?.result?.value;
    if (!Array.isArray(pass)) return TIMEOUT;
    if (pass.length && rd.owner) {
      // A cross-origin frame's scroller: the top page's element at the point is the frame's owner.
      const w = await this.read(page.send(undefined, "Runtime.callFunctionOn", { objectId: rd.owner, functionDeclaration: OWNER_AT, arguments: [{ value: pass.map((i) => [cands[i].x, cands[i].y]) }], returnByValue: true }));
      const hits = w === TIMEOUT ? null : (w as any)?.result?.value;
      if (!Array.isArray(hits)) return TIMEOUT;
      pass = pass.filter((_, j) => hits[j] === true);
    }
    if (!pass.length) return null;
    const boxes = await this.wheelListeners(page, rd, L.k);
    if (boxes === TIMEOUT) return TIMEOUT;
    // Rule 2: no box of an element with a wheel listener that is not passive holds the point or meets its column.
    const meets = (b: Rect, g: Rect) => b.x0 <= g.x1 && b.x1 > g.x0 && b.y0 <= g.y1 && b.y1 > g.y0;
    for (const i of pass) {
      const x = cands[i].x - rd.ox, y = cands[i].y - rd.oy;
      const col: Rect[] = [{ x0: x, y0: y, x1: x, y1: y }];
      if (mv[1]) col.push({ x0: x, y0: Math.min(y, y + mv[1]), x1: x, y1: Math.max(y, y + mv[1]) });
      if (mv[0]) col.push({ x0: Math.min(x, x + mv[0]), y0: y + mv[1], x1: Math.max(x, x + mv[0]), y1: y + mv[1] });
      if (!boxes.some((b) => col.some((g) => meets(b, g)))) return cands[i];
    }
    return null;
  }

  /**
   * Rule 2's read for a scroll's wheel point: the scroller and the open shadow roots inside it (WHEEL_ROOTS, at most
   * WHEEL_ROOTS_MAX; WHEEL_ROOT gives each one's handle on the scroller's reader), then their boxes (listenerBoxes), all
   * within WHEEL_LISTENERS_WAIT_MS (review-122 note 13). The handles are of the stage's own group, which it releases.
   */
  private async wheelListeners(page: StagePage, rd: Reader, k: number): Promise<Rect[] | typeof TIMEOUT> {
    const until = this.clock.now() + WHEEL_LISTENERS_WAIT_MS, left = () => until - this.clock.now();
    try {
      const n = await this.read(page.send(rd.child, "Runtime.callFunctionOn", { objectId: rd.obj, functionDeclaration: WHEEL_ROOTS, arguments: [{ value: k }, { value: WHEEL_ROOTS_MAX }], returnByValue: true }), left());
      const count = n === TIMEOUT ? undefined : (n as any)?.result?.value;
      if (typeof count !== "number" || !(count >= 1)) return TIMEOUT;
      const ids: string[] = [];
      for (let i = 0; i < count; i++) {
        const root = left() > 0 ? await this.read(page.send(rd.child, "Runtime.callFunctionOn", { objectId: rd.obj, functionDeclaration: WHEEL_ROOT, arguments: [{ value: i }], returnByValue: false, objectGroup: STAGE_GROUP }), left()) : TIMEOUT;
        const id = root === TIMEOUT ? undefined : (root as any)?.result?.objectId;
        if (typeof id !== "string") return TIMEOUT;
        ids.push(id);
      }
      return await this.listenerBoxes(page, rd.child, ids, until);
    } finally {
      void page.send(rd.child, "Runtime.releaseObjectGroup", { objectGroup: STAGE_GROUP }).catch(() => {});
    }
  }

  /**
   * Rule 2's boxes (DOM.getContentQuads) of the elements under some roots (a scroller, the open shadow roots inside it:
   * each root and every element inside it, not into a shadow root) that have a listener of `wheel` or `mousewheel` that is
   * not passive, in the points of the roots' session; the window's and the document's listeners do not count. The
   * listeners are the page's own: DOMDebugger.getEventListeners reports the listeners of the world of its handle only
   * (unless `pierce`, which also walks shadow roots and frames and reports every world, and after which the renderer of the
   * input research's recorder page crashed, twice, live), so the stage resolves each root into the page's main world
   * (DOM.describeNode, DOM.resolveNode: a handle, no script) and reads its subtree there with no `pierce`. A closed shadow
   * root and the roots after WHEEL_ROOTS_MAX stay out of the read. All the reads end by `until`, else the read fails open.
   */
  private async listenerBoxes(page: StagePage, child: string | undefined, roots: string[], until: number): Promise<Rect[] | typeof TIMEOUT> {
    const left = () => until - this.clock.now();
    const step = async <T>(p: () => Promise<T>): Promise<T | typeof TIMEOUT> => (left() > 0 ? this.read(p(), left()) : TIMEOUT);
    const nodes = new Set<number>();
    for (const id of roots) {
      const node = await step(() => page.send(child, "DOM.describeNode", { objectId: id }));
      const backendNodeId = node === TIMEOUT ? undefined : (node as any)?.node?.backendNodeId;
      if (!Number.isInteger(backendNodeId)) return TIMEOUT;
      const main = await step(() => page.send(child, "DOM.resolveNode", { backendNodeId, objectGroup: STAGE_GROUP }));
      const mainId = main === TIMEOUT ? undefined : (main as any)?.object?.objectId;
      if (typeof mainId !== "string") return TIMEOUT;
      const l = await step(() => page.send(child, "DOMDebugger.getEventListeners", { objectId: mainId, depth: -1, pierce: false }));
      if (l === TIMEOUT) return TIMEOUT;
      for (const x of (l as any)?.listeners ?? []) if ((x?.type === "wheel" || x?.type === "mousewheel") && x?.passive !== true && Number.isInteger(x?.backendNodeId)) nodes.add(x.backendNodeId);
      if (nodes.size > WHEEL_LISTENERS_MAX) return TIMEOUT;
    }
    const boxes: Rect[] = [];
    for (const b of nodes) {
      // A node with no box (Chrome refuses its quads) is under no point.
      const q = await step(() => page.send(child, "DOM.getContentQuads", { backendNodeId: b }).catch(() => ({ quads: [] })));
      if (q === TIMEOUT) return TIMEOUT;
      for (const quad of (q as any)?.quads ?? []) {
        if (!Array.isArray(quad) || quad.length !== 8) continue;
        const xs = [quad[0], quad[2], quad[4], quad[6]], ys = [quad[1], quad[3], quad[5], quad[7]];
        boxes.push({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) });
      }
    }
    return boxes;
  }

  // ---------------------------------------------------------------- the keys and the text (board ab-t30.10)

  /** The bits of the modifier keys that the client holds down (by the stage's events). */
  private clientBits(st: TabState): number {
    let m = 0;
    for (const k of st.keys.values()) if (!k.own) m |= MODIFIER_BIT[k.params.key] ?? 0;
    return m;
  }
  /** Whether the client holds a key down (a modifier or not): the run and the lock stay until its keyUp (C11, the input lock). */
  private clientKeysHeld(st: TabState): boolean { for (const k of st.keys.values()) if (!k.own) return true; return false; }

  /** The tab's key stream; a new one learns the keys that the stage's events hold down (an earlier run's, or a click's modifier). */
  private stream(page: StagePage, st: TabState): KeyStream {
    if (st.ks) return st.ks;
    // No fast end after 12 s (the rule of a key run before board ab-t30.19): the run's time has STAGE_TYPE_MAX_MS (budget).
    const s = new KeyStream(page.person, this.o.random, { runSlowMs: Infinity });
    // The modifiers first, so that a held key with text needs no press of the stream's own; the events are dropped (the keys are down already).
    const held = [...st.keys.values()].filter((k) => !k.own).sort((a, b) => Number(!MODIFIER_KEYS.has(a.params.key)) - Number(!MODIFIER_KEYS.has(b.params.key)));
    for (const k of held) s.next({ ...keyOf(k.params, 0), modifiers: 0 }, Math.min(this.clock.now(), k.at));
    return (st.ks = s);
  }

  private stopKeyTimer(st: TabState): void { st.kTimer?.(); st.kTimer = null; st.runTimer?.(); st.runTimer = null; }
  /** Planned key events into the run's queue, in the order of their times (a press can come before an earlier planned release: rollover). */
  private enqueue(st: TabState, items: KeyItem[]): void {
    for (const it of items) {
      let i = st.kq.length;
      while (i > 0 && st.kq[i - 1].ev.t > it.ev.t) i--;
      st.kq.splice(i, 0, it);
    }
  }

  /**
   * After a step of the tab (no step runs now): the next planned key event at its time; with none, the stream's own Shift
   * at its planned release when the client holds no key; else the run's end RUN_IDLE_MS after its last key. A key that the
   * client holds keeps the run and the lock until its keyUp, within STAGE_ACTION_MAX_MS (C11, the input lock).
   */
  private kick(page: StagePage, st: TabState): void {
    this.stopKeyTimer(st);
    const a = st.action;
    if (st.running || st.gone || !st.runOpen) return;
    const now = this.clock.now();
    // A collected part (C11, the collected keys) goes RUN_IDLE_MS after its last call, as a step of the tab's gate: the
    // tab's later calls wait for its events. The planned events of the run before it go first, at their times.
    const gap = () => { const c = st.col!; st.runTimer = this.clock.timer(c.lastAt + RUN_IDLE_MS - now, () => { st.runTimer = null; page.inGate(() => this.partAtGap(page, st)); }); };
    if (!a || a.over) { if (st.col) gap(); else st.runTimer = this.clock.timer(RUN_IDLE_MS, () => { st.runTimer = null; this.idleEnd(page, st); }); return; }
    if (st.kq.length) {
      st.kTimer = this.clock.timer(st.kq[0].ev.t - now, () => {
        st.kTimer = null;
        if (st.running || st.action !== a || a.over) return;
        this.drain(page, st, this.clock.now());
        this.kick(page, st);
      });
      return;
    }
    // The stage's own Shift goes up at its planned time once no key that it holds is down, also while the client holds
    // another key (review-119 N1); a key that the client holds keeps the run open after it.
    const up = st.runPlain || !st.ks || st.ks.shiftHoldsDown ? null : st.ks.plannedShiftUp();
    if (up !== null) {
      st.kTimer = this.clock.timer(up - now, () => {
        st.kTimer = null;
        if (st.running || st.action !== a || a.over || !st.ks) return;
        this.enqueue(st, st.ks.idle(this.clock.now()).map((ev) => ({ ev, typed: {} })));
        this.drain(page, st, this.clock.now());
        this.kick(page, st);
      });
      return;
    }
    if (st.col) return gap();
    if (this.clientKeysHeld(st)) return;
    st.runTimer = this.clock.timer(RUN_IDLE_MS, () => { st.runTimer = null; this.idleEnd(page, st); });
  }

  /** RUN_IDLE_MS after the run's last key (C11, the input lock): the run ends; an action that holds nothing frees the lock. */
  private idleEnd(page: StagePage, st: TabState): void {
    if (st.running || st.gone || !st.runOpen) return;
    const a = st.action;
    if (a && !a.over && st.ks && !st.runPlain) { this.enqueue(st, st.ks.end(this.clock.now()).map((ev) => ({ ev, typed: {} }))); this.drain(page, st, Infinity); }
    else st.ks?.end(this.clock.now());
    st.runOpen = false; st.runSpent = 0;
    if (st.runPlain) { st.runPlain = false; st.ks = null; }
    if (a && !a.over && !st.buttons.size && !st.keys.size && !st.rest && !st.pending.length) this.close(st, page.id);
  }

  /**
   * The end of the tab's key run (C11, the input lock: a key run ends at the tab's next call that is not a key): its
   * planned releases at their times, then the release of the stream's own Shift. The call that is not a key waits for it.
   */
  private async endRun(page: StagePage, st: TabState): Promise<void> {
    this.stopKeyTimer(st);
    // The collected part first (C11, the collected keys): the call that ends the run waits for its events.
    if (st.col) await this.endPart(page, st);
    const a = st.action;
    if (a && !a.over && st.ks && !st.runPlain) {
      this.enqueue(st, st.ks.end(Math.max(this.clock.now(), ...st.kq.map((x) => x.ev.t))).map((ev) => ({ ev, typed: {} })));
      if (st.kq.length) await this.playKeys(page, st, a, st.kq[st.kq.length - 1]);
    } else st.ks?.end(this.clock.now());
    st.runOpen = false; st.runSpent = 0;
    if (st.runPlain) { st.runPlain = false; st.ks = null; }
  }

  /**
   * A call of the tab that the stage does not take (C11, the input lock: a key run ends at the tab's next call that is not
   * a key; the answers: every later call of the tab that is not a key press waits until an early-answered release has
   * gone): null when the tab has no key run, else the step that ends the run, which the model puts in the tab's gate
   * before the call.
   */
  other(page: StagePage): (() => Promise<void>) | null {
    const st = this.tabs.get(page.id);
    // A move run ends at the tab's next call that the stage does not take (N9): its action closes before that call.
    if (st && !st.gone && st.moveTimer && !st.runOpen && !st.pending.length) return async () => {
      if (!st.moveTimer || st.running) return;
      this.stopMoveRun(st);
      await this.afterStep(page, st);
    };
    if (!st || st.gone || (!st.runOpen && !st.pending.some((x) => x.kind === "key" || x.kind === "text"))) return null;
    return async () => {
      if (!st.runOpen || st.gone || st.running) return;
      st.running = true;
      this.stopKeyTimer(st);
      try { await this.endRun(page, st); } catch (err) { this.o.log(`relay: the input stage: the end of a key run of tab ${page.id} failed: ${(err as Error).message}`); }
      finally { st.running = false; await this.afterStep(page, st); }
    };
  }

  /** The planned key events that are due by `upTo`, at once (a timer of the run, while no step runs). */
  private drain(page: StagePage, st: TabState, upTo: number): void {
    while (st.kq.length && st.kq[0].ev.t <= upTo && !st.action?.failed) this.sendKey(page, st, st.kq.shift()!);
  }

  /**
   * The planned key events in the order of their times, each at its time, up to and including `target`. False when the
   * plan ended or failed before `target` went (the end of the plan takes the queue).
   */
  private async playKeys(page: StagePage, st: TabState, a: Action, target: KeyItem, stop?: () => boolean): Promise<boolean> {
    while (st.kq.length) {
      const it = st.kq[0];
      await this.until(a, it.ev.t);
      if (a.over || st.kq[0] !== it || stop?.()) return false;
      st.kq.shift();
      this.sendKey(page, st, it);
      if (it === target) return true;
    }
    return !!target.sent;
  }

  /** One key event to Chrome, with the stage's timestamp: the keys that the stage holds down are kept for the releases at an end of a plan. */
  private sendKey(page: StagePage, st: TabState, it: KeyItem): Promise<any> {
    // A character with no US key of a typed part: an Input.insertText at its time.
    if (it.insert !== undefined) {
      const p = this.sendEvent(page, st, undefined, "Input.insertText", { text: it.insert });
      it.sent = p;
      p.then(() => { it.answeredAt = this.clock.now(); }, () => {});
      if (!it.e) p.catch((err) => this.keyError(page, st, err));
      return p;
    }
    const ev = it.ev, params = this.keyParams(page, st, it);
    const p = this.sendEvent(page, st, undefined, "Input.dispatchKeyEvent", params, it.pasteV ? "own" : it.vRoute);
    it.sent = p;
    if (it.pasteV) this.trackV(page, p, it.pasteV.via);
    p.then(() => { it.answeredAt = this.clock.now(); }, () => {});
    if (ev.type === "keyUp") st.keys.delete(ev.code);
    else if (!ev.repeat && (ev.type as string) !== "char") st.keys.set(ev.code, { at: this.clock.now(), params, own: !it.client });
    // An error of an event that no step waits for (an early-answered release, the stream's own Shift, a typed key): the
    // plan stops (C11, an error of an event); the next call of the plan gets the error.
    if (!it.e) p.catch((err) => this.keyError(page, st, err));
    return p;
  }

  /** An error of a key event that no client call waits for: the plan stops as at any error of an event. */
  private keyError(page: StagePage, st: TabState, err: unknown): void {
    const a = st.action;
    if (!a || a.over || st.gone) return;
    a.failBody = this.stopPlan(page, st, "Input.dispatchKeyEvent", err);
    if (!st.running) { this.freeTail(st); this.close(st, page.id); }
  }

  /** CDP's fields of a planned key event: the client's own params (with the modifiers down at its time), or a key of the stage's own. */
  private keyParams(page: StagePage, st: TabState, it: KeyItem): Record<string, unknown> {
    const ev = it.ev, timestamp = this.stamp(page, st);
    if (it.client) {
      const p = it.client;
      // The key that goes up is the one that is down (a Shift of the stream's own that the client took keeps its side).
      const which = ev.code !== p.code ? { key: ev.key, code: ev.code, windowsVirtualKeyCode: ev.keyCode, location: ev.location } : {};
      return { ...p, ...which, modifiers: ev.modifiers | (Number(p.modifiers ?? 0) & (ALT | CONTROL | META)), ...(ev.repeat ? { autoRepeat: true } : {}), timestamp };
    }
    const down = ev.type !== "keyUp";
    return {
      type: ev.type, modifiers: ev.modifiers, windowsVirtualKeyCode: ev.keyCode, code: ev.code, key: ev.key,
      ...(down ? { commands: it.typed?.commands ?? [] } : {}), ...(down && ev.text ? { text: ev.text, unmodifiedText: ev.text } : {}), ...(down ? { autoRepeat: false } : {}),
      location: ev.location, isKeypad: false, timestamp,
    };
  }

  /**
   * A key (C11, the keys and the text: a key run): a person's timing from the tab's key stream. A press goes at the later
   * of its arrival and its planned time, with a Shift press of the stream's own before a shifted character that comes with
   * no Shift (Playwright's capital or symbol) and the chord's times after a client's modifiers; its answer comes after its
   * keyDown. A release goes at the later of its arrival, the end of the key's planned hold and every planned release
   * before it; it is answered before it goes (the early answer) when the plan says that the next key can overlap. A click's
   * modifier goes up 60 to 200 ms after the mouse release. A `char` goes right after its key's press.
   */
  private async keyStep(page: StagePage, st: TabState, e: Entry): Promise<void> {
    const p = e.params;
    if (p.type === "keyUp" && (st.released.delete(`key:${p.code}`) || st.released.delete(`mod:${p.key}`)) && !st.keys.has(p.code)) { this.count("releasedAlready"); e.answer({ result: {} }); return; }
    if (st.runPlain) { this.count("plainKeys"); return this.plainStep(page, st, e); }
    const a = await this.begin(page, st);
    if (a.over) return this.endedEvent(page, st, e);
    const route = await this.pasteRoute(page, st, p, undefined);
    if (a.over) return this.endedEvent(page, st, e);
    st.runOpen = true;
    const s = this.stream(page, st), now = this.clock.now(), queued = Math.max(now, ...st.kq.map((x) => x.ev.t));
    let items: KeyItem[], early = false;
    if (p.type === "keyUp") {
      let at = queued;
      const down = st.keys.get(p.code);
      if (down && MODIFIER_KEYS.has(p.key) && st.releasedAt >= down.at) at = Math.max(at, st.releasedAt + modifierAfterMs(page.person, this.o.random));
      const r = s.release(keyOf(p, this.clientBits(st)), at);
      items = r.events.map((ev) => (ev.own ? { ev, typed: {} } : { ev, client: p, e }));
      early = r.early;
    } else if (p.type === "char") {
      items = [{ ev: { t: now, type: "char" as KeyEv["type"], key: String(p.key ?? ""), code: String(p.code ?? ""), keyCode: Number(p.windowsVirtualKeyCode ?? 0), location: 0, modifiers: this.clientBits(st), own: false }, client: p, e }];
    } else {
      const evs = s.next(keyOf(p, this.clientBits(st)), now);
      // A press of a Shift that is down already (the stream's own, which the client now holds): no event, and the key is the
      // client's now: the stage sends no release of its own for it (review-119 N2, P2).
      if (!evs.length) {
        for (const k of st.keys.values()) if (k.own && k.params.key === p.key) { k.own = false; k.merged = true; }
        this.count("keysDownAlready"); e.answer({ result: {} }); return;
      }
      items = evs.map((ev) => (ev.own ? { ev, typed: {} } : { ev, client: p, e }));
    }
    if (route) for (const x of items) if (x.e === e) x.vRoute = route;
    this.enqueue(st, items);
    const mine = items.find((x) => x.e === e)!;
    if (early) {
      // The early answer (C11, the answers): the release goes at its planned time, after the next key's press can come.
      mine.e = null;
      this.count("earlyReleases");
      e.answer({ result: {} });
      return;
    }
    if (!(await this.playKeys(page, st, a, mine))) return this.keyNotSent(page, st, a, e, items);
    const r = await this.settle(a, mine.sent!);
    if ("ended" in r) { this.answerWith(page, e, mine.sent!); return; }
    if (!r.ok) { if (p.type !== "keyUp") st.keys.delete(p.code); return this.fail(page, st, e, r.error); }
    e.answer({ result: r.value ?? {} });
  }

  /** The plan ended or failed before a key step's own event went: its events that did not go leave the queue; the call gets the plan's error, or goes as an event of an ended plan. */
  private keyNotSent(page: StagePage, st: TabState, a: Action, e: Entry, items: KeyItem[]): Promise<void> | void {
    st.kq = st.kq.filter((x) => !items.includes(x));
    if (a.failed) { e.answer({ error: a.failBody ?? { code: -32000, message: "the input stage stopped the plan at an error of an event" } }); return; }
    return this.endedEvent(page, st, e);
  }

  /** The keys of the stage's own (the focus click's caret), as a person types them: false when the plan ended or failed. */
  private async ownKeys(page: StagePage, st: TabState, a: Action, keys: Key[]): Promise<boolean> {
    const s = this.stream(page, st), mac = !this.linux();
    st.runOpen = true;
    for (const k of keys) {
      const commands = mac ? macCommands(k) : undefined;
      const press = s.next(k, Math.max(this.clock.now(), ...st.kq.map((x) => x.ev.t))).map((ev) => ({ ev, typed: ev.own ? {} : { commands } }));
      this.enqueue(st, press);
      if (!(await this.playKeys(page, st, a, press[press.length - 1]))) return false;
      const r = s.release(k, this.clock.now());
      const up = r.events.map((ev) => ({ ev, typed: {} }));
      this.enqueue(st, up);
      if (!r.early && !(await this.playKeys(page, st, a, up[up.length - 1]))) return false;
    }
    await this.endRun(page, st);
    return !a.over;
  }

  /**
   * The typing rule (C11, the keys and the text): a text whose typing plan at the person's speed fits in what is left of
   * the key run's STAGE_TYPE_MAX_MS is short (no fast end: the operator's answer on board item ab-2qb). A short text is
   * typed when each character has a key on the US layout (no line feed, no tab), the client holds no key (a held Shift
   * or Control would change the typed keys), and the focused element is an input of a text type or a textarea; else it
   * goes as it is. A long text goes as a person's paste when the paste rule
   * allows it (the operator's answer on board item ab-8fu), else as it is.
   */
  private async typingRule(page: StagePage, st: TabState, text: string): Promise<Rule> {
    if (!text) return { how: "asIs", why: "empty" };
    const left = STAGE_TYPE_MAX_MS - st.runSpent;
    // At the person's speed only (board item ab-2qb): no fast end.
    const plan = left > 0 ? typingPace(text, page.person, this.o.random, left, {}, false) : null;
    if (plan) {
      if ([...text].some((ch) => !charKey(ch))) return { how: "asIs", why: /[\n\t]/.test(text) ? "lineFeedOrTab" : "noUsKey" };
      if (this.clientKeysHeld(st)) return { how: "asIs", why: "keyHeld" };
      const f = await this.focused(page, st);
      if (!f) return { how: "asIs", why: "readFails" };
      if (!f.read.typing) return { how: "asIs", why: f.read.editable ? "contenteditable" : "notTextField" };
      return { how: "typed", plan, before: f.read, via: f.via };
    }
    const r = await this.pasteRule(page, st);
    if ("why" in r) return { how: "asIs", why: "tooLong", noPaste: r.why };
    return { how: "paste", before: r.before, via: r.via };
  }

  /**
   * The paste rule (C11, the paste): on Linux, with the clipboard of the service's own display, while no connection
   * holds a grant of the clipboard, while no earlier paste's V waits for its answer, while the client holds no key, while
   * the client's mark of a secret does not hold, into an input of a text type or a textarea (the typing rule's read of
   * the focused element) that is no field of a secret (board ab-t30.22). The reason when it does not hold.
   */
  private async pasteRule(page: StagePage, st: TabState): Promise<{ before: FocusRead; via: FocusVia } | { why: string; secret?: { before: FocusRead; via: FocusVia } }> {
    if (!this.linux()) return { why: "mac" };
    if (!this.clipboard) return { why: "noClipboard" };
    if (page.clipboardGranted?.()) return { why: "clipboardGrant" };
    // An earlier paste's V in the closed set (review-126 B4, board ab-t30.21), or after an error answer (review-126b note 2): its page can still read the selection.
    if (this.vPending()) return { why: "vPending" };
    if (this.clientKeysHeld(st)) return { why: "keyHeld" };
    const f = await this.focused(page, st);
    if (!f) return { why: "readFails" };
    if (!f.read.typing) return { why: f.read.editable ? "contenteditable" : "notTextField" };
    // A secret never goes through the clipboard (board ab-t30.22): the field rule (rule 7), then the client's mark (rule
    // 8), after rule 5 (review-129 B1), with the field's read for the secret's own path.
    if (secretField(f.read)) return { why: "secretField", secret: { before: f.read, via: f.via } };
    if (st.secret) return { why: "secretMark", secret: { before: f.read, via: f.via } };
    return { before: f.read, via: f.via };
  }

  /**
   * The typing rule's read of the focused element: in the stage's own isolated world on the top page; when the focus is
   * in a cross-origin frame, on that frame's own session, on a node of it that the client's calls named (Playwright's
   * utility world on that handle). Null when no read gives it.
   */
  private async focused(page: StagePage, st: TabState, via?: FocusVia): Promise<{ read: FocusRead; via: FocusVia } | null> {
    if (via === undefined) {
      const top = await this.read(page.ownRead(FOCUSED_FIELD, []));
      if (top === TIMEOUT) return null;
      if (!top || !(top as any).frame) return top ? { read: top as FocusRead, via: null } : null;
    }
    const nodes: [string, string][] = via ? [[via.child, via.node]] : [];
    if (!via) {
      if (st.field?.child) nodes.push([st.field.child, st.field.node]);
      for (const [c, n] of [...st.childNodes].reverse()) if (!nodes.some(([x, y]) => x === c && y === n)) nodes.push([c, n]);
    }
    for (const [child, node] of nodes.slice(0, 4)) {
      const r = await this.read(page.send(child, "Runtime.callFunctionOn", { objectId: node, functionDeclaration: FOCUSED_IN, returnByValue: true }));
      const v = r === TIMEOUT ? null : (r as any)?.result?.value;
      if (v && !v.away && !v.frame) return { read: v as FocusRead, via: { child, node } };
    }
    return null;
  }

  /** The field's value after a text in place of its selection (fill's script selected all of it: the text), or null when the read gave no selection. */
  private wantOf(before: FocusRead, text: string, fill: boolean): string | null {
    // An input turns each line break of an inserted or pasted text into a space (measured: board ab-t30.19's probe).
    const t = before.tag === "input" ? text.replace(/\r\n|\r|\n/g, " ") : text;
    if (fill) return t;
    return typeof before.s === "number" && typeof before.e === "number" && before.value !== null ? before.value.slice(0, before.s) + t + before.value.slice(before.e) : null;
  }

  /**
   * Input.insertText (C11, the keys and the text): typed keys when the typing rule allows them, a person's paste for a
   * long text when the paste rule allows it, else the text as it is, after one person's time from one press to the next.
   * The stream's own Shift goes up first. Typed keys follow the plan of the typing rule's pace at its own times (so the
   * plan's time is the time that the rule checked); the call is answered after the plan's last event. After the last key
   * the stage reads the field's value: when it is not the text in place of the selection, it logs and counts it, and it
   * does not repair the field (the named exception).
   */
  private async textStep(page: StagePage, st: TabState, e: Entry): Promise<void> {
    const text = typeof e.params.text === "string" ? e.params.text : "";
    if (st.runPlain) { this.count("plainKeys"); return this.plainStep(page, st, e); }
    const a = await this.begin(page, st);
    if (a.over) return this.endedEvent(page, st, e);
    st.runOpen = true;
    const s = this.stream(page, st), fill = st.fillNext;
    st.fillNext = false;
    const rule = await this.typingRule(page, st, text);
    if (a.over) return this.endedEvent(page, st, e);
    const ins = s.insert(Math.max(this.clock.now(), ...st.kq.map((x) => x.ev.t)));
    const pre = ins.events.map((ev) => ({ ev, typed: {} }));
    this.enqueue(st, pre);
    // Every planned event of the run goes first: an early-answered release, the stream's own Shift (review-119 B1).
    if (st.kq.length && !(await this.playKeys(page, st, a, st.kq[st.kq.length - 1]))) return this.keyNotSent(page, st, a, e, pre);
    if (rule.how === "typed") return this.typeText(page, st, a, { e, text, plan: rule.plan, via: rule.via, t0: ins.t, want: this.wantOf(rule.before, text, fill) });
    if (rule.how === "paste") return this.pasteText(page, st, a, { e, text, via: rule.via, t0: ins.t, before: rule.before, want: this.wantOf(rule.before, text, fill), fallback: null });
    // The text as it is (C11, the cases of no change: a text that the typing rule refuses; a long text with no paste).
    this.count("textAsIs"); this.count(`textAsIs:${rule.why}`);
    if (rule.noPaste) this.count(`noPaste:${rule.noPaste}`);
    if (this.o.trace) this.o.log(`relay: the input stage: tab ${page.id}: a text as it is (${rule.why}${rule.noPaste ? `, no paste: ${rule.noPaste}` : ""})`);
    await this.until(a, ins.t);
    if (a.over) return this.endedEvent(page, st, e);
    const pr = this.sendEvent(page, st, undefined, e.method, { ...e.params });
    s.after(this.clock.now());
    const r = await this.settle(a, pr);
    if ("ended" in r) { this.answerWith(page, e, pr); return; }
    if (!r.ok) return this.fail(page, st, e, r.error);
    e.answer({ result: r.value ?? {} });
  }

  /**
   * Typed keys of a text (C11, the typing rule; the typed part of a key run): the plan's events at their own times from
   * `t0`, and its characters with no US key (a part of a key run) as Input.insertText at theirs. The call is answered
   * after Chrome answered the plan's events. With `want` (fill and keyboard.insertText), the named exception's check.
   */
  private async typeText(page: StagePage, st: TabState, a: Action, o: { e: Entry; text: string; plan: ReturnType<typeof typingPace> & {}; via: FocusVia; t0: number; want: string | null; part?: boolean }): Promise<void> {
    const s = this.stream(page, st), e = o.e;
    this.count(o.part ? "typedParts" : "typedTexts");
    if (this.o.trace) this.o.log(`relay: the input stage: tab ${page.id}: typed keys (${o.part ? "a collected part, " : ""}${Math.round(o.plan.plan.ms)} ms)`);
    const mac = !this.linux(), noKey = [...o.text].filter((ch) => !charKey(ch));
    const items: KeyItem[] = [
      ...o.plan.plan.events.map((ev) => ({ ev: { ...ev, t: ev.t + o.t0 }, typed: { commands: mac && !ev.own ? [] : undefined } })),
      ...o.plan.plan.inserts.map((t, i) => ({ ev: { t: t + o.t0, type: "keyDown" as const, key: "", code: "", keyCode: 0, location: 0, modifiers: 0, own: false }, insert: noKey[i], typed: {} })),
    ].sort((x, y) => x.ev.t - y.ev.t);
    this.enqueue(st, items);
    const last = items[items.length - 1], typing = (st.typing = { navigated: false });
    const played = await this.playKeys(page, st, a, last, () => typing.navigated);
    if (st.typing === typing) st.typing = null;
    if (!played) return this.typedEnded(page, st, a, e, o.text, items, typing.navigated, o.via);
    s.after(Math.max(...items.filter((x) => x.ev.type !== "keyUp").map((x) => x.ev.t)));
    // The answer after Chrome answered the plan's events (they went at their times, none awaited before the next).
    const r = await this.settle(a, Promise.all(items.map((x) => x.sent!)));
    if ("ended" in r) { this.answerWith(page, e, Promise.all(items.map((x) => x.sent!)).then(() => ({}))); return; }
    if (!r.ok) return this.fail(page, st, e, r.error);
    // The named exception (C11, the typing rule): the field's value after the last key, against the text in place of the selection.
    if (o.want !== null) {
      const after = await this.focused(page, st, o.via ?? undefined);
      if (after && after.read.value !== null && after.read.value !== o.want) {
        this.count("typedValueDiffers");
        this.o.log(`relay: the input stage: tab ${page.id}: the value of a field after its typed keys is not the text in place of its selection (a key handler of the page: C11's named exception); the stage does not repair it`);
      }
    }
    e.answer({ result: {} });
  }

  /** The clipboard leaves the paste's text at once (every end of the paste's plan, and its keyDown's answer). */
  private unpaste(st: TabState): void { if (st.pasting) { st.pasting = false; this.clipboard?.clear(); } }

  /**
   * A person's paste of a text (C11, the paste): after one person's time from one press to the next (from `t0`), the
   * text on the clipboard of the service's own display, then Control+V with a person's timing (the chord's times), the
   * clipboard given up at once at the answer of V's keyDown (Chrome read it in that key's default action), the releases.
   * Then the field's value: the text in place of its selection is a paste; the field's old value is a refusal (a page's
   * paste or beforeinput handler that prevents it), and the text goes as Playwright's own input (`fallback`: the client's
   * own keys of a collected part, else the client's Input.insertText); another value is counted, with no repair.
   */
  private async pasteText(page: StagePage, st: TabState, a: Action, o: PasteJob): Promise<void> {
    const clip = this.clipboard!, s = this.stream(page, st);
    await this.until(a, o.t0);
    if (a.over) return this.pasteEnded(page, st, a, o, [], false);
    const chord = s.next(PASTE_KEY, this.clock.now()), vDown = chord[chord.length - 1];
    const up = s.release(PASTE_KEY, vDown.t);
    const items: KeyItem[] = [...chord, ...up.events].map((ev) => ({ ev, typed: {} }));
    this.enqueue(st, items);
    const v = items.find((x) => x.ev === vDown)!, typing = (st.typing = { navigated: false });
    v.pasteV = { via: o.via ?? null };
    // Control first; the text goes on the clipboard only at V's time (Chrome asks for it after V's keyDown: measured).
    let played = chord.length < 2 || (await this.playKeys(page, st, a, items[chord.length - 2], () => typing.navigated));
    if (played) await this.until(a, vDown.t);
    if (!played || a.over || typing.navigated) { if (st.typing === typing) st.typing = null; return this.pasteEnded(page, st, a, o, items, typing.navigated); }
    // The field again at V's time, after the gap and before the clipboard's hold (review-129 bar 1, review-129b B1): a
    // page can change the field after the paste rule's read. (The client's mark cannot change here: it is a step of the
    // tab's gate.) The read can make V late by its limit; the hold and V's send stay after it.
    const again = await this.focused(page, st, o.via ?? undefined);
    if (a.over || typing.navigated) { if (st.typing === typing) st.typing = null; return this.pasteEnded(page, st, a, o, items, typing.navigated); }
    // A field of a secret now gets no paste, and the text goes as for a secret; a field that is no text field (or no
    // read) gets Playwright's own input. V does not go, and the chord's Control goes up at its time.
    const changed = !again || !again.read.typing ? "notTextField" : secretField(again.read) ? "secretField" : null;
    if (changed) {
      if (st.typing === typing) st.typing = null;
      this.count(`pasteFieldChanged:${changed}`);
      this.o.log(`relay: the input stage: tab ${page.id}: the field changed before V (${changed}); the text goes with no paste`);
      st.kq = st.kq.filter((x) => x.ev.code !== "KeyV" || !items.includes(x));
      const ctrlUp = items.filter((x) => x.ev.code !== "KeyV" && x.ev.type === "keyUp").at(-1);
      if (ctrlUp && !(await this.playKeys(page, st, a, ctrlUp))) return this.pasteEnded(page, st, a, o, items, false);
      return again && changed !== "notTextField" ? this.secretText(page, st, a, { ...o, before: again.read, via: again.via, want: this.wantOf(again.read, o.text, false) }) : this.ownInput(page, st, a, o);
    }
    // The read after V's answer goes where the field is at V's time (board ab-t30.21).
    v.pasteV = { via: again!.via };
    // No text goes on the clipboard while an earlier paste's V is in the closed set: that page can still read the selection.
    const vOpen = this.vPending();
    st.pasting = !vOpen;
    let ok = false;
    const holding = vOpen ? Promise.resolve() : clip.hold(o.text).then((x) => { ok = x; }, () => {});
    const inTime = await this.within(holding, CLIPBOARD_HOLD_MS);
    if (vOpen || !inTime || !ok || a.over || !st.pasting) {
      this.unpaste(st); clip.clear();
      if (st.typing === typing) st.typing = null;
      if (a.over) return this.pasteEnded(page, st, a, o, items, typing.navigated);
      this.count(vOpen ? "pasteVPending" : "pasteHoldFails");
      this.o.log(vOpen ? `relay: the input stage: tab ${page.id}: the paste path is closed (an earlier paste's V or its read has no answer yet, or an error, the read's limit or a tab's end keeps it closed); the text goes as Playwright's own input`
        : `relay: the input stage: tab ${page.id}: the clipboard did not take the text${inTime ? "" : ` in ${CLIPBOARD_HOLD_MS} ms`}; the text goes as Playwright's own input`);
      // V does not go; the chord's Control goes up at its time, then Playwright's own input of the text.
      st.kq = st.kq.filter((x) => x.ev.code !== "KeyV" || !items.includes(x));
      const ctrlUp = items.filter((x) => x.ev.code !== "KeyV" && x.ev.type === "keyUp").at(-1);
      if (ctrlUp && !(await this.playKeys(page, st, a, ctrlUp))) return this.pasteEnded(page, st, a, o, items, false);
      return this.ownInput(page, st, a, o);
    }
    played = await this.playKeys(page, st, a, v, () => typing.navigated);
    // Chrome read the clipboard in V's keyDown: the selection goes at once, also when the plan ended.
    if (played) await this.settle(a, v.sent!);
    this.unpaste(st);
    if (played && !a.over && !typing.navigated) played = await this.playKeys(page, st, a, items[items.length - 1], () => typing.navigated);
    if (st.typing === typing) st.typing = null;
    if (!played || a.over || typing.navigated) return this.pasteEnded(page, st, a, o, items, typing.navigated);
    const r = await this.settle(a, Promise.all(items.map((x) => x.sent!)));
    if ("ended" in r) return this.pasteEnded(page, st, a, o, items, false);
    if (!r.ok) return this.fail(page, st, o.e, r.error);
    s.after(vDown.t);
    const after = await this.focused(page, st, o.via ?? undefined);
    const got = after?.read.value ?? null;
    if (got === null) { this.count("pastesUnread"); o.e.answer({ result: {} }); return; }
    if (o.want !== null ? got === o.want : got !== o.before.value) {
      this.count(o.fallback ? "pastedParts" : "pastes");
      if (this.o.trace) this.o.log(`relay: the input stage: tab ${page.id}: a paste (${o.fallback ? "a collected part" : "a text"}, ${[...o.text].length} characters)`);
      o.e.answer({ result: {} });
      return;
    }
    if (got === o.before.value) {
      this.count("pastesRefused");
      this.o.log(`relay: the input stage: tab ${page.id}: the page refused a paste (the field's value did not change); the text goes as Playwright's own input`);
      return this.ownInput(page, st, a, o);
    }
    this.count("pasteValueDiffers");
    this.o.log(`relay: the input stage: tab ${page.id}: the value of a field after a paste is not the text in place of its selection (a paste handler of the page); the stage does not repair it`);
    o.e.answer({ result: {} });
  }

  /**
   * A secret's long text (C11, the paste, rules 7 and 8; board ab-t30.22): never the clipboard. A fill's or a
   * keyboard.insertText's text is the client's own Input.insertText (ownInput: its result is the client's). A collected
   * part (`fallback`) goes as one Input.insertText of its text, as a password manager's fill does; then the field's value:
   * when the field did not take the text (its old value, and not `want`, the value that the text gives in place of the
   * selection), the part goes as the client's own keys, counted (review-129 note 1, review-129b N2).
   */
  private async secretText(page: StagePage, st: TabState, a: Action, o: PasteJob): Promise<void> {
    if (!o.fallback) return this.ownInput(page, st, a, o);
    const pr = this.sendEvent(page, st, undefined, "Input.insertText", { text: o.text });
    this.stream(page, st).after(this.clock.now());
    const r = await this.settle(a, pr);
    if ("ended" in r) { this.answerWith(page, o.e, pr); return; }
    if (!r.ok) return this.fail(page, st, o.e, r.error);
    // Its old value, and not the value that the text gives in place of the selection (review-129b N2: a part that
    // replaces a selection with the same text took it).
    const after = await this.focused(page, st, o.via ?? undefined);
    if (after && after.read.value === o.before.value && after.read.value !== o.want && !a.over) {
      this.count("secretPartsRefused");
      this.o.log(`relay: the input stage: tab ${page.id}: a field did not take a secret's text (its value did not change); the part goes as the client's own keys`);
      return this.partKeys(page, st, a, o.fallback, o.e);
    }
    o.e.answer({ result: r.value ?? {} });
  }

  /** The text as Playwright's own input (a paste that did not go): the client's Input.insertText, or the client's own keys of a collected part. */
  private async ownInput(page: StagePage, st: TabState, a: Action, o: PasteJob): Promise<void> {
    if (o.fallback) return this.partKeys(page, st, a, o.fallback, o.e);
    const pr = this.sendEvent(page, st, undefined, "Input.insertText", { ...o.e.params, text: o.text });
    const r = await this.settle(a, pr);
    if ("ended" in r) { this.answerWith(page, o.e, pr); return; }
    if (!r.ok) return this.fail(page, st, o.e, r.error);
    o.e.answer({ result: r.value ?? {} });
  }

  /**
   * The end of a paste's plan before its last event (a dialog, STAGE_EVENT_WAIT_MS, STAGE_ACTION_MAX_MS, a navigation of
   * the main frame, the end of the tab or of the session; C11, the paste). The clipboard gave up the text at the end. At
   * STAGE_EVENT_WAIT_MS and at the limit the stage waits for Chrome's answers, with the lock free, for at most one more
   * STAGE_EVENT_WAIT_MS. After the dialog's close, with the lock taken again (and the activation), the release of each
   * key of the plan that is down; then the field's value: the text in place of its selection is a paste; else, while the
   * field still has the focus, the text goes as Playwright's own input of an ended plan; else (and at a navigation) none
   * goes, and the call gets an error that names the end and the count.
   */
  private async pasteEnded(page: StagePage, st: TabState, a: Action, o: PasteJob, items: KeyItem[], navigated: boolean): Promise<void> {
    st.kq = st.kq.filter((x) => !items.includes(x));
    this.unpaste(st);
    if (a.failed) { o.e.answer({ error: a.failBody ?? { code: -32000, message: "the input stage stopped the plan at an error of an event" } }); return; }
    this.count("pastesEnded");
    const n = [...o.text].length;
    const why = navigated ? "a navigation of the main frame" : a.ended === "dialog" ? "a dialog" : a.ended === "wait" ? `no answer in ${STAGE_EVENT_WAIT_MS} ms` : a.ended === "limit" ? `the limit of ${STAGE_ACTION_MAX_MS} ms` : "the end of the tab";
    const sent = items.filter((x) => x.sent).map((x) => x.sent!.catch(() => {}));
    if (!navigated && (a.ended === "wait" || a.ended === "limit") && !(await this.within(Promise.all(sent), STAGE_EVENT_WAIT_MS))) {
      if (st.gone === "session") return;
      this.count("pastesUnanswered");
      o.e.answer({ error: { code: -32000, message: `The input stage ended a pasted text at ${why}, and ${n} characters may not have gone: the page did not answer.` } });
      return;
    }
    if (a.over) await this.dialogGone(st);
    if (st.gone === "session") return;
    // An ended plan's lock again (the order of arrival), with the activation; a navigation alone does not end the plan.
    if (a.over) await this.retake(page, st, !navigated);
    const codes = new Set(items.filter((x) => x.ev.type === "keyUp" && !x.sent).map((x) => x.ev.code));
    for (const code of codes) {
      const k = st.keys.get(code);
      if (k?.own) sent.push(this.sendKey(page, st, { ev: { t: 0, type: "keyUp", key: k.params.key, code, keyCode: k.params.windowsVirtualKeyCode, location: k.params.location ?? 0, modifiers: 0, own: true }, typed: {} }).catch(() => {}));
    }
    if (st.heldGone) { o.e.answer({ error: st.heldGone }); return; }
    const after = navigated || st.gone ? null : await this.focused(page, st, o.via ?? undefined);
    const got = after?.read.value ?? null;
    if (got !== null && (o.want !== null ? got === o.want : got !== o.before.value)) { this.answerWith(page, o.e, Promise.all(sent).then(() => ({}))); return; }
    // At a flush with no lock of the part's own, no focus check (review-126b R1): the rest goes where the page's focus is.
    const still = !navigated && !st.gone && got === o.before.value && (this.flushNoLock(st) || (await this.stillFocused(page, o.via)));
    if (!still) {
      this.count("pastesCut");
      await this.within(Promise.all(sent), STAGE_EVENT_WAIT_MS);
      o.e.answer({ error: { code: -32000, message: `The input stage ended a pasted text at ${why}, and ${n} characters did not go: ${navigated ? "the page navigated" : "the field no longer has the focus"}.` } });
      return;
    }
    // At a flush (a close of the tab, its session's end) partKeys sends the rest as one Input.insertText (STAGE_FLUSH_MS).
    if (o.fallback) return this.partKeys(page, st, a, o.fallback, o.e);
    const r = await this.endedSend(page, st, o.e, { ...o.e.params, text: o.text });
    if (r) this.answerWith(page, o.e, r.sent);
  }

  // ---------------------------------------------------------------- the collected keys (board ab-t30.19)

  /**
   * Whether a call joins the tab's collected part (C11, the collected keys): a keyDown of one printable character with a
   * key on the US layout (its `key` is its `text`; no modifiers, no auto-repeat, no editing command) while the client
   * holds no key and no collected key is down; the keyUp of the collected key that is down; an Input.insertText of a
   * text while a part is open and no collected key is down. Never on a frame's session; also after the run's
   * STAGE_TYPE_MAX_MS (review-126 B5).
   */
  private joins(st: TabState, e: Entry): boolean {
    if (e.ended || e.failedWith || st.gone || e.child) return false;
    const p = e.params, c = st.col;
    if (e.kind === "text") return !!c && !c.down && typeof p.text === "string" && p.text !== "";
    if (e.kind !== "key") return false;
    if (p.type === "keyUp") return !!c?.down && c.down.down.code === p.code;
    return p.type === "keyDown" && (!c || !c.down) && typeof p.text === "string" && [...p.text].length === 1 && !!charKey(p.text) && p.key === p.text
      && !Number(p.modifiers ?? 0) && !p.autoRepeat && !(Array.isArray(p.commands) && p.commands.length) && !this.clientKeysHeld(st) && !st.keys.has(String(p.code));
  }

  /**
   * A call of the collected part (C11, the collected keys): its answer at once, with no event (the new exception to "no
   * answer before its events"). The first call opens the part. An open action (Playwright's focus call and its click)
   * stays: the part goes in it; with none, the part takes the lock at its end.
   */
  private collect(page: StagePage, st: TabState, e: Entry): void {
    const p = e.params, now = this.clock.now();
    if (!st.col) {
      st.col = { items: [], down: null, lastAt: now, holdMin: Infinity };
      st.runOpen = true;
      this.count("collectedParts");
    }
    const c = st.col;
    if (e.kind === "text") c.items.push({ text: p.text, params: p });
    else if (p.type === "keyDown") { const it = { ch: String(p.text), down: p, downAt: now }; c.items.push(it); c.down = it; }
    else { c.down!.up = p; c.holdMin = Math.min(c.holdMin, now - c.down!.downAt); c.down = null; }
    c.lastAt = now;
    this.count("collectedCalls");
    e.answer({ result: {} });
  }

  /** RUN_IDLE_MS after the part's last call, in the tab's gate: the part goes (a newer call moved its time: the timer again). */
  private async partAtGap(page: StagePage, st: TabState): Promise<void> {
    if (st.running || st.gone || !st.col) return;
    if (this.clock.now() - st.col.lastAt < RUN_IDLE_MS - 1) { this.kick(page, st); return; }
    st.running = true;
    this.stopKeyTimer(st);
    try { await this.endPart(page, st); } catch (err) { this.o.log(`relay: the input stage: a collected part of tab ${page.id} failed: ${(err as Error).message}`); }
    finally { st.running = false; await this.afterStep(page, st); }
  }

  /**
   * The end of the collected part (C11, the collected keys): at the tab's next call that does not join it (also a call
   * that the stage does not take, and a key with no text, Enter or Tab), or RUN_IDLE_MS after its last call. The part's
   * text goes typed or pasted; a collected key whose keyUp has not come goes after it as the client's own press, which
   * stays down until the client's keyUp. Its time counts in the run's time with a person's timing.
   */
  private async endPart(page: StagePage, st: TabState): Promise<void> {
    const c = st.col;
    st.col = null;
    if (!c) return;
    const t0 = this.clock.now(), items = c.down ? c.items.slice(0, -1) : c.items;
    st.parting = true;
    try {
      if (items.length) { await this.part(page, st, items, c.holdMin); await this.settleAction(page, st); }
      if (c.down && !st.gone) { await this.downAfterPart(page, st, c.down); await this.settleAction(page, st); }
    } finally { st.parting = false; st.runSpent += this.clock.now() - t0; this.budget(page, st); }
  }

  /**
   * After a part's plan (review-126 B1): an ended or failed action of the part is finished before the tab's next call (its
   * releases, the lock that its ended events took again, the action's close), so that no call of the tab waits for the
   * tab's own lock. A live action goes on (the tab's next key is in it).
   */
  private async settleAction(page: StagePage, st: TabState): Promise<void> {
    const a = st.action;
    if (!a) { this.freeTail(st); return; }
    if (a.over) await this.finish(page, st, a);
  }

  /** A client call's stand-in for a collected part: no client call waits for it, so an error goes to the log and the counts (no text). */
  private partEntry(page: StagePage, st: TabState, text: string): Entry {
    return { child: undefined, method: "Input.insertText", params: { text }, kind: "text", util: null, st,
      answer: (body) => { if (body.error) { this.count("partErrors"); this.o.log(`relay: the input stage: tab ${page.id}: a collected part of a key run: ${body.error.message}`); } } };
  }

  /**
   * The collected part's text (C11, the collected keys): typed when its typing plan fits in what is left of the run's
   * STAGE_TYPE_MAX_MS (each hold at least the client's least hold: a client's delay), else a person's paste when the
   * paste rule allows it, else one Input.insertText of its text for a secret (the field rule and the client's mark:
   * board ab-t30.22), else the client's own keys at once (Playwright's own input). Its events go after the run's
   * planned events, under the lock, with the activation.
   */
  private async part(page: StagePage, st: TabState, items: ColItem[], holdMin: number): Promise<void> {
    const text = textOf(items), e = this.partEntry(page, st, text);
    const a = await this.begin(page, st);
    if (a.over) return this.partKeys(page, st, a, items, e);
    st.runOpen = true;
    // After the run's STAGE_TYPE_MAX_MS (review-126 B5): the part as the client's own keys at once, with no person's timing.
    if (st.runPlain) { this.count("partsAsKeys"); this.count("partsAsKeys:budget"); return this.partKeys(page, st, a, items, e); }
    const s = this.stream(page, st), H = page.person.params.keys.holdMs as { min?: number; max?: number };
    const lo = H.min ?? 50, hi = H.max ?? 250;
    const opts: StreamOptions = Number.isFinite(holdMin) && holdMin > lo ? { holdMs: [holdMin, Math.max(holdMin, hi)] } : {};
    const left = STAGE_TYPE_MAX_MS - st.runSpent;
    const plan = left > 0 ? typingPace(text, page.person, this.o.random, left, opts, false) : null;
    const typedVia = plan ? await this.focused(page, st) : null;
    const rule = plan ? null : await this.pasteRule(page, st);
    if (a.over) return this.partKeys(page, st, a, items, e);
    const ins = s.insert(Math.max(this.clock.now(), ...st.kq.map((x) => x.ev.t)));
    this.enqueue(st, ins.events.map((ev) => ({ ev, typed: {} })));
    if (st.kq.length && !(await this.playKeys(page, st, a, st.kq[st.kq.length - 1]))) return this.partKeys(page, st, a, items, e);
    if (plan) return this.typeText(page, st, a, { e, text, plan, via: typedVia?.via ?? null, t0: ins.t, want: null, part: true });
    if (rule && !("why" in rule)) return this.pasteText(page, st, a, { e, text, via: rule.via, t0: ins.t, before: rule.before, want: this.wantOf(rule.before, text, false), fallback: items });
    const why = rule && "why" in rule ? rule.why : "noPlan";
    // A secret (board ab-t30.22: the field rule, the client's mark): one Input.insertText of the part's text, as a
    // password manager's fill does, in place of its key events.
    if (rule && "secret" in rule && rule.secret) {
      this.count("partsAsText"); this.count(`partsAsText:${why}`);
      if (this.o.trace) this.o.log(`relay: the input stage: tab ${page.id}: a collected part as one Input.insertText (${why})`);
      await this.until(a, ins.t);
      if (a.over) return this.partKeys(page, st, a, items, e);
      return this.secretText(page, st, a, { e, text, via: rule.secret.via, t0: ins.t, before: rule.secret.before, want: this.wantOf(rule.secret.before, text, false), fallback: items });
    }
    this.count("partsAsKeys"); this.count(`partsAsKeys:${why}`);
    if (this.o.trace) this.o.log(`relay: the input stage: tab ${page.id}: a collected part as the client's own keys (${why})`);
    await this.until(a, ins.t);
    return this.partKeys(page, st, a, items, e);
  }

  /**
   * The client's own events of a collected part (Playwright's own input; C11, the collected keys): each keyDown and keyUp
   * and each Input.insertText as the client sent it, with the stage's timestamp, in order, at most PLAIN_IN_FLIGHT without
   * an answer. When the plan ends (dialogs, above), the rest goes as the events of an ended plan: after the dialog's close,
   * with the lock taken again, at once; at a navigation of the main frame and at a session's end none goes. At a dialog
   * Chrome drops each input event that it gets while the dialog is open (review-119 N4): the events after the first one
   * that has no answer at the plan's end (the one that opened the dialog) go again after the close. After the end each
   * wait for Chrome's answers has the limit STAGE_EVENT_WAIT_MS, and an error of an event or a page that does not answer
   * stops the rest (review-126 B2). The part's answer (to the log) comes after Chrome's answers, or after
   * STAGE_EVENT_WAIT_MS when they do not come.
   */
  private async partKeys(page: StagePage, st: TabState, a: Action, items: ColItem[], e: Entry): Promise<void> {
    const evs: [string, any][] = [];
    for (const it of items) if ("text" in it) evs.push(["Input.insertText", it.params]); else { evs.push(["Input.dispatchKeyEvent", it.down]); if (it.up) evs.push(["Input.dispatchKeyEvent", it.up]); }
    const flight = new Set<Promise<unknown>>(), all: Promise<unknown>[] = [], nav0 = st.navs, answeredAt: number[] = [];
    let resumed = false, cut = 0, i = 0, broke: unknown = null, stalled = false;
    for (;;) {
      // The tab's or the session's end, an error of an event, a navigation: no more of the part's events (review-126 B2).
      if (st.gone || broke !== null || st.navs !== nav0) { cut = evs.length - i; break; }
      if (a.over && !resumed) {
        if (a.failed) { cut = evs.length - i; break; }
        if (a.ended === "dialog") {
          // The events after the first one with no answer at the end (the one that opened the dialog) were dropped.
          let held = 0;
          while (held < i && answeredAt[held] !== undefined && answeredAt[held] <= a.endedAt) held++;
          if (held + 1 < i) { this.count("partKeysAgain", i - held - 1); i = held + 1; }
        }
        resumed = true;
        if (i < evs.length) {
          await this.dialogGone(st);
          if (st.gone || st.heldGone || st.navs !== nav0) { cut = evs.length - i; break; }
          await this.retake(page, st, true);
          if (st.gone) { cut = evs.length - i; break; }
        }
      }
      // A flush (a close of the tab, the end of its client's last session: review-126 B3): the release of a key whose
      // press went, then the rest of the part's text as one Input.insertText, so that it goes within STAGE_FLUSH_MS.
      if (st.flushing && i < evs.length) {
        const [m0, p0] = evs[i];
        if (m0 === "Input.dispatchKeyEvent" && p0.type === "keyUp") { all.push(this.sendEvent(page, st, undefined, m0, { ...p0, timestamp: this.stamp(page, st) }).catch(() => {})); st.keys.delete(String(p0.code)); i++; }
        const rest = evs.slice(i).filter(([m, p]) => m === "Input.insertText" || p.type !== "keyUp").map(([, p]) => String(p.text ?? "")).join("");
        if (rest) { const pr = this.sendEvent(page, st, undefined, "Input.insertText", { text: rest }); all.push(pr.then(() => {}, (err) => { broke ??= err; })); }
        this.count("partKeysFlushed");
        i = evs.length;
        continue;
      }
      if (i >= evs.length) {
        // The last answers, within STAGE_EVENT_WAIT_MS; a plan's end in that time (a dialog) sends the dropped events again.
        await this.within(Promise.race([Promise.all(all), ...(resumed ? [] : [a.endSignal])]), STAGE_EVENT_WAIT_MS);
        if (a.over && !resumed) continue;
        break;
      }
      if (flight.size >= PLAIN_IN_FLIGHT) {
        // Each wait for Chrome's answers has the limit STAGE_EVENT_WAIT_MS: before the plan's end its watchdog ends the
        // plan; after it, a page that does not answer stops the rest.
        const answered = await this.within(Promise.race([...flight, ...(resumed ? [] : [a.endSignal])]), STAGE_EVENT_WAIT_MS);
        if (!answered && resumed) { stalled = true; cut = evs.length - i; break; }
        continue;
      }
      const k = i, [method, p] = evs[i++];
      const params = method === "Input.insertText" ? { ...p } : { ...p, timestamp: this.stamp(page, st) };
      const pr = this.sendEvent(page, st, undefined, method, params);
      delete answeredAt[k];
      pr.then(() => { answeredAt[k] = this.clock.now(); }, () => {});
      if (method === "Input.dispatchKeyEvent") { if (p.type === "keyUp") st.keys.delete(String(p.code)); else st.keys.set(String(p.code), { at: this.clock.now(), params: p }); }
      // An error stops the plan: before its end as any error of an event; after it, here (the end has no plan to stop).
      const done = pr.then(() => {}, (err) => { if (!a.over) this.keyError(page, st, err); else broke ??= err; });
      flight.add(done); void done.then(() => flight.delete(done));
      all.push(done);
    }
    if (cut || a.failed || broke !== null) {
      // The keys that the part holds go up (an error or a page that does not answer: Chrome gives them when it can).
      if ((broke !== null || stalled) && !st.gone) this.releaseHeld(page, st);
      this.count("partKeysCut");
      e.answer({ error: { code: -32000, message: `The input stage ended a collected part of a key run, and ${cut} of its key events did not go: ${a.failed || broke !== null ? "an error of an event" : stalled ? "the page did not answer" : st.gone ? "the end of the tab or of the session" : "the page navigated"}.` } });
      return;
    }
    e.answer({ result: {} });
  }

  /** A collected key whose keyUp had not come at the part's end: the client's own press, with a person's timing, down until the client's keyUp. */
  private async downAfterPart(page: StagePage, st: TabState, it: ColItem & { down: any }): Promise<void> {
    const a = await this.begin(page, st), p = it.down;
    if (a.over) { await this.endedEvent(page, st, { ...this.partEntry(page, st, ""), method: "Input.dispatchKeyEvent", params: p, kind: "key" }); return; }
    st.runOpen = true;
    const s = this.stream(page, st);
    const evs = s.next(keyOf(p, this.clientBits(st)), Math.max(this.clock.now(), ...st.kq.map((x) => x.ev.t)));
    if (!evs.length) return;
    const ks: KeyItem[] = evs.map((ev) => (ev.own ? { ev, typed: {} } : { ev, client: p, e: null }));
    this.enqueue(st, ks);
    await this.playKeys(page, st, a, ks[ks.length - 1]);
  }

  /**
   * The end of a typed text's plan before its last event (a dialog, STAGE_EVENT_WAIT_MS, STAGE_ACTION_MAX_MS, a navigation
   * of the main frame; C11, the keys and the text). A character is typed when its keyDown reached the page. At a dialog
   * Chrome drops each input event that it gets while the dialog is open, so a keyDown sent after the first event that has
   * no answer at the end did not (review-119 N4). At STAGE_EVENT_WAIT_MS and at the limit Chrome queues the events of a
   * busy page and gives them later: the stage waits for Chrome's answers of the sent events, and each sent keyDown is
   * typed (review-119b R3); the wait has a bound of one more STAGE_EVENT_WAIT_MS, and at its end no character of the rest
   * goes and the call gets an error (the daemon lead's point). After the dialog's close, with the lock taken again in the order of arrival (as the pointer
   * part's ended events) and the activation (review-119b O1), the stage releases each key of the plan that is down, then
   * sends the characters that were not typed as one Input.insertText when the field still has the focus (sentence 13's
   * test; review-119 P1), whose answer is Chrome's. Else (or at a navigation) no character goes, and the call gets an
   * error that names the end and the count, after Chrome's answers of the plan's events (review-119b O2), or after
   * STAGE_EVENT_WAIT_MS when they do not come. With every
   * character typed, the call gets its answer after Chrome's answers of its events (review-119 B2 a).
   */
  private async typedEnded(page: StagePage, st: TabState, a: Action, e: Entry, text: string, items: KeyItem[], navigated = false, via: FocusVia = null): Promise<void> {
    st.kq = st.kq.filter((x) => !items.includes(x));
    if (a.failed) { e.answer({ error: a.failBody ?? { code: -32000, message: "the input stage stopped the plan at an error of an event" } }); return; }
    this.count("typedTextsEnded");
    const end = a.over ? a.endedAt : this.clock.now();
    const sent = items.filter((x) => x.sent).map((x) => x.sent!.catch(() => {}));
    const why = navigated ? "a navigation of the main frame" : a.ended === "dialog" ? "a dialog" : a.ended === "wait" ? `no answer in ${STAGE_EVENT_WAIT_MS} ms` : a.ended === "limit" ? `the limit of ${STAGE_ACTION_MAX_MS} ms` : "the end of the tab";
    // Each sent keyDown is typed, except at a dialog: Chrome drops each input event that it gets while a dialog is open (N4).
    // At STAGE_EVENT_WAIT_MS and at the limit (a busy page) Chrome queues the input events and gives them to the page later:
    // the stage first waits for their answers (review-119b R3), with the lock free, for at most one more
    // STAGE_EVENT_WAIT_MS (the daemon lead's point). A page that does not answer in that time (a key handler that never
    // returns): no character of the rest goes, because an unanswered key can still reach the page later; the call gets an
    // error with the count of the characters whose keyDown has no answer; the end's releases go in finish, as at any end of
    // a plan (Chrome gives them to the page when it answers again), or at a session's end in drop.
    const queued = !navigated && (a.ended === "wait" || a.ended === "limit");
    if (queued && !(await this.within(Promise.all(sent), STAGE_EVENT_WAIT_MS))) {
      if (st.gone === "session") return;
      this.count("typedTextsUnanswered");
      const n = [...text].length - items.filter((x) => !x.ev.own && x.ev.type !== "keyUp" && x.answeredAt !== undefined).length;
      e.answer({ error: { code: -32000, message: `The input stage ended a typed text at ${why}, and ${n} characters may not have gone: the page did not answer.` } });
      return;
    }
    const held = a.ended === "dialog" ? items.findIndex((x) => x.sent && !(x.answeredAt !== undefined && x.answeredAt <= end)) : -1;
    const typed = items.filter((x, i) => !x.ev.own && x.ev.type !== "keyUp" && x.sent && (held < 0 || i <= held)).length;
    const rest = [...text].slice(typed).join("");
    if (a.over) await this.dialogGone(st);
    if (st.gone === "session") return;
    // The activation before the focus read (review-119b O1): another tab's action may have taken the window's focus.
    if (a.over) await this.retake(page, st, rest.length > 0 && !navigated);
    // The release of each key of the plan that is down (the stage's own: no client call asked for it alone).
    const codes = new Set(items.filter((x) => x.ev.type === "keyUp" && !x.sent).map((x) => x.ev.code));
    for (const code of codes) {
      const k = st.keys.get(code);
      if (k?.own) sent.push(this.sendKey(page, st, { ev: { t: 0, type: "keyUp", key: k.params.key, code, keyCode: k.params.windowsVirtualKeyCode, location: k.params.location ?? 0, modifiers: 0, own: true }, typed: {} }).catch(() => {}));
    }
    if (st.heldGone) { e.answer({ error: st.heldGone }); return; }
    if (!rest) { this.answerWith(page, e, Promise.all(sent).then(() => ({}))); return; }
    // At a flush with no lock of the part's own, no focus check (review-126b R1): the rest goes where the page's focus is.
    const still = !navigated && !st.gone && (this.flushNoLock(st) || (await this.stillFocused(page, via)));
    if (!still) {
      this.count("typedTextsCut");
      // The error after Chrome's answers of the plan's events and of its releases (review-119b O2), or after
      // STAGE_EVENT_WAIT_MS when they do not come (the daemon lead's point).
      await this.within(Promise.all(sent), STAGE_EVENT_WAIT_MS);
      e.answer({ error: { code: -32000, message: `The input stage ended a typed text at ${why}, and ${[...rest].length} characters did not go: ${navigated ? "the page navigated" : "the field no longer has the focus"}.` } });
      return;
    }
    const r = await this.endedSend(page, st, e, { ...e.params, text: rest });
    if (r) this.answerWith(page, e, r.sent);
  }

  /** The field that the typing rule's read marked still has the focus (sentence 13's test), on the page or on its frame's node. */
  private async stillFocused(page: StagePage, via: FocusVia): Promise<boolean> {
    if (!via) return (await this.read(page.ownRead(FIELD_STILL, []))) === true;
    const r = await this.read(page.send(via.child, "Runtime.callFunctionOn", { objectId: via.node, functionDeclaration: FIELD_STILL_IN, returnByValue: true }));
    return r !== TIMEOUT && (r as any)?.result?.value === true;
  }

  /**
   * The focus and fill recognizers (C11, the focus click): before Playwright's script focus of a text field (focusNode for
   * pressSequentially, press, type and focus; fill's own selectText), the stage clicks the field as a person does, unless it
   * has the focus. The stage reads the field in Playwright's utility world on the node's handle; only a text field gets the
   * click; the point is where the script focus puts the caret; a field with no box, out of view, or covered at the point
   * (the stage's own hit test) gets no click, and the stage counts it. After the click, when the caret is not where the
   * script focus would put it, the stage moves it with keys. Then the utility call goes as the client sent it.
   */
  private async fieldStep(page: StagePage, st: TabState, e: Entry): Promise<void> {
    const u = e.util!, args = (Array.isArray(u.args[0]) ? u.args[0] : []) as unknown[];
    const node = (args[1] as Handle | undefined)?.handle, fill = u.name === "fill", all = u.name === "select text", follow = fill || all, reset = !follow && args[2] === true;
    if (node) { st.field = { child: e.child, node, follow }; if (e.child) { st.childNodes.delete(e.child); st.childNodes.set(e.child, node); while (st.childNodes.size > KEPT_MAX) st.childNodes.delete(st.childNodes.keys().next().value!); } }
    st.fillNext = fill;
    const why = (k: string) => this.noClick(page, k);
    const pass = () => page.pass(e.child, e.method, e.params, e.answer);
    if (!node || st.action?.over) { why("fieldNoRead"); return pass(); }
    // Playwright's focus call starts an action (C11, the window comes forward for input): the lock and the activation first.
    let a = !fill ? await this.begin(page, st) : null;
    if (a?.over) return pass();
    // Playwright's focus call and the keys after it are one action also when it gets no click (review-119b: C11's one action).
    const g = await this.fieldRead(page, st, e.child, node, follow);
    if (!g) { why("fieldNoRead"); return this.keepAction(st, a, pass); }
    // The fill of a date, time, datetime-local, month or week input: a click and typed digits; of a range input: a click
    // and arrow keys (C11, the script calls).
    if (fill && g.kind === "other" && g.type && PICKER_TYPES.includes(g.type) && !g.disabled && !g.readOnly) return this.pickerStep(page, st, e, node, g);
    if (fill && g.kind === "other" && g.type === "range" && !g.disabled && !g.readOnly) return this.rangeStep(page, st, e, node, g);
    // selectText on an element that is not an input or a textarea passes, counted (C11, the script calls).
    if (all && (g.kind === "other" || g.kind === "editable")) { why("selectTextNotField"); return this.keepAction(st, a, pass); }
    if (g.kind === "other") { why("fieldNotText"); return this.keepAction(st, a, pass); }
    // A disabled or read-only field gets no click: Playwright's fill refuses it, and a script focus of a disabled field does
    // nothing (review-119 N6). selectText selects the text of a read-only field, as a person's click and select-all do.
    if (g.disabled || (g.readOnly && !all)) { why(g.disabled ? "fieldDisabled" : "fieldReadOnly"); return this.keepAction(st, a, pass); }
    // An email or a number input with text: its caret cannot be read or set, and Playwright's script focus leaves it where
    // the field's own selection is; a click would move it (review-119 B4). fill and selectText select the text, so they get the click.
    if (!follow && g.kind === "input" && (g.type === "email" || g.type === "number") && g.len > 0) { why("focusNoCaret"); return this.keepAction(st, a, pass); }
    // The field has the focus (sentence 13's test, after the activation for Playwright's focus call). Before fill, a field
    // that fails it gets the lock and the activation, and the read again (review-119 N5).
    let f = g;
    // selectText on a field with the focus: the select-all chord alone (C11, the script calls).
    if (f.focused) { why("fieldFocused"); if (all && a && !a.over) await this.selectAll(page, st, a); return this.keepAction(st, a, pass); }
    if (!a) {
      a = await this.begin(page, st);
      if (a.over) return pass();
      const h = await this.fieldRead(page, st, e.child, node, follow);
      if (!h) { why("fieldNoRead"); return this.keepAction(st, a, pass); }
      if (h.focused) { why("fieldFocused"); return this.keepAction(st, a, pass); }
      f = h;
    }
    if (a.over) return pass();
    // A field with a sign that it opens a panel at a click gets no click (board ab-t30.18, the operator's answer on board
    // item ab-pf8, 2026-11-12): a widget sign of the field's read, else, on an input only (review-123 B1: an editor puts a
    // click listener on its own root), a click listener of the page's own scripts on the field itself whose handler is not
    // empty. Playwright's script focus goes as the client sent it, as with Playwright's own input (its focus() also
    // scrolls the field into view: no notches), in the same action; the stage counts it and the sign.
    const sign = f.widget ?? (f.kind === "input" ? await this.clickListener(page, e.child, node, follow) : null);
    if (sign === TIMEOUT) { why("fieldNoRead"); return this.keepAction(st, a, pass); }
    if (sign) { this.count(`focusWidget:${sign}`); this.noClick(page, "focusWidget", sign); return this.keepAction(st, a, pass); }
    if (a.over) return pass();
    // A field out of view first gets notches into view (C11, the focus click; board ab-t30.11, review-119 N14), also inside
    // a frame's own scroller; then the stage reads the field again. On the Mac (no notch until the Mac's wheel model) and
    // when the notches cannot bring it into view, no click, counted.
    const into = await this.intoView(page, st, a, e.child, node, follow, null);
    if (!into.ok) {
      if (into.why === "error") { a.failBody = this.stopPlan(page, st, "Input.dispatchMouseEvent", into.error); return pass(); }
      if (into.why === "ended" || into.why === "navigated") return pass();
      why(into.why === "readFails" || into.why === "frameDeep" ? "fieldNoRead" : into.why === "noBox" ? "focusNoBox" : "focusOutOfView");
      return this.keepAction(st, a, pass);
    }
    if (into.notched) {
      this.count("focusNotches");
      if (this.o.trace) this.o.log(`relay: the input stage: tab ${page.id}: a focus click: ${into.notched} notches into view`);
      const h = await this.fieldRead(page, st, e.child, node, follow);
      if (!h) { why("fieldNoRead"); return this.keepAction(st, a, pass); }
      f = h;
    }
    const at = await this.clickPoint(page, st, e.child, node, f, follow, into.view.vis[0]);
    if (!at) return this.keepAction(st, a, pass);
    // Where the script focus puts the caret: the start of an input (Playwright's caret reset), else the field's own selection.
    const want = f.kind === "input" && reset ? { s: 0, e: 0 } : typeof f.s === "number" && typeof f.e === "number" ? { s: f.s, e: f.e } : null;
    // The new elements that cover the area near the field after the click (board ab-t30.18): the first read before the
    // path, the second two frames after the release. A count only, to measure the panels that the signs above miss: the
    // stage sends no input of its own for them.
    const cover = await this.coverBefore(page, e.child, node, follow);
    this.count("focusClicks");
    if (this.o.trace) this.o.log(`relay: the input stage: tab ${page.id}: a focus click (${f.kind})`);
    if (!(await this.ownClick(page, st, a, at, Math.max(1, Math.min(f.box.x1 - f.box.x0, f.box.y1 - f.box.y0))))) { if (cover) this.coverClear(page, e.child, node); return pass(); }
    if (cover) await this.coverAfter(page, e.child, node);
    // selectText: after the click, the select-all chord (C11, the script calls); the caret does not matter.
    if (all) { const h = await this.fieldRead(page, st, e.child, node, follow); if (!h || !h.active) why("focusClickMissed"); else await this.selectAll(page, st, a); return this.keepAction(st, a, pass); }
    if (!fill && want && (f.kind === "input" || f.kind === "textarea")) {
      const h = await this.fieldRead(page, st, e.child, node, fill);
      if (!h || !h.active) why("focusClickMissed");
      else if (h.s !== want.s || h.e !== want.e) { if (this.o.trace) this.o.log(`relay: the input stage: tab ${page.id}: a focus click: the caret moves`); await this.caret(page, st, a, e.child, node, f, want); }
    }
    return this.keepAction(st, a, pass);
  }

  /** The field is the active element after the stage's click (review-132 B2); false when not, or when the read fails or reaches its limit. */
  private async hasFocus(page: StagePage, child: string | undefined, node: string): Promise<boolean> {
    const r = await this.read(page.send(child, "Runtime.callFunctionOn", { objectId: node, functionDeclaration: FIELD_ACTIVE, arguments: [{ value: true }], returnByValue: true }));
    return r !== TIMEOUT && (r as any)?.result?.value === true;
  }

  /**
   * Playwright's own state checks of the client's call, before the stage's input (review-132 note a): the states that the
   * call's function names (for example visible, enabled, editable; aria-disabled and aria-readonly, also of an ancestor),
   * on the call's own handle of Playwright's injected script. A call with `force` has none. False when a state does not
   * hold (Playwright's own call then fails with no event), and when the read fails or reaches its limit.
   */
  private async pwStates(page: StagePage, child: string | undefined, u: Utility, node: string): Promise<boolean> {
    const args = (Array.isArray(u.args[0]) ? u.args[0] : []) as unknown[], inj = (args[0] as Handle | undefined)?.handle, opt = (args[2] ?? {}) as Record<string, unknown>;
    if (opt.force === true) return true;
    const m = /checkElementStates\(node,\s*(\[[^\]]*\])/.exec(u.fn);
    let states: unknown = null;
    try { states = m ? JSON.parse(m[1]) : null; } catch { states = null; }
    if (!inj || !Array.isArray(states)) return false;
    const r = await this.read(page.send(child, "Runtime.callFunctionOn", { objectId: inj, functionDeclaration: PLAYWRIGHT_STATES, arguments: [{ objectId: node }, { value: states }, { value: opt.frameVisible ?? true }], awaitPromise: true, returnByValue: true }));
    return r !== TIMEOUT && !(r as any)?.exceptionDetails && !(r as any)?.result?.value;
  }

  /** A person's pause before the stage's own keys after its click (the hand goes to the keys; the popup opens): false when the plan ended. */
  private async handToKeys(page: StagePage, a: Action): Promise<boolean> {
    await this.until(a, this.clock.now() + pauseMs(page.person, this.o.random));
    return !a.over;
  }

  /** selectText's select-all chord (C11, the script calls): Control+A, on the Mac Meta+A with the Mac's command; counted. */
  private async selectAll(page: StagePage, st: TabState, a: Action): Promise<void> {
    this.count("selectAllKeys");
    if (this.o.trace) this.o.log(`relay: the input stage: tab ${page.id}: selectText: the select-all chord`);
    if (!(await this.handToKeys(page, a))) return;
    await this.ownKeys(page, st, a, [{ key: "a", code: "KeyA", keyCode: 65, modifiers: this.linux() ? CONTROL : META }]);
  }

  /**
   * Playwright's selectOption (C11, the script calls; board ab-t30.12.1): on a select that is not a list box, the stage
   * clicks the select as a person does (its popup opens), goes to the client's option with keys (selectKeys), and presses
   * Enter: the page gets the person's input and one trusted `input` and `change`. Then the client's call goes with
   * Playwright's function in SKIP_EVENTS, so Playwright's own events of that value do not come again, and the client gets
   * Playwright's own answer. Every other case passes as the client sent it, and the stage counts it.
   */
  private async selectStep(page: StagePage, st: TabState, e: Entry): Promise<void> {
    const args = (Array.isArray(e.util!.args[0]) ? e.util!.args[0] : []) as unknown[];
    const node = (args[1] as Handle | undefined)?.handle, opt = (args[2] ?? {}) as Record<string, unknown>;
    const want = Array.isArray(opt.optionsToSelect) ? opt.optionsToSelect : null;
    const plain = () => (st.gone === "session" ? undefined : page.pass(e.child, e.method, e.params, e.answer));
    // At the end of the client's session the call does not go, and nothing goes back (as each call of an ended plan).
    const skip = () => (st.gone === "session" ? undefined : page.pass(e.child, e.method, skipEvents(e.params), e.answer));
    const pass = (k: string) => { this.count(`selectPass:${k}`); if (this.o.trace) this.o.log(`relay: the input stage: tab ${page.id}: selectOption passes (${k})`); return plain(); };
    if (!node || !want || st.action?.over) return pass("noRead");
    // On the Mac a select's popup is a native menu that no probe measured (review-132 B3): the call passes.
    if (!this.linux()) return pass("mac");
    const handles = want.filter((w): w is Handle => !!w && typeof w === "object" && "handle" in (w as object)).map((h) => ({ objectId: h.handle }));
    const r = await this.read(page.send(e.child, "Runtime.callFunctionOn", { objectId: node, functionDeclaration: SELECT_STATE, arguments: [{ value: true }, ...handles], returnByValue: true }));
    const v = r === TIMEOUT ? null : (r as any)?.result?.value;
    if (!v || typeof v.select !== "boolean" || (v.select && !Array.isArray(v.o))) return pass("noRead");
    if (!v.select) return pass("notSelect");
    if (v.list) return pass("listBox");
    if (v.disabled) return pass("disabled");
    const t = selectTarget(want, v.o, v.hs ?? []);
    // No such option, or a disabled one: Playwright's own error, as with no stage.
    if (t === null || v.o[t].d) return pass("noOption");
    // The option is selected already: a person changes nothing, and Playwright's call still sends its events (a page can
    // wait for them), so the call goes as it is.
    if (t === v.sel) return pass("selected");
    const keys = selectKeys(v.o, v.sel, t);
    if (!keys) return pass("noKeys");
    if (!(await this.pwStates(page, e.child, e.util!, node))) return pass("states");
    // The lock and the activation (C11, the window comes forward for input), then the select's box.
    const a = await this.begin(page, st);
    if (a.over) return plain();
    let f = await this.fieldRead(page, st, e.child, node, true);
    if (!f) return pass("noRead");
    const into = await this.intoView(page, st, a, e.child, node, true, null);
    if (!into.ok) {
      if (into.why === "error") { a.failBody = this.stopPlan(page, st, "Input.dispatchMouseEvent", into.error); return plain(); }
      if (into.why === "ended" || into.why === "navigated") return plain();
      return pass(into.why === "noBox" ? "noBox" : into.why === "readFails" || into.why === "frameDeep" ? "noRead" : "outOfView");
    }
    if (into.notched) { const h = await this.fieldRead(page, st, e.child, node, true); if (!h) return pass("noRead"); f = h; }
    // The point: as the focus click's on an empty input (the middle of the select), with the stage's own hit test.
    const at = await this.clickPoint(page, st, e.child, node, { ...f, kind: "input", len: 0 }, true, into.view.vis[0]);
    if (!at) return pass("noClick");
    this.count("selectClicks");
    if (this.o.trace) this.o.log(`relay: the input stage: tab ${page.id}: selectOption: a click and ${keys.length} keys`);
    // From the press on, the client's call goes in SKIP_EVENTS: its events go only when Playwright's function changes the value.
    if (!(await this.ownClick(page, st, a, at, Math.max(1, Math.min(f.box.x1 - f.box.x0, f.box.y1 - f.box.y0))))) return skip();
    // The click gave the select no focus (review-132 B2: a page that cancels mousedown): no key goes.
    if (!(await this.hasFocus(page, e.child, node))) return pass("noFocus");
    if (!(await this.handToKeys(page, a)) || !(await this.ownKeys(page, st, a, keys))) return skip();
    const after = await this.read(page.send(e.child, "Runtime.callFunctionOn", { objectId: node, functionDeclaration: SCRIPT_VALUE, arguments: [{ value: true }], returnByValue: true }));
    if (after !== TIMEOUT && (after as any)?.result?.value === t) this.count("selectByKeys");
    else { this.count("selectMissed"); this.o.log(`relay: the input stage: tab ${page.id}: selectOption: the keys did not select the client's option; Playwright's script selects it`); }
    return skip();
  }

  /**
   * The fill of a date, time, datetime-local, month or week input (C11, the script calls; board ab-t30.12.1): the stage
   * reads the input's fields in their order on the screen (its user-agent shadow tree), clicks the first field as a person
   * does, and types the value's digits field by field (pickerKeys): the page gets the person's keys and the browser's own
   * trusted `input` and `change`. Then the client's call goes with Playwright's function in SKIP_EVENTS. Every other case
   * passes as the client sent it, and the stage counts it.
   */
  private async pickerStep(page: StagePage, st: TabState, e: Entry, node: string, g: FieldRead): Promise<void> {
    const args = (Array.isArray(e.util!.args[0]) ? e.util!.args[0] : []) as unknown[], opt = (args[2] ?? {}) as Record<string, unknown>;
    // Playwright trims the value of these inputs.
    const value = typeof opt.value === "string" ? opt.value.trim() : null;
    st.fillNext = false;
    const plain = () => (st.gone === "session" ? undefined : page.pass(e.child, e.method, e.params, e.answer));
    const skip = () => (st.gone === "session" ? undefined : page.pass(e.child, e.method, skipEvents(e.params), e.answer));
    const pass = (k: string) => { this.count(`pickerPass:${k}`); if (this.o.trace) this.o.log(`relay: the input stage: tab ${page.id}: the fill of a ${g.type} input passes (${k})`); return plain(); };
    if (value === null) return pass("noRead");
    // An empty value clears the input: a person clears each field; the call goes as it is.
    if (!value) return pass("empty");
    const cur = await this.read(page.send(e.child, "Runtime.callFunctionOn", { objectId: node, functionDeclaration: SCRIPT_VALUE, arguments: [{ value: true }], returnByValue: true }));
    if (cur === TIMEOUT) return pass("noRead");
    // The value is the input's already: a person changes nothing, and Playwright's call still sends its events.
    if ((cur as any)?.result?.value === value) return pass("same");
    const fields = await this.pickerFields(page, e.child, node);
    if (!fields) return pass("noRead");
    const keys = pickerKeys(g.type!, value, fields);
    if (!keys) return pass("noKeys");
    if (!(await this.pwStates(page, e.child, e.util!, node))) return pass("states");
    // The lock and the activation (C11, the window comes forward for input), as before fill's focus click.
    const a = await this.begin(page, st);
    if (a.over) return plain();
    let f = g;
    const into = await this.intoView(page, st, a, e.child, node, true, null);
    if (!into.ok) {
      if (into.why === "error") { a.failBody = this.stopPlan(page, st, "Input.dispatchMouseEvent", into.error); return plain(); }
      if (into.why === "ended" || into.why === "navigated") return plain();
      return pass(into.why === "noBox" ? "noBox" : into.why === "readFails" || into.why === "frameDeep" ? "noRead" : "outOfView");
    }
    if (into.notched) { const h = await this.fieldRead(page, st, e.child, node, true); if (!h) return pass("noRead"); f = h; }
    // The point: 2 to 5 px from the input's left edge, as the focus click's on a field with text: the first field gets the focus.
    const at = await this.clickPoint(page, st, e.child, node, { ...f, kind: "input", len: 1 }, true, into.view.vis[0]);
    if (!at) return pass("noClick");
    this.count("pickerClicks");
    if (this.o.trace) this.o.log(`relay: the input stage: tab ${page.id}: the fill of a ${g.type} input: a click and ${keys.length} keys`);
    if (!(await this.ownClick(page, st, a, at, Math.max(1, Math.min(f.box.x1 - f.box.x0, f.box.y1 - f.box.y0))))) return skip();
    if (!(await this.hasFocus(page, e.child, node))) return pass("noFocus");
    if (!(await this.handToKeys(page, a)) || !(await this.ownKeys(page, st, a, keys))) return skip();
    const after = await this.read(page.send(e.child, "Runtime.callFunctionOn", { objectId: node, functionDeclaration: SCRIPT_VALUE, arguments: [{ value: true }], returnByValue: true }));
    if (after !== TIMEOUT && (after as any)?.result?.value === value) this.count("pickerTyped");
    else { this.count("pickerMissed"); this.o.log(`relay: the input stage: tab ${page.id}: the fill of a ${g.type} input: the keys did not give the client's value; Playwright's script sets it`); }
    return skip();
  }

  /**
   * The fill of a range input (C11, the script calls; board ab-t30.12.1): a click on its track at the value's place (with
   * Chrome's default thumb of RANGE_THUMB_PX), then the arrow keys for the rest (at most RANGE_KEYS_MAX), as a person
   * does: the page gets the browser's trusted `input` and `change`. Then the client's call goes with Playwright's function
   * in SKIP_EVENTS. A step of `any`, a range from right to left or up and down, one in a cross-origin frame, and one whose
   * place is covered pass as the client sent them, and the stage counts them.
   */
  private async rangeStep(page: StagePage, st: TabState, e: Entry, node: string, g: FieldRead): Promise<void> {
    const args = (Array.isArray(e.util!.args[0]) ? e.util!.args[0] : []) as unknown[], opt = (args[2] ?? {}) as Record<string, unknown>;
    const value = typeof opt.value === "string" ? opt.value.trim() : null, want = value === null || value === "" ? NaN : Number(value);
    st.fillNext = false;
    const plain = () => (st.gone === "session" ? undefined : page.pass(e.child, e.method, e.params, e.answer));
    const skip = () => (st.gone === "session" ? undefined : page.pass(e.child, e.method, skipEvents(e.params), e.answer));
    const pass = (k: string) => { this.count(`rangePass:${k}`); if (this.o.trace) this.o.log(`relay: the input stage: tab ${page.id}: the fill of a range input passes (${k})`); return plain(); };
    if (!Number.isFinite(want)) return pass("noKeys");
    const r = await this.read(page.send(e.child, "Runtime.callFunctionOn", { objectId: node, functionDeclaration: RANGE_STATE, arguments: [{ value: true }], returnByValue: true }));
    const v = r === TIMEOUT ? null : (r as any)?.result?.value;
    if (!v || typeof v.min !== "number" || typeof v.max !== "number" || !(v.max > v.min)) return pass("noRead");
    if (v.step === null) return pass("stepAny");
    if (v.turned) return pass("turned");
    if (g.levels.length) return pass("frame");
    if (v.value === want) return pass("same");
    // A value out of min and max, off the step, or not in Chrome's form: Playwright's script fails with no event (review-132 note b).
    const k = (want - v.min) / v.step;
    if (want < v.min || want > v.max || Math.abs(k - Math.round(k)) > 1e-7 || String(want) !== value) return pass("value");
    if (!(await this.pwStates(page, e.child, e.util!, node))) return pass("states");
    const a = await this.begin(page, st);
    if (a.over) return plain();
    let f = g;
    const into = await this.intoView(page, st, a, e.child, node, true, null);
    if (!into.ok) {
      if (into.why === "error") { a.failBody = this.stopPlan(page, st, "Input.dispatchMouseEvent", into.error); return plain(); }
      if (into.why === "ended" || into.why === "navigated") return plain();
      return pass(into.why === "noBox" ? "noBox" : into.why === "readFails" || into.why === "frameDeep" ? "noRead" : "outOfView");
    }
    if (into.notched) { const h = await this.fieldRead(page, st, e.child, node, true); if (!h) return pass("noRead"); f = h; }
    const b = f.box, w = b.x1 - b.x0, frac = Math.min(1, Math.max(0, (want - v.min) / (v.max - v.min)));
    if (!(w > RANGE_THUMB_PX)) return pass("noBox");
    const at = { x: Math.round(b.x0 + RANGE_THUMB_PX / 2 + frac * (w - RANGE_THUMB_PX)), y: Math.round((b.y0 + b.y1) / 2) };
    if (!inside(at, into.view.vis[0])) return pass("outOfView");
    const hit = await this.read(page.send(e.child, "Runtime.callFunctionOn", { objectId: node, functionDeclaration: FIELD_HIT, arguments: [{ value: at.x - f.ox }, { value: at.y - f.oy }, { value: true }], returnByValue: true }));
    if (hit === TIMEOUT || (hit as any)?.result?.value !== true) return pass("covered");
    this.count("rangeClicks");
    if (!(await this.ownClick(page, st, a, at, Math.max(1, b.y1 - b.y0)))) return skip();
    if (!(await this.hasFocus(page, e.child, node))) return pass("noFocus");
    const read = async () => { const x = await this.read(page.send(e.child, "Runtime.callFunctionOn", { objectId: node, functionDeclaration: SCRIPT_VALUE, arguments: [{ value: true }], returnByValue: true })); return x === TIMEOUT ? NaN : Number((x as any)?.result?.value); };
    const got = await read(), n = Math.round((want - got) / v.step);
    if (Number.isFinite(n) && n !== 0 && Math.abs(n) <= RANGE_KEYS_MAX) {
      if (this.o.trace) this.o.log(`relay: the input stage: tab ${page.id}: the fill of a range input: ${Math.abs(n)} arrow keys after the click`);
      if (!(await this.handToKeys(page, a)) || !(await this.ownKeys(page, st, a, Array(Math.abs(n)).fill(n > 0 ? K_RIGHT : K_LEFT)))) return skip();
    }
    if ((await read()) === want) this.count("rangeSet");
    else { this.count("rangeMissed"); this.o.log(`relay: the input stage: tab ${page.id}: the fill of a range input: the click and the keys did not give the client's value; Playwright's script sets it`); }
    return skip();
  }

  /**
   * The fields of a date, time, datetime-local, month or week input in their order on the screen (C11, the script calls):
   * the `pseudo` names of its user-agent shadow tree (DOM.describeNode with pierce, on the field's element), for example
   * `month`, `day`, `year`; null when a read fails or reaches its limit.
   */
  private async pickerFields(page: StagePage, child: string | undefined, node: string): Promise<string[] | null> {
    try {
      const h = await this.read(page.send(child, "Runtime.callFunctionOn", { objectId: node, functionDeclaration: FIELD_ELEMENT, arguments: [{ value: true }], returnByValue: false, objectGroup: STAGE_GROUP }));
      const id = h === TIMEOUT ? undefined : (h as any)?.result?.objectId;
      if (typeof id !== "string") return null;
      const d = await this.read(page.send(child, "DOM.describeNode", { objectId: id, depth: -1, pierce: true }));
      if (d === TIMEOUT || !(d as any)?.node) return null;
      const out: string[] = [];
      const walk = (n: any, depth: number) => {
        if (!n || depth > 32) return;
        const at: unknown[] = Array.isArray(n.attributes) ? n.attributes : [];
        const i = at.indexOf("pseudo"), m = i >= 0 ? /^-webkit-datetime-edit-(\w+)-field$/.exec(String(at[i + 1])) : null;
        if (m) out.push(m[1]);
        for (const c of [...(n.shadowRoots ?? []), ...(n.children ?? [])]) walk(c, depth + 1);
      };
      walk((d as any).node, 0);
      return out.length ? out : null;
    } finally {
      void page.send(child, "Runtime.releaseObjectGroup", { objectGroup: STAGE_GROUP }).catch(() => {});
    }
  }

  /**
   * After the focus or fill call's step (review-119 B7): its action stays open for the key run that follows (Playwright's
   * keys or its insertText), as one action with one limit (STAGE_ACTION_MAX_MS from the focus call) and one activation.
   */
  private keepAction(st: TabState, a: Action | null, pass: () => Promise<void>): Promise<void> {
    if (a && !a.over && st.action === a) st.runOpen = true;
    return pass();
  }

  /** No focus click (or a click that missed): the count, and with the trace a log line of its reason (and the widget's sign; never a point). */
  private noClick(page: StagePage, k: string, sign?: string): void { this.count(k); if (this.o.trace) this.o.log(`relay: the input stage: tab ${page.id}: no focus click (${k}${sign ? `: ${sign}` : ""})`); }

  /**
   * The field's listener sign (board ab-t30.18; C11, the focus click): a listener of the page's own scripts on the field
   * itself for an event of WIDGET_LISTENERS (a click). The field's element (fill's retarget) as a handle of Playwright's
   * utility world (FIELD_ELEMENT, in the stage's group) is resolved into the page's main world (DOM.describeNode,
   * DOM.resolveNode: a handle, no script), where DOMDebugger.getEventListeners with no pierce reports the listeners of
   * that world only: the page's own (as rule 2 of the wheel point reads them). A listener of another node (a child) does
   * not count. "listener", null, or TIMEOUT when a read fails or reaches its limit (then the field gets no click).
   */
  private async clickListener(page: StagePage, child: string | undefined, node: string, follow: boolean): Promise<"listener" | null | typeof TIMEOUT> {
    // One deadline for the whole read (review-123 note 6), as rule 2 of the wheel point has.
    const until = this.clock.now() + GEOMETRY_WAIT_MS, left = () => until - this.clock.now();
    const step = async <T>(p: () => Promise<T>): Promise<T | typeof TIMEOUT> => (left() > 0 ? this.read(p(), left()) : TIMEOUT);
    try {
      const h = await step(() => page.send(child, "Runtime.callFunctionOn", { objectId: node, functionDeclaration: FIELD_ELEMENT, arguments: [{ value: follow }], returnByValue: false, objectGroup: STAGE_GROUP }));
      const id = h === TIMEOUT ? undefined : (h as any)?.result?.objectId;
      if (typeof id !== "string") return TIMEOUT;
      const d = await step(() => page.send(child, "DOM.describeNode", { objectId: id }));
      const backendNodeId = d === TIMEOUT ? undefined : (d as any)?.node?.backendNodeId;
      if (!Number.isInteger(backendNodeId)) return TIMEOUT;
      // The handle of the main world in the stage's group: Chrome then gives each listener's handler, with its text.
      const m = await step(() => page.send(child, "DOM.resolveNode", { backendNodeId, objectGroup: STAGE_GROUP }));
      const main = m === TIMEOUT ? undefined : (m as any)?.object?.objectId;
      if (typeof main !== "string") return TIMEOUT;
      const l = await step(() => page.send(child, "DOMDebugger.getEventListeners", { objectId: main, pierce: false }));
      if (l === TIMEOUT) return TIMEOUT;
      // A handler whose text is an empty function is no sign; a listener whose handler Chrome does not give is (the stage cannot tell).
      const empty = (x: any) => typeof x?.handler?.description === "string" && EMPTY_HANDLER.test(x.handler.description);
      return ((l as any)?.listeners ?? []).some((x: any) => WIDGET_LISTENERS.includes(x?.type) && x?.backendNodeId === backendNodeId && !empty(x)) ? "listener" : null;
    } finally {
      void page.send(child, "Runtime.releaseObjectGroup", { objectGroup: STAGE_GROUP }).catch(() => {});
    }
  }

  /** The cover read before the focus click (COVER_BEFORE): true when the world keeps it. */
  private async coverBefore(page: StagePage, child: string | undefined, node: string, follow: boolean): Promise<boolean> {
    const sent = page.send(child, "Runtime.callFunctionOn", { objectId: node, functionDeclaration: COVER_BEFORE, arguments: [{ value: follow }], returnByValue: true });
    const r = await this.read(sent);
    // A read that answers after its limit has kept its elements in the world: the stage clears it then (review-123 note 7).
    if (r === TIMEOUT) { sent.then(() => this.coverClear(page, child, node), () => {}); return false; }
    const n = (r as any)?.result?.value;
    return typeof n === "number" && n > 0;
  }
  /** The cover read after the focus click (COVER_AFTER, two frames after the release): the count of the new covering elements, and with the trace a log line with the count only. */
  private async coverAfter(page: StagePage, child: string | undefined, node: string): Promise<void> {
    const r = await this.read(page.send(child, "Runtime.callFunctionOn", { objectId: node, functionDeclaration: COVER_AFTER, returnByValue: true, awaitPromise: true }));
    const n = r === TIMEOUT ? undefined : (r as any)?.result?.value;
    if (typeof n !== "number" || !(n > 0)) return;
    this.count("focusNewCovers", n);
    this.count("focusClicksCovering");
    if (this.o.trace) this.o.log(`relay: the input stage: tab ${page.id}: a focus click: ${n} new covering element${n === 1 ? "" : "s"}`);
  }
  /** The world lets go of a kept cover read (the click's plan ended before its release). */
  private coverClear(page: StagePage, child: string | undefined, node: string): void {
    void page.send(child, "Runtime.callFunctionOn", { objectId: node, functionDeclaration: COVER_CLEAR, returnByValue: true }).catch(() => {});
  }

  /** The focus click's read of the field (FIELD_STATE), with its box in the top page's points (the frame mapping), or null. */
  private async fieldRead(page: StagePage, st: TabState, child: string | undefined, node: string, follow: boolean): Promise<FieldRead | null> {
    const r = await this.read(page.send(child, "Runtime.callFunctionOn", { objectId: node, functionDeclaration: FIELD_STATE, arguments: [{ value: follow }], returnByValue: true }));
    const v = r === TIMEOUT ? null : (r as any)?.result?.value;
    if (!v || typeof v.kind !== "string" || !v.box) return null;
    const m = await this.mapped(page, st, child, v);
    if (!m) { this.count("frameMapFails"); return null; }
    return { ...v, box: m.box, ox: m.ox, oy: m.oy, lox: v.ox, loy: v.oy, levels: m.levels };
  }

  /**
   * The point of the focus click (C11, the focus click): 2 to 5 px from the left edge of an input or a textarea with text,
   * and of a contenteditable; 25% to 75% across an empty input or textarea; 35% to 65% down an input, 6 to 12 px from the
   * top of a textarea or a contenteditable; whole px inside the box on Linux. Null (no click, counted) when the field has no
   * box, the point is out of the visible part of its scroller (`vis`, after the notches into view), or another element
   * covers it at the point.
   */
  private async clickPoint(page: StagePage, st: TabState, child: string | undefined, node: string, f: FieldRead, follow: boolean, vis: Rect): Promise<Pt | null> {
    const b = f.box, w = b.x1 - b.x0, h = b.y1 - b.y0;
    if (!(w >= 1 && h >= 1)) { this.noClick(page, "focusNoBox"); return null; }
    const lm = await this.read(page.send(undefined, "Page.getLayoutMetrics", {}));
    const v = lm === TIMEOUT ? null : (lm as any)?.cssLayoutViewport;
    const R = this.o.random, editable = f.kind === "editable", text = f.len > 0 || editable;
    const [xa, xb] = text ? [b.x0 + 2, b.x0 + 5] : [b.x0 + 0.25 * w, b.x0 + 0.75 * w];
    const [ya, yb] = f.kind === "input" ? [b.y0 + 0.35 * h, b.y0 + 0.65 * h] : [b.y0 + 6, b.y0 + 12];
    const pick = (lo: number, hi: number, min: number, max: number) => {
      const x = uniform(R, Math.max(min, lo), Math.max(min, Math.min(max, hi)));
      if (!this.linux()) return x;
      const r = Math.round(x), l = Math.ceil(Math.max(min, lo)), u = Math.floor(Math.min(max, hi));
      return l <= u ? Math.min(u, Math.max(l, r)) : r;
    };
    const p = { x: pick(xa, xb, b.x0, b.x1 - 1), y: pick(ya, yb, b.y0, b.y1 - 1) };
    // The point out of the visible part of the field's scroller (a field in view by the middle rule, clipped at its edge): no click.
    if (!inside(p, vis) || (v && (p.x < 0 || p.y < 0 || p.x >= v.clientWidth || p.y >= v.clientHeight))) { this.noClick(page, "focusOutOfView"); return null; }
    // The stage's own hit test (review-119 B3): the field's own document at the field's own point (the top page's point less
    // the offset of the field's document), and each same-origin frame above it (FIELD_HIT); then at each cross-origin level
    // the node at the mapped point of the parent's session is the frame's owner (DOM.getNodeForLocation). That command reads
    // a point of the parent's document (Chromium's InspectorDOMAgent: DocumentToFrame; measured, review-119b R4), so the
    // point gets the parent document's scroll: its layout viewport's offset (Page.getLayoutMetrics on that session).
    const hit = await this.read(page.send(child, "Runtime.callFunctionOn", { objectId: node, functionDeclaration: FIELD_HIT, arguments: [{ value: p.x - f.ox }, { value: p.y - f.oy }, { value: follow }], returnByValue: true }));
    if (hit === TIMEOUT || (hit as any)?.result?.value !== true) { this.noClick(page, "focusCovered"); return null; }
    for (let i = 0; i < f.levels.length; i++) {
      const L = f.levels[i];
      let px = p.x, py = p.y;
      for (const up of f.levels.slice(i + 1)) { px -= up.r.x0; py -= up.r.y0; }
      const sm = L.parent === undefined ? lm : await this.read(page.send(L.parent, "Page.getLayoutMetrics", {}));
      const sc = sm === TIMEOUT ? null : (sm as any)?.cssLayoutViewport;
      if (typeof sc?.pageX !== "number" || typeof sc?.pageY !== "number") {
        if (this.o.trace) this.o.log(`relay: the input stage: tab ${page.id}: the hit test of a cross-origin frame level: no scroll read`);
        this.noClick(page, "focusCovered"); return null;
      }
      const at = await this.read(page.send(L.parent, "DOM.getNodeForLocation", { x: Math.round(px + sc.pageX), y: Math.round(py + sc.pageY), includeUserAgentShadowDOM: false, ignorePointerEventsNone: false }));
      const owner = at !== TIMEOUT && (at as any)?.backendNodeId === L.owner;
      if (this.o.trace) this.o.log(`relay: the input stage: tab ${page.id}: the hit test of a cross-origin frame level: ${owner ? "the frame's owner" : at === TIMEOUT ? "no answer" : "another node"}`);
      if (!owner) { this.noClick(page, "focusCovered"); return null; }
    }
    return p;
  }

  /** A click of the stage's own (the focus click): a path to the point, a pause, a press of a person's hold, the release. False when the plan ended or failed. */
  private async ownClick(page: StagePage, st: TabState, a: Action, to: Pt, width: number): Promise<boolean> {
    const P = page.person, R = this.o.random;
    let from = this.from(page, st);
    from ??= await this.startOf(page);
    if (from && !same(from, to)) {
      const r = await this.play(page, st, a, this.plan(page, st, from, to, width), { modifiers: 0 });
      if (r.error !== undefined) { a.failBody = this.stopPlan(page, st, "Input.dispatchMouseEvent", r.error); return false; }
      if (r.stopped || a.over) return false;
    }
    if (st.lastWasMove) await this.until(a, st.lastMoveAt + pauseMs(P, R));
    if (a.over) return false;
    const mods = this.clientBits(st), at = this.clock.now();
    const press = this.sendEvent(page, st, undefined, "Input.dispatchMouseEvent", { type: "mousePressed", x: to.x, y: to.y, button: "left", buttons: 1, clickCount: 1, modifiers: mods, force: force(P), timestamp: this.stamp(page, st) });
    st.buttons.set("left", 1);
    st.press = { at, hold: holdMs(P, R), client: to, point: to, button: "left" };
    const r1 = await this.settle(a, press);
    if ("ended" in r1) return false;
    if (!r1.ok) { st.buttons.delete("left"); st.press = null; a.failBody = this.stopPlan(page, st, "Input.dispatchMouseEvent", r1.error); return false; }
    await this.until(a, at + st.press.hold);
    if (a.over) return false;
    const release = this.sendEvent(page, st, undefined, "Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1, modifiers: mods, timestamp: this.stamp(page, st) });
    st.buttons.delete("left"); st.releasedAt = this.clock.now(); st.press = null;
    const r2 = await this.settle(a, release);
    if ("ended" in r2) return false;
    if (!r2.ok) { a.failBody = this.stopPlan(page, st, "Input.dispatchMouseEvent", r2.error); return false; }
    return true;
  }

  /**
   * The caret after the focus click (C11, the focus click): at the start, Home (an input) or Control+Home (a textarea); at
   * the end, End or Control+End; in the middle of a text up to CARET_KEYS_MAX characters, the start and then ArrowRight
   * and Shift+ArrowRight; else the field's own setSelectionRange in Playwright's utility world (a script effect, counted).
   * On the Mac the keys carry the Mac's editing commands.
   */
  private async caret(page: StagePage, st: TabState, a: Action, child: string | undefined, node: string, f: FieldRead, want: { s: number; e: number }): Promise<void> {
    const ta = f.kind === "textarea", mac = !this.linux();
    const K = (key: string, code: string, keyCode: number, modifiers = 0): Key => ({ key, code, keyCode, modifiers });
    const start = mac ? K(ta ? "ArrowUp" : "ArrowLeft", ta ? "ArrowUp" : "ArrowLeft", ta ? 38 : 37, META) : K("Home", "Home", 36, ta ? CONTROL : 0);
    const end = mac ? K(ta ? "ArrowDown" : "ArrowRight", ta ? "ArrowDown" : "ArrowRight", ta ? 40 : 39, META) : K("End", "End", 35, ta ? CONTROL : 0);
    const right = K("ArrowRight", "ArrowRight", 39), sel = K("ArrowRight", "ArrowRight", 39, SHIFT);
    let keys: Key[] | null;
    if (want.s === 0 && want.e === 0) keys = [start];
    else if (want.s === f.len && want.e === f.len) keys = [end];
    else if (want.e <= CARET_KEYS_MAX) keys = [start, ...Array(want.s).fill(right), ...Array(want.e - want.s).fill(sel)];
    else keys = null;
    if (keys) { this.count("caretKeys"); await this.ownKeys(page, st, a, keys); return; }
    this.count("caretScript");
    this.o.log(`relay: the input stage: tab ${page.id}: the caret of a field is set by a script (setSelectionRange), to where the script focus would put it`);
    await this.read(page.send(child, "Runtime.callFunctionOn", { objectId: node, functionDeclaration: CARET_SET, arguments: [{ value: want.s }, { value: want.e }, { value: false }], returnByValue: true }));
  }

  /**
   * The hit-target setup (C11, the hit-target check and its misses): after a miss of the tab, the recovery at this setup
   * (at most two in one action, then the rest as Playwright sends it); for a hover, the path's samples outside the target
   * before the setup and the rest at Playwright's move; then the setup itself, whose answer the stage watches.
   */
  private async setupStep(page: StagePage, st: TabState, e: Entry): Promise<void> {
    const [, nodeArg, opts] = (Array.isArray(e.util?.args[0]) ? e.util!.args[0] : []) as [unknown, Handle | undefined, any];
    const node = nodeArg?.handle;
    const action = String(opts?.actionType ?? ""), trial = opts?.trial === true;
    const hit = opts?.hitPoint && typeof opts.hitPoint.x === "number" && typeof opts.hitPoint.y === "number" ? { x: opts.hitPoint.x, y: opts.hitPoint.y } : null;
    // A miss marks the tab for the next setup of its node within RETRY_MARK_MS; one action's recoveries are the setups of
    // one node that each follow such a miss. A setup with no such miss starts a new count.
    const marked = st.miss && this.clock.now() - st.missAt <= RETRY_MARK_MS && st.missNode === node;
    st.miss = false;
    if (!st.recov || st.recov.node !== node || !marked) st.recov = { node, n: 0 };
    // The plain mode covers one attempt: from this setup to its own miss, its stop's answer, or the end of the stage's action.
    st.plain = false;
    st.setup = { node, child: e.child, action, hit, trial, used: false };
    st.spread = null; this.dropRest(st);
    const live = !st.action?.over;
    let stopped = false;
    if (live && !trial && hit && node) {
      if (marked) {
        if (st.recov.n >= RECOVERIES_MAX) {
          if (!st.recov.limited) { st.recov.limited = true; this.count("recoveryLimits"); this.o.log(`relay: the input stage: tab ${page.id} reached ${RECOVERIES_MAX} recoveries in one action; each later attempt goes as the client sends it`); }
          this.count("plainAttempts");
          st.plain = true;
        } else {
          st.recov.n++;
          // A refused move of the recovery stops the plan (C11, an error of an event): no hover path, no new action.
          stopped = !(await this.recover(page, st, e, node, hit));
        }
      }
      if (action === "hover" && !st.plain && !stopped) await this.hoverBefore(page, st, e, node, hit);
    }
    this.count("setups");
    if (this.o.trace) this.o.log(`relay: the input stage: tab ${page.id}: a setup of ${action || "?"}${trial ? " (trial)" : ""}, ${st.recov.n} recoveries of its node${st.plain ? ", plain" : ""}`);
    await page.pass(e.child, e.method, e.params, (body: any) => {
      const r = body?.result?.result;
      // A miss of the setup ends its attempt (Playwright sends no input for it), so its plain mode ends too.
      if (r?.type === "string") { st.miss = true; st.missAt = this.clock.now(); st.missNode = node; st.plain = false; this.count("setupMisses"); }
      else if (typeof r?.objectId === "string") {
        st.handles.delete(r.objectId); st.handles.set(r.objectId, node);
        while (st.handles.size > KEPT_MAX) st.handles.delete(st.handles.keys().next().value!);
      }
      // A kept rest waits for Playwright's move from the setup's answer on (a miss: Playwright sends no move).
      if (st.rest) { if (r?.type === "string") { this.dropRest(st); if (!st.running) void this.afterStep(page, st); } else this.keepRest(page, st); }
      e.answer(body);
    });
  }

  /**
   * The frame mapping (C11): the node's box and its frame's offset in the top page's points. Same-origin levels by one
   * read in Playwright's utility world on the node's handle; each cross-origin level by its owner on the parent's session
   * (DOM.getFrameOwner) and the owner's content box there. Null when a read fails, a frame has a transform, or the
   * owner's quad is not a rectangle (the stage then fails open).
   */
  private async nodeGeo(page: StagePage, st: TabState, child: string | undefined, node: string): Promise<{ ox: number; oy: number; box: Rect } | null> {
    const g = await this.read(page.send(child, "Runtime.callFunctionOn", { objectId: node, functionDeclaration: NODE_GEO, returnByValue: true }));
    return this.mapped(page, st, child, g === TIMEOUT ? null : (g as any)?.result?.value);
  }

  /** The cross-origin levels of a same-origin read (NODE_GEO's, FIELD_STATE's): the node's box and offset in the top page's points, or null. */
  private async mapped(page: StagePage, st: TabState, child: string | undefined, v: any): Promise<{ ox: number; oy: number; box: Rect; levels: { parent: string | undefined; owner: number; r: Rect }[] } | null> {
    if (!v || typeof v.ox !== "number" || !v.box || v.flat === false) return null;
    let ox = v.ox, oy = v.oy, s = child;
    const levels: { parent: string | undefined; owner: number; r: Rect }[] = [];
    if (!s && !v.top) return null;
    for (let level = 0; s && level < 8; level++) {
      let f = st.frames.get(s);
      if (!f) {
        // No attach record of this session: its own target info names the frame; its parent is the tab's own session.
        const info = await this.read(page.send(s, "Target.getTargetInfo", {}));
        const id = info === TIMEOUT ? undefined : (info as any)?.targetInfo?.targetId;
        if (typeof id !== "string") { this.count("frameMapFails"); return null; }
        f = { frameId: id, parent: undefined };
        st.frames.set(s, f);
      }
      const owner = await this.read(page.send(f.parent, "DOM.getFrameOwner", { frameId: f.frameId }));
      const backendNodeId = owner === TIMEOUT ? undefined : (owner as any)?.backendNodeId;
      if (!Number.isInteger(backendNodeId)) return null;
      const box = await this.read(page.send(f.parent, "DOM.getBoxModel", { backendNodeId }));
      const r = box === TIMEOUT ? null : quadRect((box as any)?.model?.content);
      if (!r) return null;
      ox += r.x0; oy += r.y0;
      levels.push({ parent: f.parent, owner: backendNodeId, r });
      s = f.parent;
    }
    if (s) return null;
    const b = v.box as Rect;
    return { ox, oy, box: { x0: b.x0 - v.ox + ox, y0: b.y0 - v.oy + oy, x1: b.x1 - v.ox + ox, y1: b.y1 - v.oy + oy }, levels };
  }

  /**
   * The hover (C11, the pointer): at the setup the stage plans the whole path to Playwright's point (mapped to the top
   * page), sends its samples outside the target's box, and keeps the rest (from its first sample inside the box) for
   * Playwright's move. When the pointer is inside the box already, the whole path goes after the setup. A failed mapping:
   * no path before the setup (the naive way, a retry of Playwright's), and the stage counts it.
   */
  private async hoverBefore(page: StagePage, st: TabState, e: Entry, node: string, hit: Pt): Promise<void> {
    const geo = await this.nodeGeo(page, st, e.child, node);
    if (!geo) { this.count("hoverNaive"); return; }
    const to = this.fit({ x: hit.x + geo.ox, y: hit.y + geo.oy });
    const a = await this.begin(page, st);
    if (a.over) return;
    let from = this.from(page, st) ?? await this.startOf(page);
    if (!from || same(from, to)) return;
    const box = geo.box, samples = this.plan(page, st, from, to, Math.max(1, Math.min(box.x1 - box.x0, box.y1 - box.y0)));
    if (inside(from, box)) { st.rest = { to, from, samples }; return; }
    const i = samples.findIndex((q) => inside(q, box));
    const before = i < 0 ? samples : samples.slice(0, i);
    const r = await this.play(page, st, a, before, { modifiers: 0 });
    if (r.error !== undefined) { this.stopPlan(page, st, "Input.dispatchMouseEvent", r.error); this.freeTail(st); this.close(st, page.id); return; }
    if (r.stopped) return;
    if (i < 0) return;
    if (before.length) from = st.last!;
    const t0 = i > 0 ? samples[i - 1].t : 0;
    st.rest = { to, from, samples: samples.slice(i).map((q) => ({ ...q, t: q.t - t0 })) };
    this.count("hoverPathsBeforeSetup");
  }

  /**
   * The recovery at the next setup of a marked tab (C11): the element at the hit point, when it is not the target or inside
   * it; its highest ancestor that does not hold the target; a path out of both boxes, on the side away from the target, to
   * a point 15 px outside; two frames; the ancestor's box again, which the next path goes around.
   */
  private async recover(page: StagePage, st: TabState, e: Entry, node: string, hit: Pt): Promise<boolean> {
    const found = await this.read(page.send(e.child, "Runtime.callFunctionOn", { objectId: node, functionDeclaration: OBSTACLE_FIND, arguments: [{ value: hit.x }, { value: hit.y }], returnByValue: false }));
    const handle = found === TIMEOUT ? undefined : (found as any)?.result?.objectId;
    if (typeof handle !== "string") return true;
    try {
      const geo = await this.nodeGeo(page, st, e.child, node);
      if (!geo && e.child) return true;
      const ox = geo?.ox ?? 0, oy = geo?.oy ?? 0;
      const both = await this.read(page.send(e.child, "Runtime.callFunctionOn", { objectId: handle, functionDeclaration: OBSTACLE_BOTH, returnByValue: true }));
      const b = both === TIMEOUT ? null : (both as any)?.result?.value as Rect | null;
      if (!b) return true;
      const box = { x0: b.x0 + ox, y0: b.y0 + oy, x1: b.x1 + ox, y1: b.y1 + oy }, H = { x: hit.x + ox, y: hit.y + oy };
      this.count("recoveries");
      this.o.log(`relay: the input stage: a recovery in tab ${page.id} after a miss of the hit-target check`);
      const a = await this.begin(page, st);
      if (a.over) return true;
      const at = this.from(page, st) ?? { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 };
      const lm = await this.read(page.send(undefined, "Page.getLayoutMetrics", {}));
      const v = lm === TIMEOUT ? null : (lm as any)?.cssLayoutViewport;
      const W = v?.clientWidth > 0 ? v.clientWidth : Infinity, Hh = v?.clientHeight > 0 ? v.clientHeight : Infinity;
      const exits = [{ x: box.x0 - RECOVERY_EXIT_PX, y: at.y }, { x: box.x1 + RECOVERY_EXIT_PX, y: at.y }, { x: at.x, y: box.y0 - RECOVERY_EXIT_PX }, { x: at.x, y: box.y1 + RECOVERY_EXIT_PX }]
        .map((q) => this.fit(q)).filter((q) => q.x >= 2 && q.y >= 2 && q.x <= W - 3 && q.y <= Hh - 3)
        .sort((p, q) => Math.hypot(q.x - H.x, q.y - H.y) - Math.hypot(p.x - H.x, p.y - H.y));
      if (exits[0] && !same(at, exits[0])) {
        const r = await this.play(page, st, a, this.plan(page, st, at, exits[0], DEFAULT_WIDTH), { modifiers: 0 });
        if (r.error !== undefined) { this.stopPlan(page, st, "Input.dispatchMouseEvent", r.error); this.freeTail(st); this.close(st, page.id); return false; }
        if (r.stopped) return true;
      }
      await this.read(page.send(e.child, "Runtime.callFunctionOn", { objectId: handle, functionDeclaration: TWO_FRAMES, awaitPromise: true, returnByValue: true }));
      const again = await this.read(page.send(e.child, "Runtime.callFunctionOn", { objectId: handle, functionDeclaration: OBSTACLE_AGAIN, returnByValue: true }));
      const k = again === TIMEOUT ? null : (again as any)?.result?.value as Rect | null;
      if (k) st.avoid = { x0: k.x0 + ox, y0: k.y0 + oy, x1: k.x1 + ox, y1: k.y1 + oy };
      return true;
    } finally {
      void page.send(e.child, "Runtime.releaseObject", { objectId: handle }).catch(() => {});
    }
  }
}
