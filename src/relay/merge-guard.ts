// The merge guard (board ab-v16.99; C11, "The merge guard"; the design
// docs/superpowers/specs/2026-11-13-triage-merge-guard-design.md). The operator's hard rule (agentwatch board item age-zbo,
// 2026-11-12): "No PR from automatic issue triage is allowed to be merged, even if i've already given agents authorization
// to merge to staging." agentwatch's issue triage marks each of its PRs: the label agentwatch-triage, the title prefix
// "[agentwatch triage] ", the head branch agentwatch-triage/issue-N and the body's first line "Opened by agentwatch issue
// triage". This module is layer 1 of the guard, in the model: it keeps Fetch on in each tab that the model attaches, reads
// GitHub's own answers for a PR's pages (the markers), and judges each request to a GitHub host that is no GET, HEAD or
// OPTIONS (a "write"). It answers a refused write itself with HTTP 403 and a text that names the operator's rule, so the
// request never reaches GitHub. Layer 2 is the receiver's rule (C5, the merge guard's floor): it blocks every write to a
// GitHub host from each tab where layer 1 is not on. Where the guard cannot tell, it refuses (fail closed). No log line
// holds a URL path, a query, a body, a header, a cookie or a page's text: only a method, a host, a tab, a reason and counts.

/** The production hosts: GitHub. A host covers itself and every subdomain (api.github.com among them). */
export const GITHUB_HOSTS: readonly string[] = Object.freeze(["github.com"]);
/** The date of the operator's rule, as its texts name it. */
export const RULE_DATE = "2026-11-12";

export type Reason = "marked" | "unknown" | "untied";
export const GUARD_TEXT: Readonly<Record<Reason, string> & { rewrite: (host: string) => string; badId: string; logPrefix: string }> = Object.freeze({
  marked: `The agent browser refused this request: the pull request came from agentwatch issue triage. No agent merges such a pull request, marks it ready for review, turns on its auto-merge or changes it in the agent browser; only the operator does, on GitHub (the operator's rule, ${RULE_DATE}).`,
  unknown: `The agent browser refused this request: it could not tell whether the pull request came from agentwatch issue triage, and no agent merges such a pull request (the operator's rule, ${RULE_DATE}). Load the pull request's own page in this tab, then try again.`,
  untied: `The agent browser refused this request: it cannot tie the request to a pull request that did not come from agentwatch issue triage (a merge of branches, a write of a branch, or a GraphQL request that it cannot read), and no agent merges such a pull request (the operator's rule, ${RULE_DATE}).`,
  rewrite: (host: string) => `Not available in the agent browser: a request rewritten to ${host} (Fetch.continueRequest). The agent browser judges each request to GitHub itself (the merge guard of pull requests from agentwatch issue triage).`,
  /** Chrome's own text for a Fetch command whose requestId is no paused request of the session. */
  badId: "Invalid InterceptionId.",
  logPrefix: "merge guard:",
});

/** A pull request (or an issue number of a repo, which names the same number space) of a guarded host. */
export type Pr = { key: string; host: string; owner: string; repo: string; number: number; kind: "pull" | "issue"; api: boolean; rest: string | null };
/** CDP's Fetch.RequestPattern. */
export type Pattern = { urlPattern?: string; resourceType?: string; requestStage?: "Request" | "Response" };
type Target = { tabId: number; sessionId?: string };
type Client = { patterns: Pattern[]; auth: boolean };
export type GuardOptions = {
  /** Hosts beside GitHub's (only the service's --test gives one: a *.localhost stand-in). */
  hosts?: readonly string[];
  send: (target: Target, method: string, params: object) => Promise<any>;
  /** The receiver's op of the floor (C10, bridge.mergeGuard). */
  op: (args: unknown[]) => Promise<unknown>;
  log: (line: string) => void;
  now?: () => number;
};

const WRITE_FREE = new Set(["GET", "HEAD", "OPTIONS"]);
/** The separators of a marker as GitHub's pages and answers spell them: a space, a hyphen, an underscore, and their escapes. */
const SEP = String.raw`(?:[-\s_]|%2[0dD]|&#(?:32|45|x20|x2[dD]);|&nbsp;|\\u00(?:20|2[dD]))+`;
/** The markers: the label and the head branch's prefix (agentwatch-triage), the title prefix ([agentwatch triage]) and the body's first line (agentwatch issue triage). */
export const MARKER = new RegExp(`agentwatch${SEP}(?:issue${SEP})?triage`, "i");
/** GitHub's GraphQL node ids of pull requests (the new and the legacy form). */
const NODE_IDS = /\bPR_[A-Za-z0-9_-]{8,}|\bMDExOlB1bGxSZXF1ZXN0[A-Za-z0-9+/=]{2,}/g;
/** The GraphQL names of a merge, a ready for review, an auto-merge and a merge queue entry (and the input key of a merge's method). */
export const MERGE_NAMES = /mergePullRequest|enablePullRequestAutoMerge|enqueuePullRequest|markPullRequestReadyForReview|mergeMethod/i;
/** The GraphQL names of a merge of branches and a write of a branch's ref: never tied to a pull request. */
export const REF_NAMES = /mergeBranch|updateRefs?\b/i;
/** A path segment after /pull/<n>/ that names a merge-type action (merge, merge_queue, auto_merge, ready_for_review, enqueue, ...). */
const MERGE_SEGMENT = /merge|ready|queue/i;
/** A path segment, on no PR, that names a merge (a fork's fetch_and_merge, an enqueue). */
const MERGE_ELSEWHERE = /merge|enqueue/i;
/** The PR pages whose HTML always holds the PR's header (its title, labels and head branch): the only ones that can say "no marker". */
const HEADER_PAGES = new Set(["files", "commits", "checks"]);
/** At most this many verdicts and marked node ids are kept (the oldest unmarked go first). */
const MAX_VERDICTS = 20_000;
const MAX_NODES = 20_000;
/** The largest request body that the guard reads for a GraphQL request; a larger one is unreadable (untied). */
export const MAX_BODY = 1 << 20;
/** A log line of each reason and host at most once in this time (C10's log rule), with the counts. */
const NOTICE_MS = 5 * 60_000;

const lower = (s: string) => s.toLowerCase();
const decodeSegment = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

/** The guarded host that covers `hostname`, or null. */
export function baseOf(hostname: string, hosts: readonly string[]): string | null {
  const h = lower(hostname);
  for (const b of hosts) if (h === b || h.endsWith(`.${b}`)) return b;
  return null;
}

/** The PR that a URL of a guarded host names: web /<o>/<r>/pull/<n>[/...] (and /issues/<n>), API api.<host>/repos/<o>/<r>/(pulls|issues)/<n>[/...]. */
export function prOf(url: string, hosts: readonly string[]): Pr | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = baseOf(u.hostname, hosts);
  if (!host) return null;
  const api = lower(u.hostname) === `api.${host}`;
  const segs = u.pathname.split("/").slice(1).map(decodeSegment);
  let owner: string, repo: string, kind: string, num: string, rest: string[];
  if (api) {
    if (segs[0] !== "repos" || segs.length < 5) return null;
    [, owner, repo, kind, num, ...rest] = segs;
    if (kind !== "pulls" && kind !== "issues") return null;
  } else {
    if (segs.length < 4) return null;
    [owner, repo, kind, num, ...rest] = segs;
    if (kind !== "pull" && kind !== "pulls" && kind !== "issues") return null;
  }
  if (!/^[1-9][0-9]{0,9}$/.test(num) || !owner || !repo) return null;
  const restText = rest.filter((s) => s !== "").join("/");
  const k = kind === "issues" ? "issue" : "pull";
  return { key: `${host}/${lower(owner)}/${lower(repo)}#${num}`, host, owner, repo, number: Number(num), kind: k, api, rest: restText === "" ? null : restText };
}

/** A text holds a marker of agentwatch's issue triage. */
export const markersIn = (text: string) => MARKER.test(text);
/** The PR node ids that a text holds. */
export const nodeIdsIn = (text: string) => text.match(NODE_IDS) ?? [];

/** CDP's urlPattern: '*' is zero or more characters, '?' exactly one, a backslash escapes the next one. */
export function globMatch(pattern: string, url: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\" && i + 1 < pattern.length) re += pattern[++i].replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    else if (c === "*") re += "[\\s\\S]*";
    else if (c === "?") re += "[\\s\\S]";
    else re += c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }
  return new RegExp(`^${re}$`).test(url);
}

/** A Fetch.requestPaused at the response stage (CDP: a responseStatusCode or a responseErrorReason). */
export const atResponse = (p: any) => p?.responseStatusCode !== undefined || p?.responseErrorReason !== undefined;

/** Whether one of the client's patterns asks for this pause (its URL, its resource type and its stage). */
export function wanted(patterns: readonly Pattern[], p: any): boolean {
  const stage = atResponse(p) ? "Response" : "Request";
  const url = String(p?.request?.url ?? "");
  return patterns.some((x) => (x.requestStage ?? "Request") === stage && (!x.resourceType || x.resourceType === p?.resourceType) && globMatch(x.urlPattern ?? "*", url));
}

const header = (headers: unknown, name: string): string | undefined => {
  if (!headers || typeof headers !== "object") return undefined;
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) if (lower(k) === name) return String(v);
  return undefined;
};
const listHeader = (headers: unknown, name: string): string | undefined => {
  if (!Array.isArray(headers)) return undefined;
  for (const h of headers) if (h && lower(String(h.name)) === name) return String(h.value);
  return undefined;
};

/** The request body as text: "" for none, null when Chrome did not give it (or it is larger than MAX_BODY). */
export function bodyOf(req: any): string | null {
  if (typeof req?.postData === "string") return req.postData.length > MAX_BODY ? null : req.postData;
  if (Array.isArray(req?.postDataEntries)) {
    const parts: Buffer[] = [];
    let size = 0;
    for (const e of req.postDataEntries) {
      if (typeof e?.bytes !== "string") return null;
      const b = Buffer.from(e.bytes, "base64");
      size += b.length;
      if (size > MAX_BODY) return null;
      parts.push(b);
    }
    return Buffer.concat(parts).toString("utf8");
  }
  return req?.hasPostData ? null : "";
}

/** What a write's URL says: its PR, a merge-type action, a branch merge or ref write, a GraphQL endpoint. */
export function classify(url: string, hosts: readonly string[]): { base: string | null; pr: Pr | null; merge: boolean; refWrite: boolean; graphql: boolean } {
  let u: URL | null = null;
  try { u = new URL(url); } catch { /* not a URL */ }
  const base = u ? baseOf(u.hostname, hosts) : null;
  if (!u || !base) return { base: null, pr: null, merge: false, refWrite: false, graphql: false };
  const pr = prOf(url, hosts);
  const segs = u.pathname.split("/").filter((s) => s !== "").map(decodeSegment);
  const last = segs.at(-1) ?? "";
  const api = lower(u.hostname) === `api.${base}`;
  const graphql = /graphql/i.test(last);
  const refWrite = /^git-receive-pack$/i.test(last) || (api && segs[0] === "repos" && (segs[3] === "merges" || segs[3] === "git"));
  let merge = false;
  if (pr && pr.kind === "pull") merge = (pr.rest ?? "").split("/").some((s) => MERGE_SEGMENT.test(s));
  else if (!pr && !api && !graphql) merge = segs.slice(2).some((s) => MERGE_ELSEWHERE.test(s));
  return { base, pr, merge, refWrite, graphql };
}

/**
 * Layer 1 of the merge guard for one model: the verdicts of the PRs (browser-wide, for every scope), the tabs where its
 * Fetch is on, the clients' Fetch state of each session, and the paused requests that it gave a client.
 */
export class MergeGuard {
  readonly hosts: readonly string[];
  /** The guard's own Fetch patterns: each request of a guarded host at the request stage, and its PR answers at the response stage. */
  readonly patterns: readonly Pattern[];
  private readonly o: GuardOptions;
  private readonly verdicts = new Map<string, "marked" | "unmarked">();
  private readonly markedNodes = new Set<string>();
  /** The sessions where the guard's patterns are on: `${tabId}|` for a tab's own session, `${tabId}|${sessionId}` for a child. */
  private readonly armed = new Set<string>();
  /** The top URL of each tab, as the last tabs.onUpdated or top-frame document request gave it. */
  private readonly tabUrls = new Map<number, string>();
  /** A client's Fetch state of each session (null: off). */
  private readonly clients = new Map<string, Client | null>();
  /** The paused requests that a client got (`${tabId}/${requestId}` -> the session key): a Fetch.disable of the session lets them go. */
  private readonly given = new Map<string, string>();
  /** The paused requests of a guarded host that the guard holds until its own answer goes (`${tabId}/${requestId}`): no client command acts on one. */
  private readonly held = new Set<string>();
  private readonly notices = new Map<string, number>();
  private floorChain: Promise<void> = Promise.resolve();
  /** The receiver's floor (layer 2): on (it answered bridge.mergeGuard), absent (unknown op: an older receiver), or unknown. */
  floor: "on" | "absent" | "unknown" = "unknown";
  readonly counts = { writes: 0, refused: 0, marked: 0, unknown: 0, untied: 0, clientRefused: 0, reads: 0, readFailed: 0 };

  constructor(o: GuardOptions) {
    this.o = o;
    const extra = (o.hosts ?? []).map(lower).filter((h) => !GITHUB_HOSTS.includes(h));
    this.hosts = Object.freeze([...GITHUB_HOSTS, ...new Set(extra)]);
    this.patterns = Object.freeze(this.hosts.flatMap((h): Pattern[] => [
      { urlPattern: `*://${h}*`, requestStage: "Request" }, { urlPattern: `*://*.${h}*`, requestStage: "Request" },
      { urlPattern: `*://${h}*/pull*`, requestStage: "Response" }, { urlPattern: `*://*.${h}*/pull*`, requestStage: "Response" },
      { urlPattern: `*://api.${h}*/repos/*`, requestStage: "Response" },
    ]));
  }

  private key = (tabId: number, sessionId?: string) => `${tabId}|${sessionId ?? ""}`;
  /** The guarded host of a URL, or null. */
  base(url: string): string | null { try { return baseOf(new URL(url).hostname, this.hosts); } catch { return null; } }
  /** A PR's verdict: marked, unmarked, or undefined (unknown). */
  verdict(key: string) { return this.verdicts.get(key); }
  isArmed(tabId: number, sessionId?: string) { return this.armed.has(this.key(tabId, sessionId)); }

  /** What the guard keeps (the tests and the harness; no client sees it). */
  state() {
    let marked = 0, unmarked = 0;
    for (const v of this.verdicts.values()) if (v === "marked") marked++; else unmarked++;
    return { hosts: [...this.hosts], floor: this.floor, armed: [...this.armed].sort(), verdicts: { marked, unmarked }, nodes: this.markedNodes.size, counts: { ...this.counts } };
  }

  // ------------------------------------------------------------------ the tabs and the floor

  /**
   * The guard's Fetch on a tab's own session, before a client gets a session of it: then the receiver's floor (bridge.mergeGuard)
   * leaves the tab to layer 1. True when it is on. A Fetch.enable that fails leaves the tab off, so the floor keeps blocking its
   * writes to GitHub (fail closed).
   */
  async arm(tabId: number): Promise<boolean> {
    const k = this.key(tabId);
    if (this.armed.has(k)) return true;
    try { await this.o.send({ tabId }, "Fetch.enable", { patterns: [...this.patterns] }); } catch (e) {
      this.notice(`arm ${(e as Error).message}`, `${GUARD_TEXT.logPrefix} the guard's Fetch did not start in tab ${tabId} (${(e as Error).message}); the receiver's floor keeps blocking its writes to GitHub`);
      return false;
    }
    this.armed.add(k);
    this.clients.set(k, null);
    await this.syncFloor();
    return true;
  }

  /** A child session (a frame or a worker of an armed tab) that Chrome attached: the guard's Fetch on it, before the client's release. */
  armChild(tabId: number, sessionId: string): void {
    if (!this.armed.has(this.key(tabId))) return;
    const k = this.key(tabId, sessionId);
    this.armed.add(k);
    this.clients.set(k, null);
    this.o.send({ tabId, sessionId }, "Fetch.enable", { patterns: [...this.patterns] }).catch(() => { this.armed.delete(k); });
  }

  /** A child session ended. */
  childGone(tabId: number, sessionId: string): void {
    const k = this.key(tabId, sessionId);
    this.armed.delete(k); this.clients.delete(k);
    for (const [id, s] of this.given) if (s === k) this.given.delete(id);
  }

  /** The tab's attachment ended (a detach, Chrome's detach, a link change): its sessions' state goes; the receiver floors it again at its detach. */
  disarm(tabId: number): void {
    const prefix = `${tabId}|`;
    for (const k of [...this.armed]) if (k.startsWith(prefix)) this.armed.delete(k);
    for (const k of [...this.clients.keys()]) if (k.startsWith(prefix)) this.clients.delete(k);
    for (const [id, s] of [...this.given]) if (s.startsWith(prefix)) this.given.delete(id);
    for (const id of [...this.held]) if (id.startsWith(`${tabId}/`)) this.held.delete(id);
  }

  /** The tab closed. */
  forget(tabId: number): void { this.disarm(tabId); this.tabUrls.delete(tabId); }

  /** The link changed: no attachment is left; the verdicts stay (they are GitHub's answers, not a connection's). */
  reset(): void { this.armed.clear(); this.clients.clear(); this.given.clear(); this.held.clear(); this.tabUrls.clear(); this.floor = "unknown"; }

  /** The link came up: the receiver gets the guard's hosts at once, and says whether it has the floor. */
  linkUp(): Promise<void> { this.floor = "unknown"; return this.syncFloor(); }

  /** One bridge.mergeGuard at a time, with the hosts and every armed tab (a full replace). */
  private syncFloor(): Promise<void> {
    const run = this.floorChain.then(async () => {
      if (this.floor === "absent") return;
      const tabs = [...new Set([...this.armed].filter((k) => k.endsWith("|")).map((k) => Number(k.slice(0, -1))))].sort((a, b) => a - b);
      try {
        await this.o.op([{ hosts: [...this.hosts], tabs }]);
        this.floor = "on";
      } catch (e) {
        const why = (e as Error).message;
        if (why === "unknown op") {
          this.floor = "absent";
          this.o.log(`${GUARD_TEXT.logPrefix} the receiver has no floor (bridge.mergeGuard: unknown op): only the tabs that a client holds are guarded`);
        } else this.notice(`floor ${why}`, `${GUARD_TEXT.logPrefix} bridge.mergeGuard failed (${why})`);
      }
    });
    this.floorChain = run.catch(() => {});
    return run;
  }

  /** The tab's top URL (tabs.onUpdated, or a top-frame document request). */
  url(tabId: number, url: unknown): void { if (typeof url === "string" && url) this.tabUrls.set(tabId, url); }

  // ------------------------------------------------------------------ the requests

  /**
   * A Fetch.requestPaused or Fetch.authRequired of a tab's session. True when the guard answered it (a request of a guarded
   * host, which no client ever gets, or a pause that no client asked for); false when the model gives it to the owner (the
   * guard noted its requestId, so the owner's Fetch commands of it pass).
   */
  paused(tabId: number, sessionId: string | undefined, method: string, p: any, o: { owner: boolean; topFrame: string | null }): boolean {
    const k = this.key(tabId, sessionId), target: Target = sessionId ? { tabId, sessionId } : { tabId };
    const url = String(p?.request?.url ?? "");
    const base = this.base(url);
    const virtual = this.armed.has(k);
    const client = this.clients.get(k);
    if (method === "Fetch.authRequired") {
      if (base) { void this.o.send(target, "Fetch.continueWithAuth", { requestId: p.requestId, authChallengeResponse: { response: "CancelAuth" } }).catch(() => {}); return true; }
      if (!o.owner || (virtual && !client?.auth)) { void this.o.send(target, "Fetch.continueWithAuth", { requestId: p.requestId, authChallengeResponse: { response: "Default" } }).catch(() => {}); return true; }
      this.given.set(`${tabId}/${p.requestId}`, k);
      return false;
    }
    if (!sessionId && !atResponse(p) && p?.resourceType === "Document" && o.topFrame && p?.frameId === o.topFrame) this.url(tabId, url);
    if (base) { void this.guarded(target, tabId, p, base); return true; }
    if (!o.owner || (virtual && !(client && wanted(client.patterns, p)))) { void this.o.send(target, "Fetch.continueRequest", { requestId: p.requestId }).catch(() => {}); return true; }
    this.given.set(`${tabId}/${p.requestId}`, k);
    return false;
  }

  /** A paused request of a guarded host: a write is judged; a PR's answer is read for its markers; then it goes on. */
  private async guarded(target: Target, tabId: number, p: any, base: string): Promise<void> {
    const id = `${tabId}/${p.requestId}`;
    this.held.add(id);
    try { await this.answerGuarded(target, tabId, p, base); } finally { this.held.delete(id); }
  }

  private async answerGuarded(target: Target, tabId: number, p: any, base: string): Promise<void> {
    const req = p.request ?? {};
    // Each answer is sent before its await: the guard's command reaches Chrome before any later client command.
    const go = () => this.o.send(target, "Fetch.continueRequest", { requestId: p.requestId }).catch(() => {});
    if (atResponse(p)) { await this.read(target, p).catch(() => { this.counts.readFailed++; }); await go(); return; }
    const method = String(req.method ?? "GET").toUpperCase();
    if (WRITE_FREE.has(method)) { await go(); return; }
    const reason = this.judge(tabId, req);
    if (!reason) { await go(); return; }
    this.counts.refused++;
    this.counts[reason]++;
    this.notice(`${reason} ${base}`, `${GUARD_TEXT.logPrefix} refused a write to ${base} (${method}, tab ${tabId}): ${reason}; refused so far: ${this.counts.refused}`);
    const doc = p.resourceType === "Document";
    const text = GUARD_TEXT[reason];
    const body = doc ? text : JSON.stringify({ message: text, errors: [{ type: "FORBIDDEN", message: text }] });
    const headers = [{ name: "Content-Type", value: doc ? "text/plain; charset=utf-8" : "application/json; charset=utf-8" }, { name: "Cache-Control", value: "no-store" }];
    const origin = header(req.headers, "origin");
    if (origin && !doc) headers.push({ name: "Access-Control-Allow-Origin", value: origin }, { name: "Access-Control-Allow-Credentials", value: "true" });
    try { await this.o.send(target, "Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 403, responseHeaders: headers, body: Buffer.from(body, "utf8").toString("base64") }); }
    catch { await this.o.send(target, "Fetch.failRequest", { requestId: p.requestId, errorReason: "BlockedByClient" }).catch(() => {}); }
  }

  /**
   * Why a write to a guarded host is refused, or null (it goes). In this order: the tab's page or the request's Referer is a
   * PR page that is marked or unknown; the request names a marked PR, or a node id of a marked PR's answer; a merge of
   * branches or a write of a ref (never tied to a PR); a merge-type action of a PR that is not known unmarked, or of no PR
   * from a page that is no known-unmarked PR; a GraphQL request whose body Chrome did not give, that writes a ref, or that
   * names a merge-type operation from a page that is no known-unmarked PR.
   */
  judge(tabId: number, req: any): Reason | null {
    this.counts.writes++;
    const url = String(req.url ?? "");
    const c = classify(url, this.hosts);
    const pages: Pr[] = [];
    for (const u of [this.tabUrls.get(tabId), header(req.headers, "referer")]) {
      const pr = u ? prOf(u, this.hosts) : null;
      if (pr && !pr.api && pr.kind === "pull") pages.push(pr);
    }
    for (const pr of pages) { const v = this.verdicts.get(pr.key); if (v === "marked") return "marked"; if (v === undefined) return "unknown"; }
    if (c.pr && this.verdicts.get(c.pr.key) === "marked") return "marked";
    const body = bodyOf(req);
    if (body && this.namesMarkedNode(body)) return "marked";
    if (this.namesMarkedNode(url)) return "marked";
    if (c.refWrite) return "untied";
    if (c.merge) {
      if (c.pr) return this.verdicts.get(c.pr.key) === "unmarked" ? null : "unknown";
      return pages.length ? null : "unknown";
    }
    if (c.graphql) {
      if (body === null) return "untied";
      if (REF_NAMES.test(body)) return "untied";
      if (MERGE_NAMES.test(body)) return pages.length ? null : "unknown";
    }
    return null;
  }

  private namesMarkedNode(text: string): boolean {
    if (!this.markedNodes.size) return false;
    for (const id of nodeIdsIn(text)) if (this.markedNodes.has(id)) return true;
    return false;
  }

  /** A 2xx answer of a PR's URL: a marker marks it; the PR's own page (HTML) or its API object with none says unmarked. */
  private async read(target: Target, p: any): Promise<void> {
    const status = Number(p.responseStatusCode);
    if (!(status >= 200 && status < 300)) return;
    const pr = prOf(String(p.request?.url ?? ""), this.hosts);
    if (!pr) return;
    const r = await this.o.send(target, "Fetch.getResponseBody", { requestId: p.requestId });
    const text = r?.base64Encoded ? Buffer.from(String(r.body ?? ""), "base64").toString("utf8") : String(r?.body ?? "");
    this.counts.reads++;
    const type = lower(listHeader(p.responseHeaders, "content-type") ?? "");
    this.learn(pr, text, type);
  }

  /** The verdict of one read answer (exported for the unit tests through the class). */
  learn(pr: Pr, text: string, contentType: string): void {
    if (markersIn(text)) {
      this.set(pr.key, "marked");
      for (const id of nodeIdsIn(text)) { if (this.markedNodes.size >= MAX_NODES) break; this.markedNodes.add(id); }
      return;
    }
    if (pr.kind !== "pull") return;
    const ownPage = !pr.api && (pr.rest === null || HEADER_PAGES.has(pr.rest)) && contentType.startsWith("text/html") && text.includes(`/pull/${pr.number}`);
    const ownObject = pr.api && pr.rest === null && contentType.includes("json") && new RegExp(`"number"\\s*:\\s*${pr.number}\\b`).test(text);
    if ((ownPage || ownObject) && this.verdicts.get(pr.key) !== "marked") this.set(pr.key, "unmarked");
  }

  private set(key: string, v: "marked" | "unmarked"): void {
    if (this.verdicts.get(key) === "marked") return; // a PR that the guard once saw marked stays marked
    this.verdicts.delete(key);
    this.verdicts.set(key, v);
    if (this.verdicts.size <= MAX_VERDICTS) return;
    for (const [k, x] of this.verdicts) { if (this.verdicts.size <= MAX_VERDICTS) break; if (x === "unmarked") this.verdicts.delete(k); }
  }

  // ------------------------------------------------------------------ the clients' Fetch commands

  /**
   * A client's Fetch command on a page session, before it goes to Chrome: a refusal, or the command that goes (with the guard's
   * patterns kept on an armed session) and what runs after Chrome's answer.
   */
  command(tabId: number, sessionId: string | undefined, method: string, params: any): { refuse: string } | { method: string; params: any; after?: () => void } {
    const k = this.key(tabId, sessionId), target: Target = sessionId ? { tabId, sessionId } : { tabId };
    const p = params ?? {};
    const armed = this.armed.has(k);
    if (method === "Fetch.enable") {
      const patterns: Pattern[] = Array.isArray(p.patterns) ? p.patterns : [{ urlPattern: "*" }];
      this.clients.set(k, { patterns, auth: p.handleAuthRequests === true });
      return armed ? { method, params: { ...p, patterns: [...this.patterns, ...patterns] } } : { method, params: p };
    }
    if (method === "Fetch.disable") {
      this.clients.set(k, null);
      const held = [...this.given].filter(([, s]) => s === k).map(([id]) => id.slice(id.indexOf("/") + 1));
      for (const id of held) this.given.delete(`${tabId}/${id}`);
      // Chrome's Fetch.disable lets every paused request go: on an armed session the guard's patterns stay, and the guard lets
      // the client's paused requests go itself.
      if (!armed) return { method, params: p };
      return { method: "Fetch.enable", params: { patterns: [...this.patterns] }, after: () => { for (const id of held) void this.o.send(target, "Fetch.continueRequest", { requestId: id }).catch(() => {}); } };
    }
    if (typeof p.requestId === "string") {
      const id = `${tabId}/${p.requestId}`;
      if (this.held.has(id)) { this.counts.clientRefused++; return { refuse: GUARD_TEXT.badId }; }
      if (method === "Fetch.continueRequest" && typeof p.url === "string") {
        const host = this.base(p.url);
        if (host) { this.counts.clientRefused++; return { refuse: GUARD_TEXT.rewrite(host) }; }
      }
      if (method !== "Fetch.getResponseBody" && method !== "Fetch.takeResponseBodyAsStream") this.given.delete(id);
    }
    return { method, params: p };
  }

  /** A paused request whose event was too large for the link (C10's bridge.tooLarge): on a page of a guarded host it fails. */
  tooLarge(tabId: number): boolean {
    const u = this.tabUrls.get(tabId);
    return this.armed.has(this.key(tabId)) && !!u && this.base(u) !== null;
  }

  private notice(key: string, line: string): void {
    const now = (this.o.now ?? Date.now)();
    const at = this.notices.get(key);
    if (at !== undefined && now - at < NOTICE_MS) return;
    this.notices.set(key, now);
    this.o.log(line);
  }
}
