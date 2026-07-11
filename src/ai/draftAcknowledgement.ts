import type Anthropic from "@anthropic-ai/sdk";
import { CLAUDE_MODEL, getClient } from "./client.js";
import { loadBrandVoice } from "../config.js";
import { formatThreadContext } from "./prompts.js";
import type { CategoryConfig, EmailMessage, EmailThread } from "../types.js";

export interface AckDraft {
  subject: string;
  body: string;
}

export async function draftAcknowledgement(
  thread: EmailThread,
  incoming: EmailMessage,
  category: CategoryConfig
): Promise<AckDraft> {
  const client = getClient();
  const brandVoice = loadBrandVoice();

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
    max_tokens: 700,
    system: [
      "Tu rediges des accuses de reception au nom d'une entreprise, en francais.",
      "",
      brandVoice,
      "",
      "Regles strictes:",
      "- Cite explicitement l'objet reel de la demande (pas de formule generique du type",
      "  'nous avons bien recu votre message').",
      `- Annonce un delai de reponse de ${category.slaHours} heure(s) maximum, sans donner`,
      "  d'heure ou de date precise.",
      "- Ne promets rien d'autre que la prise en compte de la demande: aucun engagement",
      "  sur un prix, une disponibilite ou une decision.",
      "- Le corps doit pouvoir etre envoye tel quel: pas d'en-tete 'Objet:', pas de",
      "  placeholder, pas de mention d'IA.",
    ].join("\n"),
    tools: [tool],
    tool_choice: { type: "tool", name: "write_acknowledgement" },
    messages: [{ role: "user", content: formatThreadContext(thread, incoming) }],
  });

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
  );
  if (!toolUse) {
    throw new Error("Claude n'a pas retourne d'accuse de reception structure.");
  }
  return toolUse.input as AckDraft;
}
