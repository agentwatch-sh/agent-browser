// The X authority file of the unit's private Xvfb (the self-contained design, section 5.1, the row "Xvfb and its auth
// file"; board ab-v16.94.3; a port of agentwatch's daemon/browser/xauth.py). One FamilyWild MIT-MAGIC-COOKIE-1 entry, in a
// file of mode 0600. A fresh cookie comes at each Xvfb start; it lives only in this file: no argv, environment value or
// log line holds it, and no error text names it.

import { closeSync, constants, fchmodSync, openSync, writeSync } from "node:fs";

export const FAMILY_WILD = 0xffff;
export const AUTH_NAME = "MIT-MAGIC-COOKIE-1";
export const COOKIE_LEN = 16;

const field = (data: Buffer) => { const n = Buffer.alloc(2); n.writeUInt16BE(data.length); return Buffer.concat([n, data]); };

/** The bytes of one entry for `display` with `cookie`. */
export function xauthEntry(display: number, cookie: Buffer): Buffer {
  if (cookie.length !== COOKIE_LEN) throw new Error(`the X cookie must be ${COOKIE_LEN} bytes`);
  const family = Buffer.alloc(2);
  family.writeUInt16BE(FAMILY_WILD);
  return Buffer.concat([family, field(Buffer.alloc(0)), field(Buffer.from(String(display))), field(Buffer.from(AUTH_NAME)), field(cookie)]);
}

/** Write one entry for `display` to `path` (mode 0600, also over a looser file; never through a link). */
export function writeXauthority(path: string, display: number, cookie: Buffer): void {
  const entry = xauthEntry(display, cookie);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, entry);
  } finally { closeSync(fd); }
}
