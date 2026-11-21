// The fakes of the payment act after the approval (board ab-sta.7, the plan's Task 5b), on top of PayBrowser
// (pay-act-fakes.ts): the act page's fields with their values and boxes, the focus that a click gives, the keys and the
// inserted texts that reach the focused field, the save-card boxes, the pay button and what its press does (a
// confirmation, a decline, a bank's step, nothing), the provider frame's own requests, a provider frame that loads again,
// and the act window's tabs. The pages' texts are the test merchant's (test/fixtures/pay-merchant/). Every value here is
// a made-up TEST value, and the card is a provider's published test card (pay-test-cards.ts).

import { readFileSync } from "node:fs";
import { middlePerson, paramsFor, type Params, type Person } from "../src/human/person.ts";
import { seededRandom } from "../src/human/random.ts";
import { PayAct, type PayFillLimits } from "../src/service/pay/pay-act.ts";
import type { FieldRead } from "../src/service/pay/fields.ts";
import { ACT_TAB, CARD_FIELDS, checkoutPage, field, PayBrowser, SHOP, STRIPE, type FakeFrame, type FakePage } from "./pay-act-fakes.ts";

const DIR = new URL("./fixtures/pay-merchant/", import.meta.url);
/** The text lines of a test merchant's page as a browser shows its paragraphs, list items and headings. */
export function merchantLines(path: string): string[] {
  const html = readFileSync(new URL(path, DIR), "utf8");
  return [...html.matchAll(/<(li|p|h1|label|button)[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => m[2].replace(/<[^>]+>/g, "").replace(/&times;/g, "×").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim()).filter(Boolean);
}
export const merchantTitle = (path: string) => /<title>([^<]*)<\/title>/.exec(readFileSync(new URL(path, DIR), "utf8"))?.[1] ?? "";

/**
 * A fast person for the tests: the population's middle person, with a copy of the Linux parameters whose paths, pauses,
 * holds and keys are short (the act's code paths stay the person's; only the times are short).
 */
const FAST: Params = (() => {
  const p = structuredClone(paramsFor("linux"));
  p.path.fitts = { ...p.path.fitts, aMs: 10, bMs: 5, minMs: 20, maxMs: 60 };
  p.path.overshoot = { ...p.path.overshoot, backMinMs: 10, maxMs: 60 };
  p.press.pauseMs = { lognormal: [3, 0.1], min: 1, max: 6 };
  p.press.holdMs = { lognormal: [5, 0.1], min: 2, max: 10 };
  p.keys.holdMs = { lognormal: [5, 0.1], min: 2, max: 10 };
  return p;
})();
export const fastPerson = (): Person => ({ ...middlePerson(FAST), keySpeed: 0.05 });

/** A button of the act page (READ_BUTTONS' shape without the index). */
export type FakeButton = { text: string; submit?: boolean; cardForm?: boolean; visible?: boolean; enabled?: boolean };
/** A frame with its text (READ_VIEW). */
export type FillFrame = FakeFrame & { lines?: string[]; title?: string; buttons?: FakeButton[]; alerts?: string[] };
/** `alerts`: the lines of the page's alert and status regions (READ_VIEW), where a page names an error near its card fields. */
export type FillPage = FakePage & { buttons?: FakeButton[]; title?: string; frames: FillFrame[]; alerts?: string[] };

/** The provider frame's save-card box (the test merchant's: checked, its label says save the card). */
export const SAVE_BOX = field(4, { type: "checkbox", label: "save this card for future purchases" });
export const PROVIDER = (o: Partial<FillFrame> = {}): FillFrame => ({ id: "PF1", url: `${STRIPE}/v3/elements-inner-card.html`, fields: [...CARD_FIELDS, SAVE_BOX], oop: true, lines: ["Card number", "Expiry (MM/YY)", "Security code", "ZIP code"], ...o });
/** The checkout of the act page: the test merchant's lines and its pay button, with the provider's frame. */
export const fillCheckout = (o: Partial<FillPage> = {}): FillPage => ({ ...checkoutPage(), frames: [PROVIDER()], buttons: [{ text: "pay $51.00" }], title: "Checkout - Test Shop", ...o }) as FillPage;

/** The box of field `i` of a frame or of the main frame, and of button `j` of the main frame (the fake's layout). */
const fieldBox = (i: number) => ({ x: 20, y: 20 + 40 * i, w: 200, h: 30 });
const buttonBox = (j: number) => ({ x: 20, y: 600 + 40 * j, w: 150, h: 30 });
const frameAt = (k: number) => ({ x: 600, y: 50 + 360 * k, w: 440, h: 330 });
const inside = (p: { x: number; y: number }, b: { x: number; y: number; w: number; h: number }) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;

/** One typed text and its target: a frame (`main` or a frame's id) and a field. */
export type Typed = { frame: string; field: number; text: string; how: "key" | "insert" };

export class FillBrowser extends PayBrowser {
  /** Each field's value, by frame (`main` or a frame's id) and field index. */
  readonly values = new Map<string, Map<number, string>>();
  /** Each checkbox's state, by frame and field index (a field with no entry is checked when its label says save). */
  readonly checked = new Map<string, Map<number, boolean>>();
  /**
   * The focus, for each document as a browser keeps it (review-228 B1): the main document's active element (one of its
   * fields, or a frame's owner element), and each frame's own active field, which the frame keeps when the main
   * document takes the focus. Keys and inserted texts go to the focused frame's active field.
   */
  mainFocus: { field: number } | { frame: string } | null = null;
  readonly docFocus = new Map<string, number>();
  /** The focused field that a key reaches now, or null. */
  get focus(): { frame: string; field: number } | null {
    const m = this.mainFocus;
    if (m === null) return null;
    if ("field" in m) return { frame: "main", field: m.field };
    const i = this.docFocus.get(m.frame);
    return i === undefined ? null : { frame: m.frame, field: i };
  }
  /** A page's script takes the focus to a field of the main document (as `hidden.focus()` does); each frame keeps its own active field. */
  takeFocus(i: number): void { this.mainFocus = { field: i }; this.rec("take focus", i); }
  /** windows.get fails (review-228 N5). */
  windowsGetFails = false;
  /** Fetch.enable fails in each child session of these types (review-228 N6). */
  readonly fetchFails = new Set<string>();
  /** Each read of the pay button's box (BUTTON_AT): a test's hook (review-228 N4). */
  onButtonBox: () => void = () => {};
  readonly typed: Typed[] = [];
  readonly presses: string[] = [];
  readonly cleared: string[] = [];
  /** What the press of the pay button does. */
  onPress: (b: FillBrowser) => void = () => {};
  /** A test's hook at each typed character (its count from 1). */
  onType: (n: number) => void = () => {};
  /** The tabs of the act window (windows.get with populate). */
  windowTabs: number[] = [ACT_TAB];
  /** The options of a select field, by frame and field index. */
  readonly options = new Map<string, string[]>();

  get fillPage(): FillPage | null { return this.page as FillPage | null; }
  private frameKey(where: FakeFrame | "main"): string { return where === "main" ? "main" : where.id; }
  private fieldsOf(where: FakeFrame | "main"): FieldRead[] { return where === "main" ? this.page?.fields ?? [] : where.fields; }
  value(frame: string, i: number): string { return this.values.get(frame)?.get(i) ?? ""; }
  isChecked(frame: string, f: FieldRead): boolean {
    const m = this.checked.get(frame);
    return m?.has(f.i) ? m.get(f.i)! : /save/.test(f.label);
  }
  private setValue(frame: string, i: number, v: string): void {
    let m = this.values.get(frame);
    if (!m) this.values.set(frame, (m = new Map()));
    m.set(i, v);
  }

  protected override moreEval(tag: string | undefined, args: () => any[], where: FakeFrame | "main"): any {
    const key = this.frameKey(where), fields = this.fieldsOf(where);
    switch (tag) {
      case "/*aw-pay:at*/": {
        const [i] = args() as [number, number];
        this.rec("at", { frame: key, i });
        const f = fields.find((x) => x.i === i);
        return f && f.visible ? fieldBox(i) : null;
      }
      case "/*aw-pay:focus*/": {
        const [i] = args() as [number];
        if (key === "main") return this.mainFocus !== null && "field" in this.mainFocus && this.mainFocus.field === i;
        return this.docFocus.get(key) === i;
      }
      case "/*aw-pay:save*/":
        this.rec("save read", key);
        return fields.filter((f) => f.type === "checkbox").map((f) => ({ i: f.i, checked: this.isChecked(key, f), disabled: !f.enabled, label: f.label }));
      case "/*aw-pay:buttons*/": {
        const list = where === "main" ? this.fillPage?.buttons ?? [] : (where as FillFrame).buttons ?? [];
        return list.map((b, i) => ({ i, text: b.text, submit: b.submit ?? false, cardForm: b.cardForm ?? false, visible: b.visible ?? true, enabled: b.enabled ?? true }));
      }
      case "/*aw-pay:press*/": { const [i] = args() as [number]; this.onButtonBox(); return where === "main" && (this.fillPage?.buttons ?? [])[i] ? buttonBox(i) : null; }
      case "/*aw-pay:select*/": {
        const [i, wants] = args() as [number, string];
        const opts = this.options.get(`${key} ${i}`) ?? [];
        const w = JSON.parse(wants) as string[];
        const o = opts.find((x) => w.includes(x));
        this.rec("select", { frame: key, i });
        if (o === undefined) return false;
        this.setValue(key, i, o);
        return true;
      }
      case "/*aw-pay:clear*/": {
        this.cleared.push(key);
        this.rec("clear", key);
        const m = this.values.get(key);
        const n = m ? [...m.values()].filter((v) => v !== "").length : 0;
        this.values.delete(key);
        return n;
      }
      case "/*aw-pay:view*/":
        if (where === "main") return { url: this.current, title: this.fillPage?.title ?? "", lines: this.page?.lines ?? [], alerts: this.fillPage?.alerts ?? [], code: (this.page?.fields ?? []).some((f) => f.autocomplete.includes("one-time-code")) };
        return { url: where.url, title: (where as FillFrame).title ?? "", lines: (where as FillFrame).lines ?? [], alerts: (where as FillFrame).alerts ?? [], code: where.fields.some((f) => f.autocomplete.includes("one-time-code")) };
    }
    return undefined;
  }

  protected override moreCdp(method: string, params: any, session: string | undefined): any {
    if (session !== undefined) {
      if (method === "Fetch.enable" && this.fetchFails.has(this.workers.has(session) ? "worker" : "iframe")) throw new Error(this.fetchFailText);
      // A key on a frame's own session (board ab-sta.8, as Chromium does it live): it reaches the frame's active field only
      // while the frame has the page's focus; once a page script takes the focus, the frame's field is no longer active.
      if (method === "Input.dispatchKeyEvent" || method === "Input.insertText") {
        const f = this.attached.get(session);
        this.keySessions.push(session);
        const text = method === "Input.insertText" ? String(params.text) : params.type === "keyDown" && typeof params.text === "string" ? params.text : null;
        this.rec(method === "Input.insertText" ? "insert" : "key", method === "Input.insertText" ? undefined : params.type);
        if (text === null) return {};
        const m = this.mainFocus, i = f ? this.docFocus.get(f.id) : undefined;
        if (f && m !== null && "frame" in m && m.frame === f.id && i !== undefined) this.typeAt({ frame: f.id, field: i }, text, method === "Input.insertText" ? "insert" : "key");
        else this.lostKeys += text.length;
        return {};
      }
      if (method === "Fetch.continueRequest" || method === "Fetch.failRequest") {
        const how = method === "Fetch.continueRequest" ? "continue" : "fail";
        this.rec(`child ${method}`, { requestId: params.requestId, session });
        this.answers.set(params.requestId, how);
        this.paused.get(params.requestId)?.(how);
        this.paused.delete(params.requestId);
        return {};
      }
      return undefined;
    }
    switch (method) {
      case "DOM.getFrameOwner": {
        const k = (this.page?.frames ?? []).findIndex((f) => f.id === params.frameId);
        this.rec("owner", params.frameId);
        if (k < 0) throw new Error("Frame with the given id was not found.");
        return { backendNodeId: 1000 + k, nodeId: 0 };
      }
      case "DOM.getBoxModel": {
        const b = frameAt(params.backendNodeId - 1000);
        return { model: { content: [b.x, b.y, b.x + b.w, b.y, b.x + b.w, b.y + b.h, b.x, b.y + b.h], width: b.w, height: b.h } };
      }
      case "DOM.resolveNode": {
        this.rec("resolve", params.backendNodeId);
        return { object: { type: "object", subtype: "node", objectId: `owner-${params.backendNodeId}` } };
      }
      case "Runtime.callFunctionOn": {
        // The act's own check of the main document's focus on a frame's owner element.
        if (!/\/\*aw-pay:owner\*\//.test(String(params.functionDeclaration))) throw new Error("a fake function with no tag");
        const k = Number(/^owner-(\d+)$/.exec(String(params.objectId))?.[1]) - 1000;
        const f = (this.page?.frames ?? [])[k];
        if (!f) throw new Error("Could not find object with given id");
        const owns = this.mainFocus !== null && "frame" in this.mainFocus && this.mainFocus.frame === f.id;
        queueMicrotask(() => this.onOwnerCheck(++this.ownerChecks));
        return { result: { type: "boolean", value: owns } };
      }
      case "Input.dispatchMouseEvent": this.mouse(params); this.rec("mouse", params.type); return {};
      case "Input.dispatchKeyEvent": {
        this.keySessions.push("main");
        this.rec("key", params.type);
        if (params.type === "keyDown" && typeof params.text === "string") this.type(params.text, "key");
        return {};
      }
      case "Input.insertText": this.keySessions.push("main"); this.rec("insert"); this.type(String(params.text), "insert"); return {};
    }
    return undefined;
  }

  protected override moreWindow(args: any[]): Record<string, unknown> {
    if (this.windowsGetFails && args[1]?.populate) throw new Error("No window with id");
    return args[1]?.populate ? { tabs: this.windowTabs.map((id) => ({ id, windowId: args[0], incognito: true })) } : {};
  }

  private pressedAt: { x: number; y: number } | null = null;
  private mouse(p: any): void {
    if (p.type !== "mousePressed" && p.type !== "mouseReleased") return;
    const at = { x: p.x, y: p.y };
    if (p.type === "mousePressed") {
      this.pressedAt = at;
      const frames = this.page?.frames ?? [];
      for (const [k, f] of frames.entries()) {
        const fr = frameAt(k);
        if (!inside(at, fr)) continue;
        const local = { x: at.x - fr.x, y: at.y - fr.y };
        const hit = f.fields.find((x) => inside(local, fieldBox(x.i)));
        this.mainFocus = { frame: f.id };
        if (!hit) { this.docFocus.delete(f.id); return; }
        if (hit.type === "checkbox") { if (hit.enabled) this.toggle(f.id, hit); return; }
        this.docFocus.set(f.id, hit.i);
        return;
      }
      const hit = (this.page?.fields ?? []).find((x) => inside(at, fieldBox(x.i)));
      this.mainFocus = hit ? { field: hit.i } : null;
      return;
    }
    const from = this.pressedAt;
    this.pressedAt = null;
    const j = (this.fillPage?.buttons ?? []).findIndex((_, i) => inside(at, buttonBox(i)) && from !== null && inside(from, buttonBox(i)));
    if (j >= 0) { this.presses.push(this.fillPage!.buttons![j].text); this.onPress(this); }
  }

  private toggle(frame: string, f: FieldRead): void {
    let m = this.checked.get(frame);
    if (!m) this.checked.set(frame, (m = new Map()));
    m.set(f.i, !this.isChecked(frame, f));
    this.rec("toggle", { frame, i: f.i });
  }

  private typedCount = 0;
  private type(text: string, how: "key" | "insert"): void { this.typeAt(this.focus, text, how); }
  private typeAt(f: { frame: string; field: number } | null, text: string, how: "key" | "insert"): void {
    this.typed.push({ frame: f?.frame ?? "none", field: f?.field ?? -1, text, how });
    if (f) this.setValue(f.frame, f.field, this.value(f.frame, f.field) + text);
    for (const _ of text) this.onType(++this.typedCount);
  }
  /** The session of each key event and text insert: "main" (the act tab's own) or a frame's session (board ab-sta.8). */
  readonly keySessions: string[] = [];
  /** The characters of keys on a frame's session that reached no field (the frame had lost the page's focus). */
  lostKeys = 0;
  /** A test's hook after each answer of the act's check of the page's focus on a frame (its count from 1). */
  onOwnerCheck: (n: number) => void = () => {};
  private ownerChecks = 0;
  /** The error of a Fetch.enable that fails on a child's session. */
  fetchFailText = "Fetch is not available";

  /** The text that went into each field (frame and index), joined. */
  typedInto(frame: string, i: number): string { return this.typed.filter((t) => t.frame === frame && t.field === i).map((t) => t.text).join(""); }

  // ---- the page's own acts

  /** The main frame loads another page (a confirmation): through the act's Fetch, as a navigation does. */
  goTo(url: string, page: FillPage): void { this.pages.set(url, page); void this.navigate(url); }
  /** A provider frame loads again: its session's worlds go, its fields empty, its frame navigates. */
  reloadFrame(id: string): void {
    const session = `S-${id}`;
    for (const [ctx, w] of [...this.worlds]) if (w.session === session) this.worlds.delete(ctx);
    this.values.delete(id);
    this.docFocus.delete(id);
    const f = this.page?.frames.find((x) => x.id === id);
    this.rec("reload", id);
    this.cdp("Page.frameNavigated", { frame: { id, url: f?.url ?? "about:blank" } }, session);
  }
  /** A worker of the act page, attached as Chrome attaches it (its own session). */
  readonly workers = new Set<string>();
  addWorker(id: string): string {
    const sessionId = `S-${id}`;
    this.workers.add(sessionId);
    this.attached.set(sessionId, { id, url: `${SHOP}/worker.js`, fields: [], oop: true });
    this.cdp("Target.attachedToTarget", { sessionId, targetInfo: { targetId: id, type: "worker", url: `${SHOP}/worker.js` }, waitingForDebugger: true });
    return sessionId;
  }
  /** A new out-of-process frame of the page (a bank's step), attached as Chrome attaches it. */
  addFrame(f: FillFrame): void { this.page!.frames.push(f); this.attachFrame(f); }
  /** A paused request of a frame's session (its own requests: the provider's API, an attack); the act's answer resolves it. */
  requestIn(session: string | undefined, url: string, o: { method?: string; postData?: string; hasPostData?: boolean; resourceType?: string } = {}): Promise<string> {
    const requestId = `Q${this.nextReq++}`;
    return new Promise((resolve) => {
      this.paused.set(requestId, resolve);
      this.cdp("Fetch.requestPaused", { requestId, request: { url, method: o.method ?? "GET", ...(o.postData !== undefined ? { postData: o.postData, hasPostData: true } : {}), ...(o.hasPostData ? { hasPostData: true } : {}) }, resourceType: o.resourceType ?? "Fetch", frameId: "PF1" }, session);
    });
  }
  /** A WebSocket of the act page (Network.webSocketCreated), as the page opens it during its load. */
  socket(url: string, session?: string): void { this.cdp("Network.webSocketCreated", { requestId: `W${this.nextReq++}`, url }, session); }

  /** The act over this world, with short waits and a fast person. */
  payAct(o: { providerOrigins?: readonly string[]; limits?: Partial<PayFillLimits>; logs?: string[] } = {}): PayAct {
    return new PayAct({
      model: { call: this.model.call, listen: this.model.listen, inputLock: async (fn) => { this.rec("lock"); try { return await fn(); } finally { this.rec("unlock"); } }, person: fastPerson, random: seededRandom(11) },
      receiver: this.receiver, log: (l) => (o.logs ?? this.logs).push(l),
      ...(o.providerOrigins ? { providerOrigins: o.providerOrigins } : {}),
      limits: { resultMs: 1500, settleMs: 20, pollMs: 20, receiverMs: 200, queueMs: 100, ...o.limits },
    });
  }
}

/** The act page after the press: the test merchant's confirmation (its lines), on the shop's origin. */
export const CONFIRMATION = `${SHOP}/confirmation.html`;
export const confirmation = (file = "shop/confirmation.html"): FillPage => ({ lines: merchantLines(file), fields: [], frames: [], requests: [], title: merchantTitle(file) }) as FillPage;
