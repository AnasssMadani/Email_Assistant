import type { UrgencyThreshold } from "@global-link/db";

/** Ported unchanged from legacy/src/utils.ts. */
export function buildReplySubject(originalSubject: string): string {
  const trimmed = originalSubject.trim();
  return /^re\s*:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

const URGENCY_RANK: Record<string, number> = { low: 0, normal: 1, high: 2 };

/** True if `urgency` meets or exceeds the configured minimum threshold to alert the team. */
export function urgencyMeetsThreshold(urgency: string, minUrgency: UrgencyThreshold): boolean {
  return (URGENCY_RANK[urgency] ?? 1) >= URGENCY_RANK[minUrgency];
}
