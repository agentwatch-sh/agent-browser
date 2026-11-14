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
import { join, relative } from "node:path";
import type { CDPConnection } from "../src/cdp.ts";
import { FILE_CHOOSER_WAIT_MS, FILE_PROBE, FILES_MAX_BYTES, FILES_NOT_YOURS, FILES_PATH_FORM, FILES_SET, FILES_TOO_LARGE, STAGE_TEST_ENV, filePayloads, filesBytes, filesRefusal, filesSet, fileType, safeNames, type StageFile } from "../src/relay/stage.ts";
import { relayTestFiles, SCOPE_FILES, ScopeFiles, STAGE_FILES_ENV } from "../src/relay/scope-files.ts";
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

test("the ends: no chooser in FILE_CHOOSER_WAIT_MS, a chooser of another input, a covered input, a navigation in the wait, a write that fails: the client's call as it sent it, counted, and the interception off", async () => {
  const cases: [string, any, string, object?][] = [
    ["no chooser", setPaths("f"), "noChooser", { f: FILE({ noChooser: true }) }],
    ["another input's chooser", setPaths("f"), "otherInput", { f: FILE({ chooserNode: 43 }) }],
    ["no chooser (buffers)", setBuffers("f", payload("a.txt")), "noChooser", { f: FILE({ noChooser: true }) }],
  ];
  for (const [name, call, k, nodes] of cases) {
    const r = await runVector(own([call], { nodes }));
    assert.equal(presses(r.tab).length, 1, `${name}: the click`);
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
  assert.match(FILES_TOO_LARGE, /50 MB/);
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
    assert.equal(h.fake.requests.slice(from).filter((r) => r.op === "debugger.sendCommand" && (r.args[1] === "DOM.setFileInputFiles" || r.args[1] === "Input.dispatchDragEvent")).length, 0, "no such call reaches Chrome");
    // A drop with no file of the folder goes on, as before.
    const drop = c.send("Input.dispatchDragEvent", { type: "dragEnter", x: 10, y: 10, data: { items: [{ mimeType: "text/plain", data: "x" }], dragOperationsMask: 1 } }, p.sessionId).catch(() => {});
    await until(() => h.fake.requests.slice(from).some((r) => r.op === "debugger.sendCommand" && r.args[1] === "Input.dispatchDragEvent"), "the drop without files reaches Chrome", 3000);
    await drop;
    const got = c.waitForEvent("Page.fileChooserOpened");
    h.fake.emit("debugger.onEvent", { source: { tabId: p.tab.id }, method: "Page.fileChooserOpened", params: { frameId: "main", mode: "selectSingle", backendNodeId: 42 } });
    assert.equal((await got).backendNodeId, 42, "the client's own chooser goes to it");
    h.fake.line({ t: "end_scope", scope: "s7" });
    for (let i = 0; i < 100 && existsSync(join(files.root, "s7")); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(existsSync(join(files.root, "s7")), false, "the scope's end removed its folder");
  } finally { await h.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("C11 names the file chooser's constants with the code's values", () => {
  const C11 = readFileSync(new URL("../docs/contracts/C11.md", import.meta.url), "utf8").replace(/\s+/g, " ");
  assert.equal(FILE_CHOOSER_WAIT_MS, 2000);
  assert.ok(C11.includes("When the click opens no chooser in 2 s (`FILE_CHOOSER_WAIT_MS`)"));
  assert.equal(FILES_MAX_BYTES, 50 * 1024 * 1024);
  assert.ok(C11.includes("50 MB or more in all (`FILES_MAX_BYTES`, Playwright's own limit for buffers)"));
  assert.equal(FILES_SET, "() => undefined");
  assert.ok(C11.includes("`FILES_SET` (`() => undefined`)"));
  assert.equal(SCOPE_FILES, "scope-files");
  assert.ok(C11.includes("is `scope-files` in its state folder"));
});
