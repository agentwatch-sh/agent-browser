// CDP multiplexing proxy. One long-lived process holds a single upstream browser connection and
// shares it with every command and script of one consumer over that consumer's private Unix socket
// (Chrome asks the operator to approve every new remote-debugging connection, so the proxy's is the
// single approved one). Every connection the library makes goes through this socket.
//
// Requests are forwarded with remapped ids. Session-scoped events go to the client that attached
// that session; browser-level events go to every client. When a client leaves, its sessions are
// detached upstream.

import { createServer } from "node:http";
import { connect } from "node:net";
import { rmSync, writeFileSync, readFileSync, chmodSync, openSync, closeSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { browserTarget, lastProxyAttempt, promptNotice, proxyLogPath, recordProxyAttempt, UNANSWERED, type ProxyAttempt } from "./diagnostics.ts";
import { stateDir, statePath, type Settings } from "./options.ts";
import { makeApprover } from "./approver.ts";
import { withFileLock } from "./lock.ts";

/** The CLI entry the proxy child runs from: plain JavaScript, so it also starts from a node_modules install. */
export const BIN_PATH = fileURLToPath(new URL("../bin/agent-browser.js", import.meta.url));

export function proxyUrl(s: Settings): string {
  return `ws+unix://${s.socketPath}:/cdp`;
}

const pidFile = (s: Settings) => statePath(s, "chrome-proxy.json");

/** A live socket is never stale, even when its pid file is missing or delayed. */
export function socketAlive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}

/**
 * What a failed upstream handshake means for the operator. Chrome answers "403 Connection rejected" at
 * once, with no prompt, when this Chrome run holds a refusal (an "Allow remote debugging?" prompt for it
 * was cancelled, closed or left unanswered): only a restart of that Chrome clears it (measured on Chrome
 * Beta 158, 2026-10-30).
 */
export function handshakeFailure(message: string, s: Pick<Settings, "mode" | "commandName">): string {
  if (!/Unexpected server response: 403\b/.test(message)) return message;
  const fix = s.mode === "agent"
    ? `run \`${s.commandName} quit\`, then \`${s.commandName} launch\`, and click Allow on Chrome's prompt`
    : "quit and reopen that Chrome, then click Allow on its prompt";
  return `${message}: Chrome refused the connection without a prompt, because this Chrome run holds an earlier refusal (a cancelled, closed or unanswered "Allow remote debugging?" prompt); ${fix}`;
}

export async function runProxy(s: Settings, upstreamUrl: string, opts: { attempt?: string; timeoutMs?: number } = {}): Promise<void> {
  const attempt = opts.attempt ?? randomUUID(), target = browserTarget(s);
  const record = (phase: string, detail?: string, approval?: "refused") =>
    recordProxyAttempt(s, { attempt, target, upstream: upstreamUrl, phase, ...(detail ? { detail } : {}), ...(approval ? { approval } : {}) });
  record("child-connect", "upstream handshake starting; approval status unknown");
  let upstream: WebSocket;
  try {
    if (await socketAlive(s.socketPath)) throw new Error(`chrome proxy already running on ${s.socketPath}`);
    upstream = new WebSocket(upstreamUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024, handshakeTimeout: opts.timeoutMs ?? 90_000 });
    // The upstream open blocks on Chrome's "Allow?" dialog. If approval is configured, answer that one
    // dialog (the connection we just caused) while we wait. Best-effort: it never rejects this startup.
    const approver = makeApprover(s);
    if (approver) { record("child-approve", "answering the remote-debugging dialog for this connection"); void approver().catch(() => {}); }
    await new Promise<void>((resolve, reject) => {
      upstream.once("open", () => resolve());
      upstream.once("error", reject);
      upstream.once("close", (code) => reject(new Error(`upstream closed before ready (code ${code})`)));
    });
  } catch (e) {
    const why = handshakeFailure((e as Error).message, s), refused = why !== (e as Error).message;
    const unanswered = /handshake has timed out/i.test(why) ? `; ${UNANSWERED}` : "; approval status unknown";
    record("child-error", `upstream handshake failed: ${why}${refused ? "" : unanswered}`, refused ? "refused" : undefined);
    throw e;
  }
  record("child-connected");

  let nextId = 1;
  const pending = new Map<number, { client: WebSocket; id: number; method: string }>();
  const sessionOwner = new Map<string, WebSocket>();
  const clients = new Set<WebSocket>();
  let idleTimer: NodeJS.Timeout | undefined;
  let socketInode: number | undefined;

  const shutdown = (why: string) => {
    record("child-exit", why);
    console.error(`chrome proxy exiting: ${why}`);
    for (const c of clients) c.close();
    if (socketInode !== undefined && proxyInfo(s)?.pid === process.pid && socketInode === statSync(s.socketPath, { throwIfNoEntry: false })?.ino) {
      rmSync(s.socketPath, { force: true });
      rmSync(pidFile(s), { force: true });
    }
    process.exit(0);
  };
  const armIdle = () => {
    clearTimeout(idleTimer);
    if (clients.size === 0) idleTimer = setTimeout(() => shutdown("idle"), s.proxyIdleMs);
  };

  upstream.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    if (typeof msg.id === "number") {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (p.method === "Target.attachToTarget" && msg.result?.sessionId) sessionOwner.set(msg.result.sessionId, p.client);
      msg.id = p.id;
      if (p.client.readyState === WebSocket.OPEN) p.client.send(JSON.stringify(msg));
      return;
    }
    if (msg.method === "Target.detachedFromTarget") sessionOwner.delete(msg.params.sessionId);
    // A session that Chrome attaches through another one (auto-attach: a page's worker) belongs to the
    // client that owns the parent session, so its events reach that client and nobody else.
    if (msg.method === "Target.attachedToTarget" && msg.sessionId && msg.params?.sessionId) {
      const parent = sessionOwner.get(msg.sessionId);
      if (parent) sessionOwner.set(msg.params.sessionId, parent);
    }
    const owner = msg.sessionId ? sessionOwner.get(msg.sessionId) : undefined;
    const text = JSON.stringify(msg);
    if (owner) { if (owner.readyState === WebSocket.OPEN) owner.send(text); }
    else if (!msg.sessionId) for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(text);
  });
  // The close code, its reason and any socket error say who ended the approved connection, and how.
  let upstreamError: string | undefined;
  upstream.on("error", (e) => { upstreamError = e.message; });
  upstream.on("close", (code, reason) => shutdown(`Chrome connection closed (code ${code}${reason.length ? `, reason ${JSON.stringify(String(reason))}` : ""}${upstreamError ? `, error ${upstreamError}` : ""})`));

  if (await socketAlive(s.socketPath)) { upstream.close(); throw new Error(`chrome proxy already running on ${s.socketPath}`); }
  rmSync(s.socketPath, { force: true });
  const http = createServer((_, res) => { res.writeHead(426); res.end(); });
  const wss = new WebSocketServer({ server: http, perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
  wss.on("connection", (client) => {
    clients.add(client);
    armIdle();
    client.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      const id = nextId++;
      pending.set(id, { client, id: msg.id, method: msg.method });
      upstream.send(JSON.stringify({ ...msg, id }));
    });
    client.on("close", () => {
      clients.delete(client);
      for (const [sid, owner] of sessionOwner) {
        if (owner !== client) continue;
        sessionOwner.delete(sid);
        upstream.send(JSON.stringify({ id: nextId++, method: "Target.detachFromTarget", params: { sessionId: sid } }));
      }
      for (const [id, p] of pending) if (p.client === client) pending.delete(id);
      armIdle();
    });
  });
  // The socket is created private: no moment exists in which another user could connect to it.
  const umask = process.umask(0o077);
  try { await new Promise<void>((resolve) => http.listen(s.socketPath, resolve)); }
  finally { process.umask(umask); }
  socketInode = statSync(s.socketPath).ino;
  chmodSync(s.socketPath, 0o600);
  writeFileSync(pidFile(s), JSON.stringify({ pid: process.pid, upstream: upstreamUrl }, null, 2));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  armIdle();
  record("child-ready");
  console.error(`chrome proxy ready on ${s.socketPath} (pid ${process.pid})`);
}

export function proxyInfo(s: Settings): { pid: number; upstream: string } | undefined {
  try { return JSON.parse(readFileSync(pidFile(s), "utf8")); } catch { return undefined; }
}

/** The CLI flags that carry the approve setting to the proxy child. */
export function approveArgs(approve: Settings["approve"]): string[] {
  if (approve === undefined || approve === false) return [];
  if (approve === true) return ["--approve", "auto"];
  if (typeof approve === "string") return ["--approve", approve];
  return ["--approve-command", JSON.stringify(approve.command)];
}

/** The argv of the proxy child: this consumer's settings, so it writes to the same state folder and socket. */
export function proxyArgs(s: Settings, upstreamUrl: string, attempt: string, timeoutMs: number): string[] {
  return [BIN_PATH, "proxy", upstreamUrl, "--state-dir", s.stateDir, "--socket", s.socketPath, "--profile", s.profileDir,
    "--mode", s.mode, "--proxy-idle-ms", String(s.proxyIdleMs), "--command-name", s.commandName,
    ...(s.chromeBin ? ["--chrome-bin", s.chromeBin] : []), ...(s.endpoint ? ["--endpoint", s.endpoint] : []),
    ...approveArgs(s.approve),
    "--attempt", attempt, "--timeout-ms", String(timeoutMs)];
}

type SpawnLike = (bin: string, args: string[], opts: object) => ReturnType<typeof spawn>;

/** Start the proxy in the background (detached) and wait until its socket is up. */
export async function startProxy(s: Settings, upstreamUrl: string, timeoutMs = 90_000, deps: { spawn?: SpawnLike } = {}): Promise<void> {
  const deadline = Date.now() + timeoutMs, attempt = randomUUID(), target = browserTarget(s);
  const record = (phase: string, fields: Partial<Pick<ProxyAttempt, "detail" | "child" | "code" | "signal">> = {}) =>
    recordProxyAttempt(s, { attempt, target, upstream: upstreamUrl, phase, ...fields });
  stateDir(s);
  record("parent-start");
  if (await socketAlive(s.socketPath)) { record("parent-reuse"); return; }
  let entered = false;
  try { await withFileLock(`${s.socketPath}.start.lock`, deadline, async () => {
    entered = true;
    if (await socketAlive(s.socketPath)) { record("parent-reuse"); return; }
    s.log(promptNotice(s, target, deadline - Date.now()));
    const fd = openSync(proxyLogPath(s), "a");
    let child: ReturnType<typeof spawn>;
    try {
      child = (deps.spawn ?? (spawn as SpawnLike))(process.execPath, proxyArgs(s, upstreamUrl, attempt, Math.max(1, deadline - Date.now())), {
        detached: true, stdio: ["ignore", fd, fd],
      });
    } catch (e) { record("parent-spawn-error", { detail: (e as Error).message }); throw e; }
    finally { closeSync(fd); }
    let spawnError: Error | undefined;
    child.once("error", (error) => { spawnError = error; record("parent-spawn-error", { child: child.pid, detail: error.message }); });
    child.once("exit", (code, signal) => record("parent-exit", { child: child.pid, code, signal }));
    record("parent-spawned", { child: child.pid });
    child.unref();
    while (Date.now() < deadline) {
      // Another launcher can win while this child connects upstream. A live peer is usable too.
      if (await socketAlive(s.socketPath)) { record("parent-ready", { child: child.pid }); return; }
      if (spawnError || child.exitCode !== null || child.signalCode !== null) break;
      await new Promise((r) => setTimeout(r, Math.min(200, Math.max(1, deadline - Date.now()))));
    }
    let detail: string;
    if (spawnError) detail = `proxy spawn failed: ${spawnError.message}`;
    else if (child.exitCode !== null || child.signalCode !== null) {
      // The child wrote why into the log: carry it into this error, so the caller sees the cause.
      const why = lastProxyAttempt(s);
      detail = `proxy exited with ${child.signalCode ?? child.exitCode} before its socket was ready${why?.attempt === attempt && why.detail ? `: ${why.detail}` : ""}`;
    }
    else {
      detail = `proxy startup timed out while connecting; ${UNANSWERED}`;
      record("parent-timeout", { child: child.pid, detail });
      // Stop this attempt's child only. A peer's socket and process remain untouched.
      await new Promise<void>((resolve) => {
        let kill: NodeJS.Timeout | undefined;
        const done = () => { clearTimeout(kill); child.removeListener("exit", done); resolve(); };
        child.once("exit", done);
        child.kill("SIGTERM");
        if (child.exitCode !== null || child.signalCode !== null) done();
        else kill = setTimeout(() => { child.kill("SIGKILL"); done(); }, 1000);
      });
    }
    throw new Error(`chrome proxy did not start (${target}; ${detail}); see ${proxyLogPath(s)}`);
  }, "chrome proxy startup lock"); } catch (e) {
    if (entered) throw e;
    record("parent-lock-error", { detail: (e as Error).message });
    throw new Error(`chrome proxy did not start (${target}; startup lock failed: ${(e as Error).message}); see ${proxyLogPath(s)}`);
  }
}

/**
 * Is `pid` this consumer's proxy? Its command line is an agent-browser proxy (from any copy of the
 * package: a checkout or a node_modules install) with this consumer's socket. A stale pid file can
 * name a pid that the system has given to another process since.
 */
export function isOwnProxy(s: Settings, pid: number, command = (p: number) => execFileSync("ps", ["-ww", "-o", "command=", "-p", String(p)], { encoding: "utf8" })): boolean {
  try {
    const line = ` ${command(pid).trim()} `;
    return /\/bin\/agent-browser\.js proxy /.test(line) && line.includes(` --socket ${s.socketPath} `);
  } catch { return false; }
}

/** Ask this consumer's proxy to exit. Only the pid in its own state folder is signalled, and only when it is that proxy. */
export function stopProxy(s: Settings): boolean {
  const info = proxyInfo(s);
  if (!info || !isOwnProxy(s, info.pid)) return false;
  try { process.kill(info.pid, "SIGTERM"); return true; } catch { return false; }
}
