// The request parts of the native link (contract C4 in chrome-extension's docs/protocol.md; board ab-v16.94.9; a port
// of agentwatch's daemon/browser/parts.py). The service cuts each request into slices of PART_BYTES bytes of compact
// UTF-8 JSON and sends each slice base64-encoded, because one native message to the extension may not pass 1 MiB. A
// part names its channel in `ch`: a part without `ch` is channel main; only bridge parts carry "ch":"bridge". The
// receiver joins the slices of one id of one channel in seq order and parses them. JSON.stringify writes a lone UTF-16
// surrogate of a page string as a \udXXX escape, which the receiver's JSON.parse takes back.

/** Bytes of request JSON in one part (before base64). */
export const PART_BYTES = 700_000;

export type Part = { t: "part"; ch?: string; id: string; seq: number; n: number; b64: string };

/** The bytes that the parts of `request` carry: its compact JSON in UTF-8 (a string is taken as that JSON already). */
export const requestBytes = (request: object | string) => Buffer.from(typeof request === "string" ? request : JSON.stringify(request), "utf8");

/** Cut `request` (an object, its compact JSON, or its bytes) into the ordered part messages of `id`; with `ch`, each part names it. */
export function splitParts(id: string, request: object | string | Buffer, ch?: string, size = PART_BYTES): Part[] {
  const raw = Buffer.isBuffer(request) ? request : requestBytes(request);
  const n = Math.max(1, Math.ceil(raw.length / size));
  const out: Part[] = [];
  for (let seq = 0; seq < n; seq++) {
    const b64 = raw.subarray(seq * size, (seq + 1) * size).toString("base64");
    out.push(ch === undefined ? { t: "part", id, seq, n, b64 } : { t: "part", ch, id, seq, n, b64 });
  }
  return out;
}
