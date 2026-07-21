import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { CLAUDE_MODEL, getClient } from "./client.js";
import { recordUsage, withRetry } from "./structured.js";
import { LANGUAGE_INSTRUCTION } from "./prompts.js";

export interface CorpusAnalysis {
  tone: string;
  structure: string;
}

const analysisSchema = z.object({
  tone: z.string().min(1),
  structure: z.string().min(1),
});

/**
 * Releit un corpus de vraies reponses envoyees par l'equipe pour UNE
 * categorie et en extrait le ton reellement employe et les elements/
 * structure typiques d'une reponse (ce qu'elle demande, confirme, joint...).
 * Ce n'est pas un fine-tuning: le resultat est une note de style textuelle,
 * relue par le prompt de redaction de l'accuse (voir draftAcknowledgement.ts)
 * — pas un entrainement de modele.
 */
export async function analyzeCategoryCorpus(categoryLabel: string, replies: string[]): Promise<CorpusAnalysis> {
  return withRetry(() => analyzeCategoryCorpusOnce(categoryLabel, replies), "analyse du corpus");
}

async function analyzeCategoryCorpusOnce(categoryLabel: string, replies: string[]): Promise<CorpusAnalysis> {
  const client = getClient();

  const tool: Anthropic.Tool = {
    name: "analyze_reply_corpus",
    description: "Extrait le ton et la structure typiques d'un ensemble de reponses reelles.",
    input_schema: {
      type: "object",
      properties: {
        tone: { type: "string" },
        structure: { type: "string" },
      },
      required: ["tone", "structure"],
    },
  };

  const examplesBlock = replies
    .map((body, i) => `--- Exemple ${i + 1} ---\n${body.slice(0, 3000)}`)
    .join("\n\n");

  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 900,
    system: [
      "Tu analyses des exemples reels de reponses envoyees par une equipe a ses clients,",
      `pour la categorie de demande "${categoryLabel}".`,
      "",
      LANGUAGE_INSTRUCTION,
      "",
      "A partir de CES exemples uniquement (n'invente rien qui n'y figure pas):",
      "- tone: decris le ton reellement employe (niveau de formalisme, vouvoiement/tutoiement,",
      "  longueur des phrases, formules recurrentes).",
      "- structure: decris les elements/la structure typiques d'une reponse pour cette",
      "  categorie (ce qu'elle demande, ce qu'elle confirme, ce qu'elle joint, dans quel ordre).",
      "Reponds en francais, sous forme de note de style courte et actionnable — pas un resume",
      "des exemples eux-memes.",
    ].join("\n"),
    tools: [tool],
    tool_choice: { type: "tool", name: "analyze_reply_corpus" },
    messages: [{ role: "user", content: examplesBlock }],
  });
  recordUsage("analyse_corpus", null, response.usage);

  const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!toolUse) {
    throw new Error("Claude n'a pas retourne d'analyse de corpus structuree.");
  }
  return analysisSchema.parse(toolUse.input);
}
