import { test } from "node:test";
import assert from "node:assert/strict";
import { freshTestDb } from "./_pgTestDb.js";

// Pas de plafond d'environnement ici (voir stageLock.test.ts pour MAX_STAGE).
process.env.SHADOW_MODE = "false";
process.env.MAX_STAGE = "3";

const { listStageChanges, setStoredStage } = await freshTestDb();
const { changeStage, getStage, isSendAllowed } = await import("../src/stage.js");

test("stage 0 blocks every send; each send kind opens at its own stage", async () => {
  await setStoredStage(0);
  for (const action of ["accuse", "relance_externe", "rappel_interne", "rapport_matin", "brouillon", "reponse_directe"] as const) {
    assert.equal(await isSendAllowed(action), false, action);
  }

  await setStoredStage(1);
  assert.equal(await isSendAllowed("accuse"), true);
  assert.equal(await isSendAllowed("relance_externe"), true);
  assert.equal(await isSendAllowed("rappel_interne"), true);
  assert.equal(await isSendAllowed("rapport_matin"), true);
  assert.equal(await isSendAllowed("brouillon"), false);
  assert.equal(await isSendAllowed("reponse_directe"), false);

  await setStoredStage(2);
  assert.equal(await isSendAllowed("brouillon"), true);
  assert.equal(await isSendAllowed("reponse_directe"), false);

  await setStoredStage(3);
  assert.equal(await isSendAllowed("reponse_directe"), true);
  await setStoredStage(0);
});

test("an unreadable stored value fails closed to stage 0", async () => {
  await setStoredStage(7);
  assert.equal(await getStage(), 0);
  assert.equal(await isSendAllowed("accuse"), false);
  await setStoredStage(0);
});

test("changeStage climbs one stage at a time but can drop straight back to 0", async () => {
  await setStoredStage(0);
  await assert.rejects(() => changeStage(2), /une étape à la fois/);
  assert.equal(await getStage(), 0);

  await changeStage(1);
  await changeStage(2);
  await changeStage(3);
  assert.equal(await getStage(), 3);

  await changeStage(0);
  assert.equal(await getStage(), 0);

  const history = await listStageChanges(10);
  assert.deepEqual(
    history.slice(0, 4).map((h) => [h.from_stage, h.to_stage]),
    [
      [3, 0],
      [2, 3],
      [1, 2],
      [0, 1],
    ]
  );
});
