// PageFetch's PDFs (contract C11, "PageFetch"; the PageFetch design, section 5.7; board ab-v16.103, the operator's answer
// ab-20v: "Yes, with Mozilla's PDF library (pdf.js)"). The service has the PDF's bytes (page-fetch.ts takes them from the
// main document's response, before Chrome's PDF viewer or a download can take it); this file reads the text of each page
// with pdf.js in a worker thread of its own (pdf-worker.ts) and makes the markdown: each page under a `## Page N` line.
//
// The worker thread, not the service's own thread: a PDF is the page's data, so a large or hostile one must not hold the
// service's event loop or its heap. The worker has a heap limit (PDF_HEAP_MB), no environment and no Node flag of the
// service, and the fetch's time: at the end of that time the service ends it (terminate). Its standard output and error
// (pdf.js's warnings) are read and dropped, so nothing of a PDF reaches the service's log. One fetch runs at a time on the
// box (the one private window), so at most one worker runs.

import { Worker } from "node:worker_threads";

/** The heap limit of the PDF worker, in MiB (the first value, as the MCP workers'). */
export const PDF_HEAP_MB = 512;
/** The PDF's own title: at most this many characters (as a page's title in page-fetch.ts). */
export const PDF_TITLE_CHARS = 300;

/** What the worker reads: the PDF's own title, the text of each page that it read, and whether it stopped early. */
export type PdfText = { title: string; pages: string[]; cut: boolean };
/** Why a PDF gave no text: it needs a password, pdf.js cannot read it, or the fetch's time ended. */
export type PdfFailure = "password" | "unreadable" | "timeout";
export class PdfError extends Error {
  readonly kind: PdfFailure;
  constructor(kind: PdfFailure, why: string) { super(why); this.kind = kind; this.name = "PdfError"; }
}

/** The messages of the worker (pdf-worker.ts). */
export type FromPdfWorker =
  | { t: "done"; title: string; pages: string[]; cut: boolean }
  | { t: "failed"; kind: "password" | "unreadable"; name: string };

/**
 * The text of one page from pdf.js's text items (`getTextContent`): each item's string, and a line end where pdf.js marks
 * one (`hasEOL`). Spaces at the end of a line go, and more than one empty line in a row becomes one.
 */
export function pageText(items: readonly unknown[]): string {
  let s = "";
  for (const it of items) {
    if (it === null || typeof it !== "object") continue;
    const { str, hasEOL } = it as { str?: unknown; hasEOL?: unknown };
    if (typeof str === "string") s += str;
    if (hasEOL === true) s += "\n";
  }
  return s.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/[ \t ]+$/, "")).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** The text of a page that holds none. */
export const NO_PAGE_TEXT = "(This page has no text.)";
/** The markdown of a PDF with no text at all (C11): a scan holds images of its pages, and PageFetch has no text recognition. */
export const noPdfText = (pages: number) =>
  `This PDF has no text (${pages} ${pages === 1 ? "page" : "pages"}): it may be a scan, and PageFetch has no text recognition.`;

/** The markdown of a PDF (C11): the text of each page under a `## Page N` line; a PDF with no text says so. */
export function pdfMarkdown(pages: readonly string[]): string {
  if (!pages.some((p) => p.length > 0)) return noPdfText(pages.length);
  return pages.map((p, i) => `## Page ${i + 1}\n\n${p.length > 0 ? p : NO_PAGE_TEXT}`).join("\n\n");
}

export type ReadPdfOptions = {
  /** The time that the fetch has left: the worker ends at its end. */
  timeoutMs: number;
  /** The worker stops after the page at which the text passes this many characters (the service keeps no more). */
  keepChars: number;
  /** Tests only: the heap limit (MiB) and the worker's file. */
  heapMb?: number;
  entry?: URL;
};

/** The text of a PDF's pages, read by pdf.js in its own worker thread; a PdfError when there is none to give. */
export function readPdf(bytes: Uint8Array, o: ReadPdfOptions): Promise<PdfText> {
  return new Promise((resolve, reject) => {
    // The worker gets its own copy of the bytes (transferred, so the service keeps none).
    const data = new Uint8Array(bytes);
    const worker = new Worker(o.entry ?? new URL("./pdf-worker.ts", import.meta.url), {
      workerData: { bytes: data, keepChars: o.keepChars },
      transferList: [data.buffer],
      resourceLimits: { maxOldGenerationSizeMb: o.heapMb ?? PDF_HEAP_MB },
      // An environment of its own, and no Node flag of the service's command line (an inspector flag, a test flag).
      env: {},
      execArgv: [],
      stdout: true, stderr: true,
    });
    // Nothing of the worker's output reaches the service's log: it is read and dropped.
    worker.stdout.resume();
    worker.stderr.resume();
    let settled = false;
    const finish = (f: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      f();
      void worker.terminate().catch(() => {});
    };
    const timer = setTimeout(() => finish(() => reject(new PdfError("timeout", "the fetch's time ended while pdf.js read the PDF"))), Math.max(1, o.timeoutMs));
    worker.on("message", (m: FromPdfWorker) => {
      if (m?.t === "done" && Array.isArray(m.pages)) {
        finish(() => resolve({ title: typeof m.title === "string" ? m.title : "", pages: m.pages.map((p) => String(p)), cut: m.cut === true }));
      } else if (m?.t === "failed") {
        finish(() => reject(new PdfError(m.kind === "password" ? "password" : "unreadable", `pdf.js could not read the PDF (${String(m.name).slice(0, 60)})`)));
      }
    });
    worker.on("error", (e: NodeJS.ErrnoException) =>
      finish(() => reject(new PdfError("unreadable", e?.code === "ERR_WORKER_OUT_OF_MEMORY" ? "the PDF worker passed its heap limit" : "the PDF worker failed"))));
    worker.on("exit", () => finish(() => reject(new PdfError("unreadable", "the PDF worker ended with no answer"))));
  });
}
