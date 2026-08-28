/**
 * Prefixe une erreur avec sa source ("Messagerie", "Claude", ...) avant de
 * la relancer, pour qu'un admin lisant le Journal (pipeline_errors) sache
 * immediatement ou intervenir sans avoir a deviner d'apres le message brut.
 */
export async function tagSource<T>(source: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[${source}] ${message}`);
  }
}
