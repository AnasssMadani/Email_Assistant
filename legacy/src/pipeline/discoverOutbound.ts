import { getCategory } from "../settings.js";
import { classifyEmail } from "../ai/classify.js";
import { tagSource } from "./errorTag.js";
import {
  getThreadRow,
  isMessageProcessed,
  markMessageProcessed,
  recordPipelineError,
  setThreadHumanReplied,
  upsertThreadReceived,
} from "../db.js";
import type { EmailConnector, EmailMessage } from "../types.js";

// N'observe que les envois posterieurs au demarrage du process: sans ca, le
// tout premier cycle apres le deploiement de cette fonctionnalite creerait
// d'un coup un dossier de suivi pour chaque email deja present dans
// "Envoyes" (potentiellement des annees d'historique, y compris des
// messages personnels), au lieu de ne suivre que les envois a venir.
const OBSERVED_SINCE = new Date();

/**
 * Detecte les emails que nous envoyons sans qu'un client ait ecrit en
 * premier (devis envoye a froid suite a un appel telephonique, demarchage,
 * suivi d'un dossier traite hors messagerie) — ces conversations n'ont
 * jamais de dossier cree par processIncomingMessage puisque celui-ci ne se
 * declenche que sur des messages entrants. Pour tout message sortant dont
 * le fil n'est pas deja suivi, on cree directement un dossier en phase
 * "post_reply" (en attente de la reponse du destinataire) — jamais dans la
 * boucle "avant reponse", puisque c'est justement nous qui venons de
 * repondre. Le sujet reel du message est classifie (devis, reclamation,
 * etc.) plutot que de figer "autre" par defaut, pour que la bonne sequence
 * de relance s'applique d'emblee — modifiable ensuite comme n'importe quel
 * dossier (sequence de relance personnalisable depuis sa page de detail).
 */
export async function discoverOutboundOnlyThreads(connector: EmailConnector): Promise<void> {
  const messages = await connector.listRecentSentMessages(25);

  for (const message of messages) {
    if (message.receivedAt.getTime() < OBSERVED_SINCE.getTime()) continue;
    if (isMessageProcessed(message.id)) continue;

    try {
      await registerIfNewThread(connector, message);
    } catch (err) {
      console.error(`[decouverte envois] erreur sur le message ${message.id}:`, err);
      recordPipelineError("discover_outbound", message.threadId || null, (err as Error).message);
    }
  }
}

async function registerIfNewThread(connector: EmailConnector, message: EmailMessage): Promise<void> {
  markMessageProcessed(message.id, message.threadId);

  if (getThreadRow(message.threadId)) return; // deja suivi (dossier normal ou deja decouvert)

  const recipient = message.to[0];
  if (!recipient?.email) return; // rien a relancer sans destinataire identifiable

  // Classifie le sujet reel de cet envoi a froid (devis, reclamation, etc.)
  // plutot que de figer "autre" par defaut: sans ca, un devis envoye a froid
  // par suivi d'un appel telephonique atterrissait avec la mauvaise sequence
  // de relance (celle de la categorie "autre") et restait affiche comme
  // "non classifie" dans le registre, alors que son contenu est parfaitement
  // identifiable. Best-effort: si la classification echoue (cle API absente,
  // etc.), le dossier reste suivi sous "autre" plutot que d'echouer
  // entierement sa decouverte.
  let categoryId = "autre";
  let urgency: "low" | "normal" | "high" = "normal";
  try {
    const thread = await tagSource("Messagerie — lecture du fil", () => connector.getThread(message.threadId));
    const classification = await classifyEmail(thread, message);
    categoryId = classification.categoryId;
    urgency = classification.urgency;
  } catch (err) {
    recordPipelineError("discover_outbound", message.threadId, (err as Error).message);
  }

  const category = getCategory(categoryId);
  const sentAt = message.receivedAt.toISOString();

  upsertThreadReceived({
    threadId: message.threadId,
    subject: message.subject,
    senderEmail: recipient.email,
    senderName: recipient.name ?? null,
    categoryId: category.id,
    urgency,
    slaMinutes: category.slaMinutes,
    status: "awaiting_client_reply",
    dueAt: null,
  });
  setThreadHumanReplied(message.threadId, sentAt, message.hasAttachments);
  console.log(`[envoi suivi] ${recipient.email} — "${message.subject}" (categorie: ${category.id})`);
}
