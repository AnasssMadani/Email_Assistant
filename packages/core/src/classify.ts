import { z } from "zod";
import { eq } from "drizzle-orm";
import { withOrg, categories as categoriesTable } from "@global-link/db";
import { recordAiUsage, type LLMProvider } from "@global-link/ai";
import type { EmailMessage } from "@global-link/shared";

/**
 * Classification schema — extends the legacy app's four fields with `language`
 * (moves the FR/EN decision out of a separate drafting-time LLM instruction and
 * into the classifier's own tool schema, at the cost of ~3 output tokens on a call
 * already being made — see refonte-plan.md "The cost model"). The enum itself
 * enforces "never a third language", which is strictly safer than an instruction
 * the model can drift from.
 */
export const classificationSchema = z.object({
  categoryId: z.string().min(1),
  urgency: z.enum(["low", "normal", "high"]),
  summary: z.string().min(1),
  requiresAcknowledgement: z.boolean(),
  language: z.enum(["fr", "en"]),
});

export type ClassificationResult = z.infer<typeof classificationSchema>;

const MAX_BODY_CHARS_FOR_CLASSIFICATION = 1500;

function formatMessageForClassification(message: EmailMessage): string {
  return [
    `From: ${message.from.name ? `${message.from.name} <${message.from.email}>` : message.from.email}`,
    `Date: ${message.receivedAt.toISOString()}`,
    `Subject: ${message.subject}`,
    "Message:",
    message.bodyText.slice(0, MAX_BODY_CHARS_FOR_CLASSIFICATION),
  ].join("\n");
}

/**
 * Classifies one incoming email against the organization's own category list.
 * Runs on the cheap/small model (see packages/ai router) with the category list
 * cached across calls (byte-identical for every email of the same org/day).
 */
export async function classifyEmail(
  ai: LLMProvider,
  organizationId: string,
  message: EmailMessage,
  threadId: string | null
): Promise<ClassificationResult> {
  const orgCategories = await withOrg(organizationId, (db) =>
    db.select().from(categoriesTable).where(eq(categoriesTable.organizationId, organizationId))
  );
  const categoryList = orgCategories.map((c) => `- ${c.key}: ${c.label}`).join("\n");

  const result = await ai.structuredGenerate({
    task: "classification",
    system: {
      static: [
        "You classify incoming emails for a professional contact mailbox.",
        "Available categories:",
        categoryList,
        "",
        "Pick the category closest to the message's actual content. When unsure, use",
        "'autre'. A message that needs no reply (spam, newsletter, automated",
        "notification, internal communication) must have requiresAcknowledgement=false.",
        "",
        "Language: 'fr' if the customer's message is in French, 'en' for any other",
        "language — never anything else.",
      ].join("\n"),
    },
    userContent: formatMessageForClassification(message),
    schema: classificationSchema,
    toolName: "classify_email",
    toolDescription: "Classifies an incoming email to determine its automated handling.",
    inputSchema: {
      properties: {
        categoryId: { type: "string", enum: orgCategories.map((c) => c.key) },
        urgency: { type: "string", enum: ["low", "normal", "high"] },
        summary: { type: "string", description: "One-sentence summary, in the message's own language, of what the sender is asking." },
        requiresAcknowledgement: { type: "boolean" },
        language: { type: "string", enum: ["fr", "en"] },
      },
      required: ["categoryId", "urgency", "summary", "requiresAcknowledgement", "language"],
    },
    maxTokens: 400,
  });

  await recordAiUsage({
    organizationId,
    callType: "classification",
    threadId,
    model: result.model,
    usage: result.usage,
  });

  return result.data;
}
