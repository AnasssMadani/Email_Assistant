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
  recordAckDraft,
  recordClassification,
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

  // Nos propres rappels internes (sendInternalNotification, relanceCheck.ts)
  // portent toujours ce prefixe exact. Quand NOTIFICATION_EMAIL n'est pas
  // definie, ce rappel part vers la messagerie connectee elle-meme — et sur
  // certains fournisseurs, un envoi auto-adresse cree une copie "Inbox"
  // avec un id DIFFERENT de la copie "Sent" deja marquee traitee par
  // markMessageProcessed(sent.id, ...) dans sendInternalNotification. Sans
  // ce garde-fou, cette copie Inbox est alors lue comme un vrai email
  // client et recoit a tort un accuse de reception.
  if (message.subject.startsWith("[Rappel]")) {
    markMessageProcessed(message.id, message.threadId);
    return;
  }

  const thread = await tagSource("Messagerie — lecture du fil", () => connector.getThread(message.threadId));
  const classification = await classifyEmail(thread, message);
  const category = getCategory(classification.categoryId);

  const shouldAcknowledge = category.acknowledgeAutomatically && classification.requiresAcknowledgement;
  const now = Date.now();
  const dueAt = shouldAcknowledge
    ? new Date(now + category.slaMinutes * 60_000).toISOString()
    : null;

  // Journalise TOUTE classification, accuse ou non — sans ca, un email juge
  // "pas d'accuse necessaire" (bruit, ou requiresAcknowledgement=false)
  // n'est visible nulle part avec son contenu sur /carnet, rendant
  // impossible de juger si l'IA l'a bien classifie (le but meme de la
  // semaine pilote). L'accuse, s'il y en a un, complete cette ligne plus
  // bas (voir recordAckDraft dans sendAcknowledgementAndDrafts).
  recordClassification({
    threadId: message.threadId,
    messageId: message.id,
    categoryId: category.id,
    urgency: classification.urgency,
    originalSubject: message.subject,
    senderEmail: message.from.email,
    senderName: message.from.name ?? null,
    receivedBody: message.bodyText,
  });

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

  if (config.shadowModeEnabled) {
    recordAckDraft({
      threadId: incoming.threadId,
      messageId: incoming.id,
      categoryId: category.id,
      originalSubject: incoming.subject,
      senderEmail: incoming.from.email,
      senderName: incoming.from.name ?? null,
      receivedBody: incoming.bodyText,
      ackSubject: replySubject,
      ackBody: ack.body,
    });
    // Pas d'envoi reel, mais on fait quand meme avancer le dossier en
    // pre_reply pour que le rappel interne (30 min, seul envoi reel
    // autorise cette semaine, voir relanceCheck.ts) se declenche
    // normalement. incrementAutomatedOutboundCount n'est PAS appele: aucun
    // message reel n'a rejoint le fil, donc automated_outbound_count doit
    // rester a 0 de notre cote — sinon une VRAIE reponse de l'equipe (le
    // fil, relu, contient alors un message isFromUs de plus que ce
    // compteur) ne serait plus jamais detectee comme reponse humaine (voir
    // checkPreReplyThread dans relanceCheck.ts).
    setThreadAckSent(incoming.threadId);
    console.log(`[mode carnet] accuse redige (non envoye) pour ${incoming.from.email} — "${incoming.subject}"`);
    return;
  }

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
  // Gmail/Graph marquent automatiquement tout le fil comme lu des qu'on y
  // envoie une reponse (l'accuse ci-dessus) — sans ce correctif, le message
  // du client disparait de la liste des non-lus alors que l'equipe ne l'a
  // pas encore vu. Non bloquant: un echec ici ne doit pas faire echouer
  // l'accuse deja envoye.
  try {
    await connector.markMessageUnread(incoming.id);
  } catch (err) {
    console.error(`[non-lu] echec du marquage non-lu pour ${incoming.id}:`, err);
  }
  // Journalise le destinataire reel de l'accuse — sans ca, un envoi vers une
  // adresse corrompue (parsing, saisie manuelle via /traiter, etc.) n'est
  // visible nulle part avant qu'un rebond n'arrive dans la boite, et devient
  // alors impossible a relier au dossier d'origine.
  recordReminder(incoming.threadId, "external", `Accusé de réception envoyé à ${incoming.from.email}.`, "accuse");
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
