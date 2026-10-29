#!/usr/bin/env node
// The CLI: agent-browser <command> ... --state-dir DIR --allowlist FILE [--json]. Plain JavaScript,
// so it also starts from a node_modules install (see ../loader.js).

import { importSource } from "../loader.js";

const { main } = await importSource("./src/cli.ts");
const status = await main(process.argv.slice(2));
// The proxy keeps serving; every other command is done once its output is written.
if (status !== "serve") process.exit(status);
