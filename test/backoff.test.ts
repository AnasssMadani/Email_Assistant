import { test } from "node:test";
import assert from "node:assert/strict";
import { withBackoff } from "../src/connectors/backoff.js";

function httpError(status: number): Error & { status: number } {
  const err = new Error(`boom ${status}`) as Error & { status: number };
  err.status = status;
  return err;
}

test("OPT-008: withBackoff returns immediately on first success", async () => {
  let calls = 0;
  const result = await withBackoff(async () => {
    calls++;
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(calls, 1);
});

test("OPT-008: withBackoff retries on a transient 429/500/502/503 and eventually succeeds", async () => {
  let calls = 0;
  const result = await withBackoff(async () => {
    calls++;
    if (calls < 3) throw httpError(503);
    return "recovered";
  });
  assert.equal(result, "recovered");
  assert.equal(calls, 3);
});

test("OPT-008: withBackoff does not retry a non-transient error (e.g. 404)", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withBackoff(async () => {
        calls++;
        throw httpError(404);
      }),
    /boom 404/
  );
  assert.equal(calls, 1);
});

test("OPT-008: withBackoff gives up after exhausting attempts and throws the last error", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withBackoff(async () => {
        calls++;
        throw httpError(429);
      }, 3),
    /boom 429/
  );
  assert.equal(calls, 3);
});
