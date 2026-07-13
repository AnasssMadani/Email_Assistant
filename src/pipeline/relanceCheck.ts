import { getCategory } from "../settings.js";
import { draftRelance } from "../ai/draftRelance.js";
import { cleanupUnusedDrafts } from "./draftCleanup.js";
import { buildReplySubject } from "../utils.js";
import {
  getEffectiveRelanceSteps,
  incrementRelance,
  listThreadsAwaitingReply,
  recordPipelineError,
  recordReminder,
  setThreadStatus,
  type ThreadRow,
} from "../db.js";
import type { EmailConnector, RelanceStep } from "../types.js";

/**
 * Verifie, pour chaque dossier ouvert, si la prochaine etape de sa sequence
 * de relance (celle du dossier si une surcharge existe, sinon celle de sa
 * categorie) est arrivee a echeance (due_at + delayMinutes de l'etape).
 * relance_count sert d'index dans la sequence: chaque execution — qu'elle
 * soit un simple rappel interne journalise ou une relance externe envoyee
 * au demandeur, selon le "channel" de l'etape — avance au dossier a
 * l'etape suivante. Une sequence vide ou epuisee ne declenche plus rien.
 */
export async function runRelanceCheck(connector: EmailConnector): Promise<void> {
  const now = Date.now();

  for (const row of listThreadsAwaitingReply()) {
    if (!row.due_at) continue;

    const { steps } = getEffectiveRelanceSteps(row.thread_id, row.category_id);
    const nextStep = steps[row.relance_count];
    if (!nextStep) continue;

    const fireAt = new Date(row.due_at).getTime() + nextStep.delayMinutes * 60_000;
    if (now < fireAt) continue;

    // Isole chaque dossier: un echec (Claude, API email, dossier corrompu)
    // ne doit jamais empecher la verification des autres dossiers du cycle.
    try {
      await checkThread(connector, row, nextStep);
    } catch (err) {
      console.error(`[verification relances] erreur sur le dossier ${row.thread_id}:`, err);
      recordPipelineError("relance_check", row.thread_id, (err as Error).message);
    }
  }
}

/** Exportee pour permettre un declenchement manuel immediat d'une seule etape depuis l'UI admin (voir web/server.ts). */
export async function checkThread(connector: EmailConnector, row: ThreadRow, step: RelanceStep): Promise<void> {
  const thread = await connector.getThread(row.thread_id);

  const repliedAfterAck =
    row.ack_sent_at !== null &&
    thread.messages.some(
      (m) => m.isFromUs && m.receivedAt.getTime() > new Date(row.ack_sent_at as string).getTime()
    );

  if (repliedAfterAck) {
    setThreadStatus(row.thread_id, "responded");
    await cleanupUnusedDrafts(connector, row.thread_id);
    return;
  }

  if (step.channel === "external") {
    const lastInbound = [...thread.messages].reverse().find((m) => !m.isFromUs);
    if (!lastInbound) return;

    const category = getCategory(row.category_id);
    const relance = await draftRelance(thread, lastInbound, category);
    await connector.sendReply({
      threadId: row.thread_id,
      to: row.sender_email,
      subject: buildReplySubject(row.subject),
      bodyText: relance.body,
      inReplyToMessageId: lastInbound.rfcMessageId,
    });
    incrementRelance(row.thread_id, "relance_sent");
    recordReminder(row.thread_id, "external", "Relance envoyee automatiquement au demandeur.");
    console.log(`[relance externe] ${row.sender_email} — "${row.subject}"`);
    return;
  }

  incrementRelance(row.thread_id, row.status);
  recordReminder(
    row.thread_id,
    "internal",
    `Dossier "${row.subject}" en attente depuis plus de ${step.delayMinutes} min apres l'echeance — aucune reponse envoyee.`
  );
  console.log(`[rappel interne] "${row.subject}" — echeance depassee, a traiter.`);
}
