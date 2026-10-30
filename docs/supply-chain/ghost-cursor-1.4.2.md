# Vetting: ghost-cursor 1.4.2 and what it brings (2026-10-30)

`record` uses ghost-cursor's `path()` for the demo cursor's path (a Bezier curve with its spread, and
its overshoot past 500 px). The operator asked for this library instead of a hand-written path. This
note is the technical vetting that the repo asks for every dependency. It holds no licence review.

## The packages, pinned in `package-lock.json`

| Package | Version | Published | Publisher | Integrity (sha512, start) | Install scripts |
| --- | --- | --- | --- | --- | --- |
| ghost-cursor | 1.4.2 | 2026-01-12 | GitHub Actions (npm OIDC), SLSA provenance attestation | `NPMuH05Ik9h99zrAb4fvAzh` | none (`prepare` is a dev script; npm never runs it for a registry install) |
| bezier-js | 6.1.4 | 2023-07-16 | pomax (the only maintainer) | `PA0FW9ZpcHbojUCMu28z9Vg` | none |
| debug | 4.4.3 | 2025-09-13 | qix | `RGwwWnwQvkVfavKVt22FGLw` | none |
| ms | 2.1.3 | 2020-12-08 | styfle (Vercel) | `6FlzubTLZG3J2a/NVCAleEh` | none |
| @types/bezier-js | 4.1.3 | 2023-11-06 | DefinitelyTyped | `FNVVCu5mx/rJCWBxLTcL7oO` | none (type declarations only, no code) |

Every version is older than the operator's 30-day release age (`min-release-age=30`), so the repo
`.npmrc` stays as it is, and `ignore-scripts=true` stays on. `npm audit`: 0 vulnerabilities.

**debug.** debug 4.4.2 was the malicious release of the September 2025 npm phishing incident (a
browser crypto-wallet hijacker in `index.js`). npm removed it; it is not in the version list. 4.4.3 is
the maintainer's clean release after the incident. It has no provenance attestation, so its four
source files were read in full (below). Never accept 4.4.2.

## What was read

The five tarballs were downloaded with `npm pack` into an empty folder and read without running
anything. The installed `node_modules` copies are byte-identical to them (`diff -r`), and the lockfile
hashes match the tarballs.

- **What loads.** `require("ghost-cursor")` loads `lib/spoof.js`, `lib/math.js`, `lib/mouse-helper.js`,
  `bezier-js/dist/bezier.cjs`, `debug/src/{index,node,common}.js` and `ms/index.js`. puppeteer is only
  a dev dependency of ghost-cursor; nothing loads it at run time (`test/package.test.ts` checks this).
- **No network, files, processes or eval** in that code: no `fetch`, `http`, `net`, `fs`,
  `child_process`, `eval` or `new Function`. No obfuscation: the long lines are transpiled variable
  lists, export lists, Bezier arithmetic, and the CSS of `installMouseHelper`.
- **debug** reads `DEBUG` and `DEBUG_*` from the environment and, only when `DEBUG` names
  `ghost-cursor`, writes log lines to standard error. It tries `require("supports-color")`, which is not
  installed, inside a try block.
- **`installMouseHelper`** (ghost-cursor's own visual cursor) uses `innerHTML` and a `<style>` element,
  which Google Sheets refuses. agent-browser never calls it; it draws its own overlay with DOM calls.
- **Randomness.** ghost-cursor draws from `Math.random`. `record` swaps in its seeded generator only
  while `path()` runs (it is synchronous), so a retake with the same `--seed` moves the same way.

## How it is used

- Loaded only when a recording plans a move (`import("ghost-cursor")` in `src/record.ts`), so the rest
  of the library never loads it.
- Only `path()` and `overshoot()` (from `lib/math.js`) are called. ghost-cursor's timestamps move at one
  constant speed (measured 0.2 to 0.3 px/ms: 2.6 s for 500 px), so `record` times the path itself: a
  Fitts's-law duration (250 ms + 110 ms x log2(1 + D/W), from 300 to 1000 ms) with a minimum-jerk speed
  profile along the curve.

## Upgrades

Upgrade one package at a time (`npm install <pkg>@<exact>`), read the diff of the published files
(`npm diff --diff=<pkg>@<old> --diff=<pkg>@<new>`), and update this note and the version table in
`test/package.test.ts`.
