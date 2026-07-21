import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "connect-invite-test-"));
const dbPath = path.join(dir, "invite.db");
process.env.DB_PATH = dbPath;
process.env.CATEGORIES_CONFIG_PATH = path.resolve("config/categories.json");

const { createConnectInvite, consumeConnectInvite, getValidConnectInvite, listConnectInvites, revokeConnectInvite } =
  await import("../src/db.js");

test("createConnectInvite then getValidConnectInvite finds the token", () => {
  const { token, expiresAt } = createConnectInvite(7);
  assert.equal(token.length, 64); // randomBytes(32).toString("hex")
  assert.ok(new Date(expiresAt).getTime() > Date.now());

  const invite = getValidConnectInvite(token);
  assert.ok(invite);
  assert.equal(invite?.token, token);
  assert.equal(invite?.used_at, null);
  assert.equal(invite?.revoked_at, null);
});

test("consumeConnectInvite marks it used and getValidConnectInvite no longer returns it", () => {
  const { token } = createConnectInvite(7);
  consumeConnectInvite(token, "gmail");

  assert.equal(getValidConnectInvite(token), undefined);
  const all = listConnectInvites();
  const consumed = all.find((i) => i.token === token);
  assert.ok(consumed?.used_at);
  assert.equal(consumed?.used_provider, "gmail");
});

test("revokeConnectInvite invalidates a token even though it was never used", () => {
  const { token } = createConnectInvite(7);
  revokeConnectInvite(token);

  assert.equal(getValidConnectInvite(token), undefined);
  const all = listConnectInvites();
  const revoked = all.find((i) => i.token === token);
  assert.ok(revoked?.revoked_at);
  assert.equal(revoked?.used_at, null);
});

test("an expired invite is not valid even if never used or revoked", () => {
  const { token } = createConnectInvite(7);

  // Simule le passage du temps: recule expires_at directement en base,
  // comme les tests de migration legacy le font pour simuler un vieux schema.
  const raw = new DatabaseSync(dbPath);
  raw.prepare("UPDATE connect_invites SET expires_at = ? WHERE token = ?").run(
    new Date(Date.now() - 60_000).toISOString(),
    token
  );
  raw.close();

  assert.equal(getValidConnectInvite(token), undefined);
});
