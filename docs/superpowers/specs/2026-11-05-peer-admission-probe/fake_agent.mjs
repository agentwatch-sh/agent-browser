// An agent-like process (board ab-v16.47 probe). It runs in a tmux pane that the probe starts, as
// claude runs in an agentwatch session's pane, and starts the child shapes that Claude Code starts
// (measured on taylor from this session's own claude, read only: each Bash tool command is
// `/bin/bash -c ...` with its own process group and session, a child of claude; an MCP server is a
// stdio child of claude in claude's process group, sometimes under a wrapper such as uv or npx).
//   node fake_agent.mjs <socket path> <agent-browser bin> [late output file]
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const [sock, abBin, lateArg] = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));
const py = (label, extra = "") => `python3 ${join(here, "client.py")} ${sock} ${label} ${extra}`;
const stateDir = mkdtempSync(join(tmpdir(), "peer-probe-ab-"));
writeFileSync(join(stateDir, "allowlist.json"), JSON.stringify({ allow: ["example.com"] }));
const ab = (label) => `node ${abBin} tabs --cdp-url ws+unix://${sock}:/devtools/browser/${label} --state-dir ${stateDir} --allowlist ${join(stateDir, "allowlist.json")} 2>&1 | head -1`;
/** Claude Code's own form of a Bash tool command (read from this session's process table): a snapshot
 * source and an eval, so bash never execs the command in its own process. */
const cc = (cmd) => `source /dev/null 2>/dev/null || true && eval ${JSON.stringify(cmd)}`;
const late = lateArg ?? join(here, "results", "late.txt"); // the output of the shapes whose shell exits first

console.log(`fake_agent: pid ${process.pid} ppid ${process.ppid}`);

/** A Bash tool command: its own process group and session (detached), a child of the agent. */
function tool(label, cmd, { wait = true } = {}) {
  return new Promise((resolve) => {
    const c = spawn("/bin/bash", ["-c", cmd], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (d) => { out += d; });
    c.stderr.on("data", (d) => { out += d; });
    if (!wait) { c.unref(); resolve(`${label}: started in the background (shell pid ${c.pid})`); return; }
    c.on("close", () => resolve(`${label}: shell pid ${c.pid}: ${out.trim()}`));
  });
}

/** An MCP server: a stdio child of the agent, in its process group (not detached). */
function mcp(label, argv) {
  return new Promise((resolve) => {
    const c = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "inherit"] });
    c.stdout.once("data", (d) => { resolve(`${label}: server pid ${c.pid}: ${String(d).trim()}`); c.stdin.end(); });
    c.stdin.write("connect\n");
  });
}

const results = [];
results.push(await tool("tool-python", py("tool-python")));
results.push(await tool("tool-playwright", `node ${join(here, "pw_client.mjs")} ${sock} tool-playwright`));
results.push(await tool("tool-agent-browser", ab("tool-agent-browser")));
results.push(await tool("tool-agentwatch-browser-like", `python3 -c 'import subprocess,sys; sys.exit(subprocess.run(["/bin/sh","-c",sys.argv[1]]).returncode)' '${ab("tool-agentwatch-browser-like")}'`));
results.push(await tool("tool-amp-job-shell-exits", `${py("tool-amp-job-shell-exits", "--wait 0.5")} >> ${late} 2>&1 &`));
results.push(await tool("tool-nohup-shell-lives", `nohup ${py("tool-nohup-shell-lives")} 2>&1 & wait`));
results.push(await tool("tool-nohup-shell-exits", `nohup ${py("tool-nohup-shell-exits", "--wait 0.5")} >> ${late} 2>&1 &`));
results.push(await tool("tool-setsid-sole", `setsid ${py("tool-setsid-sole")}`));
results.push(await tool("tool-setsid-fork", `setsid -f ${py("tool-setsid-fork", "--wait 0.5")} >> ${late} 2>&1`));
results.push(await tool("tool-double-fork", `${py("tool-double-fork", "--double-fork")} ; sleep 1`));
results.push(await tool("cc-python", cc(py("cc-python"))));
results.push(await tool("cc-setsid-real", cc(`setsid ${py("cc-setsid-real")}`)));
results.push(await tool("cc-setsid-fork", cc(`setsid -f ${py("cc-setsid-fork", "--wait 0.5")} >> ${late} 2>&1`)));
results.push(await tool("cc-nohup-amp", cc(`nohup ${py("cc-nohup-amp", "--wait 0.5")} >> ${late} 2>&1 &`)));
results.push(await tool("cc-agent-browser", cc(ab("cc-agent-browser"))));
results.push(await tool("tmux-new-window", `tmux new-window -d '${py("tmux-new-window")} >> ${late} 2>&1'`));
results.push(await tool("tool-bg-job", `${py("tool-bg-job", "--wait 1")} >> ${late} 2>&1`, { wait: false }));
results.push(await mcp("mcp-direct", ["node", join(here, "mcp_like.mjs"), sock, "mcp-direct"]));
results.push(await mcp("mcp-wrapped", ["/bin/sh", "-c", `node ${join(here, "mcp_like.mjs")} ${sock} mcp-wrapped`]));
results.push(await mcp("mcp-python", ["/bin/sh", "-c", `while read l; do ${py("mcp-python")}; done`]));
for (const r of results) console.log(r);
await new Promise((r) => setTimeout(r, 2500));
console.log("fake_agent: done");
