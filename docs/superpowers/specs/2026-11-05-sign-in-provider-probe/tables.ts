// The tables of the design's sections 4 and 6 from a run of part "initiator" (results/initiator.json).
//
//   node tables.ts results/initiator.json
//
// Table 1: for each kind of navigation, who started each main-frame request (webRequest's initiator, also over
// redirects), and what the relay's Page events say. Table 2: for each kind and each rule set, which main-frame
// targets loaded and which DNR blocked, in every repetition.

import { readFileSync } from "node:fs";

const r = JSON.parse(readFileSync(process.argv[2] ?? "results/initiator.json", "utf8"));
const trials: any[] = r.trials;
const kinds = [...new Set(trials.map((t) => t.kind))];
const sets = [...new Set(trials.map((t) => t.set))];
const uniq = (xs: string[]) => [...new Set(xs)];
const hostPath = (u: string) => u.replace(/\?.*$/, "");

console.log("| Kind | Who | Main-frame requests (initiator) | The relay's Page events (reason, disposition / navigationType) | webNavigation transition |");
console.log("| --- | --- | --- | --- | --- |");
for (const k of kinds) {
  // Today's rules first; a kind that starts on the provider's page (blocked today) from the trials of option a.
  let ts = trials.filter((t) => t.kind === k && t.set === "today" && t.mainRequests);
  const from = ts.length ? "today" : "a";
  if (!ts.length) ts = trials.filter((t) => t.kind === k && t.set === "a" && t.mainRequests);
  if (!ts.length) continue;
  const reqOf = (t: any) => {
    const main = t.mainRequests.map((m: any) => `${hostPath(m.url)} (${m.initiator ?? "none"}${m.method === "POST" ? ", POST" : ""}${m.tab === "new" ? ", new tab" : ""})`);
    const frames = (t.events ?? []).filter((e: any) => e.ev === "request" && e.type === "sub_frame").map((e: any) => `frame ${hostPath(e.url)} (${e.initiator ?? "none"})`);
    return [...main, ...frames].join(" -> ") || "no request";
  };
  const reqs = uniq(ts.map(reqOf)).map((x) => (from === "a" ? `${x} [set a]` : x));
  const relay = uniq(ts.map((t) => (t.relaySees ?? []).filter((e: any) => e.frame === "main").map((e: any) => e.m === "frameRequestedNavigation" ? `requested ${e.reason}/${e.disposition}` : `started ${e.navigationType}`).join(", ") || "none"));
  const tr = uniq(ts.map((t) => (t.committed ?? []).map((c: any) => `${c.frame === "sub" ? "frame " : ""}${c.transitionType}${c.qualifiers?.length ? "+" + c.qualifiers.join("+") : ""}`).join(", ") || "none"));
  console.log(`| ${k} | ${ts[0].who} | ${reqs.join(" / ")} | ${relay.join(" / ")} | ${tr.join(" / ")} |`);
}

console.log("\n| Kind | " + sets.join(" | ") + " |");
console.log("| --- | " + sets.map(() => "---").join(" | ") + " |");
for (const k of kinds) {
  const cells = sets.map((s) => {
    const ts = trials.filter((t) => t.kind === k && t.set === s);
    if (!ts.length) return "";
    if (ts.every((t) => t.setup)) return `setup blocked (${ts.length})`;
    const outs = ts.map((t) => {
      const blocked = (t.blocked ?? []).filter((b: any) => b.type === "main_frame").map((b: any) => hostPath(b.url));
      const loaded = (t.committed ?? []).map((c: any) => (c.frame === "sub" ? "frame " : "") + hostPath(c.url)).filter((u: string) => u !== "blank");
      return `${loaded.length ? "loaded " + uniq(loaded).join(", ") : ""}${blocked.length ? `${loaded.length ? "; " : ""}blocked ${uniq(blocked).join(", ")}` : ""}` || "nothing";
    });
    const u = uniq(outs);
    return u.length === 1 ? `${u[0]} (${ts.length} of ${ts.length})` : u.map((o) => `${o} (${outs.filter((x) => x === o).length})`).join(" / ");
  });
  console.log(`| ${k} | ${cells.join(" | ")} |`);
}
