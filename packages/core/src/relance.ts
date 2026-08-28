import type { LLMProvider } from "@global-link/ai";
import type { EmailConnector, EmailMessage } from "@global-link/shared";
import type { ThreadRow, RelanceStepValue } from "./repositories.js";
import {
  freezeRelanceStepsSnapshot,
  getCategoryById,
  getEffectiveRelanceSteps,
  incrementAutomatedOutboundCount,
  incrementPostReplyRelance,
  incrementRelance,
  listThreadsAwaitingClientReply,
  listThreadsAwaitingReply,
  recordPipelineError,
  recordReminder,
  setThreadHumanReplied,
  setThreadStatus,
} from "./repositories.js";
import { getRelanceTemplateBody } from "./templateRepository.js";
import { DEFAULT_RELANCE_TEMPLATE } from "./defaultTemplates.js";
import { renderTemplate } from "./templates.js";
import { buildReplySubject, urgencyMeetsThreshold } from "./utils.js";

/**
 * Ported from legacy/src/pipeline/relanceCheck.ts — two independent loops over the
 * same dossier lifecycle. See CLAUDE.md "Rules carried over" for every invariant
 * enforced here; comments below point at the specific one where it isn't obvious
 * from the code alone.
 */

export interface ExternalSendBudget {
  remaining: number;
}

function tryConsumeExternalBudget(budget: ExternalSendBudget): boolean {
  if (budget.remaining <= 0) return false;
  budget.remaining--;
  return true;
}

export interface RelanceCheckContext {
  ai: LLMProvider;
  connector: EmailConnector;
  organizationId: string;
  mailboxId: string;
  shadowMode?: boolean;
}

export async function runRelanceCheck(ctx: RelanceCheckContext, maxExternalRelancesPerCycle: number): Promise<void> {
  const now = Date.now();
  const externalBudget: ExternalSendBudget = { remaining: maxExternalRelancesPerCycle };

  for (const row of await listThreadsAwaitingReply(ctx.organizationId, ctx.mailboxId)) {
    if (!row.dueAt || !row.categoryId) continue;

    await freezeRelanceStepsSnapshot(ctx.organizationId, row.id, row.categoryId, "pre_reply");
    const { steps } = await getEffectiveRelanceSteps(ctx.organizationId, row.id, row.categoryId, "pre_reply");
    const nextStep = steps[row.relanceCount];
    const fireAt = nextStep ? row.dueAt.getTime() + nextStep.delayMinutes * 60_000 : null;
    const dueStep = nextStep && fireAt !== null && now >= fireAt ? nextStep : undefined;

    try {
      await checkPreReplyThread(ctx, row, dueStep, externalBudget);
    } catch (err) {
      await recordPipelineError(ctx.organizationId, "relance_check", row.id, (err as Error).message);
    }
  }

  for (const row of await listThreadsAwaitingClientReply(ctx.organizationId, ctx.mailboxId)) {
    if (!row.humanRepliedAt || !row.categoryId) continue;

    await freezeRelanceStepsSnapshot(ctx.organizationId, row.id, row.categoryId, "post_reply");
    const { steps } = await getEffectiveRelanceSteps(ctx.organizationId, row.id, row.categoryId, "post_reply");
    const nextStep = steps[row.postReplyRelanceCount];
    const fireAt = nextStep ? row.humanRepliedAt.getTime() + nextStep.delayMinutes * 60_000 : null;
    const dueStep = nextStep && fireAt !== null && now >= fireAt ? nextStep : undefined;

    try {
      await checkPostReplyThread(ctx, row, dueStep, externalBudget);
    } catch (err) {
      await recordPipelineError(ctx.organizationId, "relance_check", row.id, (err as Error).message);
    }
  }
}

async function draftRelanceBody(
  ctx: RelanceCheckContext,
  threadId: string,
  categoryId: string,
  phase: "pre_reply" | "post_reply",
  language: "fr" | "en",
  slots: Record<string, string | undefined>
): Promise<string> {
  const templateBody = (await getRelanceTemplateBody(ctx.organizationId, categoryId, phase, language)) ?? DEFAULT_RELANCE_TEMPLATE[phase][language];
  return renderTemplate(templateBody, slots);
}

export async function checkPreReplyThread(
  ctx: RelanceCheckContext,
  row: ThreadRow,
  step: RelanceStepValue | undefined,
  externalBudget: ExternalSendBudget = { remaining: 1 }
): Promise<void> {
  const thread = await ctx.connector.getThread(row.providerThreadId);

  // See CLAUDE.md: human-reply detection is by COUNTING isFromUs messages against
  // automatedOutboundCount, never by matching content or ids.
  const ourMessages = thread.messages.filter((m) => m.isFromUs);
  const replyAfterAck =
    row.ackSentAt !== null && ourMessages.length > row.automatedOutboundCount ? ourMessages[ourMessages.length - 1] : undefined;

  if (replyAfterAck) {
    await setThreadHumanReplied(ctx.organizationId, row.id, replyAfterAck.receivedAt, replyAfterAck.hasAttachments);
    return;
  }

  if (!step) return;

  if (step.channel === "external") {
    const lastInbound = [...thread.messages].reverse().find((m: EmailMessage) => !m.isFromUs);
    if (!lastInbound) {
      await recordPipelineError(ctx.organizationId, "relance_check", row.id, "Relance externe annulée: aucun message entrant trouvé dans le fil.");
      return;
    }

    if (ctx.shadowMode) {
      await recordReminder(ctx.organizationId, row.id, "internal", `[shadow mode] Relance that would have been sent to ${row.senderEmail} for "${row.subject}" — not sent.`);
      await incrementRelance(ctx.organizationId, row.id, "relance_sent");
      return;
    }

    if (!tryConsumeExternalBudget(externalBudget)) return; // relanceCount untouched — retried identically next cycle, see CLAUDE.md budget cap.

    const lastMessageInThread = thread.messages[thread.messages.length - 1];
    const category = row.categoryId ? await getCategoryById(ctx.organizationId, row.categoryId) : undefined;
    if (!category) {
      await recordPipelineError(ctx.organizationId, "relance_check", row.id, "Relance externe annulée: catégorie introuvable.");
      return;
    }

    const body = await draftRelanceBody(ctx, row.id, category.id, "pre_reply", "fr", {
      senderName: row.senderName ?? undefined,
      originalSubject: row.subject,
    });

    await ctx.connector.sendReply({
      threadId: row.providerThreadId,
      to: row.senderEmail,
      subject: buildReplySubject(row.subject),
      bodyText: body,
      inReplyToMessageId: lastMessageInThread.rfcMessageId,
    });
    await incrementRelance(ctx.organizationId, row.id, "relance_sent");
    await incrementAutomatedOutboundCount(ctx.organizationId, row.id);
    await recordReminder(ctx.organizationId, row.id, "external", `Relance envoyée automatiquement à ${row.senderEmail}.`, "relance_externe_pre_reponse");
    return;
  }

  // Internal nudge step.
  const category = row.categoryId ? await getCategoryById(ctx.organizationId, row.categoryId) : undefined;
  const elapsedMinutes = row.dueAt ? Math.max(0, Math.round((Date.now() - row.dueAt.getTime()) / 60_000)) : step.delayMinutes;
  const note = `Dossier "${row.subject}" en attente depuis plus de ${elapsedMinutes} min après l'échéance.`;
  const shouldAlertTeam = category?.internalAlertsEnabled && urgencyMeetsThreshold(row.urgency, category.internalAlertsMinUrgency);

  if (shouldAlertTeam) {
    await sendInternalNotification(ctx, row, note);
    await recordReminder(ctx.organizationId, row.id, "internal", note, "relance_interne");
  } else {
    await recordReminder(ctx.organizationId, row.id, "internal", `${note} (alerte équipe non envoyée — sous le seuil configuré)`, "relance_interne_filtree");
  }
  await incrementRelance(ctx.organizationId, row.id, row.status);
}

export async function checkPostReplyThread(
  ctx: RelanceCheckContext,
  row: ThreadRow,
  step: RelanceStepValue | undefined,
  externalBudget: ExternalSendBudget = { remaining: 1 }
): Promise<void> {
  const thread = await ctx.connector.getThread(row.providerThreadId);

  const clientRepliedAfterOurReply =
    row.humanRepliedAt !== null && thread.messages.some((m) => !m.isFromUs && m.receivedAt.getTime() > (row.humanRepliedAt as Date).getTime());

  if (clientRepliedAfterOurReply) {
    await setThreadStatus(ctx.organizationId, row.id, "responded");
    return;
  }

  if (!step) return;

  if (step.channel === "external") {
    const lastOutbound = [...thread.messages].reverse().find((m) => m.isFromUs);
    if (!lastOutbound) {
      await recordPipelineError(ctx.organizationId, "relance_check", row.id, "Relance post-réponse annulée: aucun message sortant trouvé.");
      return;
    }

    if (ctx.shadowMode) {
      await recordReminder(ctx.organizationId, row.id, "internal", `[shadow mode] Post-reply relance that would have been sent to ${row.senderEmail} — not sent.`);
      await incrementPostReplyRelance(ctx.organizationId, row.id, "post_reply_relance_sent");
      return;
    }

    if (!tryConsumeExternalBudget(externalBudget)) return;

    const category = row.categoryId ? await getCategoryById(ctx.organizationId, row.categoryId) : undefined;
    if (!category) {
      await recordPipelineError(ctx.organizationId, "relance_check", row.id, "Relance post-réponse annulée: catégorie introuvable.");
      return;
    }

    const body = await draftRelanceBody(ctx, row.id, category.id, "post_reply", "fr", {
      senderName: row.senderName ?? undefined,
      originalSubject: row.subject,
      hadAttachment: row.outboundHadAttachment ? "true" : undefined,
    });

    await ctx.connector.sendReply({
      threadId: row.providerThreadId,
      to: row.senderEmail,
      subject: buildReplySubject(row.subject),
      bodyText: body,
      inReplyToMessageId: lastOutbound.rfcMessageId,
    });
    await incrementPostReplyRelance(ctx.organizationId, row.id, "post_reply_relance_sent");
    await incrementAutomatedOutboundCount(ctx.organizationId, row.id);
    await recordReminder(ctx.organizationId, row.id, "external", `Relance post-réponse envoyée à ${row.senderEmail}.`, "relance_externe_post_reponse");
    return;
  }

  // Post-reply internal nudges are disabled by design (matches legacy) — the team
  // doesn't need alerting when the CLIENT stays silent after their own reply. The
  // sequence still advances so a later external step still fires on schedule.
  const note = `Dossier "${row.subject}": client silencieux depuis notre réponse.`;
  await recordReminder(ctx.organizationId, row.id, "internal", `${note} (rappel interne post-réponse désactivé)`, "relance_interne_filtree");
  await incrementPostReplyRelance(ctx.organizationId, row.id, row.status);
}

async function sendInternalNotification(ctx: RelanceCheckContext, row: ThreadRow, note: string): Promise<void> {
  try {
    const ownEmail = await ctx.connector.getOwnEmailAddress();
    await ctx.connector.sendNotification({
      to: ownEmail,
      subject: `[Rappel] Dossier sans réponse — ${row.subject}`,
      bodyText: [note, "", `Objet: ${row.subject}`, `Expéditeur: ${row.senderEmail}`, `Urgence: ${row.urgency}`].join("\n"),
    });
  } catch (err) {
    await recordPipelineError(ctx.organizationId, "relance_check", row.id, `Échec envoi notification interne: ${(err as Error).message}`);
  }
}
