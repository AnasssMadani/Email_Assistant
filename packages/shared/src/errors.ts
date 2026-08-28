/**
 * Typed error hierarchy — every error thrown across apps/packages should be one of
 * these (or a subclass), never a bare `Error`, so callers can branch on `.code`
 * instead of parsing messages.
 */
export type ErrorCode =
  | "CONFIG_MISSING"
  | "VALIDATION_FAILED"
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "TENANT_MISMATCH"
  | "PROVIDER_ERROR"
  | "PROVIDER_RATE_LIMITED"
  | "AI_STRUCTURED_OUTPUT_INVALID"
  | "QUEUE_ERROR";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly cause?: unknown;

  constructor(code: ErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.cause = cause;
  }
}

export class ConfigError extends AppError {
  constructor(message: string) {
    super("CONFIG_MISSING", message);
    this.name = "ConfigError";
  }
}

export class ValidationError extends AppError {
  constructor(message: string, cause?: unknown) {
    super("VALIDATION_FAILED", message, cause);
    this.name = "ValidationError";
  }
}

export class TenantMismatchError extends AppError {
  constructor(message = "Cross-tenant access denied.") {
    super("TENANT_MISMATCH", message);
    this.name = "TenantMismatchError";
  }
}

export class ProviderError extends AppError {
  readonly provider: "gmail" | "graph";

  constructor(provider: "gmail" | "graph", message: string, cause?: unknown) {
    super("PROVIDER_ERROR", message, cause);
    this.name = "ProviderError";
    this.provider = provider;
  }
}

export class ProviderRateLimitedError extends AppError {
  readonly retryAfterMs: number | undefined;

  constructor(provider: "gmail" | "graph", retryAfterMs: number | undefined) {
    super("PROVIDER_RATE_LIMITED", `${provider} rate-limited${retryAfterMs ? ` (retry after ${retryAfterMs}ms)` : ""}.`);
    this.name = "ProviderRateLimitedError";
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Raised when a model's structured (tool_use) output fails schema validation after
 * retries. Callers must fall back to human review — never trust the raw output.
 */
export class AiStructuredOutputError extends AppError {
  constructor(label: string, cause?: unknown) {
    super("AI_STRUCTURED_OUTPUT_INVALID", `[AI — ${label}] structured output failed validation.`, cause);
    this.name = "AiStructuredOutputError";
  }
}
