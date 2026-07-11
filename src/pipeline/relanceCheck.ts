import { getCategory, loadCategories } from "../config.js";
import { draftRelance } from "../ai/draftRelance.js";
import {
  incrementRelance,
  listThreadsAwaitingReply,
  recordReminder,
  setThreadStatus,
  type ThreadRow,
} from "../db.js";
import type { EmailConnector } from "../types.js";

/**
 * Verifie, pour chaque dossier ouvert, si le delai (due_at) est depasse sans
 * qu'une reponse ait ete envoyee depuis l'accuse de reception. Si c'est le
 * cas: un rappel interne est journalise (a brancher sur Slack/Teams/email
 * d'equipe), ou une relance externe est envoyee au demandeur si la
 * categorie l'autorise et qu'un premier rappel interne est deja passe.
 */
export async function runRelanceCheck(connector: EmailConnector): Promise<void> {
  const { relance } = loadCategories();
  const now = Date.now();
  const cooldownMs = relance.internalReminderAfterHours * 3600_000;

  for (const row of listThreadsAwaitingReply()) {
    if (row.relance_count >= relance.maxRelances) continue;
    if (!row.due_at || new Date(row.due_at).getTime() > now) continue;
    if (row.last_relance_at && now - new Date(row.last_relance_at).getTime() < cooldownMs) continue;

    await checkThread(connector, row);
  }
}

async function checkThread(connector: EmailConnector, row: ThreadRow): Promise<void> {
  const category = getCategory(row.category_id);
  const thread = await connector.getThread(row.thread_id);

  const repliedAfterAck =
    row.ack_sent_at !== null &&
    thread.messages.some(
      (m) => m.isFromUs && m.receivedAt.getTime() > new Date(row.ack_sent_at as string).getTime()
    );

  if (repliedAfterAck) {
    setThreadStatus(row.thread_id, "responded");
    return;
  }

  const lastInbound = [...thread.messages].reverse().find((m) => !m.isFromUs);
  const isExternalStep = category.allowExternalRelance && row.relance_count >= 1;

  if (isExternalStep && lastInbound) {
    const relance = await draftRelance(thread, lastInbound, category);
    await connector.sendReply({
      threadId: row.thread_id,
      to: row.sender_email,
      subject: relance.subject,
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
    `Dossier "${row.subject}" en attente depuis plus de ${category.slaHours}h — aucune reponse envoyee.`
  );
  console.log(`[rappel interne] "${row.subject}" — echeance depassee, a traiter.`);
}
