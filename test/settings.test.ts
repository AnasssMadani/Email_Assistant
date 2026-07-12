import "./_settingsEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { getCategory, loadCategories } from "../src/settings.js";

test("getCategory resolves a known category from the seeded DB", () => {
  const category = getCategory("devis");
  assert.equal(category.id, "devis");
  assert.equal(category.label, "Demande de devis");
});

test("getCategory falls back to 'autre' for an unknown id", () => {
  const category = getCategory("ceci-nexiste-pas");
  assert.equal(category.id, "autre");
});

test("loadCategories seeds categories and relance settings from config/categories.json", () => {
  const { categories, relance } = loadCategories();
  assert.ok(categories.length > 0);
  assert.ok(categories.some((c) => c.id === "autre"));
  assert.equal(relance.maxRelances, 2);
  assert.equal(relance.internalReminderAfterHours, 24);
});
