import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { freshTestDb } from "./_pgTestDb.js";
import type { EmailMessage } from "../src/types.js";

process.env.AI_CATEGORIES_MAX_PER_DAY = "2";

const { getCategoryRelanceSteps, listCategories } = await freshTestDb();
const { classifyEmail, NEW_CATEGORY_ID } = await import("../src/ai/classify.js");
const { setClientForTesting } = await import("../src/ai/client.js");

let nextAnswer: Record<string, unknown> = {};
let lastSystemPrompt = "";
setClientForTesting({
  messages: {
    async create(params: { system: string }) {
      lastSystemPrompt = params.system;
      return {
        content: [{ type: "tool_use", input: nextAnswer }],
        usage: { input_tokens: 10, output_tokens: 10 },
      };
    },
  },
} as unknown as Anthropic);

const message: EmailMessage = {
  id: "m-1",
  threadId: "t-1",
  from: { email: "agent@example.com" },
  to: [{ email: "us@example.com" }],
  subject: "Demande de booking conteneur",
  bodyText: "Merci de réserver un 40HC...",
  receivedAt: new Date(),
  isFromUs: false,
  hasAttachments: false,
};

function answer(overrides: Record<string, unknown>) {
  nextAnswer = { categoryId: NEW_CATEGORY_ID, urgency: "normal", summary: "Booking.", requiresAcknowledgement: true, ...overrides };
}

test("when no category fits, classification creates one that behaves exactly like the fallback category", async () => {
  answer({ newCategoryLabel: "  Réservation  de conteneur ", newCategoryDescription: "Demandes de booking de conteneurs." });
  const result = await classifyEmail({ id: "t-1", messages: [message] }, message);

  assert.equal(result.categoryId, "reservation_de_conteneur");
  assert.deepEqual(result.createdCategory, { id: "reservation_de_conteneur", label: "Réservation de conteneur" });

  const categories = await listCategories();
  const created = categories.find((c) => c.id === "reservation_de_conteneur")!;
  const fallback = categories.find((c) => c.id === "autre")!;
  assert.equal(created.createdByAi, true);
  assert.equal(created.description, "Demandes de booking de conteneurs.");
  assert.equal(created.slaMinutes, fallback.slaMinutes);
  assert.equal(created.acknowledgeAutomatically, fallback.acknowledgeAutomatically);
  assert.equal(created.internalAlertsEnabled, fallback.internalAlertsEnabled);
  assert.equal(created.internalAlertsMinUrgency, fallback.internalAlertsMinUrgency);
  for (const phase of ["pre_reply", "post_reply"] as const) {
    assert.deepEqual(
      (await getCategoryRelanceSteps(created.id, phase)).map((s) => [s.channel, s.delayMinutes]),
      (await getCategoryRelanceSteps("autre", phase)).map((s) => [s.channel, s.delayMinutes])
    );
  }

  // La description est reprise dans le prompt suivant, pour que la
  // classification y range les emails similaires au lieu d'en recreer une.
  answer({ categoryId: "reservation_de_conteneur" });
  await classifyEmail({ id: "t-1", messages: [message] }, message);
  assert.match(lastSystemPrompt, /reservation_de_conteneur: Réservation de conteneur — Demandes de booking de conteneurs\./);
});

test("proposing a label that already exists reuses that category instead of duplicating it", async () => {
  const before = (await listCategories()).length;
  answer({ newCategoryLabel: "Demande de devis" });
  const result = await classifyEmail({ id: "t-1", messages: [message] }, message);
  assert.equal(result.categoryId, "devis");
  assert.equal(result.createdCategory, undefined);
  assert.equal((await listCategories()).length, before);
});

test("a missing label, or the daily cap, falls back to 'autre' without failing", async () => {
  answer({ newCategoryLabel: "   " });
  assert.equal((await classifyEmail({ id: "t-1", messages: [message] }, message)).categoryId, "autre");

  // Cap = 2 sur 24h: une creation deja faite au premier test, une de plus passe...
  answer({ newCategoryLabel: "Litige douanier" });
  assert.equal((await classifyEmail({ id: "t-1", messages: [message] }, message)).categoryId, "litige_douanier");
  // ...la suivante retombe sur la categorie de repli.
  answer({ newCategoryLabel: "Demande de partenariat" });
  const capped = await classifyEmail({ id: "t-1", messages: [message] }, message);
  assert.equal(capped.categoryId, "autre");
  assert.equal(capped.createdCategory, undefined);
  assert.ok(!(await listCategories()).some((c) => c.label === "Demande de partenariat"));
});
