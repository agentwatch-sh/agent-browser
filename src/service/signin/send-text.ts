// The Browser pane's text of a sign-in send (stage 1c, board ab-v16.94.4; C4 choice 6, C6 step 5): the port of
// agentwatch's daemon/browser/service.py `send_text` and its SEND_* texts. The service answers a failed `import` with
// this text, which the sender shows.

/** The import's steps (C6; `step(...)` of the receiver's agent/importer.js): the cookie swap is the second step. */
export const SEND_STEPS_BEFORE_SWAP: readonly string[] = ["close tabs"];
export const SEND_STEP_SWAP = "cookies";
export const SEND_STEPS_AFTER_SWAP: readonly string[] = ["open tab", "rules", "attach", "fetch enable", "restore page", "codec", "write storage", "detach", "navigate", "end rules"];
/** The error of an import that got no answer in time, or whose link dropped while it ran: a part can have gone. */
export const TIMEOUT = "timeout";
/** The error of an import with no receiver at its start: nothing went. */
export const NOT_CONNECTED_TEXT = "the agent extension is not connected";
/** How long an import waits for the receiver's hello, and its error after that wait. */
export const RECEIVER_WAIT_MS = 45_000;
export const RECEIVER_MISSING_TEXT = "The agent extension of the agent browser did not connect in 45 s.";
/** The sender keeps at most this many UTF-16 code units of the box's text (chrome-extension operator/send.js MAX_DETAIL). */
export const SEND_TEXT_MAX = 300;
/** A text that would be longer shows a long domain as "…" and its last characters, and then cuts an error. */
export const SEND_DOMAIN_SHOWN = 64;
const LOWERED_FIRST_WORDS = ["The", "A", "An"];

const SENT = (d: string) => `The sign-in for ${d} was sent. It is on no repo's list: add the site to the lists of the repos whose agents need it.`;
const AFTER_SWAP = (d: string, s: string) => `The sign-in for ${d} was sent, but the import did not complete: the step "${s}" failed after the cookies were set, so the site's page storage can be missing.`;
const SWAP = (d: string, s: string) => `The sign-in for ${d} failed during the step "${s}": its cookies in the agent browser can be partly replaced. Send it again.`;
const BEFORE_SWAP = (d: string, s: string) => `The sign-in for ${d} was not sent: the step "${s}" failed (a page of the site stayed open). Nothing changed.`;
const TIMED_OUT = (d: string) => `The agent browser did not answer the sign-in for ${d} in time: it can be sent in part or in full.`;
const NOT_SENT = (d: string, e: string) => `The sign-in for ${d} was not sent: ${e}.`;

/** `text` in at most `room` UTF-16 code units, with "…" at its end when cut (never in the middle of a code point). */
function cutTo(text: string, room: number): string {
  if (text.length <= room) return text;
  const points = Array.from(text).slice(0, Math.max(0, room - 1));
  let out = points.join("");
  while (out && out.length > room - 1) { points.pop(); out = points.join(""); }
  return out.trimEnd() + "…";
}

function sendText0(domain: string, error: string | null): { sent: boolean; text: string } {
  if (error === null) return { sent: true, text: SENT(domain) };
  if (SEND_STEPS_AFTER_SWAP.includes(error)) return { sent: true, text: AFTER_SWAP(domain, error) };
  if (error === SEND_STEP_SWAP) return { sent: false, text: SWAP(domain, error) };
  if (SEND_STEPS_BEFORE_SWAP.includes(error)) return { sent: false, text: BEFORE_SWAP(domain, error) };
  if (error === TIMEOUT) return { sent: false, text: TIMED_OUT(domain) };
  // A text that ends with a full stop gets no second one.
  let detail = error.trim().replace(/\.+$/, "").trimEnd();
  if (!detail) return { sent: false, text: `The sign-in for ${domain} was not sent.` };
  const first = detail.split(" ", 1)[0];
  if (LOWERED_FIRST_WORDS.includes(first)) detail = first.toLowerCase() + detail.slice(first.length);
  return { sent: false, text: NOT_SENT(domain, detail) };
}

/**
 * Whether the sign-in for `domain` went to the agent browser, and the pane's text for it. `error` is null for a send
 * that went, else a step name (the receiver's ok:false answer), TIMEOUT, or any other text (nothing went). A step after
 * the cookie swap counts as sent. Every text fits in SEND_TEXT_MAX.
 */
export function sendText(domain: string, error: string | null): { sent: boolean; text: string } {
  let r = sendText0(domain, error);
  if (r.text.length > SEND_TEXT_MAX && domain.length > SEND_DOMAIN_SHOWN) r = sendText0("…" + domain.slice(-(SEND_DOMAIN_SHOWN - 1)), error);
  if (r.text.length > SEND_TEXT_MAX) {
    const points = Array.from(r.text);
    r = { sent: r.sent, text: cutTo(points.slice(0, -1).join(""), SEND_TEXT_MAX - 1) + "." };
  }
  return r;
}
