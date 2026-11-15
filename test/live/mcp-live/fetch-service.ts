// The service of the MCP live check's PageFetch rows (board ab-v16.102; test/live/mcp-live/check.ts --page-fetch starts
// it). It is `agent-browser service --test --test-mcp-port 0` (src/service/main.ts), with its pinned receiver, and with
// one change for the run:
// - PageFetch's test-only `admit` (PageFetchOptions.admit; the service's option pageFetch, which no CLI flag sets) passes
//   one test name under .test, which Chrome maps to the check's own local server (--host-resolver-rules in the config's
//   chrome_args). Every other host goes through the address rule as in a real session.
// Everything else is --test's: the harness is the service's "daemon" (its parent), the folders are the run's temp
// folders, the display is the check's free display. Start it with node --disable-sigusr1. Never run it by hand.
//
//   node --disable-sigusr1 test/live/mcp-live/fetch-service.ts <run> <state> <tools> <lists> <display> <source.json> <test name>

import { join } from "node:path";
import { linkSocketFor, mcpOption, testChromeSource, testMcpPort } from "../../../src/service/main.ts";
import { mcpListen } from "../../../src/service/mcp/listen-fds.ts";
import { startService } from "../../../src/service/service.ts";
import { GoogleChromeTools } from "../../../src/service/unit/google-chrome.ts";
import { testOwner } from "../../../src/service/unit/owner.ts";
import { unitPaths } from "../../../src/service/unit/paths.ts";

const [run, stateDir, toolsDir, lists, displayArg, sourceFile, name] = process.argv.slice(2);
// The test name: a host under .test (RFC 6761: never a public name), in its normalized form.
if (!name || !/^\d+$/.test(displayArg) || !/^[a-z0-9-]+(\.[a-z0-9-]+)*\.test$/.test(name)) {
  process.stderr.write("usage: fetch-service.ts <run> <state> <tools> <lists> <display> <source.json> <name.test> (the live check starts it)\n");
  process.exit(2);
}
const log = (l: string) => process.stderr.write(`${l}\n`);
const paths = unitPaths(stateDir, toolsDir);
const controlDoor = join(run, "control.sock");
const listen = await mcpListen({ test: true, testPort: testMcpPort("0") });
const s = await startService({
  agentDoor: join(run, "cdp.sock"), controlDoor, daemonUnit: "agentwatch.service", daemonCommand: join(run, "..", "daemon-command.json"), log,
  mainPid: async () => process.ppid,
  lists: { listsFolder: lists, stateFolder: paths.state },
  unit: {
    paths, owner: testOwner(), tools: new GoogleChromeTools({ tools: paths.tools, source: testChromeSource(sourceFile), log }),
    part: { unit: { displays: { first: Number(displayArg), last: Number(displayArg) } } },
  },
  link: { socket: linkSocketFor(controlDoor) },
  ...(listen ? { mcp: mcpOption(listen, undefined) } : {}),
  // Only the one test name, over http, passes before the address rule.
  pageFetch: { admit: (u) => u.hostname === name && (u.protocol === "http:" || u.protocol === "ws:") },
});
await new Promise<void>((r) => { process.once("SIGTERM", () => r()); process.once("SIGINT", () => r()); });
await s.stop();
process.exit(0);
