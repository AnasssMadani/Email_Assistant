import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { CLAUDE_MODEL, getClient } from "./client.js";
import { recordUsage, withRetry } from "./structured.js";
import { getBrandVoice, getCategoryPlaybook, TEAM_PLAYBOOK_ID } from "../db.js";
import { stripQuotedHistory } from "../pipeline/emailText.js";
import { formatSingleMessage, LANGUAGE_INSTRUCTION } from "./prompts.js";
import type { CategoryConfig, EmailMessage, EmailThread } from "../types.js";

export interface AckDraft {
  subject: string;
  body: string;
}

const ackSchema = z.object({
  subject: z.string().min(1),
  body: z.string().min(1),
});

export async function draftAcknowledgement(
  thread: EmailThread,
  incoming: EmailMessage,
  category: CategoryConfig
): Promise<AckDraft> {
  return withRetry(() => draftAcknowledgementOnce(thread, incoming, category), "accusé de réception");
}

async function draftAcknowledgementOnce(
  thread: EmailThread,
  incoming: EmailMessage,
  category: CategoryConfig
): Promise<AckDraft> {
  const client = getClient();
  const brandVoice = await getBrandVoice();
  // Vide tant qu'aucune analyse de corpus n'a encore tourne pour cette
  // categorie (voir corpusAnalysis.ts): on se rabat alors sur la note de
  // style generale de l'equipe (toutes categories confondues). Une chaine
  // vide ne change rien au prompt, ce n'est pas une erreur.
  const categoryPlaybook = (await getCategoryPlaybook(category.id)) || (await getCategoryPlaybook(TEAM_PLAYBOOK_ID));

  const tool: Anthropic.Tool = {
    name: "write_acknowledgement",
    description: "Redige un accuse de reception personnalise, pret a etre envoye.",
    input_schema: {
      type: "object",
      properties: {
        subject: { type: "string" },
        body: { type: "string" },
      },
      required: ["subject", "body"],
    },
  };

  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 400,
    system: [
      "Tu rediges des accuses de reception au nom d'une entreprise.",
      "Un accuse dit seulement que le message est bien recu et qu'il est pris en charge.",
      "",
      LANGUAGE_INSTRUCTION,
      "",
      brandVoice,
      "",
      categoryPlaybook,
      "",
      "Regles strictes:",
      "- Court: une a trois phrases avant la signature, comme les vraies reponses de l'equipe",
      "  (ex: 'Well noted with thanks, we are checking and will revert.').",
      "- Si le message porte une reference (booking, BL, numero de dossier ou de facture),",
      "  cite-la telle quelle, une seule fois. Sinon, nomme le sujet en quelques mots.",
      "- Ne recopie AUCUN montant, prix, taux, date, port, poids ou volume, meme s'ils",
      "  figurent dans le message: un chiffre mal recopie rendrait l'accuse faux.",
      "- N'annonce aucun delai de reponse et ne promets rien: aucun engagement sur un prix,",
      "  une disponibilite, une date ou une decision.",
      "- Le corps doit pouvoir etre envoye tel quel: pas d'en-tete 'Objet:', pas de",
      "  placeholder, pas de mention d'IA.",
    ].join("\n"),
    tools: [tool],
    tool_choice: { type: "tool", name: "write_acknowledgement" },
    // Le dernier message seul, sans l'historique cite: l'accuse ne doit
    // repondre qu'a ce qui vient d'etre ecrit, et l'historique y injectait
    // des chiffres d'anciens messages (taux, dates).
    messages: [{ role: "user", content: formatSingleMessage({ ...incoming, bodyText: stripQuotedHistory(incoming.bodyText) }) }],
  });
  await recordUsage("accuse_reception", thread.id, response.usage);

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
  );
  if (!toolUse) {
    throw new Error("Claude n'a pas retourne d'accuse de reception structure.");
  }
  return ackSchema.parse(toolUse.input);
}
