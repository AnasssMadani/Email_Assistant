import type Anthropic from "@anthropic-ai/sdk";
import { CLAUDE_MODEL, getClient } from "./client.js";
import { loadBrandVoice } from "../config.js";
import { formatThreadContext } from "./prompts.js";
import type { CategoryConfig, EmailMessage, EmailThread, ReplyDraft } from "../types.js";

export async function draftThreeReplies(
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
    max_tokens: 2200,
    system: [
      `Tu rediges des propositions de reponse au nom d'une entreprise, en francais,`,
      `pour un email de categorie "${category.label}".`,
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

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
  );
  if (!toolUse) {
    throw new Error("Claude n'a pas retourne de brouillons structures.");
  }
  return (toolUse.input as { drafts: ReplyDraft[] }).drafts;
}
