import { deleteDraftRows, listDraftsForThread, recordPipelineError } from "../db.js";
import type { EmailConnector } from "../types.js";

/**
 * Supprime les brouillons deposes pour un dossier (les 3 propositions de
 * reponse) une fois qu'ils ne sont plus utiles: le dossier a ete resolu
 * autrement (un seul brouillon envoye, ou reponse hors brouillon), donc les
 * autres resteraient a jamais dans le dossier "Brouillons" de la messagerie.
 * Chaque suppression est independante — l'echec de l'une (deja envoyee,
 * deja supprimee a la main) n'empeche pas les autres, et n'est pas fatal.
 */
export async function cleanupUnusedDrafts(connector: EmailConnector, threadId: string): Promise<number> {
  const drafts = listDraftsForThread(threadId);
  let cleaned = 0;
  for (const draft of drafts) {
    try {
      await connector.deleteDraft(draft.connector_draft_id);
      cleaned++;
    } catch (err) {
      recordPipelineError(
        "draft_cleanup",
        threadId,
        `Echec suppression brouillon ${draft.connector_draft_id}: ${(err as Error).message}`
      );
    }
  }
  deleteDraftRows(threadId);
  return cleaned;
}
