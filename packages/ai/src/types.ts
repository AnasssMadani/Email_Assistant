import type { z } from "zod";

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

/**
 * Split system prompt: `static` is byte-identical across calls of the same task
 * (category list, brand voice, org instructions) and gets `cache_control` so
 * repeated calls read it at the cached-input rate; `dynamic` (if any) is
 * request-specific and never cached. See docs/architecture/refonte-plan.md "The
 * cost model" — this split is what makes prompt caching actually fire.
 */
export interface SystemPrompt {
  static: string;
  dynamic?: string;
}

export interface StructuredGenerateParams<T> {
  task: "classification" | "draft";
  system: SystemPrompt;
  userContent: string;
  schema: z.ZodType<T>;
  toolName: string;
  toolDescription: string;
  /** JSON Schema `properties`/`required` for the tool's input_schema — kept provider-shaped here deliberately; callers already write this for Anthropic tool_use today. */
  inputSchema: Record<string, unknown>;
  maxTokens?: number;
}

export interface StructuredGenerateResult<T> {
  data: T;
  usage: AiUsage;
  model: string;
}

/**
 * Provider-independent AI gateway. Every caller in packages/core imports THIS
 * interface, never a provider SDK directly — see anthropicProvider.ts, the only
 * file in the platform allowed to import @anthropic-ai/sdk.
 */
export interface LLMProvider {
  structuredGenerate<T>(params: StructuredGenerateParams<T>): Promise<StructuredGenerateResult<T>>;
  /** Phase 3+ (knowledge/pgvector) — not wired to any caller yet, see FUTURE_ROADMAP.md. */
  embed(texts: string[]): Promise<number[][]>;
}
