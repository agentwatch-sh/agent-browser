// The allowlist: matching (ported from vedlo's chrome.test.ts) and the consumer's file. There is no
// built-in denylist: the operator's list alone decides which hosts pass (O12).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAllowedUrl, loadAllowlist, validateAllowlist } from "../src/allowlist.ts";
import { NotAllowedError } from "../src/errors.ts";

test("allowlist matching: a host matches itself and its subdomains; only http(s) and about:blank", () => {
  const allow = ["suno.com"];
  assert.ok(isAllowedUrl("https://suno.com/create", allow));
  assert.ok(isAllowedUrl("https://studio-api.suno.com/x", allow));
  assert.ok(isAllowedUrl("http://suno.com/", allow));
  assert.ok(!isAllowedUrl("https://notsuno.com/", allow));
  assert.ok(!isAllowedUrl("https://suno.com.evil.io/", allow));
  assert.ok(!isAllowedUrl("file:///etc/passwd", allow));
  assert.ok(!isAllowedUrl("javascript:alert(1)", allow));
  assert.ok(!isAllowedUrl("chrome://settings", allow));
  assert.ok(!isAllowedUrl("not a url", allow));
  assert.ok(isAllowedUrl("about:blank", allow));
  assert.ok(isAllowedUrl("HTTPS://SUNO.COM/", allow), "hosts compare in lowercase");
});

test("no built-in denylist: a mail, account or admin host validates and matches when the operator lists it", () => {
  const entries = ["gmail.com", "accounts.google.com", "mail.example.com", "admin.example.com", "bank.example.com", "dash.cloudflare.com"];
  assert.deepEqual(validateAllowlist(entries), entries);
  for (const url of ["https://gmail.com/", "https://accounts.google.com/signin", "https://mail.example.com/inbox", "https://eu.mail.example.com/",
    "https://admin.example.com/", "https://bank.example.com/accounts/1", "https://dash.cloudflare.com/"])
    assert.ok(isAllowedUrl(url, entries), url);
  for (const url of ["https://mail.google.com/", "https://myaccount.google.com/", "https://example.com/", "https://webmail.example.com/",
    "https://gmail.com.evil.io/", "https://notgmail.com/", "file:///home/x/mail", "javascript:alert(1)"])
    assert.ok(!isAllowedUrl(url, entries), `still only what the list names: ${url}`);
});

test("a broad entry covers every subdomain, mail, account and admin hosts included", () => {
  const allow = ["google.com", "example.com", "yahoo.com"];
  for (const url of ["https://mail.google.com/mail/u/0", "https://accounts.google.com/", "https://admin.google.com/", "https://docs.google.com/",
    "https://mail.example.com/", "https://webmail.example.com/", "https://admin.example.com/", "https://bank.example.com/", "https://mail.yahoo.com/"])
    assert.ok(isAllowedUrl(url, allow), url);
  assert.ok(!isAllowedUrl("https://gmail.com/", allow), "gmail.com is not a subdomain of google.com");
});

test("the library exports no denylist", async () => {
  const lib: Record<string, unknown> = await import("../src/index.ts");
  for (const name of ["isDeniedHost", "DENIED_HOSTS", "DENIED_FIRST_LABELS"]) assert.ok(!(name in lib), name);
});

test("an allowlist file is validated: host names only, never a top-level domain, a scheme, a port, a path or a wildcard", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-allow-"));
  try {
    const file = join(dir, "sites.json");
    writeFileSync(file, JSON.stringify({ _comment: "hosts", allow: ["suno.com", "midjourney.com", "localhost", "127.0.0.1", "gmail.com", "mail.suno.com"] }));
    assert.deepEqual(loadAllowlist(file), ["suno.com", "midjourney.com", "localhost", "127.0.0.1", "gmail.com", "mail.suno.com"]);
    for (const bad of [["com"], ["*.suno.com"], ["https://suno.com"], ["suno.com/x"], ["suno.com:443"], ["Suno.com"], [""], [1],
      ["gmail"], ["*.gmail.com"], ["https://accounts.google.com"], ["mail.example.com:443"], ["mail.example.com/inbox"], ["GMAIL.COM"], ["suno.com", "*"]])
      assert.throws(() => validateAllowlist(bad), /allowlist/, JSON.stringify(bad));
    assert.throws(() => validateAllowlist("suno.com"), /must be an array/);
    writeFileSync(file, "{ not json");
    assert.throws(() => loadAllowlist(file), /cannot read the allowlist/);
    assert.throws(() => loadAllowlist(join(dir, "missing.json")), /cannot read the allowlist/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a refusal names only the host, never the full URL", () => {
  const e = new NotAllowedError("https://bank.example.com/accounts/123?session=secret");
  assert.equal(e.message, "refusing: bank.example.com is not on the allowlist");
  assert.equal(e.code, "not_allowed");
});
