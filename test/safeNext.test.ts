import { test } from "node:test";
import assert from "node:assert/strict";
import { safeNext, escapeHtml } from "../src/web/shared.js";

test("SEC-004: safeNext rejects protocol-relative URLs (open redirect)", () => {
  assert.equal(safeNext("//evil.com/phish", "/"), "/");
  assert.equal(safeNext("//evil.com", "/"), "/");
});

test("SEC-004: safeNext rejects backslash variants", () => {
  assert.equal(safeNext("/\\evil.com", "/"), "/");
});

test("SEC-004: safeNext accepts a plain site-relative path", () => {
  assert.equal(safeNext("/dossiers/123", "/"), "/dossiers/123");
});

test("SEC-004: safeNext falls back on absolute URLs and empty input", () => {
  assert.equal(safeNext("https://evil.com", "/"), "/");
  assert.equal(safeNext(undefined, "/"), "/");
  assert.equal(safeNext("", "/"), "/");
});

test("SEC-010: escapeHtml now also escapes ' and /", () => {
  assert.equal(escapeHtml("it's a </script> test"), "it&#39;s a &lt;&#x2F;script&gt; test");
});
