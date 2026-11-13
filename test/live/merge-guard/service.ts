// The service of the merge guard's live check (board ab-v16.99; test/live/merge-guard/check.ts starts it). It is
// `agent-browser service --test --test-merge-guard-host github-standin.localhost` (src/service/main.ts) with one change for
// the run: the agent package is the run's own copy of the receiver 0.3.7 (chrome-extension main eda8df0, release/agent.crx,
// which the check reads with `git show`), as in the sign-in act's check. Everything else is --test's: the harness is the
// service's "daemon" (its parent), the folders are the run's temp folders, the display is the check's free display, and the
// guard's hosts are GitHub's and the stand-in host (start it with node --disable-sigusr1). Never run it by hand.
//
//   node --disable-sigusr1 test/live/merge-guard/service.ts <run folder> <state> <tools> <lists> <display> <crx> <source.json> <stand-in host>

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { linkSocketFor, testChromeSource, testMergeGuardHost } from "../../../src/service/main.ts";
import { checkCrx, pinnedLastFile, stageCrx, writeExtensionFile } from "../../../src/service/package/crx.ts";
import { startService } from "../../../src/service/service.ts";
import { GoogleChromeTools } from "../../../src/service/unit/google-chrome.ts";
import { testOwner } from "../../../src/service/unit/owner.ts";
import { unitPaths } from "../../../src/service/unit/paths.ts";

const [run, stateDir, toolsDir, lists, displayArg, crx, sourceFile, standIn] = process.argv.slice(2);
if (!standIn || !/^\d+$/.test(displayArg)) { process.stderr.write("usage: service.ts <run> <state> <tools> <lists> <display> <crx> <source.json> <stand-in host> (the live check starts it)\n"); process.exit(2); }
const log = (l: string) => process.stderr.write(`${l}\n`);
const paths = unitPaths(stateDir, toolsDir);
const info = checkCrx(crx, { sha256: createHash("sha256").update(readFileSync(crx)).digest("hex") });
const controlDoor = join(run, "control.sock");
const s = await startService({
  agentDoor: join(run, "cdp.sock"), controlDoor, daemonUnit: "agentwatch.service", daemonCommand: join(run, "..", "daemon-command.json"), log,
  mainPid: async () => process.ppid,
  lists: { listsFolder: lists, stateFolder: paths.state },
  unit: {
    paths, owner: testOwner(), tools: new GoogleChromeTools({ tools: paths.tools, source: testChromeSource(sourceFile), log }),
    part: { unit: {
      displays: { first: Number(displayArg), last: Number(displayArg) },
      prepare: { run: (copy) => { writeExtensionFile(copy, stageCrx(info, paths.tools), info, paths.chromes); return info.version; }, lastFile: (copy) => pinnedLastFile(copy, paths.tools, info.sha256) },
    } },
  },
  link: { socket: linkSocketFor(controlDoor) },
  // The stand-in host through --test's own check (a normalized host under .localhost), never a real host.
  mergeGuard: { testHosts: [testMergeGuardHost(standIn)] },
});
await new Promise<void>((r) => { process.once("SIGTERM", () => r()); process.once("SIGINT", () => r()); });
await s.stop();
process.exit(0);
