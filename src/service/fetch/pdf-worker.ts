// The PDF worker of PageFetch (contract C11, "PageFetch"; the PageFetch design, section 5.7; board ab-v16.103): one
// worker thread for one PDF (pdf-text.ts starts it with a heap limit and the fetch's time). It reads the text of each page
// with pdf.js, the pinned `pdfjs-dist` (its legacy build, the build for Node), and posts the texts back. No script of the
// PDF runs:
// - pdf.js's core API only: getDocument, getPage, getTextContent and getMetadata. Nothing here asks for the PDF's
//   JavaScript (no getJSActions, no field objects) or loads pdf.js's scripting sandbox (pdf.sandbox.mjs), and pdf.js
//   runs no PDF JavaScript by itself. The build holds no `eval(`; its one call of `Function(` in each file is core-js's
//   fixed lookup of the global object (docs/supply-chain/pdfjs-dist-6.4.299.md).
// - useWasm false: pdf.js compiles no PostScript function of the PDF to WebAssembly (its JavaScript interpreter runs it,
//   with no eval), and it loads no WebAssembly decoder.
// - No network: the bytes come in workerData (no url, no range or stream requests), and pdf.js's own files (the CMaps of
//   CJK fonts and the standard fonts' data) come from the installed package's folders, read with fs (useWorkerFetch false).
// - No fonts of the system and no font loading (useSystemFonts false, disableFontFace true); no XFA forms (enableXfa false).
// - No Web Worker and no import by a URL: pdf.js's worker code runs in this thread (its "fake worker", from
//   globalThis.pdfjsWorker), and the service's worker thread is the one thread of the PDF.
// - No native code: pdf.js's Node build loads the optional package @napi-rs/canvas (for rendering) when it can; this thread's
//   resolve hook refuses every @napi-rs/ package, so pdf.js warns and goes on without it.

import { createRequire, registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { pageText, type FromPdfWorker } from "./pdf-text.ts";

/** The packages that this thread never loads (pdf.js's optional canvas and its native builds). */
export const REFUSED_PACKAGE = /^@napi-rs\//;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (REFUSED_PACKAGE.test(specifier)) throw Object.assign(new Error(`the PDF worker loads no ${specifier}`), { code: "ERR_MODULE_NOT_FOUND" });
    return nextResolve(specifier, context);
  },
});

const { bytes, keepChars } = workerData as { bytes: Uint8Array; keepChars: number };

async function main(): Promise<FromPdfWorker> {
  const root = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
  // pdf.js's worker code in this thread: its "fake worker" takes it from this global, with no import by a URL.
  (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: bytes,
    useWasm: false,
    useSystemFonts: false,
    disableFontFace: true,
    enableXfa: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    useWorkerFetch: false,
    disableRange: true,
    disableStream: true,
    disableAutoFetch: true,
    cMapUrl: `${join(root, "cmaps")}/`,
    cMapPacked: true,
    standardFontDataUrl: `${join(root, "standard_fonts")}/`,
    verbosity: 0,
  });
  let doc;
  try { doc = await task.promise; }
  catch (e) {
    const name = String((e as Error)?.name ?? "Error");
    return { t: "failed", kind: name === "PasswordException" ? "password" : "unreadable", name };
  }
  const pages: string[] = [];
  let total = 0, cut = false;
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const text = pageText((await page.getTextContent()).items);
    page.cleanup();
    pages.push(text);
    total += text.length;
    // The service keeps at most keepChars characters of a page: no need to read on.
    if (total > keepChars && n < doc.numPages) { cut = true; break; }
  }
  let title = "";
  try {
    const meta = await doc.getMetadata();
    const info = (meta?.info ?? {}) as { Title?: unknown };
    const fromXmp = meta?.metadata?.get("dc:title");
    title = typeof info.Title === "string" && info.Title.trim() ? info.Title : typeof fromXmp === "string" ? fromXmp : "";
  } catch { /* no title */ }
  await task.destroy().catch(() => {});
  return { t: "done", title, pages, cut };
}

parentPort!.postMessage(await main().catch((e): FromPdfWorker => ({ t: "failed", kind: "unreadable", name: String((e as Error)?.name ?? "Error") })));
