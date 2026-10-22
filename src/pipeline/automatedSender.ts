import { config } from "../config.js";
import { emailInDomains } from "../utils.js";
import type { EmailMessage } from "../types.js";

/**
 * Adresses d'envoi automatique (portails d'armateurs, robots de messagerie):
 * "mycustomerservice-noreply@cma-cgm.com", "mymsc.noreply@msc.com",
 * "charge_notification2@maersk.com", "mailer-daemon@..."... Personne n'attend
 * de reponse: le message est range sans appel a l'IA (economie) et ne recoit
 * jamais d'accuse, ce qui evite aussi que deux robots s'accusent en boucle.
 */
const AUTOMATED_LOCAL_PART =
  /(^|[._-])(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounces?|notifications?|notify|auto-?reply|autoresponder)([._-]|\d|$)/i;

export function isAutomatedMessage(message: EmailMessage): boolean {
  if (message.isAutomated) return true;
  // Portails dont l'adresse d'envoi n'a rien de "noreply" (ex: Portnet).
  if (emailInDomains(message.from.email, config.automatedDomains)) return true;
  const localPart = message.from.email.split("@")[0] ?? "";
  return AUTOMATED_LOCAL_PART.test(localPart);
}
