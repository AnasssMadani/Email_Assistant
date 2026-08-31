import { Pool } from "pg";
import { config } from "./config.js";

/**
 * Pool partage par tout le module db.ts. Indirection minimale (plutot qu'un
 * `new Pool()` directement dans db.ts) uniquement pour permettre aux tests
 * d'injecter un pool pg-mem (Postgres en memoire, sans reseau ni service
 * externe) via setPoolForTesting AVANT le premier import de db.ts — voir
 * test/_pgTestDb.ts.
 */
let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    if (!config.databaseUrl) {
      throw new Error(
        "Variable d'environnement manquante: DATABASE_URL. Renseignez la chaine de connexion Postgres/Supabase dans .env."
      );
    }
    pool = new Pool({
      connectionString: config.databaseUrl,
      // Supabase (comme la plupart des Postgres manages) exige TLS mais
      // presente un certificat que Node ne valide pas toujours via la
      // chaine de confiance par defaut — rejectUnauthorized: false reste
      // un chiffrement TLS reel, juste sans verification de chaine.
      ssl: config.databaseUrl.includes("supabase.co") ? { rejectUnauthorized: false } : undefined,
    });
  }
  return pool;
}

/** Reserve aux tests: remplace le pool reel par un pool pg-mem isole avant le premier import de db.ts. */
export function setPoolForTesting(testPool: Pool): void {
  pool = testPool;
}
