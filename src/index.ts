// The library. Node code imports this in-process (through index.js, see loader.js):
//   import { AgentBrowser, commands } from "agent-browser";

export { AgentBrowser, Tab, KEYS, allowlistOf, endpointCandidates, rememberEndpoint } from "./browser.ts";
export type { TargetInfo, PageInfo, Download, CapturedResponse, Viewport } from "./browser.ts";
export { commands, COMMAND_SPECS } from "./commands.ts";
export type {
  CommandName, CommandSpec, ParamSpec, ParamType, TabRef, LaunchResult, QuitResult, StatusResult, ConnectResult, StopResult,
  WindowResult, TabsResult, OpenResult, GotoResult, OutlineResult, ClickResult, HoverResult, TypeResult, PressResult,
  TextResult, EvalResult, ShotResult, FetchResult, DownloadResult, CloseResult, NetResult, RecordResult, CommandsResult,
} from "./commands.ts";
export { recordTab, planRecording, redactStep, NetworkWatch, pngPixels, samePixels, planMove, pointAt, fittsMs, seededRandom, parseSteps, parseKey, parseSize, findFfmpeg, MAX_RECORD_SECONDS } from "./record.ts";
export type { Step, StepTarget, IdleWait, StillWait, ChangeWait, Pixels, Point, Box, Leg, RecordPlan, RecordOutcome, RecordEvent } from "./record.ts";
export { main, USAGE } from "./cli.ts";
export { resolveOptions, isChromeForTesting, DEFAULT_PROXY_IDLE_MS, MAX_SOCKET_PATH_BYTES } from "./options.ts";
export type { BrowserOptions, BrowserMode, NotifyHook, Settings } from "./options.ts";
export { isAllowedUrl, isDeniedHost, loadAllowlist, validateAllowlist, DENIED_HOSTS, DENIED_FIRST_LABELS } from "./allowlist.ts";
export {
  AgentBrowserError, UsageError, NotAllowedError, PinRequiredError, ReadFirstError, TabNotFoundError, ChromeUnreachableError,
  ApprovalNeededError, runCleanup, withCleanupErrors, isSignInHost, signInHint, redirectError,
} from "./errors.ts";
export type { ErrorCode } from "./errors.ts";
export {
  launchAgentChrome, appBundle, agentEndpoint, agentChromePid, agentChromeBin, agentProfileDir, findAgentPid, parsePs, processTree,
  hasUserDataDir, restoresOnStartup, seedRemoteDebugging, assertNoDebuggingFlag, INSPECT_URL, AGENT_ARGS, CHROME_BETA_BIN, CHROME_STABLE_BIN,
} from "./agent.ts";
export type { ProcessRow } from "./agent.ts";
export { startProxy, stopProxy, proxyInfo, proxyUrl } from "./proxy.ts";
export { browserTarget, localBrowserStatus, lastConnectionEnd, lastProxyAttempt, notifyBrowserStatus } from "./diagnostics.ts";
export type { NotifyResult, ProxyAttempt } from "./diagnostics.ts";
export { outline, outlineText, idx, redact, netLog, IDX_ATTR } from "./outline.ts";
export type { OutlineElement, NetEntry } from "./outline.ts";
export { CDPConnection, CDPError } from "./cdp.ts";
export { makeApprover, approveMechanism, osascriptApprove, macProcessName, APPROVE_TIMEOUT_MS } from "./approver.ts";
export type { ApproveMechanism, Runner, RunResult } from "./approver.ts";
export { validateApprove } from "./options.ts";
export type { ApproveSpec } from "./options.ts";
