// The merge guard (board ab-v16.99; C11, "The merge guard"; the design
// docs/superpowers/specs/2026-11-13-triage-merge-guard-design.md). The operator's hard rule (agentwatch board item age-zbo,
// 2026-11-12): "No PR from automatic issue triage is allowed to be merged, even if i've already given agents authorization
// to merge to staging." A PR is marked by TRIAGE_MARKER (below; the same definition as agentwatch's own merge hook). This
// module is layer 1 of the guard, in the model: it keeps Fetch on in each tab that a client holds, reads GitHub's own
// answers for a PR's pages (the markers), and judges each request to a GitHub host that is no GET, HEAD or OPTIONS (a
// "write"). It answers a refused write itself with HTTP 403 and a text that names the operator's rule, so the request
// never reaches GitHub; a client whose own Fetch patterns ask for a paused request of GitHub gets it after the judge, and
// may not change it. Layer 2 is the receiver's rule (C5, the merge guard's floor): it blocks every write to a
// GitHub host from each tab where layer 1 is not on. Where the guard cannot tell, it refuses (fail closed). No log line
// holds a URL path, a query, a body, a header, a cookie or a page's text: only a method, a host, a tab, a reason and counts.

/** The production hosts: GitHub. A host covers itself and every subdomain (api.github.com among them). */
export const GITHUB_HOSTS: readonly string[] = Object.freeze(["github.com"]);
/** The date of the operator's rule, as its texts name it. */
export const RULE_DATE = "2026-11-12";

export type Reason = "marked" | "unknown" | "untied";
export const GUARD_TEXT: Readonly<Record<Reason, string> & { rewrite: (host: string) => string; serviceWorker: string; badId: string; logPrefix: string }> = Object.freeze({
  marked: `The agent browser refused this request: the pull request came from agentwatch issue triage. No agent merges such a pull request, marks it ready for review, turns on its auto-merge, approves it or changes it in the agent browser; only the operator does, on GitHub (the operator's rule, ${RULE_DATE}).`,
  unknown: `The agent browser refused this request: it could not tell whether the pull request came from agentwatch issue triage, and no agent merges such a pull request (the operator's rule, ${RULE_DATE}). Load the pull request's own page in this tab, then try again.`,
  untied: `The agent browser refused this request: it cannot tie the request to a pull request that did not come from agentwatch issue triage (a merge of branches, a write of a branch, or a GraphQL request that it cannot read), and no agent merges such a pull request (the operator's rule, ${RULE_DATE}).`,
  rewrite: (host: string) => `Not available in the agent browser: a request to ${host} that a client changes (Fetch.continueRequest). The agent browser judges each request to GitHub itself (the merge guard of pull requests from agentwatch issue triage).`,
  serviceWorker: "Not available in the agent browser: Network.setBypassServiceWorker with bypass false. The merge guard keeps a page's service worker off in each tab that a client holds (the merge guard of pull requests from agentwatch issue triage).",
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
/** A paused request that a client got: plain (another host), guarded (of a guarded host, after the judge: no change), refused (the guard's 403 in place of its going on). */
type Given = { key: string; kind: "plain" | "guarded" | "refused"; host?: string; refusal?: object; ev: { requestId: string; resourceType?: string; request: { headers: unknown } } };
/**
 * The arm's limit (review-125b F1): the longest wait for each of the arm's steps. Its Network.enable and its bypass go to the
 * page's renderer, which a page's dialog (a beforeunload dialog of a navigation, measured), a busy or a crashed renderer can
 * hold; at the limit the client gets its session and the floor keeps the tab until those calls answer.
 */
export const ARM_LIMIT_MS = 3000;
/** The guard's own Network.enable (review-125b F2): the smallest buffers (Chrome takes 0 and then keeps no body), as the guard reads no Network data. */
export const GUARD_NETWORK: Readonly<{ maxTotalBufferSize: number; maxResourceBufferSize: number }> = Object.freeze({ maxTotalBufferSize: 0, maxResourceBufferSize: 0 });

/** A promise that fails at `ms` when `p` has not settled by then. */
function limited<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms); });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

export type GuardOptions = {
  /** Hosts beside GitHub's (only the service's --test gives one: a *.localhost stand-in). */
  hosts?: readonly string[];
  /** The arm's limit (the tests give a short one). */
  armLimitMs?: number;
  send: (target: Target, method: string, params: object) => Promise<any>;
  /** The receiver's op of the floor (C10, bridge.mergeGuard). */
  op: (args: unknown[]) => Promise<unknown>;
  log: (line: string) => void;
  now?: () => number;
};

const WRITE_FREE = new Set(["GET", "HEAD", "OPTIONS"]);
/**
 * The one definition of a triage PR (the operator's, through the manager and the daemon lead, 2026-11-13; agentwatch's merge
 * hook uses the same one): a PR is marked when ANY one holds: one of its labels equals a name of `labels`, compared without
 * case (GitHub compares label names without case); its title starts with a prefix of `titlePrefixes`; its head branch starts
 * with `headBranchPrefix` (an extra sign). The bare forms "triage" and "[triage]" are the manager's decision: hand-started
 * triage PRs carry them; agentwatch's built feature uses "agentwatch-triage" and "[agentwatch triage]". A false match only
 * refuses a merge, the safe side of the operator's rule.
 */
export const TRIAGE_MARKER = Object.freeze({
  labels: Object.freeze(["agentwatch-triage", "triage"]),
  titlePrefixes: Object.freeze(["[agentwatch triage]", "[triage]"]),
  headBranchPrefix: "agentwatch-triage/",
});
/** One character of a marker as GitHub's HTML, JSON and URLs can spell it. */
const CHAR: Record<string, string> = {
  " ": String.raw`(?:\s+|&nbsp;|&#32;|&#x20;|%20|\+|\\u0020)`, "-": String.raw`(?:-|&#45;|&#x2[dD];|%2[dD]|\\u002[dD])`,
  "/": String.raw`(?:/|&#47;|&#x2[fF];|%2[fF]|\\u002[fF]|\\/)`, "[": String.raw`(?:\[|&#91;|&#x5[bB];|%5[bB]|\\u005[bB])`, "]": String.raw`(?:\]|&#93;|&#x5[dD];|%5[dD]|\\u005[dD])`,
};
const spell = (s: string) => [...s].map((c) => CHAR[c] ?? c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("");
/** A label's name ends at a character that no label name of the definition holds. */
const END = String.raw`(?![A-Za-z0-9_.-])`;
/**
 * The forms of each marker in a GitHub answer: a label as its own link (/labels/<name>), its data-name, its JSON name, or a
 * search's label:<name>; a title prefix at the start of the page's <title>, of an element's text, of a title attribute or of
 * a JSON title; the head branch's prefix anywhere. Each form is its own pattern, so a test and a mutation name each one.
 */
export const MARKER_FORMS: Readonly<Record<string, RegExp>> = Object.freeze(Object.fromEntries([
  ...TRIAGE_MARKER.labels.map((l) => [`label ${l}`, new RegExp(String.raw`(?:/labels/${spell(l)}${END}|data-name=["']${spell(l)}["']|"name"\s*:\s*"${spell(l)}"|label(?::|%3[aA])(?:"|%22)?${spell(l)}${END})`, "i")]),
  ...TRIAGE_MARKER.titlePrefixes.map((t) => [`title ${t}`, new RegExp(String.raw`(?:<title[^>]*>|>|"title"\s*:\s*"|title=["'])\s*${spell(t)}`, "i")]),
  [`head ${TRIAGE_MARKER.headBranchPrefix}`, new RegExp(spell(TRIAGE_MARKER.headBranchPrefix), "i")],
]));
/** GitHub's GraphQL node ids of pull requests (the new and the legacy form). */
const NODE_IDS = /\bPR_[A-Za-z0-9_-]{8,}|\bMDExOlB1bGxSZXF1ZXN0[A-Za-z0-9+/=]{2,}/g;
/** The GraphQL names of a merge, a ready for review, an auto-merge, a merge queue entry and a review (an approve), and the input values of a merge's method and an approve. */
export const MERGE_NAMES = /mergePullRequest|enablePullRequestAutoMerge|enqueuePullRequest|markPullRequestReadyForReview|addPullRequestReview|submitPullRequestReview|mergeMethod|\bAPPROVE\b/i;
/** The GraphQL names of a merge of branches and a write of a branch's ref: never tied to a pull request. */
export const REF_NAMES = /mergeBranch|updateRefs?\b/i;
/** A path segment after /pull/<n>/ (or the API's /pulls/<n>/) that names a merge-type action: merge, merge_queue, auto_merge, ready_for_review, enqueue, reviews (an approve). */
const MERGE_SEGMENT = /merge|ready|queue|review/i;
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

/** The marker forms that a text shows (MARKER_FORMS' names). */
export const formsIn = (text: string) => Object.entries(MARKER_FORMS).filter(([, re]) => re.test(text)).map(([name]) => name);
/** A text shows a marker of a triage PR: any one form of TRIAGE_MARKER. */
export const markersIn = (text: string) => Object.values(MARKER_FORMS).some((re) => re.test(text));
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

/** The guard's answer of a refused write (Fetch.fulfillRequest): HTTP 403 with the reason's text, a page for a document, JSON for any other request. */
export function refusalOf(p: any, reason: Reason | { text: string }): object {
  const doc = p?.resourceType === "Document";
  const text = typeof reason === "string" ? GUARD_TEXT[reason] : reason.text;
  const body = doc ? text : JSON.stringify({ message: text, errors: [{ type: "FORBIDDEN", message: text }] });
  const headers = [{ name: "Content-Type", value: doc ? "text/plain; charset=utf-8" : "application/json; charset=utf-8" }, { name: "Cache-Control", value: "no-store" }];
  const origin = header(p?.request?.headers, "origin");
  if (origin && !doc) headers.push({ name: "Access-Control-Allow-Origin", value: origin }, { name: "Access-Control-Allow-Credentials", value: "true" });
  return { requestId: p.requestId, responseCode: 403, responseHeaders: headers, body: Buffer.from(body, "utf8").toString("base64") };
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
  private readonly given = new Map<string, Given>();
  /**
   * The tabs' own sessions where the client turned Network on itself (the lead's focused change): the guard keeps Network on in
   * each armed tab for the service worker's bypass, and gives a client the tab's Network events only while it turned Network on.
   */
  private readonly netClients = new Set<string>();
  /**
   * The sessions where the service worker's bypass is on (the operator's ab-u92: on GitHub only): a tab's own session while its
   * main frame is on a guarded host, and the session of each dedicated worker of such a tab that the client's auto-attach
   * brings (review-125b check 3). There the guard holds the client's Network calls of the bypass and hides the Network events
   * until the client turns Network on.
   */
  private readonly bypassOn = new Set<string>();
  /** The sessions whose bypass the guard turned off, until Chrome answered its Network.disable: their events stay hidden. */
  private readonly netHeld = new Set<string>();
  /** The sessions where the client asked for the bypass itself (Network.setBypassServiceWorker true): a turn off keeps it. */
  private readonly clientBypass = new Set<string>();
  /** The dedicated workers' sessions of the armed tabs: the bypass follows their tab's. */
  private readonly workers = new Set<string>();
  /** The paused requests of a guarded host that the guard holds until its own answer goes (`${tabId}/${requestId}`): no client command acts on one. */
  private readonly held = new Set<string>();
  private readonly notices = new Map<string, number>();
  private floorChain: Promise<void> = Promise.resolve();
  /** The link's generation: an answer of bridge.mergeGuard from before a link change confirms nothing (review-125 note A). */
  private generation = 0;
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
  /** The service worker's bypass is on in the session (the tab's own session when no sessionId). */
  isBypassed(tabId: number, sessionId?: string) { return this.bypassOn.has(this.key(tabId, sessionId)); }
  /** A URL of a guarded host (where the bypass is on). */
  guardedUrl(url: unknown): boolean { return typeof url === "string" && this.base(url) !== null; }

  /** What the guard keeps (the tests and the harness; no client sees it). */
  state() {
    let marked = 0, unmarked = 0;
    for (const v of this.verdicts.values()) if (v === "marked") marked++; else unmarked++;
    return { hosts: [...this.hosts], floor: this.floor, armed: [...this.armed].sort(), verdicts: { marked, unmarked }, nodes: this.markedNodes.size, counts: { ...this.counts } };
  }

  // ------------------------------------------------------------------ the tabs and the floor

  /**
   * The guard's Fetch on a tab's own session, before a client gets a session of it: then the receiver's floor
   * (bridge.mergeGuard) leaves the tab to layer 1. True when it is on. A Fetch.enable that fails or does not answer in the
   * arm's limit leaves the tab off. When the tab's page is on a guarded host, the service worker's bypass comes next
   * (bypassTab); a bypass that fails or does not answer in time leaves the tab to the floor's rule for a request with no tab.
   */
  async arm(tabId: number): Promise<boolean> {
    const k = this.key(tabId);
    if (this.armed.has(k)) return true;
    const limit = this.o.armLimitMs ?? ARM_LIMIT_MS;
    const fetchOn = this.o.send({ tabId }, "Fetch.enable", { patterns: [...this.patterns] });
    fetchOn.catch(() => {});
    try { await limited(fetchOn, limit); } catch (e) {
      const why = (e as Error).message;
      this.notice(`arm fetch ${why}`, `${GUARD_TEXT.logPrefix} the guard's Fetch did not start in tab ${tabId} (${why}); the receiver's floor keeps blocking its writes to GitHub`);
      return false;
    }
    this.armed.add(k);
    this.clients.set(k, null);
    // The floor names the tab whether or not the bypass is on: a request that a page's service worker sends has no tab, so the
    // floor blocks its write also in a named tab (measured).
    await this.syncFloor();
    if (this.guardedUrl(this.tabUrls.get(tabId))) await this.bypassTab(tabId, true);
    return true;
  }

  /**
   * The service worker's bypass of a tab (the operator's ab-u92: on GitHub only): on (true) while its main frame is on a guarded
   * host, off (false) on another host; in the tab's own session and in its dedicated workers' sessions. It waits at most the
   * arm's limit; a late answer still takes effect, as the calls are in Chrome's queue. False when it did not answer in time.
   */
  async bypassTab(tabId: number, on: boolean): Promise<boolean> {
    const k = this.key(tabId);
    const keys = [k, ...[...this.workers].filter((w) => w.startsWith(`${tabId}|`))];
    const runs = keys.map((key) => (on ? this.bypassIn(key) : this.unbypassIn(key)));
    if (!runs.some((r) => r !== null)) return true;
    const all = Promise.all(runs);
    all.catch(() => {});
    try { await limited(all, this.o.armLimitMs ?? ARM_LIMIT_MS); return true; } catch (e) {
      const why = (e as Error).message;
      this.notice(`bypass ${on} ${why}`, `${GUARD_TEXT.logPrefix} the service worker's bypass did not ${on ? "start" : "end"} in tab ${tabId} (${why})${on ? "; the receiver's floor keeps blocking the writes of a request with no tab" : ""}`);
      return false;
    }
  }

  /** The bypass on in a session: Network on with the smallest buffers when the client has not turned it on, then the bypass. */
  private bypassIn(k: string): Promise<void> | null {
    if (this.bypassOn.has(k)) return null;
    this.bypassOn.add(k);
    const target = this.target(k);
    return (async () => {
      if (!this.netClients.has(k)) await this.o.send(target, "Network.enable", GUARD_NETWORK);
      await this.o.send(target, "Network.setBypassServiceWorker", { bypass: true });
    })();
  }

  /** The bypass off in a session: the client's own bypass value again, and Network off when the client has not turned it on. */
  private unbypassIn(k: string): Promise<void> | null {
    if (!this.bypassOn.has(k)) return null;
    this.bypassOn.delete(k);
    const target = this.target(k), off = !this.netClients.has(k);
    if (off) this.netHeld.add(k);
    return (async () => {
      await this.o.send(target, "Network.setBypassServiceWorker", { bypass: this.clientBypass.has(k) });
      if (off) await this.o.send(target, "Network.disable", {});
    })().finally(() => { this.netHeld.delete(k); });
  }

  private target(k: string): Target {
    const [tab, sid] = k.split("|");
    return sid ? { tabId: Number(tab), sessionId: sid } : { tabId: Number(tab) };
  }

  /** A client's Page.navigate of the tab, or the model's own navigation of a new tab: the bypass first, to a guarded address. */
  async beforeNavigate(tabId: number, url: unknown): Promise<void> {
    if (this.guardedUrl(url)) await this.bypassTab(tabId, true);
  }

  /** The tab's main frame committed a URL (C10's tabs.onUpdated): the bypass follows its host, in an armed tab. */
  committed(tabId: number, url: unknown): void {
    if (typeof url !== "string" || !url || !this.armed.has(this.key(tabId))) return;
    void this.bypassTab(tabId, this.guardedUrl(url));
  }

  /**
   * A child session (a frame or a worker of an armed tab) that Chrome attached: the guard's Fetch on it, before the client's
   * release; in a dedicated worker's session of a tab whose bypass is on also the bypass (a blob worker of a page that a service
   * worker controls sends its requests through that worker, measured: review-125b check 3).
   */
  armChild(tabId: number, sessionId: string, type?: string): void {
    if (!this.armed.has(this.key(tabId))) return;
    const k = this.key(tabId, sessionId), target = { tabId, sessionId };
    this.armed.add(k);
    this.clients.set(k, null);
    this.o.send(target, "Fetch.enable", { patterns: [...this.patterns] }).catch(() => { this.armed.delete(k); });
    if (type !== "worker") return;
    this.workers.add(k);
    if (this.bypassOn.has(this.key(tabId))) this.bypassIn(k)?.catch(() => {});
  }

  /** A child session ended. */
  childGone(tabId: number, sessionId: string): void {
    const k = this.key(tabId, sessionId);
    this.armed.delete(k); this.clients.delete(k); this.bypassOn.delete(k); this.netHeld.delete(k); this.netClients.delete(k); this.clientBypass.delete(k); this.workers.delete(k);
    for (const [id, g] of this.given) if (g.key === k) this.given.delete(id);
  }

  /** The tab's attachment ended (a detach, Chrome's detach, a link change): its sessions' state goes; the receiver floors it again at its detach. */
  disarm(tabId: number): void {
    const prefix = `${tabId}|`;
    for (const k of [...this.armed]) if (k.startsWith(prefix)) this.armed.delete(k);
    for (const k of [...this.clients.keys()]) if (k.startsWith(prefix)) this.clients.delete(k);
    for (const set of [this.netClients, this.bypassOn, this.netHeld, this.clientBypass, this.workers]) for (const k of [...set]) if (k.startsWith(prefix)) set.delete(k);
    for (const [id, g] of [...this.given]) if (g.key.startsWith(prefix)) this.given.delete(id);
    for (const id of [...this.held]) if (id.startsWith(`${tabId}/`)) this.held.delete(id);
  }

  /** The tab closed. */
  forget(tabId: number): void { this.disarm(tabId); this.tabUrls.delete(tabId); }

  /** The link changed: no attachment is left; the verdicts stay (they are GitHub's answers, not a connection's). */
  reset(): void { this.armed.clear(); this.clients.clear(); this.netClients.clear(); this.bypassOn.clear(); this.netHeld.clear(); this.clientBypass.clear(); this.workers.clear(); this.given.clear(); this.held.clear(); this.tabUrls.clear(); this.floor = "unknown"; this.generation++; }

  /** The link came up: the receiver gets the guard's hosts at once, and says whether it has the floor. */
  linkUp(): Promise<void> { this.floor = "unknown"; this.generation++; return this.syncFloor(); }

  /** One bridge.mergeGuard at a time, with the hosts and every tab where the guard's Fetch is on (a full replace). */
  private syncFloor(): Promise<void> {
    const run = this.floorChain.then(async () => {
      if (this.floor === "absent") return;
      const generation = this.generation;
      const tabs = [...new Set([...this.armed].filter((k) => k.endsWith("|")).map((k) => Number(k.slice(0, -1))))].sort((a, b) => a - b);
      try {
        await this.o.op([{ hosts: [...this.hosts], tabs }]);
        // Only an answer of the current link confirms the floor.
        if (generation === this.generation) this.floor = "on";
      } catch (e) {
        const why = (e as Error).message;
        if (generation !== this.generation) return;
        if (why === "unknown op") {
          this.floor = "absent";
          this.o.log(`${GUARD_TEXT.logPrefix} the receiver has no floor (bridge.mergeGuard: unknown op): only the tabs that a client holds are guarded`);
        } else {
          // An error confirms no floor (fail closed) until a later answer does.
          this.floor = "unknown";
          this.notice(`floor ${why}`, `${GUARD_TEXT.logPrefix} bridge.mergeGuard failed (${why})`);
        }
      }
    });
    this.floorChain = run.catch(() => {});
    return run;
  }

  /** The tab's top URL (tabs.onUpdated, or a top-frame document request). */
  url(tabId: number, url: unknown): void { if (typeof url === "string" && url) this.tabUrls.set(tabId, url); }

  // ------------------------------------------------------------------ the requests

  /**
   * A Fetch.requestPaused or Fetch.authRequired of a tab's session. The guard answers it itself, or calls `o.forward` to give
   * it to the tab's owner (the model's delivery, which says false when no owner takes it; then the guard lets it go). A
   * request of a guarded host is judged (a write) or read (a PR's answer) first; the owner gets it after that only when its
   * own patterns ask for it, and then it may not change it. A refused write that the owner gets is answered by the guard's
   * 403 when the owner lets it go on. Any other pause goes to the owner when its patterns ask for it, else it goes on.
   */
  paused(tabId: number, sessionId: string | undefined, method: string, p: any, o: { topFrame: string | null; forward: () => boolean }): void {
    const k = this.key(tabId, sessionId), target: Target = sessionId ? { tabId, sessionId } : { tabId };
    const url = String(p?.request?.url ?? "");
    const base = this.base(url);
    const virtual = this.armed.has(k);
    const client = this.clients.get(k);
    const id = `${tabId}/${p.requestId}`;
    if (method === "Fetch.authRequired") {
      const auth = (response: string) => void this.o.send(target, "Fetch.continueWithAuth", { requestId: p.requestId, authChallengeResponse: { response } }).catch(() => {});
      if (base) return auth("CancelAuth");
      if (virtual && !client?.auth) return auth("Default");
      if (!this.give(id, k, { kind: "plain" }, o.forward, p)) auth("Default");
      return;
    }
    if (!sessionId && !atResponse(p) && p?.resourceType === "Document" && o.topFrame && p?.frameId === o.topFrame) this.url(tabId, url);
    const wants = virtual ? !!client && wanted(client.patterns, p) : true;
    if (base) { void this.guarded(target, tabId, k, p, base, wants, o.forward); return; }
    if (!wants || !this.give(id, k, { kind: "plain" }, o.forward, p)) void this.o.send(target, "Fetch.continueRequest", { requestId: p.requestId }).catch(() => {});
  }

  /** The owner gets a paused request (the model delivers it); the guard notes it so that its commands of it are checked. */
  private give(id: string, k: string, g: Omit<Given, "key" | "ev">, forward: () => boolean, p: any): boolean {
    this.given.set(id, { key: k, ...g, ev: { requestId: p.requestId, resourceType: p.resourceType, request: { headers: p.request?.headers } } });
    if (forward()) return true;
    this.given.delete(id);
    return false;
  }

  /** A paused request of a guarded host: a write is judged; a PR's answer is read for its markers; then the owner gets it, or it goes on. */
  private async guarded(target: Target, tabId: number, k: string, p: any, base: string, wants: boolean, forward: () => boolean): Promise<void> {
    const id = `${tabId}/${p.requestId}`;
    this.held.add(id);
    let gave = false;
    try {
      const req = p.request ?? {};
      const go = () => this.o.send(target, "Fetch.continueRequest", { requestId: p.requestId }).catch(() => {});
      if (atResponse(p)) {
        await this.read(target, p).catch(() => { this.counts.readFailed++; });
        this.held.delete(id);
        if (!(wants && (gave = this.give(id, k, { kind: "guarded", host: base }, forward, p)))) await go();
        return;
      }
      const method = String(req.method ?? "GET").toUpperCase();
      const reason = WRITE_FREE.has(method) ? null : this.judge(tabId, req);
      if (reason) {
        this.counts.refused++;
        this.counts[reason]++;
        this.notice(`${reason} ${base}`, `${GUARD_TEXT.logPrefix} refused a write to ${base} (${method}, tab ${tabId}): ${reason}; refused so far: ${this.counts.refused}`);
        const refusal = refusalOf(p, reason);
        // Each answer is sent before an await: the guard's command reaches Chrome before any later client command.
        this.held.delete(id);
        if (wants && (gave = this.give(id, k, { kind: "refused", host: base, refusal }, forward, p))) return;
        try { await this.o.send(target, "Fetch.fulfillRequest", refusal); }
        catch { await this.o.send(target, "Fetch.failRequest", { requestId: p.requestId, errorReason: "BlockedByClient" }).catch(() => {}); }
        return;
      }
      this.held.delete(id);
      if (!(wants && (gave = this.give(id, k, { kind: "guarded", host: base }, forward, p)))) await go();
    } finally { if (!gave) this.held.delete(id); }
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
    if (ownPage || ownObject) this.set(pr.key, "unmarked"); // set() keeps a marked PR marked: the one place of that rule
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
   * A client's Fetch or Network command on a page session, before it goes to Chrome: a refusal, the guard's own answer, or the
   * command that goes (with the guard's patterns kept on an armed session) and what runs after Chrome's answer.
   */
  command(tabId: number, sessionId: string | undefined, method: string, params: any): { refuse: string; instead?: [string, object] } | { answer: object } | { method: string; params: any; before?: [string, object][]; after?: () => void } {
    const k = this.key(tabId, sessionId), target: Target = sessionId ? { tabId, sessionId } : { tabId };
    const p = params ?? {};
    const armed = this.armed.has(k);
    if (method.startsWith("Network.")) {
      // The service worker's bypass (the lead's focused change; review-125b; the operator's ab-u92): the guard keeps the client's
      // own Network state on each session of an armed tab, and holds the calls of the bypass only while the bypass is on there.
      if (!armed) return { method, params: p };
      const on = this.bypassOn.has(k);
      if (method === "Network.setBypassServiceWorker") {
        if (p.bypass === true) this.clientBypass.add(k); else if (!on) this.clientBypass.delete(k);
        if (!on) return { method, params: p };
        return p.bypass === true ? { answer: {} } : { refuse: GUARD_TEXT.serviceWorker };
      }
      if (method === "Network.disable") { this.netClients.delete(k); return on ? { answer: {} } : { method, params: p }; }
      if (method === "Network.enable") {
        this.netClients.add(k);
        if (!on) return { method, params: p };
        return { method, params: p, after: () => { void this.o.send(target, "Network.setBypassServiceWorker", { bypass: true }).catch(() => {}); } };
      }
      return { method, params: p };
    }
    if (method === "Fetch.enable") {
      const patterns: Pattern[] = Array.isArray(p.patterns) ? p.patterns : [{ urlPattern: "*" }];
      this.clients.set(k, { patterns, auth: p.handleAuthRequests === true });
      return armed ? { method, params: { ...p, patterns: [...this.patterns, ...patterns] } } : { method, params: p };
    }
    if (method === "Fetch.disable") {
      this.clients.set(k, null);
      const held = [...this.given].filter(([, g]) => g.key === k);
      for (const [id] of held) this.given.delete(id);
      // Chrome's Fetch.disable lets every paused request go: on an armed session the guard's patterns stay, and the guard lets
      // the client's paused requests go itself (a refused write with the guard's 403). On another session Chrome lets them go.
      if (!armed) {
        const refused = held.filter(([, g]) => g.kind === "refused");
        return refused.length ? { method, params: p, before: refused.map(([, g]) => ["Fetch.fulfillRequest", g.refusal!] as [string, object]) } : { method, params: p };
      }
      return { method: "Fetch.enable", params: { patterns: [...this.patterns] }, after: () => {
        for (const [id, g] of held) {
          const requestId = id.slice(id.indexOf("/") + 1);
          void (g.kind === "refused" ? this.o.send(target, "Fetch.fulfillRequest", g.refusal!) : this.o.send(target, "Fetch.continueRequest", { requestId })).catch(() => {});
        }
      } };
    }
    if (typeof p.requestId === "string") {
      const id = `${tabId}/${p.requestId}`;
      if (this.held.has(id)) { this.counts.clientRefused++; return { refuse: GUARD_TEXT.badId }; }
      const g = this.given.get(id);
      const final = method !== "Fetch.getResponseBody" && method !== "Fetch.takeResponseBodyAsStream";
      if (g?.kind === "refused") {
        // The client lets a refused write go on: the guard's 403 goes in its place (its fulfill and its fail stand).
        if (method === "Fetch.continueRequest") { this.given.delete(id); return { method: "Fetch.fulfillRequest", params: g.refusal }; }
      } else if (method === "Fetch.continueRequest") {
        const host = typeof p.url === "string" ? this.base(p.url) : null;
        const changed = g?.kind === "guarded" && ["url", "method", "postData", "headers"].some((f) => p[f] !== undefined);
        if (host || changed) {
          // The guard answers the request itself (a 403 with the text), so it never waits for a client that ignores the error
          // (Playwright's route.continue drops a protocol error).
          this.counts.clientRefused++;
          const text = GUARD_TEXT.rewrite(host ?? g?.host ?? "github.com");
          if (g) this.given.delete(id);
          return g ? { refuse: text, instead: ["Fetch.fulfillRequest", refusalOf(g.ev, { text })] } : { refuse: text };
        }
      }
      if (final) this.given.delete(id);
    }
    return { method, params: p };
  }

  /** A Network event of a session where the guard turned Network on, that its client did not ask for (it did not turn Network on): no client gets it. */
  hidesNetwork(tabId: number, sessionId: string | undefined): boolean {
    const k = this.key(tabId, sessionId);
    return (this.bypassOn.has(k) || this.netHeld.has(k)) && !this.netClients.has(k);
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
