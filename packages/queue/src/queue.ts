import PgBoss from "pg-boss";
import { requireDatabaseUrl, createLogger } from "@global-link/shared";

const logger = createLogger("queue");

/**
 * Job queue names in active use for Phase 1–2. More are named in the master brief
 * (document.ingest, embedding.generate, evaluation.run, analytics.process) — those
 * are not created until the phase that needs them (Phase 3+), per
 * docs/architecture/FUTURE_ROADMAP.md.
 */
export const QUEUES = {
  emailIngest: "email.ingest",
  emailClassify: "email.classify",
  emailSend: "email.send",
  relanceCheck: "relance.check",
  discoverOutbound: "email.discover_outbound",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface EnqueueOptions {
  /** pg-boss dedupes on this within its retention window — use for idempotent enqueue (e.g. one classify job per email id). */
  singletonKey?: string;
  retryLimit?: number;
  retryBackoff?: boolean;
  startAfterSeconds?: number;
}

/**
 * Thin interface over pg-boss — see docs/architecture/refonte-plan.md "Deviation
 * from the brief: pg-boss instead of Redis + BullMQ" for why. Kept narrow
 * deliberately: swapping to BullMQ/Upstash later, if a queue ever needs BullMQ's
 * rate limiter or throughput past what pg-boss's polling model handles, means
 * reimplementing this one file, not touching every job handler.
 */
export interface QueueClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  enqueue<T extends object>(queue: QueueName, payload: T, options?: EnqueueOptions): Promise<string | null>;
  work<T extends object>(queue: QueueName, handler: (payload: T) => Promise<void>): Promise<void>;
  scheduleCron(queue: QueueName, cron: string, payload?: object): Promise<void>;
}

let boss: PgBoss | null = null;

function getBoss(): PgBoss {
  if (!boss) {
    // Direct (non-pooled) connection — pg-boss holds long-lived connections for its
    // polling/maintenance loop, which pgbouncer's transaction-pooling mode does not
    // support well.
    const url = process.env.DIRECT_DATABASE_URL ?? requireDatabaseUrl();
    boss = new PgBoss({ connectionString: url });
    boss.on("error", (err) => logger.error({ err }, "pg-boss error"));
  }
  return boss;
}

export function createQueueClient(): QueueClient {
  return {
    async start() {
      const instance = getBoss();
      await instance.start();
      for (const queue of Object.values(QUEUES)) {
        await instance.createQueue(queue);
      }
    },
    async stop() {
      await getBoss().stop();
    },
    async enqueue(queue, payload, options) {
      return getBoss().send(queue, payload, {
        singletonKey: options?.singletonKey,
        retryLimit: options?.retryLimit ?? 3,
        retryBackoff: options?.retryBackoff ?? true,
        startAfter: options?.startAfterSeconds,
      });
    },
    async work(queue, handler) {
      await getBoss().work(queue, async ([job]) => {
        await handler(job.data as never);
      });
    },
    async scheduleCron(queue, cron, payload) {
      await getBoss().schedule(queue, cron, payload ?? {});
    },
  };
}
