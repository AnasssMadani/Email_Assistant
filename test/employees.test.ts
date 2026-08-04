import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "employees-test-"));
process.env.DB_PATH = path.join(dir, "employees.db");
process.env.CATEGORIES_CONFIG_PATH = path.resolve("config/categories.json");

const { createEmployee, listEmployees, setEmployeeActive, setThreadHandledBy, upsertThreadReceived, getThreadRow } =
  await import("../src/db.js");

test("createEmployee then listEmployees returns it, active by default", () => {
  const emp = createEmployee("Sara");
  assert.equal(emp.name, "Sara");
  assert.equal(emp.active, true);

  const active = listEmployees();
  assert.ok(active.some((e) => e.id === emp.id && e.name === "Sara"));
});

test("setEmployeeActive(false) hides an employee from the default (active-only) list but keeps them with includeInactive", () => {
  const emp = createEmployee("Youssef");
  setEmployeeActive(emp.id, false);

  assert.ok(!listEmployees().some((e) => e.id === emp.id));
  const all = listEmployees(true);
  const found = all.find((e) => e.id === emp.id);
  assert.ok(found);
  assert.equal(found?.active, false);
  assert.equal(found?.name, "Youssef"); // le nom reste lisible sur l'historique
});

test("setThreadHandledBy tags a dossier with an employee, and null clears it", () => {
  const emp = createEmployee("Amine");
  const threadId = "t-handled-by";
  upsertThreadReceived({
    threadId,
    subject: "Devis conteneur",
    senderEmail: "client@example.com",
    senderName: null,
    categoryId: "devis",
    urgency: "normal",
    slaMinutes: 60,
    status: "ack_sent",
    dueAt: new Date().toISOString(),
  });

  setThreadHandledBy(threadId, emp.id);
  assert.equal(getThreadRow(threadId)?.handled_by_employee_id, emp.id);

  setThreadHandledBy(threadId, null);
  assert.equal(getThreadRow(threadId)?.handled_by_employee_id, null);
});
