// The fake hosts of the sign-in provider probe (board task ab-v16.45). One HTTPS server on 127.0.0.1 serves them
// all; Chromium maps each name to 127.0.0.1 with --host-resolver-rules and trusts the probe's own certificate with
// --ignore-certificate-errors-spki-list. No real account, no real provider.
//
//   site.test          the listed site (an OIDC client and a SAML service provider)
//   tenant.auth0.test  the external provider (an OIDC /authorize, a "choose an account" page, a SAML endpoint)
//   manage.auth0.test  a sibling host of the provider (a broad entry "auth0.test" would cover it)
//   other.test         a host on no list
//
// Every request is logged (host, method, path, the Sec-Fetch-* headers, the Referer's host, the cookie names; no
// cookie value is real). The flows follow the shapes of Auth0's hosted login (query mode, web_message mode for a
// popup and for a silent renew in a frame) and of a SAML POST binding.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { join } from "node:path";

export type Hit = { at: number; host: string; method: string; path: string; query: string; sfs?: string; sfm?: string; sfd?: string; sfu?: string;
  referer?: string; origin?: string; cookies: string[]; cacheControl?: string };

export const HOSTS = ["site.test", "tenant.auth0.test", "manage.auth0.test", "other.test"];

/** A certificate for the four hosts (made once per run folder) and its SPKI hash for Chromium's flag. */
export function makeCert(dir: string): { key: Buffer; cert: Buffer; spki: string } {
  const key = join(dir, "site-key.pem"), cert = join(dir, "site-cert.pem");
  if (!existsSync(cert)) {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "3", "-subj", "/CN=sign-in probe",
      "-addext", `subjectAltName=${HOSTS.map((h) => `DNS:${h}`).join(",")}`], { stdio: "ignore" });
  }
  const pub = execFileSync("openssl", ["x509", "-in", cert, "-pubkey", "-noout"]);
  const der = execFileSync("openssl", ["pkey", "-pubin", "-outform", "der"], { input: pub });
  return { key: readFileSync(key), cert: readFileSync(cert), spki: createHash("sha256").update(der).digest("base64") };
}

const html = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>${title}</title>${body}`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function cookiesOf(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) { const i = part.indexOf("="); if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
  return out;
}

export function startSite(o: { port: number; key: Buffer; cert: Buffer; now: () => number }): { server: Server; hits: Hit[]; ready: Promise<void> } {
  const { port } = o;
  const S = `https://site.test:${port}`, P = `https://tenant.auth0.test:${port}`, M = `https://manage.auth0.test:${port}`, O = `https://other.test:${port}`;
  const hits: Hit[] = [];
  let codes = 0;
  const authorize = (mode: "query" | "web_message", extra = "") =>
    `${P}/authorize?response_type=code&client_id=probe&redirect_uri=${encodeURIComponent(S + "/callback")}&state=st&response_mode=${mode}${extra}`;

  const server = createServer({ key: o.key, cert: o.cert }, (req, res) => {
    const host = (req.headers.host ?? "").split(":")[0];
    const u = new URL(req.url ?? "/", `https://${host}`);
    const c = cookiesOf(req.headers.cookie);
    let ref: string | undefined;
    try { ref = req.headers.referer ? new URL(req.headers.referer).host.split(":")[0] : undefined; } catch { ref = "?"; }
    hits.push({ at: o.now(), host, method: req.method ?? "GET", path: u.pathname, query: u.search, sfs: req.headers["sec-fetch-site"] as string | undefined,
      sfm: req.headers["sec-fetch-mode"] as string | undefined, sfd: req.headers["sec-fetch-dest"] as string | undefined, sfu: req.headers["sec-fetch-user"] as string | undefined,
      referer: ref, origin: req.headers.origin as string | undefined, cookies: Object.keys(c), cacheControl: req.headers["cache-control"] as string | undefined });
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      const form = new URLSearchParams(body);
      const send = (status: number, text: string, headers: Record<string, string | string[]> = {}) => {
        res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...headers });
        res.end(text);
      };
      const go = (to: string, headers: Record<string, string | string[]> = {}, status = 302) => send(status, "", { Location: to, ...headers });

      if (host === "site.test") {
        if (u.pathname === "/") {
          return send(200, html("site", `<h1>site</h1><p id="who">${c.site_session ? "signed in as ada" : "not signed in"}</p><p id="status"></p>
<p><a id="signin-redirect" href="/login">Sign in</a></p>
<p><a id="signin-direct" href="${esc(authorize("query"))}">Sign in (the link goes to the provider)</a></p>
<p><button id="signin-popup">Sign in (a popup, as auth0-spa-js)</button> <button id="signin-popup-url">Sign in (window.open with the URL)</button></p>
<p><button id="silent">Renew in a frame (prompt=none)</button></p>
<p><a id="saml" href="/saml/login">Sign in with SAML</a></p>
<p><a id="open-redirect" href="/redirect?to=${encodeURIComponent(O + "/via-redirect")}">A link through the site's open redirect</a> <a id="offlist" href="${O}/link">A link to other.test</a></p>
<script>
const status = document.getElementById("status");
let popup = null;
window.addEventListener("message", (e) => {
  if (e.origin !== ${JSON.stringify(P)} || !e.data || e.data.type !== "authorization_response") return;
  const r = e.data.response || {};
  status.textContent = (e.source === popup ? "popup " : "frame ") + (r.code ? "code " + r.code : "error " + r.error);
  if (popup && e.source === popup) { popup.close(); popup = null; }
  const f = document.getElementById("renew"); if (f && e.source !== popup) f.remove();
});
document.getElementById("signin-popup").onclick = () => {
  popup = window.open("", "auth0:authorize:popup", "left=100,top=100,width=400,height=600,resizable,scrollbars=yes,status=1");
  popup.location.href = ${JSON.stringify(authorize("web_message", "&prompt=select_account"))};
};
document.getElementById("signin-popup-url").onclick = () => { popup = window.open(${JSON.stringify(authorize("web_message"))}, "signin", "popup,width=400,height=600"); };
document.getElementById("silent").onclick = () => {
  const f = document.createElement("iframe"); f.id = "renew"; f.style.display = "none";
  f.src = ${JSON.stringify(authorize("web_message", "&prompt=none"))}; document.body.appendChild(f);
};
</script>`));
        }
        if (u.pathname === "/login") return go(authorize("query"));
        if (u.pathname === "/callback") {
          const code = u.searchParams.get("code");
          if (!code) return send(200, html("callback error", `<p id="who">callback error: ${esc(u.searchParams.get("error") ?? "?")}</p>`));
          return go("/app", { "Set-Cookie": "site_session=ada; Path=/; Secure; HttpOnly; SameSite=Lax" });
        }
        if (u.pathname === "/app") {
          if (!c.site_session) return go("/login");
          return send(200, html("app", `<p id="who">signed in as ada</p>`));
        }
        if (u.pathname === "/saml/login") {
          return send(200, html("saml", `<form id="f" method="post" action="${P}/samlp/probe"><input type="hidden" name="SAMLRequest" value="req-1"><input type="hidden" name="RelayState" value="/app"></form><script>document.getElementById("f").submit()</script>`));
        }
        if (u.pathname === "/acs" && req.method === "POST") {
          if (form.get("SAMLResponse") !== "resp-1") return send(400, html("acs", "<p id='who'>bad SAML response</p>"));
          return go(form.get("RelayState") || "/app", { "Set-Cookie": "site_session=ada; Path=/; Secure; HttpOnly; SameSite=Lax" }, 303);
        }
        if (u.pathname === "/redirect") return go(u.searchParams.get("to") ?? "/");
        if (u.pathname === "/logout") return go("/", { "Set-Cookie": "site_session=; Path=/; Max-Age=0; Secure" });
        return send(404, html("site 404", "<p>404</p>"));
      }

      if (host === "tenant.auth0.test") {
        const signedIn = c.auth0_session === "s1";
        const samlPost = () => send(200, html("saml response", `<form id="f" method="post" action="${S}/acs"><input type="hidden" name="SAMLResponse" value="resp-1"><input type="hidden" name="RelayState" value="/app"></form><script>document.getElementById("f").submit()</script>`));
        if (u.pathname === "/authorize") {
          const mode = u.searchParams.get("response_mode"), prompt = u.searchParams.get("prompt");
          const ru = u.searchParams.get("redirect_uri") ?? "", state = u.searchParams.get("state") ?? "";
          let ro = "";
          try { ro = new URL(ru).origin; } catch { return send(400, html("bad", "<p>bad redirect_uri</p>")); }
          // The provider's account chooser: a session and prompt=select_account still ask which account.
          const choose = prompt === "select_account" || prompt === "login";
          if (signedIn && !choose || (!signedIn && prompt === "none")) {
            const response = signedIn ? { code: `c${++codes}`, state } : { error: "login_required", state };
            if (mode === "web_message") {
              return send(200, html("authorization response", `<script>(function(){var w=window.opener||window.parent;w.postMessage({type:"authorization_response",response:${JSON.stringify(response)}},${JSON.stringify(ro)});})()</script>`));
            }
            const q = new URLSearchParams(response as Record<string, string>);
            return go(`${ru}?${q}`);
          }
          return go(`/u/login?q=${encodeURIComponent(u.search.slice(1))}`);
        }
        if (u.pathname === "/u/login" && req.method === "GET") {
          return send(200, html("choose an account", `<h1>Choose an account</h1>
<form id="login" method="post" action="/u/login"><input type="hidden" name="q" value="${esc(u.searchParams.get("q") ?? "")}"><input type="hidden" name="saml" value="${esc(u.searchParams.get("saml") ?? "")}">
<input type="hidden" id="email" name="email" value="">
<p><button type="button" id="account-ada" onclick="document.getElementById('email').value='ada@example.test';document.getElementById('pw').hidden=false">ada@example.test</button></p>
<p id="pw" hidden><label>Password <input id="password" name="password" type="password" autocomplete="current-password"></label> <button id="submit" type="submit">Continue</button></p>
</form><p><a id="privacy" href="${O}/privacy">Privacy (other.test)</a> <a id="manage" href="${M}/">The tenant dashboard (manage.auth0.test)</a></p>
<iframe id="captcha" src="${O}/captcha" width="300" height="80"></iframe>`));
        }
        if (u.pathname === "/u/login" && req.method === "POST") {
          if (form.get("email") !== "ada@example.test" || !form.get("password")) return go(`/u/login?q=${encodeURIComponent(form.get("q") ?? "")}&saml=${form.get("saml") ?? ""}`, {}, 303);
          const set = { "Set-Cookie": "auth0_session=s1; Path=/; Secure; HttpOnly; SameSite=None" };
          if (form.get("saml") === "1") { res.setHeader("Set-Cookie", set["Set-Cookie"]); return samlPost(); }
          // Back to /authorize without the account chooser's prompt: the session now answers.
          const q = new URLSearchParams(form.get("q") ?? "");
          q.delete("prompt");
          return go(`/authorize?${q}`, set, 303);
        }
        if (u.pathname === "/samlp/probe" && req.method === "POST") {
          if (form.get("SAMLRequest") !== "req-1") return send(400, html("bad", "<p>bad SAML request</p>"));
          if (signedIn) return samlPost();
          return go(`/u/login?saml=1`, {}, 303);
        }
        if (u.pathname === "/logout") return go(`${S}/`, { "Set-Cookie": "auth0_session=; Path=/; Max-Age=0; Secure; SameSite=None" });
        return send(404, html("provider 404", "<p>404</p>"));
      }

      if (host === "manage.auth0.test") return send(200, html("dashboard", "<h1>the tenant dashboard</h1>"));
      if (host === "other.test") return send(200, html("other", `<h1>other ${esc(u.pathname)}</h1>`));
      return send(421, "no such host");
    });
  });
  const ready = new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  return { server, hits, ready };
}
