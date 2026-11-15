# Vetting: defuddle 0.19.5 and what it brings (2026-11-15)

PageFetch (board ab-v16.102; C11, "PageFetch"; the PageFetch design, section 5.12) converts the rendered DOM of a page to
markdown with Defuddle, whose markdown step is Turndown. The operator asked for an existing converter instead of one of
our own. This note is the technical vetting that the repo asks for every dependency; turndown, the other direct
dependency of PageFetch, has its own note (`docs/supply-chain/turndown-7.2.4.md`). It holds no licence review: the
legal team does that.

## The packages, pinned in `package-lock.json`

`defuddle` and `turndown` are the two direct dependencies, each pinned exactly. Each is the newest version that was at
least 30 days old on 2026-11-15: defuddle 0.19.6 (2026-10-24) and turndown 7.2.5 (2026-11-04) were younger. The Linux
server's npm has no `min-release-age` setting, so the install ran once with `--before=2026-10-16T00:00:00Z`: every
package of the tree below is at least 30 days old too (the newest is `entities` 8.1.0, 2026-09-07). Without that cut,
npm took `linkedom` 0.18.15 (2026-11-01) and its new `cssomnom` 0.1.12 (2026-11-13). The repo `.npmrc` stays as it is,
and `ignore-scripts=true` stays on. No package of the tree has an install script (`hasInstallScript` is absent in the
lockfile for each; `test/package.test.ts` checks it). `npm audit`: 0 vulnerabilities.

| Package | Version | Published | Publisher | Integrity (sha512, start) | Why it is here |
| --- | --- | --- | --- | --- | --- |
| `@mixmark-io/domino` | 2.2.0 | 2024-04-06 | pavel.horal | `Y28PR25bHXUg88kCV7nivXr` | turndown's DOM under Node, not used |
| `@xmldom/xmldom` | 0.9.12 | 2026-08-21 | karfau | `5AXjrcMClTryPe9LgZrygpB` | mathml-to-latex's XML parser, not used |
| `boolbase` | 2.0.0 | 2026-03-17 | GitHub Actions (npm OIDC), SLSA provenance | `DkVaaQHymRhpYEYo9x1oo7Q` | linkedom's parser and selectors (tests only) |
| `commander` | 12.1.0 | 2024-05-18 | abetomo | `Vw8qHK3bZM9y/P10u3Vib8o` | defuddle's command line (`dist/cli.js`), not used |
| `css-select` | 7.0.0 | 2026-03-22 | GitHub Actions (npm OIDC), SLSA provenance | `snmjEVXy+1LnwXdxhYvTMj1` | linkedom's parser and selectors (tests only) |
| `css-what` | 8.0.0 | 2026-03-17 | GitHub Actions (npm OIDC), SLSA provenance | `DH0Bqq3DNp5tdOReuNyAA+E` | linkedom's parser and selectors (tests only) |
| `cssom` | 0.5.0 | 2021-06-20 | nv | `iKuQcq+NdHqlAcwUY0o/HL6` | linkedom's parser and selectors (tests only) |
| `defuddle` | 0.19.5 | 2026-10-10 | GitHub Actions (npm OIDC), SLSA provenance | `WpgFv5TWA8s8bWRXMb+tosd` | the converter (its browser build only) |
| `dom-serializer` | 3.1.1 | 2026-05-02 | GitHub Actions (npm OIDC), SLSA provenance | `4MEa38/QexBob6gFNwu+EGd` | linkedom's parser and selectors (tests only) |
| `domelementtype` | 3.0.0 | 2026-03-17 | GitHub Actions (npm OIDC), SLSA provenance | `umCQid3jKbDmVjx8jGaW7uU` | linkedom's parser and selectors (tests only) |
| `domhandler` | 6.0.1 | 2026-03-17 | GitHub Actions (npm OIDC), SLSA provenance | `gYzvtM72ZtxQO0T048kd6HW` | linkedom's parser and selectors (tests only) |
| `domutils` | 4.0.2 | 2026-03-18 | GitHub Actions (npm OIDC), SLSA provenance | `qI4JLRKnSzqFqr7hAlS5xQD` | linkedom's parser and selectors (tests only) |
| `entities` | 8.1.0 | 2026-09-07 | GitHub Actions (npm OIDC), SLSA provenance | `kxL7msIffSuh9aaFAMD7rxA` | linkedom's parser and selectors (tests only) |
| `html-escaper` | 3.0.3 | 2021-02-18 | webreflection | `RuMffC89BOWQoY0WKGpIhn5` | linkedom's parser and selectors (tests only) |
| `htmlparser2` | 10.1.0 | 2026-01-21 | feedic | `VTZkM9GWRAtEpveh7MSF6Sj` | linkedom's parser and selectors (tests only) |
| `htmlparser2/node_modules/dom-serializer` | 2.0.0 | 2022-04-09 | feedic | `wIkAryiqt/nV5EQKqQpo3ST` | linkedom's parser and selectors (tests only) |
| `htmlparser2/node_modules/dom-serializer/node_modules/entities` | 4.5.0 | 2023-04-13 | feedic | `V0hjH4dGPh9Ao5p0MoRY6BV` | linkedom's parser and selectors (tests only) |
| `htmlparser2/node_modules/domelementtype` | 2.3.0 | 2022-04-07 | feedic | `OLETBj6w0OsagBwdXnPdN0c` | linkedom's parser and selectors (tests only) |
| `htmlparser2/node_modules/domhandler` | 5.0.3 | 2022-04-30 | feedic | `cgwlv/1iFQiFnU96XXgROh8` | linkedom's parser and selectors (tests only) |
| `htmlparser2/node_modules/domutils` | 3.2.2 | 2025-01-06 | feedic | `6kZKyUajlDuqlHKVX1w7gys` | linkedom's parser and selectors (tests only) |
| `htmlparser2/node_modules/entities` | 7.0.1 | 2026-01-21 | feedic | `TWrgLOFUQTH994YUyl1yT4u` | linkedom's parser and selectors (tests only) |
| `linkedom` | 0.18.13 | 2026-07-07 | webreflection | `ES/o9qotMpzpN2MHs+Iq/Jc` | defuddle's optional DOM under Node; the tests' fake DOM |
| `mathml-to-latex` | 1.8.0 | 2026-06-10 | GitHub Actions (npm OIDC), SLSA provenance | `gQ0uK3zqB8HwlfaXJkEL5rg` | defuddle's math step in its node entry, not used |
| `nth-check` | 3.0.1 | 2026-03-17 | GitHub Actions (npm OIDC), SLSA provenance | `GX0gsdbGVCgnRgbeGaubfjp` | linkedom's parser and selectors (tests only) |
| `temml` | 0.13.5 | 2026-08-28 | ronkok | `aPkDDgunanpLNL0ql32Hbol` | defuddle's optional math step, not used |
| `turndown` | 7.2.4 | 2026-04-03 | martincizek | `I8yFsfRzmzK0WV1pNNOA4A7` | pinned by this task: the markdown step of defuddle's node entry |
| `uhyphen` | 0.2.0 | 2022-11-13 | webreflection | `qz3o9CHXmJJPGBdqzab7qAY` | linkedom's parser and selectors (tests only) |

`linkedom` and its tree, and `temml` and `turndown`, are optional dependencies of defuddle; `turndown` is also a direct
dependency here. `npm ci` installs the optional ones too.

## What runs, and where

- **Only defuddle's browser build runs, and never in the service's process.** `src/service/fetch/fetch-page.ts` resolves
  `defuddle/full` (`dist/index.full.js`, 768,702 bytes, a webpack UMD build of defuddle with its markdown step) and reads
  it once as text. The service sends that text to the fetch tab, where it runs in a new isolated world of the page
  (`Page.createIsolatedWorld`, `grantUniversalAccess` false), wrapped in a function that gives it a `module` of its own,
  so it sets no global. No module of the library, the CLI or the service imports defuddle, turndown or linkedom
  (`test/package.test.ts` checks it). The other entries (`defuddle`'s `dist/index.js`, `dist/node.js` and `dist/cli.js`,
  and turndown's builds) are not used.
- **The build's copy of Turndown.** webpack put a copy of Turndown inside `dist/index.full.js` when defuddle's
  maintainers built 0.19.5; defuddle's own lockfile at the tag `0.19.5` names turndown 7.2.0. So the markdown step that
  runs is that copy, not the installed turndown 7.2.4. The direct pin of turndown 7.2.4 fixes the version that npm
  installs for defuddle's node entry. To run turndown 7.2.4 itself, the service would need a build step of its own (an
  open point for the lead).
- **The build's network calls.** The build holds `fetch(` 47 times, all in defuddle's extractors for some sites (for
  example YouTube transcripts and Bilibili), and each is behind `parseAsync()` and the option `useAsync`. PageFetch calls
  `parse()`, the synchronous form, with `useAsync: false`, so no extractor fetches. In any case the page's requests,
  also those of an isolated world, pass PageFetch's guard (the address rule). The build holds no `XMLHttpRequest`,
  `WebSocket`, `sendBeacon`, `eval(`, `new Function`, `importScripts`, `postMessage`, `import(`, `localStorage`,
  `document.cookie` or `navigator.`. It sets `innerHTML` 3 times, on elements of its own copy of the document.
- **The live DOM stays as it is.** Defuddle reads a copy of the document (`cloneNode`) and reads computed styles of the
  live one to remove hidden elements. The test of the conversion on a fake DOM checks that the document's HTML is the
  same after the conversion, and that the build sets no global.
- **The tests.** `test/page-fetch-parts.test.ts` runs the same build in a `node:vm` context with linkedom's document
  (linkedom is defuddle's own DOM for Node), as an isolated world runs it.

## How the files were checked

The installed copies were checked against the lockfile's hashes by `npm ci`. The build was scanned for the names above
with `grep -o -F` (it is one minified line, so no regular expression ran over it). The async path was read in
defuddle's `dist/defuddle.js` (`parseAsync`, `fetchAsyncVariables`: both return early with `useAsync: false`).

## Upgrades

Upgrade one package at a time (`npm install --save-exact <pkg>@<exact>`, with a `--before` date 30 days back while the
Linux server's npm has no `min-release-age`), read the diff of the published files (`npm diff --diff=<pkg>@<old>
--diff=<pkg>@<new>`), scan the new browser build again, and update this note and the version table in
`test/package.test.ts`.
