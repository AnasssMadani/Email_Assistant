import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "carnet-test-"));
process.env.DB_PATH = path.join(dir, "carnet.db");
process.env.CATEGORIES_CONFIG_PATH = path.resolve("config/categories.json");

const {
  getCategoryRelanceSteps,
  listCategories,
  listCategoriesWithCorpus,
  listHumanReplyCorpusByCategory,
  listShadowLogEntries,
  recordAckDraft,
  recordClassification,
  recordHumanReplyCorpus,
  setShadowLogReviewed,
} = await import("../src/db.js");

test("ensurePiloteCarnetCategories relabels the 3 existing business categories and adds the 3 new ones", () => {
  const categories = listCategories();
  const byId = new Map(categories.map((c) => [c.id, c]));

  assert.equal(byId.get("devis")?.label, "Demande de devis");
  assert.equal(byId.get("reclamation")?.label, "Réclamation");
  assert.equal(byId.get("suivi_dossier")?.label, "Suivi de dossier");

  assert.equal(byId.get("demande_facture")?.label, "Demande de facture");
  assert.equal(byId.get("disponibilite_bad")?.label, "Disponibilité de BAD");
  assert.equal(byId.get("relance_paiement_soa")?.label, "Relance de paiement SOA");

  // Non touchees: hors perimetre metier pour ce client (transitaire).
  assert.ok(byId.has("demande_information"));
  assert.ok(byId.has("candidature"));
});

test("the 6 business categories always alert the team (min urgency 'low') with a single 30-min internal pre_reply step", () => {
  const businessIds = [
    "devis",
    "reclamation",
    "suivi_dossier",
    "demande_facture",
    "disponibilite_bad",
    "relance_paiement_soa",
  ];
  const categories = listCategories();
  const byId = new Map(categories.map((c) => [c.id, c]));

  for (const id of businessIds) {
    const cat = byId.get(id);
    assert.ok(cat, `categorie ${id} manquante`);
    assert.equal(cat?.internalAlertsEnabled, true);
    assert.equal(cat?.internalAlertsMinUrgency, "low");

    const steps = getCategoryRelanceSteps(id, "pre_reply");
    assert.equal(steps.length, 1);
    assert.equal(steps[0].channel, "internal");
    assert.equal(steps[0].delayMinutes, 30);
  }
});

test("recordClassification alone shows up with ackDrafted=false (no accusé judged necessary)", () => {
  recordClassification({
    threadId: "t-shadow-noack",
    messageId: "m-shadow-noack",
    categoryId: "interne",
    urgency: "low",
    originalSubject: "RE: reunion equipe",
    senderEmail: "collegue@example.com",
    senderName: null,
    receivedBody: "On se voit a 15h ?",
  });

  const entries = listShadowLogEntries();
  const entry = entries.find((e) => e.threadId === "t-shadow-noack");
  assert.ok(entry);
  assert.equal(entry?.urgency, "low");
  assert.equal(entry?.ackDrafted, false);
  assert.equal(entry?.receivedBody, "On se voit a 15h ?");
});

test("recordClassification then recordAckDraft completes the same row (not a duplicate) and toggle review works", () => {
  recordClassification({
    threadId: "t-shadow-1",
    messageId: "m-shadow-1",
    categoryId: "devis",
    urgency: "normal",
    originalSubject: "Demande de devis conteneur",
    senderEmail: "client@example.com",
    senderName: "Client Example",
    receivedBody: "Bonjour, pouvez-vous me faire un devis ?",
  });
  recordAckDraft({
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

  const entries = listShadowLogEntries();
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

  setShadowLogReviewed(entry.id, true);
  const [updated] = listShadowLogEntries().filter((e) => e.threadId === "t-shadow-1");
  assert.equal(updated.reviewedOk, true);
});

test("recordAckDraft falls back to inserting a row when no prior classification exists (manual /traiter reprocess)", () => {
  recordAckDraft({
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

  const entry = listShadowLogEntries().find((e) => e.threadId === "t-manual-traiter");
  assert.ok(entry);
  assert.equal(entry?.ackDrafted, true);
  assert.equal(entry?.urgency, null);
});

test("human_reply_corpus: record and list per category", () => {
  recordHumanReplyCorpus({
    threadId: "t-corpus-1",
    categoryId: "reclamation",
    replyBody: "Nous sommes desoles pour ce retard, voici ce que nous proposons.",
  });

  assert.ok(listCategoriesWithCorpus().includes("reclamation"));
  const replies = listHumanReplyCorpusByCategory("reclamation");
  assert.equal(replies.length, 1);
  assert.equal(replies[0], "Nous sommes desoles pour ce retard, voici ce que nous proposons.");
  assert.equal(listHumanReplyCorpusByCategory("devis").length, 0);
});
