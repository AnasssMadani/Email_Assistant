import { getCategory } from "../settings.js";
import { analyzeCategoryCorpus } from "../ai/analyzeCorpus.js";
import {
  listCategoriesWithCorpus,
  listHumanReplyCorpusByCategory,
  recordPipelineError,
  setCategoryPlaybook,
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
