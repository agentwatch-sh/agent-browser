# Secure card checkout: an agent pays, and the card never reaches it

**Status: Draft, for the operator's approval.** Four questions for the operator are open (section 13). Nothing is
built before the operator approves this design and the manager says go.

Board: the goal "Secure card checkout" and its Needs You item (section 13). GitHub: the issue "Secure card checkout".
It builds on the stored sign-ins design (`docs/superpowers/specs/2026-11-10-stored-sign-in-credentials-design.md`,
"the sign-in design" below): the sealed store, the pane's seal, the act in its own browser context, the block, the
off-screen window and the move of a site's session. This design reuses those parts, and names only what is new.

## 1. The answer in short

1. **The operator's ask (2026-11-21, typed in a session through the web login):** "add a secure credit card checkout
   feature to the agentbrowser that authorizes credit card spending without the CC# going into your context."
2. **The agent drives the shop; the service pays.** The agent fills the cart and drives the checkout to its payment
   step in its own tab, as today. Then it calls one new tool, `browser_pay`, with the card's name, the merchant's
   origin, the amount and a short list of the items. The agent never gets the card's number, its expiry or its
   security code, and no tool, log, event or result holds them.
3. **The operator approves each purchase, in the Browser pane, behind the password login (section 7).** A Web Push
   tells the operator's phone that a payment waits. The pane shows the merchant's origin, the total that the service
   itself read on the page, the agent's list of the items (marked as the agent's words) and the card's name. The
   operator's approval is sealed to the service's own key in the operator's browser tab, as the sign-in design's pane
   seal does. So no mail, no board answer, no manager answer and no agent's claim can make a payment: only a seal that
   the service can open.
4. **The payment act, in its own browser context (section 8).** After the approval, the service copies the merchant
   site's session (its cookies and `localStorage`) from the agent's browser context into a new incognito act window,
   loads the payment page there, and checks the origin and the total against the approval. Then it fills the card
   fields (also inside a payment provider's frame), pays with the page's own button, and reads the result. No agent
   session, page, worker or screen frame reaches the act window, as for the sign-in act.
5. **The result, and only the result (section 8.6).** The agent gets "Paid: <amount> to <origin>, order <number>",
   "Declined by the card's bank or the merchant", or one refusal from a fixed list. The result never holds a digit of
   the card.
6. **The card (section 6).** It is a sealed record in the stored sign-ins' store (question Q4), entered by the operator
   alone in the Browser pane. No agent can add, read, change or offer a card.
7. **Tests use the payment providers' published test card numbers on local test pages only (section 11).** No real
   card number goes into code, a test, a fixture, a log or a commit. A repository check refuses any card-like number
   that is not on the list of published test numbers. The first real purchase waits for the operator's own yes on a
   board item, later.

## 2. The ask, and the fixed rules

The operator's words: "add a secure credit card checkout feature to the agentbrowser that authorizes credit card
spending without the CC# going into your context." The first use: the operator's holiday trip, with ticket
checkouts on city and venue sites (a city's recreation booking site, a zoo's ticket site, a garden's timed
tickets). Until the feature exists, the operator buys these tickets.

These rules come from the ask and from the operator's money rule. They are not design choices:

- **R1.** The card number and the security code never enter an agent's context, an argv, a log, a page snapshot, a
  screenshot, a transcript, a mail or a board item. agentwatch's service fills the fields; an agent never does.
- **R2.** Each purchase needs the operator's own approval of the merchant, the items and the amount, through a
  channel that proves that it is the operator. A mail, a manager's answer, a board answer by a manager, or an
  agent's claim is never an approval.
- **R3.** The agent gets only the result: paid or declined, the order number, the amount.
- **R4.** No real card number anywhere in code, tests or fixtures. Tests use standard test card numbers on a local
  test page only. A first real purchase happens only after the operator's own yes, later.

## 3. Words

- **A card**: one stored card: a name that the operator chooses (for example `travel`), the holder's name, the
  number, the expiry, the billing postal code and, by question Q1, the security code.
- **A payment request**: the agent's `browser_pay` call while it waits: an id, the card's name, the origin, the
  amount and currency, the agent's item list, the page's total as the service read it, the session and the repo.
- **An approval**: the operator's yes for one payment request, sealed in the pane to the service's pane key.
- **The payment act**: the service's own work in its own act window, from the copy of the session to the result.
- **The service**, **the pane**, **the pane key**, **the store**, **the act window**, **the block**, **the move**: as
  in the sign-in design.

## 4. The approaches

Three ways were considered. The lead's pick is A.

- **A. The payment act in its own browser context, with the merchant's session copied in (the pick).** The same shape
  as the sign-in act, which is built and live-checked. The fill happens where no agent session, agent page or agent
  worker is (the sign-in design's section 4: in a tab that an agent can reach, the agent reads a filled value in
  seven ways, also through its own service worker on the same origin). Cost: a checkout whose state lives only in
  one tab (`sessionStorage`) or in IndexedDB does not survive the copy. Then the act stops with "This checkout
  cannot move to the payment act", and the operator buys by hand (section 14).
- **B. The handover of the agent's own tab.** The relay cuts every agent session of that tab and closes the agent's
  other tabs of the site, and the service fills in the same tab. It keeps every checkout state, also a tab's own.
  But an agent that had the tab before can have left a service worker, a `BroadcastChannel` listener or a page
  script on the merchant's origin that reads the fields or the form's body. So B is weaker than R1 needs for a
  merchant whose card fields are in its own page. Not chosen.
- **C. A wallet or a one-time virtual card.** The merchant's "Pay with …" button or a card that a card service makes
  for one purchase. Strong, but many ticket sites offer no wallet, and a virtual card service is a new account and a
  money setting, which only the operator can decide. Not in this design; a later choice of the operator.

## 5. The threat model

The sign-in design's section 4 holds for the act window: the agent cannot see, attach to or get an event of the act's
tab, its frames or its workers; the live view sends no frame of the display during the act; the act window is
outside the screen's area at the X level; Chrome drops the act's context with its last window. New for a payment:

| # | Threat | The answer |
|---|---|---|
| P1 | The agent reads the card in its own tab | The card is never in the agent's tab. The fill happens only in the act window (approach A). |
| P2 | The agent claims an approval, or a manager or a mail says "approved" | Only a seal that the service opens counts (section 7.3). It binds the request id, the origin, the amount, the currency and an expiry. |
| P3 | The agent or the page steers the act to another merchant | The act's page must be on the approved origin at the fill and at the pay (section 8.3). |
| P4 | The total at the pay differs from the approved total (a fee, a donation box, a changed ticket count, a page that changes it on purpose) | The act reads the total again right before the pay, and stops when it differs (question Q2). |
| P5 | The page's scripts send the card to another host | Card fields in a payment provider's frame are out of the merchant scripts' reach (cross-origin). For each frame of the act, the block lets the frame's requests go only to its own origin, the merchant's origin and the card frame's origins (section 8.4). |
| P6 | A replay: the same approval used twice | An approval names one request id. The service keeps the ids that it used, and refuses a second use. A request expires (section 7). |
| P7 | A double payment after an unclear result | The act never pays again by itself. An unclear result gives "unknown", and the agent is told not to retry (section 8.6). |
| P8 | A program of the operator's user reads the store's files | As for the sign-ins: the files hold only sealed records; the key is only in the service's memory after the operator's unlock. |
| P9 | The card number in a test, a log or a commit | R4, and the repository check of section 11. |

The same-uid limit of the sign-in design stays: a program of the operator's user with the display's X authority can
reach the act window. That limit is stated, not solved.

## 6. The card and its entry

- **Where it lives (question Q4).** The pick: a sealed record of a new kind `card` in the stored sign-ins' store, under
  the same store key and the same passphrase. The other choice: its own store with its own passphrase.
- **Who adds, changes and removes it:** the operator alone, in the Browser pane, behind the password login. There is
  no agent offer for a card (the sign-in design's Q3 b does not apply): no agent holds the operator's card.
- **The entry form:** the card's name, the holder's name, the number, the expiry, the billing postal code, and, by Q1,
  the security code. The pane checks the number's check digit (Luhn) and seals each value to the service's pane key
  before anything leaves the tab, as for a password. The gateway and the daemon get only sealed text.
- **The record:** the sign-in design's sealed record, with `kind: "card"`. Its plain fields: the name, the card's
  brand (from the number's first digits, for the pane's list only), and the state. No plain field holds a digit of
  the number; the pane shows the card by its name and brand only.
- **One card in the first build (the lead's call).** The record format allows more; the pane and the tool take more
  later.

## 7. The payment request and the operator's approval

### 7.1 The agent's call

- The MCP tool `browser_pay`, for a local admission only (as `browser_sign_in`): `{card, origin, amount, currency,
  items}`. `amount` is a decimal string with at most two decimals; `currency` is a three-letter code; `items` is the
  agent's own text, at most 500 characters. The CLI and the library get the same call.
- Checks before the request: the store is open; the card exists; the origin is https and is on the scope's list; the
  agent's tab of that scope is on the origin; no other payment request of the scope waits.
- The service reads the page's total from the agent's tab, in its isolated world (the visible text near the words
  "total", "amount due" and the like, and the currency). When it finds no total, or a total that differs from
  `amount`, the call ends at once with "The page's total is not the amount that you asked for" and no request.
- The call then waits for the approval (up to 10 minutes, a first value), and then for the act.

### 7.2 What the operator sees

- A Web Push to the operator's phone: "A payment waits for your approval in the Browser pane." It names the
  merchant's origin and the amount, and no card value.
- The pane (behind the password login, on the desktop or on the phone): the merchant's origin; the total that the
  service read on the page, and the agent's amount; the agent's items, marked "the agent's words"; the card's name;
  the session and the repo of the request (from the daemon's walk); the time left. Two buttons: Approve and Refuse.
- With Q1 b, the security code field is on this screen: the operator types it with each approval.

### 7.3 The sealed approval

- The pane seals `{request id, origin, amount, currency, card, expires}` (and the security code with Q1 b) to the
  service's pane key, as the sign-in design seals a typed password. The daemon passes only the sealed text, in a new
  op `pay_approve`.
- The service opens the seal, checks each field against its own request, and checks that the request id was never
  used. Only then does the act start. A seal for another request, another amount, another origin or a used id gets
  "This approval does not match the payment request", and no act starts.
- The approval is good for one act within 10 minutes (a first value). After that, the request ends with "The approval
  expired".

## 8. The payment act

### 8.1 The window and the context

The sign-in design's act window: a new incognito window of the receiver, outside the screen's area at the X level,
with no frame of it to a viewer, and with no client that can see, attach to or get an event of it. The receiver's act
kind is `pay`.

### 8.2 The copy of the session (new: the reverse of the move)

- The service reads, through the receiver, the default context's cookies of the merchant's registrable domain and the
  origin's `localStorage`, and writes them into the act's context (`cookies.set` with the act's cookie store, and a
  write of `localStorage` from an act page of the origin before the payment page loads).
- Then the act's tab loads the URL of the agent's tab. When the page that loads has no card fields, or is not a
  payment step (for example the cart is empty, or the site asks to sign in again), the act stops with "This checkout
  cannot move to the payment act", and the operator buys by hand.

### 8.3 The checks before the fill

- The page's origin is the approved origin.
- The page's total is the approved amount and currency (question Q2).
- The card fields exist: in the main frame, or in the frames of a payment provider (cross-origin frames: the service's
  own session attaches to them). The service finds them by `autocomplete` (`cc-number`, `cc-exp`, `cc-exp-month`,
  `cc-exp-year`, `cc-csc`, `cc-name`, `postal-code`), then by their labels and names. A form that it cannot read
  stops the act with "The agent browser cannot find the card fields on this page".

### 8.4 The block

From the first key to the end of the act, the receiver lets the act's requests go only to: the merchant's origin, the
origins of the card fields' frames, and the hosts that those frames load from at the first key. Every other request
(every resource type, the WebSocket included) fails, as in the sign-in design's block. The guard also fails a request
whose URL holds the number in the sign-in design's five forms.

### 8.5 The fill, the second check and the pay

- The service types each value with the person's input of the input design, field by field.
- Right before the pay, it reads the total again. A total that differs stops the act (question Q2), and it empties the
  fields.
- It presses the page's pay button (the form's submit button, or the button whose text says pay, buy, place order or
  the like). The agent may give a hint of the button's text in `browser_pay`; a wrong hint cannot pay another amount,
  because of the second check.
- A bank's second step (3-D Secure): question Q3.

### 8.6 The result

- **Paid:** the page moves to a confirmation (a new URL or a new main text with words such as "confirmation", "order",
  "thank you"). The service reads an order number near these words, and the amount. The agent gets "Paid: <amount>
  <currency> to <origin>, order <number>" (or "order number not found").
- **Declined:** the page stays, and an error near the card fields names a decline. The agent gets "Declined by the
  card's bank or the merchant".
- **Unknown:** none of the two within 60 s (a first value). The agent gets "The payment's result is unknown. Do not
  pay again: check the merchant's mail or account." The operator gets an event too.
- Every other stop has a fixed text from a short list. No result holds a digit of the card.

### 8.7 The clean end

As the sign-in design's section 7.8: the service empties the fields, clears the tab's history, sends `act_end` (the
receiver closes the act's tabs, then removes the block's rules), and fills the values' buffers with zeros. After
"Paid", the service moves the site's session back into the default context through the sign-in design's move, so
that the agent's tabs see the paid order (for example tickets in an account). After "Declined" or a stop, nothing
moves back.

## 9. What stays the same, and the limits per purchase

- Each purchase needs its own approval. There is no standing approval and no budget in the first build.
- Only a local session uses `browser_pay`; a remote admission gets the refusal.
- The store and the act stay off on the Mac until the Mac's memory check (the sign-in design's section 5.5), so the
  first build is for the Linux server (the lead's call).

## 10. The parts of agentwatch, and the contract changes

agentwatch (the daemon lead builds these later, after the operator's approval):

- The store's new record kind `card`, and the pane's card form with the seal (the sign-in design's pane, extended).
- The payment requests: the daemon's queue, the pane's approval screen, the Web Push, and the op `pay_approve` that
  carries the sealed approval.
- The skill text: when to call `browser_pay`, and "never retry after unknown".

agent-browser and chrome-extension:

- The service: `browser_pay` (C11's MCP tools and the allow list), the payment request, the session copy, the payment
  act, the total reader, the card field finder, the result reader; the C12 ops `card_seal`, `pay_request` (an event
  to the daemon), `pay_approve`, and their events.
- The receiver: the act kind `pay` and its block (C4, C5, C10).
- Each contract change merges only after the daemon lead's OK at its head.

## 11. Tests

- A local test merchant on two local origins: `shop.localhost` (a cart, a checkout page with a total, a pay button and
  a confirmation page) and `pay.localhost` (card fields in a frame, as a hosted payment field). Variants: card fields
  in the main frame; a total that changes before the pay; a decline; a page that asks for a bank's second step; a
  checkout bound to `sessionStorage`.
- Only the payment providers' published test card numbers. A repository check (part of `npm test`) fails on any
  number of 13 to 19 digits with a valid check digit that is not on the list of published test numbers.
- The agent's attacks get nothing: its own service worker and `BroadcastChannel` on the shop's origin, a
  `Runtime.evaluate` and a `DOMSnapshot` of every page it can reach, a screenshot, the network events, a replayed or
  changed approval, a hint that names another button.
- A test that no log line, event, result or MCP answer holds a test card number.
- A live check on the Linux server with the test merchant, in a free display.

## 12. The build, and the first real purchase

1. The contract texts (C11, C12, C4, C5, C10) and their vectors.
2. The receiver's `pay` act kind and its block (chrome-extension, a new receiver version).
3. The service: the card record, the payment request, the session copy, the act, the readers.
4. agentwatch: the card form, the approval screen, the Web Push, `pay_approve`, the skill text.
5. The live check with the test merchant.
6. The first real purchase: only after the operator's own yes on a board item that names the merchant and the amount,
   and only for a small first purchase.

## 13. Questions for the operator

One Needs You item holds these four questions, and one line with the lead's own calls (one card first; the Linux
server first; approach A with a stop and a hand purchase when a checkout does not survive the copy), so that the
operator can change them too.

- **Q1. The security code (CVV).** a) The operator types it in the pane with each approval; the store never holds it
  (the lead's recommendation: a stolen store then cannot pay, and the approval already needs the operator). b) It is
  stored with the card; an approval is one click.
- **Q2. A total that changes.** a) Any difference from the approved total stops the act and asks the operator again
  (the recommendation). b) A small difference is allowed (for example up to 2% or 3 USD, the smaller), and the result
  names the paid total.
- **Q3. A bank's second step (3-D Secure).** a) The act waits up to 5 minutes for the operator to approve in the bank's
  own app; a page that asks for a typed code stops the act, and the operator buys by hand (the recommendation for the
  first build). b) Also a typed code: the pane asks the operator for the bank's code and seals it to the service.
  c) Any second step stops the act.
- **Q4. Where the card lives.** a) In the stored sign-ins' store, with the same passphrase (the recommendation: one
  unlock, and with Q1 a the store has no security code). b) Its own store with its own passphrase.

## 14. Limits and open points

- A checkout whose state lives only in one tab's `sessionStorage`, in IndexedDB or in a server session bound to the
  tab's connection does not survive the copy (approach A). The act stops, and the operator buys by hand.
- A captcha, a sign-in or a phone code at the payment step stops the act.
- Wallet buttons and one-time virtual cards are not in this design (approach C).
- The same-uid limit of the sign-in design.
- The total reader and the result reader read text by rules, not by a site's own data. A site with an unusual page can
  give "cannot find" or "unknown"; never a payment of another amount, because of the two total checks.
