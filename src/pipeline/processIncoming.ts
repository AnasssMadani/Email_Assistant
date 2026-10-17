import { config } from "../config.js";
import { getCategory } from "../settings.js";
import { isSendAllowed } from "../stage.js";
import { classifyEmail } from "../ai/classify.js";
import { draftAcknowledgement } from "../ai/draftAcknowledgement.js";
import { buildReplySubject, isInternalNotificationSubject } from "../utils.js";
import { tagSource } from "./errorTag.js";
import { stripQuotedHistory } from "./emailText.js";
import { isAutomatedMessage } from "./automatedSender.js";
import { getOfficeHours, isWithinOfficeHours } from "../officeHours.js";
import {
  incrementAutomatedOutboundCount,
  isMessageProcessed,
  isRfcMessageProcessed,
  markMessageProcessed,
  upsertThreadReceived,
  recordAckDraft,
  recordAckSkipped,
  recordClassification,
  recordPipelineError,
  getThreadRow,
  recordReminder,
  setThreadAckSent,
  setThreadStatus,
  listRecentAcksForDomain,
  threadHasAckDraft,
  type AckSkipReason,
} from "../db.js";
import type { CategoryConfig, EmailConnector, EmailMessage, EmailThread } from "../types.js";

export async function processIncomingMessage(
  connector: EmailConnector,
  message: EmailMessage
): Promise<void> {
  if (message.isFromUs) return;
  if (await isMessageProcessed(message.id)) return;

  // Meme email recu en plusieurs exemplaires (envoye a info@ ET import@ ET
  // finance@, tous redirigees vers la boite copie): un seul est traite, sinon
  // le client recevrait autant d'accuses que d'adresses en destinataire.
  if (message.rfcMessageId && (await isRfcMessageProcessed(message.rfcMessageId))) {
    await markMessageProcessed(message.id, message.threadId, message.rfcMessageId);
    console.log(`[doublon] "${message.subject}" — exemplaire deja traite (meme Message-ID), ignore.`);
    return;
  }

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
  // Meme regle pour le rapport du matin ("[Rapport]", voir morningReport.ts).
  const ownEmail = isInternalNotificationSubject(message.subject) ? await connector.getOwnEmailAddress() : undefined;
  if (ownEmail && message.from.email.toLowerCase() === ownEmail.toLowerCase()) {
    await markMessageProcessed(message.id, message.threadId, message.rfcMessageId);
    return;
  }

  // Dossier deja en "Erreur IA" et reessaye il y a peu: on laisse passer le
  // delai (AI_RETRY_BACKOFF_MINUTES) avant de rappeler l'IA. Le message n'est
  // PAS marque traite, donc il sera retente ensuite.
  const existing = await getThreadRow(message.threadId);
  const alreadyFlagged = existing?.status === "ai_error";
  if (alreadyFlagged && Date.now() - Date.parse(existing.updated_at) < config.aiRetryBackoffMinutes * 60_000) return;

  const thread = await tagSource("Messagerie — lecture du fil", () => connector.getThread(message.threadId));
  // Nos messages deja dans la conversation avant cet email: ils ne sont pas
  // une reponse a CET email (voir prior_outbound_count, relanceCheck.ts).
  const priorOutboundCount = countOurMessagesBefore(thread, message);

  // Robots (portails d'armateurs, noreply, mailer-daemon): ranges sans appel
  // a l'IA ni accuse. Ils restent visibles dans le carnet et le registre.
  if (isAutomatedMessage(message)) {
    await recordAutomatedMessage(message, priorOutboundCount, existing !== undefined);
    return;
  }

  let classification: Awaited<ReturnType<typeof classifyEmail>>;
  try {
    classification = await classifyEmail(thread, message);
  } catch (err) {
    // La classification a echoue (ex: solde de jetons Claude epuise, panne
    // API) — plutot que de laisser ce message invisible et retente
    // indefiniment en silence (isMessageProcessed reste faux tant qu'on
    // n'appelle pas markMessageProcessed), on cree quand meme un dossier
    // visible dans le registre, avec le message d'erreur reel en clair sur
    // sa page de detail. Categorie "autre" a titre provisoire: des que la
    // classification reussira (prochain cycle, message non marque traite),
    // upsertThreadReceived la remplacera par la vraie categorie.
    // Une seule trace par email en erreur (pas une par cycle): les essais
    // suivants remettent seulement updated_at a jour, ce qui relance le delai.
    if (!alreadyFlagged) await recordPipelineError("process_incoming", message.threadId, (err as Error).message);
    await upsertThreadReceived({
      threadId: message.threadId,
      subject: message.subject,
      senderEmail: message.from.email,
      senderName: message.from.name ?? null,
      categoryId: "autre",
      urgency: "normal",
      slaMinutes: 0,
      status: "ai_error",
      dueAt: null,
      receivedAt: message.receivedAt,
      priorOutboundCount,
    });
    if (!alreadyFlagged) {
      await recordReminder(
        message.threadId,
        "internal",
        `[Erreur IA] La classification de cet email a échoué : ${(err as Error).message}`
      );
    }
    return;
  }

  // Hameconnage probable: rangé dans "Suspect" quand la categorie existe,
  // quelle que soit la categorie proposee (un faux appel d'offres arrive
  // classe "devis urgent").
  const suspectCategory = classification.suspicious ? await findCategory(SUSPECT_CATEGORY_ID) : undefined;
  const category = suspectCategory ?? (await getCategory(classification.categoryId));

  if (category.id === "spam_newsletter") {
    // Contrairement aux autres categories "pas d'accuse necessaire", le spam
    // n'est journalise NULLE PART (ni shadow_log/carnet, ni threads/dossiers)
    // — son volume noierait les vrais dossiers dans les deux registres pour
    // un interet de revue quasi nul. Le ghosting (aucun accuse) etait deja le
    // bon comportement ; seule la journalisation change ici.
    await markMessageProcessed(message.id, message.threadId, message.rfcMessageId);
    console.log(`[skip] "${message.subject}" (spam_newsletter) — ignore, non journalise.`);
    return;
  }

  // Un email qui attend une reponse de l'equipe est SUIVI (rappel interne si
  // personne ne repond), qu'il recoive un accuse ou non. Un email suspect ne
  // l'est jamais: personne ne doit y repondre.
  const followed = classification.requiresAcknowledgement && !classification.suspicious;
  const now = Date.now();
  const dueAt = followed ? new Date(now + category.slaMinutes * 60_000).toISOString() : null;

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
    receivedBody: stripQuotedHistory(message.bodyText),
  });

  await upsertThreadReceived({
    threadId: message.threadId,
    subject: message.subject,
    senderEmail: message.from.email,
    senderName: message.from.name ?? null,
    categoryId: category.id,
    urgency: classification.urgency,
    slaMinutes: category.slaMinutes,
    status: followed ? "received" : "skipped",
    dueAt,
    receivedAt: message.receivedAt,
    priorOutboundCount,
  });
  await markMessageProcessed(message.id, message.threadId, message.rfcMessageId);

  if (classification.createdCategory) {
    await recordReminder(
      message.threadId,
      "internal",
      `[Catégorie] Nouvelle catégorie créée par l'IA : « ${classification.createdCategory.label} » (aucune catégorie existante ne convenait). Réglages repris de la catégorie de repli — à revoir dans Réglages.`
    );
  }

  if (classification.suspicious) {
    await recordAckSkipped(message.id, "suspect");
    await recordReminder(
      message.threadId,
      "internal",
      `[Suspect] Email probablement frauduleux, aucun accusé : ${classification.suspicionReason?.trim() || "signaux d'hameçonnage détectés par l'IA"}. Ne pas ouvrir les pièces jointes ni les liens sans vérifier l'expéditeur.`
    );
    console.log(`[suspect] "${message.subject}" — ${message.from.email}`);
    return;
  }

  if (!followed) {
    await recordAckSkipped(message.id, "ia");
    console.log(`[skip] "${message.subject}" (${category.id}) — pas de reponse attendue.`);
    return;
  }

  // Garde-fous: certains emails meritent un suivi (rappel a l'equipe) mais
  // pas d'accuse automatique. Le dossier suit alors le meme chemin qu'apres
  // un accuse (ack_sent, sans incrementer le compteur d'envois
  // automatiques): l'equipe est relancee, le client ne l'est pas.
  const suppression =
    ackSuppression(classification, thread, message, existing?.automated_outbound_count ?? 0) ??
    (await ackPolicySuppression(category, message));
  if (suppression) {
    await recordAckSkipped(message.id, suppression.code);
    await setThreadAckSent(message.threadId);
    await recordReminder(message.threadId, "internal", `[Accusé non envoyé] ${suppression.note}`);
    console.log(`[accuse supprime] "${message.subject}" — ${suppression.note}`);
    return;
  }

  try {
    await sendAcknowledgement(connector, thread, message, category);
  } catch (err) {
    // La classification a deja reussi (message marque traite ci-dessus, pas
    // de reessai automatique au prochain cycle) — mais la redaction ou
    // l'envoi de l'accuse a echoue (ex: solde de jetons Claude epuise entre
    // temps). Rendre le dossier visible avec l'erreur, plutot qu'un dossier
    // bloque a "received" sans aucune explication ni action possible: voir
    // le bouton "Réessayer l'accusé" sur sa page de detail (web/server.ts).
    console.error(`[accusé] erreur sur le dossier ${message.threadId}:`, err);
    await recordPipelineError("process_incoming", message.threadId, (err as Error).message);
    await setThreadStatus(message.threadId, "ai_error");
    await recordReminder(
      message.threadId,
      "internal",
      `[Erreur IA] La rédaction/l'envoi de l'accusé a échoué : ${(err as Error).message}`
    );
  }
}

const SUSPECT_CATEGORY_ID = "suspect";
const NOTIFICATION_CATEGORY_ID = "notification_transporteur";
/** Fenetre dans laquelle un second accuse a la meme conversation est evite. */
const DUPLICATE_ACK_WINDOW_DAYS = 7;

async function findCategory(id: string): Promise<CategoryConfig | undefined> {
  const category = await getCategory(id);
  return category.id === id ? category : undefined;
}

/** Nos messages du fil dates d'avant cet email (l'equipe avait deja echange dans cette conversation). */
function countOurMessagesBefore(thread: EmailThread, incoming: EmailMessage): number {
  return thread.messages.filter(
    (m) => m.isFromUs && m.id !== incoming.id && m.receivedAt.getTime() <= incoming.receivedAt.getTime()
  ).length;
}

/**
 * Message de robot: classe "Notification automatique" sans appel a l'IA
 * (economie: environ un email sur trois dans cette boite), jamais accuse,
 * jamais suivi. Garde une trace complete dans le carnet et le registre.
 */
async function recordAutomatedMessage(
  message: EmailMessage,
  priorOutboundCount: number,
  threadExists: boolean
): Promise<void> {
  const category = (await findCategory(NOTIFICATION_CATEGORY_ID)) ?? (await getCategory("autre"));
  await recordClassification({
    threadId: message.threadId,
    messageId: message.id,
    categoryId: category.id,
    urgency: "low",
    originalSubject: message.subject,
    senderEmail: message.from.email,
    senderName: message.from.name ?? null,
    receivedBody: stripQuotedHistory(message.bodyText),
  });
  // Un robot qui ecrit dans un dossier existant (rebond mailer-daemon d'un
  // accuse, notification dans un fil client) ne doit pas le fermer ni le
  // reclasser: le dossier garde son suivi.
  if (!threadExists)
    await upsertThreadReceived({
      threadId: message.threadId,
      subject: message.subject,
      senderEmail: message.from.email,
      senderName: message.from.name ?? null,
      categoryId: category.id,
      urgency: "low",
      slaMinutes: category.slaMinutes,
      status: "skipped",
      dueAt: null,
      receivedAt: message.receivedAt,
      priorOutboundCount,
    });
  await markMessageProcessed(message.id, message.threadId, message.rfcMessageId);
  await recordAckSkipped(message.id, "automatique");
  console.log(`[automatique] "${message.subject}" — ${message.from.email}, range sans IA.`);
}

/**
 * Reglages de la categorie et anti-doublon: l'accuse n'est pas envoye mais
 * le dossier reste suivi.
 * - "categorie": la categorie n'envoie pas d'accuse (choix du client dans
 *   Reglages, ex: facturation).
 * - "doublon": un accuse a deja ete redige pour cette conversation, dans ce
 *   fil ou dans un autre fil du meme expediteur avec le meme sujet ou la
 *   meme reference de dossier.
 * - "heures_bureau": categorie reglee "hors heures de bureau" et l'email
 *   est arrive pendant que l'equipe est la pour repondre elle-meme.
 */
export async function ackPolicySuppression(
  category: CategoryConfig,
  incoming: EmailMessage,
  at: Date = new Date()
): Promise<{ code: AckSkipReason; note: string } | undefined> {
  if (!category.acknowledgeAutomatically) {
    return {
      code: "categorie",
      note: `la catégorie « ${category.label} » n'envoie pas d'accusé (voir Réglages).`,
    };
  }
  if (await isDuplicateAck(incoming)) {
    return {
      code: "doublon",
      note: "un accusé a déjà été rédigé pour cette conversation ces 7 derniers jours.",
    };
  }
  if (category.ackSchedule === "outside_hours") {
    const arrivedAt = incoming.receivedAt.getTime() > at.getTime() ? at : incoming.receivedAt;
    if (isWithinOfficeHours(arrivedAt, await getOfficeHours())) {
      return {
        code: "heures_bureau",
        note: `email arrivé pendant les heures de bureau : la catégorie « ${category.label} » n'envoie un accusé qu'en dehors (voir Réglages).`,
      };
    }
  }
  return undefined;
}

const PUBLIC_MAIL_DOMAINS = new Set([
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

async function isDuplicateAck(incoming: EmailMessage): Promise<boolean> {
  if (await threadHasAckDraft(incoming.threadId)) return true;
  const domain = incoming.from.email.split("@")[1]?.toLowerCase();
  if (!domain) return false;
  const since = new Date(Date.now() - DUPLICATE_ACK_WINDOW_DAYS * 86_400_000).toISOString();
  // Messagerie grand public: deux expediteurs du meme domaine sont deux
  // clients differents, on ne compare qu'avec le meme expediteur.
  const sender = incoming.from.email.toLowerCase();
  const recent = (await listRecentAcksForDomain(domain, since)).filter(
    (r) => !PUBLIC_MAIL_DOMAINS.has(domain) || r.senderEmail.toLowerCase() === sender
  );
  if (recent.length === 0) return false;
  const subject = normalizeSubject(incoming.subject);
  const refs = extractReferences(incoming.subject);
  return recent.some(
    (r) =>
      (subject.length > 0 && normalizeSubject(r.subject) === subject) ||
      extractReferences(r.subject).some((ref) => refs.includes(ref))
  );
}

/** Sujet sans prefixes de reponse/transfert (Re:, RE:, Ynt:, TR:, Fwd:...), en minuscules. */
export function normalizeSubject(subject: string): string {
  let s = subject.trim();
  const prefix = /^\s*(re|r|aw|sv|antw|rif|ynt|yan[ıi]t|fw|fwd|tr|wg|rv|enc|i)\s*(\[\d+\])?\s*:\s*/i;
  while (prefix.test(s)) s = s.replace(prefix, "");
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * References de dossier dans un sujet (booking, BL, house, numero de
 * conteneur): suites d'au moins 8 caracteres melant lettres et chiffres, ou
 * de 9 chiffres et plus. Ex: EVLC261016273, SHPSIL26100406-08, 279853802.
 */
export function extractReferences(subject: string): string[] {
  const tokens = subject.toUpperCase().match(/[A-Z0-9][A-Z0-9-]{7,}/g) ?? [];
  return tokens.filter((t) => (/\d/.test(t) && /[A-Z]/.test(t)) || /^\d{9,}$/.test(t));
}

/**
 * Cas ou l'accuse est volontairement supprime. "equipe": un humain a deja
 * repondu dans la conversation (nos messages dans le fil depassent le nombre
 * d'envois automatiques comptabilises), un accuse en plein echange serait du
 * bruit. "sensible": litige, reclamation, menace — decision de l'IA.
 */
export function ackSuppression(
  classification: { needsHumanReply?: boolean },
  thread: EmailThread,
  incoming: EmailMessage,
  automatedOutboundCount: number
): { code: "equipe" | "sensible"; note: string } | undefined {
  const ourEarlier = thread.messages.filter(
    (m) => m.isFromUs && m.id !== incoming.id && m.receivedAt.getTime() <= incoming.receivedAt.getTime()
  ).length;
  if (ourEarlier > automatedOutboundCount) {
    return {
      code: "equipe",
      note: "l'équipe a déjà répondu dans cette conversation, pas d'accusé automatique.",
    };
  }
  if (classification.needsHumanReply) {
    return {
      code: "sensible",
      note: "sujet sensible (litige, réclamation ou pénalité), une personne doit répondre.",
    };
  }
  return undefined;
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

  // Etape 0 (silencieux): accuse redige et journalise, jamais envoye.
  if (!(await isSendAllowed("accuse"))) {
    await recordAckDraft({
      threadId: incoming.threadId,
      messageId: incoming.id,
      categoryId: category.id,
      originalSubject: incoming.subject,
      senderEmail: incoming.from.email,
      senderName: incoming.from.name ?? null,
      receivedBody: stripQuotedHistory(incoming.bodyText),
      ackSubject: replySubject,
      ackBody: ack.body,
    });
    // Pas d'envoi reel, mais on fait quand meme avancer le dossier en
    // pre_reply pour que la sequence de relance avance (redigee, non
    // envoyee elle aussi tant que l'etape reste 0 — voir relanceCheck.ts). incrementAutomatedOutboundCount n'est PAS appele: aucun
    // message reel n'a rejoint le fil, donc automated_outbound_count doit
    // rester a 0 de notre cote — sinon une VRAIE reponse de l'equipe (le
    // fil, relu, contient alors un message isFromUs de plus que ce
    // compteur) ne serait plus jamais detectee comme reponse humaine (voir
    // checkPreReplyThread dans relanceCheck.ts).
    await setThreadAckSent(incoming.threadId);
    console.log(`[silencieux] accuse redige (non envoye) pour ${incoming.from.email} — "${incoming.subject}"`);
    return;
  }

  // Dernier garde-fou avant un VRAI envoi: un champ du Ton de marque jamais
  // rempli (ex: "[coordonnees / site web]") partirait tel quel chez le client.
  if (/\[(coordonn|nom du client|coller ici)[^\]]*\]/i.test(ack.body)) {
    throw new Error(
      "Ton de marque incomplet: l'accusé contient encore un champ à remplir entre crochets. Complétez « Ton de marque »."
    );
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
  // Aucun marquage lu/non lu ici (ni nulle part): la boite est en lecture
  // seule. L'ancien "remettre en non lu" apres l'accuse ecrivait dans la
  // boite, et pouvait meme remettre en non lu un email que l'equipe avait
  // deja ouvert entre deux cycles.
  // Journalise le destinataire reel de l'accuse — sans ca, un envoi vers une
  // adresse corrompue (parsing, saisie manuelle via /traiter, etc.) n'est
  // visible nulle part avant qu'un rebond n'arrive dans la boite, et devient
  // alors impossible a relier au dossier d'origine.
  await recordReminder(incoming.threadId, "external", `Accusé de réception envoyé à ${incoming.from.email}.`, "accuse");
  console.log(`[accuse envoye] ${incoming.from.email} — "${incoming.subject}"`);
}
