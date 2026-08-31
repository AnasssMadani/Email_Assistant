import { newDb } from "pg-mem";
import type { Pool } from "pg";

/**
 * Base Postgres isolee (pg-mem — emulateur en memoire, sans reseau ni
 * service externe) pour chaque test file. Remplace le pattern SQLite
 * precedent (mkdtempSync + DB_PATH + import dynamique) — meme principe
 * d'isolation, adapte au pool Postgres partage par tout db.ts (voir
 * src/dbPool.ts). Doit etre appelee AVANT tout premier import de
 * "../src/db.js" dans le fichier de test (le pool doit deja etre en place
 * quand db.ts execute son bootstrap de schema au chargement du module).
 */
export async function freshTestDb() {
  process.env.CATEGORIES_CONFIG_PATH ??= "config/categories.json";
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  const pool = new (mem.adapters.createPg().Pool)() as unknown as Pool;
  const { setPoolForTesting } = await import("../src/dbPool.js");
  setPoolForTesting(pool);
  return import("../src/db.js");
}
