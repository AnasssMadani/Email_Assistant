import "./_settingsEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addCategoryRelanceStep,
  addThreadRelanceStep,
  clearThreadRelanceOverride,
  deleteCategoryRelanceStep,
  deleteThreadData,
  freezeRelanceStepsSnapshot,
  getCategoryRelanceSteps,
  getEffectiveRelanceSteps,
  getThreadRow,
  hasThreadRelanceOverride,
  incrementPostReplyRelance,
  listThreadsAwaitingClientReply,
  listThreadsAwaitingReply,
  setThreadAckSent,
  setThreadHumanReplied,
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
    slaMinutes: 1440,
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
    slaMinutes: 1440,
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
    slaMinutes: 1440,
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
    slaMinutes: 1440,
    status: "ack_sent",
    dueAt: new Date().toISOString(),
  });
  addThreadRelanceStep("t-delete", { channel: "external", delayMinutes: 10 });
  assert.equal(hasThreadRelanceOverride("t-delete"), true);

  deleteThreadData("t-delete");
  assert.equal(hasThreadRelanceOverride("t-delete"), false);
});

test("pre_reply and post_reply sequences for the same category are independent", () => {
  const preSteps = getCategoryRelanceSteps("devis", "pre_reply");
  const postSteps = getCategoryRelanceSteps("devis", "post_reply");
  assert.ok(preSteps.length > 0);
  assert.ok(postSteps.length > 0);
  assert.notDeepEqual(preSteps, postSteps);

  addCategoryRelanceStep("devis", { channel: "external", delayMinutes: 99999 }, "post_reply");
  const preAfter = getCategoryRelanceSteps("devis", "pre_reply");
  const postAfter = getCategoryRelanceSteps("devis", "post_reply");
  assert.deepEqual(preAfter, preSteps);
  assert.equal(postAfter.length, postSteps.length + 1);
});

test("a thread-scoped post_reply override does not affect the pre_reply sequence", () => {
  upsertThreadReceived({
    threadId: "t-two-phase",
    subject: "Test",
    senderEmail: "e@example.com",
    senderName: null,
    categoryId: "devis",
    urgency: "normal",
    slaMinutes: 1440,
    status: "ack_sent",
    dueAt: new Date().toISOString(),
  });

  addThreadRelanceStep("t-two-phase", { channel: "external", delayMinutes: 4320 }, "post_reply");

  const preReply = getEffectiveRelanceSteps("t-two-phase", "devis", "pre_reply");
  const postReply = getEffectiveRelanceSteps("t-two-phase", "devis", "post_reply");
  assert.equal(preReply.isCustom, false);
  assert.equal(postReply.isCustom, true);
  assert.equal(postReply.steps.length, 1);
  assert.equal(postReply.steps[0].delayMinutes, 4320);
});

test("setThreadHumanReplied transitions a dossier into awaiting_client_reply", () => {
  upsertThreadReceived({
    threadId: "t-human-replied",
    subject: "Devis conteneur",
    senderEmail: "f@example.com",
    senderName: null,
    categoryId: "devis",
    urgency: "normal",
    slaMinutes: 1440,
    status: "ack_sent",
    dueAt: new Date().toISOString(),
  });

  setThreadHumanReplied("t-human-replied");
  const row = getThreadRow("t-human-replied");
  assert.equal(row?.status, "awaiting_client_reply");
  assert.ok(row?.human_replied_at);

  const awaiting = listThreadsAwaitingClientReply();
  assert.ok(awaiting.some((r) => r.thread_id === "t-human-replied"));

  incrementPostReplyRelance("t-human-replied", "post_reply_relance_sent");
  const updated = getThreadRow("t-human-replied");
  assert.equal(updated?.post_reply_relance_count, 1);
  assert.equal(updated?.status, "post_reply_relance_sent");
});

test("a post-reply relance no longer makes the dossier eligible for the pre-reply loop again", () => {
  // Regression: pre-reply and post-reply external relances used to share the
  // literal status "relance_sent". listThreadsAwaitingReply() (pre-reply)
  // matches on that same string, so the moment a post-reply relance set the
  // status back to "relance_sent", the dossier became eligible for BOTH
  // loops at once — observed live as a dossier receiving an internal notify
  // AND a second, different client relance after it had already moved into
  // post-reply. It must appear in the post-reply eligible set and must NOT
  // reappear in the pre-reply one.
  const threadId = "t-no-oscillation";
  upsertThreadReceived({
    threadId,
    subject: "Devis",
    senderEmail: "client@example.com",
    senderName: null,
    categoryId: "devis",
    urgency: "normal",
    slaMinutes: 1,
    status: "ack_sent",
    dueAt: new Date(Date.now() - 60_000).toISOString(),
  });
  setThreadAckSent(threadId);
  setThreadHumanReplied(threadId);
  incrementPostReplyRelance(threadId, "post_reply_relance_sent");

  const preReplyEligible = listThreadsAwaitingReply().some((r) => r.thread_id === threadId);
  const postReplyEligible = listThreadsAwaitingClientReply().some((r) => r.thread_id === threadId);

  assert.equal(preReplyEligible, false);
  assert.equal(postReplyEligible, true);
});

test("a dossier's relance sequence freezes at first check and ignores later category edits", () => {
  // Regression: editing a category's delays used to apply live to every open
  // dossier using that category's default sequence, since getEffectiveRelanceSteps
  // read the category fresh on every cycle — a config change meant to affect
  // future dossiers could suddenly make an already-waiting dossier "due" and
  // fire an external relance to a client who was never supposed to get one at
  // that moment. freezeRelanceStepsSnapshot() locks a dossier onto the
  // category's steps as of its first check; later category edits must not
  // reach it, while a brand-new dossier must still see the updated category.
  const threadId = "t-frozen-snapshot";
  upsertThreadReceived({
    threadId,
    subject: "Devis",
    senderEmail: "g@example.com",
    senderName: null,
    categoryId: "devis",
    urgency: "normal",
    slaMinutes: 1440,
    status: "ack_sent",
    dueAt: new Date().toISOString(),
  });

  const stepsBeforeFreeze = getCategoryRelanceSteps("devis", "pre_reply");
  freezeRelanceStepsSnapshot(threadId, "devis", "pre_reply");

  // La categorie change APRES le gel de ce dossier.
  addCategoryRelanceStep("devis", { channel: "external", delayMinutes: 555 }, "pre_reply");

  const frozen = getEffectiveRelanceSteps(threadId, "devis", "pre_reply");
  assert.equal(frozen.isCustom, false);
  assert.deepEqual(frozen.steps, stepsBeforeFreeze);

  const newCategorySteps = getCategoryRelanceSteps("devis", "pre_reply");
  assert.equal(newCategorySteps.length, stepsBeforeFreeze.length + 1);

  // Un dossier jamais fige voit, lui, la categorie a jour.
  const freshThreadId = "t-fresh-after-category-change";
  upsertThreadReceived({
    threadId: freshThreadId,
    subject: "Devis",
    senderEmail: "h@example.com",
    senderName: null,
    categoryId: "devis",
    urgency: "normal",
    slaMinutes: 1440,
    status: "ack_sent",
    dueAt: new Date().toISOString(),
  });
  const fresh = getEffectiveRelanceSteps(freshThreadId, "devis", "pre_reply");
  assert.deepEqual(fresh.steps, newCategorySteps);

  // Nettoyage: ne pas polluer la categorie "devis" pour d'eventuels tests suivants.
  deleteCategoryRelanceStep("devis", newCategorySteps[newCategorySteps.length - 1].order, "pre_reply");
});
