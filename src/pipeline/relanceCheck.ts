import { config } from "../config.js";
import { getCategory } from "../settings.js";
import { draftRelance } from "../ai/draftRelance.js";
import { cleanupUnusedDrafts } from "./draftCleanup.js";
import { tagSource } from "./errorTag.js";
import { buildReplySubject, urgencyMeetsThreshold } from "../utils.js";
import {
  getEffectiveRelanceSteps,
  incrementAutomatedOutboundCount,
  incrementPostReplyRelance,
  incrementRelance,
  listThreadsAwaitingClientReply,
  listThreadsAwaitingReply,
  markMessageProcessed,
  recordPipelineError,
  recordReminder,
  setThreadHumanReplied,
  setThreadStatus,
  type ThreadRow,
} from "../db.js";
import type { EmailConnector, RelanceStep } from "../types.js";

/**
 * Compteur partage sur un seul cycle de runRelanceCheck: plafonne le nombre
 * de relances EXTERNES envoyees, quel que soit le nombre de dossiers due en
 * meme temps. Voir config.maxExternalRelancesPerCycle.
 */
interface ExternalSendBudget {
  remaining: number;
}

function tryConsumeExternalBudget(budget: ExternalSendBudget): boolean {
  if (budget.remaining <= 0) return false;
  budget.remaining--;
  return true;
}

/**
 * Detection heuristique du fournisseur d'origine d'un thread_id, pour
 * eviter d'appeler l'API Graph avec un id de fil Gmail (ou l'inverse) — les
 * deux formats n'ont rien a voir, et l'appel echoue systematiquement avec
 * une erreur peu parlante ("Id is malformed" cote Graph). Se produit quand
 * la boite connectee change de fournisseur apres coup: les dossiers suivis
 * sous l'ancien fournisseur restent en base, jamais nettoyes
 * automatiquement, et sans ce garde-fou seraient re-tentes (et
 * re-echoueraient) a chaque cycle indefiniment. Id Gmail: chaine hex
 * courte (ex: "19f674320b53b27a"). Id Graph (conversationId): bien plus
 * long, encode en base64url, jamais purement hexadecimal sur cette
 * longueur.
 */
function looksLikeGmailThreadId(id: string): boolean {
  return /^[0-9a-f]{10,20}$/i.test(id);
}

function threadIdMatchesConnector(threadId: string, connectorName: "gmail" | "graph"): boolean {
  const gmailShaped = looksLikeGmailThreadId(threadId);
  return connectorName === "gmail" ? gmailShaped : !gmailShaped;
}

/**
 * Deux boucles independantes, une par phase du cycle de vie d'un dossier:
 *
 * 1. "pre_reply" — personne chez nous n'a encore repondu de fond au client.
 *    On nudge notre equipe (rappel interne) puis, si ca continue, on
 *    rassure le client (relance externe generique "toujours en cours").
 *    S'arrete des qu'un humain envoie une reponse de fond.
 *
 * 2. "post_reply" — un humain a envoye une reponse de fond (ex: le devis).
 *    On attend maintenant la reponse DU CLIENT a ce message. S'il reste
 *    silencieux, on le relance lui, en reference a ce qu'on lui a envoye.
 *    S'arrete des que le client repond.
 *
 * Chaque etape (des deux sequences) se declenche a son propre ancrage +
 * son delai: due_at pour pre_reply, human_replied_at pour post_reply.
 */
export async function runRelanceCheck(connector: EmailConnector): Promise<void> {
  const now = Date.now();
  // Un seul budget partage entre les deux boucles (pre_reply et post_reply):
  // le plafond porte sur le TOTAL de relances externes du cycle, pas sur
  // chaque phase separement.
  const externalBudget: ExternalSendBudget = { remaining: config.maxExternalRelancesPerCycle };

  // checkPreReplyThread/checkPostReplyThread detectent une reponse humaine
  // AVANT de regarder s'il y a une etape a declencher — mais si on ne les
  // appelle QUE quand une etape est due, un dossier dont la sequence est
  // entierement epuisee (toutes les etapes deja envoyees) n'est plus jamais
  // reexamine, et une reponse arrivee APRES la derniere etape ne sera jamais
  // detectee: le dossier reste bloque indefiniment, et la phase suivante
  // (relance apres reponse, ou "repondu") ne se declenche jamais. On appelle
  // donc systematiquement la fonction pour chaque dossier eligible, en ne
  // passant une etape que si elle existe ET qu'elle est due — la detection
  // de reponse, elle, tourne a chaque cycle quoi qu'il arrive.
  for (const row of listThreadsAwaitingReply()) {
    if (!row.due_at) continue;
    if (!threadIdMatchesConnector(row.thread_id, connector.name)) continue;

    const { steps } = getEffectiveRelanceSteps(row.thread_id, row.category_id, "pre_reply");
    const nextStep = steps[row.relance_count];
    const fireAt = nextStep ? new Date(row.due_at).getTime() + nextStep.delayMinutes * 60_000 : null;
    const dueStep = nextStep && fireAt !== null && now >= fireAt ? nextStep : undefined;

    try {
      await checkPreReplyThread(connector, row, dueStep, externalBudget);
    } catch (err) {
      console.error(`[verification relances] erreur sur le dossier ${row.thread_id}:`, err);
      recordPipelineError("relance_check", row.thread_id, (err as Error).message);
    }
  }

  for (const row of listThreadsAwaitingClientReply()) {
    if (!row.human_replied_at) continue;
    if (!threadIdMatchesConnector(row.thread_id, connector.name)) continue;

    const { steps } = getEffectiveRelanceSteps(row.thread_id, row.category_id, "post_reply");
    const nextStep = steps[row.post_reply_relance_count];
    const fireAt = nextStep ? new Date(row.human_replied_at).getTime() + nextStep.delayMinutes * 60_000 : null;
    const dueStep = nextStep && fireAt !== null && now >= fireAt ? nextStep : undefined;

    try {
      await checkPostReplyThread(connector, row, dueStep, externalBudget);
    } catch (err) {
      console.error(`[verification relances post-reponse] erreur sur le dossier ${row.thread_id}:`, err);
      recordPipelineError("relance_check", row.thread_id, (err as Error).message);
    }
  }
}

/** Exportee pour permettre un declenchement manuel immediat depuis l'UI admin (voir web/server.ts). */
export async function checkPreReplyThread(
  connector: EmailConnector,
  row: ThreadRow,
  step: RelanceStep | undefined,
  externalBudget: ExternalSendBudget = { remaining: 1 }
): Promise<void> {
  const thread = await tagSource("Messagerie — lecture du fil", () => connector.getThread(row.thread_id));

  // isFromUs seul ne suffit pas: notre propre accuse ET nos propres
  // relances automatiques sont AUSSI des messages isFromUs dans ce meme
  // fil. Matcher un id ou un hash de corps precis s'est revele fragile en
  // production (Gmail/Graph peuvent alterer legerement le texte au
  // round-trip) — on compare a la place le NOMBRE de messages isFromUs
  // reellement presents au nombre qu'on sait avoir envoye nous-memes
  // (automated_outbound_count): au-dela, l'exces est forcement humain, quel
  // que soit son contenu exact. Le dernier message isFromUs du fil (trie
  // chronologiquement) est alors ce message humain.
  const ourMessages = thread.messages.filter((m) => m.isFromUs);
  const replyAfterAck =
    row.ack_sent_at !== null && ourMessages.length > row.automated_outbound_count
      ? ourMessages[ourMessages.length - 1]
      : undefined;

  if (replyAfterAck) {
    // Un humain vient de repondre de fond: ce n'est plus "notre equipe est
    // en retard", c'est desormais "on attend le client" — nouvelle phase.
    // On retient si cette reponse contenait une piece jointe (ex: grille
    // tarifaire) pour que la relance post-reponse puisse y faire reference.
    setThreadHumanReplied(row.thread_id, undefined, replyAfterAck.hasAttachments);
    await cleanupUnusedDrafts(connector, row.thread_id);
    return;
  }

  // Pas de reponse humaine, et aucune etape due pour l'instant (sequence
  // epuisee, ou prochain palier pas encore atteint) — rien de plus a faire
  // ce cycle-ci, mais la detection de reponse ci-dessus aura quand meme
  // tourne.
  if (!step) return;

  if (step.channel === "external") {
    const lastInbound = [...thread.messages].reverse().find((m) => !m.isFromUs);
    if (!lastInbound) {
      recordPipelineError(
        "relance_check",
        row.thread_id,
        "Relance externe annulee: aucun message entrant trouve dans le fil recupere depuis la messagerie."
      );
      return;
    }
    if (!tryConsumeExternalBudget(externalBudget)) {
      console.log(
        `[relance externe] "${row.subject}" — differee (limite de ${config.maxExternalRelancesPerCycle} relances externes/cycle atteinte), retentera au prochain cycle.`
      );
      return; // relance_count intact: reessaie identiquement au prochain cycle
    }
    // lastInbound sert d'ancrage de CONTENU (la demande initiale du client),
    // mais l'en-tete RFC In-Reply-To doit pointer vers le tout dernier
    // message du fil, quel qu'en soit l'auteur — sinon (ex: notre accuse
    // envoye apres lastInbound) la relance "repond" a un message plus ancien
    // que le dernier echange reel, et Gmail la detache dans un nouveau fil
    // au lieu de l'enchainer a la suite de notre accuse.
    const lastMessageInThread = thread.messages[thread.messages.length - 1];

    const category = getCategory(row.category_id);
    const relance = await draftRelance(thread, lastInbound, category, "pre_reply");
    await tagSource("Messagerie — envoi de la relance", () =>
      connector.sendReply({
        threadId: row.thread_id,
        to: row.sender_email,
        subject: buildReplySubject(row.subject),
        bodyText: relance.body,
        inReplyToMessageId: lastMessageInThread.rfcMessageId,
      })
    );
    incrementRelance(row.thread_id, "relance_sent");
    incrementAutomatedOutboundCount(row.thread_id);
    recordReminder(row.thread_id, "external", `Relance envoyee automatiquement a ${row.sender_email}.`);
    console.log(`[relance externe] ${row.sender_email} — "${row.subject}"`);
    return;
  }

  const note = `Dossier "${row.subject}" en attente depuis plus de ${step.delayMinutes} min apres l'echeance — aucune reponse envoyee.`;
  const category = getCategory(row.category_id);
  const shouldAlertTeam =
    category.internalAlertsEnabled && urgencyMeetsThreshold(row.urgency, category.internalAlertsMinUrgency);

  if (shouldAlertTeam) {
    await sendInternalNotification(connector, row, note);
    recordReminder(row.thread_id, "internal", note);
    console.log(`[rappel interne] "${row.subject}" — echeance depassee, a traiter.`);
  } else {
    // Alerte volontairement filtree (categorie/urgence sous le seuil configure
    // dans /reglages) — on avance quand meme la sequence pour ne pas re-evaluer
    // indefiniment la meme etape, mais sans notifier l'equipe pour ne pas
    // noyer sa boite sous des rappels pour des demandes jugees banales.
    recordReminder(row.thread_id, "internal", `${note} (alerte équipe non envoyée — sous le seuil configuré pour "${category.label}")`);
  }
  incrementRelance(row.thread_id, row.status);
}

/** Exportee pour permettre un declenchement manuel immediat depuis l'UI admin (voir web/server.ts). */
export async function checkPostReplyThread(
  connector: EmailConnector,
  row: ThreadRow,
  step: RelanceStep | undefined,
  externalBudget: ExternalSendBudget = { remaining: 1 }
): Promise<void> {
  const thread = await tagSource("Messagerie — lecture du fil", () => connector.getThread(row.thread_id));

  const clientRepliedAfterOurReply =
    row.human_replied_at !== null &&
    thread.messages.some(
      (m) => !m.isFromUs && m.receivedAt.getTime() > new Date(row.human_replied_at as string).getTime()
    );

  if (clientRepliedAfterOurReply) {
    setThreadStatus(row.thread_id, "responded");
    return;
  }

  // Sequence post-reponse epuisee, ou prochain palier pas encore atteint —
  // rien a envoyer ce cycle-ci, mais la detection de reponse client
  // ci-dessus continue de tourner indefiniment tant que le dossier n'est
  // pas cloture, au lieu de s'arreter des la derniere etape configuree.
  if (!step) return;

  if (step.channel === "external") {
    const lastOutbound = [...thread.messages].reverse().find((m) => m.isFromUs);
    if (!lastOutbound) {
      recordPipelineError(
        "relance_check",
        row.thread_id,
        "Relance post-reponse annulee: aucun message sortant trouve dans le fil recupere depuis la messagerie."
      );
      return;
    }
    if (!tryConsumeExternalBudget(externalBudget)) {
      console.log(
        `[relance post-reponse] "${row.subject}" — differee (limite de ${config.maxExternalRelancesPerCycle} relances externes/cycle atteinte), retentera au prochain cycle.`
      );
      return; // post_reply_relance_count intact: reessaie identiquement au prochain cycle
    }

    const category = getCategory(row.category_id);
    const relance = await draftRelance(
      thread,
      lastOutbound,
      category,
      "post_reply",
      row.outbound_had_attachment === 1
    );
    await tagSource("Messagerie — envoi de la relance", () =>
      connector.sendReply({
        threadId: row.thread_id,
        to: row.sender_email,
        subject: buildReplySubject(row.subject),
        bodyText: relance.body,
        inReplyToMessageId: lastOutbound.rfcMessageId,
      })
    );
    incrementPostReplyRelance(row.thread_id, "post_reply_relance_sent");
    incrementAutomatedOutboundCount(row.thread_id);
    recordReminder(
      row.thread_id,
      "external",
      `Relance post-reponse envoyee a ${row.sender_email} (suivi de notre reponse).`
    );
    console.log(`[relance post-reponse] ${row.sender_email} — "${row.subject}"`);
    return;
  }

  const note = `Dossier "${row.subject}": client silencieux depuis plus de ${step.delayMinutes} min apres notre reponse.`;
  const category = getCategory(row.category_id);
  const shouldAlertTeam =
    category.internalAlertsEnabled && urgencyMeetsThreshold(row.urgency, category.internalAlertsMinUrgency);

  if (shouldAlertTeam) {
    await sendInternalNotification(connector, row, note);
    recordReminder(row.thread_id, "internal", note);
    console.log(`[rappel interne post-reponse] "${row.subject}" — client silencieux.`);
  } else {
    recordReminder(row.thread_id, "internal", `${note} (alerte équipe non envoyée — sous le seuil configuré pour "${category.label}")`);
  }
  incrementPostReplyRelance(row.thread_id, row.status);
}

/**
 * L'equipe qui recoit ces rappels n'a pas forcement acces a l'application
 * admin — pointer vers "Registre des dossiers" n'aide personne. Un lien de
 * recherche direct dans la messagerie (qu'ils utilisent deja au quotidien)
 * est bien plus utile pour retrouver l'echange precis, surtout quand
 * plusieurs dossiers de la meme categorie se ressemblent.
 */
function mailboxSearchHint(connector: EmailConnector, row: ThreadRow): string {
  const query = `from:(${row.sender_email}) OR subject:(${row.subject})`;
  if (connector.name === "gmail") {
    return `Retrouver l'échange: https://mail.google.com/mail/u/0/#search/${encodeURIComponent(query)}`;
  }
  return `Retrouvez l'échange dans la messagerie en recherchant l'expéditeur (${row.sender_email}) ou l'objet ("${row.subject}").`;
}

/**
 * Envoie une vraie notification email pour un rappel interne — auparavant
 * seulement journalise en base (invisible sans ouvrir l'application). Part
 * vers NOTIFICATION_EMAIL si defini, sinon vers la messagerie connectee
 * elle-meme (un pense-bete dans sa propre boite). Best-effort: un echec
 * d'envoi ne doit pas empecher le rappel d'etre journalise normalement.
 */
async function sendInternalNotification(connector: EmailConnector, row: ThreadRow, note: string): Promise<void> {
  try {
    const ownEmail = await connector.getOwnEmailAddress();
    const to = config.notificationEmail || ownEmail;
    const categoryLabel = getCategory(row.category_id).label;
    const sent = await connector.sendNotification({
      to,
      subject: `[Rappel] ${row.subject}`,
      bodyText: [
        note,
        "",
        `Objet: ${row.subject}`,
        `Client: ${row.sender_name ? `${row.sender_name} ` : ""}<${row.sender_email}>`,
        `Categorie: ${categoryLabel}`,
        "",
        mailboxSearchHint(connector, row),
      ].join("\n"),
    });
    // Un rappel interne est envoye sans threadId (voir sendNotification), donc
    // Gmail/Graph lui creent son propre fil — qui apparait ensuite dans
    // "Envoyes" comme n'importe quel autre email. Sans ce marquage,
    // discoverOutbound.ts le voit au cycle suivant, ne le trouve dans aucun
    // dossier existant, et l'enregistre a tort comme un nouveau dossier
    // "envoye a froid" (avec le destinataire du rappel comme faux client).
    // sent.id sert de threadId de remplacement: ce rappel n'appartient a
    // aucun dossier reel, seul le marquage "deja traite" compte ici.
    markMessageProcessed(sent.id, sent.id);
  } catch (err) {
    recordPipelineError(
      "relance_check",
      row.thread_id,
      `Echec envoi de la notification de rappel interne: ${(err as Error).message}`
    );
  }
}
