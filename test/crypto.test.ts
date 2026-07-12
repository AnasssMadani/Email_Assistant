import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { decryptJson, encryptJson, looksEncrypted } from "../src/crypto.js";

const key = randomBytes(32).toString("hex");

test("encryptJson/decryptJson round-trips an object", () => {
  const payload = { access_token: "abc", refresh_token: "def", expires_at: 12345 };
  const encrypted = encryptJson(payload, key);
  const decrypted = decryptJson<typeof payload>(encrypted, key);
  assert.deepEqual(decrypted, payload);
});

test("encryptJson produces a different ciphertext each time (random IV)", () => {
  const payload = { a: 1 };
  const first = encryptJson(payload, key);
  const second = encryptJson(payload, key);
  assert.notEqual(first, second);
});

test("decryptJson fails with a different key", () => {
  const encrypted = encryptJson({ a: 1 }, key);
  const otherKey = randomBytes(32).toString("hex");
  assert.throws(() => decryptJson(encrypted, otherKey));
});

test("looksEncrypted recognizes the iv:tag:ciphertext shape", () => {
  const encrypted = encryptJson({ a: 1 }, key);
  assert.equal(looksEncrypted(encrypted), true);
  assert.equal(looksEncrypted(JSON.stringify({ a: 1 })), false);
});
