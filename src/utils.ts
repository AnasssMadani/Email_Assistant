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

/**
 * Prefixes d'objet de NOS emails internes (rappel equipe, rapport du matin).
 * Quand aucun destinataire dedie n'est configure, ces emails partent vers la
 * messagerie connectee elle-meme: leur copie "Boite de reception" ne doit
 * jamais etre traitee comme un email client (accuse envoye a nous-memes), ni
 * leur copie "Envoyes" comme un envoi a froid a suivre (relance du
 * destinataire interne). Chaque prefixe doit rester EN TETE de l'objet.
 */
export const INTERNAL_SUBJECT_PREFIXES = ["[Rappel]", "[Rapport]"] as const;

export function isInternalNotificationSubject(subject: string): boolean {
  return INTERNAL_SUBJECT_PREFIXES.some((prefix) => subject.startsWith(prefix));
}
