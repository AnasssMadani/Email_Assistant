import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { CLAUDE_MODEL, getClient } from "./client.js";
import { recordUsage, withRetry } from "./structured.js";
import { loadBrandVoice } from "../config.js";
import { formatThreadContext, LANGUAGE_INSTRUCTION } from "./prompts.js";
import type { CategoryConfig, EmailMessage, EmailThread, ReplyDraft } from "../types.js";

const replyDraftSchema = z.object({
  variant: z.enum(["A", "B", "C"]),
  label: z.string().min(1),
  subject: z.string().min(1),
  body: z.string().min(1),
});

// Exactement 3: un tableau tronque ou mal forme (max_tokens atteint en cours
// de generation, par ex.) doit echouer la validation plutot que produire
// moins de brouillons que promis, ou un brouillon au contenu incomplet.
//
// Claude retourne parfois "drafts" comme une chaine JSON serialisee plutot
// que comme un tableau natif dans tool_use.input — quirk connu de l'API sur
// des schemas avec un tableau d'objets imbriques. Observe en production:
// echec systematique sur les deux tentatives de withRetry (donc pas un
// hasard ponctuel), qui privait le dossier de ses 3 brouillons alors que
// Claude avait bien produit un contenu exploitable, juste mal encode. On
// tente donc un JSON.parse() avant validation si la valeur recue est une
// chaine; si ce n'est pas du JSON valide, la validation echoue normalement
// et withRetry reste le filet de securite.
export const repliesSchema = z.object({
  drafts: z.preprocess((value) => {
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }, z.array(replyDraftSchema).length(3)),
});

export async function draftThreeReplies(
  thread: EmailThread,
  incoming: EmailMessage,
  category: CategoryConfig
): Promise<ReplyDraft[]> {
  return withRetry(() => draftThreeRepliesOnce(thread, incoming, category), "3 brouillons de réponse");
}

async function draftThreeRepliesOnce(
  thread: EmailThread,
  incoming: EmailMessage,
  category: CategoryConfig
): Promise<ReplyDraft[]> {
  const client = getClient();
  const brandVoice = loadBrandVoice();

  const tool: Anthropic.Tool = {
    name: "propose_replies",
    description: "Propose trois brouillons de reponse distincts pour un email client.",
    input_schema: {
      type: "object",
      properties: {
        drafts: {
          type: "array",
          minItems: 3,
          maxItems: 3,
          items: {
            type: "object",
            properties: {
              variant: { type: "string", enum: ["A", "B", "C"] },
              label: {
                type: "string",
                description: "Nom court de l'approche, ex: 'Reponse detaillee'.",
              },
              subject: { type: "string" },
              body: { type: "string" },
            },
            required: ["variant", "label", "subject", "body"],
          },
        },
      },
      required: ["drafts"],
    },
  };

  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 3200,
    system: [
      `Tu rediges des propositions de reponse au nom d'une entreprise,`,
      `pour un email de categorie "${category.label}".`,
      "",
      LANGUAGE_INSTRUCTION,
      "",
      brandVoice,
      "",
      "Genere exactement 3 brouillons distincts, destines a un humain qui choisira et",
      "enverra l'un des trois depuis sa messagerie:",
      "- Variante A: reponse complete et detaillee, qui traite tous les points souleves.",
      "- Variante B: reponse courte et directe, qui va a l'essentiel.",
      "- Variante C: reponse orientee relation client, qui met l'accent sur",
      "  l'accompagnement et pose une question de clarification si le besoin reel",
      "  n'est pas totalement explicite.",
      "",
      "Chaque brouillon doit etre utilisable tel quel: pas d'en-tete 'Objet:' dans le",
      "corps, pas de mention d'IA, pas de placeholder sauf si une information est",
      "reellement manquante pour repondre correctement.",
    ].join("\n"),
    tools: [tool],
    tool_choice: { type: "tool", name: "propose_replies" },
    messages: [{ role: "user", content: formatThreadContext(thread, incoming) }],
  });
  recordUsage("brouillons_reponse", thread.id, response.usage);

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
  );
  if (!toolUse) {
    throw new Error("Claude n'a pas retourne de brouillons structures.");
  }
  return repliesSchema.parse(toolUse.input).drafts;
}
