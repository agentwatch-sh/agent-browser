#!/usr/bin/env python3
"""The probe's test sites: one HTTP server on 127.0.0.1, routed by the Host header.

Every *.localhost host resolves to the loopback in Chromium, so the probe never reaches a real site.
The server logs each request (time in ms, host, path, Sec-Fetch-Site) in memory; GET /__log on any
host gives the log and empties it. A page reports what its own script sees with a beacon to
/beacon (history.length, window.opener, document.referrer, whether a service worker controls it).

Pages:
  /page?id=X          a page with a beacon and two links (target=_blank, and rel=opener)
  /frame?id=X&to=URL  a page with an iframe of URL
  /swreg?id=X         registers /sw.js for the whole host and reports when it controls a client
  /sw.js              a service worker that answers every navigation itself, with a page that
                      sends a beacon (kind=swpage) and holds an iframe of c.localhost
  /beacon             204

Usage: site.py PORT
"""
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

LOG = []
LOCK = threading.Lock()

REPORT = """<script>
(() => {
  const q = new URLSearchParams(location.search);
  const p = new URLSearchParams({kind: '%(kind)s', id: q.get('id') || '', h: String(history.length),
    op: String(!!window.opener), ref: String(document.referrer !== ''),
    ctl: String(!!(navigator.serviceWorker && navigator.serviceWorker.controller))});
  fetch('/beacon?' + p, {keepalive: true});
})();
</script>"""

PAGE = """<!doctype html><meta charset="utf-8"><title>%(host)s</title>
<p>%(host)s</p>
<a id="blank" href="%(to)s" target="_blank">blank</a>
<a id="opener" href="%(to)s" target="_blank" rel="opener">opener</a>
<form id="post" method="post" target="_blank" action="%(to)s"><input name="x" value="1"></form>
""" + REPORT

FRAME = """<!doctype html><meta charset="utf-8"><title>frame %(host)s</title>
<iframe id="f" src="%(to)s"></iframe>
""" + REPORT

SWREG = """<!doctype html><meta charset="utf-8"><title>swreg</title>
<script>
(async () => {
  const q = new URLSearchParams(location.search);
  let r = 'ok';
  try {
    await navigator.serviceWorker.register('/sw.js', {scope: '/'});
    await navigator.serviceWorker.ready;
  } catch (e) { r = 'error:' + String(e && e.name); }
  fetch('/beacon?' + new URLSearchParams({kind: 'swreg', id: q.get('id') || '', r}), {keepalive: true});
})();
</script>"""

WORKERS = """<!doctype html><meta charset="utf-8"><title>workers</title>
<script>
(async () => {
  const q = new URLSearchParams(location.search);
  const ask = (w, port) => new Promise((resolve) => {
    const t = setTimeout(() => resolve('timeout'), 1500);
    port.onmessage = (e) => { clearTimeout(t); resolve(String(e.data)); };
    if (w) w.onerror = () => { clearTimeout(t); resolve('error'); };
    port.postMessage('hi');
  });
  let dedicated = 'error', shared = 'error';
  try { const w = new Worker('/w.js'); dedicated = await ask(w, w); } catch (e) { dedicated = 'throw'; }
  try { const s = new SharedWorker('/shw.js'); s.port.start(); shared = await ask(s, s.port); } catch (e) { shared = 'throw'; }
  fetch('/beacon?' + new URLSearchParams({kind: 'workers', id: q.get('id') || '', dedicated, shared}), {keepalive: true});
})();
</script>"""

SW = """
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return;
  const u = new URL(e.request.url);
  const id = u.searchParams.get('id') || '';
  const port = u.port ? ':' + u.port : '';
  const html = '<!doctype html><meta charset="utf-8"><title>swpage</title><p>served by the worker</p>' +
    '<iframe src="http://c.localhost' + port + '/page?id=swframe-' + id + '"></iframe>' +
    '<script>fetch("/beacon?kind=swpage&id=' + id + '&h=" + history.length, {keepalive: true});</script>';
  e.respondWith(new Response(html, {headers: {'content-type': 'text/html; charset=utf-8'}}));
});
"""


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def send(self, code, body=b"", ctype="text/html; charset=utf-8", store=False):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        if not store:  # no-store keeps a page out of the back/forward cache; ?cache=1 lets it in
            self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        host = (self.headers.get("Host") or "").split(":")[0]
        if u.path == "/__log":
            with LOCK:
                out = list(LOG)
                LOG.clear()
            return self.send(200, json.dumps(out).encode(), "application/json")
        with LOCK:
            LOG.append({"t": round(time.time() * 1000, 1), "host": host, "path": u.path, "q": q, "m": self.command,
                        "sfs": self.headers.get("Sec-Fetch-Site"), "sfd": self.headers.get("Sec-Fetch-Dest")})
        to = q.get("to", "about:blank").replace('"', "")
        if u.path == "/page":
            return self.send(200, (PAGE % {"host": host, "to": to, "kind": "page"}).encode(), store="cache" in q)
        if u.path == "/frame":
            return self.send(200, (FRAME % {"host": host, "to": to, "kind": "frame"}).encode())
        if u.path == "/swreg":
            return self.send(200, SWREG.encode())
        if u.path == "/workers":
            return self.send(200, WORKERS.encode())
        if u.path == "/w.js":
            return self.send(200, b"onmessage = () => postMessage('ok');", "text/javascript")
        if u.path == "/shw.js":
            return self.send(200, b"onconnect = (e) => { const p = e.ports[0]; p.onmessage = () => p.postMessage('ok'); };", "text/javascript")
        if u.path == "/sw.js":
            return self.send(200, SW.encode(), "text/javascript")
        if u.path == "/beacon":
            return self.send(204)
        return self.send(404, b"not found", "text/plain")


def _post(self):
    n = int(self.headers.get("Content-Length") or 0)
    self.rfile.read(n)
    self.do_GET()


Handler.do_POST = _post


def main():
    port = int(sys.argv[1])
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"site: ready on 127.0.0.1:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
