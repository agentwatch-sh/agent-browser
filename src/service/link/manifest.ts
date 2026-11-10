// The host files that the agent Chrome reads (stage 1b part 2 of the self-contained agent browser, board ab-v16.94.9;
// the design, sections 5.1 "The native link" and 5.3; chrome-extension docs/protocol.md, C1; a port of agentwatch's
// daemon/browser/host_files.py). Chrome finds the native host through a manifest in the agent profile's
// NativeMessagingHosts folder; the manifest names a wrapper script, and only the receiver may start it. The wrapper
// puts the service's link socket and the agent profile in the shim's environment and runs `agent-browser host` with
// this Node and this checkout. The host name stays `sh.agentwatch.browser`, so the receiver needs no change.

import { chmodSync, closeSync, constants, fsyncSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_HOST_NAME, RECEIVER_ID } from "../package/pins.ts";
import { ENV_PROFILE, ENV_SOCKET } from "./host.ts";

/** This checkout's bin (the wrapper runs `<node> <bin> host`). */
export const BIN = fileURLToPath(new URL("../../../bin/agent-browser.js", import.meta.url));
/** Node's flag that turns the inspector signal off (the shim also holds SIGUSR1 at start, in the bin). */
const NODE_FLAGS = ["--disable-sigusr1"] as const;

/** The wrapper's path in the state folder, and the manifest's path in the profile. */
export const wrapperPath = (state: string) => join(state, "agent-browser-host");
export const manifestPath = (profile: string) => join(profile, "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`);

/** `value` in single quotes for /bin/sh; a quote, a line break or a NUL is refused. */
export function quoted(value: string): string {
  if (/['\n\r\0]/.test(value)) throw new Error("a native host path may not hold a quote or a line break");
  return `'${value}'`;
}

/** The shim's command line as Chrome's child runs it, before the origin argument: the service tells its own shim by it. */
export function shimArgv(o: { node?: string; bin?: string } = {}): string[] {
  return [o.node ?? process.execPath, ...NODE_FLAGS, o.bin ?? BIN, "host"];
}

/** The wrapper's text: the socket and the profile in the environment, then exec of the shim with Chrome's arguments. */
export function wrapperText(o: { socket: string; profile: string; node?: string; bin?: string }): string {
  return "#!/bin/sh\n"
    + `${ENV_SOCKET}=${quoted(o.socket)}\nexport ${ENV_SOCKET}\n`
    + `${ENV_PROFILE}=${quoted(o.profile)}\nexport ${ENV_PROFILE}\n`
    + `exec ${shimArgv(o).map(quoted).join(" ")} "$@"\n`;
}

/** Replace `path` with `data` (mode `mode`, folder 0700): a new file with no link followed, its fsync, a rename. */
function replaceFile(path: string, data: string, mode: number): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!statSync(dir).isDirectory()) throw new Error(`not a folder: ${basename(dir)}`);
  chmodSync(dir, 0o700);
  const tmp = join(dir, `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    try { writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
    chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (e) { rmSync(tmp, { force: true }); throw e; }
}

/**
 * Write the wrapper (mode 0700) and the host manifest (mode 0600, in a 0700 folder) that allows only `receiverId`. A path
 * with a quote or a line break, or an ID that is not 32 letters a to p, is refused, and nothing is written then.
 */
export function writeHostFiles(o: { state: string; profile: string; socket: string; receiverId?: string; node?: string; bin?: string }): { wrapper: string; manifest: string } {
  const id = o.receiverId ?? RECEIVER_ID;
  if (!/^[a-p]{32}$/.test(id)) throw new Error("an extension ID is 32 letters a to p");
  const wrapper = wrapperPath(o.state), manifest = manifestPath(o.profile);
  const text = wrapperText(o);
  quoted(wrapper);
  replaceFile(wrapper, text, 0o700);
  replaceFile(manifest, `${JSON.stringify({ name: NATIVE_HOST_NAME, description: "agent-browser link", path: wrapper, type: "stdio", allowed_origins: [`chrome-extension://${id}/`] }, null, 2)}\n`, 0o600);
  return { wrapper, manifest };
}
