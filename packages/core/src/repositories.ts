import { and, eq, inArray, isNotNull } from "drizzle-orm";
import {
  withOrg,
  emailThreads,
  emails as emailsTable,
  reminders,
  relanceSteps,
  categories as categoriesTable,
  pipelineErrors,
  prefilterLog,
  type ThreadStatus,
  type RelancePhase,
  type RelanceChannel,
  type ReminderStepType,
  type UrgencyThreshold,
} from "@global-link/db";

/**
 * Thin, org-scoped repository functions over packages/db — the pure-function layer
 * described in docs/architecture/refonte-plan.md ("domain logic in packages/core is
 * pure functions over repository interfaces"). Every function here ports one piece
 * of legacy/src/db.ts, preserving its documented invariants (see CLAUDE.md "Rules
 * carried over") against the new multi-tenant schema.
 */

export type ThreadRow = typeof emailThreads.$inferSelect;

export interface RelanceStepValue {
  order: number;
  channel: RelanceChannel;
  delayMinutes: number;
}

/**
 * Ports legacy upsertThreadReceived's ON CONFLICT guard: a late-arriving inbound
 * message on a thread that has already moved to post_reply (human_replied_at set)
 * must never regress its status or due_at — see legacy db.ts "BUG-004" comment.
 */
export async function findOrCreateThread(
  organizationId: string,
  params: {
    mailboxId: string;
    providerThreadId: string;
    subject: string;
    senderEmail: string;
    senderName: string | null;
    categoryId: string | null;
    urgency: UrgencyThreshold;
    slaMinutes: number | null;
    status: ThreadStatus;
    dueAt: Date | null;
    receivedAt: Date;
    origin?: "inbound" | "outbound";
  }
): Promise<ThreadRow> {
  return withOrg(organizationId, async (db) => {
    const [existing] = await db
      .select()
      .from(emailThreads)
      .where(and(eq(emailThreads.mailboxId, params.mailboxId), eq(emailThreads.providerThreadId, params.providerThreadId)))
      .limit(1);

    if (existing) {
      const alreadyPostReply = existing.humanRepliedAt !== null;
      const [updated] = await db
        .update(emailThreads)
        .set({
          subject: params.subject,
          categoryId: params.categoryId,
          urgency: params.urgency,
          slaMinutes: params.slaMinutes,
          status: alreadyPostReply ? existing.status : params.status,
          dueAt: alreadyPostReply ? existing.dueAt : params.dueAt,
          updatedAt: new Date(),
        })
        .where(eq(emailThreads.id, existing.id))
        .returning();
      return updated;
    }

    const [created] = await db
      .insert(emailThreads)
      .values({
        organizationId,
        mailboxId: params.mailboxId,
        providerThreadId: params.providerThreadId,
        subject: params.subject,
        senderEmail: params.senderEmail,
        senderName: params.senderName,
        categoryId: params.categoryId,
        urgency: params.urgency,
        slaMinutes: params.slaMinutes,
        status: params.status,
        dueAt: params.dueAt,
        receivedAt: params.receivedAt,
        origin: params.origin ?? "inbound",
      })
      .returning();
    return created;
  });
}

export async function setThreadAckSent(organizationId: string, threadId: string): Promise<void> {
  await withOrg(organizationId, (db) =>
    db.update(emailThreads).set({ status: "ack_sent", ackSentAt: new Date(), updatedAt: new Date() }).where(eq(emailThreads.id, threadId))
  );
}

export async function setThreadStatus(organizationId: string, threadId: string, status: ThreadStatus): Promise<void> {
  await withOrg(organizationId, (db) =>
    db.update(emailThreads).set({ status, updatedAt: new Date() }).where(eq(emailThreads.id, threadId))
  );
}

export async function incrementRelance(organizationId: string, threadId: string, status: ThreadStatus): Promise<void> {
  await withOrg(organizationId, async (db) => {
    const [row] = await db.select({ relanceCount: emailThreads.relanceCount }).from(emailThreads).where(eq(emailThreads.id, threadId)).limit(1);
    await db
      .update(emailThreads)
      .set({ relanceCount: (row?.relanceCount ?? 0) + 1, status, updatedAt: new Date() })
      .where(eq(emailThreads.id, threadId));
  });
}

export async function incrementPostReplyRelance(organizationId: string, threadId: string, status: ThreadStatus): Promise<void> {
  await withOrg(organizationId, async (db) => {
    const [row] = await db
      .select({ postReplyRelanceCount: emailThreads.postReplyRelanceCount })
      .from(emailThreads)
      .where(eq(emailThreads.id, threadId))
      .limit(1);
    await db
      .update(emailThreads)
      .set({ postReplyRelanceCount: (row?.postReplyRelanceCount ?? 0) + 1, status, updatedAt: new Date() })
      .where(eq(emailThreads.id, threadId));
  });
}

/** A human sent a substantive reply — see CLAUDE.md "human-reply detection is by counting". `repliedAt` is the message's own timestamp, never the detection time (see legacy comment on why). */
export async function setThreadHumanReplied(
  organizationId: string,
  threadId: string,
  repliedAt: Date,
  hadAttachment: boolean
): Promise<void> {
  await withOrg(organizationId, (db) =>
    db
      .update(emailThreads)
      .set({ status: "awaiting_client_reply", humanRepliedAt: repliedAt, outboundHadAttachment: hadAttachment, updatedAt: new Date() })
      .where(eq(emailThreads.id, threadId))
  );
}

export async function incrementAutomatedOutboundCount(organizationId: string, threadId: string): Promise<void> {
  await withOrg(organizationId, async (db) => {
    const [row] = await db
      .select({ automatedOutboundCount: emailThreads.automatedOutboundCount })
      .from(emailThreads)
      .where(eq(emailThreads.id, threadId))
      .limit(1);
    await db
      .update(emailThreads)
      .set({ automatedOutboundCount: (row?.automatedOutboundCount ?? 0) + 1, updatedAt: new Date() })
      .where(eq(emailThreads.id, threadId));
  });
}

const AWAITING_REPLY_STATUSES: ThreadStatus[] = ["ack_sent", "relance_sent"];
const AWAITING_CLIENT_REPLY_STATUSES: ThreadStatus[] = ["awaiting_client_reply", "post_reply_relance_sent"];

/**
 * Scoped to `mailboxId`, not just `organizationId`: the caller's connector serves
 * exactly one mailbox (see packages/email's factory.ts), so a multi-mailbox org
 * must run this once per mailbox with that mailbox's own connector — never mix
 * dossiers from mailbox A into a relance-check pass running against mailbox B's
 * connector. This structurally removes the legacy app's
 * `threadIdMatchesConnector()` guard: a thread's mailboxId always matches its own
 * provider, there is no "current global connector" to drift out of sync with.
 */
export async function listThreadsAwaitingReply(organizationId: string, mailboxId: string): Promise<ThreadRow[]> {
  return withOrg(organizationId, (db) =>
    db
      .select()
      .from(emailThreads)
      .where(and(eq(emailThreads.mailboxId, mailboxId), inArray(emailThreads.status, AWAITING_REPLY_STATUSES), isNotNull(emailThreads.dueAt)))
  );
}

/** Includes 'post_reply_relance_sent' — without it, a dossier stops being re-examined after its first post-reply relance (see legacy comment). */
export async function listThreadsAwaitingClientReply(organizationId: string, mailboxId: string): Promise<ThreadRow[]> {
  return withOrg(organizationId, (db) =>
    db
      .select()
      .from(emailThreads)
      .where(and(eq(emailThreads.mailboxId, mailboxId), inArray(emailThreads.status, AWAITING_CLIENT_REPLY_STATUSES), isNotNull(emailThreads.humanRepliedAt)))
  );
}

export async function recordReminder(
  organizationId: string,
  threadId: string,
  kind: "internal" | "external",
  note: string,
  stepType?: ReminderStepType
): Promise<void> {
  await withOrg(organizationId, (db) =>
    db.insert(reminders).values({ organizationId, threadId, kind, note, stepType: stepType ?? null })
  );
}

export async function recordPipelineError(
  organizationId: string,
  context: string,
  threadId: string | null,
  message: string
): Promise<void> {
  await withOrg(organizationId, (db) => db.insert(pipelineErrors).values({ organizationId, context, threadId, message }));
}

/**
 * Idempotency boundary for ingestion — see packages/db schema's unique
 * (mailboxId, providerMessageId). Returns false when the row already existed
 * (duplicate webhook/notification delivery), true when this call created it.
 */
export async function recordEmailIfNew(
  organizationId: string,
  params: {
    threadId: string;
    mailboxId: string;
    providerMessageId: string;
    rfcMessageId: string | undefined;
    fromEmail: string;
    fromName: string | undefined;
    to: { name?: string; email: string }[];
    subject: string;
    bodyText: string;
    isFromUs: boolean;
    hasAttachments: boolean;
    receivedAt: Date;
  }
): Promise<boolean> {
  return withOrg(organizationId, async (db) => {
    const inserted = await db
      .insert(emailsTable)
      .values({
        organizationId,
        threadId: params.threadId,
        mailboxId: params.mailboxId,
        providerMessageId: params.providerMessageId,
        rfcMessageId: params.rfcMessageId,
        fromEmail: params.fromEmail,
        fromName: params.fromName,
        toJson: params.to,
        subject: params.subject,
        bodyText: params.bodyText,
        isFromUs: params.isFromUs,
        hasAttachments: params.hasAttachments,
        receivedAt: params.receivedAt,
      })
      .onConflictDoNothing({ target: [emailsTable.mailboxId, emailsTable.providerMessageId] })
      .returning({ id: emailsTable.id });
    return inserted.length > 0;
  });
}

// ---------- Relance sequences ----------

function toStepValues(rows: (typeof relanceSteps.$inferSelect)[]): RelanceStepValue[] {
  return rows
    .sort((a, b) => a.stepOrder - b.stepOrder)
    .map((r) => ({ order: r.stepOrder, channel: r.channel, delayMinutes: r.delayMinutes }));
}

async function readSteps(
  organizationId: string,
  phase: RelancePhase,
  ownerType: "category" | "thread",
  ownerId: string
): Promise<RelanceStepValue[]> {
  const rows = await withOrg(organizationId, (db) =>
    db
      .select()
      .from(relanceSteps)
      .where(and(eq(relanceSteps.phase, phase), eq(relanceSteps.ownerType, ownerType), eq(relanceSteps.ownerId, ownerId)))
  );
  return toStepValues(rows);
}

export async function hasThreadRelanceOverride(organizationId: string, threadId: string, phase: RelancePhase): Promise<boolean> {
  const steps = await readSteps(organizationId, phase, "thread", threadId);
  return steps.length > 0;
}

/**
 * Freezes a dossier's relance sequence the first time it is examined, per
 * (thread, phase) — idempotent, no-op if already frozen or if the dossier has a
 * manual override. See CLAUDE.md "a category's relance sequence is frozen
 * per-dossier"; editing a category's steps later must never reach dossiers already
 * in flight.
 */
export async function freezeRelanceStepsSnapshot(
  organizationId: string,
  threadId: string,
  categoryId: string,
  phase: RelancePhase
): Promise<void> {
  if (await hasThreadRelanceOverride(organizationId, threadId, phase)) return;

  await withOrg(organizationId, async (db) => {
    const column = phase === "post_reply" ? emailThreads.postReplyRelanceSnapshot : emailThreads.preReplyRelanceSnapshot;
    const [row] = await db.select({ snapshot: column }).from(emailThreads).where(eq(emailThreads.id, threadId)).limit(1);
    if (!row || row.snapshot !== null) return;

    const categorySteps = await readSteps(organizationId, phase, "category", categoryId);
    await db
      .update(emailThreads)
      .set(phase === "post_reply" ? { postReplyRelanceSnapshot: categorySteps } : { preReplyRelanceSnapshot: categorySteps })
      .where(eq(emailThreads.id, threadId));
  });
}

/** Manual override → frozen snapshot → live category, in that order. See CLAUDE.md. */
export async function getEffectiveRelanceSteps(
  organizationId: string,
  threadId: string,
  categoryId: string,
  phase: RelancePhase
): Promise<{ steps: RelanceStepValue[]; isCustom: boolean }> {
  const overrideSteps = await readSteps(organizationId, phase, "thread", threadId);
  if (overrideSteps.length > 0) return { steps: overrideSteps, isCustom: true };

  const snapshot = await withOrg(organizationId, async (db) => {
    const column = phase === "post_reply" ? emailThreads.postReplyRelanceSnapshot : emailThreads.preReplyRelanceSnapshot;
    const [row] = await db.select({ snapshot: column }).from(emailThreads).where(eq(emailThreads.id, threadId)).limit(1);
    return (row?.snapshot as RelanceStepValue[] | null) ?? null;
  });
  if (snapshot) return { steps: snapshot, isCustom: false };

  return { steps: await readSteps(organizationId, phase, "category", categoryId), isCustom: false };
}

export type CategoryRow = typeof categoriesTable.$inferSelect;

export async function getCategoryById(organizationId: string, categoryId: string): Promise<CategoryRow | undefined> {
  const [row] = await withOrg(organizationId, (db) => db.select().from(categoriesTable).where(eq(categoriesTable.id, categoryId)).limit(1));
  return row;
}

export async function getCategoryByKey(organizationId: string, key: string): Promise<CategoryRow | undefined> {
  const [row] = await withOrg(organizationId, (db) =>
    db.select().from(categoriesTable).where(and(eq(categoriesTable.organizationId, organizationId), eq(categoriesTable.key, key))).limit(1)
  );
  return row;
}

/** Cheap existence check before spending an AI call on a message that was already ingested — the authoritative guard is the unique constraint enforced by recordEmailIfNew's insert. */
export async function existsEmailByProviderMessageId(
  organizationId: string,
  mailboxId: string,
  providerMessageId: string
): Promise<boolean> {
  const [row] = await withOrg(organizationId, (db) =>
    db
      .select({ id: emailsTable.id })
      .from(emailsTable)
      .where(and(eq(emailsTable.mailboxId, mailboxId), eq(emailsTable.providerMessageId, providerMessageId)))
      .limit(1)
  );
  return row !== undefined;
}

export async function recordPrefilterDrop(
  organizationId: string,
  mailboxId: string,
  providerMessageId: string,
  rule: string,
  subject: string,
  senderEmail: string
): Promise<void> {
  await withOrg(organizationId, (db) =>
    db.insert(prefilterLog).values({ organizationId, mailboxId, providerMessageId, rule, subject, senderEmail })
  );
}
