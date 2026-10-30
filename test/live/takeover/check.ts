// The live "no takeover" check (macOS): agent-browser commands must never take the operator's focus,
// Space or pointer. It drives ONE about:blank tab of its own in a running, approved agent browser (no
// site, no other tab, no Chrome start, no quit), and logs when each command starts and ends, while
// monitor.swift logs the frontmost app and the pointer. analyse.py then names any command that changed
// either. Not part of `npm test`.
//
//   swiftc -O test/live/takeover/monitor.swift -o <dir>/monitor && (<dir>/monitor 60 > <dir>/monitor.jsonl &)
//   node test/live/takeover/check.ts --state-dir DIR --allowlist FILE --out-dir <dir>
//   python3 -I test/live/takeover/analyse.py <dir> <agent Chrome pid>
//
// Measured 2026-10-30 (Chrome Beta 158; agent browser on another desktop): no command changed the
// frontmost app or moved the pointer, after `open` made background tabs (a foreground tab activated Chrome).
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { commands } from "../../../src/commands.ts";

const { values } = parseArgs({ options: { "state-dir": { type: "string" }, allowlist: { type: "string" }, "out-dir": { type: "string" } } });
if (!values["state-dir"] || !values.allowlist || !values["out-dir"]) {
  process.stderr.write("usage: node test/live/takeover/check.ts --state-dir DIR --allowlist FILE --out-dir DIR\n");
  process.exit(2);
}
const dir = resolve(values["out-dir"]);
mkdirSync(dir, { recursive: true });
const o = { stateDir: resolve(values["state-dir"]), allowlistFile: resolve(values.allowlist), noLaunch: true, log: (l: string) => mark("log", l) };
writeFileSync(`${dir}/marks.jsonl`, "");
function mark(what: string, detail?: unknown) {
  appendFileSync(`${dir}/marks.jsonl`, JSON.stringify({ t: Date.now() / 1000, what, ...(detail === undefined ? {} : { detail }) }) + "\n");
}
async function step(name: string, fn: () => Promise<unknown>) {
  mark(`start ${name}`);
  try { const r: any = await fn(); mark(`end ${name}`, r?.ok === false ? r : r?.command ?? "ok"); return r; }
  catch (e) { mark(`fail ${name}`, (e as Error).message); return undefined; }
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const steps = `${dir}/check-steps.json`;
writeFileSync(steps, JSON.stringify([{ click: "#abc-field" }, { type: "take", delay: 60 }, { press: "Enter" }, { click: { x: 500, y: 250 } }, { wait: 300 }]));

await pause(1500);
await step("tabs (through the approved proxy)", () => commands.tabs(o));
await pause(1000);
await step("open about:blank (fixed: a background tab)", () => commands.open(o, { url: "about:blank", name: "abcheck" }));
await pause(1000);
await step("eval (add a text field to the blank tab)", () => commands.eval(o, { tab: "abcheck", expression:
  "(() => { const f = document.createElement('input'); f.id = 'abc-field'; f.style.cssText = 'position:fixed;left:40px;top:40px;width:300px;height:30px'; document.body.appendChild(f); return true; })()" }));
await step("click", () => commands.click(o, { tab: "abcheck", target: "#abc-field" }));
await pause(500);
await step("type", () => commands.type(o, { tab: "abcheck", text: "hello", into: "#abc-field" }));
await pause(500);
await step("press", () => commands.press(o, { tab: "abcheck", key: "Enter" }));
await step("outline", () => commands.outline(o, { tab: "abcheck" }));
await step("shot", () => commands.shot(o, { tab: "abcheck", path: `${dir}/check-shot.png` }));
await pause(500);
await step("record", () => commands.record(o, { tab: "abcheck", out: `${dir}/check-take.mp4`, script: steps, size: "640x360", settle: 200 }));
await pause(1000);
await step("close the check's tab", () => commands.close(o, { tab: "abcheck" }));
await pause(1500);
mark("done");
