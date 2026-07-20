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
  getClientMonthlyStats,
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

test("getClientMonthlyStats counts relances only from external step types, not internal ones", () => {
  const threadId = "t-stats";
  upsertThreadReceived({
    threadId,
    subject: "Devis stats",
    senderEmail: "d@example.com",
    senderName: null,
    categoryId: "devis",
    urgency: "normal",
    slaMinutes: 1440,
    status: "ack_sent",
    dueAt: new Date().toISOString(),
  });
  setThreadHumanReplied(threadId);
  recordReminder(threadId, "internal", "Rappel interne.", "relance_interne");
  recordReminder(threadId, "external", "Relance externe.", "relance_externe_pre_reponse");

  const before = getClientMonthlyStats();
  recordReminder(threadId, "external", "Encore une relance.", "relance_externe_post_reponse");
  const after = getClientMonthlyStats();

  assert.equal(after.relancesEnvoyees, before.relancesEnvoyees + 1);
  assert.ok(after.delaiMoyenReponseMinutes !== null);
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
