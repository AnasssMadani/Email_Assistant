import { loadConfig } from "@global-link/shared";
import type { StructuredGenerateParams } from "./types.js";

/**
 * Model routing by task, as configuration (env vars), not code — see
 * docs/architecture/refonte-plan.md "The cost model". Classification runs on a
 * cheap/small model (default Haiku); drafts a human will review run on the strong
 * model (default Sonnet). Never hardcode a model name in a caller — always go
 * through this.
 */
export function modelForTask(task: StructuredGenerateParams<unknown>["task"]): string {
  const env = loadConfig();
  return task === "classification" ? env.CLASSIFY_MODEL : env.DRAFT_MODEL;
}
