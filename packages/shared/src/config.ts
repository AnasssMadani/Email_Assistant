import { z } from "zod";
import { ConfigError } from "./errors.js";

/**
 * Every env var the platform reads, in one validated place — replaces the legacy
 * app's `src/config.ts` (per-field `??` defaults, no cross-field validation). Parsed
 * once per process; a missing *required* var fails fast at startup with a clear
 * message rather than surfacing as `undefined` deep in a pipeline call.
 *
 * Not every app needs every field (the web dashboard never touches
 * ANTHROPIC_API_KEY), so required-ness is enforced at the point of use via the
 * `require*` helpers below, not by zod `.min(1)` here — a worker-only var being unset
 * must not crash the web app at import time.
 */
const envSchema = z.object({
  NODE_ENV: z.string().optional(),

  // Supabase Postgres — see docs/architecture/refonte-plan.md "Multi-tenancy".
  // DATABASE_URL is the pooled (pgbouncer) connection string for apps/workers;
  // DIRECT_DATABASE_URL (no pooler) is required for Drizzle migrations.
  DATABASE_URL: z.string().optional(),
  DIRECT_DATABASE_URL: z.string().optional(),
  SUPABASE_URL: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  /** Project Settings → API → JWT Secret in Supabase — used to verify the HS256 access tokens Supabase Auth issues, see packages/auth. */
  SUPABASE_JWT_SECRET: z.string().optional(),

  ANTHROPIC_API_KEY: z.string().optional(),
  // Per-task model routing (see packages/ai) — cheap model for classification,
  // strong model for reasoning/drafts a human will review. Both overridable so a
  // pricing/quality change never requires a code deploy.
  CLASSIFY_MODEL: z.string().default("claude-haiku-4-5-20251001"),
  DRAFT_MODEL: z.string().default("claude-sonnet-5"),

  ENCRYPTION_KEY: z.string().optional(),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().optional(),

  AZURE_CLIENT_ID: z.string().optional(),
  AZURE_CLIENT_SECRET: z.string().optional(),
  AZURE_TENANT_ID: z.string().default("common"),
  AZURE_REDIRECT_URI: z.string().optional(),

  API_PORT: z.coerce.number().default(4400),
  WEB_PORT: z.coerce.number().default(4300),

  APP_TIMEZONE: z.string().default("Africa/Casablanca"),

  MAX_EXTERNAL_RELANCES_PER_CYCLE: z.coerce.number().default(5),
  SHADOW_MODE: z
    .string()
    .optional()
    .transform((v) => v === "true"),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function loadConfig(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new ConfigError(`Invalid environment configuration: ${parsed.error.message}`);
  }
  cached = parsed.data;
  return cached;
}

function requireField(name: keyof Env): string {
  const value = loadConfig()[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new ConfigError(`Missing required environment variable: ${String(name)}.`);
  }
  return value;
}

export function requireDatabaseUrl(): string {
  return requireField("DATABASE_URL");
}

export function requireAnthropicApiKey(): string {
  return requireField("ANTHROPIC_API_KEY");
}

export function requireEncryptionKey(): string {
  return requireField("ENCRYPTION_KEY");
}

export function requireSupabaseJwtSecret(): string {
  return requireField("SUPABASE_JWT_SECRET");
}

export function isProductionLike(): boolean {
  return loadConfig().NODE_ENV === "production";
}
