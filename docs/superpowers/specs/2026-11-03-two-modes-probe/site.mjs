// Probe only: the local test sites a.localhost (on the allowlist), b.localhost
// (off the list) and c.localhost (a cross-site frame), all on 127.0.0.1.
// Chromium resolves *.localhost to the loopback. Every request goes to the
// request log with the headers that tell how it was made; each page reports
// what a site's own script can see to /report.
import http from "node:http";
import fs from "node:fs";

const PORT = Number(process.env.SITE_PORT || 8781);
const OUT = process.env.SITE_LOG || "site-log.jsonl";
const log = (o) => fs.appendFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), ...o }) + "\n");

const DETECT = `(() => {
  const ev = { resize: 0, trusted: [], untrusted: [], pressure: [], keydowns: 0, inputs: 0 };
  addEventListener("pointerdown", (e) => ev.pressure.push(e.pointerType + ":" + e.pressure), true);
  addEventListener("keydown", () => ev.keydowns++, true);
  addEventListener("input", () => ev.inputs++, true);
  addEventListener("resize", () => ev.resize++);
  for (const t of ["click", "keydown", "mousemove", "input"])
    addEventListener(t, (e) => (e.isTrusted ? ev.trusted : ev.untrusted).push(t), true);
  let tell = 0;
  const err = new Error("probe");
  Object.defineProperty(err, "stack", { get() { tell++; return "x"; } });
  setInterval(() => console.debug(err), 250);
  window.__siteSignals = () => {
    return {
      webdriver: navigator.webdriver, ua: navigator.userAgent,
      brands: (navigator.userAgentData ? navigator.userAgentData.brands : []).map((x) => x.brand + "/" + x.version),
      innerHeight, outerHeight, innerWidth, outerWidth,
      hasFocus: document.hasFocus(), visibility: document.visibilityState,
      plugins: navigator.plugins.length, languages: navigator.languages,
      runtimeTell: tell, resize: ev.resize, pressure: [...new Set(ev.pressure)], keydowns: ev.keydowns, inputs: ev.inputs,
      trusted: [...new Set(ev.trusted)], untrusted: [...new Set(ev.untrusted)],
      globals: Object.getOwnPropertyNames(window).filter((k) => !k.startsWith("__site")),
      init: typeof window.__probeInit, url: location.href,
    };
  };
  window.__siteReport = (kind) => navigator.sendBeacon("/report", JSON.stringify({ kind, ...window.__siteSignals() }));
  addEventListener("load", () => setTimeout(() => window.__siteReport("load"), 300));
})();`;

const page = (title, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>${title}</title><script src="/det.js"></script></head><body>${body}</body></html>`;

const MAIN = page(
  "probe a",
  `<h1 id="h">Probe page A</h1>
<label>Name <input id="name" aria-label="Name"></label>
<button id="go" onclick="document.getElementById('out').textContent='Hello, '+document.getElementById('name').value">Greet</button>
<div id="out" role="status"></div>
<p><a id="off" href="http://b.localhost:${PORT}/">Off-list link</a>
<a id="blank" href="/popup?via=blank" target="_blank">Blank link</a></p>
<button id="winopen" onclick="window.open('/popup?via=open')">Open popup</button>
<button id="winopenoff" onclick="window.open('http://b.localhost:${PORT}/')">Open off-list popup</button>
<button id="alert" onclick="document.getElementById('alertout').textContent=String(confirm('Sure?'))">Confirm</button><span id="alertout"></span>
<button id="fetch" onclick="fetch('/api/data').then(r=>r.text()).then(t=>document.getElementById('fetchout').textContent=t)">Fetch</button><span id="fetchout"></span>
<input id="file" type="file" onchange="const f=this.files[0];document.getElementById('fileout').textContent=f?f.name+':'+f.size:''"><span id="fileout"></span>
<a id="dl" href="/file.txt">Download</a>
<select id="sel"><option value="x">X</option><option value="y">Y</option></select>
<span id="hov" onmouseover="this.textContent='hovered'">hover me</span>
<button id="report" onclick="window.__siteReport('click')">Report</button>
<iframe id="frame" src="http://c.localhost:${PORT}/frame" width="300" height="80"></iframe>`,
);

const server = http.createServer((req, res) => {
  const host = (req.headers.host || "").split(":")[0];
  const url = new URL(req.url, `http://${host}`);
  const h = req.headers;
  log({
    t: "req", host, method: req.method, path: url.pathname + url.search,
    fetch: { site: h["sec-fetch-site"], mode: h["sec-fetch-mode"], dest: h["sec-fetch-dest"], user: h["sec-fetch-user"] },
    ua: h["user-agent"], chua: h["sec-ch-ua"], cookies: (h.cookie || "").split(";").map((c) => c.split("=")[0].trim()).filter(Boolean),
  });
  const send = (code, type, body, extra = {}) => {
    res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", ...extra });
    res.end(body);
  };
  if (url.pathname === "/report" && req.method === "POST") {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      try {
        log({ t: "report", host, ...JSON.parse(body) });
      } catch {
        log({ t: "report-bad", host });
      }
      send(204, "text/plain", "");
    });
    return;
  }
  if (url.pathname === "/det.js") return send(200, "text/javascript", DETECT);
  if (host === "a.localhost") {
    if (url.pathname === "/") return send(200, "text/html; charset=utf-8", MAIN);
    if (url.pathname === "/popup") return send(200, "text/html; charset=utf-8", page("probe popup", `<h1 id="p">Popup ${url.searchParams.get("via")}</h1>`));
    if (url.pathname === "/m") return send(200, "text/html; charset=utf-8", page("probe m", "<p id='m'>m</p>"));
    if (url.pathname === "/geo") return send(200, "text/html; charset=utf-8", page("probe geo", "<p id='g'>geo</p>"));
    if (url.pathname === "/worker") return send(200, "text/html; charset=utf-8", page("probe worker", "<script>window.__siteWorker = new Worker('/w.js')</script><p>worker</p>"));
    if (url.pathname === "/w.js") return send(200, "text/javascript", "self.onmessage = () => {};");
    if (url.pathname === "/api/data") return send(200, "text/plain", "real");
    if (url.pathname === "/file.txt")
      return send(200, "text/plain", "probe download body\n", { "Content-Disposition": 'attachment; filename="probe.txt"' });
  }
  if (host === "b.localhost") return send(200, "text/html; charset=utf-8", page("probe b", "<h1>Off-list page B</h1>"));
  if (host === "c.localhost" && url.pathname === "/frame")
    return send(200, "text/html; charset=utf-8", `<!doctype html><title>frame c</title><button id="fbtn" onclick="document.getElementById('fout').textContent='frame clicked'">Frame button</button><span id="fout">frame ready</span>`);
  send(404, "text/plain", "not found");
});

server.listen(PORT, "127.0.0.1", () => log({ t: "listen", port: PORT }));
