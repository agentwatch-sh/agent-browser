// The Mac live check of the stored sign-ins (board ab-v16.97.17; the design note
// docs/superpowers/specs/2026-11-26-stored-sign-ins-mac-design.md, section 8, "The Mac live check", steps 1 to 4;
// test/live/README.md, "The Mac live check of the stored sign-ins").
//
//   node test/live/sign-in-act-mac/harness.ts serve --service-log <file> --sign-in-log <file> [--port <n>] [--minutes 30]
//   node test/live/sign-in-act-mac/harness.ts check --folder <folder> --window <a> --front-changed <a> [--keep]

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, mkdtempSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { constants, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANSWER_FILE, EXIT_FILE, HARNESS, HEAD_MAX, POST_MAX_BYTES, RUN_FILE, SCAN_MAX_BYTES, SITE_FILE, STOP_HEADER, STOP_PATH, VERSION,
  applyEvent, checkResult, eventLine, newSiteState, isAscii, originOf, parseArgs, resultOf, scanFrom, setupText, siteAnswer, testValues,
  type LogMark, type ScanText, type SiteState, type TestValues,
} from "./parts.ts";

const args = parseArgs(process.argv.slice(2));
if ("error" in args) {
  process.stderr.write(`${HARNESS}: ${args.error}\n`);
  process.exit(2);
}

const writeJson = (file: string, value: unknown) => {
  writeFileSync(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
};

const headOf = (file: string, len: number): string | null => {
  try {
    const buf = Buffer.alloc(len);
    const fd = openSync(file, "r");
    try { if (readSync(fd, buf, 0, len, 0) < len) return null; } finally { closeSync(fd); }
    return createHash("sha256").update(buf).digest("hex");
  } catch { return null; }
};

if (args.cmd === "serve") {
  const folder = mkdtempSync(join(tmpdir(), "ab-signin-mac-"));
  chmodSync(folder, 0o700);
  const values = testValues((n) => randomBytes(n));
  const token = randomBytes(16).toString("hex");
  const sessions = new Set<string>();
  let site: SiteState = newSiteState();
  let ended = false;
  let limit: NodeJS.Timeout | null = null;
  const server = createServer((req, res) => {
    let body = "", size = 0;
    req.on("data", (d: Buffer) => {
      size += d.length;
      if (size > POST_MAX_BYTES) { res.writeHead(413).end(); req.destroy(); return; }
      body += d.toString("utf8");
    });
    req.on("end", () => {
      if (size > POST_MAX_BYTES) return;
      const a = siteAnswer({ method: req.method ?? "", path: req.url ?? "", host: req.headers.host, cookie: req.headers.cookie, body, token: req.headers[STOP_HEADER] as string | undefined },
        { port, token, values }, sessions, () => randomBytes(16).toString("hex"));
      const stop = a.event?.kind === "stop";
      if (a.event && !stop) {
        site = applyEvent(site, a.event, Date.now());
        writeJson(join(folder, SITE_FILE), site);
      }
      const line = a.event ? eventLine(a.event) : null;
      if (line) process.stdout.write(`${line}\n`);
      res.writeHead(a.status, a.headers).end(a.body, () => { if (stop) end(0, "the check's stop"); });
    });
  });
  const end = (code: number, why: string) => {
    if (ended) return;
    ended = true;
    if (limit) clearTimeout(limit);
    process.stdout.write(`${HARNESS}: the end (${why}); the run's folder goes\n`);
    server.closeAllConnections();
    server.close();
    rmSync(folder, { recursive: true, force: true });
    process.exit(code);
  };
  for (const s of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(s, () => end(128 + constants.signals[s], s));
  process.on("uncaughtException", (e) => { process.stderr.write(`${HARNESS}: ${(e as Error).message}\n`); end(1, "an error"); });
  let port = args.port;
  const stat = (f: string) => { try { const st = statSync(f, { bigint: true }); return { ino: String(st.ino), size: Number(st.size) }; } catch { return { ino: null, size: 0 }; } };
  const serviceFile = resolve(args.serviceLog);
  const startStat = stat(serviceFile);
  const headLen = Math.min(startStat.size, HEAD_MAX);
  const serviceLog = { path: serviceFile, ...startStat, headLen, head: headLen > 0 ? headOf(serviceFile, headLen) : null };
  const signInLog = { path: resolve(args.signInLog) };
  server.once("error", (e) => { process.stderr.write(`${HARNESS}: the server cannot listen on 127.0.0.1:${args.port} (${(e as NodeJS.ErrnoException).code ?? e.message})\n`); end(1, "no server"); });
  server.listen(args.port, "127.0.0.1", () => {
    port = (server.address() as { port: number }).port;
    writeJson(join(folder, RUN_FILE), { v: VERSION, pid: process.pid, port, token, user: values.user, pass: values.pass, serviceLog, signInLog });
    writeJson(join(folder, SITE_FILE), site);
    const until = new Date(Date.now() + args.minutes * 60_000).toISOString().slice(0, 19) + "Z";
    limit = setTimeout(() => end(1, `the time limit of ${args.minutes} minutes`), args.minutes * 60_000);
    const harness = relative(process.cwd(), fileURLToPath(import.meta.url)) || fileURLToPath(import.meta.url);
    process.stdout.write(`${JSON.stringify({ harness: HARNESS, version: VERSION, folder, port, origin: originOf(port), pid: process.pid, until })}\n${setupText({ port, folder, values, until, harness })}`);
  });
} else {
  const { folder } = args;
  let run: { port: number; token: string; user: string; pass: string; serviceLog: LogMark & { path: string }; signInLog: { path: string } };
  let site: SiteState;
  try {
    run = JSON.parse(readFileSync(join(folder, RUN_FILE), "utf8"));
    site = JSON.parse(readFileSync(join(folder, SITE_FILE), "utf8"));
    if (!Number.isInteger(run.port) || typeof run.user !== "string" || typeof run.pass !== "string" || typeof run.serviceLog?.path !== "string" || !Number.isInteger(run.serviceLog.size) || !Number.isInteger(run.serviceLog.headLen) || !isAscii(run.user + run.pass)
      || typeof run.signInLog?.path !== "string" || !Array.isArray(site.posts)) throw new Error("its form");
  } catch {
    // JSON.parse's message can quote run.json, and run.json holds the test values.
    process.stderr.write(`${HARNESS}: the folder holds no run of the harness\n`);
    process.exit(2);
  }
  const values: TestValues = { user: run.user, pass: run.pass };
  const read = (file: string, after?: LogMark): { text: string | null; why?: string } => {
    try {
      const st = statSync(file, { bigint: true });
      const size = Number(st.size);
      const from = after ? scanFrom(after, { ino: String(st.ino), size, headOf: (len) => headOf(file, len) }) : 0;
      if (size - from > SCAN_MAX_BYTES) return { text: null, why: `more than ${SCAN_MAX_BYTES >> 20} MiB to read` };
      const buf = Buffer.alloc(size - from);
      const fd = openSync(file, "r");
      let got = 0;
      try {
        for (let n = 1; got < buf.length && n > 0; got += n) n = readSync(fd, buf, got, buf.length - got, from + got);
      } finally { closeSync(fd); }
      return { text: buf.subarray(0, got).toString("latin1") };
    } catch (e) { return { text: null, why: (e as NodeJS.ErrnoException).code ?? "not read" }; }
  };
  const answer = read(join(folder, ANSWER_FILE)).text;
  const exitText = read(join(folder, EXIT_FILE)).text?.trim() ?? "";
  const exit = /^[0-9]{1,3}$/.test(exitText) ? Number(exitText) : null;
  const scans: ScanText[] = [{ kind: "the service log", ...read(run.serviceLog.path, run.serviceLog) }, { kind: "the sign-in log", ...read(run.signInLog.path) }];
  const result = resultOf({ os: process.platform, port: run.port, values, site, answer, exit, scans, window: args.window, frontChanged: args.frontChanged });
  const bad = checkResult(result, values);
  process.stdout.write(bad ? `${JSON.stringify({ harness: HARNESS, version: VERSION, ok: false, failed: bad })}\n` : `${JSON.stringify(result, null, 2)}\n`);
  if (!args.keep) {
    await new Promise<void>((resolve) => {
      const r = request({ host: "127.0.0.1", port: run.port, method: "POST", path: STOP_PATH, headers: { [STOP_HEADER]: run.token }, timeout: 5000 }, (res) => { res.resume(); res.on("end", resolve); });
      r.on("error", () => { process.stderr.write(`${HARNESS}: the server did not answer the stop\n`); resolve(); });
      r.on("timeout", () => r.destroy());
      r.end();
    });
  }
  process.exit(!bad && result.ok ? 0 : 1);
}
