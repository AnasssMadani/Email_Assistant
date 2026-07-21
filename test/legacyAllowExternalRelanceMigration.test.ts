import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Regression: the real Render production database predates the current
// categories schema and still carries a legacy `allow_external_relance`
// column (NOT NULL, no default) from a model abandoned since (replaced by
// relance_steps/post_reply_relance_steps). `CREATE TABLE IF NOT EXISTS`
// never touches an existing table, so that constraint survives there. Any
// INSERT INTO categories that omits it — including
// ensurePiloteCarnetCategories() and createCategory() — fails with
// "NOT NULL constraint failed: categories.allow_external_relance". Reproduce
// that exact shape here, then import db.js against it.
const dir = mkdtempSync(path.join(tmpdir(), "accuse-relance-legacy-allow-external-test-"));
const dbPath = path.join(dir, "legacy.db");
process.env.DB_PATH = dbPath;
process.env.CATEGORIES_CONFIG_PATH = path.resolve("config/categories.json");

const legacyDb = new DatabaseSync(dbPath);
legacyDb.exec(`
  CREATE TABLE categories (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    sla_hours REAL NOT NULL,
    sla_minutes REAL,
    acknowledge_automatically INTEGER NOT NULL,
    sort_order INTEGER NOT NULL,
    internal_alerts_enabled INTEGER NOT NULL DEFAULT 1,
    internal_alerts_min_urgency TEXT NOT NULL DEFAULT 'normal',
    allow_external_relance INTEGER NOT NULL
  );
`);
// Une seule categorie preexistante suffit a faire croire a seedIfNeeded()
// que la base est deja peuplee (categoryCount.n > 0) et a sauter sa propre
// insertion — exactement l'etat d'une base de production deja en service.
legacyDb.prepare(
  `INSERT INTO categories (id, label, sla_hours, sla_minutes, acknowledge_automatically, sort_order, allow_external_relance)
   VALUES ('autre', 'Autre / non classifie', 24, 1440, 1, 0, 0)`
).run();
legacyDb.close();

const { createCategory, listCategories } = await import("../src/db.js");

test("ensurePiloteCarnetCategories inserts the 3 new business categories on a pre-migration database with a legacy NOT NULL allow_external_relance column", () => {
  // Insertion deja effectuee au chargement du module ci-dessus (import db.js) —
  // on verifie juste qu'elle n'a pas leve d'exception et a bien cree les lignes.
  const categories = listCategories();
  const ids = categories.map((c) => c.id);
  assert.ok(ids.includes("demande_facture"));
  assert.ok(ids.includes("disponibilite_bad"));
  assert.ok(ids.includes("relance_paiement_soa"));
});

test("createCategory still works on the same legacy database", () => {
  assert.doesNotThrow(() => {
    createCategory({ label: "Test manuel", slaMinutes: 60, acknowledgeAutomatically: true });
  });
  const categories = listCategories();
  assert.ok(categories.some((c) => c.label === "Test manuel"));
});
