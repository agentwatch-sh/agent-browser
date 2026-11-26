// The service of the Mac's blanket live check (board ab-4wh.16; test/live/service-blanket-mac/check.ts starts it). The
// Mac twin of test/live/service-blanket/blanket-service.ts: it calls startService (src/service/service.ts) itself, on
// the Mac, with the check's folders (a temp run folder and lists folder, and the check's state folder), testOwner, the
// native link next to the control door, the real pinned agent package (the unit writes agent-package/ and the blanket
// part agent-package-blanket/), no MCP port, no stored sign-ins and no card pay, and the test-only seams of the blanket
// profile that no CLI flag sets:
// - the address proxy's resolver: the two test names public.test and private.test (RFC 6761: never public names) give
//   127.0.0.1, the check's local stand-in; every other name has no address, so no request of the run reaches a public
//   site (Chrome's own traffic is refused too);
// - the address proxy's `admit`: only public.test, at 127.0.0.1 and the stand-in's port, passes before the address rule;
// - layer 1's address check: public.test passes; every other name goes through the address rule with the test resolver.
// The Chrome unit's update check never runs (the Mac has no Chrome copy to update; the limits are pushed out of the run).
// The check is the service's "daemon" (its parent). Start it with node --disable-sigusr1. Never run it by hand.
//
//   node --disable-sigusr1 test/live/service-blanket-mac/blanket-mac-service.ts <run> <state> <lists> <stand-in port>

import { join } from "node:path";
import { checkHost } from "../../../src/service/fetch/address.ts";
import { linkSocketFor } from "../../../src/service/main.ts";
import { startService } from "../../../src/service/service.ts";
import { GoogleChromeTools } from "../../../src/service/unit/google-chrome.ts";
import { testOwner } from "../../../src/service/unit/owner.ts";
import { unitPaths } from "../../../src/service/unit/paths.ts";

const [run, stateDir, lists, portArg] = process.argv.slice(2);
if (process.platform !== "darwin" || !run || !stateDir || !lists || !/^\d+$/.test(portArg ?? "")) {
  process.stderr.write("usage (the Mac only): blanket-mac-service.ts <run> <state> <lists> <stand-in port> (the live check starts it)\n");
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
const paths = unitPaths(stateDir, join(run, "tools"));
const controlDoor = join(run, "control.sock");
const NEVER = 2 ** 31 - 1;
const s = await startService({
  agentDoor: join(run, "cdp.sock"), controlDoor, daemonUnit: "com.agentwatch", daemonCommand: join(run, "..", "daemon-command.json"), log,
  mainPid: async () => process.ppid,
  lists: { listsFolder: lists, stateFolder: paths.state },
  unit: { paths, owner: testOwner(), tools: new GoogleChromeTools({ tools: paths.tools, log }), part: { firstCheckMs: NEVER, checkEveryMs: NEVER } },
  link: { socket: linkSocketFor(controlDoor) },
  blanket: {
    addressCheck: async (host) => { if (host === "public.test") return null; const r = await checkHost(host, resolve); return r.ok ? null : r.why; },
    proxy: { resolve, admit: (host, address, port) => host === "public.test" && address === "127.0.0.1" && port === standIn },
  },
});
await new Promise<void>((r) => { process.once("SIGTERM", () => r()); process.once("SIGINT", () => r()); });
await s.stop();
process.exit(0);
