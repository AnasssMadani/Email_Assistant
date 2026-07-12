import type Anthropic from "@anthropic-ai/sdk";
import { CLAUDE_MODEL, getClient } from "./client.js";
import { loadCategories } from "../settings.js";
import { formatThreadContext } from "./prompts.js";
import type { ClassificationResult, EmailMessage, EmailThread } from "../types.js";

export async function classifyEmail(
  thread: EmailThread,
  incoming: EmailMessage
): Promise<ClassificationResult> {
  const client = getClient();
  const { categories } = loadCategories();
  const categoryList = categories.map((c) => `- ${c.id}: ${c.label}`).join("\n");

  const tool: Anthropic.Tool = {
    name: "classify_email",
    description: "Classifie un email entrant pour determiner son traitement automatique.",
    input_schema: {
      type: "object",
      properties: {
        categoryId: { type: "string", enum: categories.map((c) => c.id) },
        urgency: { type: "string", enum: ["low", "normal", "high"] },
        summary: {
          type: "string",
          description: "Resume en une phrase, en francais, de ce que demande l'expediteur.",
        },
        requiresAcknowledgement: {
          type: "boolean",
          description: "Faux pour le spam, les newsletters, ou les communications internes.",
        },
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
    ].join("\n"),
    tools: [tool],
    tool_choice: { type: "tool", name: "classify_email" },
    messages: [{ role: "user", content: formatThreadContext(thread, incoming) }],
  });

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
  );
  if (!toolUse) {
    throw new Error("Claude n'a pas retourne de classification structuree.");
  }
  return toolUse.input as ClassificationResult;
}
