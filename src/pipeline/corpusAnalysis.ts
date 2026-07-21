import { saveCategoryPlaybook } from "../config.js";
import { getCategory } from "../settings.js";
import { analyzeCategoryCorpus } from "../ai/analyzeCorpus.js";
import { listCategoriesWithCorpus, listHumanReplyCorpusByCategory, recordPipelineError } from "../db.js";

/**
 * Relit le corpus des vraies reponses de l'equipe (voir relanceCheck.ts,
 * recordHumanReplyCorpus) categorie par categorie, et regenere la note de
 * style de chacune (config/category-playbooks/<id>.md) — relue ensuite par
 * draftAcknowledgement.ts. Une categorie sans corpus est simplement ignoree
 * ce cycle-ci (pas encore de vraie reponse a apprendre).
 */
export async function runCorpusAnalysis(): Promise<void> {
  for (const categoryId of listCategoriesWithCorpus()) {
    const replies = listHumanReplyCorpusByCategory(categoryId);
    if (replies.length === 0) continue;

    try {
      const category = getCategory(categoryId);
      const analysis = await analyzeCategoryCorpus(category.label, replies);
      saveCategoryPlaybook(
        categoryId,
        [
          `# Style observe — ${category.label}`,
          "",
          `_Genere automatiquement a partir de ${replies.length} reponse(s) reelle(s) de l'equipe.`,
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
      recordPipelineError("corpus_analysis", null, (err as Error).message);
    }
  }
}
