import { test } from "node:test";
import assert from "node:assert/strict";
import { freshTestDb } from "./_pgTestDb.js";

// Deploiement verrouille (ex: globallink-dev): l'ancien SHADOW_MODE=true
// reste honore comme MAX_STAGE=0, quoi qu'on choisisse dans /etape.
process.env.SHADOW_MODE = "true";

const { setStoredStage } = await freshTestDb();
const { changeStage, getStage, isSendAllowed } = await import("../src/stage.js");

test("legacy SHADOW_MODE=true caps the effective stage at 0 even if the database says otherwise", async () => {
  await setStoredStage(1);
  assert.equal(await getStage(), 0);
  assert.equal(await isSendAllowed("accuse"), false);
  await assert.rejects(() => changeStage(1), /verrouillé/);
});
