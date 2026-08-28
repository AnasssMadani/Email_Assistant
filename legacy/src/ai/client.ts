import Anthropic from "@anthropic-ai/sdk";
import { requireAnthropicApiKey } from "../config.js";

export const CLAUDE_MODEL = "claude-sonnet-5";

let client: Anthropic | null = null;

export function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: requireAnthropicApiKey() });
  }
  return client;
}
