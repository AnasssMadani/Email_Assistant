import { config } from "../config.js";
import { getCategory } from "../settings.js";
import { classifyEmail } from "../ai/classify.js";
import { draftAcknowledgement } from "../ai/draftAcknowledgement.js";
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
  recordReminder,
} from "../db.js";
import type { CategoryConfig, EmailConnector, EmailMessage, EmailThread } from "../types.js";

export async function processIncomingMessage(
  connector: EmailConnector,
  message: EmailMessage
): Promise<void> {
  if (message.isFromUs) return;
  if (await isMessageProcessed(message.id)) return;

  // Nos propres rappels internes (sendInternalNotification, relanceCheck.ts)
  // portent toujours ce prefixe exact. Quand NOTIFICATION_EMAIL n'est pas
  // definie, ce rappel part vers la messagerie connectee elle-meme — et sur
  // certains fournisseurs, un envoi auto-adresse cree une copie "Inbox"
  // avec un id DIFFERENT de la copie "Sent" deja marquee traitee par
  // markMessageProcessed(sent.id, ...) dans sendInternalNotification, ET pas
  // forcement marquee isFromUs par le fournisseur (d'ou le if isFromUs
  // return; ci-dessus qui ne suffit pas seul). Un vrai tiers peut cependant
  // legitimement envoyer un objet commencant par "[Rappel]" (relance de
  // facture, courant chez un transitaire) — on ne doit avaler ce message que
  // s'il vient EN PLUS de notre propre boite (auto-adresse), jamais sur le
  // seul prefixe d'objet, qui n'importe quel expediteur peut usurper.
  const ownEmail = message.subject.startsWith("[Rappel]") ? await connector.getOwnEmailAddress() : undefined;
  if (ownEmail && message.from.email.toLowerCase() === ownEmail.toLowerCase()) {
    await markMessageProcessed(message.id, message.threadId);
    return;
  }

  const thread = await tagSource("Messagerie — lecture du fil", () => connector.getThread(message.threadId));
  const classification = await classifyEmail(thread, message);
  const category = await getCategory(classification.categoryId);

  if (category.id === "spam_newsletter") {
    // Contrairement aux autres categories "pas d'accuse necessaire", le spam
    // n'est journalise NULLE PART (ni shadow_log/carnet, ni threads/dossiers)
    // — son volume noierait les vrais dossiers dans les deux registres pour
    // un interet de revue quasi nul. Le ghosting (aucun accuse) etait deja le
    // bon comportement ; seule la journalisation change ici.
    await markMessageProcessed(message.id, message.threadId);
    console.log(`[skip] "${message.subject}" (spam_newsletter) — ignore, non journalise.`);
    return;
  }

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
  // bas (voir recordAckDraft dans sendAcknowledgement).
  await recordClassification({
    threadId: message.threadId,
    messageId: message.id,
    categoryId: category.id,
    urgency: classification.urgency,
    originalSubject: message.subject,
    senderEmail: message.from.email,
    senderName: message.from.name ?? null,
    receivedBody: message.bodyText,
  });

  await upsertThreadReceived({
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
  await markMessageProcessed(message.id, message.threadId);

  if (!shouldAcknowledge) {
    console.log(`[skip] "${message.subject}" (${category.id}) — pas d'accuse requis.`);
    return;
  }

  await sendAcknowledgement(connector, thread, message, category);
}

/**
 * Envoie l'accuse de reception pour un message donne. Extrait de
 * processIncomingMessage pour etre reutilisable depuis une intervention
 * manuelle (voir POST /dossiers/:threadId/traiter dans web/server.ts): un
 * dossier mal classifie par erreur (ex: vrai email client marque
 * "newsletter", donc jamais accuse) peut ainsi etre traite a la main avec la
 * bonne categorie, sans devoir rejouer toute la classification.
 */
export async function sendAcknowledgement(
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
    await recordAckDraft({
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
    await setThreadAckSent(incoming.threadId);
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
  await setThreadAckSent(incoming.threadId);
  // Comptabilise cet envoi automatique: permet a checkPreReplyThread de
  // reconnaitre plus tard que ce message (retrouve dans le fil relu depuis
  // la messagerie) est notre propre accuse, pas une reponse humaine.
  await incrementAutomatedOutboundCount(incoming.threadId);
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
  await recordReminder(incoming.threadId, "external", `Accusé de réception envoyé à ${incoming.from.email}.`, "accuse");
  console.log(`[accuse envoye] ${incoming.from.email} — "${incoming.subject}"`);
}
