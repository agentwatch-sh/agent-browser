// The service of the blanket live check (board ab-4wh.6; test/live/service-blanket/check.ts starts it). It is `agent-browser
// service --test` (src/service/main.ts: the --test path, with its pinned receiver and the check's display), with the
// test-only seams of the blanket profile that no CLI flag sets:
// - the address proxy's resolver: the two test names public.test and private.test (RFC 6761: never public names) give
//   127.0.0.1, the check's local stand-in; every other name has no address, so no request of the run reaches a public
//   site (Chrome's own traffic is refused too);
// - the address proxy's `admit`: only public.test, at 127.0.0.1 and the stand-in's port, passes before the address rule,
//   as a stand-in of a public host; private.test (the same address) gets the rule's refusal;
// - layer 1's address check: public.test passes; every other name goes through the address rule with the test resolver.
// Everything else is --test's: the harness is the service's "daemon" (its parent), the folders are the run's temp folders.
// Start it with node --disable-sigusr1. Never run it by hand.
//
//   node --disable-sigusr1 test/live/service-blanket/blanket-service.ts <run> <state> <tools> <lists> <display> <source.json> <stand-in port>

import { join } from "node:path";
import { checkHost } from "../../../src/service/fetch/address.ts";
import { linkSocketFor, testChromeSource } from "../../../src/service/main.ts";
import { startService } from "../../../src/service/service.ts";
import { GoogleChromeTools } from "../../../src/service/unit/google-chrome.ts";
import { testOwner } from "../../../src/service/unit/owner.ts";
import { unitPaths } from "../../../src/service/unit/paths.ts";

const [run, stateDir, toolsDir, lists, displayArg, sourceFile, portArg] = process.argv.slice(2);
if (!run || !/^\d+$/.test(displayArg ?? "") || !/^\d+$/.test(portArg ?? "")) {
  process.stderr.write("usage: blanket-service.ts <run> <state> <tools> <lists> <display> <source.json> <stand-in port> (the live check starts it)\n");
  process.exit(2);
}
const standIn = Number(portArg);
const log = (l: string) => process.stderr.write(`${l}\n`);
const NAMES: Record<string, string[]> = { "public.test": ["127.0.0.1"], "private.test": ["127.0.0.1"] };
const resolve = async (host: string): Promise<string[]> => {
  const all = NAMES[host.toLowerCase().replace(/\.+$/, "")];
  if (!all) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
  return all;
};
const paths = unitPaths(stateDir, toolsDir);
const controlDoor = join(run, "control.sock");
const s = await startService({
  agentDoor: join(run, "cdp.sock"), controlDoor, daemonUnit: "agentwatch.service", daemonCommand: join(run, "..", "daemon-command.json"), log,
  mainPid: async () => process.ppid,
  lists: { listsFolder: lists, stateFolder: paths.state },
  unit: {
    paths, owner: testOwner(), tools: new GoogleChromeTools({ tools: paths.tools, source: testChromeSource(sourceFile), log }),
    part: { unit: { displays: { first: Number(displayArg), last: Number(displayArg) } } },
  },
  link: { socket: linkSocketFor(controlDoor) },
  blanket: {
    addressCheck: async (host) => { if (host === "public.test") return null; const r = await checkHost(host, resolve); return r.ok ? null : r.why; },
    proxy: { resolve, admit: (host, address, port) => host === "public.test" && address === "127.0.0.1" && port === standIn },
  },
});
await new Promise<void>((r) => { process.once("SIGTERM", () => r()); process.once("SIGINT", () => r()); });
await s.stop();
process.exit(0);
