import { eq } from "drizzle-orm";
import { getDb, modelPricing } from "@global-link/db";
import type { AiUsage } from "./types.js";

/**
 * Fallback prices if `model_pricing` has no row yet for a model — TODO verify
 * against the current Anthropic pricing page before relying on these for a real
 * invoice; they exist so /consommation shows a number instead of crashing on an
 * unseeded table, not as a source of truth. Seed `model_pricing` per environment
 * instead of editing this map.
 */
const FALLBACK_PRICING: Record<string, { inputPerMillionTokensUsd: number; outputPerMillionTokensUsd: number }> = {
  "claude-haiku-4-5-20251001": { inputPerMillionTokensUsd: 1, outputPerMillionTokensUsd: 5 },
  "claude-sonnet-5": { inputPerMillionTokensUsd: 3, outputPerMillionTokensUsd: 15 },
};

export async function getModelPricing(
  model: string
): Promise<{ inputPerMillionTokensUsd: number; outputPerMillionTokensUsd: number }> {
  const db = getDb();
  const [row] = await db.select().from(modelPricing).where(eq(modelPricing.model, model)).limit(1);
  if (row) return row;
  return FALLBACK_PRICING[model] ?? { inputPerMillionTokensUsd: 3, outputPerMillionTokensUsd: 15 };
}

/** Cached input tokens are billed separately (Anthropic prompt caching reads at ~10% of the base input rate) — approximated here as 10% until model_pricing carries a distinct cached rate column. */
export async function estimateCostUsd(model: string, usage: AiUsage): Promise<number> {
  const pricing = await getModelPricing(model);
  const uncachedInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const cachedCost = (usage.cachedInputTokens / 1_000_000) * pricing.inputPerMillionTokensUsd * 0.1;
  const inputCost = (uncachedInput / 1_000_000) * pricing.inputPerMillionTokensUsd;
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.outputPerMillionTokensUsd;
  return inputCost + cachedCost + outputCost;
}
