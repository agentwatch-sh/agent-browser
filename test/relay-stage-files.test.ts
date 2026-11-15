// The file chooser of the input stage (board ab-t30.12.2, part 2 of ab-t30.12; the input design's section 5.1, the rows of
// setInputFiles with paths and with buffers; C11 "The input stage", files). The operator's answer Q3 a (board item
// ab-0z5): "files from buffers get a click on the input, and the service writes them to the scope's own folder for the
// file chooser". Playwright's setInputFiles goes as a person's file choice: a click on the input (or on the label of a
// hidden input) with Chrome's file chooser intercepted, then the files to the input that the chooser names. With buffers
// the stage writes the files to a new folder of the tab's scope (src/relay/scope-files.ts) and the client's call goes with
// FILES_SET. The stage's tests run on the fake Chrome of stage-fakes.ts (no browser, a fake clock); the scope's folder on
// a temporary folder of its own; the model's refusal and its chooser hook on the fake bridge.

import { test } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import type { CDPConnection } from "../src/cdp.ts";
import { FILE_CHOOSER_WAIT_MS, FILE_PATH_MAX, STAGE_ACTION_MAX_MS, FILE_PROBE, FILES_MAX_BYTES, FILES_NOT_YOURS, FILES_PATH_FORM, FILES_SET, FILES_STATE, FILES_TOO_LARGE, STAGE_TEST_ENV, filePayloads, filesBytes, filesRefusal, filesSet, fileType, safeNames, type StageFile } from "../src/relay/stage.ts";
import { nearFolder, nearTo, relayTestFiles, SCOPE_FILES, ScopeFiles, STAGE_FILES_ENV, StateFolder, type FileLook } from "../src/relay/scope-files.ts";
import { FakeFiles, runVector, type FakeTab, type Sent } from "./stage-fakes.ts";
import { harness, until } from "./fake-bridge.ts";

const V = JSON.parse(readFileSync(new URL("./vectors/stage.json", import.meta.url), "utf8"));
const SET_FILES_FN = V.vectors.find((x: any) => x.id === "set-files-payloads").in[0].params.arguments[3].value as string;

// ---------------------------------------------------------------- the client's calls, as Playwright sends them

const setPaths = (node: string, files: string[] = ["/data/report.pdf"]) => ({ method: "DOM.setFileInputFiles", params: { objectId: node, files } });
const payload = (name: string, text = "hi", extra: object = {}) => ({ o: [{ k: "name", v: name }, { k: "mimeType", v: "text/plain" }, { k: "buffer", v: Buffer.from(text).toString("base64") }, ...Object.entries(extra).map(([k, v]) => ({ k, v }))] });
const setBuffers = (node: string, ...files: unknown[]) => ({ method: "Runtime.callFunctionOn",
  params: { functionDeclaration: "(utilityScript, ...args) => utilityScript.evaluate(...args)", objectId: "7.3.1", returnByValue: true, awaitPromise: true, userGesture: true,
    arguments: [{ objectId: "7.3.1" }, { value: true }, { value: true }, { value: SET_FILES_FN }, { value: 1 }, { value: { a: [{ h: 0 }, { h: 1 }, { a: files }] } }, { objectId: "7.3.2" }, { objectId: node }] } });
/** A vector of the tests' own: the calls in order, each after the answer of the one before. */
function own(calls: any[], page: Partial<any> = {}, extra: Partial<any> = {}) {
  const ins = calls.map((c, i) => ({ id: i + 1, ...(c.at === undefined && c.after === undefined && c.afterEvent === undefined ? (i === 0 ? { at: 0 } : { after: i }) : {}), ...c }));
  return { id: "own", platform: "linux", seed: 11, clock: 0, page: { viewport: { width: 1280, height: 720 }, last: { x: 900, y: 700 }, nodes: {}, focused: null, scopeFiles: true, ...page },
    chrome: { results: {} }, in: ins, out: [], answers: [], ...extra };
}
const FILE = (o: object = {}) => ({ tag: "input", type: "file", backendNodeId: 42, box: { x: 60, y: 500, width: 200, height: 30 }, focused: false, ...o });
const mine = (t: FakeTab) => t.sent.filter((s) => s.pass === undefined && !s.read);
const presses = (t: FakeTab) => t.sent.filter((s) => s.method === "Input.dispatchMouseEvent" && s.params.type === "mousePressed");
const intercepts = (t: FakeTab) => mine(t).filter((s) => s.method === "Page.setInterceptFileChooserDialog").map((s) => s.params.enabled);
const passOf = (t: FakeTab, id: number) => t.sent.find((s) => s.pass === id);
const answerOf = (r: Awaited<ReturnType<typeof runVector>>, id: number) => r.answers.find((a) => a.id === id);
const events = (t: FakeTab) => t.pageEvents.map((e) => `${e.type}${e.trusted ? "" : "(untrusted)"}`);
const fnOf = (s: Sent | undefined) => (s?.params as any)?.arguments?.[3]?.value;
const filesOf = (r: Awaited<ReturnType<typeof runVector>>) => r.stage.files as FakeFiles;

// ================================================================ the translations

test("setInputFiles with paths: the interception on, a click on the input, its chooser (to no client), the client's files to the input that the chooser names, the interception off; the page gets a trusted click, then trusted input and change", async () => {
  for (const seed of [11, 112, 213]) {
    const r = await runVector(own([setPaths("f")], { nodes: { f: FILE() } }), { seed });
    const w = `seed ${seed}`, sent = mine(r.tab), press = presses(r.tab)[0];
    assert.ok(press && press.params.x >= 110 && press.params.x <= 210 && press.params.y >= 511 && press.params.y <= 519, `${w}: a press on the input's middle`);
    assert.deepEqual(intercepts(r.tab), [true, false], `${w}: the interception on for the click only`);
    assert.ok(sent.indexOf(sent.find((s) => s.method === "Page.setInterceptFileChooserDialog")!) < sent.indexOf(press), `${w}: on before the press`);
    const set = sent.find((s) => s.method === "DOM.setFileInputFiles")!;
    assert.deepEqual(set.params, { files: ["/data/report.pdf"], backendNodeId: 42 }, `${w}: the client's files to the chooser's input`);
    assert.ok(sent.indexOf(set) > sent.indexOf(press) && sent.indexOf(set) < sent.lastIndexOf(sent.find((s) => s.params.enabled === false)!), `${w}: after the click, before the interception goes off`);
    assert.deepEqual(r.tab.choosers.map((c) => c.own), [true], `${w}: the chooser of the stage's click goes to no client`);
    assert.equal(r.tab.clientEvents.filter((e) => e.method === "Page.fileChooserOpened").length, 0);
    assert.deepEqual(events(r.tab), ["input", "change"], `${w}: the browser's trusted input and change`);
    assert.deepEqual(r.tab.inputFiles.get("f"), ["/data/report.pdf"]);
    assert.ok(!answerOf(r, 1)!.body.error);
    assert.deepEqual([r.stage.counts.fileClicks, r.stage.counts.filesByChooser], [1, 1]);
    assert.ok(r.tab.sent.some((x) => x.method === "Runtime.releaseObject" && x.params.objectId === "f"), `${w}: FILE_TARGET's handle goes at the end`);
  }
});

test("setInputFiles with buffers: the files in a new folder of the tab's scope, the click and the chooser, the stage's DOM.setFileInputFiles with their paths, then the client's call with FILES_SET; the page gets no untrusted event", async () => {
  const r = await runVector(own([setBuffers("f", payload("a.txt", "hello"), payload("b.csv", "x,y", { mimeType: "text/csv", lastModifiedMs: 1700000000000 }))], { nodes: { f: FILE({ multiple: true }) } }));
  assert.deepEqual(filesOf(r).writes, [{ scope: "s1", files: [{ name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("hello").toString("base64") },
    { name: "b.csv", mimeType: "text/csv", buffer: Buffer.from("x,y").toString("base64"), lastModifiedMs: 1700000000000 }] }], "the files of the tab's scope, written once");
  assert.equal(presses(r.tab).length, 1, "a click");
  const set = mine(r.tab).find((s) => s.method === "DOM.setFileInputFiles")!;
  assert.deepEqual(set.params, { files: ["/scope-files/s1/call-1/a.txt", "/scope-files/s1/call-1/b.csv"], backendNodeId: 42 });
  const pass = passOf(r.tab, 1)!;
  assert.equal(fnOf(pass), FILES_SET, "the client's call with FILES_SET");
  assert.deepEqual({ ...(pass.params as any), arguments: (pass.params as any).arguments.filter((_: unknown, i: number) => i !== 3) },
    { ...setBuffers("f").params, arguments: (setBuffers("f", payload("a.txt", "hello"), payload("b.csv", "x,y", { mimeType: "text/csv", lastModifiedMs: 1700000000000 })).params as any).arguments.filter((_: unknown, i: number) => i !== 3) }, "the rest of the call as the client sent it");
  assert.ok(r.tab.sent.indexOf(pass) > r.tab.sent.indexOf(set), "the call after the files");
  assert.deepEqual(intercepts(r.tab), [true, false]);
  assert.deepEqual(events(r.tab), ["input", "change"], "the browser's trusted events only");
  assert.ok(!answerOf(r, 1)!.body.error, "Chrome's answer to the call");
  assert.equal(r.stage.counts.filesByChooser, 1);
});

test("review-135 L1: a set files call goes as a person's choice only when each type that Chrome gives a written file is the client's mimeType; else it passes as the client sent it, counted (filesPass:type)", async () => {
  // Chrome's types: the written files on a file input of the stage's own world in no document, read, then released.
  const ok = await runVector(own([setBuffers("f", payload("a.txt", "hi", { mimeType: "Text/Plain" }), payload("c.pdf", "%PDF", { mimeType: "application/pdf" }))], { nodes: { f: FILE({ multiple: true }) } }));
  const own_ = ok.tab.sent.find((x) => x.method === "ownObject")!, probe = ok.tab.sent.find((x) => x.method === "DOM.setFileInputFiles" && String(x.params.objectId).startsWith("probe:"))!;
  assert.equal(own_.params.fn, FILE_PROBE);
  assert.deepEqual(probe.params.files, ["/scope-files/s1/call-1/a.txt", "/scope-files/s1/call-1/c.pdf"]);
  assert.ok(ok.tab.sent.indexOf(probe) < ok.tab.sent.indexOf(presses(ok.tab)[0]), "the types' read before the click");
  assert.ok(ok.tab.sent.some((x) => x.method === "Runtime.releaseObject" && x.params.objectId === probe.params.objectId), "the stage's own input goes");
  assert.equal(ok.stage.counts.filesByChooser, 1, "the types match (the mimeType in lower case, as File gives it)");
  for (const [name, mime] of [["report", "text/csv"], ["a.bin", "application/json"], ["b.csv", "text/plain"]]) {
    const r = await runVector(own([setBuffers("f", payload(name, "x", { mimeType: mime }))], { nodes: { f: FILE() } }));
    assert.equal(presses(r.tab).length, 0, `${name} ${mime}: no click`);
    assert.equal(fnOf(passOf(r.tab, 1)), SET_FILES_FN, `${name} ${mime}: the call as the client sent it`);
    assert.equal(r.stage.counts["filesPass:type"], 1, `${name} ${mime}: filesPass:type`);
    assert.deepEqual(events(r.tab), ["input(untrusted)", "change(untrusted)"], `${name}: Playwright's own script and events`);
  }
  // A read that fails (no handle of the stage's own world): the call passes, counted.
  const nr = await runVector(own([setBuffers("f", payload("a.txt"))], { nodes: { f: FILE() } }), { hook: (x) => (x.method === "ownObject" ? null : undefined) });
  assert.equal(nr.stage.counts["filesPass:noRead"], 1);
  assert.equal(fileType("Text/CSV"), "text/csv");
  assert.equal(fileType("text/caf\u00e9"), "", "a type out of U+0020 to U+007E: File gives \"\"");
});

test("a hidden input with a label: the click goes on the label, and the chooser names the input", async () => {
  const r = await runVector(own([setPaths("f")], { nodes: { f: FILE({ box: { x: 0, y: 0, width: 0, height: 0 }, label: "lb" }), lb: { tag: "label", control: "f", box: { x: 300, y: 200, width: 120, height: 30 }, focused: false } } }));
  const press = presses(r.tab)[0];
  assert.ok(press.params.x >= 330 && press.params.x <= 390 && press.params.y >= 210 && press.params.y <= 220, "a press on the label");
  assert.deepEqual(mine(r.tab).find((s) => s.method === "DOM.setFileInputFiles")!.params, { files: ["/data/report.pdf"], backendNodeId: 42 });
  assert.equal(r.stage.counts.filesByChooser, 1);
});

test("the client's interception on: the stage sends no interception of its own, and the chooser of its click still goes to no client", async () => {
  const r = await runVector(own([{ method: "Page.setInterceptFileChooserDialog", params: { enabled: true } }, setPaths("f")], { nodes: { f: FILE() } }));
  assert.deepEqual(intercepts(r.tab), [], "no interception of the stage's own");
  assert.deepEqual(r.tab.choosers.map((c) => c.own), [true]);
  assert.equal(r.tab.clientEvents.filter((e) => e.method === "Page.fileChooserOpened").length, 0);
  assert.equal(r.tab.intercept, true, "the client's interception stays on");
  assert.equal(r.stage.counts.filesByChooser, 1);
});

test("the client's own open chooser (its click opened it, with its interception on): the client's next file call of that input gets its files with no click; a navigation closes it", async () => {
  // The chooser that went to the client (no wait of the stage): Playwright's fileChooser.setFiles() then sends the call.
  const r = await runVector(own([setPaths("f")], { nodes: { f: FILE() } }), { tab: (t) => { assert.equal(t.stage.chooser(t, { frameId: "main", mode: "selectSingle", backendNodeId: 42 }), false, "the event goes to the client"); } });
  assert.equal(presses(r.tab).length, 0, "no click");
  assert.deepEqual(intercepts(r.tab), []);
  assert.deepEqual(mine(r.tab).find((s) => s.method === "DOM.setFileInputFiles")!.params, { files: ["/data/report.pdf"], backendNodeId: 42 });
  assert.equal(r.stage.counts.filesInChooser, 1);
  const b = await runVector(own([setBuffers("f", payload("a.txt"))], { nodes: { f: FILE() } }), { tab: (t) => { t.stage.chooser(t, { backendNodeId: 42 }); } });
  assert.equal(presses(b.tab).length, 0, "buffers: no click");
  assert.equal(fnOf(passOf(b.tab, 1)), FILES_SET);
  assert.deepEqual(events(b.tab), ["input", "change"]);
  // After a navigation of the main frame the chooser is closed: a click again.
  const n = await runVector(own([setPaths("f")], { nodes: { f: FILE() } }), { tab: (t) => { t.stage.chooser(t, { backendNodeId: 42 }); t.stage.event(t, undefined, "Page.frameNavigated", { frame: { id: "main" } }); } });
  assert.equal(presses(n.tab).length, 1);
  assert.equal(n.stage.counts.filesInChooser, undefined);
});

// ================================================================ the ends

test("the ends: no chooser in FILE_CHOOSER_WAIT_MS, a chooser of another input, a covered input, a navigation in the wait, a write that fails: the client's call as it sent it, counted, and the interception off (with no chooser after STAGE_ACTION_MAX_MS)", async () => {
  const cases: [string, any, string, object?][] = [
    ["no chooser", setPaths("f"), "noChooser", { f: FILE({ noChooser: true }) }],
    ["another input's chooser", setPaths("f"), "otherInput", { f: FILE({ chooserNode: 43 }) }],
    ["no chooser (buffers)", setBuffers("f", payload("a.txt")), "noChooser", { f: FILE({ noChooser: true }) }],
  ];
  for (const [name, call, k, nodes] of cases) {
    const r = await runVector(own([call], { nodes }));
    assert.equal(presses(r.tab).length, 1, `${name}: the click`);
    // Review-135 N1: with no chooser the stage keeps its interception on for a late chooser, up to STAGE_ACTION_MAX_MS.
    if (k === "noChooser") { assert.deepEqual(intercepts(r.tab), [true], `${name}: the interception on after the pass`); await r.clock.advance(STAGE_ACTION_MAX_MS); }
    assert.deepEqual(intercepts(r.tab), [true, false], `${name}: the interception off`);
    const pass = passOf(r.tab, 1)!;
    assert.ok(pass, `${name}: the call as the client sent it`);
    assert.equal(call.method === "DOM.setFileInputFiles" ? (pass.params as any).objectId : fnOf(pass), call.method === "DOM.setFileInputFiles" ? "f" : SET_FILES_FN, name);
    assert.equal(r.stage.counts[`filesPass:${k}`], 1, `${name}: filesPass:${k}`);
    if (k === "noChooser") assert.ok(pass.t - presses(r.tab)[0].t >= FILE_CHOOSER_WAIT_MS, `${name}: after ${FILE_CHOOSER_WAIT_MS} ms`);
  }
  // The files are written before the click (review-135 L1: the types' read); with no chooser no input of the page gets them.
  const nc = await runVector(own([setBuffers("f", payload("a.txt"))], { nodes: { f: FILE({ noChooser: true }) } }));
  assert.equal(nc.tab.inputFiles.has("f") && nc.tab.inputFiles.get("f")![0].startsWith("/scope-files/"), false, "no written file on the page's input with no chooser");
  // Another element covers the input at the point: no click.
  const c = await runVector(own([setPaths("f")], { nodes: { f: FILE(), cover: { tag: "div", box: { x: 100, y: 505, width: 120, height: 20 } } } }));
  assert.equal(presses(c.tab).length, 0);
  assert.deepEqual(intercepts(c.tab), []);
  assert.equal(c.stage.counts["filesPass:noClick"], 1);
  // A navigation of the main frame in the wait.
  const n = await runVector(own([setPaths("f")], { nodes: { f: FILE({ noChooser: true }) } }), { tab: (t) => { t.hook = (s) => { if (s.method === "Input.dispatchMouseEvent" && s.params.type === "mouseReleased") setImmediate(() => t.stage.event(t, undefined, "Page.frameNavigated", { frame: { id: "main" } })); return undefined; }; } });
  assert.equal(n.stage.counts["filesPass:navigated"], 1);
  assert.ok(passOf(n.tab, 1));
  // The scope's folder cannot take the files: Playwright's own script gives them.
  const wf = await runVector(own([setBuffers("f", payload("a.txt"))], { nodes: { f: FILE() } }), { tab: (t) => { (t.stage.files as FakeFiles).fail = true; } });
  assert.equal(wf.stage.counts["filesPass:write"], 1);
  assert.equal(fnOf(passOf(wf.tab, 1)), SET_FILES_FN);
  assert.ok(wf.logs.some((l) => /the files of a set files call were not written \(ENOSPC\)$/.test(l)), "the log names the error's code, no file");
  assert.ok(!wf.logs.some((l) => l.includes("a.txt")), "no file name in a log line");
});

test("review-135b N2: a file call that passes before the chooser (a name that the stage does not write, a type that is not the client's) ends the client's open chooser: the next file call of its input gets a click", async () => {
  const calls: [string, any][] = [
    ["a name", setBuffers("f", payload("a/b.txt"))],
    ["a type", setBuffers("f", payload("b.csv", "x", { mimeType: "text/plain" }))],
  ];
  for (const [name, call] of calls) {
    const r = await runVector(own([call, setPaths("f")], { nodes: { f: FILE() } }), { tab: (t) => { assert.equal(t.stage.chooser(t, { backendNodeId: 42 }), false); } });
    assert.ok(passOf(r.tab, 1), `${name}: the first call passes`);
    assert.equal(presses(r.tab).length, 1, `${name}: the next file call of the input gets a click`);
    assert.equal(r.stage.counts.filesInChooser, undefined, `${name}: no files in a chooser that is closed`);
    assert.equal(r.stage.counts.filesByChooser, 1, name);
  }
});

test("review-135 N1: a chooser that opens after FILE_CHOOSER_WAIT_MS goes to no client and opens no dialog: the stage's interception stays on until it comes, and then goes off; with the client's interception on, the chooser of the stage's input goes to no client and is not the client's open chooser", async () => {
  // The stage's own interception (the client has it off): the late chooser goes to no client, and the interception goes off at once.
  const r = await runVector(own([setPaths("f")], { nodes: { f: FILE({ noChooser: true }) } }));
  assert.equal(r.stage.counts["filesPass:noChooser"], 1);
  assert.equal(r.tab.intercept, true, "the interception stays on after the pass");
  await r.clock.advance(5000);
  assert.equal(r.stage.chooser(r.tab, { frameId: "main", mode: "selectSingle", backendNodeId: 42 }), true, "the late chooser goes to no client");
  await r.clock.advance(1);
  assert.deepEqual(intercepts(r.tab), [true, false], "the interception off at the late chooser");
  assert.equal(r.stage.counts.fileChooserLate, 1);
  assert.equal(r.stage.chooser(r.tab, { backendNodeId: 42 }), false, "a chooser after the wait's end goes to the client");
  // The client's interception on: the late chooser of the stage's input goes to no client and opens no chooser of the
  // client's (the next set files call of that input gets a click); another input's chooser goes to the client.
  const c = await runVector(own([{ method: "Page.setInterceptFileChooserDialog", params: { enabled: true } }, setPaths("f")], { nodes: { f: FILE({ noChooser: true }) } }));
  assert.equal(c.stage.chooser(c.tab, { backendNodeId: 43 }), false, "another input's chooser goes to the client");
  assert.equal(c.stage.chooser(c.tab, { backendNodeId: 42 }), true, "the stage's input's chooser goes to no client");
  assert.deepEqual(intercepts(c.tab), [], "no interception of the stage's own");
  assert.equal(c.tab.intercept, true, "the client's interception stays on");
  assert.equal((c.stage as any).st(c.tab).openChooser, 43, "only the client's own chooser is open");
  // A navigation of the main frame ends the wait: the interception goes off.
  const n = await runVector(own([setPaths("f")], { nodes: { f: FILE({ noChooser: true }) } }));
  n.stage.event(n.tab, undefined, "Page.frameNavigated", { frame: { id: "main" } });
  await n.clock.advance(1);
  assert.deepEqual(intercepts(n.tab), [true, false], "a navigation: the interception off");
  assert.equal(n.stage.chooser(n.tab, { backendNodeId: 42 }), false);
});

test("review-140 N1, N2 and N8: the client's interception that comes in the click's wait (it goes to Chrome after the click's step: review-144 N1) or in the late wait holds (the wait's end sends nothing, and another input's chooser goes to the client); the stage's next file click ends the late wait; a client's setting that waits in the gate behind a file call is not Chrome's yet", async () => {
  const SET_ON = { method: "Page.setInterceptFileChooserDialog", params: { enabled: true } };
  // N1: the client's setting arrives in the click's FILE_CHOOSER_WAIT_MS; it goes to Chrome after the step, with the late wait on.
  const a = await runVector(own([setPaths("f"), { ...SET_ON, at: 1000 }], { nodes: { f: FILE({ noChooser: true }) } }));
  assert.equal(a.stage.counts["filesPass:noChooser"], 1);
  assert.ok(passOf(a.tab, 2)!.t >= FILE_CHOOSER_WAIT_MS, "the client's setting goes to Chrome after the step");
  assert.equal(a.stage.chooser(a.tab, { backendNodeId: 43 }), false, "N1: another input's chooser goes to the client");
  await a.clock.advance(STAGE_ACTION_MAX_MS);
  assert.deepEqual(intercepts(a.tab), [true], "N1: the wait's end does not turn the client's interception off");
  assert.equal(a.tab.intercept, true, "N1: Chrome's interception stays on, as the client set it");
  // N2: the client's setting in the late wait (after the step): the stage's input's late chooser goes to no client, and the
  // interception stays the client's.
  const b = await runVector(own([setPaths("f"), { ...SET_ON, after: 1, waitMs: 3000 }], { nodes: { f: FILE({ noChooser: true }) } }));
  assert.ok(passOf(b.tab, 2)!.t - passOf(b.tab, 1)!.t >= 3000, "the setting in the late wait");
  assert.equal(b.stage.chooser(b.tab, { backendNodeId: 42 }), true, "N2: the late chooser of the stage's input goes to no client");
  assert.equal(b.stage.counts.fileChooserLate, 1);
  await b.clock.advance(STAGE_ACTION_MAX_MS);
  assert.deepEqual(intercepts(b.tab), [true], "N2: no interception off of the stage's");
  assert.equal(b.tab.intercept, true, "N2: the client's interception stays on");
  // N2: the stage's next file click ends the late wait: its interception off, then on for the new click.
  const G = FILE({ backendNodeId: 44, box: { x: 60, y: 600, width: 200, height: 30 } });
  const c = await runVector(own([setPaths("f"), setPaths("g")], { nodes: { f: FILE({ noChooser: true }), g: G } }));
  assert.equal(c.stage.counts["filesPass:noChooser"], 1);
  assert.equal(c.stage.counts.filesByChooser, 1, "the next click's chooser");
  assert.deepEqual(intercepts(c.tab), [true, false, true, false], "N2: the late wait's end at the next file click, then the new click's interception");
  assert.equal(c.stage.chooser(c.tab, { backendNodeId: 42 }), false, "N2: no late wait after the next click: the chooser goes to the client");
  assert.deepEqual(intercepts(c.tab), [true, false, true, false]);
  // N8: the client's setting arrives with the file call, behind it in the gate: Chrome's interception is still off, so the
  // stage's click turns it on (no native dialog); the client's setting then goes to Chrome.
  const atPress: boolean[] = [];
  const d = await runVector(own([setPaths("f"), { ...SET_ON, at: 0 }], { nodes: { f: FILE() } }), { tab: (t) => { t.hook = (s) => { if (s.method === "Input.dispatchMouseEvent" && s.params.type === "mousePressed") atPress.push(t.intercept); return undefined; }; } });
  assert.deepEqual(atPress, [true], "N8: Chrome's interception is on at the stage's press");
  assert.equal(d.stage.counts.filesByChooser, 1, "N8: the chooser of the click goes to the stage");
  assert.deepEqual(intercepts(d.tab), [true, false], "N8: the stage's own interception, on and off");
  assert.equal(d.tab.intercept, true, "N8: the client's setting goes to Chrome last");
  assert.equal((d.stage as any).st(d.tab).clientChooser, true);
});

test("a dialog at the click ends the plan: the client's call goes as it sent it after the close, counted", async () => {
  const v = own([setPaths("f"), { afterEvent: "Page.javascriptDialogOpening", waitMs: 300, method: "Page.handleJavaScriptDialog", params: { accept: true } }], { nodes: { f: FILE({ noChooser: true }) } });
  const r = await runVector(v, { tab: (t) => { t.opensDialog = (s) => s.method === "Input.dispatchMouseEvent" && s.params.type === "mouseReleased"; } });
  assert.equal(r.stage.counts["filesPass:ended"], 1);
  assert.ok(passOf(r.tab, 1));
  assert.ok(!answerOf(r, 1)!.body.error);
});

test("the end of the client's session in the wait for the chooser: the call does not go, and nothing goes back", async () => {
  const r = await runVector(own([setPaths("f")], { nodes: { f: FILE({ noChooser: true }) } }), { tab: (t) => { t.hook = (s) => { if (s.method === "Input.dispatchMouseEvent" && s.params.type === "mouseReleased") setImmediate(() => t.stage.drop(t.id, "session")); return undefined; }; } });
  assert.equal(r.tab.sent.filter((s) => s.pass === 1).length, 0, "the call does not go");
  assert.equal(answerOf(r, 1), undefined, "no answer");
});

// ================================================================ the passes and the refusal

test("these pass as the client sent them, and the stage counts each: the Mac, a frame's session, no file input, a disabled or a directory input, no box and no label, no files, unsafe or same names, no folder", async () => {
  const cases: [string, any, string, Partial<any>, Partial<any>?][] = [
    ["the Mac", setPaths("f"), "mac", { nodes: { f: FILE() } }, { platform: "mac" }],
    ["the Mac (buffers)", setBuffers("f", payload("a.txt")), "mac", { nodes: { f: FILE() } }, { platform: "mac" }],
    ["a text input", setPaths("f"), "notFile", { nodes: { f: { tag: "input", type: "text", box: { x: 60, y: 500, width: 200, height: 30 }, backendNodeId: 42 } } }],
    ["a disabled input", setPaths("f"), "disabled", { nodes: { f: FILE({ disabled: true }) } }],
    ["a directory input", setPaths("f"), "directory", { nodes: { f: FILE({ directory: true }) } }],
    ["no box and no label", setPaths("f"), "noBox", { nodes: { f: FILE({ box: { x: 0, y: 0, width: 0, height: 0 } }) } }],
    ["no files", setBuffers("f"), "empty", { nodes: { f: FILE() } }],
    ["a name with a path part", setBuffers("f", payload("a/b.txt")), "name", { nodes: { f: FILE() } }],
    ["a name with a back slash", setBuffers("f", payload("a\\b.txt")), "name", { nodes: { f: FILE() } }],
    ["the name ..", setBuffers("f", payload("..")), "name", { nodes: { f: FILE() } }],
    ["an empty name", setBuffers("f", payload("")), "name", { nodes: { f: FILE() } }],
    ["a name of 256 bytes", setBuffers("f", payload("x".repeat(256))), "name", { nodes: { f: FILE() } }],
    ["two files of one name", setBuffers("f", payload("a.txt"), payload("a.txt")), "name", { nodes: { f: FILE({ multiple: true }) } }],
    ["no folder (the relay of the old path)", setBuffers("f", payload("a.txt")), "noFolder", { nodes: { f: FILE() }, scopeFiles: false }],
  ];
  for (const [name, call, k, page, extra] of cases) {
    const r = await runVector(own([call], page, extra ?? {}));
    assert.equal(presses(r.tab).length, 0, `${name}: no click`);
    assert.deepEqual(intercepts(r.tab), [], `${name}: no interception`);
    const pass = passOf(r.tab, 1)!;
    assert.ok(pass && (call.method === "DOM.setFileInputFiles" ? (pass.params as any).objectId === "f" : fnOf(pass) === SET_FILES_FN), `${name}: the call as the client sent it`);
    assert.equal(r.stage.counts[`filesPass:${k}`], 1, `${name}: filesPass:${k}`);
  }
  // A frame's own session: both calls pass, counted.
  for (const call of [setPaths("f"), setBuffers("f", payload("a.txt"))]) {
    const r = await runVector(own([{ ...call, session: "child" }], { nodes: { f: FILE() } }));
    assert.equal(presses(r.tab).length, 0);
    assert.equal(r.stage.counts["filesPass:frame"], 1);
    assert.ok(passOf(r.tab, 1));
  }
});

test("a set files call of FILES_MAX_BYTES or more in all: an error that names the limit, with no click and no file", async () => {
  const half = "A".repeat(Math.ceil(FILES_MAX_BYTES / 2 / 3) * 4);
  const r = await runVector(own([setBuffers("f", { o: [{ k: "name", v: "a.bin" }, { k: "mimeType", v: "application/octet-stream" }, { k: "buffer", v: half }] }, { o: [{ k: "name", v: "b.bin" }, { k: "mimeType", v: "application/octet-stream" }, { k: "buffer", v: half }] })], { nodes: { f: FILE({ multiple: true }) } }));
  assert.deepEqual(answerOf(r, 1)!.body.error, { code: -32000, message: FILES_TOO_LARGE });
  assert.match(FILES_TOO_LARGE, /50 MiB/);
  assert.equal(r.tab.sent.length, 0, "no click, no read, no call");
  assert.equal(filesOf(r).writes.length, 0);
  assert.equal(r.stage.counts.filesRefused, 1);
});

test("filePayloads reads Playwright's files; filesBytes sums their bytes; safeNames refuses a path part, a dot name, an empty or long name and a name twice; filesSet changes only the function's text", () => {
  const f = (name: string, extra: object = {}): StageFile => ({ name, mimeType: "text/plain", buffer: "aGk=", ...extra });
  assert.deepEqual(filePayloads([{ name: "a", mimeType: "x/y", buffer: "aGk=", lastModifiedMs: 5 }]), [{ name: "a", mimeType: "x/y", buffer: "aGk=", lastModifiedMs: 5 }]);
  assert.equal(filePayloads([{ name: "a", mimeType: "x/y" }]), null);
  assert.equal(filePayloads("a"), null);
  assert.equal(filePayloads([{ name: "a", mimeType: "x/y", buffer: "aGk=", lastModifiedMs: "now" }]), null);
  assert.equal(filesBytes([f("a"), f("b", { buffer: Buffer.alloc(1000).toString("base64") })]), 1002);
  assert.equal(safeNames([f("report 1.pdf"), f(".env"), f("ünïcode.txt")]), true);
  for (const bad of [[f("a/b")], [f("a\\b")], [f("a\0b")], [f(".")], [f("..")], [f("")], [f("é".repeat(128))], [f("a"), f("a")]]) assert.equal(safeNames(bad), false, JSON.stringify(bad.map((x) => x.name)).slice(0, 40));
  const call = setBuffers("f", payload("a.txt")).params, out = filesSet(call);
  assert.equal(out.arguments[3].value, FILES_SET);
  assert.deepEqual({ ...out, arguments: out.arguments.filter((_: unknown, i: number) => i !== 3) }, { ...call, arguments: call.arguments.filter((_: unknown, i: number) => i !== 3) });
  assert.equal(call.arguments[3].value, SET_FILES_FN, "the client's own call stays");
});

// ================================================================ the scope's own folder (src/relay/scope-files.ts)

test("review-135b N4: a start with the stage off removes an earlier run's folder of the stage's files, and makes none", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-scope-files-"));
  try {
    mkdirSync(join(dir, SCOPE_FILES, "old"), { recursive: true });
    writeFileSync(join(dir, SCOPE_FILES, "old", "x.txt"), "x");
    await ScopeFiles.clear(dir);
    assert.equal(existsSync(join(dir, SCOPE_FILES)), false, "the earlier run's folder is gone");
    await ScopeFiles.clear(dir);
    assert.deepEqual(readdirSync(dir), [], "no folder, also at a start with none");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the scopes' folder: the start removes an earlier run's files; mode 0700 folders, a new folder for each call, 0600 files with the client's time; the scope's end removes its folder; holds sees a path in it, also through a link", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-scope-files-"));
  try {
    mkdirSync(join(dir, SCOPE_FILES, "old"), { recursive: true });
    writeFileSync(join(dir, SCOPE_FILES, "old", "x.txt"), "x");
    const sf = await ScopeFiles.open(dir);
    assert.deepEqual(readdirSync(sf.root), [], "the start removed the earlier run's files");
    assert.equal(statSync(sf.root).mode & 0o777, 0o700);
    const a = await sf.write("s1", [{ name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("hello").toString("base64"), lastModifiedMs: 1700000000000 }]);
    const b = await sf.write("s1", [{ name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("again").toString("base64") }]);
    const c = await sf.write("s2", [{ name: "c.txt", mimeType: "text/plain", buffer: "" }]);
    assert.notEqual(a[0], b[0], "a new folder for each call: no file over another");
    assert.ok(a[0].startsWith(join(sf.root, "s1") + "/") && c[0].startsWith(join(sf.root, "s2") + "/"), "each scope's files in its own folder");
    assert.equal(readFileSync(a[0], "utf8"), "hello");
    assert.equal(statSync(a[0]).mode & 0o777, 0o600);
    for (const p of [join(sf.root, "s1"), join(a[0], "..")]) assert.equal(statSync(p).mode & 0o777, 0o700, p);
    assert.equal(statSync(a[0]).mtimeMs, 1700000000000, "the client's lastModifiedMs");
    assert.equal(statSync(c[0]).size, 0);
    await assert.rejects(sf.write("../x", [{ name: "a", mimeType: "", buffer: "" }]), /not a scope's name/);
    // holds: a path in the folder, also through a link to it; not a path beside it.
    symlinkSync(join(sf.root, "s1"), join(dir, "link"));
    assert.equal(sf.holds(a[0]), true);
    assert.equal(sf.holds(join(dir, "link", "x")), true, "a link into the folder");
    assert.equal(sf.holds(join(dir, "scope-files-other", "x")), false);
    assert.equal(sf.holds("/data/report.pdf"), false);
    // review-135 B2: a link, then `..`: the kernel follows the link first (into s1, then up to the root), a text resolve does not.
    const tricky = `${dir}/link/../${relative(sf.root, c[0])}`;
    assert.equal(realpathSync.native(tricky).startsWith(realpathSync.native(sf.root) + "/"), true, "the kernel reaches the stage's folder");
    assert.equal(sf.holds(tricky), false, "holds alone misses it");
    assert.equal(filesRefusal(sf, "DOM.setFileInputFiles", { files: [tricky] }), FILES_PATH_FORM, "the model refuses its form");
    // review-135b R1: Chrome cuts a path at its first NUL byte, so `<folder>\0` is the folder itself (a webkitdirectory input
    // or a drop would give the page every scope's files); holds() sees another path.
    assert.equal(sf.holds(`${sf.root}\0`), false, "holds alone misses it");
    assert.equal(filesRefusal(sf, "DOM.setFileInputFiles", { files: [`${sf.root}\0`] }), FILES_PATH_FORM, "a NUL byte: refused");
    assert.equal(filesRefusal(sf, "Input.dispatchDragEvent", { data: { files: ["/data/report.pdf", `${sf.root}/s1\0x`] } }), FILES_PATH_FORM, "a NUL byte in a drop's files: refused");
    assert.equal(filesRefusal(sf, "Input.dispatchDragEvent", { data: { files: [a[0]] } }), FILES_NOT_YOURS);
    assert.equal(filesRefusal(sf, "Input.dispatchDragEvent", { data: { items: [] } }), null);
    assert.equal(filesRefusal(sf, "DOM.setFileInputFiles", { files: ["/data/report.pdf"] }), null);
    await sf.endScope("s1");
    assert.equal(existsSync(join(sf.root, "s1")), false, "the scope's end removed its folder");
    assert.equal(existsSync(c[0]), true, "another scope's files stay");
    assert.equal(lstatSync(join(dir, "link")).isSymbolicLink(), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the live rows' door: STAGE_FILES_ENV gives the relay a folder only with the stage's test value and an absolute path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-scope-files-"));
  try {
    const logs: string[] = [];
    assert.equal(await relayTestFiles({ [STAGE_FILES_ENV]: dir }, (l) => logs.push(l)), null, "no stage test value");
    assert.equal(await relayTestFiles({ [STAGE_TEST_ENV]: "test", [STAGE_FILES_ENV]: "rel" }, (l) => logs.push(l)), null, "a relative path");
    const sf = await relayTestFiles({ [STAGE_TEST_ENV]: "test", [STAGE_FILES_ENV]: dir }, (l) => logs.push(l));
    assert.equal(sf?.root, join(dir, SCOPE_FILES));
    assert.ok(logs.every((l) => !l.includes(dir)), "no path in the log");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ================================================================ the model

async function page(h: Awaited<ReturnType<typeof harness>>, c: CDPConnection) {
  await c.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const attached = c.waitForEvent("Target.attachedToTarget");
  const { targetId } = await c.send("Target.createTarget", { url: "about:blank" });
  const ev = await attached;
  return { targetId, sessionId: ev.sessionId as string, tab: [...h.fake.tabs.values()].find((t) => t.targetId === targetId)! };
}

test("the model: a client's DOM.setFileInputFiles that names a file of the stage's folder gets an error; a chooser that the stage does not wait for goes to the client; the end of the scope removes its folder", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-scope-files-"));
  const files = await ScopeFiles.open(dir);
  const h = await harness({ stage: true, files } as any);
  try {
    await h.ready();
    const c = await h.connect("s7");
    const p = await page(h, c);
    const [held] = await files.write("s7", [{ name: "a.txt", mimeType: "text/plain", buffer: "aGk=" }]);
    const from = h.fake.requests.length;
    await assert.rejects(c.send("DOM.setFileInputFiles", { objectId: "7.3.19", files: [held] }, p.sessionId), (e: Error) => e.message.includes(FILES_NOT_YOURS));
    await assert.rejects(c.send("DOM.setFileInputFiles", { objectId: "7.3.19", files: [join(dir, SCOPE_FILES, "s8", "b.txt")] }, p.sessionId), (e: Error) => e.message.includes(FILES_NOT_YOURS), "another scope's path too");
    // review-135 B1: Input.dispatchDragEvent's data.files too; B2: a path with a `..` part, also outside the folder, and a relative path.
    await assert.rejects(c.send("Input.dispatchDragEvent", { type: "drop", x: 10, y: 10, data: { items: [], files: [join(files.root, "s8")], dragOperationsMask: 1 } }, p.sessionId), (e: Error) => e.message.includes(FILES_NOT_YOURS), "a drop of another scope's folder");
    await assert.rejects(c.send("DOM.setFileInputFiles", { objectId: "7.3.19", files: ["/proc/self/root/../" + held.slice(1)] }, p.sessionId), (e: Error) => e.message.includes(FILES_PATH_FORM), "a link, then ..");
    await assert.rejects(c.send("Input.dispatchDragEvent", { type: "drop", x: 10, y: 10, data: { items: [], files: ["/tmp/../etc/hostname"], dragOperationsMask: 1 } }, p.sessionId), (e: Error) => e.message.includes(FILES_PATH_FORM), "a .. part outside the folder");
    await assert.rejects(c.send("DOM.setFileInputFiles", { objectId: "7.3.19", files: ["a.txt"] }, p.sessionId), (e: Error) => e.message.includes(FILES_PATH_FORM), "a relative path");
    // review-135b R1: a NUL byte (Chrome cuts the path there: the stage's folder itself).
    await assert.rejects(c.send("DOM.setFileInputFiles", { objectId: "7.3.19", files: [`${files.root}\0`] }, p.sessionId), (e: Error) => e.message.includes(FILES_PATH_FORM), "a NUL byte");
    await assert.rejects(c.send("Input.dispatchDragEvent", { type: "drop", x: 10, y: 10, data: { items: [], files: [`${files.root}/s8\0`], dragOperationsMask: 1 } }, p.sessionId), (e: Error) => e.message.includes(FILES_PATH_FORM), "a NUL byte in a drop's files");
    // review-135 N3: on a frame's own session too (the model checks before the stage's arrive).
    h.fake.emit("debugger.onEvent", { source: { tabId: p.tab.id }, method: "Target.attachedToTarget", params: { sessionId: "FR1", waitingForDebugger: false,
      targetInfo: { targetId: "FR1T", type: "iframe", title: "", url: "https://a.example/f", attached: true, canAccessOpener: false, browserContextId: "C1" } } });
    await new Promise((r) => setTimeout(r, 20));
    await assert.rejects(c.send("DOM.setFileInputFiles", { objectId: "9.3.1", files: [held] }, "FR1"), (e: Error) => e.message.includes(FILES_NOT_YOURS), "a frame's session: a file of the folder");
    await assert.rejects(c.send("Input.dispatchDragEvent", { type: "drop", x: 10, y: 10, data: { items: [], files: ["a.txt"], dragOperationsMask: 1 } }, "FR1"), (e: Error) => e.message.includes(FILES_PATH_FORM), "a frame's session: a relative path in a drop");
    assert.equal(h.fake.requests.slice(from).filter((r) => r.op === "debugger.sendCommand" && (r.args[1] === "DOM.setFileInputFiles" || r.args[1] === "Input.dispatchDragEvent")).length, 0, "no such call reaches Chrome");
    // A drop with no file of the folder goes on, as before.
    const drop = c.send("Input.dispatchDragEvent", { type: "dragEnter", x: 10, y: 10, data: { items: [{ mimeType: "text/plain", data: "x" }], dragOperationsMask: 1 } }, p.sessionId).catch(() => {});
    await until(() => h.fake.requests.slice(from).some((r) => r.op === "debugger.sendCommand" && r.args[1] === "Input.dispatchDragEvent"), "the drop without files reaches Chrome", 3000);
    await drop;
    // review-140 N8: the client's interception counts for the stage as the model sends the call to Chrome (the model's hook).
    const tabState = () => (h.relay.model as any).stage.tabs.get(p.tab.id);
    const sets = () => h.fake.requests.filter((r) => r.op === "debugger.sendCommand" && r.args[1] === "Page.setInterceptFileChooserDialog").length;
    await c.send("Page.setInterceptFileChooserDialog", { enabled: true }, p.sessionId);
    assert.equal(sets(), 1, "the client's setting reaches Chrome");
    assert.equal(tabState()?.clientChooser, true, "the stage sees the client's interception on");
    await c.send("Page.setInterceptFileChooserDialog", { enabled: false }, p.sessionId);
    assert.equal(tabState()?.clientChooser, false, "and off");
    const got = c.waitForEvent("Page.fileChooserOpened");
    h.fake.emit("debugger.onEvent", { source: { tabId: p.tab.id }, method: "Page.fileChooserOpened", params: { frameId: "main", mode: "selectSingle", backendNodeId: 42 } });
    assert.equal((await got).backendNodeId, 42, "the client's own chooser goes to it");
    h.fake.line({ t: "end_scope", scope: "s7" });
    for (let i = 0; i < 100 && existsSync(join(files.root, "s7")); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(existsSync(join(files.root, "s7")), false, "the scope's end removed its folder");
  } finally { await h.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("board ab-t30.27 (review-153 B1, N1): a folder that holds the stage's folder is the stage's (holds); the state folder refuses a path in it, the folder itself and each folder that holds it, as written and after links (FILES_STATE, before FILES_NOT_YOURS); a file and a folder outside pass", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-state-folder-"));
  try {
    const state = join(dir, "state");
    mkdirSync(join(state, "profile", "Default"), { recursive: true });
    writeFileSync(join(state, "profile", "Default", "Cookies"), "cookies");
    writeFileSync(join(state, "profile", "Default", "Login Data"), "passwords");
    const sf = await ScopeFiles.open(state);
    const guard = new StateFolder(state);
    mkdirSync(join(dir, "outside"));
    writeFileSync(join(dir, "outside", "report.pdf"), "a file");
    symlinkSync(dir, join(dir, "outside", "up"));
    symlinkSync(join(state, "profile"), join(dir, "outside", "prof"));
    // The stage's folder (B1): the folder, each folder that holds it, and a link to one of them; not a folder beside it.
    for (const p of [sf.root, state, dir, tmpdir(), "/", join(dir, "outside", "up")]) assert.equal(sf.holds(p), true, p);
    for (const p of [join(dir, "outside"), join(dir, "outside", "report.pdf"), join(state, "profile")]) assert.equal(sf.holds(p), false, p);
    // The state folder (B1 and N1): a path in it (the profile's Cookies and Login Data, the stage's files), the folder, each
    // folder that holds it (its parent, the temp folder, /), and links to them.
    const refused = [join(state, "profile", "Default", "Cookies"), join(state, "profile", "Default", "Login Data"), join(state, "profile"), join(sf.root, "s1", "x.txt"),
      state, `${state}/`, dir, tmpdir(), "/", join(dir, "outside", "up"), join(dir, "outside", "prof", "Default", "Cookies"), join(dir, "outside", "up", "state", "profile")];
    for (const p of refused) {
      assert.equal(guard.covers(p), true, p);
      assert.equal(filesRefusal(sf, "DOM.setFileInputFiles", { files: [p] }, guard), FILES_STATE, `setFileInputFiles ${p}`);
      assert.equal(filesRefusal(null, "Input.dispatchDragEvent", { data: { files: ["/data/report.pdf", p] } }, guard), FILES_STATE, `a drop, no stage's folder: ${p}`);
    }
    // Outside the state folder: a file, a folder, and a folder beside the state folder pass.
    for (const p of [join(dir, "outside", "report.pdf"), join(dir, "outside"), `${state}-other`, "/data/report.pdf"]) {
      assert.equal(guard.covers(p), false, p);
      assert.equal(filesRefusal(sf, "DOM.setFileInputFiles", { files: [p] }, guard), null, p);
    }
    // The form rule still comes first, also with no stage's folder; with neither folder nothing is refused.
    assert.equal(filesRefusal(null, "DOM.setFileInputFiles", { files: ["a.txt"] }, guard), FILES_PATH_FORM);
    assert.equal(filesRefusal(null, "DOM.setFileInputFiles", { files: ["/"] }), null, "no folder known: the call goes");
    // Without the state folder, a folder that holds the stage's folder gets the stage's refusal.
    assert.equal(filesRefusal(sf, "DOM.setFileInputFiles", { files: [dir] }), FILES_NOT_YOURS);
    // The scope's own MCP folder (C11, the MCP inside the service): a path inside it passes for a tab of that scope only;
    // the folder itself, another scope's, a link in it to the profile, and a link at the scope's folder are refused.
    mkdirSync(join(state, "mcp", "s1", "updir"), { recursive: true });
    writeFileSync(join(state, "mcp", "s1", "updir", "one.txt"), "one");
    symlinkSync(join(state, "profile"), join(state, "mcp", "s1", "prof"));
    const updir = join(state, "mcp", "s1", "updir");
    assert.equal(guard.covers(updir, "s1"), false, "the scope's own folder");
    assert.equal(filesRefusal(sf, "DOM.setFileInputFiles", { files: [updir, join(updir, "one.txt")] }, guard, "s1"), null);
    for (const [p, scope] of [[updir, "s2"], [updir, null], [join(state, "mcp", "s1"), "s1"], [join(state, "mcp"), "s1"], [join(state, "mcp", "s1", "prof", "Default", "Cookies"), "s1"], [join(state, "mcp", "s1", "..x"), "../s1"]] as const) {
      assert.equal(guard.covers(p, scope), true, `${p} for ${scope}`);
      assert.equal(filesRefusal(sf, "DOM.setFileInputFiles", { files: [p] }, guard, scope), FILES_STATE, `${p} for ${scope}`);
    }
    mkdirSync(join(state, "mcp", "s3"));
    rmSync(join(state, "mcp", "s1", "prof"));
    rmSync(join(state, "mcp", "s3"), { recursive: true });
    symlinkSync(join(state, "profile"), join(state, "mcp", "s3"));
    assert.equal(guard.covers(join(state, "mcp", "s3", "Default", "Cookies"), "s3"), true, "a link at the scope's folder: no part of it is the scope's own");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("board ab-t30.27 (review-153 B1, N1): the model with the service's state folder and no stage's folder refuses a client's path of the state folder (also another scope's MCP folder) or of a folder that holds it; a file outside and a folder of the tab's own scope's MCP folder go on", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-state-folder-"));
  const h = await harness({ stage: true } as any);
  try {
    const state = join(dir, "state");
    mkdirSync(join(state, "profile", "Default"), { recursive: true });
    writeFileSync(join(state, "profile", "Default", "Cookies"), "cookies");
    writeFileSync(join(dir, "report.txt"), "a file");
    h.relay.model.setStateFolder(new StateFolder(state));
    await h.ready();
    const c = await h.connect("s7");
    const p = await page(h, c);
    const from = h.fake.requests.length;
    mkdirSync(join(state, "mcp", "s8", "updir"), { recursive: true });
    for (const f of [join(state, "profile", "Default", "Cookies"), state, dir, "/", join(state, "mcp", "s8", "updir")]) {
      await assert.rejects(c.send("DOM.setFileInputFiles", { objectId: "7.3.19", files: [f] }, p.sessionId), (e: Error) => e.message.includes(FILES_STATE), f);
      await assert.rejects(c.send("Input.dispatchDragEvent", { type: "drop", x: 10, y: 10, data: { items: [], files: [f], dragOperationsMask: 1 } }, p.sessionId), (e: Error) => e.message.includes(FILES_STATE), `a drop: ${f}`);
    }
    assert.equal(h.fake.requests.slice(from).filter((r) => r.op === "debugger.sendCommand" && (r.args[1] === "DOM.setFileInputFiles" || r.args[1] === "Input.dispatchDragEvent")).length, 0, "no such call reaches Chrome");
    // A file outside the state folder, and a folder of the tab's own scope's MCP folder, go on (the stage's step, then
    // Chrome: no refusal of the model).
    mkdirSync(join(state, "mcp", "s7", "updir"), { recursive: true });
    const ok = c.send("DOM.setFileInputFiles", { objectId: "7.3.19", files: [join(dir, "report.txt")] }, p.sessionId).then(() => "answered", (e: Error) => e.message);
    const own = c.send("DOM.setFileInputFiles", { objectId: "7.3.19", files: [join(state, "mcp", "s7", "updir")] }, p.sessionId).then(() => "answered", (e: Error) => e.message);
    await until(() => h.fake.requests.slice(from).some((r) => r.op === "debugger.sendCommand") || h.logs.some((l) => l.includes("setInputFiles")), "the outside file's call to go on");
    for (const [what, call] of [["an outside file", ok], ["a folder of the scope's own MCP folder", own]] as const) {
      const got = await Promise.race([call, new Promise<string>((r) => setTimeout(() => r("waits"), 3000))]);
      assert.ok(!String(got).includes(FILES_STATE) && !String(got).includes(FILES_PATH_FORM), `${what} is not refused: ${got}`);
    }
  } finally { await h.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("review-153b B1 (board ab-t30.29): a path in /proc, /dev or /sys, as written or after its links, gets FILES_STATE (Chrome opens it in its own process, where /proc/self and /dev/fd name its open files); a path beside them passes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-state-sys-"));
  try {
    const state = join(dir, "state");
    mkdirSync(state);
    const sf = await ScopeFiles.open(state);
    const guard = new StateFolder(state);
    mkdirSync(join(dir, "mine"));
    symlinkSync("/proc/self/fd", join(dir, "mine", "fds"));
    symlinkSync("/dev/fd", join(dir, "mine", "devfd"));
    const refused = ["/proc/self/fd", "/proc/self/fd/", "/proc/self/fd/3", "/proc/thread-self/fd", "/proc/1/fd", `/proc/${process.pid}/fd/0`, "/dev/fd", "/dev/fd/3",
      "/proc", "/dev", "/sys", "/sys/kernel", "/dev/shm/x.txt", "/proc/self/root/etc/hostname", "/proc/self/./fd", "//proc/self/fd", "/PROC/self/fd", "/Dev/fd/3",
      join(dir, "mine", "fds"), join(dir, "mine", "fds", "3"), join(dir, "mine", "devfd", "3")];
    for (const p of refused) {
      assert.equal(guard.covers(p), true, p);
      assert.equal(guard.covers(p, "s1"), true, `${p} for a tab of scope s1`);
      assert.equal(filesRefusal(sf, "DOM.setFileInputFiles", { files: [p] }, guard, "s1"), FILES_STATE, `setFileInputFiles ${p}`);
      assert.equal(filesRefusal(null, "Input.dispatchDragEvent", { data: { items: [], files: ["/data/report.pdf", p] } }, guard), FILES_STATE, `a drop, no stage's folder: ${p}`);
    }
    for (const p of ["/procx/a.txt", "/devices/a.txt", "/system/a.txt", "/home/u/proc/self/fd", "/data/dev/fd/3", join(dir, "mine")]) {
      assert.equal(guard.covers(p), false, p);
      assert.equal(filesRefusal(sf, "DOM.setFileInputFiles", { files: [p] }, guard), null, p);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/**
 * A small model of the Mac's file system for the compare by device and inode (board ab-v16.94.22): no Mac is needed. A
 * name is the same name with no regard to case and to Unicode normalization (APFS's default); /System/Volumes/Data/Users
 * and /System/Volumes/Data/private name /Users and /private (the firmlinks); a link is followed. `realpath` keeps each
 * part as written and follows only links, as Node's realpathSync does on the Mac.
 */
class FakeMac implements FileLook {
  private readonly ids = new Map<string, string>();
  private readonly links = new Map<string, string>();
  constructor(paths: string[], links: Record<string, string>) {
    for (const p of paths) for (let at = p; !this.ids.has(FakeMac.key(at)); at = dirname(at)) {
      this.ids.set(FakeMac.key(at), `1:${this.ids.size + 2}`);
      if (at === "/") break;
    }
    for (const [at, to] of Object.entries(links)) this.links.set(FakeMac.key(at), to);
  }
  private static key(p: string): string {
    const k = resolve(p).normalize("NFD").toLowerCase();
    return k.replace(/^\/system\/volumes\/data(?=\/(users|private)(\/|$))/, "");
  }
  /** The path after its links: its key and its text (the text as realpath gives it), or null when it does not exist. */
  private walk(p: string, depth = 0): { key: string; text: string } | null {
    if (depth > 8) return null;
    let text = "/";
    for (const part of resolve(p).split("/").filter(Boolean)) {
      text = join(text, part);
      const to = this.links.get(FakeMac.key(text));
      if (to !== undefined) {
        const r = this.walk(resolve(dirname(text), to), depth + 1);
        if (r === null) return null;
        text = r.text;
      } else if (!this.ids.has(FakeMac.key(text))) return null;
    }
    return { key: FakeMac.key(text), text };
  }
  id(p: string): string | null { const r = this.walk(p); return r === null ? null : this.ids.get(r.key) ?? null; }
  realpath(p: string): string { const r = this.walk(p); if (r === null) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" }); return r.text; }
}

test("board ab-v16.94.22 (review-155 N1, review-153b N1): on the Mac's file system the state folder's rule and the stage's folder rule compare paths by device and inode: a change of case, a Unicode normalization form, the data volume's form, a link and a missing file under the profile get the error; a path outside passes", () => {
  const home = "/Users/josé", state = `${home}/.local/share/agentwatch-browser`, files = `${state}/scope-files`;
  const mac = new FakeMac([`${state}/profile/Default/Cookies`, `${state}/profile/Default/Login Data`, `${files}/s2/call-1/a.txt`, `${state}/mcp/s1/updir/one.txt`,
    `${home}/Documents/report.pdf`, `${home}/Desktop/notes.txt`, "/System/Volumes/Data/.fseventsd", "/Volumes/USB/x.txt"],
  { [`${home}/Desktop/prof`]: `${state}/profile`, [`${home}/Desktop/up`]: "/USERS/JOSÉ/.LOCAL", [`${home}/Desktop/doc`]: `${home}/Documents/report.pdf` });
  const guard = new StateFolder(state, mac);
  const stage = { holds: (p: string) => nearFolder(p, files, mac.realpath(files), mac) } as any;
  const refused: [string, string][] = [
    ["a change of case", `${home}/.local/share/AGENTWATCH-BROWSER/profile/Default/Cookies`],
    ["a change of case of a folder that holds it", "/USERS/JOSÉ/.LOCAL"],
    ["a Unicode normalization form (NFD)", "/Users/josé/.local/share/agentwatch-browser/profile/Default/Login Data"],
    ["the data volume's form", `/System/Volumes/Data${state}/profile/Default/Cookies`],
    ["the data volume's form and a change of case", `/system/volumes/data/USERS/josé/.local/share/agentwatch-browser`],
    ["the data volume, which holds it", "/System/Volumes/Data"],
    ["a folder above the data volume", "/System/Volumes"],
    ["the folder above that", "/System"],
    ["a link to the profile", `${home}/Desktop/prof/Default/Cookies`],
    ["a link to a case form of a folder that holds it", `${home}/Desktop/up`],
    ["through that link", `${home}/Desktop/up/share/agentwatch-browser/profile/Default/Cookies`],
    ["a missing file under the profile", `${state}/profile/Default/NoSuch`],
    ["a missing file in a missing folder of a case form of the profile", "/users/JOSÉ/.local/SHARE/agentwatch-browser/profile/NoSuch/x.txt"],
    ["the scope's own MCP folder in the data volume's form (the MCP part compares text)", `/System/Volumes/Data${state}/mcp/s1/updir/one.txt`],
    ["the scope's own MCP folder in a case form", `${home}/.local/share/AGENTWATCH-BROWSER/mcp/s1/updir`],
  ];
  for (const [what, p] of refused) {
    assert.equal(guard.covers(p, "s1"), true, `${what}: ${p}`);
    assert.equal(filesRefusal(stage, "DOM.setFileInputFiles", { files: [p] }, guard, "s1"), FILES_STATE, `${what}: ${p}`);
  }
  // The stage's folder (FILES_NOT_YOURS) compares the same way.
  for (const p of [`/System/Volumes/Data/Users/JOSÉ/.local/share/agentwatch-browser/Scope-Files/s2/call-1/a.txt`, "/users/josé/.local/share/agentwatch-browser/scope-files", "/SYSTEM/Volumes"]) {
    assert.equal(stage.holds(p), true, p);
    assert.equal(filesRefusal(stage, "Input.dispatchDragEvent", { data: { items: [], files: [p] } }), FILES_NOT_YOURS, p);
  }
  // A path outside passes: a file and a folder, in any form, a missing file, a folder beside the state folder, a link to a file outside, another volume.
  for (const p of [`${home}/Documents/report.pdf`, `${home}/Documents`, "/USERS/JOSÉ/DOCUMENTS/REPORT.PDF", `/System/Volumes/Data${home}/Documents/report.pdf`,
    `${home}/Documents/missing.txt`, `${state}-other/x.txt`, `${home}/Desktop/doc`, "/Volumes/USB/x.txt", `${state}/mcp/s1/updir/one.txt`, `${state}/mcp/s1/updir/new.txt`]) {
    assert.equal(guard.covers(p, "s1"), false, p);
    assert.equal(stage.holds(p), false, p);
    assert.equal(filesRefusal(stage, "DOM.setFileInputFiles", { files: [p] }, guard, "s1"), null, p);
  }
});

test("board ab-v16.94.22: on Linux's file system the compare is the same, and a case form names another path: a path with no part in the state folder or above it passes", () => {
  const state = "/home/u/.local/share/agentwatch-browser";
  const dirs = ["/", "/home", "/home/u", "/home/u/.local", "/home/u/.local/share", state, `${state}/profile`, "/home/u/Documents"];
  const linux: FileLook = {
    id: (p) => (dirs.includes(resolve(p)) ? `2:${dirs.indexOf(resolve(p))}` : null),
    realpath: (p) => { if (linux.id(p) === null) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return resolve(p); },
  };
  const guard = new StateFolder(state, linux);
  for (const p of [`${state}/profile/Default/Cookies`, state, "/home/u", "/"]) assert.equal(guard.covers(p), true, p);
  for (const p of ["/home/u/.local/share/AGENTWATCH-BROWSER/profile/Default/Cookies", "/HOME/u/.local", "/home/u/Documents", "/home/u/Documents/report.pdf", `${state}-other`, "/data/report.pdf"]) {
    assert.equal(guard.covers(p), false, p);
  }
});

test("review-157 N1 (board ab-v16.94.25): a path in /.vol, or /.vol itself, as written or after links, gets FILES_STATE: on the Mac /.vol/<device>/<inode> names a file of the profile by a folder below the state folder; a path beside /.vol passes", async () => {
  const home = "/Users/ann", state = `${home}/.local/share/agentwatch-browser`;
  const mac = new FakeMac([`${state}/profile/Default/Cookies`, `${home}/Documents/report.pdf`, `${home}/Desktop/notes.txt`, "/.vol/1/2"], { [`${home}/Desktop/vol`]: "/.vol/1/2" });
  const guard = new StateFolder(state, mac);
  const ino = (p: string) => mac.id(p)!.split(":")[1];
  const refused = [`/.vol/1/${ino(`${state}/profile`)}/Default/Cookies`, `/.vol/1/${ino(`${state}/profile/Default/Cookies`)}`, `/.vol/1/${ino(state)}`, "/.vol", "/.vol/", "/.VOL/1/2", "//.vol/1/2", "/.vol/./1/2",
    `${home}/Desktop/vol`, `${home}/Desktop/vol/x.txt`];
  for (const p of refused) {
    assert.equal(guard.covers(p, "s1"), true, p);
    assert.equal(filesRefusal(null, "DOM.setFileInputFiles", { files: ["/data/report.pdf", p] }, guard, "s1"), FILES_STATE, p);
  }
  for (const p of ["/.volume/x.txt", "/vol/1/2", `${home}/.vol/1/2`, `${home}/Documents/report.pdf`]) {
    assert.equal(guard.covers(p, "s1"), false, p);
    assert.equal(filesRefusal(null, "DOM.setFileInputFiles", { files: [p] }, guard, "s1"), null, p);
  }
  // On Linux the rule is the same text rule (no /.vol there), on the service's file system.
  const dir = mkdtempSync(join(tmpdir(), "ab-state-vol-"));
  try {
    mkdirSync(join(dir, "state"));
    const linux = new StateFolder(join(dir, "state"));
    assert.equal(linux.covers("/.vol/16777220/12345/Default/Cookies"), true, "a /.vol path on Linux");
    assert.equal(linux.covers(join(dir, ".vol", "x.txt")), false, "a .vol folder beside the state folder");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("review-157 N2 (board ab-v16.94.25): a path of PATH_MAX bytes or more (4096 on Linux, 1024 on the Mac; the limit counts the NUL at its end) gets FILES_PATH_FORM, and one byte less does not; each rule reads its folder's device and inode once per call, not once per path", () => {
  assert.equal(FILE_PATH_MAX, process.platform === "darwin" ? 1024 : 4096, "the system's PATH_MAX");
  const call = (p: string, max?: number) => filesRefusal(null, "DOM.setFileInputFiles", { files: [p] }, { coversAny: () => false }, "s1", max);
  for (const max of [4096, 1024]) {
    assert.equal(call("/" + "a".repeat(max - 2), max), null, `${max - 1} bytes`);
    assert.equal(call("/" + "a".repeat(max - 1), max), FILES_PATH_FORM, `${max} bytes`);
    assert.equal(call("/" + "é".repeat(max / 2), max), FILES_PATH_FORM, `${max} characters of two bytes: the bytes count`);
    assert.equal(call("/a".repeat(512 * 1024), max), FILES_PATH_FORM, "a deep path of 1 MiB");
  }
  assert.equal(call("/" + "a".repeat(FILE_PATH_MAX - 1)), FILES_PATH_FORM, "the platform's limit by default");
  assert.equal(filesRefusal(null, "Input.dispatchDragEvent", { data: { items: [], files: ["/data/report.pdf", "/" + "a".repeat(5000)] } }, { coversAny: () => false }), FILES_PATH_FORM, "a drop's long path");
  // The reads of the folder side: the same for a call of one path and of three.
  const state = "/home/u/.local/share/agentwatch-browser", files = `${state}/scope-files`;
  const dirs = ["/", "/home", "/home/u", "/home/u/.local", "/home/u/.local/share", state, files, "/home/u/Documents", "/home/u/Documents/a", "/home/u/Documents/a/b"];
  const reads: string[] = [];
  const look: FileLook = {
    id: (p) => { reads.push(resolve(p)); return dirs.includes(resolve(p)) ? `2:${dirs.indexOf(resolve(p))}` : null; },
    realpath: (p) => { if (!dirs.includes(resolve(p))) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return resolve(p); },
  };
  const guard = new StateFolder(state, look);
  // The stage's rule as ScopeFiles.holdsAny makes it: one compare (nearTo) for the call's paths.
  const stage = { holds: (p: string) => nearFolder(p, files, files, look), holdsAny: (ps: readonly string[]) => ps.some(nearTo(files, files, look)) };
  const count = (paths: string[]) => {
    reads.length = 0;
    assert.equal(filesRefusal(stage as any, "DOM.setFileInputFiles", { files: paths }, guard, "s1"), null, paths.join(" "));
    return reads.filter((p) => p === state || p === files || p === "/home/u/.local" || p === "/home/u/.local/share").length;
  };
  const one = count(["/home/u/Documents/a/b"]);
  assert.ok(one > 0, "the folder side is read");
  assert.equal(count(["/home/u/Documents/a/b", "/home/u/Documents/a", "/home/u/Documents"]), one, "three paths: the folder side is read as often as for one");
});

test("review-157 N3 (board ab-v16.94.25): on Linux a second name of the state folder (a bind mount) gets FILES_STATE, with a path in it; a folder beside it passes", () => {
  const state = "/home/u/.local/share/agentwatch-browser", mount = "/mnt/state";
  const dirs = ["/", "/home", "/home/u", "/home/u/.local", "/home/u/.local/share", state, `${state}/profile`, "/home/u/Documents", "/mnt", "/mnt/other"];
  // A bind mount names the same folder by a second path; it is no link, so the real path keeps the path as written.
  const named = (p: string) => { const r = resolve(p); return r === mount || r.startsWith(mount + "/") ? state + r.slice(mount.length) : r; };
  const linux: FileLook = {
    id: (p) => (dirs.includes(named(p)) ? `2:${dirs.indexOf(named(p))}` : null),
    realpath: (p) => { if (linux.id(p) === null) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return resolve(p); },
  };
  const guard = new StateFolder(state, linux);
  for (const p of [mount, `${mount}/`, `${mount}/profile`, `${mount}/profile/Default/Cookies`]) {
    assert.equal(guard.covers(p, "s1"), true, p);
    assert.equal(filesRefusal(null, "DOM.setFileInputFiles", { files: [p] }, guard, "s1"), FILES_STATE, p);
  }
  for (const p of ["/mnt/other", "/mnt/other/x.txt", "/mnt/state-other/x.txt", "/home/u/Documents"]) {
    assert.equal(guard.covers(p, "s1"), false, p);
    assert.equal(filesRefusal(null, "DOM.setFileInputFiles", { files: [p] }, guard, "s1"), null, p);
  }
});

test("C11 names the file chooser's constants with the code's values", () => {
  const C11 = readFileSync(new URL("../docs/contracts/C11.md", import.meta.url), "utf8").replace(/\s+/g, " ");
  assert.equal(FILE_CHOOSER_WAIT_MS, 2000);
  assert.ok(C11.includes("When the click opens no chooser in 2 s (`FILE_CHOOSER_WAIT_MS`)"));
  assert.equal(FILES_MAX_BYTES, 50 * 1024 * 1024);
  assert.ok(C11.includes("50 MiB (52,428,800 bytes) or more in all (`FILES_MAX_BYTES`, Playwright's own limit for buffers"));
  assert.equal(FILES_SET, "() => undefined");
  assert.ok(C11.includes("`FILES_SET` (`() => undefined`)"));
  assert.equal(SCOPE_FILES, "scope-files");
  assert.ok(C11.includes("is `scope-files` in its state folder"));
});
