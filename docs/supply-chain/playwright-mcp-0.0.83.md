# Vetting: @playwright/mcp 0.0.83 and what it brings (2026-11-11)

The service serves the standard Playwright MCP inside its own process (the operator's answer Q4 of 2026-11-10; the
self-contained design, section 8.2; contract C11, "The MCP inside the service"; board ab-v16.94.5, stage 1d part 2b).
This note is the technical vetting that the repo asks for every dependency, by steps 1 to 8 of vedlo's
`docs/supply-chain.md` ("Before adding or upgrading anything"). It holds no licence review.

## The packages, pinned in `package.json` and `package-lock.json`

| Package | Version | Published (UTC) | Publisher | Integrity (sha512, start) | Install scripts |
| --- | --- | --- | --- | --- | --- |
| @playwright/mcp | 0.0.83 | 2026-09-28 23:19 | GitHub Actions (npm OIDC), SLSA provenance attestation | `oNcl+Ae2/IAjhfPeP46BfIk` | none |
| playwright | 1.64.0-alpha-1790635538000 | 2026-09-28 22:50 | GitHub Actions (npm OIDC), SLSA provenance attestation | `/5XDUMxpOd/9AojJtWDFIRV` | none |
| playwright-core | 1.64.0-alpha-1790635538000 | 2026-09-28 22:52 | GitHub Actions (npm OIDC), SLSA provenance attestation | `pNwaXirhXMRLaRQs4NQ18Ep` | none |

`npm install --save-exact @playwright/mcp@0.0.83` added these three packages and no other; `playwright` and
`playwright-core` are pinned in `package.json` too, at the exact versions that `@playwright/mcp` 0.0.83 names.
`playwright` names only `playwright-core` (no optional package), and `playwright-core` names none.
`test/package.test.ts` fails on any other package or version.

## The steps

1. **Need.** The operator chose the standard Playwright MCP (Q4 a), over a tool set of agent-browser's own. Nothing in
   the repo serves MCP tools; the service needs `createConnection` of the package's public entry.
2. **Identity.** The names are exact: `@playwright/mcp` (the `@playwright` scope), `playwright` and `playwright-core`.
   The registry links `git+https://github.com/microsoft/playwright-mcp.git` and `git+https://github.com/microsoft/playwright.git`.
   The repositories link back: `microsoft/playwright-mcp`'s homepage is the npm page of `@playwright/mcp`, its
   `package.json` names `@playwright/mcp`, and `microsoft/playwright`'s `packages/playwright` and
   `packages/playwright-core` name `playwright` and `playwright-core`.
3. **Maintainers and age.** The maintainers of all three are `pavelfeldman`, `yurys`, `dgozman-ms`,
   `microsoft-oss-releases` and `microsoft1es`, the same set as for the earlier releases. Since 0.0.81 (and for
   `playwright-core` since 1.63.0) GitHub Actions publishes through npm's trusted publishing (OIDC); 0.0.80 came from
   `microsoft1es`. The version choice:
   - 0.0.85 (2026-11-09 18:31 UTC, the version of the design's M3) is younger than 72 hours: not taken.
   - 0.0.84 (2026-10-31, with `playwright` 1.65.0-alpha-2026-10-30) is younger than 30 days. The repo's `.npmrc` says
     that the repo follows the operator's release-age rule (`min-release-age=30`, operator 2026-10-29), so it is not
     taken.
   - 0.0.83 and its two packages are 44 days old: the newest version that passes both rules.
   - The tools of 0.0.83 and 0.0.84 differ only in three argument keys (`browser_find.maxResults`,
     `browser_network_requests.all` and `browser_tabs.isolatedContext`); 0.0.85's were not compared.
4. **Known vulnerabilities.** `npm audit` after the change: 0 vulnerabilities. GitHub's advisory database has two
   advisories for these packages, both for older versions: GHSA-6fg3-hvw7-2fwq (`@playwright/mcp` < 0.0.40, the DNS
   rebinding of its own HTTP server, which the service does not run) and GHSA-7mvr-c777-76hp (`playwright` < 1.55.1,
   browser downloads without a certificate check; the service never downloads a browser). The two repositories
   publish no repository security advisory.
5. **Provenance.** `npm audit signatures`: 9 packages with verified registry signatures, 4 with verified attestations
   (these three and ghost-cursor). The SLSA provenance of `@playwright/mcp` 0.0.83 names `microsoft/playwright-mcp`,
   `.github/workflows/publish.yml`, commit `f183dad4a52965583e3cc1d59b88cdc279e2e57d` ("chore: mark v0.0.83"); that of
   `playwright` and `playwright-core` names `microsoft/playwright`, `.github/workflows/publish_release.yml` on `main`,
   commit `e8149b8257d32dcf8f72573ecc43e72439da7080`. Both builders are GitHub-hosted runners.
6. **What it runs.**
   - No `preinstall`, `install`, `postinstall` or `prepare` script in any of the three (their other scripts are the
     projects' own development scripts, which npm never runs for a registry install). `ignore-scripts=true` stays on.
   - Each package has a `bin` (`playwright-mcp`, `playwright`, `playwright-core`). The service never runs them.
   - The service loads only `@playwright/mcp/index.js` (two statements: it requires
     `playwright-core/lib/coreBundle` and exports `createConnection`), and so `playwright-core`'s `coreBundle.js`
     (3.6 MB) and `utilsBundle.js` (3.1 MB, the bundled third-party code: the MCP SDK's server, `ws`, `debug`, `zod`
     and others), with `package.json` and `browsers.json`. The `playwright` package is never loaded. Nothing loads
     before the first MCP session, and only in the scope's worker thread (`test/package.test.ts`).
   - The code holds launch and download paths (the browser registry, a download in a child process), HTTP fetches
     (a CDP endpoint's `/json/version`) and `child_process` uses. The service takes none of them: it gives
     `createConnection` a context getter, which connects over CDP to the agent door with a one-time ticket
     (`ws+unix://`). Without a getter, `createConnection` with `browser.cdpEndpoint` would call `browser.bind()`, which
     starts a pipe server for the browser in the temp folder (`<tmp>/pw-<hash>/browser/<guid>.sock`) and writes a
     server registry entry: another program of the user could then reach the browser around the agent door. With the
     getter neither happens. Two tests prove the path: one replaces `child_process`'s functions and `chromium`'s
     launch and connect calls with ones that fail, and runs tool calls; the other runs `initialize`, `tools/list` and
     five tool calls in a child under Node's permission model with reads only (no write, no network, no child process,
     no worker), and each answer is the getter's own error.
   - `debug` reads `DEBUG` from the environment and would write the MCP's calls with their arguments to standard
     error. The worker runs with an environment of its own (no `DEBUG`, no `PLAYWRIGHT_*`), and the service reads and
     drops the worker's standard output and error.
   - WebMCP (a page's own tools): its listing runs page code; the configuration turns it off (`webmcp: false`), and
     the allow list drops any such tool anyway.
   - `new Function` appears in the code of component testing (an `import("vite")`), in a check that a text parses as a
     function, and in the bundled JSON schema validator; `eval(` in page-side scripts that Playwright sends to the
     browser. `browser_run_code_unsafe` runs a client's code with `vm` in the server's process: the allow list refuses
     it. The code is bundled (esbuild), not minified or obfuscated.
7. **Diff on upgrades.** A first install: no diff. A pin bump runs `npm diff --diff=@playwright/mcp@0.0.83
   --diff=@playwright/mcp@<new>` and the same for `playwright-core`, and the allow list's test fails at any change of
   a tool (`src/service/mcp/allow-list.json`).
8. **Scope.** Only these three packages changed (`npm install --save-exact`); the area's tests and `npm test` ran.

## What was read

The three tarballs were fetched with `npm pack` and read without running anything; the installed `node_modules`
copies are byte-identical to them (`diff -r`), and the lockfile hashes match. `@playwright/mcp`'s `index.js`,
`index.d.ts`, `config.d.ts` and `cli.js`; in `playwright-core`'s `coreBundle.js` the MCP's `createConnection`, its
configuration (`resolveConfig`: no environment and no file is read on this path), its server (the roots request, the
tool list, the backend that the first tool call makes), its file checks (`outputFile`, `checkFile`), the browser
factory (`createBrowser`, `browser.bind`, the server registry), `connectOverCDP` (the `ws+unix://` URL, `noDefaults`,
`artifactsDir`) and the WebMCP switch; in `utilsBundle.js` the `ws+unix:` handling of the bundled `ws`.

## How it is used

- `src/service/mcp/session.ts` makes one server object for each MCP session with `createConnection(config, getter)`
  and the fixed configuration of C11; `src/service/mcp/worker.ts` runs them in one worker thread for each scope, with
  a heap limit; `src/service/mcp/transport.ts` applies the allow list (`src/service/mcp/allow-list.json`) before a
  message reaches them.
- Playwright's `chromium.connectOverCDP` is the only Playwright call of the service's own code.

## Upgrades

Upgrade one package set at a time (`npm install --save-exact @playwright/mcp@<exact>` and the exact `playwright` and
`playwright-core` that it names), read the diffs, write the new list from the new `tools/list` with a review of each
change, and update this note, the list and the version table in `test/package.test.ts`.
