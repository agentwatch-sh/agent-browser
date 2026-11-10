// The blocked-site prompts (stage 1c of the self-contained agent browser, board ab-v16.94.4; the design, section 5.1):
// the port of agentwatch's gateway/browser_prompts.py and of the daemon's on_blocked limit. The service owns the
// prompts and their dismissals; the gateway only shows the prompts and sends their Web Push.
//
// - A blocked report (the receiver's `blocked`, C4, or the model's `daemon.blocked`, C10) goes on at most once in
//   BLOCKED_MIN_MS for each host, counted from the last report that went; at most BLOCKED_HOSTS_KEPT hosts are kept.
// - A report makes or changes one prompt for its host and its scope's list, when the scope has a list now (its target),
//   the list does not cover the host, and the operator has not dismissed the host for that list. Its `from` is the
//   report's from host only when the list covers it. Each recipient is the session that the block stopped, with the
//   lifetime id of that run.
// - A prompt closes when one of its scopes no longer has the prompt's list, or the list covers the host now.
// - A dismissal holds DISMISS_S, and outlives a restart: the dismissals file in the state folder (mode 0600) keeps them.
//   Open prompts live in memory only.
//
// The log rule: a log line names a host, never a scope, a URL path or a lifetime id.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { coveredBy, hostOrNull, SCOPE } from "../lists/hosts.ts";
import { parseJsonBytes, writeJson } from "../lists/files.ts";
import { warningsFor, type Warning } from "./rules.ts";

export const MAX_PROMPTS = 20;
export const MAX_DISMISSALS = 500;
export const DISMISS_S = 86_400;
/** One blocked report per host in this time at most (the daemon's BLOCKED_EVENT_MIN_S). */
export const BLOCKED_MIN_MS = 10_000;
export const BLOCKED_HOSTS_KEPT = 256;

/** A blocked navigation: C4's `blocked` from the receiver, or C10's `daemon.blocked` from the model (`from` null). */
export type Blocked = { host: string; scope: string | null; from: string | null };
/** A scope's list now: its name, its repo (null for no-repo) and its hosts. */
export type Target = { name: string; repo: string | null; hosts: readonly string[] };
/** A session that a block stopped, with the lifetime id of that run (null: the session had none). */
export type Recipient = { session: string; lifetime_id: string | null };
export type PromptView = { id: string; host: string; list: string; repo: string | null; scopes: string[]; from: string | null; warnings: Warning[]; recipients: Recipient[] };
/** C12's `prompt` event: no URL path. */
export type PromptEvent = { t: "ev"; ev: "prompt"; id: string; state: "open" | "changed" | "closed"; host: string; scope: string | null; list: string; from: string | null; warnings: Warning[] };

type Prompt = { id: string; host: string; list: string; repo: string | null; scopes: Set<string>; from: string | null; recipients: Recipient[] };

const keyOf = (host: string, list: string) => `${host}\n${list}`;
const sameView = (a: Prompt, b: { scopes: string[]; from: string | null }) => a.from === b.from && [...a.scopes].sort().join("\n") === b.scopes.join("\n");

export type PromptBookOptions = {
  /** The dismissals file (`<state>/prompt-dismissals.json`). */
  file: string;
  /** A monotonic clock in ms, for the per-host limit. */
  now: () => number;
  /** The wall clock in seconds, for the dismissals. */
  wall: () => number;
  log: (line: string) => void;
  /** Tests only: the file's writer. */
  write?: (path: string, value: unknown) => void;
};

export class PromptBook {
  private readonly o: PromptBookOptions;
  private readonly writer: (path: string, value: unknown) => void;
  /** The open prompts by host and list, oldest first (a report moves its prompt to the end). */
  private readonly open = new Map<string, Prompt>();
  /** The dismissals by host and list: their end (wall seconds), oldest first. */
  private dismissed = new Map<string, number>();
  private readonly blockedAt = new Map<string, number>();

  constructor(o: PromptBookOptions) {
    this.o = o;
    this.writer = o.write ?? writeJson;
    this.dismissed = this.loadDismissals();
  }

  private loadDismissals(): Map<string, number> {
    let raw: unknown;
    try { raw = parseJsonBytes(readFileSync(this.o.file)); } catch { return new Map(); }
    const rows: [string, number][] = [];
    const wall = this.o.wall();
    for (const row of Array.isArray(raw) ? raw : []) {
      if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
      const { host, list, until } = row as Record<string, unknown>;
      if (typeof host !== "string" || hostOrNull(host) !== host || typeof list !== "string" || !SCOPE.test(list)) continue;
      if (typeof until !== "number" || !Number.isFinite(until) || until <= wall) continue;
      rows.push([keyOf(host, list), until]);
    }
    rows.sort((a, b) => a[1] - b[1]);
    return new Map(rows.slice(-MAX_DISMISSALS));
  }

  private dismissals(): Map<string, number> {
    const wall = this.o.wall();
    for (const [k, until] of this.dismissed) if (until <= wall) this.dismissed.delete(k);
    return this.dismissed;
  }

  /** The per-host limit of a blocked report: true when the report goes on (and its time is kept). */
  admit(host: string): boolean {
    const now = this.o.now();
    const last = this.blockedAt.get(host);
    if (last !== undefined && now - last < BLOCKED_MIN_MS) return false;
    if (this.blockedAt.size >= BLOCKED_HOSTS_KEPT) {
      for (const [h, t] of this.blockedAt) if (now - t >= BLOCKED_MIN_MS) this.blockedAt.delete(h);
      if (this.blockedAt.size >= BLOCKED_HOSTS_KEPT) return false; // a flood of hosts: the state stays bounded
    }
    this.blockedAt.set(host, now);
    return true;
  }

  /** The number of hosts that the limit keeps now. */
  hostsKept(): number { return this.blockedAt.size; }

  private view(p: Prompt): PromptView {
    return { id: p.id, host: p.host, list: p.list, repo: p.repo, scopes: [...p.scopes].sort(), from: p.from, warnings: warningsFor(p.host), recipients: p.recipients.map((r) => ({ ...r })) };
  }

  private event(p: Prompt, state: "open" | "changed", scope: string): PromptEvent {
    return { t: "ev", ev: "prompt", id: p.id, state, host: p.host, scope, list: p.list, from: p.from, warnings: warningsFor(p.host) };
  }

  private closedEvent(p: Prompt): PromptEvent {
    return { t: "ev", ev: "prompt", id: p.id, state: "closed", host: p.host, scope: [...p.scopes].sort()[0] ?? null, list: p.list, from: null, warnings: [] };
  }

  /**
   * One blocked report: the limit, the log line, then the prompt of its host and its scope's list. `targetOf` gives a
   * scope's list now (null: none); `recipientOf` the session of a scope with the lifetime id of its run now. The events
   * that the report makes.
   */
  blocked(b: Blocked, targetOf: (scope: string) => Target | null, recipientOf: (scope: string) => Recipient | null): PromptEvent[] {
    const host = hostOrNull(b.host);
    if (host === null || !this.admit(host)) return [];
    this.o.log(`prompts: blocked a navigation to ${host}`);
    const scope = b.scope;
    if (typeof scope !== "string") return [];
    const target = targetOf(scope);
    if (target === null || coveredBy(target.hosts, host)) return [];
    const key = keyOf(host, target.name);
    if (this.dismissals().has(key)) return [];
    let p = this.open.get(key);
    const fresh = p === undefined;
    if (p === undefined) p = { id: randomBytes(16).toString("hex"), host, list: target.name, repo: target.repo, scopes: new Set(), from: null, recipients: [] };
    this.open.delete(key);
    this.open.set(key, p);
    const before = { scopes: [...p.scopes].sort(), from: p.from };
    p.scopes.add(scope);
    const from = hostOrNull(b.from);
    p.from = from !== null && coveredBy(target.hosts, from) ? from : null;
    const r = recipientOf(scope);
    if (r !== null && !p.recipients.some((x) => x.session === r.session && x.lifetime_id === r.lifetime_id)) p.recipients.push({ session: r.session, lifetime_id: r.lifetime_id });
    const out: PromptEvent[] = [];
    if (fresh) out.push(this.event(p, "open", scope));
    else if (!sameView(p, before)) out.push(this.event(p, "changed", scope));
    while (this.open.size > MAX_PROMPTS) {
      const [k, old] = this.open.entries().next().value!;
      this.open.delete(k);
      out.push(this.closedEvent(old));
    }
    if (out.some((e) => e.state === "closed")) this.o.log(`prompts: the prompt limit (${MAX_PROMPTS}) dropped the oldest prompt`);
    return out;
  }

  /**
   * Check each open prompt against its scopes' lists now: a prompt closes when one of its scopes no longer has the
   * prompt's list (and repo), or a list covers its host; a from host that the list no longer covers is cleared.
   */
  revalidate(targetOf: (scope: string) => Target | null): PromptEvent[] {
    const out: PromptEvent[] = [];
    for (const [k, p] of [...this.open]) {
      const targets = [...p.scopes].map(targetOf);
      const valid = targets.filter((t): t is Target => t !== null && t.name === p.list && t.repo === p.repo);
      if (valid.length === 0 || valid.length !== targets.length || valid.some((t) => coveredBy(t.hosts, p.host))) {
        this.open.delete(k);
        out.push(this.closedEvent(p));
      } else if (p.from !== null && !coveredBy(valid[0].hosts, p.from)) {
        p.from = null;
        out.push(this.event(p, "changed", [...p.scopes].sort()[0]));
      }
    }
    return out;
  }

  /** The open prompts, oldest first, each with its recipients. */
  views(): PromptView[] { return [...this.open.values()].map((p) => this.view(p)); }

  /** The open prompt with this id. */
  find(id: string): PromptView | undefined {
    for (const p of this.open.values()) if (p.id === id) return this.view(p);
    return undefined;
  }

  /** Close the open prompt with this id: its closed event, or none when no prompt has the id. */
  close(id: string): PromptEvent[] {
    for (const [k, p] of this.open) if (p.id === id) { this.open.delete(k); return [this.closedEvent(p)]; }
    return [];
  }

  /**
   * Dismiss the open prompt with this id for DISMISS_S: the dismissals file first (a write that fails throws, and the
   * prompt stays open), then the prompt closes. Its closed event, or none when no prompt has the id.
   */
  dismiss(id: string): PromptEvent[] {
    const p = [...this.open.values()].find((x) => x.id === id);
    if (p === undefined) return [];
    const entries = new Map(this.dismissals());
    const key = keyOf(p.host, p.list);
    entries.delete(key);
    entries.set(key, this.o.wall() + DISMISS_S);
    while (entries.size > MAX_DISMISSALS) entries.delete(entries.keys().next().value!);
    this.writer(this.o.file, [...entries].map(([k, until]) => { const [host, list] = k.split("\n"); return { host, list, until }; }));
    this.dismissed = entries;
    return this.close(id);
  }
}
