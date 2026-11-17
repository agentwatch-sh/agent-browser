# Vetting: typescript 7.0.2 and the type check's packages (2026-11-15)

`npm run typecheck` runs `tsc --noEmit -p tsconfig.json`: the repo's strict `tsconfig.json` over `src/` and `test/`
(board task ab-b84.39), and `npm test` runs it first. The tests alone cannot find a type error: Node runs the `.ts`
files with type stripping and never checks a type. Review-164 B1 (a service part with no required `ops`) was such an
error: tsc finds it, the tests do not. This note is the technical vetting that the repo asks for every dependency. It
holds no licence review.

## The packages, pinned in `package.json` and `package-lock.json`

All are `devDependencies` (lockfile `dev: true`): `npm ci` in a checkout installs them; a consumer's install of
agent-browser never does.

| Package | Version | Published (UTC) | Publisher | Integrity (sha512, start) | Install scripts |
| --- | --- | --- | --- | --- | --- |
| typescript | 7.0.2 | 2026-07-08 15:55 | microsoft1es (Microsoft's release account) | `8FYau96o3NKOhbjKi/qNvG/` | none |
| @typescript/typescript-linux-x64 | 7.0.2 | 2026-07-08 15:50 | microsoft1es | `EYdf2cNg7rgCWJnxCdJ+F3V` | none |
| @typescript/typescript-darwin-arm64 | 7.0.2 | 2026-07-08 15:49 | microsoft1es | `gowzar9MwS/aRWp6f3a4KUq` | none |
| the 18 other `@typescript/typescript-<os>-<cpu>` | 7.0.2 | 2026-07-08 15:49 to 15:50 | microsoft1es | in `package-lock.json` | none |
| @types/node | 26.6.5 | 2026-10-09 18:46 | types (DefinitelyTyped's publisher) | `uMzsv9stDdofIZBx4UGh4Z9` | none (type declarations only, no code) |
| undici-types | 8.9.0 | 2026-07-24 12:32 | GitHub Actions (npm OIDC), provenance attestation | `KTDyRTYX8sWmKXAikPHHSyc` | none (type declarations only, no code) |
| @types/ws | 8.18.2 | 2026-09-29 08:07 | types (DefinitelyTyped's publisher) | `67MQl+fpWKVTT1NYdnmo3U4` | none (type declarations only, no code) |

- **typescript 7** is the native port of the compiler: the `typescript` package is a small Node launcher, and `tsc`
  itself is a native binary in one `@typescript/typescript-<os>-<cpu>` package per platform. `typescript` names all
  20 as optional dependencies; the lockfile records all 20 with their `os` and `cpu`, and npm installs only the one
  that matches the box (`linux-x64` on the Linux server, `darwin-arm64` on the Mac).
- **@types/node** is the `types: ["node"]` of `tsconfig.json`; it names `undici-types ~8.9.0` (8.9.0 is the only
  8.9 release). **@types/ws**: `ws` ships no declarations, so without it each `import ... from "ws"` is an error
  (TS7016, 14 of them) and every value from `ws` is `any`. It names `@types/node *` (the one above).
- **Release age.** Each version is the newest release that was at least 30 days old on 2026-11-15 (the operator's
  `min-release-age=30`, which the repo `.npmrc` names): typescript 7.0.2 is the newest stable release (7.1 is a
  beta); @types/node 26.6.6 (2026-10-28) is younger than 30 days, so 26.6.5; @types/ws 8.18.2 is its newest release.
  `ignore-scripts=true` stays on.
- **Signatures and audit.** `npm audit`: 0 vulnerabilities. `npm audit signatures`: every installed package has a
  verified registry signature; of the new ones, only undici-types has a provenance attestation.

## What was read

The tarballs of typescript, the linux-x64 and darwin-arm64 packages, @types/node, undici-types and @types/ws were
downloaded with `npm pack` into an empty folder and read without running anything. The installed `node_modules`
copies are byte-identical to them (`diff -r`), and the lockfile hashes match the tarballs.

- **The launcher** (read in full: `bin/tsc`, `lib/tsc.js`, `lib/getExePath.js`, `lib/version.cjs`, 3.8 kB).
  `bin/tsc` imports `lib/tsc.js`, which finds the binary of `@typescript/typescript-<platform>-<arch>` (by
  `import.meta.resolve` of its `package.json`) and replaces the Node process with it (`process.execve`, or
  `execFileSync` where that is missing). It reads only `package.json` files; no network, no `eval`.
- **What `tsc` does not load.** The rest of the package (`dist/api`, `dist/ast`, `dist/enums`, `dist/internal`,
  `vendor/vscode-jsonrpc`) is the `typescript/unstable/*` API for other tools: it starts the binary as a server over
  pipes or sockets. Nothing in this repo imports it.
- **The native binary** (24 MB, too large to read). Its Go build information names the module
  `github.com/microsoft/typescript-go` at commit `2bd066d87f5bafd315be9f40889d0a60b9e58e0b`, the same commit as the
  npm package's `gitHead`, built at 2026-07-08 04:22 UTC with Microsoft's Go 1.26.4 toolset, `CGO_ENABLED=0`, and
  `vcs.modified=true` (the build tree had changes that are not in the commit). Its Go dependencies:
  go-json-experiment/json, klauspost/cpuid, mackerelio/go-osstat, zeebo/xxh3 and golang.org/x/{sync,sys,term,text}.
  Its symbols hold no `net/http` client and no TLS; they hold the `net` dialer and `os/exec`.
- **Signatures of the binary.** The linux-x64 package carries `lib/tsc.sig`, a detached PGP signature: `gpgv` with
  Microsoft's release key (`EB3E94ADBE1229CF`, from the box's apt keyring) reports a good signature from "Microsoft
  (Release signing)". The darwin-arm64 binary has no `.sig`; its Mach-O code signature names "Developer ID
  Application: Microsoft Corporation (UBF8T346G9)" (not verified with `codesign`, which runs only on a Mac). Both
  binaries name the same commit, and their `lib/*.d.ts` files are identical.
- **One run, traced.** `strace -f -e trace=network,execve` of `node node_modules/typescript/bin/tsc --noEmit -p
  tsconfig.json` on the Linux server: the Node launcher replaces itself with the binary, and the binary opens no
  socket and starts no other process. The run takes about 2.5 s.
- **The declarations** (@types/node, undici-types, @types/ws) are `.d.ts` files, a `package.json`, a README and a
  licence file each: tsc reads them; nothing runs them. Node's type stripping never loads them.

## How it is used

- Only `npm run typecheck` runs `tsc` (also as the first step of `npm test`). No code in `src/` or `test/` imports typescript, and the library, the CLI
  and the service run as before: Node strips the types.
- `tsconfig.json` sets `noEmit`, so `tsc` writes no file.

## Upgrades

Upgrade one package at a time (`npm install --save-exact --save-dev <pkg>@<exact>`), keep the 30-day age rule, read
the diff of the published files (`npm diff --diff=<pkg>@<old> --diff=<pkg>@<new>`), verify the binary's signature
again, and update this note and the version table in `test/package.test.ts`.
