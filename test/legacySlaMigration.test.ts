import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Same failure shape as legacySchemaMigration.test.ts, for a different column:
// categories.sla_hours and threads.sla_hours predate sla_minutes and are NOT NULL
// on any database created before this migration. Reproduce that exact schema and
// confirm updateCategory/createCategory/upsertThreadReceived never violate it.
const dir = mkdtempSync(path.join(tmpdir(), "accuse-relance-legacy-sla-test-"));
const dbPath = path.join(dir, "legacy-sla.db");
process.env.DB_PATH = dbPath;
process.env.CATEGORIES_CONFIG_PATH = path.resolve("config/categories.json");

const legacyDb = new DatabaseSync(dbPath);
legacyDb.exec(`
  CREATE TABLE categories (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    sla_hours REAL NOT NULL,
    acknowledge_automatically INTEGER NOT NULL,
    sort_order INTEGER NOT NULL
  );
  CREATE TABLE threads (
    thread_id TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    sender_email TEXT NOT NULL,
    sender_name TEXT,
    category_id TEXT NOT NULL,
    urgency TEXT NOT NULL,
    sla_hours REAL NOT NULL,
    status TEXT NOT NULL,
    received_at TEXT NOT NULL,
    ack_sent_at TEXT,
    due_at TEXT,
    last_relance_at TEXT,
    relance_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);
legacyDb.prepare(
  `INSERT INTO categories (id, label, sla_hours, acknowledge_automatically, sort_order) VALUES (?, ?, ?, ?, ?)`
).run("devis", "Demande de devis", 24, 1, 0);
legacyDb.close();

const { updateCategory, createCategory, upsertThreadReceived, listCategories, getThreadRow } = await import(
  "../src/db.js"
);

test("updating a category's SLA on a pre-migration database does not violate sla_hours NOT NULL", () => {
  assert.doesNotThrow(() => {
    updateCategory("devis", {
      label: "Demande de devis",
      slaMinutes: 90,
      acknowledgeAutomatically: true,
      internalAlertsEnabled: true,
      internalAlertsMinUrgency: "normal",
    });
  });
  const updated = listCategories().find((c) => c.id === "devis");
  assert.equal(updated?.slaMinutes, 90);
});

test("creating a category on a pre-migration database does not violate sla_hours NOT NULL", () => {
  assert.doesNotThrow(() => {
    createCategory({ label: "Test rapide", slaMinutes: 5, acknowledgeAutomatically: true });
  });
});

test("upserting a thread on a pre-migration database does not violate sla_hours NOT NULL", () => {
  assert.doesNotThrow(() => {
    upsertThreadReceived({
      threadId: "legacy-thread-1",
      subject: "Test",
      senderEmail: "a@example.com",
      senderName: null,
      categoryId: "devis",
      urgency: "normal",
      slaMinutes: 120,
      status: "received",
      dueAt: new Date().toISOString(),
    });
  });
  const row = getThreadRow("legacy-thread-1");
  assert.equal(row?.sla_minutes, 120);
});
