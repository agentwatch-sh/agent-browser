// The parity probe's server (test/live/parity/server.ts) against what a browser that a person opens
// does in a --serve run: a certificate warning ends the first TLS handshake with an alert, and the
// browser keeps its connections open until the probe stops. No Chrome: Node's own clients. The TLS
// tests need openssl (as the probe does) and are skipped without it.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect as http2Connect, type ClientHttp2Session } from "node:http2";
import { connect as netConnect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { parseClientHello } from "./live/parity/fingerprint.ts";
import { ProbeServer } from "./live/parity/server.ts";

const OPENSSL = (() => { try { execFileSync("openssl", ["version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const needsOpenssl = { skip: OPENSSL ? false : "no openssl on PATH" };

let tmp = "";
let tls = { key: "", cert: "" };
before(() => {
  tmp = mkdtempSync(join(tmpdir(), "ab-parity-"));
  if (!OPENSSL) return;
  // The probe's own certificate for probe.localhost (probe.ts).
  writeFileSync(join(tmp, "req.cnf"), "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=probe.localhost\n[ext]\nsubjectAltName=DNS:probe.localhost\n");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-config", join(tmp, "req.cnf"),
    "-keyout", join(tmp, "key.pem"), "-out", join(tmp, "cert.pem")], { stdio: "ignore" });
  tls = { key: readFileSync(join(tmp, "key.pem"), "utf8"), cert: readFileSync(join(tmp, "cert.pem"), "utf8") };
});
after(() => rmSync(tmp, { recursive: true, force: true }));

/** A probe server on three free ports in a row (it takes P, P+1 and P+2). */
async function start(): Promise<ProbeServer> {
  for (let i = 0; ; i++) {
    const s = new ProbeServer(20_000 + Math.floor(Math.random() * 40_000), tls);
    try { await s.start(); return s; } catch (e) { await s.stop(); if (i === 20) throw e; }
  }
}

/** Whether `s` closes within ms; listen before the step that should close it. */
function closes(s: Socket | ClientHttp2Session, ms = 3_000): Promise<boolean> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    s.once("close", () => { clearTimeout(t); resolve(true); });
  });
}

/** A TLS 1.2 ClientHello from Node's TLS client: in TLS 1.2 the client's alert goes in the clear. */
async function helloTls12(): Promise<Buffer> {
  const l = createServer();
  await new Promise<void>((r) => l.listen(0, "127.0.0.1", r));
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      l.once("connection", (sock) => {
        let buf = Buffer.alloc(0);
        sock.on("data", (b) => { buf = Buffer.concat([buf, b]); if (parseClientHello(buf)) { sock.destroy(); resolve(buf); } });
        sock.on("error", reject);
      });
      const c = tlsConnect({ host: "127.0.0.1", port: (l.address() as { port: number }).port, servername: "probe.localhost", ALPNProtocols: ["h2", "http/1.1"], maxVersion: "TLSv1.2" });
      c.on("error", () => {});
      setTimeout(() => { c.destroy(); reject(new Error("no ClientHello")); }, 5_000).unref();
    });
  } finally {
    l.close();
  }
}

/** An HTTP/2 session over TLS to the probe server, as a browser holds it, and the status of one GET. */
async function h2Get(server: ProbeServer, path: string): Promise<{ session: ClientHttp2Session; status: number }> {
  const session = http2Connect(`https://127.0.0.1:${server.port + 1}`, { servername: "probe.localhost", ca: tls.cert });
  session.on("error", () => {});
  const req = session.request({ ":path": path });
  const [headers] = await once(req, "response");
  req.resume();
  await once(req, "end");
  return { session, status: headers[":status"] };
}

test("a TLS client that ends the handshake with alert 46 (a person's certificate warning) does not stop the server", needsOpenssl, async () => {
  const server = await start();
  let session: ClientHttp2Session | undefined;
  try {
    const sock = netConnect(server.port + 1, "127.0.0.1");
    sock.on("error", () => {});
    await once(sock, "connect");
    const closed = closes(sock, 5_000);
    sock.write(await helloTls12());
    await once(sock, "data");   // the server's flight, up to ServerHelloDone
    // Chrome's answer at its certificate warning: a fatal alert, certificate_unknown (46).
    sock.write(Buffer.from([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 46]));
    assert.ok(await closed, "the server ends that connection");
    assert.ok(server.records.some((r) => r.kind === "tls-hello"), "the ClientHello is recorded");
    // The server is still up: a browser that clicks Proceed gets the page over TLS and HTTP/2.
    const r = await h2Get(server, "/blank");
    session = r.session;
    assert.equal(r.status, 200);
    assert.ok(server.records.some((x) => x.kind === "h2-fingerprint" && x.data && (x.data as { path?: string }).path === "/blank"));
  } finally {
    session?.destroy();
    await server.stop();
  }
});

test("stop() ends the connections that a browser keeps open, on each of the three ports", async () => {
  const server = await start();
  const clients: Socket[] = [];
  try {
    const connect = async (port: number) => { const s = netConnect(port, "127.0.0.1"); s.on("error", () => {}); clients.push(s); await once(s, "connect"); return s; };
    // HTTP/1.1 keep-alive after one answer; an open connection on the TLS port; one on the proxy.
    const http = await connect(server.port);
    http.write("GET /blank HTTP/1.1\r\nHost: probe.localhost\r\nConnection: keep-alive\r\n\r\n");
    await once(http, "data");
    await connect(server.port + 1);
    await connect(server.port + 2);
    const closed = clients.map((c) => closes(c));
    const stopped = Promise.race([server.stop().then(() => true), new Promise((r) => setTimeout(() => r(false), 3_000).unref())]);
    assert.deepEqual(await Promise.all(closed), [true, true, true], "each client connection is closed");
    assert.equal(await stopped, true, "stop() returns");
  } finally {
    for (const c of clients) c.destroy();
  }
});

test("stop() ends an HTTP/2 session over TLS that a browser keeps open", needsOpenssl, async () => {
  const server = await start();
  let session: ClientHttp2Session | undefined;
  try {
    const r = await h2Get(server, "/blank");
    session = r.session;
    assert.equal(r.status, 200);
    const closed = closes(session);
    await server.stop();
    assert.equal(await closed, true, "the session is closed");
  } finally {
    session?.destroy();
  }
});
