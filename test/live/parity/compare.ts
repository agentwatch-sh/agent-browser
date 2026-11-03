// Tables from a probe run folder (probe.ts --out DIR): identity, features of one version only, the
// extension load paths, the signals while an agent drives, and what each browser tried to reach.
//
//   node test/live/parity/compare.ts DIR > DIR/report.md

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { otherRun } from "./files.ts";
import { akamaiH2 } from "./fingerprint.ts";

const DIR = process.argv[2];
if (!DIR) { console.error("usage: compare.ts DIR"); process.exit(2); }
const summary = JSON.parse(readFileSync(join(DIR, "summary.json"), "utf8"));
const labels: string[] = Object.keys(summary.browsers);

type Rec = { t: number; run: string; kind: string; data: any };
type Run = { records: Rec[]; marks: { t: number; what: string; detail?: any }[]; prefs?: any; extAlive?: boolean; flags?: string[]; shots?: any };
const load = (label: string, run: string): Run | undefined => {
  const f = join(DIR, label, `${run}.json`);
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : undefined;
};
const first = (r: Run | undefined, kind: string, test: (d: any) => boolean = () => true) => r?.records.find((x) => x.kind === kind && test(x.data))?.data;
const all = (r: Run | undefined, kind: string) => r?.records.filter((x) => x.kind === kind) ?? [];
const mark = (r: Run | undefined, what: string) => r?.marks.find((m) => m.what === what)?.t;
const cell = (v: unknown) => (v === undefined ? "–" : typeof v === "string" ? v : JSON.stringify(v)).replace(/\|/g, "\\|");
const row = (name: string, vals: unknown[]) => `| ${name} | ${vals.map(cell).join(" | ")} |`;
const table = (title: string, rows: [string, (l: string) => unknown][]) => {
  console.log(`\n## ${title}\n`);
  console.log(`| | ${labels.join(" | ")} |`);
  console.log(`| --- | ${labels.map(() => "---").join(" | ")} |`);
  for (const [name, f] of rows) console.log(row(name, labels.map((l) => { try { return f(l); } catch (e) { return `error: ${e}`; } })));
};
const header = (r: Run | undefined, name: string, path = "/") => {
  const req = r?.records.filter((x) => x.kind === "request" && x.data.path === path).map((x) => x.data.rawHeaders as [string, string][]);
  for (const h of req ?? []) { const v = h.find(([k]) => k.toLowerCase() === name); if (v) return v[1]; }
  return undefined;
};

console.log(`# Parity probe: ${DIR}\n`);
console.log(`Platform ${summary.platform}, started ${summary.started}.\n`);
for (const l of labels) { const o = otherRun(summary, l); console.log(`- **${l}**: ${summary.browsers[l].version} (\`${summary.browsers[l].bin}\`)${o ? `; ${o}` : ""}`); }

// --- What a site sees ------------------------------------------------------------------------------

const fp = (l: string, run = "site") => first(load(l, run), "page-fp");
const tls = (l: string) => load(l, "tls");
const fullHello = (l: string) => first(tls(l), "tls-hello", (d) => !d.extensionsSorted.includes("0029"));
table("Identity: what a site reads (plain agent flags, fresh profile)", [
  ["User-Agent header", (l) => header(load(l, "site"), "user-agent")],
  ["Sec-CH-UA", (l) => header(load(l, "site"), "sec-ch-ua")],
  ["Sec-CH-UA-Full-Version-List (after Accept-CH)", (l) => header(load(l, "site"), "sec-ch-ua-full-version-list", "/site.js")],
  ["Sec-CH-UA-Platform", (l) => header(load(l, "site"), "sec-ch-ua-platform")],
  ["Accept-Language", (l) => header(load(l, "site"), "accept-language")],
  ["Accept (navigation)", (l) => header(load(l, "site"), "accept")],
  ["header order (first page request)", (l) => load(l, "site")?.records.find((x) => x.kind === "request")?.data.rawHeaders.map(([k]: [string]) => k.toLowerCase()).join(",")],
  ["userAgentData.brands", (l) => fp(l)?.userAgentData?.brands.map((b: any) => `${b.brand} ${b.version}`).join(", ")],
  ["uaFullVersion", (l) => fp(l)?.userAgentData?.high?.uaFullVersion],
  ["platform / platformVersion", (l) => `${fp(l)?.userAgentData?.platform} ${fp(l)?.userAgentData?.high?.platformVersion}`],
  ["navigator.webdriver", (l) => fp(l)?.navigator.webdriver],
  ["navigator.plugins", (l) => fp(l)?.navigator.plugins.length],
  ["window.chrome keys", (l) => fp(l)?.chromeObject?.keys.join(",")],
  ["languages", (l) => fp(l)?.navigator.languages.join(",")],
  ["time zone", (l) => fp(l)?.intl.timeZone],
  ["hardwareConcurrency / deviceMemory", (l) => `${fp(l)?.navigator.hardwareConcurrency} / ${fp(l)?.navigator.deviceMemory}`],
  ["screen / window", (l) => `${fp(l)?.screen.width}x${fp(l)?.screen.height} dpr ${fp(l)?.screen.devicePixelRatio} / ${fp(l)?.window.outerWidth}x${fp(l)?.window.outerHeight}`],
  ["fonts found (of 65)", (l) => fp(l)?.fonts.length],
  ["canvas hash", (l) => fp(l)?.canvas],
  ["audio sum", (l) => fp(l)?.audio?.sum],
  ["WebGL renderer", (l) => fp(l)?.webgl?.unmaskedRenderer ?? fp(l)?.webgl ?? null],
  ["WebGPU", (l) => fp(l)?.webgpu?.info ?? (fp(l)?.webgpu?.available ? "API present, no adapter" : "no API")],
  ["speech voices", (l) => fp(l)?.voices?.count],
  ["Widevine (EME)", (l) => fp(l)?.media?.eme?.["com.widevine.alpha"]?.ok ?? fp(l)?.media?.eme?.["com.widevine.alpha"]],
  ["H.264 / HEVC / AV1 canPlayType", (l) => ["avc1.42E01E", "hvc1.1.6.L93.B0", "av01.0.05M.08"].map((c) => fp(l)?.media?.canPlay[`video/mp4; codecs="${c}"`] || "no").join(" / ")],
  ["storage quota (bytes)", (l) => fp(l)?.storage?.quota],
  ["window globals", (l) => fp(l)?.globals.length],
  ["CSS properties", (l) => fp(l)?.cssProperties.length],
  ["hash: globals / CSS / prototypes", (l) => `${fp(l)?.hashes.globals} / ${fp(l)?.hashes.cssProperties} / ${fp(l)?.hashes.prototypes}`],
  ["JA4 (full handshake)", (l) => fullHello(l)?.ja4],
  ["JA4 (resumed, with PSK)", (l) => first(tls(l), "tls-hello", (d) => d.extensionsSorted.includes("0029"))?.ja4],
  ["TLS groups / key shares", (l) => `${fullHello(l)?.groups.join(",")} / ${fullHello(l)?.keyShares.join(",")}`],
  ["TLS extensions (sorted)", (l) => fullHello(l)?.extensionsSorted.join(",")],
  ["ALPS / ECH GREASE", (l) => `${fullHello(l)?.alps.join(",")} / ${fullHello(l)?.ech}`],
  // The fingerprint record, or the first HTTP/2 frames plus the first h2 request's header order.
  ["Akamai HTTP/2", (l) => first(tls(l), "h2-fingerprint")?.akamai ?? (() => {
    const start = first(tls(l), "h2-start")?.start;
    const req = first(tls(l), "request", (d) => d.proto === "h2");
    return start && req ? akamaiH2(start, req.rawHeaders.map(([k]: [string]) => k)) : undefined;
  })()],
  ["HTTP/2 first HEADERS priority", (l) => first(tls(l), "h2-start")?.start.firstHeaders],
  ["DBSC registration call", (l) => (all(tls(l), "dbsc").length ? all(tls(l), "dbsc").map((x) => x.data.path).join(",") : "none")],
]);

// --- Features of one version only -----------------------------------------------------------------

const diff = (a: string[] = [], b: string[] = []) => ({ onlyA: a.filter((x) => !b.includes(x)), onlyB: b.filter((x) => !a.includes(x)) });
console.log("\n## Features of one version only (window globals, prototypes, CSS properties)\n");
for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
  const [a, b] = [labels[i], labels[j]];
  const fa = fp(a), fb = fp(b);
  if (!fa || !fb) continue;
  const parts: [string, string[], string[]][] = [["globals", fa.globals, fb.globals], ["CSS", fa.cssProperties, fb.cssProperties]];
  for (const k of Object.keys(fa.prototypes)) parts.push([`${k}.prototype`, fa.prototypes[k], fb.prototypes[k]]);
  console.log(`### ${a} vs ${b}\n`);
  let any = false;
  for (const [name, x, y] of parts) {
    const d = diff(x, y);
    if (!d.onlyA.length && !d.onlyB.length) continue;
    any = true;
    console.log(`- ${name}: only in ${a}: ${d.onlyA.join(", ") || "none"}; only in ${b}: ${d.onlyB.join(", ") || "none"}`);
  }
  if (!any) console.log("- no difference");
  console.log();
}

// --- Loading the extension -------------------------------------------------------------------------

const RUNS = ["cmdline-ext", "cmdline-ext-feature", "cdp-install", "relaunch-cdp-flag", "relaunch-cdp", "cdp-install-devmode", "relaunch-cdp-devmode",
  "ui-install", "relaunch-silent", "relaunch-banner", "update", "update-devmode-off", "update-devmode-off-relaunch", "ui-install-2", "devmode-off",
  "devmode-off-relaunch", "external-crx", "external-crx-relaunch", "external-crx-banner"];
const ours = (r: Run | undefined) => {
  const v = Object.values(r?.prefs?.ours ?? {})[0] as any;
  return v ? `in prefs (location ${v.location}${v.disable_reasons?.length ? `, disabled ${v.disable_reasons.join("+")}` : ""})` : "not in prefs";
};
table("Loading the extension: did its service worker start? (and the profile afterwards)", RUNS.map((run) => [run, (l: string) => {
  const r = load(l, run);
  if (!r) return undefined;
  const alive = r.extAlive ?? !!first(r, "ext-alive");
  return `${alive ? "**loaded**" : "not loaded"}; ${ours(r)}; developer mode ${r.prefs?.developerMode ?? false}`;
}]));
for (const l of labels) {
  const u = load(l, "update");
  const other = u && labels.find((o) => summary.browsers[o].bin === u.bin);
  if (u) console.log(`\nThe update rows of ${l} ran ${other ?? u.bin} (${u.bin === summary.browsers[l].bin ? "the same browser" : "a newer browser of the same product"}) on ${l}'s "Load unpacked" profile.`);
}

// --- While an agent drives ---------------------------------------------------------------------------

// The run where the extension drove a tab: relaunch-silent, else cmdline-ext (Chromium), else
// external-crx-relaunch, else the update run of another label that ran this label's browser. Without
// the silent flag: relaunch-banner, else external-crx-banner.
const driven = (l: string, silent: boolean) => {
  for (const run of silent ? ["relaunch-silent", "cmdline-ext", "external-crx-relaunch"] : ["relaunch-banner", "external-crx-banner"]) { const r = load(l, run); if (r && mark(r, "attach")) return r; }
  if (silent) for (const o of labels) { const r = load(o, "update"); if (r && r.bin === summary.browsers[l].bin && mark(r, "attach")) return r; }
  return undefined;
};
// A mark is set when the extension's answer comes back, so an event of that step comes before its
// mark: a step's events lie between the previous mark and its own. Page events count at page time.
const between = (r: Run | undefined, kind: string, from: string, to?: string) => {
  const a = mark(r, from), b = to ? mark(r, to) : Infinity;
  return a === undefined ? [] : all(r, kind).filter((x) => { const t = x.data?.pageT ?? x.t; return t >= a && t <= (b ?? Infinity); });
};
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : undefined; };
const pd = (r: Run | undefined, after?: string, before?: string) => {
  const ev = (after ? between(r, "page-input", after, before) : all(r, "page-input")).map((x) => x.data);
  const down = ev.find((e) => e.type === "pointerdown");
  return down ? `pressure ${down.pressure}, width ${down.width}, screenY-clientY ${down.screenY - down.clientY}` : "none";
};
const keyp = (r: Run | undefined, after?: string) => {
  const ev = (after ? between(r, "page-input", after) : all(r, "page-input")).map((x) => x.data).filter((e) => e.type === "keypress" || e.type === "keydown");
  return ev.slice(0, 2).map((e) => `${e.type} key=${e.key} code=${e.code} keyCode=${e.keyCode} charCode=${e.charCode}`).join("; ") || "none";
};
const hidden = (r: Run | undefined) => {
  const v = all(r, "page-visibility").map((x) => x.data).find((d) => d.state === "visible" && d.ticks !== undefined);
  return v ? `median ${v.medianGapMs} ms, max ${v.maxGapMs} ms (${v.ticks} ticks in ${v.hiddenMs} ms; 50 ms asked)` : "–";
};
table("While the agent drives through chrome.debugger (relaunch-silent; Chromium: cmdline-ext)", [
  ["extension installType", (l) => first(driven(l, true), "ext-result", (d) => d.op === "self")?.result?.installType],
  ["page can fetch the extension's manifest / chrome.runtime on page", (l) => { const e = first(driven(l, true), "page-extension-visible"); return e ? `${e.manifestFetch?.status ?? e.manifestFetch?.error} / ${e.runtimeOnPage}` : undefined; }],
  ["navigator.webdriver while attached", (l) => [...new Set(between(driven(l, true), "page-tick", "attach", "detach").map((x) => x.data.webdriver))].join(",") || "no sample"],
  ["the run", (l) => { const r = driven(l, true); return r ? `${r.records[0]?.run} (${r.bin === summary.browsers[l].bin ? "this browser" : "?"})` : undefined; }],
  ["page resize at attach (silent flag)", (l) => between(driven(l, true), "page-resize", "findTab", "cdp-click").map((x) => x.data.innerHeight).join(",") || "none"],
  ["page resize at attach (no silent flag)", (l) => { const r = driven(l, false); const fpd = first(r, "page-fp"); const rs = between(r, "page-resize", "findTab", "cdp-click").map((x) => x.data.innerHeight); return r ? (rs.length ? `${fpd?.window.innerHeight} -> ${rs.join(",")}` : "none") : undefined; }],
  ["Error.stack trap after Runtime.enable", (l) => between(driven(l, true), "page-trap", "runtime-enable", "runtime-disable").length ? "fired" : "silent"],
  ["console.debug(2 MB) ms: before / Runtime on / after", (l) => {
    const r = driven(l, true);
    const ms = (a: string, b?: string) => median(between(r, "page-console-ms", a, b).map((x) => x.data.ms));
    return `${ms("attach", "runtime-enable")} / ${ms("runtime-enable", "runtime-disable")} / ${ms("runtime-disable", "hidden-start")}`;
  }],
  ["CDP click: pointerdown", (l) => pd(driven(l, true), "attach", "cdp-click")],
  ["CDP click with force 0.5: pointerdown", (l) => pd(driven(l, true), "cdp-click", "cdp-click-force")],
  ["real click (xdotool, site run): pointerdown", (l) => pd(load(l, "site"))],
  ["CDP keys", (l) => keyp(driven(l, true), "cdp-click-force")],
  ["real keys (xdotool, site run)", (l) => keyp(load(l, "site"), "real-click")],
  ["hidden tab timers, agent flags (extension's new tab)", (l) => hidden(driven(l, true))],
  ["hidden tab timers, agent flags (real Ctrl+T)", (l) => hidden(load(l, "site"))],
  ["hidden tab timers, plain flags (real Ctrl+T)", (l) => hidden(load(l, "site-plain"))],
]);

// --- Prompts and screenshots -------------------------------------------------------------------------

console.log("\n## Screenshots (review them for prompts, bars and banners)\n");
for (const l of labels) {
  const shots: string[] = [];
  for (const run of ["site", "site-plain", "tls", "cmdline-ext", "cdp-install", "ui-install", "relaunch-silent", "relaunch-banner", "update", "devmode-off-relaunch", "external-crx", "external-crx-relaunch", "external-crx-banner", "inspect-approval"]) {
    const r = load(l, run);
    for (const [k, v] of Object.entries(r?.shots ?? {})) if (typeof v === "string" && !v.startsWith("failed")) shots.push(`${run}/${k}: \`${v.replace(DIR + "/", "")}\``);
  }
  console.log(`- **${l}**: ${shots.join("; ")}`);
  const ia = load(l, "inspect-approval") as any;
  if (ia) console.log(`  - inspect-approval: DevTools WebSocket ${ia.state?.opened ? "opened" : "did not open"} in 10 s with nobody at the prompt`);
}

// --- What each browser tried to reach -----------------------------------------------------------------

console.log("\n## Outside hosts each browser tried at start (all refused by the probe's proxy; site-plain run)\n");
for (const l of labels) {
  const hosts = [...new Set(summary.blockedEgress.filter((e: any) => e.run === `${l}/site-plain`).map((e: any) => e.host.replace(/:443$/, "")))].sort();
  console.log(`- **${l}**: ${hosts.join(", ") || "none"}`);
}
