# Vetting: pdfjs-dist 6.4.299 and what it brings (2026-11-15)

PageFetch (board ab-v16.103; C11, "PageFetch", its item "PDFs"; the PageFetch design, sections 5.7 and 5.12) reads the
text of a PDF with Mozilla's pdf.js, the operator's choice (board answer ab-20v: "Yes, with Mozilla's PDF library
(pdf.js)"). This note is the technical vetting that the repo asks for every dependency. It holds no licence review: the
legal team does that.

## The packages, pinned in `package-lock.json`

`pdfjs-dist` is the one new direct dependency, pinned exactly: the newest version that was at least 30 days old on
2026-11-15 (pdfjs-dist 6.5.438, 2026-11-01, was younger). The Linux server's npm has no `min-release-age` setting, so the
install ran once with `--before=2026-10-16T00:00:00Z`: every package of the tree below is at least 30 days old too. The
repo `.npmrc` stays as it is, and `ignore-scripts=true` stays on. No package of the tree has an install script
(`hasInstallScript` is absent in the lockfile for each; `test/package.test.ts` checks it, and it checks that pdfjs-dist's
`package.json` has no install script). `npm audit`: 0 vulnerabilities.

pdfjs-dist has no `dependencies`. Its one optional dependency is `@napi-rs/canvas` (`^1.0.10`, a Skia canvas for
rendering in Node), which brings one prebuilt native build for each platform as an optional dependency of its own. npm
records all of them in the lockfile, and it installs only the build of the box's platform (on the Linux server,
`@napi-rs/canvas-linux-x64-gnu`). No code of this repository loads any of them (below).

| Package | Version | Published | Publisher | Integrity (sha512, start) | Why it is here |
| --- | --- | --- | --- | --- | --- |
| `pdfjs-dist` | 6.4.299 | 2026-10-03 | GitHub Actions (npm OIDC), SLSA provenance | `AVl138zALtfaAPvADulE0PZ` | the PDF reader (its legacy build for Node) |
| `@napi-rs/canvas` | 1.0.11 | 2026-10-10 | GitHub Actions (npm OIDC), SLSA provenance | `vt5tog1cr+QKadIddGe+3Lr` | pdf.js's optional canvas for rendering, never loaded |
| `@napi-rs/canvas-android-arm64` | 1.0.11 | 2026-10-10 | GitHub Actions (npm OIDC), SLSA provenance | `dtJS4FQEfH9OwSYLtMrEnj7` | the canvas's native build, never loaded |
| `@napi-rs/canvas-darwin-arm64` | 1.0.11 | 2026-10-10 | GitHub Actions (npm OIDC), SLSA provenance | `J/JylWoJTG8OQqZaiqly4IO` | the canvas's native build, never loaded |
| `@napi-rs/canvas-darwin-x64` | 1.0.11 | 2026-10-10 | GitHub Actions (npm OIDC), SLSA provenance | `nlecCk3xy06eAGC7krZtzND` | the canvas's native build, never loaded |
| `@napi-rs/canvas-linux-arm-gnueabihf` | 1.0.11 | 2026-10-10 | GitHub Actions (npm OIDC), SLSA provenance | `DKImmG+sTPolE0kGPsYPBxT` | the canvas's native build, never loaded |
| `@napi-rs/canvas-linux-arm64-gnu` | 1.0.11 | 2026-10-10 | GitHub Actions (npm OIDC), SLSA provenance | `55sykACGENj5j1rhj+81AO8` | the canvas's native build, never loaded |
| `@napi-rs/canvas-linux-arm64-musl` | 1.0.11 | 2026-10-10 | GitHub Actions (npm OIDC), SLSA provenance | `6Jz6jys17yXydO+WdJgu7Jh` | the canvas's native build, never loaded |
| `@napi-rs/canvas-linux-riscv64-gnu` | 1.0.11 | 2026-10-10 | GitHub Actions (npm OIDC), SLSA provenance | `lf2XeEebWiUYVOVEjLXxF7d` | the canvas's native build, never loaded |
| `@napi-rs/canvas-linux-x64-gnu` | 1.0.11 | 2026-10-10 | GitHub Actions (npm OIDC), SLSA provenance | `iDapw7nFSE5tsmQxcH2+Kot` | the canvas's native build, never loaded |
| `@napi-rs/canvas-linux-x64-musl` | 1.0.11 | 2026-10-10 | GitHub Actions (npm OIDC), SLSA provenance | `26q26AyITo3CGZX4HWFIMgB` | the canvas's native build, never loaded |
| `@napi-rs/canvas-win32-arm64-msvc` | 1.0.11 | 2026-10-10 | GitHub Actions (npm OIDC), SLSA provenance | `cUO96IdsfvIj2S+2PNcDSkT` | the canvas's native build, never loaded |
| `@napi-rs/canvas-win32-x64-msvc` | 1.0.11 | 2026-10-10 | GitHub Actions (npm OIDC), SLSA provenance | `DFYp/ZQRdKunI/LPc0UkRXG` | the canvas's native build, never loaded |

Sizes: pdfjs-dist unpacks to 34.9 MB (554 files; most are the browser builds, the viewer, source maps, CMaps and fonts).
Each native build of the canvas is 24 to 38 MB; the Linux server's (`skia.linux-x64-gnu.node`) is 34.8 MB.

## What runs, and where

- **Only two files of pdfjs-dist run, and only in the PDF worker thread.** `src/service/fetch/pdf-worker.ts` is the one
  module that imports pdfjs-dist (`test/package.test.ts` checks it): `legacy/build/pdf.mjs` (1,069,549 bytes, the API)
  and `legacy/build/pdf.worker.mjs` (2,418,244 bytes, the parser). `src/service/fetch/pdf-text.ts` starts that file as
  a worker thread for each PDF, with a heap limit of 512 MiB, an empty environment, no Node flag of the service, and the
  fetch's time; it ends the worker at the end of that time. The service drops the worker's standard output and error.
  The service's own thread never loads pdf.js (`test/package.test.ts` loads the library, the CLI's service and
  `pdf-text.ts`, and finds no pdf.js module and no canvas global).
- **No native code.** At its import in Node, pdf.js's API (`pdf.mjs`, `node_utils`) calls
  `require("@napi-rs/canvas")` to fill `DOMMatrix` and `Path2D` for rendering. The worker registers a resolve hook
  (`registerHooks`, for that thread only) that refuses every `@napi-rs/` package, so pdf.js warns
  (`Cannot load "@napi-rs/canvas" package`) and goes on: text extraction needs no canvas. `test/page-fetch-pdf.test.ts`
  reads that warning from a real worker and gets the text.
- **No script of the PDF runs.** The worker uses pdf.js's core API only: `getDocument`, `getPage`, `getTextContent`
  and `getMetadata`. pdf.js runs a PDF's JavaScript only in its viewer's scripting sandbox (`pdf.sandbox.mjs`, which
  nothing here loads) and only when a caller asks for the PDF's actions (`getJSActions`, `getFieldObjects`), which
  nothing here does. The test PDFs include one with a JavaScript open action.
- **No eval.** pdf.js 6.4.299 has no `isEvalSupported` option any more: both files hold no `eval(`. Of the matches of
  `Function(` (2 in `pdf.mjs`, 23 in `pdf.worker.mjs`), one in each file is core-js's fixed lookup of the global object
  (`Function('return this')()`, a constant text that runs only where `globalThis` is missing); the others are names
  (`aFunction`, `parseShadingFunction`, `buildPostScriptJsFunction` and others). PostScript functions of a PDF (type 4)
  run in pdf.js's own interpreter (`PsJsCompiler`, an intermediate form, no eval). The option `useWasm: false` turns off
  the compile of PostScript functions to WebAssembly and pdf.js's WebAssembly image decoders.
- **No network.** The bytes come in the worker's `workerData` (pdf.js's `data`), never a `url`, so pdf.js's network
  streams (its `fetch` and `XMLHttpRequest` code: 8 and 3 matches of `fetch(` and `XMLHttpRequest` in `pdf.mjs`, 40 and
  1 in `pdf.worker.mjs`) do not run; `disableRange`, `disableStream` and `disableAutoFetch` are on too. The CMaps of
  CJK fonts and the standard fonts' data come from the package's own folders (`cmaps/`, `standard_fonts/`) through
  pdf.js's Node file reader (`useWorkerFetch: false`); pdf.js reads a CMap only by a name in its fixed list
  (`BUILT_IN_CMAPS`) and a standard font only by its fixed map of names, so a PDF cannot name another file. Neither
  file holds `WebSocket`, `importScripts` or `child_process`.
- **No Web Worker.** In Node pdf.js uses its "fake worker": the worker thread sets `globalThis.pdfjsWorker` to the
  imported `pdf.worker.mjs` first, so pdf.js imports no worker file by a URL and starts no thread of its own.
- **Other options.** `useSystemFonts: false`, `disableFontFace: true`, `enableXfa: false`,
  `isOffscreenCanvasSupported: false`, `isImageDecoderSupported: false`, `verbosity: 0`. Text extraction decodes no
  image.

## How the files were checked

The installed copies were checked against the lockfile's hashes by `npm ci`. The two files that run were scanned for the
names above with `grep -o -F` (fixed strings, no regular expression over the large files), and the call sites of
`Function(`, `import(`, `require(`, `fetch(` and `XMLHttpRequest` were read. The Node polyfill block (`node_utils`), the
fake worker's loader (`PDFWorker`), `getDocument`'s options and the CMap fetch (`createBuiltInCMap`) were read in
`pdf.mjs` and `pdf.worker.mjs`. pdf.js was checked to work with the canvas refused: a worker read a PDF of three pages
(text, a page with no text, text), a PDF with no text, a locked PDF (`PasswordException`) and a file that is no PDF
(`InvalidPDFException`).

## Upgrades

Upgrade one package at a time (`npm install --save-exact pdfjs-dist@<exact>`, with a `--before` date 30 days back while
the Linux server's npm has no `min-release-age`), read the diff of the two files that run (`npm diff
--diff=pdfjs-dist@<old> --diff=pdfjs-dist@<new>`), scan them again for the names above, check that the canvas's
`require` is still the one in `node_utils` and that `getDocument` still takes the options of the worker, and update this
note, the version table in `test/package.test.ts` and C11's item "PDFs" (it names the version).
