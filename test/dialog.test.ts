// JavaScript dialogs (board ab-exa): an alert, confirm, prompt or beforeunload dialog blocks its page. Chrome answers no
// page call of the tab while it is open, and only a session that saw it open can answer it (measured on the Linux server
// with Chromium 156; the fake Chrome models it: FakeChrome.openDialog). So a command stops at once at a dialog that it
// gives no answer, dismisses it before its session ends and fails with code "dialog"; --dialog accept|dismiss (and
// --dialog-text) answers it and the command goes on; a page that an earlier dialog blocks gives code "dialog" at the
// start; close closes such a tab. The library and the real CLI against the fake Chrome, directly (the fake's stand-in
// endpoint) and through agent mode's real relay. No browser starts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentBrowser } from "../src/browser.ts";
import { commands } from "../src/commands.ts";
import { DialogError, UsageError } from "../src/errors.ts";
import { USAGE } from "../src/cli.ts";
import { FakeChrome, type FakePage } from "./fake-chrome.ts";
import { backByChrome, harness, lineOf, type Harness } from "./fake-bridge.ts";
import { cli, consumer, flags, FIXTURE_HOST, fixtureServer, site } from "./helpers.ts";

const QUESTION = "Replace the list in use with the held list?";

/**
 * A page with a button whose click asks a confirm() (and writes the answer to the title), over either endpoint.
 * `focusEmulation`: a display that is not the agent browser's own (the drive of test/browser.test.ts, and the Mac's
 * default): each attach turns focus emulation on; through the relay, the Mac's relay.
 */
async function setup(agent: boolean, opts: { focusEmulation?: boolean } = {}) {
  const fx = await fixtureServer(FIXTURE_HOST), c = consumer([FIXTURE_HOST]);
  const chrome = await FakeChrome.start(site(fx.base));
  let h: Harness | undefined, end: (() => void) | undefined;
  // With focus emulation, the relay of the Mac (tabs, not a window per page): it sends Emulation.setFocusEmulationEnabled to Chrome.
  if (agent) { h = await harness(opts.focusEmulation ? { windowPerPage: false } : {}); end = await backByChrome(h.fake, chrome); await h.ready(lineOf([FIXTURE_HOST])); }
  const cdpUrl = agent ? h!.url("dialog-test") : chrome.cdpUrl;
  const o = c.options({ cdpUrl, ...(opts.focusEmulation ? { display: { own: false } } : {}) });
  const opened = await commands.open(o, { url: fx.base, name: "d" });
  const page = chrome.pages.get(opened.tab.targetId)!;
  /** The button #b asks `type` (a confirm by default); `then` runs after the answer (a second dialog, say). */
  const ask = (type = "confirm", then?: (p: FakePage, answer: { accept: boolean; promptText?: string }) => Promise<unknown>) => {
    page.select("#b")[0].onclick = async (p) => {
      const a = await chrome.openDialog(p, type, QUESTION, type === "prompt" ? "default" : "");
      p.title = type === "prompt" ? `answer: ${a.accept ? a.promptText ?? "default" : null}` : `answer: ${a.accept}`;
      await then?.(p, a);
    };
  };
  return { fx, c, chrome, page, h, o, ask, args: flags(c, cdpUrl),
    async close() { end?.(); await h?.close(); await chrome.close(); await fx.close(); c.remove(); },
  };
}

for (const agent of [false, true]) {
  const mode = agent ? "agent relay" : "the fake's stand-in endpoint";

  test(`${mode}: a confirm that a click opens stops the click at once with code dialog; agent-browser dismissed it, the page got false, and the next command works`, async () => {
    const f = await setup(agent);
    try {
      f.ask();
      const t0 = Date.now();
      const e = await commands.click(f.o, { tab: "d", target: "#b" }).then(() => assert.fail("the click went on"), (e) => e);
      assert.ok(e instanceof DialogError, String(e));
      assert.equal(e.code, "dialog");
      assert.ok(Date.now() - t0 < 10_000, `the click stopped at the dialog, not after a call's 60 s (${Date.now() - t0} ms)`);
      assert.ok(e.message.includes(`a JavaScript confirm dialog opened on tab ${f.page.targetId.slice(0, 8)}: ${JSON.stringify(QUESTION)}`), e.message);
      assert.match(e.message, /dismissed the dialog \(the page got false \(Cancel\)\)/);
      assert.match(e.message, /--dialog accept/);
      assert.deepEqual(f.page.dialogAnswers, [{ type: "confirm", accept: false }], "the click's own session dismissed it before it ended");
      assert.equal(f.page.dialog, undefined, "no dialog stays open");
      assert.equal(f.page.title, "answer: false");
      assert.match((await commands.text(f.o, { tab: "d" })).text, /Fixture page/, "the tab is not blocked");
    } finally { await f.close(); }
  });

  test(`${mode}: --dialog accept answers the dialog and the click goes on; --dialog dismiss; --dialog-text gives a prompt its text; the result lists the dialogs`, async () => {
    const f = await setup(agent);
    try {
      f.ask();
      const accepted = await commands.click(f.o, { tab: "d", target: "#b", dialog: "accept" });
      assert.deepEqual(accepted.dialogs, [{ type: "confirm", message: QUESTION, accepted: true }]);
      assert.equal(f.page.title, "answer: true");
      const dismissed = await commands.click(f.o, { tab: "d", target: "#b", dialog: "dismiss" });
      assert.deepEqual(dismissed.dialogs, [{ type: "confirm", message: QUESTION, accepted: false }]);
      assert.equal(f.page.title, "answer: false");
      f.ask("prompt");
      const typed = await commands.click(f.o, { tab: "d", target: "#b", dialog: "accept", dialogText: "the held list" });
      assert.deepEqual(typed.dialogs, [{ type: "prompt", message: QUESTION, accepted: true }]);
      assert.equal(f.page.title, "answer: the held list");
      assert.deepEqual(f.page.dialogAnswers.at(-1), { type: "prompt", accept: true, promptText: "the held list" });
      f.page.select("#b")[0].onclick = (p) => { p.title = "no dialog"; };
      const none = await commands.click(f.o, { tab: "d", target: "#b", dialog: "accept" });
      assert.equal("dialogs" in none, false, "no dialog: no dialogs in the result");
      assert.equal(f.page.dialog, undefined);
    } finally { await f.close(); }
  });

  test(`${mode}: a dialog that the page opens right after the dismissed one (an alert after Cancel) is dismissed too before the command ends`, async () => {
    const f = await setup(agent);
    try {
      f.ask("confirm", async (p, a) => { if (!a.accept) await f.chrome.openDialog(p, "alert", "Nothing was replaced."); });
      await assert.rejects(commands.click(f.o, { tab: "d", target: "#b" }), DialogError);
      assert.deepEqual(f.page.dialogAnswers, [{ type: "confirm", accept: false }, { type: "alert", accept: false }]);
      assert.equal(f.page.dialog, undefined, "no dialog stays open");
    } finally { await f.close(); }
  });

  test(`${mode}: a dialog that opened before the command blocks the page: text fails with code dialog after AgentBrowser.pageAnswerMs, not after 60 s, and close still closes the tab`, async () => {
    const f = await setup(agent);
    const limit = AgentBrowser.pageAnswerMs;
    AgentBrowser.pageAnswerMs = 400;
    try {
      // The page's own timer, with no command attached: no session saw it open, so none can answer it.
      void f.chrome.openDialog(f.page, "alert", "Session expires soon");
      const t0 = Date.now();
      const e = await commands.text(f.o, { tab: "d" }).then(() => assert.fail("the text came"), (e) => e);
      assert.ok(e instanceof DialogError, String(e));
      // Through the relay the attach also waits for the merge guard's Fetch.enable, which the fake holds while the dialog
      // is open (at most the guard's 3 s; not measured in Chrome).
      assert.ok(Date.now() - t0 < 15_000, `the text failed at the start, not after a call's 60 s (${Date.now() - t0} ms)`);
      assert.match(e.message, new RegExp(`^tab ${f.page.targetId.slice(0, 8)} does not answer: Chrome gave no answer to Page.enable in 0.4 s\\. Most likely a JavaScript dialog`));
      assert.ok(e.message.includes(`\`agent-browser close ${f.page.targetId.slice(0, 8)}\` closes the tab with the dialog open`), e.message);
      assert.ok(f.page.dialog, "the dialog is still open: no later session can answer it");
      const closed = await commands.close(f.o, { tab: "d" });
      assert.equal(closed.tab.targetId, f.page.targetId);
      assert.equal(f.chrome.pages.has(f.page.targetId), false, "the tab is closed");
      assert.ok(f.chrome.calls.some((x) => x.method === "Page.handleJavaScriptDialog"), "close tried the dismissal first (Chrome refuses it to a later session)");
    } finally { AgentBrowser.pageAnswerMs = limit; await f.close(); }
  });
}

for (const agent of [false, true]) {
  const mode = agent ? "agent relay" : "the fake's stand-in endpoint";
  test(`${mode}, the focus-emulation drive (review-213 B1): on a tab that an earlier dialog blocks, text fails at the start and close closes the tab, with no wait for focus emulation`, async () => {
    const f = await setup(agent, { focusEmulation: true });
    const limit = AgentBrowser.pageAnswerMs;
    AgentBrowser.pageAnswerMs = 400;
    try {
      void f.chrome.openDialog(f.page, "alert", "Session expires soon");
      const t0 = Date.now();
      await assert.rejects(commands.text(f.o, { tab: "d" }), (e: Error) => e instanceof DialogError && /does not answer: Chrome gave no answer to Page\.enable/.test(e.message));
      assert.ok(Date.now() - t0 < 15_000, `the text failed at the start, not after a call's 60 s (${Date.now() - t0} ms)`);
      const t1 = Date.now();
      await commands.close(f.o, { tab: "d" });
      assert.ok(Date.now() - t1 < 15_000, `the close did not wait for a call's 60 s (${Date.now() - t1} ms)`);
      assert.equal(f.chrome.pages.has(f.page.targetId), false, "the tab is closed");
    } finally { AgentBrowser.pageAnswerMs = limit; await f.close(); }
  });
}

test("open: a dialog that opens as the page loads names the tab that stays open, goto with --dialog accept on it, and close (not a second open, which opens another tab)", async () => {
  const f = await setup(false);
  try {
    const e = await commands.open(f.o, { url: f.fx.base + "/dialog-on-load", name: "draft" }).then(() => assert.fail("the open went on"), (e) => e);
    assert.ok(e instanceof DialogError, String(e));
    const page = [...f.chrome.pages.values()].find((p) => p.url.endsWith("/dialog-on-load"))!;
    const id = page.targetId.slice(0, 8);
    assert.ok(e.message.includes(`a JavaScript confirm dialog opened on tab ${id}: "Keep the draft?"`), e.message);
    assert.ok(e.message.includes(`The tab ${id} stays open: to accept the dialog, load the page again in that tab with \`agent-browser goto ${id} URL --dialog accept\``), e.message);
    assert.ok(e.message.includes(`\`agent-browser close ${id}\` closes it`), e.message);
    assert.equal(e.message.includes("run the command again"), false, e.message);
    assert.deepEqual(page.dialogAnswers, [{ type: "confirm", accept: false }]);
    const again = await commands.goto(f.o, { tab: id, url: f.fx.base + "/dialog-on-load", dialog: "accept" });
    assert.deepEqual(again.dialogs, [{ type: "confirm", message: "Keep the draft?", accepted: true }]);
  } finally { await f.close(); }
});

test("close accepts a beforeunload dialog that the close opens (as the relay's tabs.remove runs the page's beforeunload handler), and the tab closes", async () => {
  const f = await setup(false);
  try {
    f.chrome.closeRunsBeforeUnload = true;
    f.page.beforeUnload = true;
    await commands.close(f.o, { tab: "d" });
    assert.deepEqual(f.page.dialogAnswers, [{ type: "beforeunload", accept: true }]);
    assert.equal(f.chrome.pages.has(f.page.targetId), false);
  } finally { await f.close(); }
});

test("a dialog stops the command's input at once: no key after the dialog reaches the page", async () => {
  const f = await setup(false);
  try {
    await commands.goto(f.o, { tab: "d", url: f.fx.base + "/editor" });
    const page = f.chrome.pages.get(f.page.targetId)!;
    page.onKey = (k) => { if (k === "a") void f.chrome.openDialog(page, "alert", "a key opened me"); };
    const e = await commands.type(f.o, { tab: "d", text: "abcdef", into: "#cell" }).then(() => assert.fail("the typing went on"), (e) => e);
    assert.ok(e instanceof DialogError, String(e));
    assert.deepEqual(page.keys.filter((k) => "bcdef".includes(k)), [], `keys after the dialog: ${page.keys.join(",")}`);
    assert.equal(page.dialog, undefined);
  } finally { await f.close(); }
});

test("eval: --dialog accept answers a confirm() that the expression opens, and the value comes back", async () => {
  const f = await setup(false);
  try {
    const r = await commands.eval(f.o, { tab: "d", expression: `confirm(${JSON.stringify(QUESTION)})`, dialog: "accept" });
    assert.equal(r.value, true);
    assert.deepEqual(r.dialogs, [{ type: "confirm", message: QUESTION, accepted: true }]);
    await assert.rejects(commands.eval(f.o, { tab: "d", expression: `confirm("again")` }), (e: Error) => e instanceof DialogError && /confirm dialog opened/.test(e.message));
    assert.equal(f.page.dialog, undefined);
  } finally { await f.close(); }
});

test("--dialog is accept or dismiss, and --dialog-text needs --dialog accept: usage errors before any call", async () => {
  const f = await setup(false);
  try {
    const before = f.chrome.calls.length;
    await assert.rejects(commands.click(f.o, { tab: "d", target: "#b", dialog: "yes" }), (e: Error) => e instanceof UsageError && /--dialog is accept or dismiss/.test(e.message));
    await assert.rejects(commands.press(f.o, { tab: "d", key: "Enter", dialogText: "x" }), (e: Error) => e instanceof UsageError && /--dialog-text needs --dialog accept/.test(e.message));
    await assert.rejects(commands.eval(f.o, { tab: "d", expression: "1", dialog: "dismiss", dialogText: "x" }), UsageError);
    assert.equal(f.chrome.calls.length, before, "no CDP call");
  } finally { await f.close(); }
});

test("the CLI: a dialog gives the JSON error document with code dialog and exit status 1; --dialog accept prints the dialog on standard error in the text form; a bad --dialog is a usage error", async () => {
  const f = await setup(false);
  try {
    f.ask();
    const stopped = await cli(["click", "d", "#b", ...f.args, "--json"], { cwd: f.c.dir });
    assert.equal(stopped.status, 1, stopped.stdout + stopped.stderr);
    assert.equal(stopped.json.ok, false);
    assert.equal(stopped.json.command, "click");
    assert.equal(stopped.json.error.code, "dialog");
    assert.ok(stopped.json.error.message.includes(JSON.stringify(QUESTION)), stopped.json.error.message);
    const accepted = await cli(["click", "d", "#b", "--dialog", "accept", ...f.args], { cwd: f.c.dir });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.ok(accepted.stderr.includes(`agent-browser: a confirm dialog opened: ${JSON.stringify(QUESTION)}; accepted`), accepted.stderr);
    assert.equal(f.page.title, "answer: true");
    const bad = await cli(["press", "d", "Enter", "--dialog", "maybe", ...f.args, "--json"], { cwd: f.c.dir });
    assert.equal(bad.status, 2);
    assert.equal(bad.json.error.code, "usage");
  } finally { await f.close(); }
});

test("the help says that eval runs in an isolated world (a change of window.confirm there is not the page's) and names --dialog; close works while a dialog blocks the tab", () => {
  const evalLine = USAGE.split("\n").find((l) => l.trimStart().startsWith("eval <tab>"))!;
  assert.match(evalLine, /isolated world of the page \(its DOM, not its globals: a change of window\.confirm there does not change the page's; a dialog: --dialog\)/);
  assert.match(evalLine, /\[--dialog accept\|dismiss\]/);
  assert.match(USAGE, /eval runs in agent-browser's\nisolated world: the page's DOM, not its JavaScript globals \(a change of window\.confirm there is not the page's\)\./);
  assert.match(USAGE, /a command stops at once at a dialog\nthat opens during it, dismisses it, and fails with code "dialog"/);
  for (const name of ["open", "goto", "click", "hover", "type", "press", "eval"])
    assert.match(USAGE.split("\n").find((l) => l.trimStart().startsWith(`${name} <`))!, /--dialog accept\|dismiss/, name);
  assert.match(USAGE.split("\n").find((l) => l.trimStart().startsWith("close <tab>"))!, /also while a JavaScript dialog blocks it/);
});
