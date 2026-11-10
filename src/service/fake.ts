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
// key: the rules of `record`, the order of the checks, the snapshot, the state, the `rid` of a pane's seal, the KDF
// bounds, the fields that the service seals, the generation and the removed ids.

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
    off: { agent_text: "The agent browser is not running.", operator_text: "The agent browser is not running. A start on the Browser page starts it." },
  },
  chrome: { kind: "google-chrome", version: "157.0.7000.1-1", pid: 4242 },
  extension_version: "0.3.6",
  update: "current",
  endpoint: { form: "pidfd" },
  mcp: { state: "none", address: null },
  agent_door: "/run/user/1000/agent-browser/cdp.sock",
  sender: {
    id: "bpfkgknpndlpkcffmaaelkfcbpackiip", version: "0.2.0",
    package: { name: "agentwatch-sender-0.2.0.zip", sha256: "8739c76e681f900923b900c9df0ef75cf421d39cabb54650c4b9ad19b6a76d85", base64: "UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==" },
  },
  /** The stored sign-ins' fake values: the pane key's public half, the key.json of a set-up and of a rekey, the sealed part of each seal, and the seal text that the fake takes as a wrong passphrase. */
  sign_ins: {"pane_key":"cVrQRT3DOnPdlN6N+gi5ebA8kiQkgNKRTZnJBCQKb6A=","key":{"v":1,"public":"zsDsPOTLhtSCCNLmY1PEbVxm_rj8wh-mhuQp5BQ-aWs","kdf":{"name":"scrypt","n":131072,"r":8,"p":1,"salt":"XtlD_scc1BSqO7QI6IJgPg"},"wrapped":{"iv":"B4obup7UgkQF8GYX","ct":"ulzZP3n9NFs_aeFAro4mshfMWABrf5Njd1KtGvO6aeh2JS7OTQD6gk5bYGds0ny6","tag":"jk4pUJmfRHDzXStJGojQwA"}},"rekeyed":{"v":1,"public":"zsDsPOTLhtSCCNLmY1PEbVxm_rj8wh-mhuQp5BQ-aWs","kdf":{"name":"scrypt","n":131072,"r":8,"p":1,"salt":"0_XWx6Xj1oofUDswBrKe5g"},"wrapped":{"iv":"a3IUxpg3ws4tUVUs","ct":"2LYZeNUlZUWi5MsrEsMC7KQr63QKCQtq82XLbYT4EESSr3CwcY7YoLyDHafmH3GU","tag":"hNF_MZqahErAHIr8y361MQ"}},"sealed":{"epk":"ZMBmwnJDjDnRw2eALakV-4ADm5h01d-8QojuKofB3Xk","iv":"Thcyq0pYkHTUDuOs","ct":"eAHvzGeS2_22yzFzA0PmMpcQlsq9IU1E6CSLPk3Qe6UUz9EpEOpfjKrmzIVENjj5-j17MODlH2qJjldhKDVc3OvIzSf8l99iSPZgUumLEMJcpZXqnoNTwQu3kr55fim3","tag":"JMg6-BFlhxw7HHdyxOgcnQ"},"wrong_passphrase":"aw1:pGtgeZRgmdvjzNp91_j2Rq09WDtReAOK10feP98eVqJKtzz6it9HeuL4HHJjqxSa1ZOL9j9O3H0tBznJo7Ihs_oaUxPmAuPCfVNRB-FjYP9pq7Dn4w136-v59byT7vKueJqv1saYN3_bGkMdL0nO4AlWk38ZEuPHu8OBzrPsFQQZDdG09Kd1cgnvE_Xas3s79ujqs1fKohwgdo7i-QMfyDlKYId66wiccVjOZTXD3hn6DRpSUIAMwO7mxCB5bY0eBY38HYMMwyVq6ta0OZElU92wr3hNWktbWe41WKxNuYrNUSM1e3197HqVgmr7O_SHGnun_YOpy2zoUj7Urze-JcRW7ppmWwK7XWKCbDtd5LL4hWaqTtOiWeX8J-QCWQnu14LW12giNSlO02WlHDX8fA"},
};
/** The features of the fake's hello: `fake`, and `sign_ins` (it has the stored sign-ins' ops, C12). */
export const FAKE_FEATURES = ["fake", "sign_ins"] as const;
/** The refused line of `--refuse`: the vectors' line of rule 2. */
export const FAKE_REFUSED = refusedRule(2, "its parent is not the MainPID of agentwatch's unit");
// The service's text (stage1c.ts LAUNCH_HELD_TEXT) with the vectors' example error (r6).
const launchRefusal = (scope: string) => `A session named ${scope} ended a moment ago, and the agent browser could not record it (the file of ended scopes cannot be written: ENOSPC). Choose another name, or wait until the agent browser confirms its lists.`;

const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x));

// ---- The stored sign-ins of the fake (C12, "The stored sign-ins") ----
type StoreState = "none" | "locked" | "open";
type SnapRecord = { id: string; gen: unknown; origin: string; by: string };
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
  if (!/^\/[^?#]*$/.test(r.path)) return "path";
  if (!r.send_to.includes(r.origin) || !r.send_to.every(originFits) || new Set(r.send_to).size !== r.send_to.length) return "send_to";
  return null;
}
/** The KDF bounds of a key.json: scrypt, N a power of two from 2^15 to 2^18, r 8, p 1, a salt of 16 bytes. */
function kdfFits(key: Record<string, any>): boolean {
  const k = key.kdf;
  return isObj(k) && k.name === "scrypt" && Number.isSafeInteger(k.n) && k.n >= 2 ** 15 && k.n <= 2 ** 18 && (k.n & (k.n - 1)) === 0 && k.r === 8 && k.p === 1
    && typeof k.salt === "string" && /^[A-Za-z0-9_-]+$/.test(k.salt) && Buffer.from(k.salt, "base64url").length === 16;
}

/** The fake's store: no key and no seal, only the rules of C12 that need none. */
class FakeStore {
  private snap: { key: Record<string, any> | null; records: SnapRecord[] } | null = null;
  private open = false;
  private openPublic: string | null = null;
  private readonly highest = new Map<string, number>();
  private readonly removed = new Set<string>();
  /** Each `rid` of a pane's seal that the fake opened, and when (C12: a rid seen in the last 120 s does not open). */
  private readonly rids = new Map<string, number>();
  private readonly now: () => Date;
  constructor(now: () => Date) { this.now = now; }

  state(): StoreState { return this.open ? "open" : this.snap && this.snap.key !== null ? "locked" : "none"; }
  status() { return { state: this.state(), records: this.snap?.records.length ?? 0, acts: 0, pane_key: FAKE_STATE.sign_ins.pane_key }; }

  private seal(sealed: { rid: string }): boolean {
    const t = this.now().getTime();
    for (const [rid, at] of this.rids) if (t - at > RID_MS) this.rids.delete(rid);
    if (this.rids.has(sealed.rid)) return false;
    this.rids.set(sealed.rid, t);
    return true;
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
    const record = req.record as RecordFields | undefined;
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
    const sealed = req.sealed as { text: string; rid: string } | undefined;
    switch (req.op) {
      case "sign_ins_setup":
        if (this.snap.key !== null || this.open) return err("the store is set up already");
        if (!this.seal(sealed!)) return err("the sealed value cannot be opened");
        this.open = true; this.openPublic = FAKE_STATE.sign_ins.key.public;
        return { data: { key: copy(FAKE_STATE.sign_ins.key) } };
      case "sign_ins_unlock":
        if (this.open) return { data: {} };
        if (this.snap.key === null) return err("the store is not set up");
        if (!this.seal(sealed!)) return err("the sealed value cannot be opened");
        if (!kdfFits(this.snap.key)) return err("the store's key file is not valid");
        if (sealed!.text === FAKE_STATE.sign_ins.wrong_passphrase) return err("the passphrase does not open the store");
        this.open = true; this.openPublic = this.snap.key.public;
        return { data: {} };
      case "sign_ins_rekey":
        if (state === "none" || this.snap.key === null) return err("the store is not set up");
        if (state === "locked") return err("the store is locked");
        if (!this.seal(sealed!)) return err("the sealed value cannot be opened");
        if (!kdfFits(this.snap.key)) return err("the store's key file is not valid");
        if (sealed!.text === FAKE_STATE.sign_ins.wrong_passphrase) return err("the passphrase does not open the store");
        return { data: { key: copy(FAKE_STATE.sign_ins.rekeyed) } };
      case "sign_in_seal":
        if (state === "none") return err("the store is not set up");
        if (state === "locked") return err("the store is locked");
        if (!this.seal(sealed!)) return err("the sealed value cannot be opened");
        if (this.removed.has(record!.id)) return err("the stored sign-in was removed");
        return req.offer === true ? this.sealed(record!, "offer", false) : this.sealed(record!, "operator", true);
      case "sign_in_reseal": {
        if (state === "none") return err("the store is not set up");
        if (state === "locked") return err("the store is locked");
        const old = this.snap.records.find((x) => x.id === record!.id);
        if (!old) return err("there is no stored sign-in with this id");
        if (old.origin !== record!.origin) return err("a change of the origin needs a new seal of the password");
        const gen = old.gen;
        if (typeof gen !== "number" || !Number.isSafeInteger(gen) || gen < 1 || gen < (this.highest.get(old.id) ?? 0) || this.removed.has(old.id)) return err("the stored sign-in cannot be opened");
        return this.sealed(record!, old.by === "offer" ? "offer" : "operator", true);
      }
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
  private sessions: { scope: string; repo: string | null }[] = [];
  private box = { hosts: [] as string[], cookie_names: [] as string[] };
  private readonly held = new Set<string>();
  private lastStop: { reason: string; at: string; by: By | null } | null = null;
  private readonly store: FakeStore;

  constructor(o: { agentDoor?: string; now?: () => Date }) {
    this.agentDoor = o.agentDoor ?? FAKE_STATE.agent_door;
    this.now = o.now ?? (() => new Date());
    this.store = new FakeStore(this.now);
    this.hello = serviceHello(packageInfo().version, null, FAKE_FEATURES);
  }

  attach(emit: (ev: Record<string, unknown>) => void): void { this.emit = emit; }
  has(): boolean { return true; }

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
      sessions: this.sessions.map((s) => ({ scope: s.scope, repo: s.repo, list: this.listOf(s.repo) })),
      lists: [...this.lists.keys()], last_stop: this.lastStop === null ? null : copy(this.lastStop), prompts: copy(this.prompts),
      sign_ins: this.store.status(),
    };
  }

  handle(req: Req): Answer {
    const prompt = () => this.prompts.find((p) => p.id === req.prompt);
    switch (req.op) {
      case "config": return { data: {} };
      case "set_sessions":
        this.sessions = (req.sessions as { scope: string; repo: string | null }[]).map((s) => ({ scope: s.scope, repo: s.repo }));
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
      case "sign_ins_setup": case "sign_ins_unlock": case "sign_ins_lock": case "sign_ins_rekey": case "sign_in_seal": case "sign_in_reseal": case "sign_ins": {
        const before = this.store.state();
        const a = this.store.handle(req);
        const after = this.store.state();
        if (after !== before) this.emit({ t: "ev", ev: "sign_ins", state: after, pane_key: FAKE_STATE.sign_ins.pane_key });
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
export async function startFake(o: { controlDoor: string; agentDoor?: string; refuse?: boolean; input?: Readable; log: (line: string) => void; refusedFolders?: string[] }): Promise<{ door: ControlDoor; stop: () => Promise<void> }> {
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
  const door = await ControlDoor.open({
    path: o.controlDoor, handler: new FakeService({ agentDoor: o.agentDoor }), log: o.log,
    admit: o.refuse ? async () => ({ ok: false, reason: FAKE_REFUSED }) : async () => ({ ok: true }),
  });
  const lines = o.input ? createInterface({ input: o.input, crlfDelay: Infinity }) : null;
  lines?.on("line", (line) => {
    let ev: unknown;
    try { ev = JSON.parse(line); } catch { ev = null; }
    if (eventFits(ev)) door.emit(ev as Record<string, unknown>);
    else o.log("fake: dropped a line of its standard input that is not an event of C12");
  });
  o.log(`fake: ready on ${o.controlDoor} (agent-browser service --fake; no Chrome)`);
  return { door, stop: async () => { lines?.close(); await door.stop(); } };
}
