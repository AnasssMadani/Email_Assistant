import { getCategory } from "../settings.js";
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
 * premier (devis envoye a froid, demarchage) — ces conversations n'ont
 * jamais de dossier cree par processIncomingMessage puisque celui-ci ne se
 * declenche que sur des messages entrants. Pour tout message sortant dont
 * le fil n'est pas deja suivi, on cree directement un dossier en phase
 * "post_reply" (en attente de la reponse du destinataire), avec la
 * categorie "autre" par defaut — modifiable ensuite comme n'importe quel
 * dossier (sequence de relance personnalisable depuis sa page de detail).
 */
export async function discoverOutboundOnlyThreads(connector: EmailConnector): Promise<void> {
  const messages = await connector.listRecentSentMessages(25);

  for (const message of messages) {
    if (message.receivedAt.getTime() < OBSERVED_SINCE.getTime()) continue;
    if (isMessageProcessed(message.id)) continue;

    try {
      await registerIfNewThread(message);
    } catch (err) {
      console.error(`[decouverte envois] erreur sur le message ${message.id}:`, err);
      recordPipelineError("discover_outbound", message.threadId || null, (err as Error).message);
    }
  }
}

async function registerIfNewThread(message: EmailMessage): Promise<void> {
  markMessageProcessed(message.id, message.threadId);

  if (getThreadRow(message.threadId)) return; // deja suivi (dossier normal ou deja decouvert)

  const recipient = message.to[0];
  if (!recipient?.email) return; // rien a relancer sans destinataire identifiable

  const category = getCategory("autre");
  const sentAt = message.receivedAt.toISOString();

  upsertThreadReceived({
    threadId: message.threadId,
    subject: message.subject,
    senderEmail: recipient.email,
    senderName: recipient.name ?? null,
    categoryId: category.id,
    urgency: "normal",
    slaHours: category.slaHours,
    status: "awaiting_client_reply",
    dueAt: null,
  });
  setThreadHumanReplied(message.threadId, sentAt, message.hasAttachments);
  console.log(`[envoi suivi] ${recipient.email} — "${message.subject}"`);
}
