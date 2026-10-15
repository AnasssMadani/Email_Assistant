import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { CLAUDE_MODEL, getClient } from "./client.js";
import { recordUsage, withRetry } from "./structured.js";

export interface ExtractedThread {
  categoryId: string;
  /** La demande du client a laquelle l'equipe repondait, en une phrase. */
  clientAsk: string;
  /** Les reponses ecrites par l'equipe, sans citation de l'historique ni signature automatique. */
  teamReplies: string[];
}

const extractionSchema = z.object({
  threads: z.array(
    z.object({
      categoryId: z.string().min(1),
      clientAsk: z.string(),
      teamReplies: z.array(z.string()),
    })
  ),
});

/** Taille maximale de texte collé acceptée en une fois (≈ 30 000 jetons). */
export const MAX_PASTED_CHARS = 120_000;

/**
 * Lit des fils d'emails colles a la main et en extrait ce que l'EQUIPE a
 * ecrit. Le texte n'a aucune metadonnee: c'est l'IA qui repere qui est
 * l'equipe (adresses du domaine de l'entreprise, signatures, indices donnes
 * par l'admin). Elle ne reecrit rien: les reponses sont recopiees telles
 * quelles, c'est le style reel qu'on veut apprendre.
 */
export async function extractTeamReplies(params: {
  text: string;
  categories: Array<{ id: string; label: string }>;
  teamHint: string;
  ownDomains: string[];
}): Promise<ExtractedThread[]> {
  return withRetry(() => extractTeamRepliesOnce(params), "import d'apprentissage");
}

async function extractTeamRepliesOnce(params: {
  text: string;
  categories: Array<{ id: string; label: string }>;
  teamHint: string;
  ownDomains: string[];
}): Promise<ExtractedThread[]> {
  const client = getClient();

  const tool: Anthropic.Tool = {
    name: "extract_team_replies",
    description: "Pour chaque fil colle, classe la demande et recopie les reponses ecrites par l'equipe.",
    input_schema: {
      type: "object",
      properties: {
        threads: {
          type: "array",
          items: {
            type: "object",
            properties: {
              categoryId: { type: "string", enum: params.categories.map((c) => c.id) },
              clientAsk: { type: "string", description: "La demande du client, en une phrase en francais." },
              teamReplies: {
                type: "array",
                items: { type: "string" },
                description:
                  "Reponses ecrites par l'equipe, recopiees telles quelles, sans l'historique cite dessous ni la signature automatique.",
              },
            },
            required: ["categoryId", "clientAsk", "teamReplies"],
          },
        },
      },
      required: ["threads"],
    },
  };

  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 8000,
    system: [
      "On te donne un ou plusieurs fils d'emails colles tels quels (les fils sont separes par une ligne '---', mais cette separation peut manquer: deduis-la du contenu).",
      "Pour chaque fil, repere ce qu'a ecrit L'EQUIPE de l'entreprise (pas le client, pas un partenaire exterieur).",
      params.ownDomains.length
        ? `L'equipe ecrit depuis les domaines: ${params.ownDomains.join(", ")}.`
        : "Aucun domaine d'equipe n'est configure: deduis l'equipe des signatures et du contexte.",
      params.teamHint ? `Indice donne par l'administrateur sur l'equipe: ${params.teamHint}` : "",
      "",
      "Regles strictes:",
      "- Recopie chaque reponse de l'equipe MOT POUR MOT (meme langue, memes formules). Ne corrige pas, ne resume pas, ne traduis pas.",
      "- N'inclus pas l'historique cite sous la reponse (lignes 'De:', 'From:', 'On ... wrote:', '>').",
      "- Si un fil ne contient aucune reponse de l'equipe, renvoie-le avec teamReplies vide.",
      "- Ignore les accuses automatiques, absences du bureau et notifications.",
      "- Choisis la categorie la plus proche de la demande du client parmi:",
      params.categories.map((c) => `  - ${c.id}: ${c.label}`).join("\n"),
    ]
      .filter((line) => line !== "")
      .join("\n"),
    tools: [tool],
    tool_choice: { type: "tool", name: "extract_team_replies" },
    messages: [{ role: "user", content: params.text.slice(0, MAX_PASTED_CHARS) }],
  });
  await recordUsage("import_apprentissage", null, response.usage);

  const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!toolUse) {
    throw new Error("Claude n'a pas retourné d'extraction structurée.");
  }
  return extractionSchema.parse(toolUse.input).threads;
}
