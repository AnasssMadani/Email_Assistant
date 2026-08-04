import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Regression: syncCarnetRappelDelay used to run on EVERY startup and force
// the 6 carnet business categories' pre_reply sequence back to a single
// 30-min rappel interne step, silently erasing anything an admin had added
// from /reglages (e.g. a client-facing "sorry for the delay" step). Fixed by
// moving the initial 30-min seed into ensurePiloteCarnetCategories, which
// only ever runs once (guarded by "disponibilite_bad already exists?").
const dir = mkdtempSync(path.join(tmpdir(), "carnet-persist-test-"));
process.env.DB_PATH = path.join(dir, "carnet-persist.db");
process.env.CATEGORIES_CONFIG_PATH = path.resolve("config/categories.json");

const { getCategoryRelanceSteps, addCategoryRelanceStep } = await import("../src/db.js");

test("a manually added pre_reply step for a carnet business category survives a simulated server restart", async () => {
  const initial = getCategoryRelanceSteps("devis", "pre_reply");
  assert.equal(initial.length, 1); // amorce initiale unique: un seul rappel a 30 min

  // Ce qu'un admin ferait depuis /reglages: ajouter une 2e etape (ex: relance
  // externe d'excuse) a la sequence pre_reply de "devis".
  addCategoryRelanceStep("devis", { channel: "external", delayMinutes: 60 }, "pre_reply");
  assert.equal(getCategoryRelanceSteps("devis", "pre_reply").length, 2);

  // Simule un redemarrage du serveur: reimporte src/db.ts comme un tout
  // nouveau module (le suffixe de requete contourne le cache ESM), dont les
  // effets de bord d'initialisation tournent a nouveau contre la MEME base
  // sur disque, exactement comme au demarrage reel du processus.
  const fresh = (await import(`../src/db.js?restart=${Date.now()}`)) as typeof import("../src/db.js");

  const afterRestart = fresh.getCategoryRelanceSteps("devis", "pre_reply");
  assert.equal(afterRestart.length, 2);
  assert.equal(afterRestart[1].channel, "external");
  assert.equal(afterRestart[1].delayMinutes, 60);
});
