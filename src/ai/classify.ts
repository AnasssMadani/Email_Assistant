import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { CLAUDE_MODEL, getClient } from "./client.js";
import { recordUsage, withRetry } from "./structured.js";
import { config } from "../config.js";
import { createCategoryFromAi, listCategories } from "../db.js";
import { formatSingleMessage } from "./prompts.js";
import type { ClassificationResult, EmailMessage, EmailThread } from "../types.js";

/**
 * Valeur speciale de categoryId: "aucune categorie existante ne convient,
 * en voici une nouvelle" (libelle + description dans newCategoryLabel /
 * newCategoryDescription). Jamais stockee telle quelle: classifyEmail la
 * remplace par l'id de la categorie creee, ou par "autre".
 */
export const NEW_CATEGORY_ID = "nouvelle_categorie";
const FALLBACK_CATEGORY_ID = "autre";

const classificationSchema = z.object({
  categoryId: z.string().min(1),
  urgency: z.enum(["low", "normal", "high"]),
  summary: z.string().min(1),
  requiresAcknowledgement: z.boolean(),
  newCategoryLabel: z.string().optional(),
  newCategoryDescription: z.string().optional(),
});

type RawClassification = z.infer<typeof classificationSchema>;

export async function classifyEmail(
  thread: EmailThread,
  incoming: EmailMessage
): Promise<ClassificationResult> {
  const raw = await withRetry(() => classifyEmailOnce(thread, incoming), "classification");
  return resolveCategory(raw);
}

/**
 * Hors de withRetry: la creation de categorie ne doit avoir lieu qu'une
 * fois, sur la reponse finale. Toute impossibilite (libelle vide,
 * plafond journalier atteint, creation desactivee) retombe sur "autre" —
 * jamais d'echec de classification pour ce motif.
 */
async function resolveCategory(raw: RawClassification): Promise<ClassificationResult> {
  const { newCategoryLabel, newCategoryDescription, ...base } = raw;
  if (base.categoryId !== NEW_CATEGORY_ID) return base;

  const label = cleanText(newCategoryLabel, 60);
  if (!label || config.aiCategoriesMaxPerDay <= 0) return { ...base, categoryId: FALLBACK_CATEGORY_ID };

  const result = await createCategoryFromAi({
    label,
    description: cleanText(newCategoryDescription, 300),
    maxPerDay: config.aiCategoriesMaxPerDay,
  });
  if (!result) return { ...base, categoryId: FALLBACK_CATEGORY_ID };
  return {
    ...base,
    categoryId: result.category.id,
    ...(result.created ? { createdCategory: { id: result.category.id, label: result.category.label } } : {}),
  };
}

function cleanText(value: string | undefined, maxLength: number): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength).trim();
}

async function classifyEmailOnce(thread: EmailThread, incoming: EmailMessage): Promise<RawClassification> {
  const client = getClient();
  const categories = await listCategories();
  const categoryList = categories
    .map((c) => `- ${c.id}: ${c.label}${c.description ? ` — ${c.description}` : ""}`)
    .join("\n");
  const canCreateCategory = config.aiCategoriesMaxPerDay > 0;

  const tool: Anthropic.Tool = {
    name: "classify_email",
    description: "Classifie un email entrant pour determiner son traitement automatique.",
    input_schema: {
      type: "object",
      properties: {
        categoryId: {
          type: "string",
          enum: [...categories.map((c) => c.id), ...(canCreateCategory ? [NEW_CATEGORY_ID] : [])],
        },
        urgency: { type: "string", enum: ["low", "normal", "high"] },
        summary: {
          type: "string",
          description: "Resume en une phrase, en francais, de ce que demande l'expediteur.",
        },
        requiresAcknowledgement: {
          type: "boolean",
          description: "Faux pour le spam, les newsletters, ou les communications internes.",
        },
        ...(canCreateCategory
          ? {
              newCategoryLabel: {
                type: "string",
                description: `Seulement si categoryId = '${NEW_CATEGORY_ID}': libelle court et generique en francais (2 a 4 mots), valable pour d'autres emails du meme type.`,
              },
              newCategoryDescription: {
                type: "string",
                description: `Seulement si categoryId = '${NEW_CATEGORY_ID}': une phrase decrivant quels emails relevent de cette categorie.`,
              },
            }
          : {}),
      },
      required: ["categoryId", "urgency", "summary", "requiresAcknowledgement"],
    },
  };

  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 512,
    system: [
      "Tu classifies les emails entrants d'une boite de contact professionnelle.",
      "Categories disponibles:",
      categoryList,
      "",
      "Choisis la categorie la plus proche du contenu reel du message. En cas de doute,",
      "utilise 'autre'. Un email qui n'appelle aucune reponse (spam, newsletter,",
      "notification automatique, communication interne) doit avoir requiresAcknowledgement=false.",
      ...(canCreateCategory
        ? [
            "",
            `Si et seulement si AUCUNE categorie ne convient ET que l'email represente un type de demande`,
            `metier recurrent (pas un cas isole, pas du spam ni une notification), choisis '${NEW_CATEGORY_ID}'`,
            "et renseigne newCategoryLabel et newCategoryDescription. Ne cree jamais une categorie proche",
            "d'une categorie existante: choisis alors celle-ci.",
          ]
        : []),
    ].join("\n"),
    tools: [tool],
    tool_choice: { type: "tool", name: "classify_email" },
    messages: [{ role: "user", content: formatSingleMessage(incoming) }],
  });
  await recordUsage("classification", thread.id, response.usage);

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
  );
  if (!toolUse) {
    throw new Error("Claude n'a pas retourne de classification structuree.");
  }
  return classificationSchema.parse(toolUse.input);
}
