import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "client-period-kpis-test-"));
process.env.DB_PATH = path.join(dir, "client-period-kpis.db");
process.env.CATEGORIES_CONFIG_PATH = path.resolve("config/categories.json");

const {
  getClientCategoryShare,
  getClientPeriodKpis,
  getClientVolumeSeries,
  listCategories,
  setThreadHumanReplied,
  upsertThreadReceived,
} = await import("../src/db.js");

// Doit tourner en premier: les tests suivants ajoutent aussi des dossiers
// "devis", ce qui fausserait la repartition en % attendue ici (tests dans
// un meme fichier partagent la meme base — voir DB_PATH ci-dessus).
test("getClientCategoryShare: percentages sorted by volume, beyond the top 5 folded into Autre", () => {
  const counts: Array<[string, number]> = [
    ["devis", 6],
    ["reclamation", 5],
    ["suivi_dossier", 4],
    ["candidature", 3],
    ["demande_information", 2],
    ["autre", 1],
  ];
  let n = 0;
  for (const [categoryId, count] of counts) {
    for (let i = 0; i < count; i++) {
      upsertThreadReceived({
        threadId: `share-${categoryId}-${i}`,
        subject: `Sujet ${n++}`,
        senderEmail: "x@example.com",
        senderName: null,
        categoryId,
        urgency: "normal",
        slaMinutes: 60,
        status: "ack_sent",
        dueAt: null,
      });
    }
  }

  const labels = new Map(listCategories().map((c) => [c.id, c.label]));
  const shares = getClientCategoryShare(7);

  assert.equal(shares.length, 6); // top 5 + "Autre"
  assert.equal(shares[0].label, labels.get("devis"));
  assert.equal(shares[0].pct, 29); // round(6/21*100)
  const autre = shares.find((s) => s.label === "Autre");
  assert.ok(autre);
  assert.equal(autre!.pct, 5); // round(1/21*100) — la categorie "autre" seule, hors top 5
});

test("getClientPeriodKpis: on-time/late split vs SLA, no delta when there's no prior-period data", () => {
  // Ecart avant/apres plutot qu'un total absolu: robuste face aux dossiers
  // deja inseres par le test precedent (meme base partagee, voir DB_PATH).
  const before = getClientPeriodKpis(7);
  const now = Date.now();

  // A: repond avant l'echeance -> a l'heure.
  upsertThreadReceived({
    threadId: "kpi-a",
    subject: "A",
    senderEmail: "a@example.com",
    senderName: null,
    categoryId: "devis",
    urgency: "normal",
    slaMinutes: 60,
    status: "ack_sent",
    dueAt: new Date(now + 60 * 60_000).toISOString(),
  });
  setThreadHumanReplied("kpi-a", new Date(now + 30 * 60_000).toISOString());

  // B: repond 20 min apres l'echeance -> en retard.
  upsertThreadReceived({
    threadId: "kpi-b",
    subject: "B",
    senderEmail: "b@example.com",
    senderName: null,
    categoryId: "devis",
    urgency: "normal",
    slaMinutes: 10,
    status: "ack_sent",
    dueAt: new Date(now + 10 * 60_000).toISOString(),
  });
  setThreadHumanReplied("kpi-b", new Date(now + 30 * 60_000).toISOString());

  const kpis = getClientPeriodKpis(7);
  // Les dossiers deja presents (test precedent) n'ont ni due_at ni reponse:
  // ils ne bougent que "processed", jamais le ratio a l'heure/en retard ni
  // le delai moyen de reponse, tous les deux calcules seulement sur A et B.
  assert.equal(kpis.processed, before.processed + 2);
  assert.equal(kpis.slaPct, 50); // 1 a l'heure / 2 mesurables
  assert.equal(kpis.avgResponseMinutes, 30); // seuls A et B ont une reponse enregistree
  // Rien recu dans la fenetre precedente (base de test isolee, fraiche) —
  // jamais de delta invente a partir d'une absence de donnees.
  assert.equal(kpis.deltaProcessedPct, null);
  assert.equal(kpis.deltaSlaPts, null);
  assert.equal(kpis.deltaResponseMinutes, null);
});

test("getClientVolumeSeries(7) buckets today's dossiers into the last (today) point, nothing in the others", () => {
  const before = getClientVolumeSeries(7);
  upsertThreadReceived({
    threadId: "vol-1",
    subject: "A",
    senderEmail: "a@example.com",
    senderName: null,
    categoryId: "devis",
    urgency: "normal",
    slaMinutes: 60,
    status: "ack_sent",
    dueAt: null,
  });
  upsertThreadReceived({
    threadId: "vol-2",
    subject: "B",
    senderEmail: "b@example.com",
    senderName: null,
    categoryId: "devis",
    urgency: "normal",
    slaMinutes: 60,
    status: "ack_sent",
    dueAt: null,
  });

  const series = getClientVolumeSeries(7);
  assert.equal(series.length, 7);
  assert.equal(series[6].value, before[6].value + 2); // aujourd'hui = dernier point
  for (let i = 0; i < 6; i++) {
    assert.equal(series[i].value, before[i].value); // les jours precedents n'ont pas bouge
  }
});
