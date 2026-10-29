// The allowlist: matching (ported from vedlo's chrome.test.ts), the consumer's file, and the
// mail/account/admin denylist that no entry can widen.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAllowedUrl, isDeniedHost, loadAllowlist, validateAllowlist } from "../src/allowlist.ts";
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

test("mail, account and admin hosts are refused even when a broad entry covers them", () => {
  const allow = ["google.com", "example.com", "yahoo.com"];
  for (const url of ["https://mail.google.com/mail/u/0", "https://accounts.google.com/", "https://admin.google.com/", "https://mail.example.com/",
    "https://webmail.example.com/", "https://admin.example.com/", "https://bank.example.com/", "https://mail.yahoo.com/"])
    assert.ok(!isAllowedUrl(url, allow), url);
  assert.ok(isAllowedUrl("https://docs.google.com/", allow), "other subdomains still match");
  assert.ok(isAllowedUrl("https://www.example.com/mail", allow), "a path is not a host");
  assert.ok(isDeniedHost("GMAIL.COM."));
  assert.ok(!isDeniedHost("mailchimp.com"), "a first label must be exactly mail");
});

test("an allowlist file is validated: host names only, never a top-level domain, a wildcard or a denied host", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-allow-"));
  try {
    const file = join(dir, "sites.json");
    writeFileSync(file, JSON.stringify({ _comment: "hosts", allow: ["suno.com", "midjourney.com", "localhost", "127.0.0.1"] }));
    assert.deepEqual(loadAllowlist(file), ["suno.com", "midjourney.com", "localhost", "127.0.0.1"]);
    for (const bad of [["com"], ["*.suno.com"], ["https://suno.com"], ["suno.com/x"], ["suno.com:443"], ["Suno.com"], [""], [1], ["gmail.com"], ["mail.suno.com"]])
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
