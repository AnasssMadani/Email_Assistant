import { ProviderRateLimitedError } from "@global-link/shared";

/**
 * Per-mailbox token bucket + 429/503 backoff. In-memory, keyed by mailboxId — correct
 * for the current single-worker-process deployment target (see
 * docs/architecture/refonte-plan.md, "not solving a throughput problem" at 800
 * emails/day). If workers ever scale horizontally, this needs to move to a shared
 * store (e.g. a Postgres-backed bucket, consistent with not introducing Redis for
 * this — see the queue package's rationale); a comment, not a TODO buried in code,
 * because the day it matters is the day a burst gets throttled twice as hard as it
 * should.
 *
 * Microsoft Graph is the provider the brief calls out as needing mailbox-aware
 * concurrency; the same limiter applies to Gmail for uniformity, at a much higher
 * default rate since Gmail's per-user quota is considerably more generous.
 */
interface Bucket {
  tokens: number;
  lastRefillAt: number;
}

const buckets = new Map<string, Bucket>();

function bucketFor(key: string, capacity: number): Bucket {
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { tokens: capacity, lastRefillAt: Date.now() };
    buckets.set(key, bucket);
  }
  return bucket;
}

async function acquire(key: string, capacity: number, refillPerSecond: number): Promise<void> {
  const bucket = bucketFor(key, capacity);
  for (;;) {
    const now = Date.now();
    const elapsedSeconds = (now - bucket.lastRefillAt) / 1000;
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSeconds * refillPerSecond);
    bucket.lastRefillAt = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return;
    }
    const waitMs = Math.max(50, ((1 - bucket.tokens) / refillPerSecond) * 1000);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

export interface RateLimitOptions {
  /** Burst capacity in requests. */
  capacity: number;
  /** Sustained requests/second once the burst is spent. */
  refillPerSecond: number;
  /** Retries on a 429/503-shaped error before giving up. */
  maxRetries?: number;
}

const DEFAULT_GRAPH_LIMIT: RateLimitOptions = { capacity: 4, refillPerSecond: 2, maxRetries: 3 };
const DEFAULT_GMAIL_LIMIT: RateLimitOptions = { capacity: 10, refillPerSecond: 5, maxRetries: 3 };

export function defaultLimitFor(provider: "gmail" | "graph"): RateLimitOptions {
  return provider === "graph" ? DEFAULT_GRAPH_LIMIT : DEFAULT_GMAIL_LIMIT;
}

/** Extracts a Retry-After (seconds or HTTP-date) header value into milliseconds, if present. */
export function parseRetryAfterMs(headerValue: string | null | undefined): number | undefined {
  if (!headerValue) return undefined;
  const asSeconds = Number(headerValue);
  if (!Number.isNaN(asSeconds)) return asSeconds * 1000;
  const asDate = Date.parse(headerValue);
  return Number.isNaN(asDate) ? undefined : Math.max(0, asDate - Date.now());
}

/**
 * Runs `fn` under the token bucket for `mailboxId`, retrying on
 * `ProviderRateLimitedError` up to `options.maxRetries` times, honouring the
 * provider's own Retry-After when the caller surfaces one.
 */
export async function withRateLimit<T>(
  mailboxId: string,
  provider: "gmail" | "graph",
  fn: () => Promise<T>,
  options: RateLimitOptions = defaultLimitFor(provider)
): Promise<T> {
  const key = `${provider}:${mailboxId}`;
  const maxRetries = options.maxRetries ?? 3;
  let attempt = 0;
  for (;;) {
    await acquire(key, options.capacity, options.refillPerSecond);
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof ProviderRateLimitedError) || attempt >= maxRetries) throw err;
      attempt++;
      const waitMs = err.retryAfterMs ?? 1000 * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}
