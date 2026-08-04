import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "performance-test-"));
process.env.DB_PATH = path.join(dir, "performance.db");
process.env.CATEGORIES_CONFIG_PATH = path.resolve("config/categories.json");

const {
  createEmployee,
  getCategoryPerformance,
  getEmployeePerformance,
  recordReminder,
  setThreadHandledBy,
  setThreadHumanReplied,
  upsertThreadReceived,
} = await import("../src/db.js");

const now = Date.now();
const sinceIso = new Date(now - 600 * 60_000).toISOString();
const untilIso = new Date(now + 200 * 60_000).toISOString();

// A: repond avant l'echeance -> a l'heure.
upsertThreadReceived({
  threadId: "perf-a",
  subject: "Devis A",
  senderEmail: "a@example.com",
  senderName: null,
  categoryId: "devis",
  urgency: "normal",
  slaMinutes: 60,
  status: "ack_sent",
  dueAt: new Date(now + 60 * 60_000).toISOString(),
});
setThreadHumanReplied("perf-a", new Date(now + 50 * 60_000).toISOString());

// B: repond 50 min apres l'echeance -> en retard (bucket 30-60min), et a
// necessite un vrai rappel interne (escalade).
upsertThreadReceived({
  threadId: "perf-b",
  subject: "Devis B",
  senderEmail: "b@example.com",
  senderName: null,
  categoryId: "devis",
  urgency: "normal",
  slaMinutes: 30,
  status: "ack_sent",
  dueAt: new Date(now + 30 * 60_000).toISOString(),
});
setThreadHumanReplied("perf-b", new Date(now + 80 * 60_000).toISOString());
recordReminder("perf-b", "internal", "echeance depassee", "relance_interne");

// C: toujours ouvert, echeance deja passee depuis longtemps -> en retard
// (bucket 4h+), jamais repondu.
upsertThreadReceived({
  threadId: "perf-c",
  subject: "Devis C",
  senderEmail: "c@example.com",
  senderName: null,
  categoryId: "devis",
  urgency: "normal",
  slaMinutes: 60,
  status: "ack_sent",
  dueAt: new Date(now - 400 * 60_000).toISOString(),
});

// D: classe "sans suite requise" (spam/newsletter typiquement) -> doit etre
// exclu du volume, comme getClientPeriodKpis l'exclut deja pour la meme raison.
upsertThreadReceived({
  threadId: "perf-d",
  subject: "Newsletter",
  senderEmail: "d@example.com",
  senderName: null,
  categoryId: "devis",
  urgency: "low",
  slaMinutes: 0,
  status: "skipped",
  dueAt: null,
});

// E: dossier "outbound" (envoi a froid decouvert par discoverOutbound.ts) —
// doit rester exclu du volume/retard (BUG-005/BUG-002: received_at y vaut
// l'heure de decouverte, pas de reception).
upsertThreadReceived({
  threadId: "perf-e",
  subject: "Suivi envoye a froid",
  senderEmail: "e@example.com",
  senderName: null,
  categoryId: "devis",
  urgency: "normal",
  slaMinutes: 60,
  status: "ack_sent",
  dueAt: new Date(now + 60 * 60_000).toISOString(),
  origin: "outbound",
});

test("getCategoryPerformance: volume, a l'heure/en retard vs SLA, buckets et escalades, en excluant skipped/outbound", () => {
  const rows = getCategoryPerformance(sinceIso, untilIso);
  const devis = rows.find((r) => r.categoryId === "devis");
  assert.ok(devis, "categorie devis manquante dans les resultats");

  assert.equal(devis!.received, 3); // A, B, C uniquement — D (skipped) et E (outbound) exclus
  assert.equal(devis!.onTime, 1); // A
  assert.equal(devis!.late, 2); // B, C
  assert.equal(devis!.lateBuckets.under60, 1); // B (~50 min de retard)
  assert.equal(devis!.lateBuckets.over240, 1); // C (~400 min de retard)
  assert.equal(devis!.escalations, 1); // B a recu un vrai rappel interne

  // Moyenne sur A (~50min) et B (~80min) uniquement — C n'a jamais repondu.
  assert.ok(devis!.avgResponseMinutes !== null);
  assert.ok(Math.abs(devis!.avgResponseMinutes! - 65) < 2);
});

test("getEmployeePerformance: regroupe uniquement les dossiers tagues et repondus dans la fenetre", () => {
  const sara = createEmployee("Sara");
  setThreadHandledBy("perf-a", sara.id);
  setThreadHandledBy("perf-b", sara.id);
  // perf-c reste non tague (jamais repondu de toute facon).

  const rows = getEmployeePerformance(sinceIso, untilIso);
  const saraRow = rows.find((r) => r.employeeId === sara.id);
  assert.ok(saraRow, "ligne Sara manquante");

  assert.equal(saraRow!.handled, 2); // A et B
  assert.equal(saraRow!.onTime, 1);
  assert.equal(saraRow!.late, 1);
  assert.ok(Math.abs(saraRow!.avgResponseMinutes! - 65) < 2);
});
