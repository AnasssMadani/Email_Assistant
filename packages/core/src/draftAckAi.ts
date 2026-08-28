import { z } from "zod";
import type { LLMProvider } from "@global-link/ai";
import { recordAiUsage } from "@global-link/ai";
import type { EmailMessage } from "@global-link/shared";
import { formatSlaForHuman } from "./format.js";

/**
 * Opt-in ($$$) accusé path — ported from legacy/src/ai/draftAcknowledgement.ts.
 * Only reached when a category's `ackMode` is explicitly set to "ai" (default is
 * "template", zero cost — see templates.ts). Runs on the strong/draft model since a
 * human is not reviewing this before it sends automatically; kept expensive-by-
 * exception, not the default path.
 */
const ackDraftSchema = z.object({
  subject: z.string().min(1),
  body: z.string().min(1),
});

export interface AckDraft {
  subject: string;
  body: string;
}

export async function draftAcknowledgementWithAi(
  ai: LLMProvider,
  organizationId: string,
  threadId: string | null,
  incoming: EmailMessage,
  categoryLabel: string,
  slaMinutes: number,
  brandVoice: string
): Promise<AckDraft> {
  const result = await ai.structuredGenerate({
    task: "draft",
    system: {
      static: [
        "You write acknowledgement emails on behalf of a company, ready to send as-is.",
        "",
        brandVoice,
        "",
        "Strict rules:",
        "- Explicitly reference the actual subject of the request (never a generic",
        "  'we have received your message').",
        `- Announce a maximum reply time of ${formatSlaForHuman(slaMinutes)}, without giving`,
        "  a precise time or date.",
        "- Promise nothing else: no commitment on price, availability, or decision.",
        "- The body must be sendable as-is: no 'Subject:' header, no placeholder, no",
        "  mention of AI.",
        "- Reply in the same language as the customer's message (French or English only).",
      ].join("\n"),
      dynamic: `Category: ${categoryLabel}`,
    },
    userContent: [
      `From: ${incoming.from.name ? `${incoming.from.name} <${incoming.from.email}>` : incoming.from.email}`,
      `Subject: ${incoming.subject}`,
      "Message:",
      incoming.bodyText.slice(0, 4000),
    ].join("\n"),
    schema: ackDraftSchema,
    toolName: "write_acknowledgement",
    toolDescription: "Writes a personalized, ready-to-send acknowledgement email.",
    inputSchema: {
      properties: { subject: { type: "string" }, body: { type: "string" } },
      required: ["subject", "body"],
    },
    maxTokens: 900,
  });

  await recordAiUsage({ organizationId, callType: "accuse_reception_ai", threadId, model: result.model, usage: result.usage });
  return result.data;
}
