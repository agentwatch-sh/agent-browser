// The start of `start.ts --variant hidden` (ab-b84.11): agent-browser's `launch` command (src/commands.ts),
// as the CLI runs it, with its measurement hook `hidden` on, so that the background start on macOS goes
// through `open -n -g -j`. The CLI never sets the hook. It prints one JSON document, as `launch --json`
// does; exit 0 on success, 1 on a failure, 2 on a usage error. Only start.ts runs it.
//
//   node test/live/takeover/launch-hidden.ts --state-dir DIR --chrome-bin APP_BINARY

import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { commands } from "../../../src/commands.ts";
import { errorCode } from "../../../src/errors.ts";

const USAGE = "usage: node test/live/takeover/launch-hidden.ts --state-dir DIR --chrome-bin APP_BINARY (absolute paths; start.ts runs it)";
const done = (doc: unknown, code: number) => process.stdout.write(JSON.stringify(doc) + "\n", () => process.exit(code));

let values: { "state-dir"?: string; "chrome-bin"?: string } = {};
try {
  values = parseArgs({ args: process.argv.slice(2), strict: true, allowPositionals: false, options: { "state-dir": { type: "string" }, "chrome-bin": { type: "string" } } }).values;
} catch (e) { values = {}; process.stderr.write(`${(e as Error).message}\n`); }
const stateDir = values["state-dir"], chromeBin = values["chrome-bin"];
if (!stateDir || !chromeBin || !isAbsolute(stateDir) || !isAbsolute(chromeBin)) {
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
}
try {
  done(await commands.launch({ stateDir, chromeBin, log: (line) => { process.stderr.write(`${line}\n`); } }, {}, { hidden: true }), 0);
} catch (e) {
  const code = errorCode(e);
  done({ ok: false, command: "launch", error: { code, message: e instanceof Error ? e.message : String(e) } }, code === "usage" ? 2 : 1);
}
