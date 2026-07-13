import { test } from "node:test";
import assert from "node:assert/strict";
import { withRetry } from "../src/ai/structured.js";

test("withRetry returns the result on first success", async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(calls, 1);
});

test("withRetry retries once after a failure, then succeeds", async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    if (calls === 1) throw new Error("transient");
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(calls, 2);
});

test("withRetry throws the last error once attempts are exhausted", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(async () => {
        calls++;
        throw new Error(`failure ${calls}`);
      }),
    /failure 2/
  );
  assert.equal(calls, 2);
});
