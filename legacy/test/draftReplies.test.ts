import { test } from "node:test";
import assert from "node:assert/strict";
import { repliesSchema } from "../src/ai/draftReplies.js";

const validDraft = { variant: "A", label: "Réponse détaillée", subject: "Re: Devis", body: "Bonjour..." };

test("repliesSchema accepts a native array of 3 drafts", () => {
  const result = repliesSchema.parse({
    drafts: [validDraft, { ...validDraft, variant: "B" }, { ...validDraft, variant: "C" }],
  });
  assert.equal(result.drafts.length, 3);
});

test("repliesSchema recovers when Claude returns drafts as a JSON-stringified array", () => {
  // Regression: observed in production — Claude's tool_use.input.drafts came
  // back as a string instead of an array, failing validation on both
  // withRetry attempts and silently dropping the 3 draft replies for the
  // dossier even though the ack had already been sent successfully.
  const stringified = JSON.stringify([validDraft, { ...validDraft, variant: "B" }, { ...validDraft, variant: "C" }]);
  const result = repliesSchema.parse({ drafts: stringified });
  assert.equal(result.drafts.length, 3);
  assert.equal(result.drafts[0].variant, "A");
});

test("repliesSchema still rejects a drafts value that isn't valid JSON or an array", () => {
  assert.throws(() => repliesSchema.parse({ drafts: "not json at all" }));
});

test("repliesSchema still enforces exactly 3 drafts even after JSON-string recovery", () => {
  const stringified = JSON.stringify([validDraft, { ...validDraft, variant: "B" }]);
  assert.throws(() => repliesSchema.parse({ drafts: stringified }));
});
