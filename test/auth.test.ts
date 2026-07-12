import "./_authEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  authConfigured,
  createSession,
  destroySession,
  hashPasswordForStorage,
  isLoginRateLimited,
  recordLoginFailure,
  resetLoginAttempts,
  verifyLogin,
} from "../src/web/auth.js";

test("authConfigured is true once username + legacy password are set", () => {
  assert.equal(authConfigured(), true);
});

test("verifyLogin accepts the correct legacy plaintext password", () => {
  assert.equal(verifyLogin("test-admin", "correct-horse-battery-staple"), true);
});

test("verifyLogin rejects a wrong password", () => {
  assert.equal(verifyLogin("test-admin", "wrong-password"), false);
});

test("verifyLogin rejects a wrong username", () => {
  assert.equal(verifyLogin("someone-else", "correct-horse-battery-staple"), false);
});

test("hashPasswordForStorage produces a distinct salt each time", () => {
  const first = hashPasswordForStorage("same-password");
  const second = hashPasswordForStorage("same-password");
  assert.notEqual(first, second);
  assert.match(first, /^[0-9a-f]+:[0-9a-f]+$/);
});

test("createSession yields a usable token and csrf token, destroySession revokes it", () => {
  const { token, csrfToken } = createSession();
  assert.ok(token.length > 0);
  assert.ok(csrfToken.length > 0);
  assert.notEqual(token, csrfToken);
  destroySession(token);
});

test("login rate limiter blocks after repeated failures and resets on success", () => {
  const ip = "203.0.113.5";
  for (let i = 0; i < 5; i++) recordLoginFailure(ip);
  assert.equal(isLoginRateLimited(ip), true);
  resetLoginAttempts(ip);
  assert.equal(isLoginRateLimited(ip), false);
});
