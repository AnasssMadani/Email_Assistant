import type { LLMProvider } from "@global-link/ai";
import type { EmailConnector, EmailMessage } from "@global-link/shared";
import { evaluatePrefilter } from "./prefilter.js";
import { classifyEmail } from "./classify.js";
import { renderTemplate } from "./templates.js";
import { formatSlaForHuman } from "./format.js";
import { buildReplySubject } from "./utils.js";
import { draftAcknowledgementWithAi } from "./draftAckAi.js";
import { getAckTemplateBody } from "./templateRepository.js";
import { DEFAULT_ACK_TEMPLATE } from "./defaultTemplates.js";
import {
  existsEmailByProviderMessageId,
  findOrCreateThread,
  getCategoryByKey,
  incrementAutomatedOutboundCount,
  recordEmailIfNew,
  recordPipelineError,
  recordPrefilterDrop,
  recordReminder,
  setThreadAckSent,
} from "./repositories.js";

export interface IntakeContext {
  ai: LLMProvider;
  connector: EmailConnector;
  organizationId: string;
  mailboxId: string;
  /** See docs/architecture/refonte-plan.md — suppresses real sends for pilot-week verification; classification/templating still runs so the pipeline can be inspected end to end. */
  shadowMode?: boolean;
}

/**
 * One incoming message → prefilter → classify → (template or AI) accusé.
 * Ported from legacy/src/pipeline/processIncoming.ts's intake half (draft-replies
 * generation is Phase 2.5, not included here). See CLAUDE.md "Rules carried over"
 * for the invariants this must not break.
 */
export async function processIncomingMessage(ctx: IntakeContext, message: EmailMessage): Promise<void> {
  if (message.isFromUs) return;

  // Own-[Rappel]-notification echo: only drop when the sender IS our own mailbox —
  // matching the subject prefix alone would let a real third party (e.g. an invoice
  // reminder that happens to start with "[Rappel]") be silently swallowed.
  const prefilter = evaluatePrefilter({ subject: message.subject, headers: message.headers, fromEmail: message.from.email });
  if (prefilter.drop) {
    if (prefilter.rule === "own_rappel_echo") {
      const ownEmail = await ctx.connector.getOwnEmailAddress();
      if (message.from.email.toLowerCase() !== ownEmail.toLowerCase()) {
        // Not actually our own echo — a genuine third party. Fall through to normal processing.
      } else {
        return;
      }
    } else {
      await recordPrefilterDrop(ctx.organizationId, ctx.mailboxId, message.id, prefilter.rule ?? "unknown", message.subject, message.from.email);
      return;
    }
  }

  if (await existsEmailByProviderMessageId(ctx.organizationId, ctx.mailboxId, message.id)) return;

  const classification = await classifyEmail(ctx.ai, ctx.organizationId, message, null);
  const category = await getCategoryByKey(ctx.organizationId, classification.categoryId);
  if (!category) {
    await recordPipelineError(ctx.organizationId, "process_incoming", null, `Unknown category key from classifier: "${classification.categoryId}".`);
    return;
  }

  // Matches legacy's spam_newsletter ghosting: never logged, never acknowledged —
  // its volume would drown real dossiers in the review UI for near-zero value.
  if (category.key === "spam_newsletter") return;

  const shouldAcknowledge = category.acknowledgeAutomatically && classification.requiresAcknowledgement;
  const now = new Date();
  const dueAt = shouldAcknowledge ? new Date(now.getTime() + category.slaMinutes * 60_000) : null;

  const thread = await findOrCreateThread(ctx.organizationId, {
    mailboxId: ctx.mailboxId,
    providerThreadId: message.threadId,
    subject: message.subject,
    senderEmail: message.from.email,
    senderName: message.from.name ?? null,
    categoryId: category.id,
    urgency: classification.urgency,
    slaMinutes: category.slaMinutes,
    status: shouldAcknowledge ? "received" : "skipped",
    dueAt,
    receivedAt: message.receivedAt,
  });

  const isNew = await recordEmailIfNew(ctx.organizationId, {
    threadId: thread.id,
    mailboxId: ctx.mailboxId,
    providerMessageId: message.id,
    rfcMessageId: message.rfcMessageId,
    fromEmail: message.from.email,
    fromName: message.from.name,
    to: message.to,
    subject: message.subject,
    bodyText: message.bodyText,
    isFromUs: false,
    hasAttachments: message.hasAttachments,
    receivedAt: message.receivedAt,
  });
  if (!isNew) return; // duplicate delivery of the same provider event — idempotency guard, see recordEmailIfNew.

  if (!shouldAcknowledge) return;

  await sendAcknowledgement(ctx, thread.id, message, category, classification.summary, classification.language);
}

interface CategoryForAck {
  id: string;
  key: string;
  label: string;
  slaMinutes: number;
  ackMode: "template" | "ai";
}

async function sendAcknowledgement(
  ctx: IntakeContext,
  threadId: string,
  incoming: EmailMessage,
  category: CategoryForAck,
  summary: string,
  language: "fr" | "en"
): Promise<void> {
  const replySubject = buildReplySubject(incoming.subject);

  let body: string;
  if (category.ackMode === "ai") {
    const draft = await draftAcknowledgementWithAi(
      ctx.ai,
      ctx.organizationId,
      threadId,
      incoming,
      category.label,
      category.slaMinutes,
      "" // TODO: org-level brand voice setting — not modeled yet, see FUTURE_ROADMAP.
    );
    body = draft.body;
  } else {
    const templateBody = (await getAckTemplateBody(ctx.organizationId, category.id, language)) ?? DEFAULT_ACK_TEMPLATE[language];
    body = renderTemplate(templateBody, {
      senderName: incoming.from.name,
      originalSubject: incoming.subject,
      summary,
      sla: formatSlaForHuman(category.slaMinutes),
      signature: undefined,
    });
  }

  if (ctx.shadowMode) {
    await setThreadAckSent(ctx.organizationId, threadId);
    return;
  }

  await ctx.connector.sendReply({
    threadId: incoming.threadId,
    to: incoming.from.email,
    subject: replySubject,
    bodyText: body,
    inReplyToMessageId: incoming.rfcMessageId,
  });
  await setThreadAckSent(ctx.organizationId, threadId);
  await incrementAutomatedOutboundCount(ctx.organizationId, threadId);
  try {
    await ctx.connector.markMessageUnread(incoming.id);
  } catch (err) {
    await recordPipelineError(ctx.organizationId, "process_incoming", threadId, `Failed to mark message unread: ${(err as Error).message}`);
  }
  await recordReminder(ctx.organizationId, threadId, "external", `Acknowledgement sent to ${incoming.from.email}.`, "accuse");
}
