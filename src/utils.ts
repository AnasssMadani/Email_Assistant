import type { UrgencyThreshold } from "./types.js";

export function buildReplySubject(originalSubject: string): string {
  const trimmed = originalSubject.trim();
  return /^re\s*:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

const URGENCY_RANK: Record<string, number> = { low: 0, normal: 1, high: 2 };

/** Vrai si l'urgence d'un dossier atteint (ou depasse) le seuil minimal configure pour alerter l'equipe. */
export function urgencyMeetsThreshold(urgency: string, minUrgency: UrgencyThreshold): boolean {
  return (URGENCY_RANK[urgency] ?? 1) >= URGENCY_RANK[minUrgency];
}
