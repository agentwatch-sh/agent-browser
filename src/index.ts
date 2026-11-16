// The library. Node code imports this in-process (through index.js, see loader.js):
//   import { AgentBrowser, commands } from "agent-browser";

export { AgentBrowser, Tab, KEYS, allowlistOf } from "./browser.ts";
export type { TargetInfo, PageInfo, Download, CapturedResponse, Viewport, Drive } from "./browser.ts";
export { commands, COMMAND_SPECS } from "./commands.ts";
export type {
  CommandName, CommandSpec, ParamSpec, ParamType, TabRef, StatusResult,
  WindowResult, TabsResult, OpenResult, GotoResult, OutlineResult, ClickResult, HoverResult, TypeResult, PressResult,
  TextResult, EvalResult, ShotResult, FetchResult, DownloadResult, CloseResult, NetResult, RecordResult, CommandsResult,
} from "./commands.ts";
export { recordTab, planRecording, redactStep, NetworkWatch, pngPixels, samePixels, planMove, pointAt, fittsMs, seededRandom, parseSteps, parseKey, parseSize, findFfmpeg, MAX_RECORD_SECONDS } from "./record.ts";
export type { Step, StepTarget, IdleWait, StillWait, ChangeWait, Pixels, Point, Box, Leg, RecordPlan, RecordOutcome, RecordEvent } from "./record.ts";
export { main, USAGE } from "./cli.ts";
export { resolveOptions, TAB_SCOPE_RE, CDP_URL_RE, REMOVED_OPTIONS } from "./options.ts";
export type { BrowserOptions, NotifyHook, Settings } from "./options.ts";
export { notifyBrowserStatus } from "./notify.ts";
export type { NotifyResult } from "./notify.ts";
export { isAllowedUrl, loadAllowlist, validateAllowlist } from "./allowlist.ts";
export {
  AgentBrowserError, UsageError, NotAllowedError, ReadFirstError, TabNotFoundError, ChromeUnreachableError,
  runCleanup, withCleanupErrors, isSignInHost, signInHint, redirectError,
} from "./errors.ts";
export type { ErrorCode } from "./errors.ts";
export { appBundle, assertSafeChromeArgs, AGENT_ARGS, CHROME_STABLE_BIN, parsePs, hasUserDataDir, processTree } from "./agent.ts";
export type { ProcessRow } from "./agent.ts";
export { outline, outlineText, idx, redact, netLog, IDX_ATTR } from "./outline.ts";
export type { OutlineElement, NetEntry } from "./outline.ts";
export { CDPConnection, CDPError } from "./cdp.ts";
