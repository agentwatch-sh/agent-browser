// PageFetch's PDFs (src/service/fetch/page-fetch.ts, pdf-text.ts and pdf-worker.ts; contract C11, "PageFetch"; the
// PageFetch design, section 5.7; board ab-v16.103), on the fake fetch tab (test/fetch-fakes.ts) with the real pdf.js in
// its worker thread and small PDFs written by test/pdf-fixture.ts. The main document's response is held at Fetch's
// response stage, its bytes come through a stream, and Chrome's PDF viewer or a download never gets it (D1 of the real-page
// check: a PDF URL lost its fetch window in 2.6 s). No Chrome.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { FetchRefusal, FETCH_LIMITS, PDF_PART_BYTES } from "../src/service/fetch/page-fetch.ts";
import { NO_PAGE_TEXT, PdfError, pageText, pdfMarkdown, readPdf } from "../src/service/fetch/pdf-text.ts";
import { FetchWorld, sleep } from "./fetch-fakes.ts";
import { makePdf } from "./pdf-fixture.ts";

const URL1 = "https://pages.example.test/books/chapter-3.pdf?token=test-query-value";
const LOCAL = { scope: "web-1", admission: "local" as const };
const PDF = "application/pdf";

async function refusal(p: Promise<unknown>): Promise<FetchRefusal> {
  try { await p; } catch (e) { assert.ok(e instanceof FetchRefusal, String(e)); return e; }
  assert.fail("the call did not fail");
}
const header = (text: string) => text.slice(0, text.indexOf("\n\n"));
const body = (text: string) => text.slice(text.indexOf("\n\n") + 2);
/** The service's answers to the response stage's pauses of the main document. */
const mainResponses = (w: FetchWorld) => w.sent.filter((s) => s.session === undefined && (s.method === "Fetch.continueRequest" || s.method === "Fetch.failRequest") && w.held.includes(s.params.requestId));

test("a PDF with text: the main document's response is held at the response stage, its bytes come through a stream in parts of 1 MiB, and the request fails (Aborted), so no PDF viewer and no download gets it; pdf.js gives each page under a ## Page N line; the header says Kind: pdf", async () => {
  const w = new FetchWorld();
  const pdf = makePdf([["PDF-FIRST: the first line of the chapter.", "A second line (with parentheses)."], null, ["PDF-LAST: the third page."]], { title: "A Test Chapter", script: "app.alert('a script of the PDF')" });
  w.pages[URL1] = { status: 200, mime: PDF, body: pdf, headers: { "Content-Length": String(pdf.length) } };
  const text = await w.fetcher().fetch(LOCAL, { url: URL1 });
  assert.deepEqual(w.sent.find((s) => s.method === "Fetch.enable" && s.session === undefined)!.params,
    { patterns: [{ urlPattern: "*", requestStage: "Request" }, { urlPattern: "*", resourceType: "Document", requestStage: "Response" }] });
  const m = w.methods();
  assert.ok(m.includes("Fetch.takeResponseBodyAsStream") && m.includes("IO.read") && m.includes("IO.close"), m.join(", "));
  for (const r of w.sent.filter((s) => s.method === "IO.read")) assert.equal(r.params.size, PDF_PART_BYTES);
  assert.equal(PDF_PART_BYTES, 1024 * 1024);
  assert.deepEqual(mainResponses(w).map((s) => [s.method, s.params.errorReason]), [["Fetch.failRequest", "Aborted"]], "the PDF's response never reaches Chrome");
  assert.ok(m.indexOf("IO.close") < m.lastIndexOf("Fetch.failRequest"), "the stream closes before the request fails");
  assert.ok(!w.sent.some((s) => s.method === "Runtime.evaluate" && /aw-fetch:(check|convert)/.test(s.params.expression)), "no check read and no Defuddle on a PDF");
  assert.equal(header(text), [`URL: ${URL1}`, "Title: A Test Chapter", "Status: 200", "Kind: pdf", "Mode: main", `Length: ${body(text).length} characters`].join("\n"));
  assert.equal(body(text), `## Page 1\n\nPDF-FIRST: the first line of the chapter.\nA second line (with parentheses).\n\n## Page 2\n\n${NO_PAGE_TEXT}\n\n## Page 3\n\nPDF-LAST: the third page.`);
  assert.equal(w.fetchEnds, 1, "fetch_end once");
  assert.match(w.log.at(-1)!, /^page-fetch: scope web-1, host pages\.example\.test, result ok, status 200, \d+ ms, \d+ characters, 0 downloads, 0 websockets$/);
  assert.ok(!w.log.some((l) => l.includes("chapter-3") || l.includes("token")), "no path and no query in a log line");
});

test("a PDF with no text says so (a scan: PageFetch has no text recognition); mode whole gives the same text, and its header names the call's mode", async () => {
  const w = new FetchWorld();
  w.pages[URL1] = { mime: "application/PDF; charset=binary", body: makePdf([null, null]) };
  const text = await w.fetcher().fetch(LOCAL, { url: URL1, mode: "whole" });
  assert.match(header(text), /\nTitle: \nStatus: 200\nKind: pdf\nMode: whole\nLength: /);
  assert.equal(body(text), "This PDF has no text (2 pages): it may be a scan, and PageFetch has no text recognition.");
});

test("a PDF over the limit (25 MB): too_large; a Content-Length above the limit reads no byte; a stream with no Content-Length stops after the part that passes the limit; each request fails (Aborted)", async () => {
  assert.equal(FETCH_LIMITS.pdfBytes, 25 * 1024 * 1024);
  const limit = 2 * 1024 * 1024;
  const big = Buffer.alloc(5 * 1024 * 1024, 0x20);
  const declared = new FetchWorld();
  declared.pages[URL1] = { mime: PDF, body: big, headers: { "Content-Length": String(big.length) } };
  const e1 = await refusal(declared.fetcher({ limits: { pdfBytes: limit } }).fetch(LOCAL, { url: URL1 }));
  assert.equal(e1.message, "Not fetched (too_large): The PDF is larger than 2 MB.");
  assert.equal(declared.readBytes, 0, "no byte read");
  assert.ok(!declared.methods().includes("Fetch.takeResponseBodyAsStream"));
  assert.deepEqual(mainResponses(declared).map((s) => [s.method, s.params.errorReason]), [["Fetch.failRequest", "Aborted"]]);
  assert.match(declared.log.at(-1)!, /result too_large,/);
  const streamed = new FetchWorld();
  streamed.pages[URL1] = { mime: PDF, body: big, headers: { "Content-Encoding": "gzip", "Content-Length": "1000" } };
  const e2 = await refusal(streamed.fetcher({ limits: { pdfBytes: limit } }).fetch(LOCAL, { url: URL1 }));
  assert.equal(e2.message, "Not fetched (too_large): The PDF is larger than 2 MB.");
  assert.ok(streamed.readBytes > limit && streamed.readBytes <= limit + PDF_PART_BYTES, `read ${streamed.readBytes} bytes`);
  assert.equal(streamed.streams.size, 0, "the stream is closed");
  assert.deepEqual(mainResponses(streamed).map((s) => [s.method, s.params.errorReason]), [["Fetch.failRequest", "Aborted"]]);
  assert.equal(streamed.fetchEnds, 1);
});

test("D1: a PDF whose window Chrome ends: its bytes are taken before Chrome's PDF viewer or a download, so Chrome's end of the session after the response changes nothing, and the text comes", async () => {
  const w = new FetchWorld();
  w.pages[URL1] = { mime: PDF, body: makePdf([["D1-TEXT: the page of a PDF whose window Chrome ends."]]), detachAfterResponse: true };
  const text = await w.fetcher().fetch(LOCAL, { url: URL1 });
  assert.match(header(text), /\nKind: pdf\n/);
  assert.equal(body(text), "## Page 1\n\nD1-TEXT: the page of a PDF whose window Chrome ends.");
  assert.equal(w.fetchEnds, 1);
});

test("D1: a main document that the network domain reports as a PDF with no held response, before the end of its session: could not read the PDF, not the lost window; a read that fails (Chrome ended the window during it): could not read the PDF, and the request fails", async () => {
  const w = new FetchWorld();
  w.pages[URL1] = { mime: PDF, heldMime: "application/octet-stream", detachAfterResponse: true };
  const e = await refusal(w.fetcher().fetch(LOCAL, { url: URL1 }));
  assert.equal(e.message, "Not fetched (unavailable): The agent browser could not read the PDF.");
  const v = new FetchWorld();
  v.pages[URL1] = { mime: PDF, body: makePdf([["text"]]) };
  v.failing.add("IO.read");
  const e2 = await refusal(v.fetcher().fetch(LOCAL, { url: URL1 }));
  assert.equal(e2.message, "Not fetched (unavailable): The agent browser could not read the PDF.");
  assert.deepEqual(mainResponses(v).map((s) => [s.method, s.params.errorReason]), [["Fetch.failRequest", "Aborted"]]);
  assert.ok(v.methods().includes("IO.close"));
  assert.equal(v.fetchEnds, 1);
});

test("a non-PDF is unchanged: its response goes on at the response stage (Fetch.continueRequest), no stream is read; a frame's PDF document and a redirect of the main document that names the PDF type go on too", async () => {
  const w = new FetchWorld();
  w.pages[URL1] = {
    status: 200, title: "The Test Page",
    after: async (x) => {
      assert.equal(await x.pauseResponse("https://pages.example.test/frame.pdf", { mime: PDF, body: makePdf([["frame"]]) }, { frameId: "F2" }), "continue");
      assert.equal(await x.pauseResponse("https://pages.example.test/moved", { mime: PDF, headers: { Location: "https://pages.example.test/next" } }, { status: 302 }), "continue");
    },
  };
  const text = await w.fetcher().fetch(LOCAL, { url: URL1 });
  assert.match(header(text), /^URL: .*\nTitle: The Test Page\nStatus: 200\nKind: html\nMode: main\nLength: \d+ characters$/);
  assert.match(body(text), /^# A test page\n\nThe text of the test page/);
  assert.equal(w.held.length, 3);
  assert.deepEqual(mainResponses(w).map((s) => s.method), ["Fetch.continueRequest", "Fetch.continueRequest", "Fetch.continueRequest"]);
  assert.ok(!w.methods().some((x) => x === "Fetch.takeResponseBodyAsStream" || x.startsWith("IO.")));
  assert.equal(w.sent.filter((s) => s.method === "Page.navigate").length, 1);
});

test("a PDF's text in parts and from the memory, as an HTML page's: at most partChars in one answer with the next offset; the read on comes from the scope's memory with no second window", async () => {
  const w = new FetchWorld();
  w.pages[URL1] = { mime: PDF, body: makePdf([["PART-ONE: " + "a".repeat(80)], ["PART-TWO: " + "b".repeat(80)]]) };
  const f = w.fetcher({ limits: { partChars: 100 } });
  const a = await f.fetch(LOCAL, { url: URL1 });
  const total = Number(/\nLength: (\d+) characters/.exec(header(a))![1]);
  assert.match(header(a), /\nPart: characters 0 to 100; the next part starts at offset 100$/);
  assert.ok(body(a).startsWith("## Page 1\n\nPART-ONE: "));
  const b = await f.fetch(LOCAL, { url: URL1, offset: 100 });
  assert.match(header(b), new RegExp(`\\nKind: pdf\\n[\\s\\S]*\\nPart: characters 100 to ${Math.min(200, total)}`));
  assert.ok(w.log[1].includes("result ok (from memory)"));
  assert.equal(w.calls.filter((x) => x.op === "windows.create").length, 1);
});

test("a locked PDF (a password) and a file that is no PDF: unavailable, each with its sentence", async () => {
  const w = new FetchWorld();
  w.pages[URL1] = { mime: PDF, body: makePdf([["secret"]], { locked: true }) };
  assert.equal((await refusal(w.fetcher().fetch(LOCAL, { url: URL1 }))).message, "Not fetched (unavailable): The PDF needs a password; PageFetch reads no protected PDF.");
  const v = new FetchWorld();
  v.pages[URL1] = { mime: PDF, body: Buffer.from("<!doctype html><p>an error page with the PDF type</p>") };
  assert.equal((await refusal(v.fetcher().fetch(LOCAL, { url: URL1 }))).message, "Not fetched (unavailable): The agent browser could not read the PDF.");
});

test("the PDF reader: pageText joins pdf.js's items and their line ends; pdfMarkdown; the worker ends at the fetch's time (timeout)", async () => {
  assert.equal(pageText([{ str: "Hello" }, { str: " " }, { str: "world", hasEOL: true }, { type: "beginMarkedContent" }, { str: "Line two   ", hasEOL: true }, { str: "", hasEOL: true }, { str: "", hasEOL: true }, { str: "End" }]), "Hello world\nLine two\n\nEnd");
  assert.equal(pdfMarkdown(["a", ""]), `## Page 1\n\na\n\n## Page 2\n\n${NO_PAGE_TEXT}`);
  assert.equal(pdfMarkdown([""]), "This PDF has no text (1 page): it may be a scan, and PageFetch has no text recognition.");
  await assert.rejects(readPdf(makePdf([["x"]]), { timeoutMs: 1, keepChars: 1000 }), (e: unknown) => e instanceof PdfError && e.kind === "timeout");
  // The worker stops after the page at which the text passes keepChars.
  const r = await readPdf(makePdf([["A".repeat(50)], ["B".repeat(50)], ["C".repeat(50)]]), { timeoutMs: 20_000, keepChars: 60 });
  assert.deepEqual([r.pages.length, r.cut], [2, true]);
});

test("no native code and no pdf.js in the service's thread: the PDF worker refuses @napi-rs/canvas (pdf.js warns and goes on); only pdf-worker.ts imports pdfjs-dist; its getDocument options", async () => {
  const data = new Uint8Array(makePdf([["worker"]]));
  const wk = new Worker(new URL("../src/service/fetch/pdf-worker.ts", import.meta.url), { workerData: { bytes: data, keepChars: 1000 }, transferList: [data.buffer], stdout: true, stderr: true, env: {}, execArgv: [] });
  let out = "";
  wk.stdout.on("data", (b) => { out += b; });
  wk.stderr.on("data", (b) => { out += b; });
  const m = await new Promise<any>((resolve, reject) => { wk.once("message", resolve); wk.once("error", reject); });
  await sleep(50);
  await wk.terminate();
  assert.deepEqual(m, { t: "done", title: "", pages: ["worker"], cut: false });
  assert.match(out, /Cannot load "@napi-rs\/canvas" package: "Error: the PDF worker loads no @napi-rs\/canvas"/);
  const src = (f: string) => readFileSync(new URL(`../src/service/fetch/${f}`, import.meta.url), "utf8");
  for (const f of ["page-fetch.ts", "pdf-text.ts", "fetch-page.ts"]) assert.doesNotMatch(src(f), /pdfjs-dist/, `${f} imports no pdf.js`);
  // The worker's code without its comments (they name what it never calls).
  const worker = src("pdf-worker.ts").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  for (const o of ["useWasm: false", "useSystemFonts: false", "disableFontFace: true", "enableXfa: false", "useWorkerFetch: false", "disableRange: true", "disableStream: true"]) assert.ok(worker.includes(o), o);
  assert.doesNotMatch(worker, /getJSActions|getFieldObjects|pdf\.sandbox|\burl:/, "no PDF script, no sandbox, no URL");
});
