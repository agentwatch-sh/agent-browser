// `agent-browser service`, stage 1a of the self-contained agent browser (the design
// docs/superpowers/specs/2026-11-09-self-contained-agent-browser-design.md, sections 5, 7.1 and 13.1; contract C12,
// docs/contracts/C12.md; board ab-v16.94.2). One process with two doors: the agent door (today's CDP endpoint with
// today's peer check, agent-door.ts) and the control door (control.sock, control.ts, with the admission of
// admission.ts). Off by default: nothing starts it before stage 2, and no install step of this repository writes a unit
// for it. Stage 1a has no Chrome, no list and no MCP: it has the ops config, set_sessions, session_ended, status and
// endpoint, and it answers each other op of C12 `unsupported` until the stage that adds it (C12, "The ops of stage 1a").
// Each later part adds its ops to the op table through ServicePart: stage 1b part 1 (board ab-v16.94.3) adds the Chrome
// unit and its owner rule (src/service/unit/part.ts) with the ops start and stop (C12, "The ops of stage 1b part 1").

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PeerGate } from "../relay/peer.ts";
import { agentDoorPeerCheck, agentDoorUrl, endpointState, openAgentDoor, type AgentDoor, type EndpointState } from "./agent-door.ts";
import { daemonAdmission, loadPidfdOpen, systemdMainPid } from "./admission.ts";
import { ControlDoor, ERR, serviceHello, type Answer, type Handler, type Req } from "./control.ts";
import { realDisplayFs } from "./unit/display.ts";
import { GoogleChromeTools, which, type ChromeTools } from "./unit/google-chrome.ts";
import { Owner, type UnitStateReader } from "./unit/owner.ts";
import { UnitPart, type UnitPartOptions } from "./unit/part.ts";
import type { UnitDeps } from "./unit/unit.ts";
import type { UnitPaths } from "./unit/paths.ts";
import { Procs } from "./unit/procs.ts";

export { serviceHello };

/** The ops of stage 1a (C12, "The ops of stage 1a"). */
export const STAGE_1A_OPS = ["config", "set_sessions", "session_ended", "status", "endpoint"] as const;
/** The ops of each later part of the service (C12, "The ops of stage 1a" and the parts after it): a part adds its ops through ServicePart. */
export const PART_OPS: Readonly<Record<string, readonly string[]>> = {
  "1b1": ["start", "stop"],
};
/** Each op of C12 that no part of this service has yet, and the stage that adds it; until then it gets `unsupported`. */
export const LATER_OPS: Readonly<Record<string, "1b2" | "1c">> = {
  sender: "1b2",
  launch_check: "1c", list_set: "1c", prompt_allow: "1c", prompt_dismiss: "1c", import: "1c", lists_get: "1c", prompts_get: "1c",
};

/** An op of a part: its answer now, or later (a start, a stop). */
export type Op = (req: Req) => Answer | Promise<Answer>;
/**
 * A part of the service after stage 1a (the Chrome unit of stage 1b part 1: src/service/unit/part.ts). Each part adds
 * its ops to the op table, its keys to `status`, and hears each `config` and `set_sessions`.
 */
export interface ServicePart {
  readonly ops?: Readonly<Record<string, Op>>;
  /** The keys of `status` that this part gives, over stage 1a's. */
  status?(): Record<string, unknown>;
  /** After each `config`, with agentwatch's browser.* keys. */
  onConfig?(keys: Record<string, unknown>): void;
  /** After each `set_sessions`. */
  onSessions?(): void;
  attach?(emit: (ev: Record<string, unknown>) => void): void;
}
/** The texts of stage 1a's one state, `off` (I2: the agent's text names no stop and no start). */
export const STAGE_1A_TEXTS = {
  agent_text: "The agent browser is not running.",
  operator_text: "The agent browser is not running: this agent-browser service has no Chrome yet (stage 1a of the self-contained agent browser).",
} as const;
/** At most this many ended scopes are kept in memory (the oldest goes first). */
const ENDED_MAX = 4096;

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const HEX40 = /^[0-9a-f]{40}$/;

/**
 * The commit that this checkout runs, for the hello (C12: for the daemon's pin check only, never for trust): the name of
 * a folder that is a 40-hex commit (agentwatch installs each pin at tools/agent-browser/<commit>, with no .git), else the
 * HEAD of a git checkout or worktree (read from its files, with no git process), else null.
 */
export function commitOf(root: string): string | null {
  const name = basename(resolve(root));
  if (HEX40.test(name)) return name;
  try {
    let gitdir = join(root, ".git");
    if (statSync(gitdir).isFile()) {
      const m = /^gitdir: (.+)$/m.exec(readFileSync(gitdir, "utf8"));
      if (!m) return null;
      gitdir = resolve(root, m[1].trim());
    }
    const head = readFileSync(join(gitdir, "HEAD"), "utf8").trim();
    if (HEX40.test(head)) return head;
    const ref = /^ref: (refs\/[A-Za-z0-9._/-]+)$/.exec(head)?.[1];
    if (!ref || ref.includes("..")) return null;
    let common = gitdir;
    try { common = resolve(gitdir, readFileSync(join(gitdir, "commondir"), "utf8").trim()); } catch {}
    for (const dir of [gitdir, common]) {
      try { const c = readFileSync(join(dir, ref), "utf8").trim(); if (HEX40.test(c)) return c; } catch {}
    }
    for (const line of readFileSync(join(common, "packed-refs"), "utf8").split("\n")) {
      const [sha, refName] = line.trim().split(" ");
      if (refName === ref && HEX40.test(sha)) return sha;
    }
  } catch {}
  return null;
}

/** This package's version (package.json) and the commit that it runs. */
export function packageInfo(): { version: string; commit: string | null } {
  return { version: JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version, commit: commitOf(ROOT) };
}

/** The default path of control.sock (C12, the door): $XDG_RUNTIME_DIR/agent-browser/ on Linux, ~/.cache/agent-browser/run/ on the Mac; null with no run folder. */
export function defaultControlDoor(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string | null {
  if (platform === "darwin") return join(home, ".cache", "agent-browser", "run", "control.sock");
  const run = env.XDG_RUNTIME_DIR;
  return run && isAbsolute(run) ? join(run, "agent-browser", "control.sock") : null;
}

type Session = { scope: string; repo: string | null; roots: { pid: number; start: number }[]; cgroup: string | null; lifetime_id: string | null };

/** The ops of stage 1a, with the service's state in memory. */
export class Stage1a implements Handler {
  readonly hello: Record<string, unknown>;
  private readonly agentDoor: { url(scope: string): string; state(): EndpointState };
  /** agentwatch's browser.* keys of the last `config` (stage 1a keeps them: no Chrome uses them yet). */
  config: Record<string, unknown> | null = null;
  private sessions: Session[] = [];
  /** The ended scopes, in memory only (stage 1c adds the ended file and launch_check). */
  readonly ended = new Set<string>();

  /** The parts after stage 1a, in order, and their op table. */
  private readonly parts: readonly ServicePart[];
  private readonly ops = new Map<string, Op>();

  constructor(o: { agentDoor: { url(scope: string): string; state(): EndpointState }; hello?: Record<string, unknown>; parts?: readonly ServicePart[] }) {
    this.agentDoor = o.agentDoor;
    const { version, commit } = packageInfo();
    this.hello = o.hello ?? serviceHello(version, commit, []);
    this.parts = o.parts ?? [];
    for (const p of this.parts) for (const [name, op] of Object.entries(p.ops ?? {})) this.ops.set(name, op);
  }

  has(op: string): boolean { return (STAGE_1A_OPS as readonly string[]).includes(op) || this.ops.has(op); }

  endpointState(): EndpointState { return this.agentDoor.state(); }

  attach(emit: (ev: Record<string, unknown>) => void): void { for (const p of this.parts) p.attach?.(emit); }

  /** A complete set_sessions came (the fail-closed watch's sessions_unread). */
  get sessionsComplete(): boolean { return this.sessionsRead; }
  private sessionsRead = false;

  status(): Record<string, unknown> {
    return Object.assign({
      state: "off", ...STAGE_1A_TEXTS,
      chrome_kind: null, chrome_version: null, chrome_pid: null, extension_version: null, update: null,
      endpoint: this.agentDoor.state(), mcp: { state: "none", address: null },
      sessions: this.sessions.map((s) => ({ scope: s.scope, repo: s.repo, list: null })), lists: [], last_stop: null, prompts: [],
    }, ...this.parts.map((p) => p.status?.() ?? {}));
  }

  handle(req: Req): Answer | Promise<Answer> {
    const op = this.ops.get(req.op);
    if (op) return op(req);
    switch (req.op) {
      case "config": {
        const { t, id, op, by, ...keys } = req;
        this.config = keys;
        for (const p of this.parts) p.onConfig?.(keys);
        return { data: {} };
      }
      case "set_sessions":
        this.sessions = (req.sessions as Session[]).map((s) => ({ scope: s.scope, repo: s.repo, roots: s.roots.map((r) => ({ pid: r.pid, start: r.start })), cgroup: s.cgroup, lifetime_id: s.lifetime_id }));
        this.sessionsRead = true;
        for (const p of this.parts) p.onSessions?.();
        return { data: {} };
      case "session_ended": {
        const scope = req.scope as string;
        this.sessions = this.sessions.filter((s) => s.scope !== scope);
        this.ended.delete(scope);
        this.ended.add(scope);
        if (this.ended.size > ENDED_MAX) this.ended.delete(this.ended.values().next().value!);
        return { data: {} };
      }
      case "status": return { data: this.status() };
      case "endpoint":
        // A scope that the service does not have (no session of the last set_sessions, or it ended): no URL (C12).
        if (!this.sessions.some((s) => s.scope === req.scope)) return { error: ERR.noSession };
        return { data: { url: this.agentDoor.url(req.scope as string) } };
      default: return { error: ERR.unsupported };
    }
  }
}

/** The Chrome unit of stage 1b part 1 (src/service/unit/): its folders, the reader of the service's own unit state, and the test seams. */
export type UnitOptions = {
  paths: UnitPaths;
  /** The owner rule's reader (systemd, or `--test`'s). */
  owner: UnitStateReader;
  tools?: ChromeTools;
  procs?: Procs;
  /** Tests and `--test`: the part's other options; `unit` adds to the unit's real displays, processes and programs. */
  part?: Partial<Omit<UnitPartOptions, "unit">> & { unit?: Partial<UnitDeps> };
};

export type ServiceOptions = {
  /** The agent door's address (--agent-door): in stage 1a a Unix socket path. */
  agentDoor: string;
  /** The path of control.sock (--control-door). */
  controlDoor: string;
  /** agentwatch's unit, whose MainPID rule 1 reads (--daemon-unit; default agentwatch.service). */
  daemonUnit?: string;
  /** The file of the daemon's expected command (--daemon-command). */
  daemonCommand: string;
  log: (line: string) => void;
  /** Tests only: the MainPID in place of the user's systemd. */
  mainPid?: () => Promise<number | null>;
  /** The Chrome unit (stage 1b part 1). Without it the service has stage 1a's ops only. */
  unit?: UnitOptions;
};
/** `lost` resolves with the reason when the owner rule says that the service no longer owns: the service then stops. */
export type Service = { control: ControlDoor; agent: AgentDoor; state: Stage1a; part: UnitPart | null; lost: Promise<string>; stop: () => Promise<void> };

/** The service does not own the Chrome unit at its start (the design, section 13.2): it exits, and the daemon owns. */
export class NotOwnerAtStart extends Error {}

/**
 * Start the service: the peer check's self-test (the relay's, next to the agent door), the control door with its
 * admission, then the agent door with the same peer reader. A self-test that fails makes both doors fail closed.
 */
export async function startService(o: ServiceOptions): Promise<Service> {
  const t = await agentDoorPeerCheck(o.agentDoor);
  o.log("failed" in t ? `service: the peer check cannot run: ${t.failed}` : `service: the peer check runs (${t.reader.form})`);
  const gate = "failed" in t ? new PeerGate({ failed: t.failed }) : new PeerGate({ reader: t.reader });
  const pidfd = await loadPidfdOpen();
  let agent: AgentDoor | null = null;
  // The Chrome unit (stage 1b part 1) and its owner rule: built now, begun only after the owner rule said yes.
  const owner = o.unit ? new Owner(o.unit.owner, o.log) : null;
  let state!: Stage1a;
  const part = o.unit && owner ? new UnitPart({
    paths: o.unit.paths, procs: o.unit.procs ?? new Procs(), owner, log: o.log,
    tools: o.unit.tools ?? new GoogleChromeTools({ tools: o.unit.paths.tools, log: o.log }),
    endpoint: () => endpointState(gate), sessionsComplete: () => state.sessionsComplete,
    activity: { clients: () => (agent?.clients() ?? 0) > 0 },
    ...o.unit.part,
    unit: { displayFs: realDisplayFs(() => (o.unit!.procs ?? new Procs()).netUnix()), which: (n) => which(n), ...o.unit.part?.unit },
  }) : null;
  state = new Stage1a({ agentDoor: { url: (scope) => agentDoorUrl(o.agentDoor, scope), state: () => endpointState(gate) }, parts: part ? [part] : [] });
  const unit = o.daemonUnit ?? "agentwatch.service";
  // The control door opens first, before the agent door and before any Chrome start (the design's build note 8).
  const control = await ControlDoor.open({
    path: o.controlDoor, handler: state, log: o.log,
    admit: daemonAdmission({ reader: "failed" in t ? { failed: t.failed } : t.reader, pidfd, mainPid: o.mainPid ?? (() => systemdMainPid(unit)), commandFile: o.daemonCommand }),
  });
  // The owner rule at the start: a service runs only to own (the design, section 13.2). The agent door is an owner part.
  if (owner && !(await owner.check("the service's start"))) {
    await control.stop();
    throw new NotOwnerAtStart(`the service does not own the Chrome unit, so it exits: ${await owner.lost}`);
  }
  try { agent = await openAgentDoor({ address: o.agentDoor, gate, log: o.log }); }
  catch (e) { await control.stop(); throw e; }
  const door = agent;
  if (part) await part.begin();
  o.log(`service: ready (pid ${process.pid}; ${part ? "the Chrome unit runs" : "stage 1a: no Chrome"})`);
  let stopping: Promise<void> | undefined;
  return {
    control, agent: door, state, part, lost: owner ? owner.lost : new Promise<string>(() => {}),
    stop: () => stopping ??= (async () => { await part?.stop(); await control.stop(); await door.stop(); o.log("service: stopped"); })(),
  };
}
