// The keep of the card payments' results (contract C11, the card payment, the keep; C12, `pay_result` and `earlier`;
// board ab-sta.5). The service keeps the result of each payment request of the last 24 hours in `pay-results.json` in
// the folder of `--state-folder`, with mode 0600 (writeJson): the fields of C12's `pay_result` only (the request id, the
// scope, the origin, the state, the text, the time and `alert`), and no value of the card, no order line, no
// description, no URL path and no query. `browser_pay_status` and the `earlier` of `pay_request` read it, so a result
// survives a restart of the service. A file that the service cannot read at its start counts as no file, and the
// service logs the error's kind.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCOPE } from "../../relay/scopes.ts";
import { errorKind, parseJsonBytes, writeJson } from "../lists/files.ts";
import { atFits, originFits } from "../signins/store.ts";
import type { PayState } from "./texts.ts";

export const KEEP_FILE = "pay-results.json";
/** C11: the service keeps each result for 24 hours (a first value). */
export const KEEP_MS = 24 * 3_600_000;
const STATES: readonly string[] = ["paid", "declined", "unknown", "stopped"];

/** One kept result: exactly the fields of C12's `pay_result` (`at` in UTC, ISO 8601). */
export type KeptResult = { id: string; scope: string; origin: string; state: PayState; text: string; at: string; alert: boolean };

/** A time in UTC with no milliseconds (C12's `at` and `expires`: `2026-11-21T14:00:00Z`). */
export const isoTime = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");

const fits = (e: unknown): e is KeptResult => {
  if (e === null || typeof e !== "object" || Array.isArray(e)) return false;
  const x = e as Record<string, unknown>;
  return Object.keys(x).length === 7 && typeof x.id === "string" && /^[0-9a-f]{16}$/.test(x.id) && typeof x.scope === "string" && SCOPE.test(x.scope)
    && originFits(x.origin) && typeof x.state === "string" && STATES.includes(x.state) && typeof x.text === "string" && x.text.length <= 1000
    && typeof x.at === "string" && atFits(x.at) && typeof x.alert === "boolean";
};

export class PayKeep {
  private readonly path: string;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private readonly keepMs: number;
  private entries: KeptResult[] = [];

  constructor(o: { stateFolder: string; log: (line: string) => void; now: () => number; keepMs?: number }) {
    this.path = join(o.stateFolder, KEEP_FILE);
    this.log = o.log;
    this.now = o.now;
    this.keepMs = o.keepMs ?? KEEP_MS;
    this.read();
  }

  private fresh(e: KeptResult): boolean { return this.now() - Date.parse(e.at) < this.keepMs; }

  private read(): void {
    let raw: Buffer;
    try { raw = readFileSync(this.path); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.log(`pay: the keep cannot be read (${errorKind(e)}); the service starts with no earlier result`); return; }
    try {
      const f = parseJsonBytes(raw) as Record<string, unknown>;
      if (f === null || typeof f !== "object" || f.v !== 1 || !Array.isArray(f.results)) throw new SyntaxError("not the keep");
      this.entries = f.results.filter(fits).filter((e) => this.fresh(e));
    } catch (e) { this.log(`pay: the keep cannot be read (${errorKind(e)}); the service starts with no earlier result`); }
  }

  /** Put a result in the keep (it replaces the entry of the same id) and write the file; false when the write failed. */
  put(e: KeptResult): boolean {
    this.entries = [...this.entries.filter((x) => x.id !== e.id && this.fresh(x)), { ...e }];
    try { writeJson(this.path, { v: 1, results: this.entries }); return true; }
    catch (err) { this.log(`pay: the keep cannot be written (${errorKind(err)})`); return false; }
  }

  /** The kept results of the last 24 hours that `which` takes, the newest first. */
  of(which: (e: KeptResult) => boolean): KeptResult[] {
    return this.entries.map((e, i) => ({ e, i })).filter(({ e }) => this.fresh(e) && which(e))
      .sort((a, b) => (a.e.at === b.e.at ? b.i - a.i : a.e.at < b.e.at ? 1 : -1)).map(({ e }) => ({ ...e }));
  }
}
