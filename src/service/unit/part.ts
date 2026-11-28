// The Chrome unit inside `agent-browser service`: stage 1b part 1 of the self-contained agent browser (the design,
// sections 5.1, 5.6 and 13.2; contract C12; board ab-v16.94.3). One part of the service (part.ts, ServicePart):
//
// - the ops `start` and `stop` of the control door (kind operator or token; the door logs each with its provenance),
//   which answer when Chrome runs or is gone; a stop's `stopped` event and `last_stop` carry its `by`;
// - the events `ready` (Chrome and Xvfb run after a start, a supervisor's restart, an adoption or a move), `chrome`
//   (its version and update state changed) and `stopped` (`stop`, `receiver_missing`, `sessions_unread`,
//   `start_failed`);
// - Chrome's facts in `status`: the state (off, starting, ready, failed closed) with an agent's text and an
//   operator's text, `chrome_kind`, `chrome_version`, `chrome_pid`, `update` and `last_stop`;
// - the owner parts of section 13.2, which run only while the owner rule says that the service owns: at its start the
//   adoption from the unit record (or a start of a wanted Chrome at the first `config`: build note 8; a `config` that
//   came before applies at once), the boot sweep of orphans (never on a record that cannot be read), then the 5 s
//   supervisor (it reads the owner state at each tick),
//   the 1 s fail-closed watch (watch.ts) and the Chrome updater (updates.ts).
//
// When the owner rule says no, the part stops its loops at once and `lost` resolves: the service closes its doors and
// exits. Chrome and Xvfb stay (they run detached) for the next owner.
//
// The start and the stop by use (board ab-v16.94.11; the operator's answer Q5 on board item ab-1n8; the design, section
// 19): the service's doors run at all times, and Chrome and Xvfb run only while agents use them.
//
// - The use signal (`use`, which the service builds): only an agent's real activity. An agent's open client connection of
//   the agent door (`client`), an agent's client message that the model handles (`request`), a send, an import, that runs
//   (`send`), an MCP tool call that runs (`mcp`), and each request that waits for the browser (`wake`, `waiting`).
//   `quietFor` gives the time since the last of these messages, sends and tool calls, so a use between two checks counts
//   too. The MCP's own CDP connection, an open MCP session, the model's own bridge calls and a tab's events are no use.
//   The blanket scope's connections, messages and tool calls are no use of this Chrome (board ab-4wh.24); the blanket
//   Chrome's own stop by use reads its own model's traffic (blanket/part.ts).
// - The start at a use (`wake`): a request that needs the browser while Chrome does not run starts Chrome and Xvfb (one
//   start for all the requests that wait), waits until its caller's check says ready, at most USE_WAIT_MS, then goes on.
//   The state is `starting` from its first moment, and the start sends `ready` with Chrome's pid. A start that fails
//   gives the waiting requests its error text and sends `stopped` with the reason `start_failed` once until a start works;
//   the requests of the next USE_RETRY_MS get the same error at once, with no new start.
// - The stop by use (each second, with the watch): when Chrome runs and nothing used it for the grace time (`config`'s
//   `idle_stop_minutes`, a whole number from 1 to 1440, default 10; `status` gives it), the service stops Chrome and
//   Xvfb (the owner rule first; Xvfb stays while the blanket Chrome runs on it: board ab-4wh.8) and sends `stopped`
//   with the reason `idle`. The profile stays on disk. It is no crash: the record says `wanted: false`, so the
//   supervisor starts nothing and the fail-closed watch counts no Chrome. A request that comes during the stop waits
//   for its end, then starts Chrome again. A newer Google Chrome that waits (`update` `pending`) moves at this stop:
//   the next start runs it.
// - The Mac's end (board ab-xxh): on the Mac an end of the agent Chrome that no stop of the service caused (the
//   operator's quit, the last window closed, or a crash: they look the same) is a stop by use too. The first of the
//   part's watch (each second, after the owner rule), the supervisor's check and a start takes the end: the record says
//   `wanted: false`, that Chrome's link drops, a run of fail-closed stops ends, and `stopped` goes out with the reason
//   `idle`. The state is `off` from the end on, and a use starts Chrome, also before the end is taken and once for a
//   request that waits while Chrome ends.
//
// The Mac (board ab-v16.94.6; the design, section 10), with `mac`: at each check of the watch the give-back watcher runs for
// the running agent Chrome (and for none while none runs), and every MAC_VERSION_EVERY_MS the part compares the version
// that the agent Chrome runs with the version that the operator's running Chrome runs. When the operator's Chrome runs a
// newer version (its relaunch after an update), the app's version on disk is newer than the agent Chrome's too, and no
// agent's client is connected, no bridge request is in flight and no send runs, the agent Chrome starts again (the owner
// rule first), at the version on disk. An agent Chrome that runs ahead of the operator's (it started while the operator's
// Chrome waited for "Relaunch to update") does not start again, and a start that would run the same version never comes,
// so the check never loops (review-145 B1). Like a move on Linux, the restart sends `ready`, not `stopped`. The version on
// disk is read only after the activity check (review-145b N4). The fail-closed watch waits up to LOAD_HOLD_MS for a
// Chrome's first receiver (the operator's one-time "Load unpacked", board ab-v16.94.19), and the operator's text says
// what to load and where while it waits (`notes`). When the agent profile shows that Chrome turned the receiver off (a
// Chrome update, or developer mode off; board ab-v16.116, access.ts receiverOff), the operator's text gives that sentence
// and one more after it until a receiver links again, and a send's wait that ends with no receiver names it. Before a
// start whose Chrome version differs from the profile's `Last Version`, and 15 s after it, the service logs the profile's
// guarded settings (board ab-v16.118: developer mode, the reset time and the receiver's entry; access.ts guardedSettings).
//
// C12's `receiver_off` (board ab-v16.118), on Linux and on the Mac: the first off read for each agent Chrome (one for no
// Chrome) sends the event once, and `status` gives the latest off read, until a read that says not off or a receiver's
// link-up; a read right before each start of Chrome (after the unit's own writes) counts for the Chrome that it starts.
//
// The move of the agent extension (board ab-v16.81; C12, the agent package; agentwatch's _start_unit): on Linux the
// unit stages the receiver's CRX through Chrome's external extensions file, and while an older receiver runs in the
// profile, Chrome installs the newer CRX only as a delayed install (Preferences: `idle_install_info`,
// `delay_install_reason` 2): the old receiver holds its native port, so it never goes idle, runs that whole Chrome run,
// and only the next start loads the new one. So a start (the op `start`, a start at a use) that starts a new Chrome with
// a staged package waits up to RECEIVER_HELLO_WAIT_MS for the first hello of that Chrome; a hello older than the package
// starts Chrome once more, before the start answers and before `ready` (moveReceiver). While a start runs, a new
// connection counts the link as down and a request waits for the start's end (`startHolds`, `wake`), so no agent's
// request reaches the first Chrome.

import { join } from "node:path";
import { ERR, type Answer, type By, type Req } from "../control.ts";
import type { EndpointState } from "../agent-door.ts";
import type { ServicePart } from "../part.ts";
import type { ChromeTools } from "./google-chrome.ts";
import type { Owner } from "./owner.ts";
import type { UnitPaths } from "./paths.ts";
import type { Procs } from "./procs.ts";
import { ChromeUnit, configFrom, KIND_GOOGLE, NotOwnerError, StartError, SUPERVISE_MS, type UnitDeps, type UnitEvent } from "./unit.ts";
import { ChromeMover, ChromeUpdater, CHECK_EVERY_MS, FIRST_CHECK_MS, type Activity } from "./updates.ts";
import { MAC_VERSION_EVERY_MS, MAC_VERSION_RE, macNewer, type MacApp } from "./mac-chrome.ts";
import { PACKAGE_FOLDER } from "../package/crx.ts";
import { accessKey, accessLine, accessNote, DEVELOPER_MODE_REASON, guardedSettings, isOff, lastVersion, offFields, offKey, offLine, receiverAccess, receiverOff, versionChangeHead, type AccessWhen, type OffFields, type OffWhen, type ReceiverAccess, type ReceiverOff } from "./access.ts";
import { RECEIVER_OFF_SEND_TEXT } from "../signin/send-text.ts";
import { FailClosedWatch, LOAD_HOLD_MS, LOAD_NOTE_MS, monotonicMs, NO_LINK, RECEIVER_MISSING_MS, type LinkPort, type WatchStop } from "./watch.ts";

/**
 * The Mac: what the operator does once for each agent profile (board ab-v16.94.19): the steps and the agent package's
 * folder. The last step gives the receiver's incognito access in the same sitting: on the Mac Chrome keeps the
 * receiver's settings in `Secure Preferences` and drops the service's write, so only the operator gives it (board
 * ab-v16.94.34; access.ts). An unpacked extension has access to local files by default.
 */
/** The kinds of a stop of Chrome (beforeStop): the op `stop`, `enabled: false`, the stop by use, the fail-closed watch, a move. */
export type StopWhy = "stop" | "off" | "idle" | "watch" | "move";

export const loadNote = (state: string) =>
  `in the agent Chrome open chrome://extensions, turn on Developer mode, click Load unpacked and choose the folder ${join(state, PACKAGE_FOLDER)} (Command-Shift-G in that dialog takes a path), then click Details of the agent extension and turn on 'Allow in Incognito'`;

/**
 * The Mac (board ab-v16.116): the operator's sentence after the load sentence (C12's, which stays as it is) when the agent
 * profile shows that Chrome turned the receiver off with the reason of developer mode (access.ts, DEVELOPER_MODE_REASON):
 * developer mode went off, or a Chrome update kept only a stub of the receiver's entry with that reason (Chrome 158 after
 * 157, 2026-11-24). The load sentence's steps load it again.
 */
export const RECEIVER_OFF_TEXT = "Chrome turned the agent extension off in the agent Chrome (Developer mode is off, or a Chrome update removed the extension). Do these Load unpacked steps again, and keep Developer mode on.";
/**
 * The Mac's sentence after the load sentence for the `reasons` of a receiver that Chrome turned off (review of board
 * ab-v16.116, M4): RECEIVER_OFF_TEXT with the reason of developer mode, else a general sentence that names the reasons.
 */
export const receiverOffNote = (reasons: readonly number[]): string => reasons.includes(DEVELOPER_MODE_REASON) ? RECEIVER_OFF_TEXT
  : `Chrome lists the agent extension as turned off in the agent Chrome (${reasons.length === 1 ? "disable reason" : "disable reasons"} ${reasons.join(", ")}): in chrome://extensions turn it on; if Chrome does not list it, do these Load unpacked steps again.`;

/**
 * While the receiver's access on the running Chrome is missing or unknown, the service reads the profile's files again
 * this often (board ab-v16.94.34): Chrome writes them some seconds after a change (its pref store writes at most once in
 * 10 s), so the read at the link-up that follows the operator's switch can find the old files.
 */
export const ACCESS_REREAD_MS = 30_000;

/**
 * The Chrome of the read right before a start of Chrome (board ab-v16.118): no Chrome runs yet, and the read counts for
 * the Chrome that the start starts (the first one that runs after it).
 */
const NEXT_CHROME = "next";

export const WATCH_MS = 1000;
/** A run of fail-closed stops ends when a Chrome is still up this long past the watch's limit (board ab-v16.111). */
export const RUN_END_MARGIN_MS = 5000;
/** The ops of stage 1b part 1 (C12, "The ops of stage 1b part 1"). */
export const STAGE_1B1_OPS = ["start", "stop"] as const;

/** The texts of each state (I2: no agent's text names a stop or a start; the gateway gives the operator's text to a password login only). */
export const STATE_TEXTS = {
  off: { agent_text: "The agent browser is not running; it gets ready when an agent uses it.", operator_text: "The agent browser is not running. It starts at the next use by an agent." },
  starting: { agent_text: "The agent browser is getting ready; try again in a few seconds.", operator_text: "The agent browser is starting." },
  ready: { agent_text: "The agent browser is ready.", operator_text: "The agent browser is ready." },
  "failed closed": {
    agent_text: "The agent browser is not running: its extension did not answer in time, so it closed for safety.",
    operator_text: "The agent browser stopped itself: its extension did not confirm the site lists in 60 s (no allowlist block without it). The next use by an agent starts it again.",
  },
} as const;
export type State = keyof typeof STATE_TEXTS;
/**
 * The operator's text of `failed closed` on the Mac after the watch stopped a Chrome on which no receiver ever linked: it
 * names the wait that applied, LOAD_HOLD_MS, not the 60 s (board ab-v16.94.33; the Mac check B1.3: the stop came at 301 s).
 */
export const FAILED_CLOSED_FIRST_LINK_TEXT = "The agent browser stopped itself: its extension did not confirm the site lists in 5 minutes, the wait for a new agent Chrome's first link on this Mac (no allowlist block without it). The next use by an agent starts it again.";
/** The answer of an owner part that the owner rule refused. */
export const NOT_OWNER = "the agent-browser service does not own the agent browser now";
const FAIL_CLOSED = new Set(["receiver_missing", "sessions_unread"]);

/** The grace time of the stop by use (board ab-v16.94.11): `config`'s `idle_stop_minutes`, else this many minutes. */
export const IDLE_STOP_DEFAULT_MINUTES = 10;
export const IDLE_STOP_MAX_MINUTES = 1440;
/** How long a request that needs the browser waits for it at a use (the start, then its caller's check). */
export const USE_WAIT_MS = 60_000;
/** After a start at a use failed, the requests of this time get its error at once, with no new start. */
export const USE_RETRY_MS = 10_000;
/** After a fail-closed stop, a use starts Chrome again at most once in this time (the watch's 60 s or more). */
export const FAIL_HOLD_MS = 60_000;
/** The 503 of a use of the blanket scope in that time (board ab-4wh.25; I2: it names no stop and no start). */
export const FAIL_HOLD_TEXT = "The agent browser is not ready: it closed for safety less than 60 s ago, and it gets ready again at an agent's use after that time.";
const USE_POLL_MS = 100;
/** The text of a request whose start at a use failed: the start's error text is the reason (I2: it names no command). */
export const useFailed = (reason: string) => `The agent browser could not get ready: ${reason.replace(/[.\s]+$/, "")}.`;

/**
 * A start that started a new Chrome with a staged agent package waits this long for the first hello of that Chrome's
 * receiver (board ab-v16.81; C12, the agent package).
 */
export const RECEIVER_HELLO_WAIT_MS = 30_000;
const DOTTED_RE = /^[0-9]{1,9}(\.[0-9]{1,9}){0,3}$/;

/**
 * True when the receiver's hello `said` a version older than the `staged` package's, compared as dotted integers (a
 * missing part counts as 0). A version that is not one to four dotted integers, on either side, is never older: no extra
 * start (agentwatch's extension_older; board ab-v16.81).
 */
export function extensionOlder(said: string | null, staged: string | null): boolean {
  if (typeof said !== "string" || typeof staged !== "string" || !DOTTED_RE.test(said) || !DOTTED_RE.test(staged)) return false;
  const a = said.split(".").map(Number), b = staged.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

/**
 * The answer of a start whose move of the agent extension failed in its stop or its second start with an error that is
 * no start error (agentwatch's EXTENSION_MOVE_FAILED_TEXT): the error's kind only, never its text (board ab-v16.81).
 */
export const extensionMoveFailed = (step: "stop" | "start", staged: string, kind: string) =>
  `the agent browser could not ${step === "stop" ? "stop Chrome" : "start Chrome again"} to move the agent extension to ${staged} (${kind})`;

/** `config`'s `idle_stop_minutes`: a whole number from 1 to IDLE_STOP_MAX_MINUTES, else null (the default applies). */
export function idleStopMinutes(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v <= IDLE_STOP_MAX_MINUTES ? v : null;
}

/**
 * The use of the browser (board ab-v16.94.11), which the service builds from its doors, its link and its MCP path: only an
 * agent's real activity.
 */
export type UseSignal = {
  /**
   * The sources that use the browser now, by name: `client` (an agent's open client connection of the agent door),
   * `request` (an agent's client message that the model handles), `send` (an import that runs), `mcp` (an MCP tool call
   * that runs); empty when none does. Only the main Chrome's scopes count, never the blanket scope (board ab-4wh.24).
   */
  now(): string[];
  /** ms since the last agent's client message, send or MCP tool call came or ended (Infinity before one). */
  quietFor(): number;
};

export type UnitPartOptions = {
  paths: UnitPaths;
  procs: Procs;
  tools: ChromeTools;
  owner: Owner;
  log: (line: string) => void;
  /** The agent door's peer check state (the `ready` event's `endpoint`). */
  endpoint: () => EndpointState;
  /** A complete set_sessions came. */
  sessionsComplete: () => boolean;
  /** The native link (part 2); stage 1b part 1 has none. */
  link?: LinkPort;
  /** The agent extension's version (part 2: the receiver's hello, else the agent package that the start staged), or null. */
  extensionVersion?: () => string | null;
  /** After each `ready` (part 2: the end of the old owner's host, by note 7). */
  onReady?: () => void;
  /**
   * Right before each stop of Chrome, also the stop of a Chrome move and of its way back (part 2: the X pointer's playing
   * path is killed), with the stop's kind (board ab-4wh.3: the blanket Chrome on the same Xvfb stops too, and its folder
   * goes at the daemon's `stop` and at `enabled: false`).
   */
  beforeStop?: (why: StopWhy) => void;
  /**
   * After each stop of Chrome (the op `stop`, the fail-closed watch's, the stop by use, `enabled: false`, the stop of a
   * Chrome move and of its way back), also one that failed, and before its `stopped`; when the supervisor finds Chrome
   * gone (a crash); and when a start finds Chrome gone before that check, or stops a Chrome whose display is gone (part 2:
   * the stopped or gone Chrome's link goes down; boards ab-b84.33, ab-b84.34, ab-b84.36 and ab-b84.37).
   */
  linkDown?: () => void;
  activity?: Partial<Activity>;
  /** The use signal (board ab-v16.94.11); with none, only the requests that wait (`wake`) are a use. */
  use?: UseSignal;
  /** Tests only: the wait of a request at a use, and its poll. */
  useWaitMs?: number;
  usePollMs?: number;
  /** Tests only: the read of the receiver's access (access.ts, receiverAccess). */
  accessRead?: typeof receiverAccess;
  /** Tests only: the read of whether Chrome turned the receiver off (access.ts, receiverOff). */
  offRead?: typeof receiverOff;
  /** The unit's displays and programs (tests: also its processes, clock and spawn). */
  unit: Partial<UnitDeps> & Pick<UnitDeps, "displayFs" | "which">;
  clock?: () => number;
  wall?: () => number;
  superviseMs?: number;
  watchMs?: number;
  watchLimitMs?: number;
  firstCheckMs?: number;
  checkEveryMs?: number;
  /**
   * The Mac (board ab-v16.94.6): the give-back watcher of the running agent Chrome, and the versions that the agent Chrome
   * and the operator's running Chrome run now (mac-chrome.ts, chromeVersions); `everyMs`: tests only.
   */
  mac?: {
    watcher: { tick(chrome: { pid: number; start: number | null } | null): void; stop(): void };
    versions(app: MacApp, agentPid: number): { agent: string | null; operator: string | null };
    /** The app's version on disk now (mac-chrome.ts, appVersion), or null. */
    disk(app: MacApp): string | null;
    everyMs?: number;
  };
};

export class UnitPart implements ServicePart {
  readonly ops: Readonly<Record<string, (req: Req) => Promise<Answer>>>;
  readonly unit: ChromeUnit;
  readonly watch: FailClosedWatch;
  readonly updater: ChromeUpdater;
  readonly mover: ChromeMover;
  private readonly o: UnitPartOptions;
  private readonly clock: () => number;
  private readonly wall: () => number;
  private emitFn: (ev: Record<string, unknown>) => void = () => {};
  private lastStop: { reason: string; at: string; by: By | null } | null = null;
  /** The record said `wanted` and no Chrome could be adopted: it starts at the first `config` (build note 8). */
  private pendingStart = false;
  /** The Chrome (pid and start time) of the last `ready`: each Chrome gets one `ready` (C12). */
  private lastReady = "";
  private lastChrome = "";
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private wakers = new Set<() => void>();
  private closed = false;
  private loops: Promise<void>[] = [];
  // The start and the stop by use (board ab-v16.94.11).
  /** The grace time in minutes (`config`'s `idle_stop_minutes`). */
  private idleMinutes = IDLE_STOP_DEFAULT_MINUTES;
  /** The last moment (the monotonic clock) at which something used the browser, or a Chrome started. */
  private lastUse: number;
  /** The requests that wait for the browser now (`wake`). */
  private waiters = 0;
  /** The one start at a use for all the requests that wait; null while none runs. */
  private useStart: Promise<string | null> | null = null;
  /** The last start at a use that failed, and its text, for USE_RETRY_MS; `useFailTold`: its `stopped` event went out. */
  private useFail: { at: number; text: string } | null = null;
  private useFailTold = false;
  /** The stop by use while it runs: a request that comes waits for its end. */
  private idleStop: Promise<void> | null = null;
  /** A start at a use runs (the `ready` of its Chrome marks that Chrome as started by a use). */
  private startingByUse = false;
  /** The running Chrome was started by a use, and since when it runs (the monotonic clock). */
  private chromeByUse = false;
  private readyAt: number | null = null;
  /** The Chrome (pid:start) that readyAt belongs to (board ab-v16.111: a new Chrome before its ready() has no readyAt yet). */
  private readyFor: string | null = null;
  /** The time of the last fail-closed stop, and whether a run of fail-closed stops after starts at a use goes on. */
  private failClosedAt: number | null = null;
  private failRun = false;
  /** The keys of the last config, as JSON: a change clears the hold-off of a failed start (review-120 note 11). */
  private lastConfig = "";
  /**
   * The Mac: the last version check (the monotonic clock); the versions (agent/operator) of the last wait that the log
   * named, of the last read of the version on disk, and of the last read that failed and that the log named.
   */
  private macCheckedAt: number | null = null;
  private macWait = "";
  private macRead = "";
  private macUnread = "";
  /**
   * The receiver's access in the profile of the running Chrome (board ab-v16.94.31): that Chrome (`pid:start`), the
   * last read's result and its time (the monotonic clock). `linkUpFor`: the Chrome whose receiver's link the watch's
   * last check saw ("" for none); `linkHellos`: the link's count of hellos at that check (board ab-v16.94.34).
   */
  private access: { chrome: string; result: ReceiverAccess; at: number } | null = null;
  /**
   * Whether Chrome turned the receiver off (board ab-v16.116): the latest read, with its Chrome (`pid:start`, or "" for
   * none), its result and its time (the monotonic clock); a receiver's link-up clears it.
   */
  private off: { chrome: string; result: ReceiverOff; at: number } | null = null;
  /**
   * C12's `receiver_off` (board ab-v16.118): the Chrome whose off state the event told (`pid:start`, "" for none, or
   * NEXT_CHROME for the Chrome of a start), and the status field: the latest off read's fields and time. A read that says
   * not off, or a receiver's link-up, clears it; an unknown read changes nothing.
   */
  private offTold: { chrome: string; fields: OffFields; at: string } | null = null;
  /**
   * The Mac (board ab-v16.118): the log line's start of a start whose Chrome version differs from the profile's `Last
   * Version`, the Chrome that it started (null until the part's loop sees one run) and since when that Chrome runs; its
   * line after the start comes at the watch's 15 s note, or 15 s after the start when a receiver links before that note.
   */
  private versionChange: { head: string; chrome: string | null; since: number } | null = null;
  private linkUpFor = "";
  private linkHellos = 0;
  /** The startBrowser calls that run (board ab-v16.81): while one runs, a new connection waits (`startHolds`). */
  private startRuns = 0;
  /** The receiver check of a start that started a new Chrome, with its move (moveReceiver); each start joins it. */
  private receiverMove: Promise<void> | null = null;
  /** The stops of Chrome that the moves made: a start at a use counts only the other stops as a stop during it. */
  private moveStops = 0;

  constructor(o: UnitPartOptions) {
    this.o = o;
    this.clock = o.clock ?? monotonicMs;
    this.wall = o.wall ?? Date.now;
    this.lastUse = this.clock();
    const mayAct = (what: string) => o.owner.check(what);
    this.updater = new ChromeUpdater({ tools: o.tools, file: o.paths.updateFile, wanted: () => !!this.unit.config?.enabled && !this.unit.config.chromeBin, log: o.log });
    this.unit = new ChromeUnit({
      paths: o.paths, procs: o.procs, tools: o.tools, log: o.log, clock: this.clock, wall: this.wall,
      refused: () => this.updater.refused(), mayAct, nap: (ms) => this.nap(ms),
      // A start that finds Chrome gone first drops its link too (board ab-b84.37), as the supervisor's `gone` does.
      gone: () => this.linkDown(), ended: () => this.macEnd(), beforeChrome: (version) => this.beforeChrome(version), ...o.unit,
    });
    const link = o.link ?? NO_LINK;
    this.watch = new FailClosedWatch({
      file: o.paths.watchFile, bootId: () => o.procs.bootId(), clock: this.clock, link, log: o.log, limitMs: o.watchLimitMs,
      sessionsComplete: o.sessionsComplete, chrome: () => this.unit.chromeId(), stop: (reason) => this.failClosed(reason),
      // The Mac: the wait for the operator's one-time "Load unpacked" (board ab-v16.94.19).
      // The watch's note after 15 s with no receiver reads whether Chrome turned it off (board ab-v16.116).
      // The Mac's line of the guarded settings after a start at a Chrome version change comes at that note too (board ab-v16.118).
      ...(o.mac ? { hold: { ms: LOAD_HOLD_MS, note: () => { this.checkOff("note"); this.versionChangeAfter(this.chromeKey() ?? ""); return loadNote(o.paths.state); } } } : {}),
    });
    const a = o.activity ?? {};
    this.mover = new ChromeMover({
      unit: this.unit, updater: this.updater, clock: this.clock, wall: this.wall, mayAct, log: o.log, onChange: () => this.chromeChanged(), onStarted: () => this.ready(),
      // The move's stop and its way back's drop the stopped Chrome's link too: their start can fail, and Chrome stays off (board ab-b84.36).
      stop: () => this.stopUnit("move"),
      activity: { inFlight: a.inFlight ?? (() => 0), idleFor: a.idleFor ?? (() => Infinity), importing: a.importing ?? (() => false), clients: a.clients ?? (() => false), sinceSend: a.sinceSend ?? (() => Infinity) },
    });
    this.ops = { start: (req) => this.startBrowser(req.by), stop: (req) => this.stopBrowser(req.by) };
  }

  attach(emit: (ev: Record<string, unknown>) => void): void { this.emitFn = emit; }
  private emit(ev: Record<string, unknown>): void { if (!this.closed) this.emitFn(ev); }

  // ------------------------------------------------------------------ the status and the events

  state(): State {
    // A request that waits for the end of a stop by use starts Chrome next (review-120 note 6).
    if (this.idleStop !== null && this.waiters > 0) return "starting";
    // A start's receiver check or move (board ab-v16.81): the start has not answered, and `ready` has not gone out.
    if (this.receiverMove !== null) return "starting";
    if (this.unit.running()) return "ready";
    if (this.unit.starting || this.useStart !== null || this.pendingStart) return "starting";
    // The Mac (board ab-xxh): a Chrome that ended with no stop of the service is off at once, before the supervisor's check.
    if (this.unit.endedOnMac()) return "off";
    if (this.unit.wanted && this.unit.config?.enabled !== false) return "starting";
    if (this.lastStop && FAIL_CLOSED.has(this.lastStop.reason)) return "failed closed";
    return "off";
  }

  status(): Record<string, unknown> {
    // The Mac: the status read of the off check first (offReasons, at most every 30 s), so `receiver_off` and the
    // operator's sentences of this answer come from the same read (board ab-v16.118).
    if (this.o.mac) this.offReasons();
    const state = this.state();
    const f = this.unit.chromeFacts();
    const texts = state === "failed closed" && this.watch.stoppedBeforeLink() ? { ...STATE_TEXTS[state], operator_text: FAILED_CLOSED_FIRST_LINK_TEXT } : STATE_TEXTS[state];
    return {
      state, ...texts,
      chrome_kind: f?.kind ?? null, chrome_version: f?.version || null, chrome_pid: f ? this.unit.chromePid() : null,
      extension_version: f ? this.extensionVersion() : null, update: this.mover.updateState(),
      last_stop: this.lastStop ? { ...this.lastStop, by: this.lastStop.by ? { ...this.lastStop.by } : null } : null,
      idle_stop_minutes: this.idleMinutes,
      // C12's `receiver_off` (board ab-v16.118): the latest off read, or null.
      receiver_off: this.offTold ? { ...this.offTold.fields, reasons: [...this.offTold.fields.reasons], at: this.offTold.at } : null,
    };
  }

  /**
   * The operator's sentences: a start at a use that failed (its error text), while it holds; and on the Mac, while the
   * agent Chrome runs with no agent extension (or the watch stopped one that never had it), what to load and where. On
   * the Mac, while the latest read says that Chrome turned the receiver off (board ab-v16.116), whichever Chrome it was
   * for and also with no Chrome, the same sentence and after it receiverOffNote's, until a receiver links again.
   */
  notes(): { agent: string[]; operator: string[] } {
    const f = this.useFail, operator: string[] = [];
    if (f && !this.unit.running()) operator.push(`The last start at an agent's use failed: ${f.text.replace(/[.\s]+$/, "")}.`);
    const off = this.o.mac ? this.offReasons() : null;
    if (this.o.mac && (off !== null || (this.watch.awaitsLoad() && (this.unit.running() || this.state() === "failed closed")))) {
      operator.push(`The agent extension did not connect to the agent Chrome. If it is not loaded there yet: ${loadNote(this.o.paths.state)}.`);
      if (off !== null) operator.push(receiverOffNote(off));
    }
    const a = this.access, id = this.unit.running() ? this.unit.chromeId() : null;
    // The sentence says what needs each access on this system (board ab-v16.105): the Mac's text, as for the read.
    const note = a && id && a.chrome === `${id.pid}:${id.start}` ? accessNote(a.result, { mac: !!this.o.mac }) : null;
    if (note) operator.push(note);
    return { agent: [], operator };
  }

  /** The running Chrome as `pid:start`, or null when none runs (board ab-v16.111). */
  private chromeKey(): string | null {
    const id = this.unit.running() ? this.unit.chromeId() : null;
    return id ? `${id.pid}:${id.start}` : null;
  }

  private ready(): void {
    // A start that succeeded (or an adoption): no start waits for a config any more (review-106 B1).
    this.pendingStart = false;
    if (this.unit.running()) {
      this.useFail = null; this.useFailTold = false;
      this.chromeByUse = this.startingByUse;
      this.readyAt = this.clock();
      this.readyFor = this.chromeKey();
    }
    const f = this.unit.chromeFacts();
    const id = this.unit.chromeId();
    if (!f || !id) return;
    // One `ready` for each Chrome: a start op that meets the supervisor's restart sends none of its own.
    const key = `${id.pid}:${id.start}`;
    if (key === this.lastReady) return;
    this.lastReady = key;
    this.emit({ t: "ev", ev: "ready", chrome_pid: this.unit.chromePid(), chrome_version: f.version || null, extension_version: this.extensionVersion(), endpoint: this.o.endpoint() });
    this.chromeChanged();
    try { this.o.onReady?.(); } catch (e) { this.o.log(`unit: the step after ready failed (${(e as Error).name})`); }
  }

  /**
   * The receiver's access check (board ab-v16.94.31): at the adoption of a running Chrome, at each link-up of a
   * receiver, and while the result is missing or unknown every ACCESS_REREAD_MS (board ab-v16.94.34), a read of the
   * profile's files (access.ts), never a write while Chrome runs. A missing key or an unknown access gets a sentence of
   * the operator's text while that Chrome runs, and one log line for each new result of a Chrome (a first result that
   * finds the access gets none). Where the receiver's entry comes from `Preferences`, the service's next start of Chrome
   * writes the keys (unit.ts, writeDownloadPrefs); where it comes from `Secure Preferences` (the Mac), only the
   * operator's switch 'Allow in Incognito' gives the incognito access, and the sentence names it (Chrome gives an
   * unpacked extension access to local files by itself). It never refuses the adoption.
   */
  private checkAccess(when: AccessWhen): void {
    const id = this.unit.running() ? this.unit.chromeId() : null;
    if (!id) return;
    const chrome = `${id.pid}:${id.start}`;
    const result = (this.o.accessRead ?? receiverAccess)(this.o.paths.preferences, { mac: !!this.o.mac });
    const last = this.access?.chrome === chrome ? accessKey(this.access.result) : null;
    this.access = { chrome, result, at: this.clock() };
    const key = accessKey(result);
    if (key !== last && (last !== null || result.state !== "ok")) this.o.log(accessLine(when, result, this.o.paths.profile, id.pid));
  }

  /**
   * Board ab-v16.116: a read-only check whether Chrome turned the receiver off in the agent profile (access.ts,
   * receiverOff), for the Chrome `chrome` (`pid:start`; the running one by default, "" for none), and one log line for
   * each new result of a Chrome. Its moments: the watch's 15 s note on the Mac, the end of a use's or a send's wait
   * with no receiver, the watch's stop of a Chrome with no receiver on the Mac, and the Mac's status read while the load
   * sentence applies or after an off read (offReasons). It never throws.
   */
  private checkOff(when: OffWhen, chrome: string = this.chromeKey() ?? ""): ReceiverOff {
    let result: ReceiverOff;
    try { result = (this.o.offRead ?? receiverOff)(this.o.paths.preferences); }
    catch (e) { result = { unknown: `the read failed (${(e as Error).name})` }; }
    const last = this.off?.chrome === chrome ? offKey(this.off.result) : null;
    this.off = { chrome, result, at: this.clock() };
    const pid = this.pidOf(chrome);
    // The read right before a start logs only a result that is off or unknown (board ab-v16.118): each start reads.
    if (offKey(result) !== last && (when !== "start" || !("off" in result) || result.off)) {
      try { this.o.log(offLine(when, result, this.o.paths.profile, pid)); } catch {}
    }
    this.tellOff(chrome, result, pid);
    return result;
  }

  /** The pid of a Chrome key (`pid:start`), or null ("" and NEXT_CHROME: no Chrome runs). */
  private pidOf(chrome: string): number | null {
    const pid = chrome ? Number(chrome.split(":")[0]) : NaN;
    return Number.isSafeInteger(pid) ? pid : null;
  }

  /**
   * C12's `receiver_off` (board ab-v16.118) after an off check of the Chrome `chrome`: an off read sets the status field;
   * a not-off read clears it and the event's state; an unknown read sends nothing and changes nothing. The event goes out
   * at most once for each agent Chrome (the daemon lead's rule): when the off state begins (no event since the last
   * clear), and when the read is for a new agent Chrome. The read right before a start (NEXT_CHROME) is for the Chrome
   * that the start starts: a later read of that Chrome is not new (the part's loop, or that read, ties it to the Chrome).
   * A read while no Chrome runs ("") is for no new Chrome: while the off state goes on it sends nothing, and the event's
   * state stays with its Chrome.
   */
  private tellOff(chrome: string, r: ReceiverOff, pid: number | null): void {
    if ("unknown" in r) return;
    if (!r.off) { this.offTold = null; return; }
    const fields = offFields(r.reasons, pid), at = this.isoNow();
    const told = this.offTold?.chrome ?? null;
    if (told !== null && (told === chrome || chrome === "")) { this.offTold = { chrome: told, fields, at }; return; }
    if (told === NEXT_CHROME && chrome !== NEXT_CHROME) { this.offTold = { chrome, fields, at }; return; }
    this.offTold = { chrome, fields, at };
    this.emit({ t: "ev", ev: "receiver_off", ...fields, reasons: [...fields.reasons] });
  }

  /** A receiver linked (board ab-v16.116 and ab-v16.118): the latest off read, the event's state and the status field end. */
  private clearOff(): void { this.off = null; this.offTold = null; }

  /** The time now in UTC, ISO 8601 with whole seconds (`last_stop`'s `at`, and `receiver_off`'s; board ab-v16.118). */
  private isoNow(): string { return new Date(this.wall()).toISOString().replace(/\.\d{3}Z$/, "Z"); }

  /**
   * The step right before each start of Chrome, after the unit's own writes into the profile (unit.ts, beforeChrome;
   * board ab-v16.118). On the Mac, when the start's Chrome `version` differs from the profile's `Last Version` (both of
   * the form a.b.c.d), one log line of the profile's guarded settings (access.ts guardedSettings), and the same line again
   * after the start (versionChangeAfter). On every system an off check, which counts for the Chrome that the start starts:
   * when it says off, C12's `receiver_off` goes out now with `chrome_pid` null, and on the Mac the operator's sentences
   * show. It never throws.
   */
  private beforeChrome(version: string): void {
    if (this.o.mac) {
      // A line that waits for an earlier start's Chrome belongs to that Chrome only: a new start drops it (board ab-v16.118).
      // A start that fails before Chrome writes `Last Version` logs its first line again at the next start.
      this.versionChange = null;
      try {
        const last = lastVersion(this.o.paths.profile);
        if (last !== null && MAC_VERSION_RE.test(last) && MAC_VERSION_RE.test(version) && last !== version) {
          const head = versionChangeHead(version, last, this.o.paths.profile);
          this.o.log(`${head}, before the start: ${guardedSettings(this.o.paths.preferences)}`);
          this.versionChange = { head, chrome: null, since: this.clock() };
        }
      } catch {}
    }
    this.checkOff("start", NEXT_CHROME);
  }

  /**
   * The Mac: the line of the guarded settings after a start at a Chrome version change, once, for the Chrome of that start
   * (board ab-v16.118): a line that the part's loop tied to another Chrome is dropped, never logged with this one's pid.
   */
  private versionChangeAfter(chrome: string): void {
    const v = this.versionChange;
    if (!v) return;
    this.versionChange = null;
    if (v.chrome !== null && v.chrome !== chrome) return;
    const pid = this.pidOf(chrome);
    try { this.o.log(`${v.head}, 15 s after the start${pid === null ? "" : ` (Chrome pid ${pid})`}: ${guardedSettings(this.o.paths.preferences)}`); } catch {}
  }

  /**
   * The Mac (board ab-v16.116; review M1 and M2): the reasons of the latest read when it says off, else null. The latest
   * read decides, whichever Chrome it was for (the running one, the one that the watch stopped, or none at a send), until
   * a receiver links again: a link-up clears it. While Chrome runs and the load sentence applies or the latest read says
   * off, the status read reads again when no read is for that Chrome or the last is ACCESS_REREAD_MS old (Chrome writes
   * its files some seconds after a change, so a later read sees what an earlier one missed).
   */
  private offReasons(): number[] | null {
    const running = this.chromeKey();
    if (running !== null && (this.o.link ?? NO_LINK).ready()) { this.clearOff(); return null; }
    const a = this.off;
    if (running !== null && (this.watch.awaitsLoad() || isOff(a?.result)) && (a === null || a.chrome !== running || this.clock() - a.at >= ACCESS_REREAD_MS)) this.checkOff("status", running);
    const r = this.off?.result;
    return isOff(r) ? r.reasons : null;
  }

  /**
   * The send's error after its wait for the receiver ended with none (stage1c.ts, board ab-v16.116): a read now, and
   * when Chrome turned the receiver off, the send's text of this system (send-text.ts RECEIVER_OFF_SEND_TEXT: the Mac's
   * names the Browser pane's Load unpacked steps, Linux's none); else null, and the send keeps RECEIVER_MISSING_TEXT.
   */
  receiverOffText(): string | null {
    return isOff(this.checkOff("send")) ? RECEIVER_OFF_SEND_TEXT[this.o.mac ? "mac" : "linux"] : null;
  }

  /** The running Chrome's last result is missing or unknown, and its read is ACCESS_REREAD_MS old (board ab-v16.94.34). */
  private accessDue(): boolean {
    const a = this.access, key = this.chromeKey();
    return a !== null && key !== null && a.chrome === key && a.result.state !== "ok" && this.clock() - a.at >= ACCESS_REREAD_MS;
  }

  private extensionVersion(): string | null {
    try { return this.o.extensionVersion?.() ?? null; } catch { return null; }
  }

  private beforeStop(why: StopWhy): void { try { this.o.beforeStop?.(why); } catch {} }
  private linkDown(): void { try { this.o.linkDown?.(); } catch {} }

  /**
   * Each stop of Chrome (the op `stop`, the fail-closed watch's, the stop by use, `enabled: false`, and the stop of a
   * Chrome move and of its way back, whose start can fail or meet `enabled: false` and leave Chrome off): the unit's stop,
   * then the drop of the stopped Chrome's link, also when the unit's stop fails, and the caller's report after both. Else,
   * until its shim's own late end, the model holds its old connections, `wake` sees the link ready and starts nothing, and
   * a use reaches the stopped Chrome's connections (boards ab-b84.33, ab-b84.34 and ab-b84.36). The drop cannot hit a new
   * Chrome's link: the unit's stop holds its lock, and only microtasks run between its end and the drop.
   */
  private async stopUnit(why: StopWhy, begins?: (xvfbStays: boolean) => void): Promise<boolean> {
    this.beforeStop(why);
    // The stop by use keeps the unit's Xvfb while the blanket Chrome runs on it (board ab-4wh.8); every other stop ends it.
    try { return await this.unit.stop({ keepXvfb: why === "idle", ...(begins ? { begins } : {}) }); }
    finally { this.linkDown(); }
  }

  /** One `chrome` event when the running Chrome's version or update state changed. */
  private chromeChanged(): void {
    const f = this.unit.chromeFacts();
    if (!f) { this.lastChrome = ""; return; }
    const ev = { t: "ev", ev: "chrome", version: f.version || null, update: this.mover.updateState() };
    const key = JSON.stringify(ev);
    if (key === this.lastChrome) return;
    this.lastChrome = key;
    this.emit(ev);
  }

  private stopped(reason: string, by: By | null, quiet = false): void {
    this.lastStop = { reason, at: this.isoNow(), by };
    this.lastChrome = "";
    if (!quiet) this.emit(by ? { t: "ev", ev: "stopped", reason, by: { ...by } } : { t: "ev", ev: "stopped", reason });
  }

  private onUnitEvent = (e: UnitEvent) => {
    if (e.kind === "ready") this.ready();
    // A crash: the gone Chrome's link goes down at once, not at its shim's late end, so a use waits for the supervisor's
    // start after its backoff (C12) and never reaches the gone Chrome's connections (board ab-b84.36).
    else if (e.kind === "gone") this.linkDown();
    else if (e.kind === "ended") this.macEnd();
    else this.stopped("start_failed", null);
  };

  /**
   * The Mac (board ab-xxh): the unit took the end of a Chrome that ended with no stop of the service (the part's watch,
   * the supervisor's check or a start: one rule, review M1). A stop by use: the link goes down at once, the end ends a
   * run of fail-closed stops, so the next fail-closed stop sends its `stopped` (review C1), and `stopped` goes out with the
   * reason `idle` and no `by` (last_stop carries it; no failure, no alert). The next use starts Chrome.
   */
  private macEnd(): void {
    this.linkDown();
    this.pendingStart = false;
    this.failRun = false;
    this.stopped("idle", null);
  }

  // ------------------------------------------------------------------ the ops

  /**
   * Start Chrome and Xvfb (the op `start`, and the start at a use of board ab-v16.94.11). `by` is the caller's
   * provenance, or null for the service's own start. The answer of C12: `{}` when they run, else the error text.
   */
  async startBrowser(_by: By | null): Promise<Answer> {
    if (!(await this.o.owner.check("a start"))) return { error: NOT_OWNER };
    this.startRuns++;
    try {
      const wasRunning = this.unit.running();
      const before = this.chromeKey();
      // The link's hellos before the start: a hello after them on the start's Chrome is that Chrome's (board ab-v16.81).
      const hellos = this.hellos();
      this.pendingStart = false;
      await this.unit.start();
      // The grace time of the stop by use counts from a start op and a start at a use, never from a restart of the
      // service's own (the supervisor's, a move's): review-120 note 5.
      this.lastUse = this.clock();
      // Also a new Chrome in place of one that ended during the start (review-185 N2): its ready() ties readyAt to it.
      const key = this.chromeKey();
      const fresh = key !== null && (!wasRunning || key !== before);
      // The receiver check of the new Chrome, and its move (board ab-v16.81): one for all the starts that run; a start
      // that comes during it answers at its end. Its `ready` comes after it, for the final Chrome only.
      if (fresh) this.receiverMove ??= this.moveReceiver(key, hellos).finally(() => { this.receiverMove = null; });
      const move = this.receiverMove;
      if (move) { await move; this.lastUse = this.clock(); }
      if (this.unit.running() && (fresh || move)) this.ready();
      return { data: {} };
    } catch (e) {
      if (e instanceof NotOwnerError) return { error: NOT_OWNER };
      return { error: (e as Error).message || ERR.bad };
    } finally { this.startRuns--; }
  }

  /**
   * True while a start of Chrome runs (the op `start`, a start at a use), with its receiver check and move (board
   * ab-v16.81): a new connection of the agent door or the MCP path counts the link as down and waits in `wake`.
   */
  get startHolds(): boolean { return this.startRuns > 0; }

  /** The count of the receivers' hellos on the link, or 0 (no link, or one that does not count them). */
  private hellos(): number {
    try { return this.o.link?.hellos?.() ?? 0; } catch { return 0; }
  }

  /**
   * The move of the agent extension to the staged package (board ab-v16.81; C12, the agent package; agentwatch's
   * _start_unit), after a start that started the Chrome `key`; `hellos` is the link's count before that start. With a
   * staged package (a Google Chrome copy on Linux; the Mac and a Chromium of `chrome_bin` have none: no wait) it waits
   * for the first hello of that Chrome (helloOf). A hello older than the package (extensionOlder) logs one line, stops
   * Chrome (its link drops, as at every stop) and starts it once more; a second hello that is still older logs one
   * warning, and nothing more starts. No hello in time, an equal or newer one: nothing more. A stop (the op, `enabled:
   * false`), the owner rule or the part's close during the move keeps Chrome stopped. The first Chrome gets no `ready`
   * and no `stopped` event. A stop or second start that fails with an error that is no start error throws a StartError
   * with extensionMoveFailed's text, so each caller handles it as a failed start.
   */
  private async moveReceiver(key: string, hellos: number): Promise<void> {
    const staged = this.unit.stagedPackage();
    if (staged === null || !this.o.link?.hellos) return;
    const said = await this.helloOf(key, hellos);
    if (!extensionOlder(said, staged)) return;
    // The stop count before the owner check (review-200 B1): a stop (the op, the watch's, `enabled: false`), the part's
    // close or a new Chrome during the check ends the move, and Chrome stays as it is.
    const stops = this.unit.stopCount;
    if (!(await this.o.owner.check("a move of the agent extension"))) throw new NotOwnerError("not the owner");
    const changed = this.closed || this.unit.stopCount !== stops || this.chromeKey() !== key;
    if (changed || this.unit.config?.enabled !== true) return;
    this.o.log(`unit: the agent extension ${said} waits for Chrome's next start (the staged package is ${staged}); starting Chrome once more`);
    this.moveStops++;
    try { await this.stopUnit("move"); }
    catch (e) { throw this.moveFailed("stop", staged, e); }
    if (this.closed || this.unit.stopCount !== stops + 1 || this.unit.config?.enabled !== true) return;
    const again = this.hellos();
    try { await this.unit.start(); }
    catch (e) { throw this.moveFailed("start", staged, e); }
    const next = this.chromeKey();
    if (next === null) return;
    const now = await this.helloOf(next, again);
    if (extensionOlder(now, staged)) this.o.log(`unit: warning: the agent extension did not move to ${staged} at Chrome's next start (its hello says ${now}); Chrome does not start again`);
  }

  /** A failed step of a move: a start error (a start's answer) or the owner rule as it is, else the move's text. */
  private moveFailed(step: "stop" | "start", staged: string, e: unknown): Error {
    if (e instanceof NotOwnerError || e instanceof StartError) return e;
    const text = extensionMoveFailed(step, staged, e instanceof Error ? e.name : typeof e);
    this.o.log(`unit: ${text}`);
    return new StartError(text);
  }

  /**
   * The version of the first hello of the Chrome `key` after `hellos` hellos on the link, or null when that Chrome ends,
   * a stop comes, the part closes or RECEIVER_HELLO_WAIT_MS passes first. The link drops at each stop of Chrome and its
   * peer check admits only a shim of the running Chrome, so a later hello on the start's Chrome is that Chrome's.
   */
  private async helloOf(key: string, hellos: number): Promise<string | null> {
    const link = this.o.link ?? NO_LINK;
    const stops = this.unit.stopCount;
    const end = this.clock() + RECEIVER_HELLO_WAIT_MS;
    for (;;) {
      const cur = this.chromeKey();
      if (cur === key && this.hellos() !== hellos && link.ready()) {
        try { return link.version?.() ?? null; } catch { return null; }
      }
      if (this.closed || cur !== key || this.unit.stopCount !== stops || this.clock() >= end) return null;
      await this.nap(this.o.usePollMs ?? USE_POLL_MS);
    }
  }

  /**
   * Stop Chrome and Xvfb (the op `stop`). A requested stop is a stop, not a crash: the record says `wanted: false`, so
   * neither the supervisor nor the fail-closed watch starts or counts a Chrome after it. `by` is the caller's provenance
   * (the `stopped` event's `by`), or null. A later use starts Chrome again (board ab-v16.94.11).
   */
  async stopBrowser(by: By | null): Promise<Answer> {
    if (!(await this.o.owner.check("a stop"))) return { error: NOT_OWNER };
    this.pendingStart = false;
    const ran = await this.stopUnit("stop");
    if (ran) this.stopped("stop", by ? { ...by } : null);
    return { data: {} };
  }

  /** The watch's stop: the owner rule first; a Chrome on probation takes the way back instead. */
  private async failClosed(reason: WatchStop): Promise<boolean> {
    if (!(await this.o.owner.check("the watch's stop"))) return false;
    // After a fail-closed stop only a `start` starts Chrome again: no later `config` does (review-106 B1).
    this.pendingStart = false;
    const p = reason === "receiver_missing" ? this.mover.probationFor() : null;
    if (p) { this.mover.revert(p, "no receiver confirmed the lists in 60 s"); return true; }
    const key = this.chromeKey();
    await this.stopUnit("watch");
    // The Mac: the stop of a Chrome with no receiver reads whether Chrome turned it off, once Chrome wrote its files at
    // its end (board ab-v16.116); the failed-closed state's sentences use that read.
    if (this.o.mac && reason === "receiver_missing" && key !== null) this.checkOff("stop", key);
    // A run of fail-closed stops of Chromes that a use started sends its `stopped` once, until a Chrome stays up past the
    // watch (the daemon lead's P2): the later stops of the run set last_stop only.
    const quiet = this.chromeByUse && this.failRun;
    if (this.chromeByUse) this.failRun = true;
    this.failClosedAt = this.clock();
    this.stopped(reason, null, quiet);
    return true;
  }

  // ------------------------------------------------------------------ the start and the stop by use (board ab-v16.94.11)

  /** The names of the sources that use the browser now: the service's signal, and `waiting` for the requests that wait. */
  usedBy(): string[] {
    let now: string[] = [];
    try { now = this.o.use?.now() ?? []; } catch { now = []; }
    return this.waiters > 0 ? [...now, "waiting"] : now;
  }

  /** How long nothing has used the browser (ms): 0 while something does. */
  unusedFor(): number {
    const now = this.clock();
    if (this.usedBy().length) { this.lastUse = now; return 0; }
    let quiet = Infinity;
    try { quiet = this.o.use?.quietFor() ?? Infinity; } catch {}
    if (Number.isFinite(quiet)) this.lastUse = Math.max(this.lastUse, now - Math.max(0, quiet));
    return Math.max(0, now - this.lastUse);
  }

  /** The grace time of the stop by use, in ms. */
  get idleStopMs(): number { return this.idleMinutes * 60_000; }

  /** True while the stop by use runs: a new connection waits for its end (the agent door and the MCP path ask). */
  get idleStopping(): boolean { return this.idleStop !== null; }

  /**
   * A request that needs the browser (an upgrade of the agent door, a request of the MCP path, a send): it is a use while
   * it waits. With no config yet, or with `enabled: false`, it starts nothing and goes on at once. Else, when a stop by use
   * runs, it waits for its end; when Chrome does not run, it starts Chrome and Xvfb (the one start of all the requests that
   * wait); then it waits until `ready` says yes, Chrome stops, or USE_WAIT_MS has passed. While a start runs (with its
   * move of the agent extension, board ab-v16.81) it waits for that start's end first. The answer: null (the caller's
   * checks run again), or the text of a start that failed (`useFailed`), which the caller gives its client. With
   * `send` (stage 1c's import, the operator's send): the `starting` state's text when its limit passed during a start.
   */
  async wake(ready: () => boolean, o: { send?: boolean } = {}): Promise<string | null> {
    const cfg = this.unit.config;
    if (this.closed || !cfg || !cfg.enabled) return null;
    // After a fail-closed stop, a use starts Chrome again at most once in FAIL_HOLD_MS: until then the request gets that
    // moment's answer at once, and the state stays failed closed (the daemon lead's P2).
    if (this.failClosedHold()) return null;
    this.waiters++;
    this.lastUse = this.clock();
    // The limit covers the whole wait: the end of a stop by use, the start and the caller's check (review-120 note 1).
    const end = this.clock() + (this.o.useWaitMs ?? USE_WAIT_MS);
    const isReady = () => { try { return ready(); } catch { return false; } };
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const pause = (ms: number) => new Promise<void>((r) => { const t = setTimeout(() => { timers.delete(t); r(); }, Math.max(0, ms)); timers.add(t); });
    const LATE = Symbol("late");
    const inTime = <T>(p: Promise<T>): Promise<T | typeof LATE> => Promise.race([p, pause(end - this.clock()).then((): typeof LATE => LATE)]);
    // A start that still runs at a send's limit (its move of the agent extension, board ab-v16.81): the send gets the
    // state's text, never the first Chrome (its caller would go on to the receiver that links). An upgrade and an MCP
    // call get null and run their checks again, which count the link as down while a start runs (`startHolds`).
    const late = () => (o.send && !this.closed && this.startRuns > 0 ? STATE_TEXTS.starting.agent_text : null);
    try {
      if (this.idleStop && (await inTime(this.idleStop)) === LATE) return late();
      // A Chrome that crashed (the record still wants it): the supervisor starts it again after its backoff, and the
      // request waits for that start (review-120 note 5). On the Mac a Chrome that ended with no stop of the service is a
      // stop by use (board ab-xxh): the request starts Chrome at once, also before the supervisor's check, and once more
      // when Chrome ends during its wait. Else a Chrome that does not run starts now.
      for (let again = false; ; again = true) {
        // The Mac (board ab-d35): the ends that a taker takes from here on. A take between two polls (the part's watch,
        // the supervisor's check) leaves Chrome off and unwanted, so the wait sees that end by the unit's count of ends,
        // when no start that did not fail began and no stop came after it (endedSince; a failed start covers nothing,
        // board ab-w6i). Linux: no end is ever taken.
        const mark = this.unit.endMark();
        if (!this.unit.running() && !isReady() && (!this.unit.wanted || this.unit.endedOnMac())) {
          const failed = await inTime(this.startAtUse());
          if (failed === LATE) return late();
          if (failed !== null) return failed;
        }
        // A start that runs (the op `start`'s, or another request's), with its receiver check and move: the request waits
        // for its end, also when its check says ready now (the first Chrome's old receiver links and confirms; ab-v16.81).
        let ended = false;
        while (!this.closed) {
          const ok = this.startRuns === 0 && isReady();
          if (!(this.startRuns > 0 || (!ok && (this.unit.running() || this.unit.wanted)))) {
            // Nothing to wait for: no start runs, and the check says ready, or Chrome is off and unwanted. An end that a
            // taker took since the mark, with no start that did not fail and no stop after it, is an end during the
            // wait; with `enabled: false` a use starts nothing (C12).
            if (!ok && this.unit.config?.enabled === true && this.unit.endedSince(mark)) ended = true;
            break;
          }
          if (this.clock() >= end) break;
          if (this.startRuns === 0 && this.unit.endedOnMac()) { ended = true; break; }
          await pause(this.o.usePollMs ?? USE_POLL_MS);
        }
        if (!ended || again || this.closed || this.clock() >= end) break;
      }
      // The Mac: a wait that ended with no receiver on the running Chrome reads whether Chrome turned it off (board ab-v16.116).
      if (this.o.mac && !this.closed && this.startRuns === 0 && this.unit.running() && !isReady() && !(this.o.link ?? NO_LINK).ready()) this.checkOff("use");
      return late();
    } finally {
      for (const t of timers) clearTimeout(t);
      this.waiters--;
      this.lastUse = this.clock();
    }
  }

  /**
   * A use of the blanket scope on Linux (board ab-4wh.8; C12, the blanket profile): the unit's Xvfb (alone when the main
   * Chrome does not run) and the Chrome that the blanket Chrome runs (unit.ts, startForBlanket); the main Chrome does not
   * start, and its state, its record and its events stay as they are. The rules of a use stay: with the part closed, no
   * config yet or `enabled: false`, it starts nothing (null: the blanket Chrome's start then finds no Xvfb), and in the
   * hold-off after a fail-closed stop it starts nothing and answers FAIL_HOLD_TEXT (board ab-4wh.25). A stop that comes
   * during the start (the daemon's `stop`, also during the wait for an install, or `enabled: false`) is that stop, not a
   * failed start (the review's C1): null, and the blanket part, which that stop reached too, starts nothing. The answer:
   * null, FAIL_HOLD_TEXT, or the text of a start that failed (`useFailed`).
   */
  async wakeForBlanket(): Promise<string | null> {
    const cfg = this.unit.config;
    if (this.closed || !cfg || !cfg.enabled) return null;
    if (this.failClosedHold()) return FAIL_HOLD_TEXT;
    if (!(await this.o.owner.check("a start of Xvfb for the blanket Chrome"))) return useFailed(NOT_OWNER);
    const stops = this.unit.stopCount;
    try { await this.unit.startForBlanket(); return null; }
    catch (e) {
      if (!(e instanceof NotOwnerError) && (this.unit.stopCount !== stops || this.unit.config?.enabled !== true)) {
        this.o.log("unit: a stop came during the start of Xvfb for the blanket Chrome; it stays stopped");
        return null;
      }
      const text = e instanceof NotOwnerError ? NOT_OWNER : (e as Error).message || ERR.bad;
      this.o.log(`unit: the start of Xvfb for the blanket Chrome failed: ${text.slice(0, 300)}`);
      return useFailed(text);
    }
  }

  /**
   * Board ab-4wh.8 (Linux): the unit's Xvfb stops when no Chrome runs on it (unit.ts, releaseXvfb), the owner rule first
   * (the review's M1: a service that no longer owns leaves Chrome and Xvfb for the next owner). The part's check each
   * second and each stop of the blanket Chrome (service.ts) run it, also at the service's own stop. True when it stopped one.
   */
  async releaseXvfb(): Promise<boolean> {
    if (!this.unit.idleXvfb() || !(await this.o.owner.check("the stop of an Xvfb with no Chrome"))) return false;
    return this.unit.releaseXvfb();
  }

  /** True in the hold-off after a fail-closed stop, while Chrome does not run: a use starts nothing (the daemon lead's P2). */
  failClosedHold(): boolean {
    return !this.unit.running() && this.failClosedAt !== null && this.lastStop !== null && FAIL_CLOSED.has(this.lastStop.reason) && this.clock() - this.failClosedAt < FAIL_HOLD_MS;
  }

  /** The one start at a use: null when Chrome runs, else the text for the waiting requests. */
  private startAtUse(): Promise<string | null> {
    if (this.useStart) return this.useStart;
    const f = this.useFail;
    if (f && this.clock() - f.at < USE_RETRY_MS) return Promise.resolve(useFailed(f.text));
    // The stops of the moves of the agent extension are the start's own, not a stop during it (board ab-v16.81).
    const otherStops = () => this.unit.stopCount - this.moveStops;
    const stops = otherStops();
    const p = (async (): Promise<string | null> => {
      this.o.log("unit: an agent uses the agent browser; starting Chrome");
      this.startingByUse = true;
      let a: Answer;
      try { a = await this.startBrowser(null); } finally { this.startingByUse = false; }
      if (!("error" in a)) return null;
      if (a.error === NOT_OWNER) return useFailed(a.error);
      // A stop (the daemon's own, or browser.enabled false) that came during the start, also during its wait for the
      // install, ended it: that is the stop's, not a failed start (review-120 note 3). The request gets that moment's answer.
      if (otherStops() !== stops) { this.o.log("unit: a stop came during the start at an agent's use; it stays stopped"); return null; }
      this.useFail = { at: this.clock(), text: a.error };
      this.o.log(`unit: the start at an agent's use failed: ${a.error.slice(0, 300)}`);
      // One `stopped` event for a run of failed starts at a use, as the supervisor's report (C12: start_failed).
      if (!this.useFailTold) { this.useFailTold = true; this.stopped("start_failed", null); }
      return useFailed(a.error);
    })();
    this.useStart = p;
    void p.finally(() => { if (this.useStart === p) this.useStart = null; });
    return p;
  }

  /**
   * The stop by use, at each check of the watch: Chrome runs, no start, stop or move runs, and nothing used the browser for
   * the grace time. The owner rule first; then the same checks again, and the stop: Chrome and Xvfb (the Mac: Chrome)
   * end, the profile stays, the record says `wanted: false`, and `stopped` goes out with the reason `idle`.
   */
  private async idleCheck(): Promise<void> {
    const idle = () => {
      if (this.closed || !this.unit.running()) return false;
      // Read first, so the time of the last use stays fresh at each check.
      const unused = this.unusedFor();
      return this.idleStop === null && this.useStart === null && this.startRuns === 0 && this.unit.config?.enabled === true
        && !this.unit.starting && !this.unit.locked && !this.mover.working && unused >= this.idleStopMs;
    };
    if (!idle()) return;
    if (!(await this.o.owner.check("the stop of an unused browser"))) return;
    if (!idle()) return; // a use came during the owner check
    const pending = this.mover.updateState() === "pending" ? this.updater.readyVersion() : null;
    const run = (async () => {
      this.pendingStart = false;
      // The Mac runs no Xvfb (board ab-v16.94.35): its line names Chrome only; the Linux line stays as it was. Board
      // ab-4wh.25: the unit's stop gives Xvfb's fate under its lock, the one choice that it acts on.
      const line = (xvfbStays: boolean) => this.o.log(`unit: no agent used the agent browser for ${this.idleMinutes} min; stopping ${this.o.unit.mac ? "Chrome" : xvfbStays ? "Chrome; Xvfb stays for the blanket Chrome" : "Chrome and Xvfb"} (the profile stays)`);
      // The link of the stopped Chrome goes down before the stop's report and its end (stopUnit; board ab-b84.33).
      const ran = await this.stopUnit("idle", line);
      if (ran) this.stopped("idle", null);
      if (ran && pending) this.o.log(`update: the agent browser stopped with no use; its next start runs Google Chrome ${pending}`);
    })();
    const p = run.catch((e) => { this.o.log(`unit: the stop of an unused browser failed: ${(e as Error).name}`); });
    this.idleStop = p;
    try { await p; } finally { if (this.idleStop === p) this.idleStop = null; }
  }

  // ------------------------------------------------------------------ config and sessions

  onConfig(keys: Record<string, unknown>): void {
    const cfg = configFrom(keys);
    this.unit.config = cfg;
    // The grace time of the stop by use (board ab-v16.94.11): agentwatch's browser.idle_stop_minutes, as data.
    const minutes = idleStopMinutes(keys.idle_stop_minutes);
    if (minutes === null && keys.idle_stop_minutes != null) this.o.log(`unit: config's idle_stop_minutes is not a whole number from 1 to ${IDLE_STOP_MAX_MINUTES}; the grace time is ${IDLE_STOP_DEFAULT_MINUTES} min`);
    this.idleMinutes = minutes ?? IDLE_STOP_DEFAULT_MINUTES;
    // A config that changed clears the hold-off of a failed start at a use (review-120 note 11).
    const json = JSON.stringify(keys);
    if (json !== this.lastConfig) { this.lastConfig = json; this.useFail = null; }
    if (!cfg.enabled) {
      // browser.enabled false stops the browser (no event: turning it off is not a fault).
      this.pendingStart = false;
      if (this.unit.chromePid() !== null || this.unit.wanted) void this.turnOff();
      return;
    }
    if (this.pendingStart) {
      this.pendingStart = false;
      void this.startWanted();
    }
  }

  /** browser.enabled false: stop Chrome and Xvfb; the record says `wanted: false` (an owner part; no event). */
  private turnOff(): Promise<void> {
    return this.ownerPart("the stop of a browser that is turned off", async () => { await this.stopUnit("off"); });
  }

  /** The start of a wanted Chrome with no `start` op (build note 8): at the first `config`, or in begin when that came first. */
  private startWanted(): Promise<void> {
    // A stop that comes during the owner check wins: the start reads the stop count before the check (review-106b F1).
    const stops = this.unit.stopCount;
    return this.ownerPart("the start of a wanted Chrome", async () => {
      if (this.unit.stopCount !== stops || !this.unit.wanted) return;
      // On the Mac a Chrome of this service that ended with no stop of the service is a stop by use (board ab-d35): this
      // start takes that end and starts nothing.
      try { await this.unit.start({ wanted: true }); if (this.unit.running()) this.ready(); }
      catch (e) { if (e instanceof NotOwnerError) throw e; this.o.log(`unit: the start of the wanted Chrome failed: ${(e as Error).message.slice(0, 300)}`); }
    });
  }

  // ------------------------------------------------------------------ the owner parts and their loops

  private async ownerPart(what: string, f: () => Promise<void>): Promise<void> {
    if (this.closed || !(await this.o.owner.check(what))) return;
    try { await f(); } catch (e) { if (!(e instanceof NotOwnerError)) this.o.log(`unit: ${what} failed: ${(e as Error).name}`); }
  }

  /** A sleep that `stop` ends at once. */
  private nap(ms: number): Promise<void> {
    return new Promise((r) => {
      if (this.closed) return r();
      const done = () => { clearTimeout(t); this.timers.delete(t); this.wakers.delete(done); r(); };
      const t = setTimeout(done, ms);
      this.timers.add(t); this.wakers.add(done);
    });
  }

  private loop(ms: number, first: number, body: () => Promise<void>): void {
    this.loops.push((async () => {
      await this.nap(first);
      while (!this.closed) {
        try { await body(); } catch (e) { if (e instanceof NotOwnerError) break; this.o.log(`unit: a check failed: ${(e as Error).name}`); }
        await this.nap(ms);
      }
    })());
  }

  /**
   * The start of the part (the owner rule said yes): the adoption, the boot sweep (never on a record that cannot be
   * read), then the supervisor, the watch and the updater.
   */
  async begin(): Promise<void> {
    // The grace time of an adopted Chrome counts from the service's start (board ab-v16.94.11).
    this.lastUse = this.clock();
    const a = this.unit.adopt();
    const stops = this.unit.stopCount;
    if (a.unreadable === null) await this.unit.stopOrphans();
    // A `config` can come before this point (the control door opens first: build note 8). It applies now, before the
    // loops start (review-106 B1): `enabled: false` stops what the record wanted, and a wanted Chrome that is gone
    // starts at once. With no `config` yet, a wanted Chrome starts at the first one.
    // A stop during the sweep wins (review-106b F1): it counts at once and clears the wish when it gets the lock.
    const cfg = this.unit.config;
    const wanted = this.unit.wanted && this.unit.stopCount === stops;
    if (cfg && !cfg.enabled) { if (a.adopted || wanted) await this.turnOff(); }
    else if (a.adopted) { this.ready(); this.checkAccess("adoption"); }
    else if (wanted && cfg) await this.startWanted();
    else if (wanted) { this.pendingStart = true; this.o.log("unit: the unit record wants the agent browser; it starts at the daemon's config"); }
    const superviseMs = this.o.superviseMs ?? SUPERVISE_MS;
    this.loop(superviseMs, superviseMs, async () => {
      if (!(await this.o.owner.check("the supervisor's check"))) throw new NotOwnerError("not the owner");
      await this.unit.superviseOnce(this.onUnitEvent);
    });
    const watchMs = this.o.watchMs ?? 1000;
    this.loop(watchMs, 0, async () => {
      // The Mac (board ab-xxh): an end with no stop of the service is taken within a second, after the owner rule, so the
      // record says `wanted: false` at once (review M4). Linux: endedOnMac is false, and nothing is read.
      if (this.unit.endedOnMac() && (await this.o.owner.check("the take of a Chrome's end"))) this.unit.takeEnd(this.onUnitEvent);
      await this.watch.tick();
      const link = this.o.link ?? NO_LINK;
      // A receiver's link-up (its hello) on the running Chrome, also on a new Chrome since the last check: the access check.
      // A new hello on the same Chrome's link is a link-up too (board ab-v16.94.34): an extension reload (the operator's
      // switch in chrome://extensions) drops the link and links again, and both can fall between two checks. While the
      // result is missing or unknown, a read every ACCESS_REREAD_MS; after a result that finds the access, none until a
      // link-up.
      const id = this.unit.running() && link.ready() ? this.unit.chromeId() : null;
      const up = id ? `${id.pid}:${id.start}` : "";
      const hellos = link.hellos?.() ?? 0;
      // A receiver that links clears the latest read of a receiver that Chrome turned off (board ab-v16.116), and C12's
      // `receiver_off` state (board ab-v16.118).
      if (up) this.clearOff();
      // The read right before a start counts for the Chrome that the start started: the first one that runs (board ab-v16.118).
      const running = this.chromeKey();
      if (running !== null && this.offTold?.chrome === NEXT_CHROME) this.offTold.chrome = running;
      // The Mac: 15 s after a start at a Chrome version change, the line of the guarded settings again, also when a
      // receiver linked before the watch's note (board ab-v16.118). The line belongs to the first Chrome that runs after
      // that start: when that Chrome stops before its line, the line is dropped.
      const v = this.versionChange;
      if (v && v.chrome === null && running !== null) { v.chrome = running; v.since = this.clock(); }
      else if (v && v.chrome !== null && v.chrome !== running) this.versionChange = null;
      else if (v && running !== null && this.clock() - v.since >= LOAD_NOTE_MS) this.versionChangeAfter(running);
      if (up && (up !== this.linkUpFor || hellos !== this.linkHellos)) this.checkAccess("link-up");
      else if (this.accessDue()) this.checkAccess("re-read");
      this.linkUpFor = up;
      this.linkHellos = hellos;
      // No Chrome move while a start runs (its move of the agent extension stops and starts Chrome; board ab-v16.81),
      // and no `chrome` event of the first Chrome of that move.
      this.mover.tick(this.unit.running() && link.ready() && link.confirmed() && this.startRuns === 0);
      if (this.receiverMove === null) this.chromeChanged();
      // A Chrome that stays up past the watch's limit (C12's 60 s on Linux and the Mac) ends a run of fail-closed stops
      // (the daemon lead's P2). The watch counts from its first check of the Chrome (often a little before readyAt) and
      // stops it at the limit, so at that moment this check is often true as well: only a Chrome that is still up
      // RUN_END_MARGIN_MS past the limit ends the run (board ab-v16.111: else the part's loop, when it ran before the
      // watch's, ended the run with each stop). readyAt counts only for the Chrome that it belongs to: a new Chrome before
      // its ready() still had the last Chrome's readyAt, which ended the run.
      const cur = this.chromeKey();
      if (this.failRun && cur && this.readyAt !== null && this.readyFor === cur && this.clock() - this.readyAt > (this.o.watchLimitMs ?? RECEIVER_MISSING_MS) + RUN_END_MARGIN_MS) this.failRun = false;
      await this.idleCheck();
      // Board ab-4wh.8 (Linux): an Xvfb on which no Chrome runs any more (the blanket Chrome exited by itself or its start
      // failed, while the main Chrome does not run) stops, the owner rule first.
      await this.releaseXvfb();
      this.o.mac?.watcher.tick(this.unit.running() ? this.unit.chromeId() : null);
      await this.macVersionCheck();
    });
    this.loop(this.o.checkEveryMs ?? CHECK_EVERY_MS, this.o.firstCheckMs ?? FIRST_CHECK_MS, async () => {
      if (await this.o.owner.check("the Chrome update check")) await this.updater.checkOnce();
      if (this.receiverMove === null) this.chromeChanged();
    });
  }

  /**
   * The Mac: when the operator's running Chrome runs a newer version than the agent Chrome (the operator's relaunch), and
   * the version on disk is newer than the agent Chrome's too, the agent Chrome starts again at a moment with no agent's
   * client, no request in flight and no send (the design, section 10; review-145 B1).
   */
  private async macVersionCheck(): Promise<void> {
    const m = this.o.mac;
    if (!m) return; // Linux: no read at all (review-145 N1)
    const app = this.unit.macApp(), pid = this.unit.chromePid();
    if (!app || pid === null || this.closed || this.unit.locked || this.unit.starting || this.idleStop !== null || this.useStart !== null) return;
    const now = this.clock();
    if (this.macCheckedAt !== null && now - this.macCheckedAt < (m.everyMs ?? MAC_VERSION_EVERY_MS)) return;
    this.macCheckedAt = now;
    const v = m.versions(app, pid);
    if (!v.agent || !v.operator || !macNewer(v.operator, v.agent)) return;
    const a = this.o.activity ?? {};
    const pair = `${v.agent}/${v.operator}`;
    if ((a.inFlight?.() ?? 0) > 0 || a.importing?.() || a.clients?.()) {
      // No read of the disk now, so the line promises no restart that the disk check can refuse; it comes once for the
      // pair, and not after a read for it (review-147 note 4, board ab-v16.94.21).
      if (this.macWait !== pair && this.macRead !== pair) { this.macWait = pair; this.o.log(`unit: the operator's Chrome runs ${v.operator}, newer than the agent Chrome's ${v.agent}; when no agent uses it, the service reads the version on disk of ${app.bundle}, and the agent Chrome starts again if that version is newer too`); }
      return;
    }
    // The version on disk only now, with no agent's use (review-145b N4): its read (plutil) blocks for up to 5 s.
    const disk = m.disk(app);
    this.macRead = pair;
    if (!disk) {
      // Once for the pair, also when an agent's client comes and goes between the reads (review-147 note 4).
      if (this.macUnread !== pair) { this.macUnread = pair; this.o.log(`unit: the operator's Chrome runs ${v.operator}, newer than the agent Chrome's ${v.agent}, but the version on disk of ${app.bundle} cannot be read as a.b.c.d; the agent Chrome does not start again`); }
      return;
    }
    if (!macNewer(disk, v.agent)) return; // a new start would run the agent's version again: no restart, no loop
    // The stop count before the owner check (review-200 B1): a stop or a new Chrome during the check ends the restart.
    const stops = this.unit.stopCount;
    if (!(await this.o.owner.check("a restart of the agent Chrome at a version change"))) return;
    const changed = this.closed || this.unit.stopCount !== stops || this.unit.chromePid() !== pid;
    if (changed || this.unit.config?.enabled !== true) return;
    this.o.log(`unit: the operator's Chrome runs ${v.operator}, newer than the agent Chrome's ${v.agent}; the agent Chrome starts again at ${disk}`);
    this.macWait = ""; this.macRead = ""; this.macUnread = "";
    await this.stopUnit("move");
    if (this.closed || this.unit.stopCount !== stops + 1 || this.unit.config?.enabled !== true) return;
    try { await this.unit.start(); }
    catch (e) {
      if (e instanceof NotOwnerError) return;
      this.o.log(`unit: the agent Chrome could not start again after the version change: ${(e as Error).message.slice(0, 300)}`);
      this.stopped("start_failed", null);
      return;
    }
    if (this.unit.running()) this.ready();
  }

  /** Stop the loops (never Chrome: it runs detached for the next owner). */
  async stop(): Promise<void> {
    this.closed = true;
    this.o.mac?.watcher.stop();
    this.unit.halt();
    for (const w of [...this.wakers]) w();
    await Promise.allSettled(this.loops);
  }
}

export { KIND_GOOGLE };
