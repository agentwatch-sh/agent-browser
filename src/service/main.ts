// `agent-browser service ...` on the command line (contract C12, "The command (stage 1a)" and "The fake service";
// board ab-v16.94.2). agentwatch's unit starts it from stage 2; nothing starts it before. Its log goes to standard
// error (the unit's journal), and it runs until SIGTERM or SIGINT.

import { resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { UsageError } from "../errors.ts";
import { defaultDaemonCommandFile } from "./admission.ts";
import { encodeLine, serviceHello } from "./control.ts";
import { startFake } from "./fake.ts";
import { defaultControlDoor, packageInfo, startService } from "./service.ts";

export const SERVICE_USAGE = "usage: agent-browser service --agent-door ADDRESS [--control-door PATH] [--daemon-unit UNIT] [--daemon-command FILE]"
  + " | agent-browser service --hello [--fake] | agent-browser service --fake --control-door PATH [--agent-door ADDRESS] [--refuse]"
  + " (agentwatch's unit starts it, not a person)";

type Values = Record<string, string | boolean | undefined>;

/** Resolves at the first SIGTERM or SIGINT. */
const signalled = () => new Promise<void>((r) => { process.once("SIGTERM", () => r()); process.once("SIGINT", () => r()); });

export async function serviceMain(v: Values, io: { stdout: Writable; stdin: Readable }, log: (line: string) => void): Promise<number> {
  const str = (k: string) => {
    const x = v[k];
    if (x === "") throw new UsageError(`--${k} is empty`);
    return typeof x === "string" ? x : undefined;
  };
  const fake = v.fake === true;
  if (v.refuse === true && !fake) throw new UsageError("--refuse goes with --fake");
  if (v.hello === true) {
    const { version, commit } = packageInfo();
    await new Promise<void>((r) => io.stdout.write(encodeLine(fake ? serviceHello(version, null, ["fake"]) : serviceHello(version, commit, [])), () => r()));
    return 0;
  }
  if (fake) {
    const controlDoor = str("control-door");
    if (!controlDoor) throw new UsageError("--fake needs --control-door: the fake never takes the place of the service");
    const agentDoor = str("agent-door");
    const f = await startFake({ controlDoor: resolve(controlDoor), agentDoor: agentDoor === undefined ? undefined : resolve(agentDoor), refuse: v.refuse === true, input: io.stdin, log });
    await signalled();
    await f.stop();
    log("fake: stopped");
    return 0;
  }
  const agentDoor = str("agent-door");
  if (!agentDoor) throw new UsageError(`--agent-door is required: the agent door's address, which the daemon gives; ${SERVICE_USAGE}`);
  const controlDoor = str("control-door") ?? defaultControlDoor();
  if (!controlDoor) throw new UsageError("--control-door is required when XDG_RUNTIME_DIR is not set");
  const s = await startService({
    agentDoor: resolve(agentDoor), controlDoor: resolve(controlDoor), daemonUnit: str("daemon-unit") ?? "agentwatch.service",
    daemonCommand: resolve(str("daemon-command") ?? defaultDaemonCommandFile()), log,
  });
  await signalled();
  await s.stop();
  return 0;
}
