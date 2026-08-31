const RETRYABLE_STATUSES = new Set([429, 500, 502, 503]);

function extractStatus(err: unknown): number | undefined {
  const e = err as { status?: number; code?: number; response?: { status?: number } };
  return e.status ?? e.code ?? e.response?.status;
}

/**
 * Retente un appel Gmail/Graph en cas d'erreur transitoire (429 rate-limit,
 * 500/502/503) avec un backoff exponentiel + jitter. RESERVE AUX LECTURES
 * (list/get) — ne jamais l'utiliser pour un envoi (sendReply,
 * sendNotification): un timeout ambigu sur un envoi peut
 * avoir reussi cote serveur malgre l'erreur cote client, et retenter
 * risquerait un envoi en double (contrainte permanente du projet, voir
 * CLAUDE.md). Seuls les codes explicitement transitoires sont retentes —
 * toute autre erreur (401, 404, validation...) echoue immediatement.
 */
export async function withBackoff<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const status = extractStatus(err);
      if (i >= attempts - 1 || status === undefined || !RETRYABLE_STATUSES.has(status)) {
        throw err;
      }
      const delayMs = 2 ** i * 500 + Math.random() * 250;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}
