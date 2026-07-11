import type Anthropic from "@anthropic-ai/sdk";
import { CLAUDE_MODEL, getClient } from "./client.js";
import { loadBrandVoice } from "../config.js";
import { formatThreadContext } from "./prompts.js";
import type { CategoryConfig, EmailMessage, EmailThread } from "../types.js";

export interface RelanceDraft {
  subject: string;
  body: string;
}

export async function draftRelance(
  thread: EmailThread,
  lastInbound: EmailMessage,
  category: CategoryConfig
): Promise<RelanceDraft> {
  const client = getClient();
  const brandVoice = loadBrandVoice();

  const tool: Anthropic.Tool = {
    name: "write_relance",
    description: "Redige un email de relance courtois pour un dossier reste sans reponse.",
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
    max_tokens: 500,
    system: [
      "Tu rediges un email de relance, en francais, pour un dossier client reste sans",
      "reponse malgre l'accuse de reception deja envoye.",
      "",
      brandVoice,
      "",
      "Regles:",
      "- Ton courtois, jamais culpabilisant envers le destinataire.",
      "- Rappelle brievement l'objet de la demande initiale.",
      "- Indique que le dossier est toujours en cours de traitement.",
      "- Ne promets pas de nouveau delai precis s'il n'est pas confirme.",
      `- Cette demande relevait de la categorie "${category.label}".`,
    ].join("\n"),
    tools: [tool],
    tool_choice: { type: "tool", name: "write_relance" },
    messages: [{ role: "user", content: formatThreadContext(thread, lastInbound) }],
  });

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
  );
  if (!toolUse) {
    throw new Error("Claude n'a pas retourne de relance structuree.");
  }
  return toolUse.input as RelanceDraft;
}
