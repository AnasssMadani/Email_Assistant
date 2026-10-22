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

/** Messageries grand public: deux expediteurs du meme domaine sont deux personnes differentes. */
export const PUBLIC_MAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "hotmail.com",
  "hotmail.fr",
  "outlook.com",
  "outlook.fr",
  "live.com",
  "live.fr",
  "msn.com",
  "yahoo.com",
  "yahoo.fr",
  "icloud.com",
  "me.com",
  "aol.com",
  "gmx.com",
  "gmx.fr",
  "orange.fr",
  "menara.ma",
  "qq.com",
  "163.com",
  "126.com",
]);

/** Vrai si l'adresse est celle d'un des domaines (sous-domaines compris: "service.hlag.com" pour "hlag.com"). */
export function emailInDomains(email: string, domains: string[]): boolean {
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return false;
  return domains.some((d) => domain === d || domain.endsWith(`.${d}`));
}
