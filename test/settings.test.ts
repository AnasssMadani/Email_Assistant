import "./_settingsEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { getCategory } from "../src/settings.js";
import { listCategories } from "../src/db.js";

test("getCategory resolves a known category from the seeded DB", () => {
  const category = getCategory("devis");
  assert.equal(category.id, "devis");
  assert.equal(category.label, "Demande de devis");
});

test("getCategory falls back to 'autre' for an unknown id", () => {
  const category = getCategory("ceci-nexiste-pas");
  assert.equal(category.id, "autre");
});

test("listCategories seeds categories from config/categories.json", () => {
  const categories = listCategories();
  assert.ok(categories.length > 0);
  assert.ok(categories.some((c) => c.id === "autre"));
});

test("seeded internal-alert defaults favor high-stakes categories, stay quiet on high-volume ones", () => {
  const categories = listCategories();
  const byId = new Map(categories.map((c) => [c.id, c]));

  assert.equal(byId.get("reclamation")?.internalAlertsEnabled, true);
  assert.equal(byId.get("reclamation")?.internalAlertsMinUrgency, "low");

  assert.equal(byId.get("devis")?.internalAlertsEnabled, true);
  assert.equal(byId.get("devis")?.internalAlertsMinUrgency, "normal");

  // Categories a fort volume / faible enjeu: pas d'alerte par defaut, pour ne
  // pas noyer la boite de l'equipe sous des rappels pour des demandes banales.
  assert.equal(byId.get("demande_information")?.internalAlertsEnabled, false);
  assert.equal(byId.get("candidature")?.internalAlertsEnabled, false);
  assert.equal(byId.get("autre")?.internalAlertsEnabled, false);
});
