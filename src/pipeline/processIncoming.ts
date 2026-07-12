import { getCategory } from "../settings.js";
import { classifyEmail } from "../ai/classify.js";
import { draftAcknowledgement } from "../ai/draftAcknowledgement.js";
import { draftThreeReplies } from "../ai/draftReplies.js";
import { buildReplySubject } from "../utils.js";
import {
  isMessageProcessed,
  markMessageProcessed,
  upsertThreadReceived,
  setThreadAckSent,
  setThreadStatus,
  recordDraft,
} from "../db.js";
import type { EmailConnector, EmailMessage } from "../types.js";

export async function processIncomingMessage(
  connector: EmailConnector,
  message: EmailMessage
): Promise<void> {
  if (message.isFromUs) return;
  if (isMessageProcessed(message.id)) return;

  const thread = await connector.getThread(message.threadId);
  const classification = await classifyEmail(thread, message);
  const category = getCategory(classification.categoryId);

  const shouldAcknowledge = category.acknowledgeAutomatically && classification.requiresAcknowledgement;
  const now = Date.now();
  const dueAt = shouldAcknowledge
    ? new Date(now + category.slaHours * 3600_000).toISOString()
    : null;

  upsertThreadReceived({
    threadId: message.threadId,
    subject: message.subject,
    senderEmail: message.from.email,
    senderName: message.from.name ?? null,
    categoryId: category.id,
    urgency: classification.urgency,
    slaHours: category.slaHours,
    status: shouldAcknowledge ? "received" : "skipped",
    dueAt,
  });
  markMessageProcessed(message.id, message.threadId);

  if (!shouldAcknowledge) {
    console.log(`[skip] "${message.subject}" (${category.id}) — pas d'accuse requis.`);
    return;
  }

  // Le sujet envoye reprend toujours "Re: <sujet original>", pas celui que
  // Claude propose (ack.subject) - Gmail/Outlook exigent cette coherence
  // de sujet, en plus des en-tetes de threading, pour rattacher la reponse
  // au bon fil plutot que d'en creer un nouveau.
  const replySubject = buildReplySubject(message.subject);

  const ack = await draftAcknowledgement(thread, message, category);
  await connector.sendReply({
    threadId: message.threadId,
    to: message.from.email,
    subject: replySubject,
    bodyText: ack.body,
    inReplyToMessageId: message.rfcMessageId,
  });
  setThreadAckSent(message.threadId);
  console.log(`[accuse envoye] ${message.from.email} — "${message.subject}"`);

  const replies = await draftThreeReplies(thread, message, category);
  for (const reply of replies) {
    const draft = await connector.createDraftReply({
      threadId: message.threadId,
      to: message.from.email,
      subject: replySubject,
      bodyText: reply.body,
      inReplyToMessageId: message.rfcMessageId,
    });
    recordDraft({
      threadId: message.threadId,
      connectorDraftId: draft.id,
      variant: reply.variant,
      label: reply.label,
    });
  }
  setThreadStatus(message.threadId, "drafts_ready");
  console.log(`[brouillons prets] ${replies.length} propositions pour ${message.from.email}`);
}
