// The entries of a fetch list (board ab-v16.113; src/service/fetch/fetch-list.ts; `agent-browser page-fetch`'s allow
// file): the entry rules (a host by list_set's host rules, a path prefix in the form that the WHATWG URL parser gives),
// the match of a URL (https only, the default port only, no user name, the exact host, a prefix of the parsed path at a
// segment boundary, also with a trailing slash or a query), and the allow file's text. Every host here is a test value.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EntryError } from "../src/service/lists/hosts.ts";
import { AllowFileError, fetchEntryOrNull, fetchListAllows, FETCH_PATH_MAX, hostsOf, normalizeFetchEntry, parseAllowFile } from "../src/service/fetch/fetch-list.ts";

const reason = (s: unknown) => { try { normalizeFetchEntry(s); return null; } catch (e) { assert.ok(e instanceof EntryError, String(e)); return (e as EntryError).reason; } };

test("a fetch entry is a host or a host and a path: the host by list_set's host rules (lowercase, punycode, one trailing dot dropped), the path as it is (case-sensitive); host/ is the whole host", () => {
  for (const [s, out] of [
    ["example.com", "example.com"], ["Example.COM", "example.com"], ["  docs.example/a/b  ", "docs.example/a/b"],
    ["github.com/MarketDataApp", "github.com/MarketDataApp"], ["GitHub.com/MarketDataApp", "github.com/MarketDataApp"],
    ["github.com/", "github.com"], ["github.com/MarketDataApp/", "github.com/MarketDataApp/"], ["XN--Bcher-kva.example/x", "xn--bcher-kva.example/x"],
    ["example.com./x", "example.com/x"], ["github.com//x", "github.com//x"], ["github.com/a.b/c", "github.com/a.b/c"], ["github.com/.well-known/x", "github.com/.well-known/x"],
    ["docs.example/a-b_c~d.e/f!$&'()*+,;=:@", "docs.example/a-b_c~d.e/f!$&'()*+,;=:@"],
  ]) assert.equal(normalizeFetchEntry(s), out, s);
  assert.equal(normalizeFetchEntry(`docs.example/${"a".repeat(FETCH_PATH_MAX - 1)}`).length, "docs.example/".length + FETCH_PATH_MAX - 1, "a path of the longest length");
  assert.equal(fetchEntryOrNull("Example.COM/x"), "example.com/x");
  assert.equal(fetchEntryOrNull("https://example.com"), null);
});

const REFUSED: [unknown, string][] = [
  ["", "the entry is empty"], ["   ", "the entry is empty"], [42, "the entry must be text"], [null, "the entry must be text"],
  ["https://example.com", "give the entry with no scheme"], ["http://example.com/x", "give the entry with no scheme"], ["//example.com/x", "the entry must start with its host"],
  ["/MarketDataApp", "the entry must start with its host"], ["example.com/a b", "whitespace is not allowed"], ["example .com", "whitespace is not allowed"],
  ["example.com:443", "a port is not allowed"], ["example.com:443/x", "a port is not allowed"], ["user@example.com", "a user name is not allowed"],
  ["user:pw@example.com/x", "a port is not allowed"], ["1.2.3.4", "an IP address is not allowed"], ["1.2.3.4/x", "an IP address is not allowed"],
  ["[::1]/x", "an IP address is not allowed"], ["0x7f.1/x", "an IP address is not allowed"], ["*.example.com", "a wildcard is not allowed"],
  ["bücher.example", "use the punycode form"], ["com", "the host needs at least two labels"], ["example..com/x", "a label is empty"],
  ["example.com?x=1", "a character is not allowed"], ["example.com/a?x=1", "a query or a fragment is not allowed"], ["example.com/a#f", "a query or a fragment is not allowed"],
  ["example.com/a\\b", "use / in a path"], ["example.com/a​b", "a control or invisible character is not allowed"], ["example.com/a\u0007b", "a control or invisible character is not allowed"],
  ["example.com/café", "use the percent-encoded form of the path"], [`example.com/${"a".repeat(FETCH_PATH_MAX)}`, "the path is too long"],
  ["example.com/a/../b", "the path has a dot segment or a character that a browser encodes"], ["example.com/a/%2e%2e/b", "the path has a dot segment or a character that a browser encodes"],
  ["example.com/a/%2E%2e", "the path has a dot segment or a character that a browser encodes"], ["example.com/./a", "the path has a dot segment or a character that a browser encodes"],
  ["example.com/a/.", "the path has a dot segment or a character that a browser encodes"], ["example.com/a<b", "the path has a dot segment or a character that a browser encodes"],
  ["example.com/a\"b", "the path has a dot segment or a character that a browser encodes"], ["example.com/a{b}", "the path has a dot segment or a character that a browser encodes"],
  ["example.com/a`b", "the path has a dot segment or a character that a browser encodes"],
  // The review of PR #214 (note 3): a path entry fails closed, so an entry that could never match is refused.
  ["github.com/a%2Fb", "the path has an encoded slash, backslash or dot (%2F, %5C or %2E)"], ["github.com/a%2fb", "the path has an encoded slash, backslash or dot (%2F, %5C or %2E)"],
  ["github.com/a%5Cb", "the path has an encoded slash, backslash or dot (%2F, %5C or %2E)"], ["github.com/a%2E", "the path has an encoded slash, backslash or dot (%2F, %5C or %2E)"],
  ["github.com/..x", "a segment of the path starts with .."], ["github.com/a/..;/b", "a segment of the path starts with .."],
];

test("the entry rules refuse each bad entry with its reason, and no reason holds the entry", () => {
  for (const [s, want] of REFUSED) {
    const r = reason(s);
    assert.equal(r, want, JSON.stringify(s));
    if (typeof s === "string" && s.trim().length > 3) assert.ok(!r!.includes(s.trim()), `the reason echoes ${JSON.stringify(s)}`);
  }
});

const ENTRIES = ["example.com", "github.com/MarketDataApp", "docs.example/guide/", "xn--bcher-kva.example"];

test("a URL matches an entry by the WHATWG URL parser: https, the default port, no user name, the exact host, and the parsed path's prefix at a segment boundary (case-sensitive; the query does not count)", () => {
  for (const url of [
    "https://example.com/", "https://example.com", "https://example.com/any/path?q=1#f", "https://EXAMPLE.com/x", "https://example.com:443/x",
    "https://github.com/MarketDataApp", "https://github.com/MarketDataApp/", "https://github.com/MarketDataApp/sdk-js/issues?q=is%3Aopen",
    // The daemon lead's point a: the path with a trailing slash and with a query string.
    "https://github.com/MarketDataApp?x=1", "https://github.com/MarketDataApp/?x=1", "https://github.com/MarketDataApp#f", "https://github.com/MarketDataApp/?x=1#f",
    "https://github.com/x/../MarketDataApp/y", "https://github.com/x/%2e%2e/MarketDataApp", "https://github.com\\MarketDataApp\\x",
    "https://docs.example/guide/", "https://docs.example/guide/a/b", "https://bücher.example/", "https://BÜCHER.example/x",
    // A host entry does not look at the path.
    "https://example.com/..%2Fx", "https://example.com/a/..;/b", "https://example.com/%2e%2E%5c",
  ]) assert.equal(fetchListAllows(ENTRIES, url), true, url);
  for (const url of [
    "https://www.example.com/", "https://example.com.evil.test/", "https://notexample.com/", "https://example.com./", "http://example.com/",
    "https://example.com:8443/", "https://example.com:80/", "https://user@example.com/", "https://u:p@example.com/", "https://:p@example.com/",
    "wss://example.com/", "ftp://example.com/", "data:text/html,x", "about:blank", "not a url", "",
    "https://github.com/MarketDataAppX", "https://github.com/MarketDataApp-x", "https://github.com/MarketDataApp-x/?x=1", "https://github.com/MarketDataApp.x",
    "https://github.com/MarketDataAppX?x=/MarketDataApp/", "https://github.com/marketdataapp", "https://github.com/", "https://gist.github.com/MarketDataApp",
    "https://github.com/MarketDataApp/../other", "https://github.com/MarketDataApp/%2e%2e/other", "https://github.com/MarketDataApp/%2E%2E/other",
    "https://github.com/MarketDataApp\\..\\other", "https://github.com/MarketDataApp%2Fx", "https://github.com/MarketDataApp%2fx",
    "https://docs.example/guide", "https://docs.example/guidebook",
    // The review of PR #214 (note 3): a path entry matches no URL with an encoded slash, backslash or dot, or with a segment that starts with "..".
    "https://github.com/MarketDataApp/..%2FMarketDataAppX", "https://github.com/MarketDataApp/..%2fMarketDataAppX", "https://github.com/MarketDataApp/..%5cx",
    "https://github.com/MarketDataApp/..%5Cx", "https://github.com/MarketDataApp/..;/x", "https://github.com/MarketDataApp/x%2Fy", "https://github.com/MarketDataApp/a%2e",
    "https://github.com/MarketDataApp/...", "https://github.com/MarketDataApp/x/..;jsessionid=1/y",
    "https://127.0.0.1/", "https://[::1]/",
  ]) assert.equal(fetchListAllows(ENTRIES, url), false, url);
  assert.equal(fetchListAllows(ENTRIES, new URL("https://github.com/MarketDataApp/x")), true, "a parsed URL");
  assert.equal(fetchListAllows([], "https://example.com/"), false, "an empty list refuses every URL");
});

test("each entry that the rules give matches the URL of its own host and path, and no entry of a host matches a subdomain", () => {
  for (const e of ["example.com", "github.com/MarketDataApp", "docs.example/guide/", "api.example/v1/a.b"]) {
    const n = normalizeFetchEntry(e);
    const at = n.indexOf("/");
    const url = `https://${at < 0 ? n : n.slice(0, at)}${at < 0 ? "/" : n.slice(at)}`;
    assert.equal(fetchListAllows([n], url), true, url);
    assert.equal(fetchListAllows([n], url.replace("https://", "https://sub.")), false, `a subdomain of ${n}`);
  }
});

test("the allow file's text: {\"allow\":[...]} with each entry by the entry rules, sorted and once each; not JSON, another shape, a refused entry (named by its number, never echoed) and no entry fail", () => {
  assert.deepEqual(parseAllowFile('{"allow":["www.marketdata.app","MarketData.app","marketdata.app","github.com/MarketDataApp/"]}'), ["github.com/MarketDataApp/", "marketdata.app", "www.marketdata.app"]);
  assert.deepEqual(parseAllowFile('{"allow":["a.example"],"note":"a key that the command does not know"}'), ["a.example"]);
  const why = (text: string) => { try { parseAllowFile(text); return null; } catch (e) { assert.ok(e instanceof AllowFileError, String(e)); return (e as AllowFileError).reason; } };
  assert.equal(why("{not json"), "the allow file is not JSON");
  for (const t of ["[]", "null", "\"a.example\"", "{}", '{"allow":"a.example"}', '{"allow":null}']) assert.equal(why(t), 'the allow file is not {"allow":[<entry>...]}', t);
  assert.equal(why('{"allow":[]}'), "the allow file has no entry, so nothing can be fetched");
  assert.equal(why('{"allow":["a.example","https://secret-host.example/x"]}'), "entry 2 of the allow file is refused: give the entry with no scheme");
  assert.equal(why('{"allow":[7]}'), "entry 1 of the allow file is refused: the entry must be text");
  assert.ok(!why('{"allow":["secret-host.example:8443"]}')!.includes("secret-host"), "no entry in the reason");
  assert.deepEqual(hostsOf(["www.marketdata.app", "github.com/MarketDataApp", "github.com/other/"]), ["github.com", "www.marketdata.app"]);
});
