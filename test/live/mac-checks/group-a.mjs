// Group A of the Mac checks (board ab-v16.94.6; A3 again after ab-v16.94.29): read-only, no Chrome, nothing installed.
// Run on the Mac from the checkout's top folder, after `npm ci --ignore-scripts`:
//   node test/live/mac-checks/group-a.mjs <a new empty temp folder>
// Files are made only under that temp folder. Each line is PASS, FAIL or NOTE; the last line is DONE.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, symlinkSync, statSync, realpathSync } from "node:fs";
import { createServer, connect } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
const T = realpathSync(process.argv[2]);
const imp = (p) => import(pathToFileURL(join(process.cwd(), p)).href);
const row = (id, ok, d) => console.log(`${ok === true ? "PASS" : ok === false ? "FAIL" : "NOTE"} ${id}: ${typeof d === "string" ? d : JSON.stringify(d)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const m = await imp("src/service/mac.ts");
const lib = await m.loadMacLib();
let p = null;
if (lib.failed) row("A1 loadMacLib", false, lib.failed); else p = new m.MacProcs(lib);
if (p) {
  const self = p.proc(process.pid);
  row("A1 proc(self) ppid", self?.ppid === process.ppid, { self, ppid: process.ppid });
  const argv = p.cmdline(process.pid);
  row("A1 cmdline(self) ends with the temp folder", argv.at(-1) === process.argv[2], argv);
  row("A1 exe(self) is node's real path", p.exe(process.pid) === realpathSync(process.execPath), p.exe(process.pid));
  const n = p.pids().length; row("A1 pids() > 100", n > 100, n);
  const boot = p.bootId(); row("A1 bootId is a UUID", /^[0-9A-F]{8}-([0-9A-F]{4}-){3}[0-9A-F]{12}$/i.test(boot ?? ""), boot);
  const kid = spawn(process.execPath, ["-e", "setTimeout(()=>{},20000)", "--", "--user-data-dir=/tmp/a b"], { stdio: "ignore" });
  await sleep(500);
  const ka = p.cmdline(kid.pid);
  row("A2 an argument with a space stays whole", ka.at(-1) === "--user-data-dir=/tmp/a b", ka);
  kid.kill();
  const srv = createServer(() => {}); await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const accepted = new Promise((r) => srv.once("connection", r));
  const cli = spawn(process.execPath, ["-e", `const s=require("net").connect(${port},"127.0.0.1");setTimeout(()=>s.end(),15000)`], { stdio: "ignore" });
  const sock = await accepted;
  const childAddr = `127.0.0.1:${sock.remotePort}`, srvAddr = `127.0.0.1:${port}`;
  const reader = m.macTcpReader(p);
  const t0 = performance.now(); const lines = reader.tcp(); const dt = performance.now() - t0;
  row("A3 tcp() time under 100 ms", dt < 100, `${dt.toFixed(1)} ms, ${lines?.length ?? "null"} lines`);
  const out = (lines ?? []).filter((l) => l.local === childAddr && l.remote === srvAddr);
  row("A3 exactly one line for the child's socket, with the operator's uid", out.length === 1 && out[0].uid === process.getuid(), out);
  if (out.length === 1) row("A3 its holder is the child's pid", reader.holders(out[0].inode).includes(cli.pid), { holders: reader.holders(out[0].inode), child: cli.pid });
  const back = (lines ?? []).filter((l) => l.local === srvAddr && l.remote === childAddr);
  row("A3 the accepted socket has the reverse tuple, held by this process", back.length === 1 && reader.holders(back[0].inode).includes(process.pid), back);
  cli.kill(); srv.close(); sock.destroy();
  const job = await m.launchdJob("com.agentwatch");
  row("A4 launchctl print gui/<uid>/com.agentwatch", job ? job.state === "running" && job.pid > 0 : null, job ?? "no such job");
  if (job?.pid) {
    const a = p.procArgs(job.pid), e = p.exeBytes(job.pid);
    row("A4 the job's process", null, { exec: a?.exec, argv: a?.argv.map((b) => b.toString()), exe: e?.toString() });
    const kids = p.pids().filter((x) => p.proc(x)?.ppid === job.pid);
    row("A4 the job's children", null, kids.map((k) => ({ pid: k, argv: p.cmdline(k).slice(0, 6) })));
  }
  const dc = join(homedir(), ".config", "agent-browser", "daemon-command.json");
  row("A4 daemon-command.json", null, (() => { try { statSync(dc); return "present"; } catch { return "absent (agentwatch writes it at stage 4)"; } })());
}
const { StateFolder } = await imp("src/relay/scope-files.ts");
const S = join(T, "state");
mkdirSync(join(S, "profile", "Default"), { recursive: true }); writeFileSync(join(S, "profile", "Default", "Cookies"), "x");
mkdirSync(join(S, "mcp", "s1", "f1"), { recursive: true });
mkdirSync(join(T, "outside"), { recursive: true }); writeFileSync(join(T, "outside", "x.txt"), "x");
const g = new StateFolder(S);
const want = (id, path, refused) => { const got = g.covers(path, "s1"); row(id, got === refused, `${got ? "refused" : "passes"} ${path}`); };
const DV = "/System/Volumes/Data";
const st = (x) => { try { const s = statSync(x); return `${s.dev} ${s.ino}`; } catch (e) { return `stat fails (${e.code})`; } };
row("F1 the data volume form of the state has the same dev and ino", st(S) === st(DV + S) && !st(S).startsWith("stat"), [st(S), st(DV + S)]);
want("F2 the state in capitals", S.toUpperCase(), true);
want("F2 a file in PROFILE", join(S, "PROFILE", "Default", "Cookies"), true);
for (const x of [DV + join(S, "profile", "Default", "Cookies"), DV, "/System/Volumes", "/System"]) want("F3 a data volume or firmlink form", x, true);
const nfc = join(T, "nf-café"), nfS = join(nfc, "state");
mkdirSync(join(nfS, "profile"), { recursive: true });
{ const gn = new StateFolder(nfS); const pth = join(T, "nf-café", "state", "profile"); const got = gn.covers(pth, "s1"); row("F4 an NFD form of an NFC state", got === true, `${got ? "refused" : "passes"} (NFD)`); }
symlinkSync(join(S, "profile"), join(T, "link-prof")); want("F5 a link to the profile", join(T, "link-prof", "Default", "Cookies"), true);
const sv = statSync(S), sp = statSync(join(S, "profile")), sc = statSync(join(S, "profile", "Default", "Cookies"));
for (const x of [`/.vol/${sv.dev}/${sv.ino}`, `/.vol/${sv.dev}/${sv.ino}/profile`, `/.vol/${sp.dev}/${sp.ino}/Default/Cookies`, `/.vol/${sc.dev}/${sc.ino}`, `/.VOL/${sv.dev}/${sv.ino}`]) want("F5 a /.vol form", x, true);
symlinkSync("/.vol", join(T, "link-vol")); want("F5 a link to /.vol", join(T, "link-vol", String(sp.dev), String(sp.ino), "Default", "Cookies"), true);
symlinkSync(`/.vol/${sp.dev}/${sp.ino}`, join(T, "link-prof2"));
{ const pth = join(T, "link-prof2", "Default", "Cookies"); const got = g.covers(pth, "s1"); let statOk = true; try { statSync(pth); } catch { statOk = false; }
  row("F5 a link to a deep /.vol form", got === true ? true : statOk ? false : null, `${got ? "refused" : "passes"}; stat ${statOk ? "works" : "fails"}`); }
want("F6 a missing file under the profile", join(S, "profile", "Default", "NoSuch"), true);
want("F6 a missing file under the state in capitals", join(S.toUpperCase(), "profile", "NoSuch", "x.txt"), true);
for (const x of [join(homedir(), "Documents"), join(T, "outside", "x.txt"), join(T, "OUTSIDE", "X.TXT"), DV + join(T, "outside", "x.txt"), join(T, "outside", "NoSuch"), S + "-other/x"]) want("F7 a path outside", x, false);
want("F8 the MCP folder of s1", join(S, "mcp", "s1", "f1"), false);
want("F8 its case form", join(S, "MCP", "S1", "F1"), true);
want("F8 its data volume form", DV + join(S, "mcp", "s1", "f1"), true);
const { filesRefusal, FILE_PATH_MAX } = await imp("src/relay/stage.ts");
row("F11 FILE_PATH_MAX", FILE_PATH_MAX === 1024, FILE_PATH_MAX);
for (const [n, refused] of [[1023, false], [1024, true]]) { const r = filesRefusal(null, "DOM.setFileInputFiles", { files: ["/" + "a".repeat(n - 1)] }, { coversAny: () => false }); row(`F11 a path of ${n} bytes`, (r != null) === refused, r ?? "passes"); }
console.log("DONE");
