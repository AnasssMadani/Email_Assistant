import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeBase64Url, extractPlainText, parseAddress } from "../src/connectors/mime.js";

test("parseAddress handles a bare address with no angle brackets or name", () => {
  // Regression: the previous regex had no way to bound an absent display
  // name, so it greedily consumed the local part of the address itself,
  // backtracking just far enough to still find an "@" — turning
  // "ahmedmokile@gmail.com" into { name: "ahmedmokil", email: "e@gmail.com" }.
  assert.deepEqual(parseAddress("ahmedmokile@gmail.com"), { email: "ahmedmokile@gmail.com" });
  assert.deepEqual(parseAddress("a@b.co"), { email: "a@b.co" });
});

test("parseAddress extracts name and email from \"Name <email>\" form", () => {
  assert.deepEqual(parseAddress("Anas Madani <monissisme12@gmail.com>"), {
    name: "Anas Madani",
    email: "monissisme12@gmail.com",
  });
});

test("parseAddress extracts name and email from '\"Name\" <email>' form", () => {
  assert.deepEqual(parseAddress('"Anas Madani" <monissisme12@gmail.com>'), {
    name: "Anas Madani",
    email: "monissisme12@gmail.com",
  });
});

test("parseAddress returns an empty email for undefined input", () => {
  assert.deepEqual(parseAddress(undefined), { email: "" });
});

test("extractPlainText converts a text/plain part that actually holds HTML code", () => {
  const html = "<html><body><p>Bonjour,</p><p>Merci de trouver ci joint notre quotation&nbsp;</p></body></html>";
  const text = extractPlainText({ mimeType: "text/plain", body: { data: encodeBase64Url(html) } });
  assert.equal(text, "Bonjour,\n\nMerci de trouver ci joint notre quotation");
  const plain = "Hi dear,\nWell noted.";
  assert.equal(extractPlainText({ mimeType: "text/plain", body: { data: encodeBase64Url(plain) } }), plain);
});
