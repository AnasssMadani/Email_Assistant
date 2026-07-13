import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { CLAUDE_MODEL, getClient } from "./client.js";
import { withRetry } from "./structured.js";
import { loadBrandVoice } from "../config.js";
import { formatThreadContext } from "./prompts.js";
import type { CategoryConfig, EmailMessage, EmailThread } from "../types.js";

export interface RelanceDraft {
  subject: string;
  body: string;
}

const relanceSchema = z.object({
  subject: z.string().min(1),
  body: z.string().min(1),
});

export async function draftRelance(
  thread: EmailThread,
  lastInbound: EmailMessage,
  category: CategoryConfig
): Promise<RelanceDraft> {
  return withRetry(() => draftRelanceOnce(thread, lastInbound, category));
}

async function draftRelanceOnce(
  thread: EmailThread,
  lastInbound: EmailMessage,
  category: CategoryConfig
): Promise<RelanceDraft> {
  const client = getClient();
  const brandVoice = loadBrandVoice();

  // Le fil complet (formatThreadContext ci-dessous) contient deja nos
  // messages precedents, mais noyes dans l'historique general — on extrait
  // et met en avant explicitement le dernier message QUE NOUS avons envoye
  // (accuse ou relance precedente) pour que chaque relance s'appuie dessus
  // et assure une continuite naturelle, plutot que de repartir de zero a
  // chaque fois.
  const lastOutbound = [...thread.messages].reverse().find((m) => m.isFromUs);
  const continuityBlock = lastOutbound
    ? [
        "",
        "Notre dernier message envoye a ce demandeur dans ce fil (a ne pas repeter mot pour",
        "mot, mais dont tu dois assurer la continuite naturelle — ne pas redemander une",
        "information deja demandee ici, ne pas repeter une promesse deja faite):",
        `"""${lastOutbound.bodyText.slice(0, 2000)}"""`,
      ]
    : [];

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
    max_tokens: 700,
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
      ...continuityBlock,
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
  return relanceSchema.parse(toolUse.input);
}
