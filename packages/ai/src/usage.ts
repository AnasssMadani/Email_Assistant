import { withOrg, aiUsageEvents } from "@global-link/db";
import type { AiUsage } from "./types.js";

/**
 * One row per model call, per-model (not a single global rate) — fixes the legacy
 * app's `/consommation` bug where `config.pricing` was one global input/output pair
 * even though `ai_usage_events.model` was already per-row. The moment two models
 * are in use (Haiku for classification, Sonnet for opt-in drafts), that global rate
 * silently mis-prices everything; see docs/architecture/refonte-plan.md.
 */
export async function recordAiUsage(params: {
  organizationId: string;
  callType: string;
  threadId: string | null;
  model: string;
  usage: AiUsage;
}): Promise<void> {
  await withOrg(params.organizationId, async (db) => {
    await db.insert(aiUsageEvents).values({
      organizationId: params.organizationId,
      callType: params.callType,
      threadId: params.threadId,
      model: params.model,
      inputTokens: params.usage.inputTokens,
      outputTokens: params.usage.outputTokens,
      cachedInputTokens: params.usage.cachedInputTokens,
    });
  });
}
