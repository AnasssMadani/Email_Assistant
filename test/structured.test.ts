import { test } from "node:test";
import assert from "node:assert/strict";
import { freshTestDb } from "./_pgTestDb.js";

// structured.ts imports recordAiUsage from db.js — the pg-mem pool must be
// wired up before that transitive import evaluates, even though this file
// never touches the database directly.
await freshTestDb();
const { withRetry } = await import("../src/ai/structured.js");

test("withRetry returns the result on first success", async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    return "ok";
  }, "test-label");
  assert.equal(result, "ok");
  assert.equal(calls, 1);
});

test("withRetry retries once after a failure, then succeeds", async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    if (calls === 1) throw new Error("transient");
    return "ok";
  }, "test-label");
  assert.equal(result, "ok");
  assert.equal(calls, 2);
});

test("withRetry throws the last error tagged with the source label once attempts are exhausted", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(async () => {
        calls++;
        throw new Error(`failure ${calls}`);
      }, "classification"),
    /\[Claude — classification\] failure 2/
  );
  assert.equal(calls, 2);
});
