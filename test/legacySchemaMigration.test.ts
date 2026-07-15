import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Databases created before the hours->minutes migration have relance_steps.delay_hours
// defined NOT NULL (the original column, before delay_minutes existed). `CREATE TABLE IF
// NOT EXISTS` never touches an existing table, so that constraint survives on any
// pre-migration database. Reproduce that exact shape here, then import db.js against it —
// this is what a real production database looked like when "NOT NULL constraint failed:
// relance_steps.delay_hours" started firing on every add/delete of a category relance step.
const dir = mkdtempSync(path.join(tmpdir(), "accuse-relance-legacy-schema-test-"));
const dbPath = path.join(dir, "legacy.db");
process.env.DB_PATH = dbPath;
process.env.CATEGORIES_CONFIG_PATH = path.resolve("config/categories.json");

const legacyDb = new DatabaseSync(dbPath);
legacyDb.exec(`
  CREATE TABLE relance_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_type TEXT NOT NULL CHECK (owner_type IN ('category', 'thread')),
    owner_id TEXT NOT NULL,
    step_order INTEGER NOT NULL,
    channel TEXT NOT NULL CHECK (channel IN ('internal', 'external')),
    delay_hours REAL NOT NULL,
    UNIQUE(owner_type, owner_id, step_order)
  );
`);
legacyDb.prepare(
  `INSERT INTO relance_steps (owner_type, owner_id, step_order, channel, delay_hours) VALUES (?, ?, ?, ?, ?)`
).run("category", "devis", 1, "internal", 24);
legacyDb.close();

const { addCategoryRelanceStep, deleteCategoryRelanceStep, getCategoryRelanceSteps } = await import(
  "../src/db.js"
);

test("adding a category relance step on a pre-migration database does not violate delay_hours NOT NULL", () => {
  assert.doesNotThrow(() => {
    addCategoryRelanceStep("devis", { channel: "external", delayMinutes: 90 }, "pre_reply");
  });
  const steps = getCategoryRelanceSteps("devis", "pre_reply");
  assert.ok(steps.some((s) => s.delayMinutes === 90));
});

test("deleting a category relance step on a pre-migration database does not violate delay_hours NOT NULL", () => {
  const before = getCategoryRelanceSteps("devis", "pre_reply");
  assert.doesNotThrow(() => {
    deleteCategoryRelanceStep("devis", before[0].order, "pre_reply");
  });
});
