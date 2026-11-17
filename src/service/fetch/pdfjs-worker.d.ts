// pdfjs-dist ships no declarations for its worker module (only for pdf.mjs). pdf-worker.ts imports it only to hand
// the module to pdf.js (globalThis.pdfjsWorker), so the one export it has is typed as unknown here.
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
