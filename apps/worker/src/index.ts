import { createLogger, loadConfig } from "@global-link/shared";
import { createQueueClient, QUEUES } from "@global-link/queue";
import { getDb, mailboxes, type MailboxProvider } from "@global-link/db";
import { createEmailConnector } from "@global-link/email";
import { createAnthropicProvider } from "@global-link/ai";
import { processIncomingMessage, discoverOutboundOnlyThreads, runRelanceCheck } from "@global-link/core";

/**
 * The background process for the whole platform — every organization's mailboxes
 * are polled from this one worker (Phase 1 scale target: 800 emails/day for one
 * tenant, a handful of tenants total; see docs/architecture/refonte-plan.md "800
 * emails/day is not a scale problem"). Ported from legacy/src/scheduler.ts: same
 * tick structure (poll inbox, discover outbound, check relances), same
 * in-process overlap guard, now iterating mailboxes instead of a single global
 * connector, and using pg-boss (see @global-link/queue) as the cron trigger
 * instead of node-cron directly, so a tick is still a durable, retryable job.
 */

const logger = createLogger("worker");
const env = loadConfig();
const ai = createAnthropicProvider();
const workerStartedAt = new Date();

interface MailboxRow {
  id: string;
  organizationId: string;
  provider: MailboxProvider;
}

async function listConnectedMailboxes(): Promise<MailboxRow[]> {
  // TODO: filter to mailboxes that have actually completed OAuth (tokenExpiresAt/
  // encryptedRefreshToken set) once the Connections UI (apps/web, Phase 1) can
  // produce that state — see docs/architecture/FUTURE_ROADMAP.md progress log.
  // Today this returns every mailbox row, which is only correct while every row
  // in the table is already connected.
  const rows = await getDb().select().from(mailboxes);
  return rows.map((r) => ({ id: r.id, organizationId: r.organizationId, provider: r.provider }));
}

async function forEachMailbox(
  taskName: string,
  fn: (mailbox: MailboxRow) => Promise<void>
): Promise<void> {
  for (const mailbox of await listConnectedMailboxes()) {
    try {
      await fn(mailbox);
    } catch (err) {
      logger.error({ err, mailboxId: mailbox.id, organizationId: mailbox.organizationId, task: taskName }, `${taskName} failed for mailbox`);
    }
  }
}

let pollInProgress = false;
async function pollInboxTick(): Promise<void> {
  if (pollInProgress) return;
  pollInProgress = true;
  try {
    await forEachMailbox("poll_inbox", async (mailbox) => {
      const connector = createEmailConnector(mailbox);
      const messages = await connector.listRecentInboxMessages(25);
      for (const message of messages) {
        try {
          await processIncomingMessage(
            { ai, connector, organizationId: mailbox.organizationId, mailboxId: mailbox.id, shadowMode: env.SHADOW_MODE },
            message
          );
        } catch (err) {
          logger.error({ err, mailboxId: mailbox.id, messageId: message.id }, "process_incoming failed");
        }
      }
    });
  } finally {
    pollInProgress = false;
  }
}

let discoverInProgress = false;
async function discoverOutboundTick(): Promise<void> {
  if (discoverInProgress) return;
  discoverInProgress = true;
  try {
    await forEachMailbox("discover_outbound", async (mailbox) => {
      const connector = createEmailConnector(mailbox);
      const sent = await connector.listRecentSentMessages(25);
      await discoverOutboundOnlyThreads(
        { ai, connector, organizationId: mailbox.organizationId, mailboxId: mailbox.id, observedSince: workerStartedAt },
        sent
      );
    });
  } finally {
    discoverInProgress = false;
  }
}

let relanceCheckInProgress = false;
async function relanceCheckTick(): Promise<void> {
  if (relanceCheckInProgress) return;
  relanceCheckInProgress = true;
  try {
    await forEachMailbox("relance_check", async (mailbox) => {
      const connector = createEmailConnector(mailbox);
      await runRelanceCheck(
        { ai, connector, organizationId: mailbox.organizationId, mailboxId: mailbox.id, shadowMode: env.SHADOW_MODE },
        env.MAX_EXTERNAL_RELANCES_PER_CYCLE
      );
    });
  } finally {
    relanceCheckInProgress = false;
  }
}

async function main(): Promise<void> {
  const queue = createQueueClient();
  await queue.start();

  await queue.work(QUEUES.emailIngest, () => pollInboxTick());
  await queue.work(QUEUES.discoverOutbound, () => discoverOutboundTick());
  await queue.work(QUEUES.relanceCheck, () => relanceCheckTick());

  // Same cadence as legacy's pollIntervalCron/relanceCheckCron defaults
  // (*/2 * * * *) — see legacy/CLAUDE.md on why 2 minutes, not the older 30.
  await queue.scheduleCron(QUEUES.emailIngest, "*/2 * * * *");
  await queue.scheduleCron(QUEUES.discoverOutbound, "*/2 * * * *");
  await queue.scheduleCron(QUEUES.relanceCheck, "*/2 * * * *");

  logger.info("Worker started — polling every 2 minutes.");

  // Immediate first run, same rationale as legacy's void pollInbox() at startup:
  // don't wait a full interval before the first pass after a deploy/restart.
  void pollInboxTick();
  void discoverOutboundTick();
}

main().catch((err) => {
  logger.error({ err }, "worker failed to start");
  process.exit(1);
});
