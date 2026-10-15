import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshTestDb } from "./_pgTestDb.js";

process.env.WEB_PORT = "45873";
process.env.SETUP_USERNAME = "";
process.env.SETUP_PASSWORD_HASH = "";
process.env.SETUP_PASSWORD = "";
const db = await freshTestDb();
await import("../src/web/server.js");
await new Promise((r) => setTimeout(r, 300));

const base = "http://127.0.0.1:45873";
const get = async (path: string) => {
  const res = await fetch(base + path);
  return { status: res.status, html: await res.text() };
};

test("the Apprentissage page renders tiles, maturity per category and the import form", async () => {
  const cat = (await db.listCategories())[0];
  await db.recordHumanReplyCorpus({ threadId: "t1", categoryId: cat.id, replyBody: "Bonjour, voici la reponse type de l'equipe pour cette categorie.", source: "manuel", clientAsk: "Une question" });
  const { status, html } = await get("/apprentissage");
  assert.equal(status, 200);
  assert.match(html, /Maturité par catégorie/);
  assert.match(html, /Apprendre de nouveaux fils/);
  assert.match(html, /Réponses apprises/);
  assert.match(html, /action="\/apprentissage\/importer"/);
  assert.match(html, /Une question/);
  assert.match(html, /href="\/apprentissage"/, "sidebar link");
});

test("the Carnet page is light: summary line and no per-email wall", async () => {
  const { status, html } = await get("/carnet");
  assert.equal(status, 200);
  assert.match(html, /email\(s\) reçu\(s\)/);
  assert.doesNotMatch(html, /Corpus des réponses de l'équipe/);
});

after(() => setTimeout(() => process.exit(0), 50));
