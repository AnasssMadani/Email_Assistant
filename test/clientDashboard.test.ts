import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// DB isolee: ces tests ecrivent des rappels et des dossiers dans des etats
// precis (statuts, step_type) et comptent des lignes — partager la base
// fichier des autres tests rendrait les totaux fragiles.
const dir = mkdtempSync(path.join(tmpdir(), "client-dashboard-test-"));
process.env.DB_PATH = path.join(dir, "client.db");
process.env.CATEGORIES_CONFIG_PATH = path.resolve("config/categories.json");

const {
  getClientPeriodKpis,
  getClientThreadDetail,
  hasReminderStep,
  listClientCategories,
  listClientThreads,
  recordReminder,
  setThreadAckSent,
  setThreadHumanReplied,
  setThreadStatus,
  updateClientCategorySla,
  upsertThreadReceived,
} = await import("../src/db.js");

test("recordReminder tags step_type, and hasReminderStep reads it back", () => {
  const threadId = "t-step-type";
  upsertThreadReceived({
    threadId,
    subject: "Devis conteneur",
    senderEmail: "a@example.com",
    senderName: null,
    categoryId: "devis",
    urgency: "normal",
    slaMinutes: 1440,
    status: "ack_sent",
    dueAt: new Date().toISOString(),
  });

  assert.equal(hasReminderStep(threadId, "accuse"), false);
  recordReminder(threadId, "external", "Accusé de réception envoyé à a@example.com.", "accuse");
  assert.equal(hasReminderStep(threadId, "accuse"), true);

  // Un rappel interne filtre (urgence sous le seuil) ne doit jamais compter
  // comme "relance_interne" — le client ne doit jamais voir "équipe alertée"
  // pour une alerte qui n'a en realite pas ete envoyee.
  recordReminder(threadId, "internal", "Alerte filtree", "relance_interne_filtree");
  assert.equal(hasReminderStep(threadId, "relance_interne"), false);

  recordReminder(threadId, "internal", "Rappel reel", "relance_interne");
  assert.equal(hasReminderStep(threadId, "relance_interne"), true);
});

test("listClientThreads excludes skipped dossiers and exposes only client-safe fields", () => {
  upsertThreadReceived({
    threadId: "t-visible",
    subject: "Demande visible",
    senderEmail: "b@example.com",
    senderName: "Client B",
    categoryId: "devis",
    urgency: "normal",
    slaMinutes: 1440,
    status: "ack_sent",
    dueAt: new Date().toISOString(),
  });
  upsertThreadReceived({
    threadId: "t-skipped",
    subject: "Newsletter",
    senderEmail: "spam@example.com",
    senderName: null,
    categoryId: "spam_newsletter",
    urgency: "normal",
    slaMinutes: 0,
    status: "skipped",
    dueAt: null,
  });

  const threads = listClientThreads();
  const ids = threads.map((t) => t.threadId);
  assert.ok(ids.includes("t-visible"));
  assert.ok(!ids.includes("t-skipped"));

  const visible = threads.find((t) => t.threadId === "t-visible")!;
  assert.deepEqual(Object.keys(visible).sort(), [
    "categoryLabel",
    "dueAt",
    "receivedAt",
    "resolved",
    "senderEmail",
    "senderName",
    "subject",
    "threadId",
  ]);
});

test("getClientThreadDetail builds a checklist from real timestamps and reminder steps, not deduced from text", () => {
  const threadId = "t-checklist";
  upsertThreadReceived({
    threadId,
    subject: "Devis grue",
    senderEmail: "c@example.com",
    senderName: null,
    categoryId: "devis",
    urgency: "normal",
    slaMinutes: 1440,
    status: "ack_sent",
    dueAt: new Date().toISOString(),
  });
  setThreadAckSent(threadId);
  recordReminder(threadId, "external", "Accusé envoyé.", "accuse");

  let detail = getClientThreadDetail(threadId);
  assert.ok(detail);
  assert.equal(detail!.checklist.accuseEnvoye.done, true);
  assert.equal(detail!.checklist.reponseEquipe.done, false);
  assert.equal(detail!.checklist.cloture.done, false);

  setThreadHumanReplied(threadId);
  recordReminder(threadId, "external", "Relance envoyee.", "relance_externe_pre_reponse");

  detail = getClientThreadDetail(threadId);
  assert.equal(detail!.checklist.relanceClientAvantReponse.done, true);
  assert.equal(detail!.checklist.reponseEquipe.done, true);
  assert.ok(detail!.checklist.reponseEquipe.delayLabel); // "X min" / "X h" / "X j"

  setThreadStatus(threadId, "closed");
  detail = getClientThreadDetail(threadId);
  assert.equal(detail!.checklist.cloture.done, true);
  assert.equal(detail!.resolved, true);
});

test("BUG-002/005: getClientPeriodKpis excludes outbound-discovered dossiers from the average response time and the processed count", () => {
  // Dossier normal (inbound): repondu il y a 30 min -> compte dans "processed"
  // et contribue au delai moyen de reponse.
  upsertThreadReceived({
    threadId: "t-inbound-delay",
    subject: "Devis inbound",
    senderEmail: "inbound@example.com",
    senderName: null,
    categoryId: "devis",
    urgency: "normal",
    slaMinutes: 1440,
    status: "awaiting_client_reply",
    dueAt: null,
  });
  setThreadHumanReplied("t-inbound-delay", new Date(Date.now() - 30 * 60_000).toISOString());

  const before = getClientPeriodKpis(7);

  // Dossier decouvert en sortie (outbound): received_at = maintenant (heure
  // de decouverte), human_replied_at = il y a 5 min (heure du vrai envoi) ->
  // span negatif s'il etait inclus. Doit etre exclu du delai moyen ET du
  // compteur "processed" (ce n'est pas un email client traite).
  upsertThreadReceived({
    threadId: "t-outbound-negative",
    subject: "Devis a froid",
    senderEmail: "prospect@example.com",
    senderName: null,
    categoryId: "devis",
    urgency: "normal",
    slaMinutes: 1440,
    status: "awaiting_client_reply",
    dueAt: null,
    origin: "outbound",
  });
  setThreadHumanReplied("t-outbound-negative", new Date(Date.now() - 5 * 60_000).toISOString());

  const after = getClientPeriodKpis(7);

  // La moyenne ne doit jamais devenir negative ni etre tiree vers le bas par
  // le dossier outbound, et le compteur "processed" ne doit pas bouger.
  assert.ok(after.avgResponseMinutes !== null && after.avgResponseMinutes >= 0);
  assert.equal(after.avgResponseMinutes, before.avgResponseMinutes);
  assert.equal(after.processed, before.processed);
});

test("listClientCategories excludes spam_newsletter and interne, and updateClientCategorySla only touches the SLA", () => {
  const categories = listClientCategories();
  const ids = categories.map((c) => c.id);
  assert.ok(!ids.includes("spam_newsletter"));
  assert.ok(!ids.includes("interne"));
  assert.ok(ids.includes("devis"));

  updateClientCategorySla("devis", 60);
  const updated = listClientCategories().find((c) => c.id === "devis")!;
  assert.equal(updated.slaMinutes, 60);
  assert.equal(updated.label, "Demande de devis"); // le libelle n'a pas bouge
});
