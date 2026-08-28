import Anthropic from "@anthropic-ai/sdk";
import { requireAnthropicApiKey, AiStructuredOutputError } from "@global-link/shared";
import { modelForTask } from "./router.js";
import type { LLMProvider, StructuredGenerateParams, StructuredGenerateResult, AiUsage } from "./types.js";

/**
 * The ONLY file in the platform allowed to import @anthropic-ai/sdk — see
 * CLAUDE.md and docs/architecture/refonte-plan.md "Model gateway". Every other
 * package calls the LLMProvider interface in types.ts. This is what lets a second
 * provider be added later (per the master brief §11) by adding one more file here,
 * with zero changes to packages/core.
 */

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: requireAnthropicApiKey() });
  }
  return client;
}

function toUsage(usage: Anthropic.Usage): AiUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cachedInputTokens: usage.cache_read_input_tokens ?? 0,
  };
}

async function structuredGenerateOnce<T>(
  params: StructuredGenerateParams<T>
): Promise<StructuredGenerateResult<T>> {
  const model = modelForTask(params.task);
  const tool: Anthropic.Tool = {
    name: params.toolName,
    description: params.toolDescription,
    input_schema: {
      type: "object",
      properties: params.inputSchema.properties as Record<string, unknown>,
      required: params.inputSchema.required as string[] | undefined,
    },
  };

  // Static system content gets cache_control so repeated calls (same category
  // list/brand voice for every email of the day) read at the cached-input rate —
  // see types.ts SystemPrompt. Anthropic requires system content as a content-block
  // array (not a plain string) for cache_control to apply to a specific block.
  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: params.system.static, cache_control: { type: "ephemeral" } },
  ];
  if (params.system.dynamic) {
    system.push({ type: "text", text: params.system.dynamic });
  }

  const response = await getClient().messages.create({
    model,
    max_tokens: params.maxTokens ?? 1024,
    system,
    tools: [tool],
    tool_choice: { type: "tool", name: params.toolName },
    messages: [{ role: "user", content: params.userContent }],
  });

  const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!toolUse) {
    throw new Error(`Model returned no tool_use block for "${params.toolName}".`);
  }
  const data = params.schema.parse(toolUse.input);
  return { data, usage: toUsage(response.usage), model };
}

/**
 * Retries once on any failure (transient generation error, or the model's raw
 * tool_use.input failing `params.schema` validation — a truncated/malformed
 * response is not guaranteed to conform, see legacy's withRetry). Exhausting
 * retries throws AiStructuredOutputError; the caller MUST fall back to human
 * review, never trust a best-effort partial result (see master brief §12).
 */
async function structuredGenerateWithRetry<T>(
  params: StructuredGenerateParams<T>,
  attempts = 2
): Promise<StructuredGenerateResult<T>> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await structuredGenerateOnce(params);
    } catch (err) {
      lastError = err;
    }
  }
  throw new AiStructuredOutputError(params.toolName, lastError);
}

export function createAnthropicProvider(): LLMProvider {
  return {
    structuredGenerate: (params) => structuredGenerateWithRetry(params),
    async embed() {
      // Phase 3+ (knowledge/pgvector) — Anthropic has no first-party embeddings
      // endpoint; the intended provider is Voyage AI. Not wired to any caller in
      // Phase 0–2, so left as an explicit TODO rather than a fake implementation
      // (see docs/architecture/FUTURE_ROADMAP.md Phase 3.3, and CLAUDE.md §35 on
      // not presenting placeholder code as production-ready).
      throw new Error("embed() is not implemented — Phase 3 (knowledge base) work, not yet started.");
    },
  };
}
