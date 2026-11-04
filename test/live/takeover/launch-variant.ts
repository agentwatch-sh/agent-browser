// The start of a `start.ts` comparison variant (ab-b84.11): agent-browser's `launch` command (src/commands.ts),
// as the CLI runs it, with its measurement hooks: --hidden starts through `open -n -g -j`, and --no-give-back
// turns the built-in give-back guard (src/giveback.ts) off. The CLI never sets them. It prints one JSON
// document, as `launch --json` does; exit 0 on success, 1 on a failure, 2 on a usage error. Only start.ts runs it.
//
//   node test/live/takeover/launch-variant.ts --state-dir DIR --chrome-bin APP_BINARY [--hidden] [--no-give-back]

import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { commands } from "../../../src/commands.ts";
import { errorCode } from "../../../src/errors.ts";

const USAGE = "usage: node test/live/takeover/launch-variant.ts --state-dir DIR --chrome-bin APP_BINARY [--hidden] [--no-give-back] (absolute paths; start.ts runs it)";
const done = (doc: unknown, code: number) => process.stdout.write(JSON.stringify(doc) + "\n", () => process.exit(code));

let values: { "state-dir"?: string; "chrome-bin"?: string; hidden?: boolean; "no-give-back"?: boolean } = {};
try {
  values = parseArgs({ args: process.argv.slice(2), strict: true, allowPositionals: false, options: {
    "state-dir": { type: "string" }, "chrome-bin": { type: "string" }, hidden: { type: "boolean" }, "no-give-back": { type: "boolean" },
  } }).values;
} catch (e) { values = {}; process.stderr.write(`${(e as Error).message}\n`); }
const stateDir = values["state-dir"], chromeBin = values["chrome-bin"];
if (!stateDir || !chromeBin || !isAbsolute(stateDir) || !isAbsolute(chromeBin)) {
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
}
const hooks = { ...(values.hidden ? { hidden: true } : {}), ...(values["no-give-back"] ? { giveBack: false } : {}) };
try {
  done(await commands.launch({ stateDir, chromeBin, log: (line) => { process.stderr.write(`${line}\n`); } }, {}, hooks), 0);
} catch (e) {
  const code = errorCode(e);
  done({ ok: false, command: "launch", error: { code, message: e instanceof Error ? e.message : String(e) } }, code === "usage" ? 2 : 1);
}
