# A press-and-hold check: what it measures, and what the agent browser does

Board task ab-t30.34, epic ab-t30. Part 1 (offline research, 2026-11-26 UTC) read public sources only: no site with a
bot check was opened, and no vendor code was read or taken apart. Parts 2 and 3 (the same day) built the agent
browser's hold (C11, the press and hold) and its local test page. This note holds no bypass code and no vendor code.

The operator's words (2026-11-25): "i found an interesting bot check today on fiverr. it was a button that i had to
long-press. make sure you have something that can pass this." The check is most likely HUMAN Security's "Press & Hold"
check (earlier PerimeterX's "human challenge").

How sure each fact is: **H** a vendor's own text, a standard or this repository's code; **M** one direct public account
(for example a recording's caption file); **L** a scraping vendor's text, a mirror or an anecdote.

## 1. What the check measures (public sources)

1. **The hold.** The hold's time "varies" [2] (H). The page shows a fill, and the person holds "until the bar is full
   and then release it" [3] (H). HUMAN's test header sets a solve time of 1000 to 10000 ms, for tests only [3] (H). A
   release before the fill is full drains the fill [6] (M); it "counts against you" [11] (L). At the full fill a check
   mark shows, then the page loads [6] (M). One recorded attempt got the check mark and then "Please try again" [6]:
   a full fill alone does not pass (M). The page counts failed attempts (`dynamicTextThreshold`) [4] (H). No source
   says what a late release does.
2. **The events.** The sensor tracks "mouse, touch, and keyboard events" [1] (H). During the hold the check runs a proof
   of work and reads "mouse movement behavior" [5] (H). It detects scripts that use "the native methods provided by the
   DOM", and it sets fake events as honeypots [1] (H). No source names `isTrusted` (by inference it is read: M). The
   keyboard: Tab reaches the button, and a held Space or Enter fills it [6] (M); the accessible mode is "press the button
   once, wait for confirmation, and press again" [4] (H). Third parties name the rate of `mousedown`, the variance of the
   points and a jitter under 1 ms [8], the pressure and "tiny involuntary movements" [10] (L). A mouse gives the
   pressure 0.5 while a button is down [14] (H), so a curve of the pressure applies only to touch and pen. No source
   gives the time from the page's load to the press, or the path to the button.
3. **The frame.** No vendor text names a frame, a shadow root or a canvas for the button; "multiple iframes" are named
   as honeypots [1] (H), "closed shadow roots" by a third party [8] (L). The script comes from `px-cloud.net` [7] (H) or
   from the site's own domain [11] (L). No source says whether the press must be at the button's middle.
4. **The other signals.** The check shows only when the behaviour "deviates from the normal human range" [5] (H): the
   hold comes after the sensor's score. Headless callbacks "(for example, selenium)" and replays of a token are named [1],
   and the proof of work is harder for a client under suspicion [5] (H). Third parties name `navigator.webdriver`,
   `HeadlessChrome`, fingerprints and the reputation of the IP address [9][11] (L). No source ties CDP traces to HUMAN.
5. **Automation, as others report it.** Selenium's `click()` and `click_and_hold` failed; a hold of about 10 s on
   `#px-captcha` worked; a random hold time is advised [12] (L, a search excerpt only). Plain Playwright fails the
   fingerprint and IP checks [9]; a physical mouse "works much more reliably" [13] (L).

## 2. What the agent browser did before board ab-t30.34 (main a733d40)

- The input stage's press: `force` 0.5 and a hold of 60 to 180 ms (`src/human/press.ts`; C11). The release goes at the
  later of its arrival and the press plus the hold, so a client's longer hold stays. A hold of a client has the limit
  `STAGE_ACTION_MAX_MS` = 25000.
- No pointer moves during a hold ("No idle moves", C11).
- CDP's `Input.dispatchMouseEvent` gives trusted pointer and mouse events, with the pressure 0.5 and then 0, and no touch
  events (`docs/research/2026-11-09-click-box-input-signals.md`).
- An MCP agent could not hold: `browser_click` presses for 60 to 180 ms, and Playwright MCP's vision cap (with
  `browser_mouse_down` and `browser_mouse_up`) is off. A Playwright script could hold with `mouse.down()`, a wait and
  `mouse.up()`, with the pointer still.

## 3. What the agent browser does now (C11, the press and hold)

- **A service tool, not the vision cap.** ab-lead kept Playwright MCP's vision cap off: with it, the agent's turn time
  would set the hold's length. The service's own tool `browser_press_hold` takes `ref` (a ref of the page snapshot),
  `element` and `maxMs` (15000 by default, at most 20000), and the service and the input stage control the hold.
- **The element by its ref.** The service sends the MCP session's worker the MCP's own `browser_hover` of the ref. So the
  MCP's Playwright finds the element (also in a cross-origin frame), scrolls it into view with the stage's wheel notches
  and moves the pointer through the stage's person model (a path at a device's rate). The hover's path ends at a spread
  point of the button. The service puts nothing into the page. An element in a closed shadow root has no ref: the agent
  gives the ref of its host (as `#px-captcha`), and the press reaches the element under the point.
- **The press and the hand.** The pause before a press (25 to 190 ms from the last move), then a press with `force` 0.5.
  During the hold the hand moves 1 px at random gaps of 150 to 600 ms, never more than 2 px from the press point
  (Chrome starts a drag only past 4 px), as a hand that holds a button is not still.
- **The end.** The first of: the button's done state (each 100 ms a screenshot of the button's box; a change of the
  pixels and then the same pixels for 300 ms: the fill is full and the check mark shows; this read works through a
  cross-origin frame and a closed shadow root), a navigation, the element gone, or `maxMs`. The release goes 150 to
  400 ms after the done state, and at once after the other ends.
- **A Playwright client** that holds with `mouse.down()`, a wait and `mouse.up()` gets its own time through the stage
  (measured in `test/relay-stage-hold.test.ts` and by the live check).
- **The local test page** (`test/live/press-hold/`) copies the check's rules: a random fill time of 1 to 10 s shown as a
  bar, a drain at an early release, a check mark at the full fill, and the button in the page, in a cross-origin frame
  (a second local origin) and in a closed shadow root. It logs each event (its type, `isTrusted`, the pressure, the
  buttons, the point, the time, the coalesced count, the repeat) and the moves during the hold.

## 4. The limits, stated plainly

- The first values (the hand's gaps and steps, the release's delay) come from these sources and from no recording of a
  person's long hold. A Mac recording of the operator's long hold on the local test page can calibrate them.
- The hold is one part of the check. The sensor's score before the hold, the proof of work, the browser's fingerprint
  and the reputation of the IP address count too (section 1, items 4 and 5), and this build does not change them.
- No keyboard hold (Space or Enter) of the service's own.
- No live test on a public site: only the operator says where (board ab-t30's limit: forum.bearchive.com only, from
  the Mac only, never from a datacenter address).

## Sources

1. https://docs.humansecurity.com/applications/human-challenge
2. https://docs.humansecurity.com/applications/create-a-human-challenge
3. https://docs.humansecurity.com/applications/human-challenge-integration-testing-process
4. https://docs.humansecurity.com/applications/customize-challenge-page
5. https://humansecurity.com/wp-content/uploads/2025/01/HMN_121124_Human-Challenge_Brief.pdf
6. https://adrianroselli.com/wp-content/uploads/2026/08/2.1.1-failure_wayfair.vtt
7. https://bugzilla.mozilla.org/show_bug.cgi?id=1949192
8. https://www.zenrows.com/blog/please-verify-you-are-human
9. https://www.zenrows.com/blog/playwright-perimeterx
10. https://scrappey.com/qa/web-automation/how-perimeterx-detects-bots
11. https://www.coronium.io/blog/press-and-hold-captcha
12. https://coderapp.vercel.app/answer/68848948
13. https://learn.microsoft.com/en-us/answers/questions/5775388/press-and-hold-issue
14. https://www.w3.org/TR/pointerevents/
