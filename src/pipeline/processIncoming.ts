import { config } from "../config.js";
import { getCategory } from "../settings.js";
import { classifyEmail } from "../ai/classify.js";
import { draftAcknowledgement } from "../ai/draftAcknowledgement.js";
import { draftThreeReplies } from "../ai/draftReplies.js";
import { buildReplySubject } from "../utils.js";
import { tagSource } from "./errorTag.js";
import {
  incrementAutomatedOutboundCount,
  isMessageProcessed,
  markMessageProcessed,
  upsertThreadReceived,
  setThreadAckSent,
  setThreadStatus,
  recordDraft,
  recordReminder,
} from "../db.js";
import type { CategoryConfig, EmailConnector, EmailMessage, EmailThread } from "../types.js";

export async function processIncomingMessage(
  connector: EmailConnector,
  message: EmailMessage
): Promise<void> {
  if (message.isFromUs) return;
  if (isMessageProcessed(message.id)) return;

  const thread = await tagSource("Messagerie — lecture du fil", () => connector.getThread(message.threadId));
  const classification = await classifyEmail(thread, message);
  const category = getCategory(classification.categoryId);

  const shouldAcknowledge = category.acknowledgeAutomatically && classification.requiresAcknowledgement;
  const now = Date.now();
  const dueAt = shouldAcknowledge
    ? new Date(now + category.slaMinutes * 60_000).toISOString()
    : null;

  upsertThreadReceived({
    threadId: message.threadId,
    subject: message.subject,
    senderEmail: message.from.email,
    senderName: message.from.name ?? null,
    categoryId: category.id,
    urgency: classification.urgency,
    slaMinutes: category.slaMinutes,
    status: shouldAcknowledge ? "received" : "skipped",
    dueAt,
  });
  markMessageProcessed(message.id, message.threadId);

  if (!shouldAcknowledge) {
    console.log(`[skip] "${message.subject}" (${category.id}) — pas d'accuse requis.`);
    return;
  }

  await sendAcknowledgementAndDrafts(connector, thread, message, category);
}

/**
 * Envoie l'accuse de reception et depose les 3 brouillons de reponse pour un
 * message donne. Extrait de processIncomingMessage pour etre reutilisable
 * depuis une intervention manuelle (voir POST /dossiers/:threadId/traiter
 * dans web/server.ts): un dossier mal classifie par erreur (ex: vrai email
 * client marque "newsletter", donc jamais accuse) peut ainsi etre traite
 * a la main avec la bonne categorie, sans devoir rejouer toute la
 * classification.
 */
export async function sendAcknowledgementAndDrafts(
  connector: EmailConnector,
  thread: EmailThread,
  incoming: EmailMessage,
  category: CategoryConfig
): Promise<void> {
  // Le sujet envoye reprend toujours "Re: <sujet original>", pas celui que
  // Claude propose (ack.subject) - Gmail/Outlook exigent cette coherence
  // de sujet, en plus des en-tetes de threading, pour rattacher la reponse
  // au bon fil plutot que d'en creer un nouveau.
  const replySubject = buildReplySubject(incoming.subject);

  const ack = await draftAcknowledgement(thread, incoming, category);
  await tagSource("Messagerie — envoi de l'accusé", () =>
    connector.sendReply({
      threadId: incoming.threadId,
      to: incoming.from.email,
      subject: replySubject,
      bodyText: ack.body,
      inReplyToMessageId: incoming.rfcMessageId,
    })
  );
  setThreadAckSent(incoming.threadId);
  // Comptabilise cet envoi automatique: permet a checkPreReplyThread de
  // reconnaitre plus tard que ce message (retrouve dans le fil relu depuis
  // la messagerie) est notre propre accuse, pas une reponse humaine.
  incrementAutomatedOutboundCount(incoming.threadId);
  // Journalise le destinataire reel de l'accuse — sans ca, un envoi vers une
  // adresse corrompue (parsing, saisie manuelle via /traiter, etc.) n'est
  // visible nulle part avant qu'un rebond n'arrive dans la boite, et devient
  // alors impossible a relier au dossier d'origine.
  recordReminder(incoming.threadId, "external", `Accusé de réception envoyé à ${incoming.from.email}.`);
  console.log(`[accuse envoye] ${incoming.from.email} — "${incoming.subject}"`);

  if (!config.draftRepliesEnabled) {
    // En pause: ni appel Claude ni depot de brouillon — le dossier reste au
    // statut "ack_sent", deja eligible aux relances/rappels normalement.
    console.log(`[brouillons en pause] aucun brouillon genere pour ${incoming.from.email}.`);
    return;
  }

  const replies = await draftThreeReplies(thread, incoming, category);
  for (const reply of replies) {
    const draft = await tagSource("Messagerie — dépôt du brouillon", () =>
      connector.createDraftReply({
        threadId: incoming.threadId,
        to: incoming.from.email,
        subject: replySubject,
        bodyText: reply.body,
        inReplyToMessageId: incoming.rfcMessageId,
      })
    );
    recordDraft({
      threadId: incoming.threadId,
      connectorDraftId: draft.id,
      variant: reply.variant,
      label: reply.label,
    });
  }
  setThreadStatus(incoming.threadId, "drafts_ready");
  console.log(`[brouillons prets] ${replies.length} propositions pour ${incoming.from.email}`);
}
