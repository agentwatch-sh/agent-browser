// The card payment's texts (contract C11, the card payment, the table of what the agent sees; board ab-sta.5). Each
// text is C11's, word for word: `<x>` is a value that the service fills in. A text of the state `stopped` comes to the
// agent as `Not paid: <text>`; `pay_result` (C12) and the keep hold the text alone.

export type PayState = "paid" | "declined" | "unknown" | "stopped";

export const PAY_TEXT = {
  paid: (amount: string, currency: string, origin: string, number: string) => `Paid: ${amount} ${currency} to ${origin}, order ${number}`,
  paidNoNumber: (amount: string, currency: string, origin: string) => `Paid: ${amount} ${currency} to ${origin}, order number not found`,
  paidOther: (amount: string) => `Paid, but the merchant's confirmation shows ${amount}`,
  declined: "Declined by the card's bank or the merchant",
  bankStep: "The card's bank asked for a second step. The payment's result is unknown: check the merchant's account before you buy by hand.",
  unknown: "The payment's result is unknown. Do not pay again: check the merchant's mail or account.",
  remote: "Payments work only for sessions of this box.",
  amount: "The amount must be a decimal number above 0 with at most two decimals.",
  currency: "The currency must be a code of three capital letters.",
  description: "The description must be a text of at most 500 characters.",
  key: (key: "card" | "origin" | "button") => `The ${key} of the payment request is not valid.`,
  locked: "The stored sign-ins and cards are locked. The operator unlocks them in the Browser pane.",
  noCard: (name: string) => `There is no stored card named ${name}.`,
  cardCannotOpen: "The stored card cannot be opened. The operator adds it again.",
  notAllowed: (host: string) => `Not allowed: ${host} is not on the allowlist`,
  oneTab: (origin: string) => `Exactly one tab of this session must show the checkout of ${origin}.`,
  hostedPage: (origin: string) => `This checkout's payment page is on a payment provider's own site, and the agent browser cannot tie it to ${origin}. The operator buys it by hand.`,
  scopeWaits: "A payment request of this scope waits.",
  busy: "Another payment or sign-in runs now. Try again in a minute.",
  privateWindow: "Another private window is open in the agent browser.",
  noWindow: "The agent browser could not open the payment window.",
  copy: "The agent browser could not copy the checkout's session.",
  rules: "The agent browser could not hold the payment's rules.",
  noPaymentStep: "This checkout cannot move to the payment act",
  check: "The checkout asks for a check that the agent browser cannot pass.",
  noTotal: "The agent browser cannot read the total of this checkout.",
  otherTotal: (amount: string, currency: string) => `The checkout's total is not ${amount} ${currency}.`,
  fields: "This checkout's card fields are not in a known payment provider's frame",
  expired: "The operator did not answer the payment request within 10 minutes.",
  refused: "The operator refused this payment.",
  cancelled: "The agent cancelled the payment request.",
  mismatch: "This approval does not match the payment request",
  orderChanged: "The checkout's order changed after the approval: a new request asks the operator again.",
  keepsCard: "The checkout keeps the card, and the agent browser cannot turn that off.",
  frameLoaded: "The payment provider's frame loaded again during the fill.",
  totalChanged: "The checkout's total changed before the payment.",
  noButton: "The agent browser found no pay button on the checkout.",
  guard: "The checkout tried to send the card's number to a place where it does not belong.",
  lockedBefore: "The stored sign-ins and cards were locked before the payment.",
  keepFailed: "The agent browser could not keep a record of the payment, so it did not pay.",
  lostBefore: "The agent browser lost the payment window before the payment.",
  timeBefore: "The checkout did not reach the payment within 5 minutes.",
} as const;

/** The line after the text when the session copy ran (C11, what the agent sees). */
export const blockedLine = (domain: string) => `Your tabs could not reach ${domain} from the copy of the checkout to the end of the payment.`;

/** C12's `alert` of a `pay_result`: true for each `unknown` and for `Paid, but the merchant's confirmation shows <amount>`. */
export const alertOf = (state: PayState, text: string): boolean => state === "unknown" || (state === "paid" && text.startsWith("Paid, but the merchant's confirmation shows "));

/** The tool's answer for the agent (C11): `paid` is a tool result, each other state a tool error; `stopped` comes as `Not paid: <text>`. */
export function agentAnswer(state: PayState, text: string, domain: string | null): { text: string; isError: boolean } {
  const head = state === "stopped" ? `Not paid: ${text}` : text;
  return { text: domain ? `${head}\n${blockedLine(domain)}` : head, isError: state !== "paid" };
}
