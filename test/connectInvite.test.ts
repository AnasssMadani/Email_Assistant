import { test } from "node:test";
import assert from "node:assert/strict";
import { freshTestDb } from "./_pgTestDb.js";

const { createConnectInvite, consumeConnectInvite, getValidConnectInvite, listConnectInvites, revokeConnectInvite } =
  await freshTestDb();
const { getPool } = await import("../src/dbPool.js");

test("createConnectInvite then getValidConnectInvite finds the token", async () => {
  const { token, expiresAt } = await createConnectInvite(7);
  assert.equal(token.length, 64); // randomBytes(32).toString("hex")
  assert.ok(new Date(expiresAt).getTime() > Date.now());

  const invite = await getValidConnectInvite(token);
  assert.ok(invite);
  assert.equal(invite?.token, token);
  assert.equal(invite?.used_at, null);
  assert.equal(invite?.revoked_at, null);
});

test("consumeConnectInvite marks it used and getValidConnectInvite no longer returns it", async () => {
  const { token } = await createConnectInvite(7);
  await consumeConnectInvite(token, "gmail");

  assert.equal(await getValidConnectInvite(token), undefined);
  const all = await listConnectInvites();
  const consumed = all.find((i) => i.token === token);
  assert.ok(consumed?.used_at);
  assert.equal(consumed?.used_provider, "gmail");
});

test("revokeConnectInvite invalidates a token even though it was never used", async () => {
  const { token } = await createConnectInvite(7);
  await revokeConnectInvite(token);

  assert.equal(await getValidConnectInvite(token), undefined);
  const all = await listConnectInvites();
  const revoked = all.find((i) => i.token === token);
  assert.ok(revoked?.revoked_at);
  assert.equal(revoked?.used_at, null);
});

test("an expired invite is not valid even if never used or revoked", async () => {
  const { token } = await createConnectInvite(7);

  // Simule le passage du temps: recule expires_at directement en base, via
  // le meme pool pg-mem que db.ts (voir getPool dans src/dbPool.ts).
  await getPool().query("UPDATE connect_invites SET expires_at = $1 WHERE token = $2", [
    new Date(Date.now() - 60_000).toISOString(),
    token,
  ]);

  assert.equal(await getValidConnectInvite(token), undefined);
});
