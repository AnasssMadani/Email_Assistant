import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { extractTeamReplies } from "../ai/extractTeamReplies.js";
import {
  corpusHasReply,
  deleteCategoryPlaybook,
  deleteCorpusBatch,
  listHumanReplyCorpusByCategory,
  listCategories,
  recordHumanReplyCorpus,
} from "../db.js";
import { stripQuotedHistory } from "./emailText.js";
import { runCorpusAnalysisFor } from "./corpusAnalysis.js";

/** Seuils de maturité d'une catégorie (nombre d'exemples de réponses réelles de l'équipe). */
export const LEARNING_MIN_EXAMPLES = 3;
export const LEARNING_READY_EXAMPLES = 10;

export type LearningLevel = "vide" | "debut" | "en_cours" | "pret";

export interface LearningStatus {
  level: LearningLevel;
  label: string;
  /** 0 à 100: avancement vers LEARNING_READY_EXAMPLES. */
  progressPct: number;
  /** Ce qu'il manque, en une phrase. */
  hint: string;
}

/**
 * Niveau de maturité d'une catégorie. "Prêt" exige à la fois assez
 * d'exemples ET une note de style déjà générée: sans note, l'IA n'a encore
 * rien appris de ces exemples.
 */
export function learningStatus(examples: number, hasPlaybook: boolean): LearningStatus {
  const progressPct = Math.min(100, Math.round((examples / LEARNING_READY_EXAMPLES) * 100));
  if (examples === 0) {
    return { level: "vide", label: "Rien appris", progressPct, hint: `Collez au moins ${LEARNING_MIN_EXAMPLES} réponses de l'équipe.` };
  }
  if (examples < LEARNING_MIN_EXAMPLES) {
    return { level: "debut", label: "Début", progressPct, hint: `Encore ${LEARNING_MIN_EXAMPLES - examples} exemple(s) avant une première note de style.` };
  }
  if (examples < LEARNING_READY_EXAMPLES || !hasPlaybook) {
    return {
      level: "en_cours",
      label: "En apprentissage",
      progressPct,
      hint: !hasPlaybook
        ? "Lancez « Analyser » pour générer la note de style."
        : `Encore ${LEARNING_READY_EXAMPLES - examples} exemple(s) pour être fiable.`,
    };
  }
  return { level: "pret", label: "Prêt", progressPct, hint: "Assez d'exemples et note de style à jour." };
}

export interface LearningImportResult {
  batchId: string | null;
  threadsSeen: number;
  repliesLearned: number;
  duplicatesSkipped: number;
  byCategory: Array<{ categoryId: string; label: string; count: number }>;
}

const MIN_REPLY_CHARS = 30;
const MAX_REPLY_CHARS = 3000;

/**
 * Apprentissage manuel: extrait les réponses de l'équipe de fils collés,
 * les range par catégorie (source "manuel", un lot annulable) et régénère
 * tout de suite la note de style des seules catégories touchées.
 */
export async function learnFromPastedThreads(text: string, teamHint: string): Promise<LearningImportResult> {
  const categories = await listCategories();
  const known = new Map(categories.map((c) => [c.id, c.label]));
  const fallback = known.has("autre") ? "autre" : categories[0]?.id;
  const ownDomains = config.imap.ownDomains.length
    ? config.imap.ownDomains
    : config.imap.mailboxAddress.includes("@")
      ? [config.imap.mailboxAddress.split("@")[1].toLowerCase()]
      : [];

  const threads = await extractTeamReplies({
    text,
    categories: categories.map((c) => ({ id: c.id, label: c.label })),
    teamHint: teamHint.trim().slice(0, 300),
    ownDomains,
  });

  const batchId = randomUUID();
  const counts = new Map<string, number>();
  let learned = 0;
  let duplicates = 0;
  let index = 0;
  for (const thread of threads) {
    index++;
    const categoryId = known.has(thread.categoryId) ? thread.categoryId : fallback;
    if (!categoryId) continue;
    for (const raw of thread.teamReplies) {
      const body = stripQuotedHistory(raw).trim().slice(0, MAX_REPLY_CHARS);
      if (body.length < MIN_REPLY_CHARS) continue;
      if (await corpusHasReply(categoryId, body)) {
        duplicates++;
        continue;
      }
      await recordHumanReplyCorpus({
        threadId: `manuel:${batchId}:${index}`,
        categoryId,
        replyBody: body,
        source: "manuel",
        batchId,
        clientAsk: thread.clientAsk.trim().slice(0, 300),
      });
      learned++;
      counts.set(categoryId, (counts.get(categoryId) ?? 0) + 1);
    }
  }

  if (counts.size > 0) await runCorpusAnalysisFor([...counts.keys()]);

  return {
    batchId: learned > 0 ? batchId : null,
    threadsSeen: threads.length,
    repliesLearned: learned,
    duplicatesSkipped: duplicates,
    byCategory: [...counts.entries()].map(([categoryId, count]) => ({
      categoryId,
      label: known.get(categoryId) ?? categoryId,
      count,
    })),
  };
}

/** Annule un import: supprime ses exemples puis refait (ou retire) la note de style des catégories touchées. */
export async function undoLearningBatch(batchId: string): Promise<void> {
  const touched = await deleteCorpusBatch(batchId);
  await refreshPlaybooks(touched);
}

export async function refreshPlaybooks(categoryIds: string[]): Promise<void> {
  const stillHaveExamples: string[] = [];
  for (const id of categoryIds) {
    if ((await listHumanReplyCorpusByCategory(id)).length === 0) await deleteCategoryPlaybook(id);
    else stillHaveExamples.push(id);
  }
  if (stillHaveExamples.length > 0) await runCorpusAnalysisFor(stillHaveExamples);
}

