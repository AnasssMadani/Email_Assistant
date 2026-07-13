/**
 * Les sorties structurees de Claude (tool_use.input) ne sont pas garanties
 * conformes au schema declare — une reponse tronquee (max_tokens atteint) ou
 * mal formee produit des champs manquants, qui deviennent `undefined` en JS.
 * Sans validation, ce `undefined` se retrouve tel quel dans un email reel
 * (ex: corps de brouillon = "undefined"). withRetry re-tente une fois avant
 * d'abandonner, pour absorber les echecs transitoires de generation.
 */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 2): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}
