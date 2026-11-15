# Vetting: turndown 7.2.4 and what it brings (2026-11-15)

PageFetch (board ab-v16.102; C11, "PageFetch"; the PageFetch design, section 5.12) pins turndown, the markdown step of
Defuddle, beside defuddle itself (`docs/supply-chain/defuddle-0.19.5.md`, which holds the table of the whole tree, the
release-age cut and the scan of the build that runs). This note is the technical vetting that the repo asks for every
dependency. It holds no licence review: the legal team does that.

## The packages, pinned in `package-lock.json`

| Package | Version | Published | Publisher | Integrity (sha512, start) | Install scripts |
| --- | --- | --- | --- | --- | --- |
| turndown | 7.2.4 | 2026-04-03 | martincizek | `I8yFsfRzmzK0WV1pNNOA4A7` | none (`prepare` is a dev script; npm never runs it for a registry install) |
| @mixmark-io/domino | 2.2.0 | 2024-04-06 | pavel.horal | `Y28PR25bHXUg88kCV7nivXr` | none |

turndown 7.2.4 is the newest version that was at least 30 days old on 2026-11-15 (7.2.5 came on 2026-11-04). Neither
package has a provenance attestation. `ignore-scripts=true` stays on.

## What runs

Nothing of this package runs in the service or in the fetch tab:

- The service's process never imports turndown (`test/package.test.ts` checks that no module of the library, the CLI
  or the service imports it).
- The fetch tab runs defuddle's browser build, which carries its own copy of Turndown from defuddle's build (7.2.0 in
  defuddle's lockfile at its tag `0.19.5`; the defuddle note).
- `@mixmark-io/domino` is turndown's DOM under Node, for its node build only.

So the pin fixes the version that npm installs for defuddle's node entry, and the code of a later build step, if the
lead wants the fetch tab to run turndown 7.2.4 itself (an open point of the PR).

## What was read

The installed `package.json` of both packages: no `preinstall`, `install` or `postinstall` script, and no `bin`
(turndown's `prepare` builds it from its source; npm never runs it for a registry install). turndown's `lib/` holds its builds for the browser and for Node (`turndown.browser.*.js`, `turndown.*.js`); the
Node builds `require("@mixmark-io/domino")` only, and the browser builds use the page's `DOMParser`. No build holds
`fetch(`, `XMLHttpRequest`, `eval(` or `new Function`.

## Upgrades

As for defuddle: one package at a time, the diff of the published files, a `--before` date 30 days back while the
Linux server's npm has no `min-release-age`, and the version table in `test/package.test.ts`.
