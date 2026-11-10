// The fake service, `agent-browser service --fake` (contract C12, "The fake service"; the daemon lead's C10; board
// ab-v16.94.2): the control door with the scripted state of the vectors (the `state` of test/vectors/control.json,
// which FAKE_STATE equals: a test checks it) and no Chrome, for agentwatch's hermetic tests. It has every op of C12,
// and it gives each request vector its answer when the vectors run in their order on one connection.
//
// It admits each connection that reaches its socket (mode 0600 in a folder of mode 0700): it holds no list, no
// sign-in, no Chrome and no data of the user. It refuses the default path of control.sock, so it never takes the place
// of the service. Each line on its standard input that is an event of C12's table, with exactly its fields, goes to
// each connection past the hellos.

import { mkdirSync, realpathSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { covers, normalizeEntry } from "../relay/scopes.ts";
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
    id: "bpfkgknpndlpkcffmaaelkfcbpackiip", version: "0.3.6",
    package: { name: "agentwatch-sender-0.3.6.zip", sha256: "8739c76e681f900923b900c9df0ef75cf421d39cabb54650c4b9ad19b6a76d85", base64: "UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==" },
  },
};
/** The refused line of `--refuse`: the vectors' line of rule 2. */
export const FAKE_REFUSED = refusedRule(2, "its parent is not the MainPID of agentwatch's unit");
const launchRefusal = (scope: string) => `A session named ${scope} ended a moment ago, and the agent browser still closes its tabs. Try the launch again in a few seconds.`;

const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x));
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

  constructor(o: { agentDoor?: string; now?: () => Date }) {
    this.agentDoor = o.agentDoor ?? FAKE_STATE.agent_door;
    this.now = o.now ?? (() => new Date());
    this.hello = serviceHello(packageInfo().version, null, ["fake"]);
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
    for (const e of add) {
      const n = normalizeEntry(e);
      if (n === null) refused.push({ entry: e, reason: "not a host name" });
      else allow.add(n);
    }
    for (const e of remove) { allow.delete(e); const n = normalizeEntry(e); if (n !== null) allow.delete(n); }
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
