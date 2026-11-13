// The fake service, `agent-browser service --fake` (contract C12, "The fake service"; the daemon lead's C10; board
// ab-v16.94.2): the control door with the scripted state of the vectors (the `state` of test/vectors/control.json,
// which FAKE_STATE equals: a test checks it) and no Chrome, for agentwatch's hermetic tests. It has every op of C12,
// and it gives each request vector its answer when the vectors run in their order on one connection.
//
// It admits each connection that reaches its socket (mode 0600 in a folder of mode 0700): it holds no list, no
// sign-in, no Chrome and no data of the user. It refuses the default path of control.sock, so it never takes the place
// of the service. Each line on its standard input that is an event of C12's table, with exactly its fields, goes to
// each connection past the hellos.
//
// Its stored sign-ins (the feature sign_ins; C12, "The stored sign-ins" and the fake's part; board ab-v16.97.1): it opens
// no seal, makes no key and seals nothing. It answers the vectors' fake values, and it follows each rule that needs no
// key: the rules of `record`, the order of the checks, the snapshot, the state, the form and the `rid` of a pane's seal,
// the key's form and its KDF bounds, the names and ids, the fields that the service seals, the generation, the removed
// ids and "Start again". The vectors' scripted seal texts stand for a wrong passphrase, a short one and a stale seal.
// With `unprotected` (`--unprotected`), it answers as a process where that protection does not hold (review-112 B5).
// The connection tokens (C12; stage 1d, board ab-v16.94.5; the token design, board ab-v16.94.10): the fake's hello has the feature mcp_token, it takes
// each session's mcp_token by the door's field rules, keeps it in memory only, and its status says whether each session
// has a fingerprint (never the fingerprint). It serves no MCP.
// The start and the stop by use (C12; board ab-v16.94.11): its config takes idle_stop_minutes by the service's rule and
// its status gives it; it runs no start and no stop by use (no agent door listens): a test sends `stopped` with the reason
// `idle` on its standard input, which sets its state to off and its last_stop.

import { mkdirSync, realpathSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { covers, SCOPE } from "../relay/scopes.ts";
import { EntryError, hostOrNull, normalizeHost } from "./lists/hosts.ts";
import { refusedRule } from "./admission.ts";
import { agentDoorUrl } from "./agent-door.ts";
import { ControlDoor, ERR, eventFits, serviceHello, type Answer, type By, type Handler, type Req } from "./control.ts";
import { packageInfo } from "./service.ts";
import { atFits } from "./signins/store.ts";
import { IDLE_STOP_DEFAULT_MINUTES, idleStopMinutes } from "./unit/part.ts";

/** A prompt's recipient: a session that a block stopped, with the lifetime id of that run (null: the session had none). */
type Recipient = { session: string; lifetime_id: string | null };
type Prompt = { id: string; host: string; list: string; repo: string | null; scopes: string[]; from: string | null; warnings: string[]; recipients: Recipient[] };
type List = { name: string; repo: string | null; allow: string[]; error: string };

/** The vectors' state (test/vectors/control.json, `state`): the fake's state at its start. */
export const FAKE_STATE = {
  prompts: [
    { id: "p1", host: "login.example", list: "owner-repo", repo: "owner/repo", scopes: ["web-1"], from: "app.example", warnings: [], recipients: [{ session: "web-1", lifetime_id: "lt-1a2b" }] },
    { id: "p2", host: "cdn.example", list: "owner-repo", repo: "owner/repo", scopes: ["web-1", "web-2"], from: null, warnings: [], recipients: [{ session: "web-1", lifetime_id: "lt-1a2b" }, { session: "web-2", lifetime_id: null }] },
  ] as Prompt[],
  lists: [{ name: "owner-repo", repo: "owner/repo", allow: ["a.example", "old.example"], error: "" }] as List[],
  old_allow: [] as string[],
  state: "ready",
  texts: {
    ready: { agent_text: "The agent browser is ready.", operator_text: "The agent browser is ready." },
    off: { agent_text: "The agent browser is not running; it gets ready when an agent uses it.", operator_text: "The agent browser is not running. It starts at the next use by an agent." },
  },
  chrome: { kind: "google-chrome", version: "157.0.7000.1-1", pid: 4242 },
  extension_version: "0.3.8",
  update: "current",
  endpoint: { form: "pidfd" },
  mcp: { state: "none", address: null },
  agent_door: "/run/user/1000/agent-browser/cdp.sock",
  sender: {
    id: "bpfkgknpndlpkcffmaaelkfcbpackiip", version: "0.2.0",
    package: { name: "agentwatch-sender-0.2.0.zip", sha256: "8739c76e681f900923b900c9df0ef75cf421d39cabb54650c4b9ad19b6a76d85", base64: "UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==" },
  },
  /**
   * The stored sign-ins' fake values: the pane key's public half (the vectors' test pane key), the key.json of a set-up and
   * of a rekey, the sealed part of each seal, and the seal texts that the fake takes as a wrong passphrase, as a new
   * passphrase of fewer than 16 characters (short_passphrase in a set-up; short_rekey in a rekey, with an old one that does
   * not open the store), and as a seal more than 120 s old.
   */
  sign_ins: {"pane_key":"NVNMwi+i+u1CSlQGjVuVoit8Dj2cx5Cu70dE21bRi18=","key":{"v":1,"public":"zsDsPOTLhtSCCNLmY1PEbVxm_rj8wh-mhuQp5BQ-aWs","kdf":{"name":"scrypt","n":131072,"r":8,"p":1,"salt":"XtlD_scc1BSqO7QI6IJgPg"},"wrapped":{"iv":"B4obup7UgkQF8GYX","ct":"ulzZP3n9NFs_aeFAro4mshfMWABrf5Njd1KtGvO6aeh2JS7OTQD6gk5bYGds0ny6","tag":"jk4pUJmfRHDzXStJGojQwA"}},"rekeyed":{"v":1,"public":"zsDsPOTLhtSCCNLmY1PEbVxm_rj8wh-mhuQp5BQ-aWs","kdf":{"name":"scrypt","n":131072,"r":8,"p":1,"salt":"0_XWx6Xj1oofUDswBrKe5g"},"wrapped":{"iv":"a3IUxpg3ws4tUVUs","ct":"2LYZeNUlZUWi5MsrEsMC7KQr63QKCQtq82XLbYT4EESSr3CwcY7YoLyDHafmH3GU","tag":"hNF_MZqahErAHIr8y361MQ"}},"sealed":{"epk":"ZMBmwnJDjDnRw2eALakV-4ADm5h01d-8QojuKofB3Xk","iv":"Thcyq0pYkHTUDuOs","ct":"eAHvzGeS2_22yzFzA0PmMpcQlsq9IU1E6CSLPk3Qe6UUz9EpEOpfjKrmzIVENjj5-j17MODlH2qJjldhKDVc3OvIzSf8l99iSPZgUumLEMJcpZXqnoNTwQu3kr55fim3","tag":"JMg6-BFlhxw7HHdyxOgcnQ"},"wrong_passphrase":"aw1:C6g5hjOFwp1bbijVem9lEHB1LoLEb1Pu0Z2bqVZWBHI98p2UrXBQ_52rnFG0Gv1iTnczikWDP97nVFtMbJOXhmm5BdXVqRw_16s1-4ti6r5TVD9NS3McB0Z0vBUigyDqJbUsVqB-9VCiJM4eKon_8achAwTAS_m5A-g8BDcYGSA4w441aIQ3M9hJo9Loyhl_tAEFSoQ1QyBEmT6Lfl3gM0UtJMndFW5tJv8PMKEv1u9_d26beGQippwKn6KRTjOac_UrDjWdHOwtboB7FpKFIpqsuvnDk-2pEvWdLlP0PKWCtzUEqhPqSDHjdAieGyj290vISoSDrmxlAosKoVE-zG05F5JVgw8aHnLW6UdB_6a5E4J0acu58u1reALwM7imYcMV0684QGQVGtmFYITjj8brAeJuOCBaweDm6ydlqxBN_zMFVVn-Ic-tq0JNC-ju","short_passphrase":"aw1:UergxM4WIU2ShOnAxGRQUgBEkY4VOaAR-9tQS5cBxgh7shVHu8xjA4tZa7ZyrCgMjZM4Rv0LXpPgc6_YSw2fkid6K1orrAQRpxZKUtTqFU7j8zd7haGhrH1XmiPCTMepeyTKwaGfcpUVARt-8DkSpAAkh9bB-svX3B9Jsbp7FTUaRmG6nnD-Itz9e2_N4hTc6WRMZq23DbTvBVT1jpgq7rqwJj0dObIybsDj60qswLho41Nn3IGwRbfNedlxA-_a-P1S5ya80dkrc3ecWAVUytm-6PC5CPv5okggBXb5k3wg9z0GKbMd6YJSYRBHQmUd3rCtgT9hwBBCv_rE_zs2VKOQYostkU5Zv8aFu-zwW7YGb-GBMRHcyLz0OGalch74OEbS6o1BEbS3Dgv_4r3-0G-M2ZB0ZxBPjOl6wHTeG3OEWl89XcO7tr38d0n2mv58","stale_seal":"aw1:otQWW7UPImaX-FTkb5UmppB5TsPEPVScgTRtL_VtqiZ-X4UJgKNNNIcJD-nEd5hpPY7mo02oBLiqtk4R2AEHfT3cLpizPcL_9dEfl2gcxupn0rZjjGaDNwLp6uLZx4oReCTiNVY54yuG-NlEDkvxb7gKGreMWLJVGgysfhJoTzecZYUFCE2Qo0M-maf0QGz7ghUJ0GHHhN6Z99LxuuNCMZNMp5vVgbyAXlh88jY-CZmpfoOgRk_jDBQgwPbAyTyLUHf1Vkb6KjZqauYxH1_h4lQi6VEQ0pcTnrQeFRcFElbdTFaez1Gq3kDjYLF499GQ6Fez--fnt9UwC_82BsRYC_8h72Fgnfn_N6EuhCKlupaHHRl7lujtakxM9YMfmNKVu0IvvZsXuUg3SMjee74B0ZSRLePsqJsBtXxpSxu2XOKwNTfYHHUYh_seDVSO8kxi","short_rekey":"aw1:duL1W8qVl5Boe0jgmWN6d-mrDhzGhXPTLZUWTfyvTV-mc6dUM8F3CkmxCXQmTKjrxa-g5wHIvCCeCofN-YtGnUWqQGDZdtNG1yTRkzq_C5OvD99vWiOY6-l66W3wMct3BRuPq8CBiI0G2ucsrYOMn8-P0_1Hqx1WJfOmZv4IoBE6j74I_y0SgmwAcnpQZX0kPKldZeWesjjZQnO3BREYs5EemwRcEmGsrMBnJERM4r0K-hj0QVn3JSe_NpAZDjerDB4j_hhPbVdjwWanxnIcM-IMarNFpWC41_cgQb39dcChxEvjua5NJA35M8bMSm_KqZaSebwpTklPTT1JqyiAXgKWuK2iNFFjx7VSv0-3cs-3sgyw9DYkGrYO2LO29hFMs6vUqpsJGHkx9l8KdYFjXq5R8mliq4AXzdJQnq0yLQpiEwIe6nMPBqdTq0wSh5y8"},
};
/** The fake's features (C12, the hello): the fake, the connection tokens' field (the token design), and the
 * stored sign-ins' ops (C12). */
export const FAKE_FEATURES = ["fake", "mcp_token", "sign_ins"] as const;
/** The refused line of `--refuse`: the vectors' line of rule 2. */
export const FAKE_REFUSED = refusedRule(2, "its parent is not the MainPID of agentwatch's unit");
// The service's text (stage1c.ts LAUNCH_HELD_TEXT) with the vectors' example error (r6).
const launchRefusal = (scope: string) => `A session named ${scope} ended a moment ago, and the agent browser could not record it (the file of ended scopes cannot be written: ENOSPC). Choose another name, or wait until the agent browser confirms its lists.`;

const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x));

// ---- The stored sign-ins of the fake (C12, "The stored sign-ins") ----
type StoreState = "none" | "locked" | "open";
type SnapRecord = { id: string; gen: unknown; name: unknown; origin: string; by: string; approved: unknown };
/** The reasons of a protection of the service's memory that does not hold (C12, the protections), in their order. */
export const UNPROTECTED = ["dumpable", "signal"] as const;
export type Unprotected = (typeof UNPROTECTED)[number];
/** The form of a pane's seal's `rid` (C12, the pane's seal); its `at` is atFits's: the form, and a real time. */
const RID = /^[A-Za-z0-9_-]{22,64}$/;
type RecordFields = { id: string; name: string; origin: string; path: string; send_to: string[] };
const RID_MS = 120_000;
const loopback = (h: string) => h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1";
/** `origin`: a URL origin as the WHATWG URL parser gives it, `https:`, or `http:` with a loopback host (for tests). */
function originFits(o: string): boolean {
  if (!URL.canParse(o)) return false;
  const u = new URL(o);
  return u.origin === o && (u.protocol === "https:" || (u.protocol === "http:" && loopback(u.hostname)));
}
/** The first field of `record` that breaks its rule (C12's order), or null. */
function recordBreaks(r: RecordFields): string | null {
  if (!/^c-[0-9a-f]{8}$/.test(r.id)) return "id";
  if (!SCOPE.test(r.name)) return "name";
  if (!originFits(r.origin)) return "origin";
  if (!/^\/[\x20-\x7e]*$/.test(r.path) || /[?#]/.test(r.path)) return "path";
  if (!r.send_to.includes(r.origin) || !r.send_to.every(originFits) || new Set(r.send_to).size !== r.send_to.length) return "send_to";
  return null;
}
/**
 * A key.json that the service takes: `v` 1, a string `public`, an object `wrapped` of the strings iv, ct and tag, and the KDF
 * bounds (scrypt, N a power of two from 2^15 to 2^18, r 8, p 1, a salt of 16 bytes).
 */
function keyFits(key: Record<string, any>): boolean {
  const k = key.kdf, w = key.wrapped;
  return key.v === 1 && typeof key.public === "string" && isObj(w) && ["iv", "ct", "tag"].every((x) => typeof w[x] === "string")
    && isObj(k) && k.name === "scrypt" && Number.isSafeInteger(k.n) && k.n >= 2 ** 15 && k.n <= 2 ** 18 && (k.n & (k.n - 1)) === 0 && k.r === 8 && k.p === 1
    && typeof k.salt === "string" && /^[A-Za-z0-9_-]+$/.test(k.salt) && Buffer.from(k.salt, "base64url").length === 16;
}

/** The fake's store: no key and no seal, only the rules of C12 that need none. */
class FakeStore {
  private snap: { key: Record<string, any> | null; records: SnapRecord[] } | null = null;
  private open = false;
  private openPublic: string | null = null;
  private readonly highest = new Map<string, number>();
  private readonly removed = new Set<string>();
  /**
   * Each `rid` of a pane's seal that the fake took, and the time until which it keeps it (C12): until the seal's `at` is
   * more than 120 s in the past by the fake's clock and at least 120 s after the fake first saw the rid.
   */
  private readonly rids = new Map<string, number>();
  private readonly now: () => Date;
  private readonly unprotected: Unprotected | null;
  constructor(now: () => Date, unprotected: Unprotected | null) { this.now = now; this.unprotected = unprotected; }

  state(): StoreState { return this.open ? "open" : this.snap && this.snap.key !== null ? "locked" : "none"; }
  /** C12's status key: the fake runs no act, so no act and no stopped credential. */
  status() { return { state: this.state(), records: this.snap?.records.length ?? 0, acts: 0, pane_key: FAKE_STATE.sign_ins.pane_key, stopped: [] as string[], unprotected: this.unprotected }; }

  /**
   * The pane's seal: the form of `rid` and `at`, an `at` that is a real time, the vectors' stale seal (whose rid the fake
   * does not take, as the service takes no rid of a seal that its time refuses), then a `rid` that the fake keeps.
   */
  private seal(sealed: { text: string; rid: string; at: string }): boolean {
    if (!RID.test(sealed.rid) || !atFits(sealed.at) || sealed.text === FAKE_STATE.sign_ins.stale_seal) return false;
    const t = this.now().getTime();
    for (const [rid, until] of this.rids) if (t > until) this.rids.delete(rid);
    if (this.rids.has(sealed.rid)) return false;
    this.rids.set(sealed.rid, Math.max(t, Date.parse(sealed.at)) + RID_MS);
    return true;
  }

  /** The set-ups, unlocks and rekeys that have not answered, and the one at a time (the service's queue and its bound). */
  private pending = 0;
  private queue: Promise<unknown> = Promise.resolve();
  /**
   * A set-up, an unlock or a rekey, as the service runs them: one at a time, at most two that wait (one more gets the
   * busy text at once), and the vectors' wrong passphrase answers 2 s after the op's turn began.
   */
  keyOp(req: Req): Answer | Promise<Answer> {
    if (this.pending > 2) return { error: "the store is busy; try again" };
    this.pending++;
    const run = this.queue.then(async () => {
      const started = Date.now();
      const a = this.handle(req);
      if ("error" in a && a.error === "the passphrase does not open the store") await new Promise((r) => setTimeout(r, Math.max(0, 2000 - (Date.now() - started))));
      return a;
    });
    const done = () => { this.pending--; };
    run.then(done, done);
    this.queue = run.catch(() => {});
    return run;
  }

  /** The vectors' seal texts that stand for a new passphrase of fewer than 16 characters (a set-up's and a rekey's). */
  private short(text: string): boolean { return text === FAKE_STATE.sign_ins.short_passphrase || text === FAKE_STATE.sign_ins.short_rekey; }

  /** Another approved record of the last snapshot has this name (C12, names and ids). */
  private nameTaken(id: string, name: string): boolean {
    return (this.snap?.records ?? []).some((x) => x.id !== id && x.name === name && x.approved === true);
  }

  private sealed(r: RecordFields, by: "operator" | "offer", approved: boolean): Answer {
    const gen = (this.highest.get(r.id) ?? 0) + 1;
    this.highest.set(r.id, gen);
    const send_to = by === "offer" && !approved ? [r.origin] : [...r.send_to];
    return { data: { record: { v: 1, id: r.id, gen, name: r.name, origin: r.origin, path: r.path, send_to, repos: null, by, approved }, sealed: copy(FAKE_STATE.sign_ins.sealed) } };
  }

  /** An op of the stored sign-ins after the door's checks (the op, the shape and the kind). */
  handle(req: Req): Answer {
    const err = (error: string): Answer => ({ error });
    // The rules of record, only for the ops that take a record: a side ignores a field that it does not know.
    const record = req.op === "sign_in_seal" || req.op === "sign_in_reseal" ? req.record as RecordFields : undefined;
    if (record) { const f = recordBreaks(record); if (f) return err(`the stored sign-in is not valid (field ${f})`); }
    if (req.op === "sign_ins_lock") { this.open = false; return { data: {} }; }
    if (req.op === "sign_ins") {
      const records = req.records as SnapRecord[];
      const key = req.key as Record<string, any> | null;
      const ids = new Set(records.map((r) => r.id));
      for (const r of this.snap?.records ?? []) if (!ids.has(r.id)) this.removed.add(r.id);
      for (const r of records) if (typeof r.gen === "number" && Number.isSafeInteger(r.gen) && r.gen >= 1 && r.gen > (this.highest.get(r.id) ?? 0)) this.highest.set(r.id, r.gen);
      if (key === null || key.public !== this.openPublic) this.open = false;
      this.snap = { key, records: copy(records) };
      return { data: { records: records.length } };
    }
    if (!this.snap) return err("the stored sign-ins have no snapshot yet");
    const state = this.state();
    const sealed = req.sealed as { text: string; rid: string; at: string } | undefined;
    const S = FAKE_STATE.sign_ins;
    const unprotected = this.unprotected === null ? null : err(`the service's memory is not protected (${this.unprotected})`);
    switch (req.op) {
      case "sign_ins_setup":
        if (this.snap.key !== null || this.open) return err("the store is set up already");
        if (unprotected) return unprotected;
        if (!this.seal(sealed!)) return err("the sealed value cannot be opened");
        if (this.short(sealed!.text)) return err("the passphrase has fewer than 16 characters");
        this.open = true; this.openPublic = S.key.public;
        return { data: { key: copy(S.key) } };
      case "sign_ins_unlock":
        if (this.open) return { data: {} };
        if (this.snap.key === null) return err("the store is not set up");
        if (unprotected) return unprotected;
        if (!this.seal(sealed!)) return err("the sealed value cannot be opened");
        if (!keyFits(this.snap.key)) return err("the store's key file is not valid");
        if (sealed!.text === S.wrong_passphrase) return err("the passphrase does not open the store");
        this.open = true; this.openPublic = this.snap.key.public;
        return { data: {} };
      case "sign_ins_rekey":
        if (state === "none" || this.snap.key === null) return err("the store is not set up");
        if (state === "locked") return err("the store is locked");
        if (!this.seal(sealed!)) return err("the sealed value cannot be opened");
        // The new passphrase's length comes before the old passphrase (and before the key).
        if (this.short(sealed!.text)) return err("the passphrase has fewer than 16 characters");
        if (!keyFits(this.snap.key)) return err("the store's key file is not valid");
        if (sealed!.text === S.wrong_passphrase) return err("the passphrase does not open the store");
        return { data: { key: copy(S.rekeyed) } };
      case "sign_in_seal": {
        if (state === "none") return err("the store is not set up");
        if (state === "locked") return err("the store is locked");
        if (!this.seal(sealed!)) return err("the sealed value cannot be opened");
        const offer = req.offer === true;
        if (this.removed.has(record!.id)) return err("the stored sign-in was removed");
        // An offer gets its own new id, which the fake never saw (in the last sign_ins, or with a gen of a sign_ins or of its
        // own seal); it never changes or replaces a credential (C12, names and ids).
        if (offer && (this.snap.records.some((x) => x.id === record!.id) || this.highest.has(record!.id))) return err("an offer needs a new id");
        if (!offer && this.nameTaken(record!.id, record!.name)) return err("another stored sign-in has this name");
        return offer ? this.sealed(record!, "offer", false) : this.sealed(record!, "operator", true);
      }
      case "sign_in_reseal": {
        if (state === "none") return err("the store is not set up");
        if (state === "locked") return err("the store is locked");
        const old = this.snap.records.find((x) => x.id === record!.id);
        if (!old) return err("there is no stored sign-in with this id");
        if (old.origin !== record!.origin) return err("a change of the origin needs a new seal of the password");
        const gen = old.gen;
        if (typeof gen !== "number" || !Number.isSafeInteger(gen) || gen < 1 || gen < (this.highest.get(old.id) ?? 0) || this.removed.has(old.id)) return err("the stored sign-in cannot be opened");
        if (this.nameTaken(record!.id, record!.name)) return err("another stored sign-in has this name");
        return this.sealed(record!, old.by === "offer" ? "offer" : "operator", true);
      }
      case "sign_in_start_again":
        // The operator's "Start again" (review-112 B4): it needs no state; the fake runs no act, so no credential stops. A
        // removed id is no credential, also when a later sign_ins holds its file again.
        if (!this.snap.records.some((x) => x.id === req.credential) || this.removed.has(req.credential as string)) return err("there is no stored sign-in with this id");
        return { data: {} };
    }
    return err(ERR.unsupported);
  }
}
const isObj = (x: unknown): x is Record<string, any> => x !== null && typeof x === "object" && !Array.isArray(x);
const len = (x: unknown) => (Array.isArray(x) ? x.length : 0);
const keys = (x: unknown) => (isObj(x) ? Object.keys(x).length : 0);

/** C4's import counts of a payload, as the fake would import it (it imports nothing): the box's own sign-in cookies drop. */
function importCounts(payload: Record<string, any>, box: { hosts: string[]; cookie_names: string[] }) {
  const cookies = (Array.isArray(payload.cookies) ? payload.cookies : []).filter((c: any) => !(isObj(c) && box.cookie_names.includes(c.name) && typeof c.domain === "string" && covers(box.hosts, c.domain.replace(/^\./, ""))));
  const storage = isObj(payload.storage) ? payload.storage : {};
  const idb = Array.isArray(storage.idb) ? storage.idb : [];
  const caches = Array.isArray(storage.caches) ? storage.caches : [];
  return {
    cookies_removed: 0, cookies_set: cookies.length, tabs_closed: 0, local: keys(storage.local), session: keys(storage.session),
    idb_databases: idb.length, idb_records: idb.reduce((n: number, db: any) => n + (isObj(db) && Array.isArray(db.stores) ? db.stores.reduce((m: number, s: any) => m + len(isObj(s) ? s.records : null), 0) : 0), 0),
    cache_entries: caches.reduce((n: number, c: any) => n + len(isObj(c) ? c.entries : null), 0), errors: [] as string[],
  };
}

export class FakeService implements Handler {
  readonly hello: Record<string, unknown>;
  private readonly agentDoor: string;
  private readonly now: () => Date;
  private emit: (ev: Record<string, unknown>) => void = () => {};
  private state: "ready" | "off" = FAKE_STATE.state as "ready";
  private prompts: Prompt[] = copy(FAKE_STATE.prompts);
  private readonly lists = new Map<string, List>(copy(FAKE_STATE.lists).map((l) => [l.name, l]));
  /** The sessions of the last set_sessions, each with its fingerprint or null (in memory only; the token design). */
  private sessions: { scope: string; repo: string | null; mcp_token: string | null }[] = [];
  private box = { hosts: [] as string[], cookie_names: [] as string[] };
  private readonly held = new Set<string>();
  private lastStop: { reason: string; at: string; by: By | null } | null = null;
  /** The grace time of the stop by use from the last config (C12; board ab-v16.94.11). */
  private idleStop = IDLE_STOP_DEFAULT_MINUTES;
  private readonly store: FakeStore;

  constructor(o: { agentDoor?: string; now?: () => Date; unprotected?: Unprotected }) {
    if (o.unprotected !== undefined && !UNPROTECTED.includes(o.unprotected)) throw new Error("the fake's unprotected is dumpable or signal");
    this.agentDoor = o.agentDoor ?? FAKE_STATE.agent_door;
    this.now = o.now ?? (() => new Date());
    this.store = new FakeStore(this.now, o.unprotected ?? null);
    this.hello = serviceHello(packageInfo().version, null, FAKE_FEATURES);
  }

  attach(emit: (ev: Record<string, unknown>) => void): void { this.emit = emit; }
  has(): boolean { return true; }

  /**
   * An event that a test sends on the fake's standard input, before it goes out (C12, the fake): a `stopped` with the
   * reason `idle` is a stop by use, so the state is `off` and `last_stop` carries it, with no `by` (review-120 note 7).
   */
  observe(ev: Record<string, unknown>): void {
    if (ev.ev === "stopped" && ev.reason === "idle") {
      this.state = "off";
      this.lastStop = { reason: "idle", at: this.now().toISOString(), by: null };
    }
  }

  /** The state of the last `sign_ins` event: the store starts in `none`, and each change of the state sends one. */
  private told: "none" | "locked" | "open" = "none";
  private tell(): void {
    const state = this.store.state();
    if (state === this.told) return;
    this.told = state;
    this.emit({ t: "ev", ev: "sign_ins", state, pane_key: FAKE_STATE.sign_ins.pane_key });
  }

  private listOf(repo: string | null): string | null {
    for (const l of this.lists.values()) if (repo !== null && l.repo === repo) return l.name;
    return null;
  }

  private listSet(name: string, add: string[], remove: string[]): Answer {
    let l = this.lists.get(name);
    if (!l) this.lists.set(name, (l = { name, repo: null, allow: [], error: "" }));
    const allow = new Set(l.allow);
    const refused: { entry: string; reason: string }[] = [];
    // The service's host rules and their reason texts (stage 1c, lists/hosts.ts).
    for (const e of add) {
      try { allow.add(normalizeHost(e)); } catch (x) { refused.push({ entry: e, reason: (x as EntryError).reason }); }
    }
    for (const e of remove) { allow.delete(e); const n = hostOrNull(e); if (n !== null) allow.delete(n); }
    l.allow = [...allow].sort();
    return { data: { allow: [...l.allow], refused } };
  }

  private close(p: Prompt): void {
    this.prompts = this.prompts.filter((x) => x !== p);
    this.emit({ t: "ev", ev: "prompt", id: p.id, state: "closed", host: p.host, scope: p.scopes[0] ?? null, list: p.list, from: null, warnings: [] });
  }

  private status(): Record<string, unknown> {
    const ready = this.state === "ready";
    const c = FAKE_STATE.chrome;
    return {
      state: this.state, ...FAKE_STATE.texts[this.state],
      chrome_kind: ready ? c.kind : null, chrome_version: ready ? c.version : null, chrome_pid: ready ? c.pid : null,
      extension_version: ready ? FAKE_STATE.extension_version : null, update: FAKE_STATE.update,
      endpoint: copy(FAKE_STATE.endpoint), mcp: copy(FAKE_STATE.mcp),
      sessions: this.sessions.map((s) => ({ scope: s.scope, repo: s.repo, list: this.listOf(s.repo), mcp_token: s.mcp_token !== null })),
      lists: [...this.lists.keys()], last_stop: this.lastStop === null ? null : copy(this.lastStop), prompts: copy(this.prompts),
      sign_ins: this.store.status(), idle_stop_minutes: this.idleStop,
    };
  }

  handle(req: Req): Answer | Promise<Answer> {
    const prompt = () => this.prompts.find((p) => p.id === req.prompt);
    switch (req.op) {
      case "config":
        // The grace time of the stop by use, by the service's rule (C12); the fake runs no stop by use.
        this.idleStop = idleStopMinutes(req.idle_stop_minutes) ?? IDLE_STOP_DEFAULT_MINUTES;
        return { data: {} };
      case "set_sessions":
        this.sessions = (req.sessions as { scope: string; repo: string | null; mcp_token: string | null }[]).map((s) => ({ scope: s.scope, repo: s.repo, mcp_token: s.mcp_token }));
        this.box = { hosts: [...(req.box as any).hosts], cookie_names: [...(req.box as any).cookie_names] };
        this.held.clear();
        return { data: {} };
      case "session_ended":
        this.sessions = this.sessions.filter((s) => s.scope !== req.scope);
        this.held.add(req.scope as string);
        return { data: {} };
      case "launch_check": return { data: { refusal: this.held.has(req.scope as string) ? launchRefusal(req.scope as string) : null } };
      case "list_set": return this.listSet(req.list as string, req.add as string[], req.remove as string[]);
      case "prompt_allow": {
        const p = prompt();
        if (!p || p.host !== req.host || p.list !== req.list) return { error: ERR.gone };
        const a = this.listSet(p.list, [p.host], []);
        this.close(p);
        return a;
      }
      case "prompt_dismiss": {
        const p = prompt();
        if (!p) return { error: ERR.gone };
        this.close(p);
        return { data: {} };
      }
      case "import": return { data: importCounts(req.payload as Record<string, any>, this.box) };
      case "start":
        if (this.state === "off") { this.state = "ready"; this.emit({ t: "ev", ev: "ready", chrome_pid: FAKE_STATE.chrome.pid, chrome_version: FAKE_STATE.chrome.version, extension_version: FAKE_STATE.extension_version, endpoint: copy(FAKE_STATE.endpoint) }); }
        return { data: {} };
      case "stop":
        if (this.state === "ready") {
          this.state = "off";
          this.lastStop = { reason: "stop", at: this.now().toISOString(), by: copy(req.by) };
          this.emit({ t: "ev", ev: "stopped", reason: "stop", by: copy(req.by) });
        }
        return { data: {} };
      case "status": return { data: this.status() };
      case "lists_get":
        return { data: { lists: [...this.lists.values()].map((l) => ({ name: l.name, repo: l.repo, allow: [...l.allow], sessions: this.sessions.filter((s) => s.repo !== null && s.repo === l.repo).map((s) => s.scope), error: l.error })), old_allow: [...FAKE_STATE.old_allow] } };
      case "prompts_get": return { data: { prompts: copy(this.prompts) } };
      case "endpoint":
        if (!this.sessions.some((s) => s.scope === req.scope)) return { error: ERR.noSession };
        return { data: { url: agentDoorUrl(this.agentDoor, req.scope as string) } };
      case "sender": return { data: copy(FAKE_STATE.sender) };
      case "sign_ins_setup": case "sign_ins_unlock": case "sign_ins_rekey": {
        // The service's queue: such an op answers later, and its event goes out after its answer.
        const a = this.store.keyOp(req);
        if (!(a instanceof Promise)) return a;
        return a.finally(() => setImmediate(() => this.tell()));
      }
      case "sign_ins_lock": case "sign_in_seal": case "sign_in_reseal": case "sign_in_start_again": case "sign_ins": {
        const a = this.store.handle(req);
        this.tell();
        return a;
      }
      default: return { error: ERR.unsupported };
    }
  }
}

/**
 * The service's run folders, where the fake never listens (C12, the fake): the folder of the default control.sock,
 * and on Linux also /run/user/<uid>/agent-browser, the default when XDG_RUNTIME_DIR is not set.
 */
export function serviceRunFolders(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform, home = homedir(), uid = process.getuid?.() ?? -1): string[] {
  if (platform === "darwin") return [join(home, ".cache", "agent-browser", "run")];
  const out = [`/run/user/${uid}/agent-browser`];
  const run = env.XDG_RUNTIME_DIR;
  if (run && isAbsolute(run) && !out.includes(join(run, "agent-browser"))) out.push(join(run, "agent-browser"));
  return out;
}

/** The real path of `p` after links: of `p` itself, or of its nearest folder that exists, with the rest of `p`. */
function realOf(p: string): string {
  const rest: string[] = [];
  for (let at = resolve(p); ;) {
    try { return join(realpathSync(at), ...[...rest].reverse()); } catch {}
    const up = dirname(at);
    if (up === at) return resolve(p);
    rest.push(basename(at));
    at = up;
  }
}

/**
 * Start the fake on `controlDoor`, never in a run folder of the service (`refusedFolders`; the default is
 * serviceRunFolders()): its socket's real folder is compared with each one before the fake makes its folder, and
 * again after (by device and inode). `input`: its standard input, whose event lines go to each connection past the
 * hellos. `refuse`: each connection gets FAKE_REFUSED.
 */
export async function startFake(o: { controlDoor: string; agentDoor?: string; refuse?: boolean; unprotected?: Unprotected; input?: Readable; log: (line: string) => void; refusedFolders?: string[] }): Promise<{ door: ControlDoor; stop: () => Promise<void> }> {
  const folders = o.refusedFolders ?? serviceRunFolders();
  const dir = dirname(resolve(o.controlDoor));
  const refuse = () => { throw new Error(`the fake never takes the place of the service: ${dir} is a run folder of the service; give --control-door a path in another folder`); };
  if (folders.some((f) => realOf(f) === realOf(dir))) refuse();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = statSync(dir);
  for (const f of folders) {
    const ft = statSync(f, { throwIfNoEntry: false });
    if ((ft && ft.dev === st.dev && ft.ino === st.ino) || realOf(f) === realpathSync(dir)) refuse();
  }
  const service = new FakeService({ agentDoor: o.agentDoor, unprotected: o.unprotected });
  const door = await ControlDoor.open({
    path: o.controlDoor, handler: service, log: o.log,
    admit: o.refuse ? async () => ({ ok: false, reason: FAKE_REFUSED }) : async () => ({ ok: true }),
  });
  const lines = o.input ? createInterface({ input: o.input, crlfDelay: Infinity }) : null;
  lines?.on("line", (line) => {
    let ev: unknown;
    try { ev = JSON.parse(line); } catch { ev = null; }
    if (eventFits(ev)) { service.observe(ev as Record<string, unknown>); door.emit(ev as Record<string, unknown>); }
    else o.log("fake: dropped a line of its standard input that is not an event of C12");
  });
  o.log(`fake: ready on ${o.controlDoor} (agent-browser service --fake; no Chrome)`);
  return { door, stop: async () => { lines?.close(); await door.stop(); } };
}
