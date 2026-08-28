import type { LLMProvider } from "@global-link/ai";
import type { EmailConnector, EmailMessage } from "@global-link/shared";
import { classifyEmail } from "./classify.js";
import { existsEmailByProviderMessageId, findOrCreateThread, getCategoryByKey, recordEmailIfNew, recordPipelineError, setThreadHumanReplied } from "./repositories.js";

/**
 * Ported from legacy/src/pipeline/discoverOutbound.ts. Catches cold outreach (a
 * message we send with no prior tracked thread — a quote sent after a phone call,
 * unsolicited follow-up) and registers it directly in post_reply phase, classified
 * against the outbound message's own content so the right relance sequence applies
 * immediately.
 */
export interface DiscoverOutboundContext {
  ai: LLMProvider;
  connector: EmailConnector;
  organizationId: string;
  mailboxId: string;
  /** Only messages sent after this instant are considered — see legacy comment: otherwise the very first run after deploying this feature would retroactively create a dossier for every email ever sent from the mailbox. */
  observedSince: Date;
}

export async function discoverOutboundOnlyThreads(ctx: DiscoverOutboundContext, sentMessages: EmailMessage[]): Promise<void> {
  for (const message of sentMessages) {
    if (message.receivedAt.getTime() < ctx.observedSince.getTime()) continue;
    if (await existsEmailByProviderMessageId(ctx.organizationId, ctx.mailboxId, message.id)) continue;

    try {
      await discoverOne(ctx, message);
    } catch (err) {
      await recordPipelineError(ctx.organizationId, "discover_outbound", null, (err as Error).message);
    }
  }
}

async function discoverOne(ctx: DiscoverOutboundContext, message: EmailMessage): Promise<void> {
  const classification = await classifyEmail(ctx.ai, ctx.organizationId, message, null);
  const category = await getCategoryByKey(ctx.organizationId, classification.categoryId);
  if (!category) {
    await recordPipelineError(ctx.organizationId, "discover_outbound", null, `Unknown category key from classifier: "${classification.categoryId}".`);
    return;
  }

  // The recipient of our own outbound message is the "customer" for this dossier.
  const recipient = message.to[0];
  if (!recipient) return;

  const thread = await findOrCreateThread(ctx.organizationId, {
    mailboxId: ctx.mailboxId,
    providerThreadId: message.threadId,
    subject: message.subject,
    senderEmail: recipient.email,
    senderName: recipient.name ?? null,
    categoryId: category.id,
    urgency: classification.urgency,
    slaMinutes: category.slaMinutes,
    status: "awaiting_client_reply",
    dueAt: null,
    receivedAt: message.receivedAt,
    origin: "outbound",
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
    isFromUs: true,
    hasAttachments: message.hasAttachments,
    receivedAt: message.receivedAt,
  });
  if (!isNew) return;

  // Anchor the post_reply sequence on the real send time, not discovery time —
  // discovery can run minutes to hours after the actual send (scheduler downtime,
  // poll interval), and the client's silence duration must not absorb that lag.
  await setThreadHumanReplied(ctx.organizationId, thread.id, message.receivedAt, message.hasAttachments);
}
