import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { requireDatabaseUrl } from "@global-link/shared";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Applies drizzle-kit's generated table migrations, then the hand-written RLS
 * policy file (drizzle-kit only manages table DDL, not `CREATE POLICY`). Run with
 * DIRECT_DATABASE_URL (non-pooled) — migrations use session-level features that
 * pgbouncer transaction mode does not support.
 */
async function main(): Promise<void> {
  const url = process.env.DIRECT_DATABASE_URL ?? requireDatabaseUrl();
  const sql = postgres(url, { max: 1 });
  const db = drizzle(sql);

  console.log("Applying table migrations...");
  await migrate(db, { migrationsFolder: path.join(__dirname, "../migrations") });

  const rlsPath = path.join(__dirname, "../migrations-rls/0001_rls.sql");
  console.log(`Applying RLS policies from ${rlsPath}...`);
  await sql.file(rlsPath);

  await sql.end();
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
