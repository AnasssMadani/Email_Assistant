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
  recordHumanReplyCorpus,
  recordShadowLogEntry,
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

test("shadow_log: record, list and toggle review", () => {
  recordShadowLogEntry({
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
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.equal(entry.threadId, "t-shadow-1");
  assert.equal(entry.categoryLabel, "Demande de devis");
  assert.equal(entry.reviewedOk, false);
  assert.equal(entry.rappelEnvoye, false);
  assert.equal(entry.humanReplyDelayMinutes, null);

  setShadowLogReviewed(entry.id, true);
  const [updated] = listShadowLogEntries();
  assert.equal(updated.reviewedOk, true);
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
