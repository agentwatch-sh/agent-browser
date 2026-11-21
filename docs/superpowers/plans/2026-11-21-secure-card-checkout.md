# Secure card checkout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** an agent pays with the operator's stored card through `browser_pay`, the operator approves each purchase in the pane (`kind: operator`), and the service pays in its own act window; no card value ever reaches an agent.

**Architecture:** the stored sign-ins' parts (the sealed store, the pane seal, the incognito act window of the receiver, the block, the guard) get a second act kind, `pay`. The service copies the merchant's session into the act window before the approval, binds the approval to the page-order hash, fills only inside a provider frame, and keeps each result. agentwatch's parts (the card form, the approval screen, the Web Push, `pay_approve`'s client, the skill text) are the daemon lead's later work: this plan fixes only their contract.

**Tech Stack:** TypeScript on Node 26 (agent-browser), the receiver in plain JavaScript MV3 (chrome-extension), CDP, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-21-secure-card-checkout-design.md` (approved 2026-11-21, ab-lmv). Read it with this plan; the section numbers below are its sections.

## Global Constraints

- R1: the card number and the security code never enter an agent's context, an argv, a log, a page snapshot, a screenshot, a transcript, a mail or a board item.
- R2: each purchase needs the operator's own approval: `pay_approve` applies only with C12's `kind: operator`; every other kind gets "not the operator".
- R3: the agent gets only the result texts of spec section 8.7.
- R4: no real card number anywhere; tests use only the payment providers' published test card numbers on loopback test pages.
- First values: approval wait 10 min; an approval good for 10 min; the result window 60 s; results kept 24 h; `description` at most 500 characters; `amount` a decimal string with at most two decimals; `currency` three letters.
- The operator's answers: the store keeps the CVV; any changed total stops; any bank step stops (and counts as "Unknown" after the press); the card is in the stored sign-ins' store (kind `card`).
- A C11, C12, C4, C5 or C10 change merges only after the daemon lead's OK at its head. Each PR: one native builder, one review, one fix round, one re-check, `flock heavy.lock timeout -k 60 1800 npm test` on the exact tip, the privacy filter, no Claude credit.

## Review Focus

- Two `browser_pay` calls of one scope at the same time: the second gets "A payment request of this scope waits" (test in Task 4).
- A page whose text holds several amounts (subtotal, tax, fees, total): the reader takes the total line, and a page with two candidate totals stops with "cannot read the total" (test in Task 4).
- The service restarts (the store locks) between the approval and the press: the act stops before the press; after the press it is "Unknown" (test in Task 5).
- An approval that arrives after its request expired, or for a request of another scope: refused, no act (test in Task 4).
- A provider frame that reloads while the act types: the act stops and empties the fields, never types into the new frame without a new find (test in Task 5).

---

### Task 1: The contracts in agent-browser (C11, C12, vectors)

**Files:**
- Modify: `docs/contracts/C11.md` (the MCP tools: `browser_pay`, `browser_pay_status`; the result texts table; the `pay` event's blank of the live view)
- Modify: `docs/contracts/C12.md` (the record kind `card`; the ops `card_seal` and `pay_approve`, both `kind: operator` only; the daemon event `pay_request`; the event `pay`; the seal purpose `browser-pay` and its binding fields; `kind` in the seal's additional data)
- Modify: `src/service/mcp/allow-list.ts` (the two tools' keys and schemas), `test/vectors/mcp-allow-list.json`, `test/vectors/control.json`
- Create: this plan at `docs/superpowers/plans/2026-11-21-secure-card-checkout.md`
- Test: `test/contracts-c11.test.ts`, `test/contracts-c12.test.ts` (a new list `CARD_PAY` that quotes each new sentence)

**Interfaces:**
- Produces: the tool `browser_pay` with keys `card, origin, amount, currency, description, button` (required: the first five); `browser_pay_status` with no key. The C12 ops `card_seal {sealed}` and `pay_approve {request, sealed}`; the event to the daemon `pay_request {id, scope, origin, provider_origin?, order:{lines[], total, currency, delivery?}, description, card, expires}`; the event `pay {state: "start"|"end"}`.

- [ ] Write the contract test first (each new sentence quoted; the allow list's keys); run it: it fails.
- [ ] Write the texts and the allow-list entries; run the tests: they pass.
- [ ] Commit, push, draft PR, the daemon lead's OK at the head, merge.

### Task 2: The receiver's act kind `pay` (chrome-extension, C4, C5, C10, receiver 0.3.15)

**Files:**
- Modify: `agent/act.js` (the act kind `pay`), `agent/dnr.js` (the block's two sets; the merchant rule), `agent/allowlist.js` (the new requests), `agent/manifest.json` (0.3.15), `docs/protocol.md` (C4, C5, C10)
- Test: `test/act.test.mjs`, `test/contracts.test.mjs`

**Interfaces:**
- Produces: C4 requests `pay_cookies_copy {domain, window}` (reads the default store's cookies of the registrable domain, httpOnly included, writes them into the act window's store; answers `{count}` only, never a value); `pay_merchant_block {domain, on}` (a session rule that blocks the default context's requests to the domain; the act's tabs excluded); `act_rules` with `kind: "pay"` and `{before: [hosts], after: [hosts]}` (top-level GET stays open); `act_end` removes the merchant rule too.

- [ ] Tests first: a copy answers a count and no value; the act refuses a store other than its own window's for writes; the merchant rule blocks a default-context tab's fetch to the domain and not an act tab's; the `after` set only after the service's switch; `act_end` removes both rules.
- [ ] Implement; `npm test`; commit; PR; the review; the lead's repack (`npm run pack:agent -- --out release`, the new `versions.json` entry); CI green; the daemon lead's OK; merge.

### Task 3: The agent-browser pin of receiver 0.3.15

As ab-v16.115 (PR #219): `src/service/package/pins.ts`, the shipped `agent.crx`, the vectors folder, the fake, the package tests, C11's release item, C12's pin text. The daemon lead's OK at the head.

### Task 4: The service: the card record, the request and the approval (no fill yet)

**Files:**
- Modify: `src/service/signins/store.ts` (kind `card`: the plain fields name, brand, state; `kind` in the seal's additional data; the sign-in act refuses a card)
- Create: `src/service/pay/request.ts`, `src/service/pay/order.ts`, `src/service/pay/providers.ts`
- Create: `test/fixtures/pay-merchant/` (the local test merchant: `shop.localhost` with a cart, order lines, a total, a pay button, a confirmation; `pay.localhost` with card fields in a frame; variants per spec section 11)
- Create: `test/card-numbers.test.ts` (the repository check)
- Test: `test/pay-request.test.ts`, `test/pay-order.test.ts`

**Interfaces:**
- Produces: `readOrder(session: ActSession): Promise<PageOrder | {stop: string}>` with `PageOrder = {lines: string[], total: string, currency: string, delivery?: {name?: string, email?: string}}`; `orderHash(o: PageOrder): string` (SHA-256 hex of the canonical JSON of exactly those four keys); `PROVIDER_ORIGINS: readonly string[]` and `isProviderOrigin(origin: string): boolean` (the test list adds `https://pay.localhost`); `class PayRequests { open(input: PayInput, caller: Caller): Promise<PayResult>; approve(requestId: string, sealed: string, kind: Kind): Promise<void>; status(scope: string): PayResult[] }`.
- `PayResult = {state: "paid"|"declined"|"unknown"|"stopped", text: string, at: number, origin: string}`; the texts exactly as spec 8.7.

- [ ] Tests first: `kind: token` approval gets "not the operator"; a used id is refused; an expired request is refused; the hash differs for a changed line and is the same for a changed countdown; two calls of one scope; the store locked; a total that differs from `amount`; several amounts on a page; the repository check fails on a made-up card-like number in a temp file and passes on the published test list; no log line holds a test number.
- [ ] Implement; `npm test`; PR; review; the daemon lead's OK only if a contract text changes; merge.

### Task 5: The service: the session copy, the fill, the result

**Files:**
- Create: `src/service/pay/act.ts`, `src/service/pay/fields.ts`, `src/service/pay/result.ts`
- Modify: `src/service/pay/request.ts` (start the act after the approval)
- Test: `test/pay-act.test.ts`, `test/pay-result.test.ts`

**Interfaces:**
- Consumes: Task 2's receiver requests, Task 4's `readOrder`, `orderHash`, `isProviderOrigin`, `PayRequests`.
- Produces: `copySession(req: PayRequest, act: ActWindow): Promise<void | {stop: string}>` (the cookies through `pay_cookies_copy`; the origin's `localStorage` written from a blank document that the act's `Fetch` answers at the first load, then the act page loads; `pay_merchant_block` on from here to `act_end`); the guard on each act frame with `Fetch` (a URL with the number fails everywhere; a body with it fails outside the provider origins; the number's forms: digits, groups with spaces, dashes, `+`, `%20`); `findCardFields(frames: ActFrame[]): CardFields | {stop: string}` (by `autocomplete`, then labels and names; only provider frames); `class PayAct { run(req: PayRequest, approval: Approval): Promise<PayResult> }`; `readResult(page: ActPage, card: CardView): PayResult` with `refusesDigits(text: string, card: CardView): boolean` (the last four digits, a run of four or more of the number's digits, the expiry).

- [ ] Tests first, over the fakes and the test merchant: card fields on the shop's own page stop; a frame not on the list stops; a hash change after the approval stops; a save-card box is unticked, and one that cannot be unticked stops; a total change before the press stops and empties the fields; a fee at the press gives "Paid, but …"; a decline; a bank frame after the press is "Unknown"; a lost tab after the press is "Unknown"; a confirmation with the last four digits gives "order number not found"; the agent's cart change through the shared cookie fails at the merchant rule; no result, log line or event holds a test number or its groups.
- [ ] Implement; `npm test`; PR; review; merge.

### Task 6: The live check on the Linux server

**Files:**
- Create: `test/live/card-checkout/check.ts` (its own test service with `--test`, a free display such as 171, `/usr/bin/chromium`, the test merchant, a test approval through the control door with `kind: operator`)

- [ ] Run once: Paid with a published test number; Declined with the provider's decline test number; the attacks of spec section 11 get nothing. Record the result on the board.

### agentwatch's part (the daemon lead, later; not in this plan's PRs)

The card form (seals each value to the pane key; `card_seal`), the approval screen (plain text; `pay_approve` with the operator's login), the Web Push on `pay_request`, the earlier results, the blank of the live view on `pay`, the skill text. Its place in the daemon lead's queue is the manager's decision.
