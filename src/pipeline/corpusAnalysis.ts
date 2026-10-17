import { getCategory } from "../settings.js";
import { analyzeCategoryCorpus } from "../ai/analyzeCorpus.js";
import {
  listAllHumanReplyCorpus,
  listCategoriesWithCorpus,
  listHumanReplyCorpusByCategory,
  recordPipelineError,
  setCategoryPlaybook,
  TEAM_PLAYBOOK_ID,
} from "../db.js";

/**
 * Relit le corpus des vraies reponses de l'equipe (voir relanceCheck.ts,
 * recordHumanReplyCorpus) categorie par categorie, et regenere la note de
 * style de chacune (table category_playbooks) — relue ensuite par
 * draftAcknowledgement.ts. Une categorie sans corpus est simplement ignoree
 * ce cycle-ci (pas encore de vraie reponse a apprendre).
 */
export async function runCorpusAnalysis(): Promise<void> {
  await runCorpusAnalysisFor(await listCategoriesWithCorpus());
}

/** Même analyse, limitée aux catégories données (import manuel: seules celles touchées sont refaites). */
export async function runCorpusAnalysisFor(categoryIds: string[]): Promise<void> {
  if (categoryIds.length > 0) await runTeamStyleAnalysis();
  for (const categoryId of categoryIds) {
    const allReplies = await listHumanReplyCorpusByCategory(categoryId);
    if (allReplies.length === 0) continue;
    // Les 30 plus recentes suffisent a une note de style, et bornent le cout.
    const replies = allReplies.slice(-30);

    try {
      const category = await getCategory(categoryId);
      const analysis = await analyzeCategoryCorpus(category.label, replies);
      await setCategoryPlaybook(
        categoryId,
        [
          `# Style observe — ${category.label}`,
          "",
          `_Genere automatiquement a partir de ${replies.length} reponse(s) reelle(s) de l'equipe (sur ${allReplies.length} apprises).`,
          `Pas un "fine-tuning" — un resume d'exemples curates, relu par le prompt de redaction._`,
          "",
          "## Ton",
          "",
          analysis.tone,
          "",
          "## Structure typique",
          "",
          analysis.structure,
          "",
        ].join("\n")
      );
      console.log(`[analyse corpus] note de style mise a jour pour "${category.label}" (${replies.length} exemples).`);
    } catch (err) {
      console.error(`[analyse corpus] erreur categorie ${categoryId}:`, err);
      await recordPipelineError("corpus_analysis", null, (err as Error).message);
    }
  }
}

/**
 * Note de style generale de l'equipe, toutes categories confondues: une
 * categorie qui n'a encore aucune reponse apprise (nouvelle categorie, ou
 * peu frequente) s'en sert a la place de sa propre note (voir
 * draftAcknowledgement.ts). L'equipe ecrit de la meme facon quel que soit
 * le sujet ("Hi dear", "Well noted with thanks", meme signature).
 */
async function runTeamStyleAnalysis(): Promise<void> {
  const allReplies = await listAllHumanReplyCorpus();
  if (allReplies.length === 0) return;
  const replies = allReplies.slice(-40);
  try {
    const analysis = await analyzeCategoryCorpus("toutes les demandes", replies);
    await setCategoryPlaybook(
      TEAM_PLAYBOOK_ID,
      [
        "# Style observe — equipe (toutes categories)",
        "",
        `_Genere automatiquement a partir de ${replies.length} reponse(s) reelle(s) de l'equipe, historique cite retire._`,
        "",
        "## Ton",
        "",
        analysis.tone,
        "",
        "## Structure typique",
        "",
        analysis.structure,
        "",
      ].join("\n")
    );
  } catch (err) {
    console.error("[analyse corpus] erreur note generale:", err);
    await recordPipelineError("corpus_analysis", null, (err as Error).message);
  }
}
