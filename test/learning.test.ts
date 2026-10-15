import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { freshTestDb } from "./_pgTestDb.js";

process.env.IMAP_MAILBOX_ADDRESS = "info@oceanlink-global.com";
const db = await freshTestDb();
const { learnFromPastedThreads, undoLearningBatch, learningStatus } = await import("../src/pipeline/learning.js");
const { setClientForTesting } = await import("../src/ai/client.js");

let extraction: unknown = { threads: [] };
let lastSystem = "";
const toolsSeen: string[] = [];
setClientForTesting({
  messages: {
    async create(params: { system: string; tools?: Array<{ name: string }> }) {
      const name = params.tools?.[0]?.name ?? "";
      if (name === "extract_team_replies") lastSystem = params.system;
      toolsSeen.push(name);
      const input = name === "extract_team_replies" ? extraction : { tone: "Vouvoiement, direct.", structure: "Confirme puis demande les documents." };
      return { content: [{ type: "tool_use", input }], usage: { input_tokens: 10, output_tokens: 10 } };
    },
  },
} as unknown as Anthropic);

test("learningStatus: levels depend on example count and on the style note", () => {
  assert.equal(learningStatus(0, false).level, "vide");
  assert.equal(learningStatus(2, false).level, "debut");
  assert.equal(learningStatus(5, false).level, "en_cours");
  assert.match(learningStatus(5, false).hint, /Analyser/);
  assert.equal(learningStatus(12, false).level, "en_cours", "enough examples but no style note yet");
  assert.equal(learningStatus(12, true).level, "pret");
  assert.equal(learningStatus(40, true).progressPct, 100);
});

const reply1 = "Bonjour,\n\nMerci pour votre demande. Veuillez nous envoyer la facture, la packing list et le HS code.\n\nCordialement";
const reply2 = "Bonjour,\n\nLe BL original vous sera remis dès paiement du fret. Cordialement.";

test("pasted threads become tagged corpus examples and refresh the style note of touched categories only", async () => {
  const categories = await db.listCategories();
  const first = categories[0].id;
  extraction = {
    threads: [
      { categoryId: first, clientAsk: "Documents douane", teamReplies: [reply1 + "\n\nDe : client@x.com\nEnvoyé : lundi\nÀ : info@y.com\nObjet : x\nancien"] },
      { categoryId: "categorie-inconnue", clientAsk: "BL", teamReplies: [reply2, "ok"] },
      { categoryId: first, clientAsk: "Rien", teamReplies: [] },
    ],
  };
  const result = await learnFromPastedThreads("fil 1\n---\nfil 2 ...............................", "Younes");
  assert.equal(result.threadsSeen, 3);
  assert.equal(result.repliesLearned, 2, "the one-word reply is ignored");
  assert.ok(result.batchId);
  assert.match(lastSystem, /oceanlink-global\.com/);
  assert.match(lastSystem, /Younes/);

  const stats = await db.listCorpusStats();
  assert.equal(stats.reduce((n, s) => n + s.total, 0), 2);
  assert.ok(stats.every((s) => s.manual === s.total));
  const stored = await db.listHumanReplyCorpusByCategory(first);
  assert.equal(stored[0], reply1, "quoted history is stripped");
  assert.ok((await db.getCategoryPlaybook(first)).includes("Vouvoiement"), "style note generated");

  // Same text again: nothing new.
  const again = await learnFromPastedThreads("fil 1 ..........................................", "");
  assert.equal(again.repliesLearned, 0);
  assert.equal(again.duplicatesSkipped, 2);
  assert.equal(again.batchId, null);

  // Undo removes the examples and the style notes that no longer have any basis.
  await undoLearningBatch(result.batchId as string);
  assert.equal((await db.listCorpusStats()).length, 0);
  assert.equal(await db.getCategoryPlaybook(first), "");
});
