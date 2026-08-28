import pino from "pino";

/**
 * One structured logger for the whole platform. `component` scopes every line
 * (e.g. "worker.ingest", "api.oauth") so multi-tenant logs stay greppable —
 * always pass `organizationId` in the bindings when the log concerns a tenant,
 * never leave it to be inferred from message text.
 */
export function createLogger(component: string) {
  return pino({
    name: component,
    level: process.env.LOG_LEVEL ?? "info",
    // Pretty-print only in local dev; production stays newline-delimited JSON
    // for the hosting platform's log pipeline.
    transport:
      process.env.NODE_ENV === "production"
        ? undefined
        : { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } },
  });
}

export type Logger = ReturnType<typeof createLogger>;
