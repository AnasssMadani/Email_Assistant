import { draftReply } from "../ai/draftReply.js";
import { config } from "../config.js";
import { countReplyDraftsLast24h, listThreadAttachments, recordPipelineError, saveReplyDraft } from "../db.js";
import type { ReplyDraftRow } from "../db.js";
import type { CategoryConfig, EmailMessage, EmailThread } from "../types.js";

/**
 * Redige et enregistre le brouillon de reponse d'un message. Le brouillon
 * reste dans l'application (table reply_drafts, page du dossier): aucun
 * envoi, aucune ecriture dans la boite mail — rien ici n'appelle
 * sendReply/sendNotification, donc rien n'a a passer par isSendAllowed.
 */
export async function draftAndStoreReply(params: {
  thread: EmailThread;
  incoming: EmailMessage;
  category: CategoryConfig;
  source: "auto" | "manuel";
}): Promise<void> {
  const { thread, incoming, category, source } = params;
  // Les pieces jointes ne sont lues qu'a l'arrivee: pour un dossier relu plus
  // tard (bouton manuel), on les reprend de la base.
  const stored = incoming.attachments?.length
    ? incoming.attachments
    : (await listThreadAttachments(thread.id)).filter((a) => a.messageId === incoming.id);
  const draft = await draftReply({ thread, incoming, category, attachments: stored });
  await saveReplyDraft({
    threadId: thread.id,
    messageId: incoming.id,
    categoryId: category.id,
    shouldReply: draft.shouldReply,
    reason: draft.reason,
    subject: draft.subject,
    body: draft.body,
    missing: draft.missing,
    confidence: draft.confidence,
    source,
  });
}

/**
 * Brouillon automatique d'un email suivi, si ENABLE_DRAFT_REPLIES est actif.
 * Ne bloque et ne fait echouer jamais le traitement de l'email: une erreur
 * IA ou le plafond quotidien (cout) se contentent de s'inscrire au Journal.
 */
export async function maybeAutoDraftReply(thread: EmailThread, incoming: EmailMessage, category: CategoryConfig): Promise<void> {
  if (!config.draftRepliesEnabled || config.draftRepliesMaxPerDay <= 0) return;
  try {
    if ((await countReplyDraftsLast24h()) >= config.draftRepliesMaxPerDay) return;
    await draftAndStoreReply({ thread, incoming, category, source: "auto" });
  } catch (err) {
    await recordPipelineError("reply_draft", thread.id, (err as Error).message);
  }
}

export type { ReplyDraftRow };
