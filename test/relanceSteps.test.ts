import "./_settingsEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addCategoryRelanceStep,
  addThreadRelanceStep,
  clearThreadRelanceOverride,
  deleteCategoryRelanceStep,
  deleteThreadData,
  getCategoryRelanceSteps,
  getEffectiveRelanceSteps,
  hasThreadRelanceOverride,
  upsertThreadReceived,
} from "../src/db.js";

test("a category seeded from config/categories.json has a relance sequence", () => {
  const steps = getCategoryRelanceSteps("devis");
  assert.ok(steps.length > 0);
  assert.equal(steps[0].order, 1);
});

test("a dossier with no override falls back to its category's sequence", () => {
  upsertThreadReceived({
    threadId: "t-fallback",
    subject: "Test",
    senderEmail: "a@example.com",
    senderName: null,
    categoryId: "devis",
    urgency: "normal",
    slaHours: 24,
    status: "ack_sent",
    dueAt: new Date().toISOString(),
  });

  const { steps, isCustom } = getEffectiveRelanceSteps("t-fallback", "devis");
  assert.equal(isCustom, false);
  assert.deepEqual(steps, getCategoryRelanceSteps("devis"));
});

test("adding a thread-scoped step overrides the category sequence entirely", () => {
  upsertThreadReceived({
    threadId: "t-override",
    subject: "Test",
    senderEmail: "b@example.com",
    senderName: null,
    categoryId: "devis",
    urgency: "normal",
    slaHours: 24,
    status: "ack_sent",
    dueAt: new Date().toISOString(),
  });

  assert.equal(hasThreadRelanceOverride("t-override"), false);
  addThreadRelanceStep("t-override", { channel: "external", delayMinutes: 48 });

  const { steps, isCustom } = getEffectiveRelanceSteps("t-override", "devis");
  assert.equal(isCustom, true);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].channel, "external");
  assert.equal(steps[0].delayMinutes, 48);
  assert.notDeepEqual(steps, getCategoryRelanceSteps("devis"));
});

test("clearing a thread override reverts it to the category default", () => {
  upsertThreadReceived({
    threadId: "t-clear",
    subject: "Test",
    senderEmail: "c@example.com",
    senderName: null,
    categoryId: "devis",
    urgency: "normal",
    slaHours: 24,
    status: "ack_sent",
    dueAt: new Date().toISOString(),
  });
  addThreadRelanceStep("t-clear", { channel: "internal", delayMinutes: 12 });
  assert.equal(getEffectiveRelanceSteps("t-clear", "devis").isCustom, true);

  clearThreadRelanceOverride("t-clear");
  const result = getEffectiveRelanceSteps("t-clear", "devis");
  assert.equal(result.isCustom, false);
  assert.deepEqual(result.steps, getCategoryRelanceSteps("devis"));
});

test("category steps can be added and deleted, re-numbering the remaining ones", () => {
  const before = getCategoryRelanceSteps("candidature").length;
  addCategoryRelanceStep("candidature", { channel: "external", delayMinutes: 200 });
  const afterAdd = getCategoryRelanceSteps("candidature");
  assert.equal(afterAdd.length, before + 1);

  deleteCategoryRelanceStep("candidature", 1);
  const afterDelete = getCategoryRelanceSteps("candidature");
  assert.equal(afterDelete.length, before);
  assert.deepEqual(
    afterDelete.map((s) => s.order),
    afterDelete.map((_, i) => i + 1)
  );
});

test("deleteThreadData removes a dossier's custom relance override", () => {
  upsertThreadReceived({
    threadId: "t-delete",
    subject: "Test",
    senderEmail: "d@example.com",
    senderName: null,
    categoryId: "devis",
    urgency: "normal",
    slaHours: 24,
    status: "ack_sent",
    dueAt: new Date().toISOString(),
  });
  addThreadRelanceStep("t-delete", { channel: "external", delayMinutes: 10 });
  assert.equal(hasThreadRelanceOverride("t-delete"), true);

  deleteThreadData("t-delete");
  assert.equal(hasThreadRelanceOverride("t-delete"), false);
});
