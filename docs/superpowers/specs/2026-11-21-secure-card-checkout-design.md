# Secure card checkout: an agent pays, and the card never reaches it

**Status: Approved by the operator on 2026-11-21 (board item ab-lmv, "The operator approves the design as it is",
through the web login).** The operator answered the four questions the same day (board item ab-uzv; section 13). The
build starts only on the manager's go.

Board: the goal ab-sta, the design task ab-sta.1. GitHub: issue #222, draft PR #223. It builds on the stored sign-ins
design (`docs/superpowers/specs/2026-11-10-stored-sign-in-credentials-design.md`, "the sign-in design" below): the
sealed store, the pane's seal, the act in its own browser context, the block, the guard and the off-screen window. This
design reuses those parts, and names only what is new.

## 1. The answer in short

1. **The operator's ask (2026-11-21, typed in a session through the web login):** "add a secure credit card checkout
   feature to the agentbrowser that authorizes credit card spending without the CC# going into your context."
2. **The agent drives the shop; the service pays.** The agent fills the cart and drives the checkout to its payment
   step in its own tab, as today. Then it calls one new tool, `browser_pay`. The agent never gets the card's number,
   its expiry or its security code, and no tool, log, event or result holds them.
3. **The payment page moves into the service's own act window before the approval (section 8).** The service copies
   the merchant's session into a new incognito act window, loads the payment page there, and from then on blocks the
   agent's own requests to the merchant. The page that the operator approves is the page that the act pays.
4. **The operator approves each purchase in the Browser pane, behind the password login (section 7).** A Web Push
   tells the operator's phone that a payment waits. The pane shows the merchant, the page's own order lines and total
   as the act read them, the agent's description (marked as the agent's words) and the card's name. Only C12's
   `kind: operator` (the password login) can approve. A mail, a board answer, a manager's answer or an agent's claim
   cannot.
5. **The fill, only inside a payment provider's frame (section 8.4).** In the first build, the act fills card fields
   only in a cross-origin frame of a known payment provider. A checkout whose card fields are on the merchant's own
   page stops, and the operator buys by hand.
6. **The result, and only the result (section 8.7).** "Paid: <amount> to <origin>, order <number>", "Declined", or
   "Unknown: do not pay again". The result never holds a digit of the card.
7. **The card (section 6).** A sealed record in the stored sign-ins' store, with the same passphrase (Q4). The store
   keeps the security code (Q1). The operator alone enters, changes and removes a card.
8. **Tests use only the payment providers' published test card numbers on local test pages (section 11).** A
   repository check refuses any other card-like number. The first real purchase waits for the operator's own yes on a
   board item, later.

## 2. The ask, and the fixed rules

The operator's words: "add a secure credit card checkout feature to the agentbrowser that authorizes credit card
spending without the CC# going into your context." The first use: ticket checkouts on city and venue sites. Until the
feature exists, the operator buys these tickets.

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
  number, the expiry, the security code and the billing postal code.
- **A payment request**: the agent's `browser_pay` call while it waits: an id, the card's name, the origin, the
  amount and currency, the agent's description, the agent's tab id and the tab's URL, the session and the repo.
- **The act page**: the payment page, loaded in the act window from the agent's tab's URL after the session copy.
- **The page's order**: what the act reads on the act page: the order lines, the total, the currency, and the
  delivery name and email when the page shows them, and nothing else (no countdown, no hold timer, no banner). Its
  hash binds the approval.
- **An approval**: the operator's yes for one payment request, made in the pane with `kind: operator`.
- **A provider frame**: a cross-origin frame of the act page whose origin is on the service's list of payment
  providers' hosted field origins (section 8.4); also the main frame of a provider's hosted payment page, when the
  merchant's page sends the act there and that origin is on the list.
- **The service**, **the pane**, **the pane key**, **the store**, **the act window**, **the block**, **the guard**: as
  in the sign-in design.

## 4. The approaches

Three ways were considered. The lead's pick is A.

- **A. The payment act in its own browser context, with the merchant's session copied in (the pick).** The same shape
  as the sign-in act. The fill happens where no agent session, page or worker is. Two costs, both stated: a checkout
  whose state lives only in one tab (`sessionStorage`) or in IndexedDB does not survive the copy; and the act shares
  the merchant's server session with the agent's tabs, so the act fills only in a provider frame (section 8.4) and
  blocks the agent's merchant requests while it runs (section 8.2).
- **B. The handover of the agent's own tab.** It keeps every checkout state. But an agent that had the tab can have
  left a service worker, a `BroadcastChannel` listener or a script on the merchant's origin. Not chosen.
- **C. A wallet or a one-time virtual card.** Many ticket sites offer no wallet, and a virtual card service is a new
  account and a money setting, which only the operator can decide. A later choice of the operator.

## 5. The threat model

The sign-in design's section 4 holds for the act window. New for a payment:

| # | Threat | The answer |
|---|---|---|
| P1 | The agent reads the card in its own tab | The card is never in the agent's tab. The fill is only in the act window, in a provider frame. |
| P2 | Something other than the operator approves (a seal that a program makes to the public pane key, a mail, a manager's answer, an agent's claim) | `pay_approve` applies only with C12's `kind: operator`; every other kind gets "not the operator". The seal has its own purpose and binds the request (section 7.3). |
| P3 | The agent changes what the act pays (another checkout URL, a cart change through the shared session, another cart with the same total) | The act page is loaded and read before the approval; the approval binds the page's order hash; the receiver blocks the agent's requests to the merchant from the copy to the act's end; the act reads the order again before the pay (section 8.2, 8.5). |
| P4 | The total changes at the pay | Any difference stops the act (Q2). A change at the moment of the press (for example a script on the button's events) is found only after the pay: the act compares the confirmation's amount (section 8.7). |
| P5 | The page's scripts send the card to another host | The fill is only in a provider frame (cross-origin to the merchant's scripts). The block and the guard of section 8.6. |
| P6 | The merchant's own page keeps or shows the card where the agent can read it | No fill on the merchant's own page in the first build (section 8.4). No move back of the session after the act (section 8.8). |
| P7 | A replay: one approval used twice | An approval names one request id and one page-order hash; the service refuses a used id. A request expires. |
| P8 | A second payment after an unclear end | Every end after the press that is not Paid or Declined is "Unknown"; the service keeps each result, and the pane shows an earlier result to the same origin (section 8.7). |
| P9 | A card that the merchant saves for later purchases | The act unticks the save-card and remember boxes, and stops when it cannot (section 8.5). |
| P10 | A program of the operator's user reads the store's files | As for the sign-ins: sealed records; the key only in the service's memory after the unlock. |
| P11 | The card number in a test, a log or a commit | R4, and the repository check (section 11). |

Stated limits: the same-uid limit of the sign-in design; a token that an agent took from the merchant's
`localStorage` earlier can still act on the merchant from the agent's shell, outside the browser; the merchant's own
pages show the last four digits, the holder's name and the postal code (as a site shows a username).

## 6. The card and its entry

- **Where it lives (Q4, the operator's answer):** a sealed record of the new kind `card` in the stored sign-ins' store,
  under the same store key and passphrase. `kind` is in the seal's additional data: the sign-in act refuses a card,
  and the payment act refuses a sign-in.
- **The security code (Q1, the operator's answer):** the store keeps it with the card. So an approval is one click.
  The effect, stated: a reader of an opened store (the service's memory) has every value that a payment needs.
- **Who adds, changes and removes it:** the operator alone, in the Browser pane, with `kind: operator`. No agent offer
  for a card.
- **The entry form:** the card's name, the holder's name, the number, the expiry, the security code, the billing postal
  code. The pane checks the number's check digit (Luhn) and seals each value to the service's pane key before anything
  leaves the tab. The gateway and the daemon get only sealed text.
- **The record:** plain fields are the name, the brand (from the first digits, for the pane's list) and the state. No
  plain field holds a digit of the number.
- **One card in the first build (the lead's call).**

## 7. The payment request and the operator's approval

### 7.1 The agent's call

- The MCP tool `browser_pay`, for a local admission only: `{card, origin, amount, currency, description, button?}`.
  `amount` is a decimal string with at most two decimals; `currency` is a three-letter code; `description` is the
  agent's own text, at most 500 characters; `button` is an optional hint of the pay button's text.
- Checks before the request: the store is open; the card exists and is of kind `card`; the origin is https (or a
  loopback test origin, as the sign-in design allows) and is on the scope's list; the agent's tab of that scope is on
  the origin; no other payment request of the scope waits.
- The request records the agent's tab id and the tab's URL. Then the act window opens (section 8.1-8.3), and the call
  waits for the approval (up to 10 minutes, a first value) and then for the act.
- A cancel of the call before the approval ends the request. A cancel after the approval does not stop the act; its
  result stays (section 8.7).

### 7.2 What the operator sees

- A Web Push to the operator's phone: "A payment waits for your approval in the Browser pane." It names the merchant's
  origin and the amount, and no card value.
- The pane (behind the password login, on the desktop or on the phone), all as plain text (never HTML):
  - the merchant's origin, and the provider's origin when the page pays through a provider's hosted page;
  - **the page's order** as the act read it in the act window: the order lines, the total, the currency, and the
    delivery name and email ("the page's words");
  - the agent's amount and description ("the agent's words");
  - the card's name; the session and the repo (from the daemon's walk); the time left;
  - each earlier payment result to the same origin in the last 24 hours (section 8.7).
- Two buttons: Approve and Refuse.

### 7.3 The approval

- `pay_approve` applies only with C12's `kind: operator`. Every other kind gets "not the operator". This, not the seal
  alone, makes R2: the pane key is public, so a program can seal to it.
- The pane also seals the approval, with its own purpose `browser-pay` (not `browser-sign-in`), the op, `rid` and `at`
  of C12's seal rules, and the binding fields: the request id, the origin, the amount, the currency, the card's name
  and the page-order hash.
- The service checks each field against its own request and the act page, and refuses a used request id. A mismatch
  gets "This approval does not match the payment request", and the act does not go on.
- The approval is good for one act within 10 minutes (a first value).

## 8. The payment act

### 8.1 The window

The sign-in design's act window, of the receiver's new act kind `pay`: a new incognito window, outside the screen's
area at the X level, with no frame of it to a viewer and no client that can see or attach to it. One private window
exists at a time (C10), so while a payment request waits (up to 10 minutes), the sign-in acts and PageFetch wait too.
A new event `pay` blanks the live view from the first key to the act's end, as `sign_in` does; its fail-safe covers
the act's longest time.

### 8.2 The session copy, and the agent's merchant requests

- New receiver requests (C4): read the default context's cookies of the merchant's registrable domain, httpOnly
  included (a narrow exception to review-ce44 N10, for the `pay` act only, inside the service: no client gets them);
  write them into the act's cookie store; and write the origin's `localStorage` in the act's context before the
  merchant's scripts run (the service's `Fetch` answers the first load of the origin with a blank document, writes the
  storage, then loads the act page).
- From the copy to the act's end, a receiver rule blocks every request of the default context (its tabs and their
  workers; the act's tabs are excluded) to the merchant's registrable domain. So the agent's tab cannot change the cart
  or the order while the operator approves or while the act pays. The agent's call gets this in its first answer
  text.

### 8.3 The act page, before the approval

- The act's tab loads the URL of the agent's tab. When the page is not a payment step (an empty cart, a sign-in page,
  no card fields), or its origin is not the request's origin (or a known provider's hosted payment page that the
  merchant's page sent it to), the request ends with "This checkout cannot move to the payment act", and the operator
  buys by hand.
- The act reads the page's order and its total in its isolated world, maps the currency (a code on the page, or a
  symbol that fits the agent's currency, for example `$` for USD), and checks that the total equals the agent's
  amount. Then the approval screen of section 7.2 shows it.

### 8.4 The card fields: provider frames only (the first build)

- The service holds a list of payment providers' hosted field origins (a first value; the builder fills it from the
  providers' documentation, and the operator can extend it in the pane later). The act fills only inside a provider
  frame. Its own sessions attach to the frame (an out-of-process frame), with `Fetch` on each, as for the sign-in
  act's children.
- It finds the fields by `autocomplete` (`cc-number`, `cc-exp`, `cc-exp-month`, `cc-exp-year`, `cc-csc`, `cc-name`,
  `postal-code`), then by their labels and names.
- Card fields on the merchant's own page, or in a frame that is not on the list: the request ends with "This
  checkout's card fields are not in a known payment provider's frame", and the operator buys by hand (the lead's call;
  section 14).

### 8.5 After the approval: the fill, the second check and the pay

- The act reads the page's order again. A hash that differs from the approved one stops the act (Q2: any difference
  asks the operator again: a new request).
- It unticks every box near the card fields whose label says save, remember or keep the card. It stops when it cannot.
- It types each value with the person's input of the input design.
- Right before the pay, it reads the total again; a difference stops the act and empties the fields.
- It presses the pay button: the form's submit button, or the button whose text says pay, buy, place order or the
  like, or the agent's hint. A wrong hint cannot pay another amount: the total check comes before the press, and the
  confirmation check after it.

### 8.6 The block and the guard

- Before the press, the act's requests go only to the merchant's registrable domain and to the provider frames'
  origins and the hosts that they load from (one set for the whole act); top-level GET navigations stay open, as in
  the sign-in design.
- After the press, the set grows by the hosts that the page and the provider frames call then (a provider's API, a
  confirmation on another host), because the filled values stay in the provider frame. The guard still applies to
  every request.
- The guard (also in the provider frames): a request whose URL holds the number fails, on every origin. A request
  whose body holds the number fails unless its origin is a provider frame's origin or a provider host on the list (the
  provider's own API gets the number: that is the payment). The number's forms: the digits, and groups of digits with
  spaces, dashes, `+` or `%20`. The guard does not match the security code or the expiry by themselves: they are too
  short to tell from ordinary text (section 14).

### 8.7 The result

- **A bank's second step (Q3, the operator's answer: any bank step stops).** A frame or a page of a bank's check
  (3-D Secure) after the press ends the act. No code is typed and no wait is made. Because the provider can still
  complete the charge on its server (a frictionless check), the act counts this end as "Unknown" in the keep and in the
  pane, with the text "The card's bank asked for a second step. The payment's result is unknown: check the merchant's
  account before you buy by hand."
- **Paid:** the page moves to a confirmation. The act reads an order number near words such as "confirmation",
  "order", "thank you", and the amount. The reader refuses a value that holds the card's last four digits, a run of
  four or more of its digits, or its expiry. The agent gets "Paid: <amount> <currency> to <origin>, order <number>" (or
  "order number not found"). A confirmation amount that differs from the approved amount gives "Paid, but the
  merchant's confirmation shows <amount>", and the operator gets an alert at once.
- **Declined:** the page stays, and an error near the card fields names a decline. "Declined by the card's bank or the
  merchant".
- **Unknown:** every other end after the press (no confirmation within 60 s, a lost tab, a link change, a stop of the
  service). "The payment's result is unknown. Do not pay again: check the merchant's mail or account." The operator
  gets an alert.
- The service keeps each request's result for 24 hours. A status read of the scope returns it, and the pane shows it
  with the next request to the same origin. Stops before the press have fixed texts from a short list.

### 8.8 The clean end

As the sign-in design's section 7.8, without its move: the service empties the fields, clears the tab's history,
sends `act_end` (the receiver closes the act's tabs, then removes the block's and the merchant rule's rules), and fills
the values' buffers with zeros. No session moves back into the default context in the first build: the agent's tabs
keep the merchant's session cookie, so they see the paid order where the site shows it to a signed-in session.

## 9. What stays the same

- Each purchase needs its own approval. No standing approval and no budget in the first build.
- Only a local session uses `browser_pay`; a remote admission gets the refusal.
- Every local scope whose list covers the merchant may ask for a payment; each request still needs the operator's
  approval (the lead's call).
- The store and the act stay off on the Mac until the Mac's memory check (the sign-in design's section 5.5), so the
  first build is for the Linux server (the lead's call).

## 10. The parts of agentwatch, and the contract changes

agentwatch (the daemon lead builds these later, after the operator's approval):

- The store's record kind `card`, and the pane's card form with the seal.
- The payment requests: the daemon's queue, the pane's approval screen (plain text only), the Web Push, the op
  `pay_approve` with `kind: operator` only, the earlier results in the pane, the blank of the live view on `pay`.
- The skill text: when to call `browser_pay`, and never to pay again after "Unknown".

agent-browser and chrome-extension:

- The service: `browser_pay` and its status read (C11's MCP tools and the allow list), the payment request, the session
  copy, the act page reader, the provider frame list and finder, the fill, the result reader with its digit filter,
  the results' keep; the C12 ops `card_seal`, `pay_approve`, the event to the daemon for a new request, and the `pay`
  event.
- The receiver (C4, C5, C10): the act kind `pay`; the cookie read of the default store for the merchant's domain, the
  write into the act's store, the storage write; the rule that blocks the default context's requests to the merchant's
  domain; the block's sets before and after the press; `Fetch` on the provider frames.
- Each contract change merges only after the daemon lead's OK at its head.

## 11. Tests

- A local test merchant on loopback origins: `shop.localhost` (a cart, a checkout page with order lines and a total, a
  pay button, a confirmation) and `pay.localhost` (card fields in a frame, as hosted fields; on the test list of
  provider origins). Variants: card fields on the shop's own page (must stop); a frame on another origin (must stop);
  a total that changes before the pay; a fee that a script adds at the press (must give "Paid, but …"); a decline; a
  bank's check after the press (must stop); a save-card box; a checkout bound to `sessionStorage` (must stop).
- Attacks that must get nothing: a cart change from the agent's tab through the shared cookie (blocked); another
  checkout URL after the approval (the hash stops it); the agent's own service worker and `BroadcastChannel` on the
  shop's origin; `Runtime.evaluate` and `DOMSnapshot` of every page it can reach; a screenshot; a seal that a program
  makes to the pane key with `kind: token` (refused); a replayed approval; a cancelled call followed by a new request
  (the pane shows the earlier result); a confirmation page with the last four digits (the reader refuses them).
- Only the payment providers' published test card numbers. A repository check (part of `npm test`) fails on any
  number of 15 to 19 digits, contiguous or in groups with spaces or dashes, with a valid check digit, that is not on
  the list of published test numbers.
- A test that no log line, event, result or MCP answer holds a test card number, its groups or its expiry.
- A live check on the Linux server with the test merchant, in a free display.

## 12. The build, and the first real purchase

1. The contract texts (C11, C12, C4, C5, C10) and their vectors.
2. The receiver's `pay` act kind, its cookie and storage requests, its rules (chrome-extension, a new receiver).
3. The service: the card record, the request, the copy, the act, the readers, the results.
4. agentwatch: the card form, the approval screen, the Web Push, `pay_approve`, the skill text (the daemon lead).
5. The live check with the test merchant.
6. The first real purchase: only after the operator's own yes on a board item that names the merchant and the amount,
   and only for a small first purchase.

## 13. The operator's answers, and the lead's calls

The operator answered board item ab-uzv on 2026-11-21 (through the web login, confirmed):

- **Q1, the security code:** "The store keeps the CVV with the card" (an approval is one click).
- **Q2, a changed total:** "Any difference stops the payment and asks the operator again".
- **Q3, a bank's second step:** "Any bank step stops the payment" (the operator buys by hand).
- **Q4, the card's store:** "The stored sign-ins' store, with the same passphrase".

The lead's calls (the item named the first three; the operator can still change each one at the approval of this
design): one card in the first build; the Linux server first; approach A, with a stop and a hand purchase when a
checkout does not survive the copy; card fields only in a known provider's frame in the first build; no move back of
the session after the act; every local scope whose list covers the merchant may ask.

## 14. Limits and open points

- A checkout with its card fields on the merchant's own page, or in a frame that is not on the provider list, stops,
  and the operator buys by hand. Before the build, the lead checks how the first ticket sites take a card (a hosted
  provider frame, a redirect to a provider's page, or the merchant's own fields), from their pages only.
- A checkout whose state lives only in one tab's `sessionStorage`, in IndexedDB or in a server session bound to the
  tab's connection does not survive the copy.
- A captcha, a sign-in or a phone code at the payment step stops the act.
- A site that saves every card to the account with no box to untick can let an agent buy again with the saved card,
  without `browser_pay`. The operator removes the saved card at the merchant.
- The guard does not match the security code or the expiry alone (section 8.6); the provider frame keeps them away from
  the merchant's scripts.
- A change at the moment of the press is found only after the pay, by the confirmation's amount.
- Wallet buttons and one-time virtual cards are not in this design (approach C).
- The same-uid limit, the merchant token limit and the last-four-digits limit of section 5.
- A check without money of the first sites (2026-11-21) reached no payment step: the Railroad Park sells through
  ActiveNet, which likely needs an account; the zoo's ticket store and the garden's site are behind Cloudflare, and the
  agent browser on the Linux server got Cloudflare's bot check there. So the first build on the Linux server may not
  reach these sites, and their payments may need the Mac (the home address) after its memory check. The card field
  type of these sites is still open.
