import { test } from "node:test";
import assert from "node:assert/strict";
import { freshTestDb } from "./_pgTestDb.js";

const {
  listCategoriesWithCorpus,
  listHumanReplyCorpusByCategory,
  listShadowLogEntries,
  purgeShadowLogOlderThan,
  recordAckDraft,
  recordClassification,
  recordHumanReplyCorpus,
  setShadowLogReviewed,
} = await freshTestDb();

test("SEC-003: purgeShadowLogOlderThan removes rows past retention but not recent ones", async () => {
  await recordClassification({
    threadId: "t-purge",
    messageId: "m-purge",
    categoryId: "devis",
    urgency: "normal",
    originalSubject: "A purger un jour",
    senderEmail: "purge@example.com",
    senderName: null,
    receivedBody: "Corps du message a purger.",
  });
  const beforeIds = (await listShadowLogEntries()).map((e) => e.threadId);
  assert.ok(beforeIds.includes("t-purge"));

  // Fenetre de 90 jours: cette entree, creee a l'instant, ne doit pas etre purgee.
  const deletedTooEarly = await purgeShadowLogOlderThan(90);
  assert.equal(deletedTooEarly, 0);
  assert.ok((await listShadowLogEntries()).map((e) => e.threadId).includes("t-purge"));

  // Fenetre de 0 jour: le seuil (maintenant) est posterieur au created_at de
  // l'entree, elle doit donc bien passer a la purge.
  const deletedNow = await purgeShadowLogOlderThan(0);
  assert.ok(deletedNow >= 1);
  assert.ok(!(await listShadowLogEntries()).map((e) => e.threadId).includes("t-purge"));
});

test("recordClassification alone shows up with ackDrafted=false (no accusé judged necessary)", async () => {
  await recordClassification({
    threadId: "t-shadow-noack",
    messageId: "m-shadow-noack",
    categoryId: "interne",
    urgency: "low",
    originalSubject: "RE: reunion equipe",
    senderEmail: "collegue@example.com",
    senderName: null,
    receivedBody: "On se voit a 15h ?",
  });

  const entries = await listShadowLogEntries();
  const entry = entries.find((e) => e.threadId === "t-shadow-noack");
  assert.ok(entry);
  assert.equal(entry?.urgency, "low");
  assert.equal(entry?.ackDrafted, false);
  assert.equal(entry?.receivedBody, "On se voit a 15h ?");
});

test("recordClassification then recordAckDraft completes the same row (not a duplicate) and toggle review works", async () => {
  await recordClassification({
    threadId: "t-shadow-1",
    messageId: "m-shadow-1",
    categoryId: "devis",
    urgency: "normal",
    originalSubject: "Demande de devis conteneur",
    senderEmail: "client@example.com",
    senderName: "Client Example",
    receivedBody: "Bonjour, pouvez-vous me faire un devis ?",
  });
  await recordAckDraft({
    threadId: "t-shadow-1",
    messageId: "m-shadow-1",
    categoryId: "devis",
    originalSubject: "Demande de devis conteneur",
    senderEmail: "client@example.com",
    senderName: "Client Example",
    receivedBody: "Bonjour, pouvez-vous me faire un devis ?",
    ackSubject: "Re: Demande de devis conteneur",
    ackBody: "Bonjour, nous avons bien reçu votre demande...",
  });

  const entries = await listShadowLogEntries();
  const matching = entries.filter((e) => e.threadId === "t-shadow-1");
  assert.equal(matching.length, 1); // pas de doublon: meme message_id, meme ligne
  const [entry] = matching;
  assert.equal(entry.categoryLabel, "Demande de devis");
  assert.equal(entry.urgency, "normal");
  assert.equal(entry.ackDrafted, true);
  assert.equal(entry.ackBody, "Bonjour, nous avons bien reçu votre demande...");
  assert.equal(entry.reviewedOk, false);
  assert.equal(entry.rappelEnvoye, false);
  assert.equal(entry.humanReplyDelayMinutes, null);

  await setShadowLogReviewed(entry.id, true);
  const [updated] = (await listShadowLogEntries()).filter((e) => e.threadId === "t-shadow-1");
  assert.equal(updated.reviewedOk, true);
});

test("recordAckDraft falls back to inserting a row when no prior classification exists (manual /traiter reprocess)", async () => {
  await recordAckDraft({
    threadId: "t-manual-traiter",
    messageId: "m-manual-traiter",
    categoryId: "reclamation",
    originalSubject: "Colis endommage",
    senderEmail: "client2@example.com",
    senderName: null,
    receivedBody: "Mon colis est arrive casse.",
    ackSubject: "Re: Colis endommage",
    ackBody: "Nous sommes desoles, nous investiguons.",
  });

  const entry = (await listShadowLogEntries()).find((e) => e.threadId === "t-manual-traiter");
  assert.ok(entry);
  assert.equal(entry?.ackDrafted, true);
  assert.equal(entry?.urgency, null);
});

test("human_reply_corpus: record and list per category", async () => {
  await recordHumanReplyCorpus({
    threadId: "t-corpus-1",
    categoryId: "reclamation",
    replyBody: "Nous sommes desoles pour ce retard, voici ce que nous proposons.",
  });

  assert.ok((await listCategoriesWithCorpus()).includes("reclamation"));
  const replies = await listHumanReplyCorpusByCategory("reclamation");
  assert.equal(replies.length, 1);
  assert.equal(replies[0], "Nous sommes desoles pour ce retard, voici ce que nous proposons.");
  assert.equal((await listHumanReplyCorpusByCategory("devis")).length, 0);
});
