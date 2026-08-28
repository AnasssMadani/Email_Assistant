import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { requireDatabaseUrl } from "@global-link/shared";
import * as schema from "./schema.js";

let sqlClient: ReturnType<typeof postgres> | null = null;

function getSql() {
  if (!sqlClient) {
    // prepare:false — required when DATABASE_URL points at Supabase's pgbouncer
    // (transaction pooling mode) rather than a direct connection; prepared
    // statements do not survive across pooled connections.
    sqlClient = postgres(requireDatabaseUrl(), { prepare: false });
  }
  return sqlClient;
}

export function getDb() {
  return drizzle(getSql(), { schema });
}

export type Db = ReturnType<typeof getDb>;

/**
 * The only sanctioned way to run a tenant-scoped query. Sets the Postgres session
 * variable `app.current_org_id` for the lifetime of one transaction; every RLS
 * policy in `migrations/0001_rls.sql` filters on it, so a repository function that
 * forgets `WHERE organization_id = ...` returns zero rows instead of another
 * tenant's data — see docs/architecture/refonte-plan.md "Multi-tenancy". Never call
 * getDb() directly from a route or job handler.
 */
export async function withOrg<T>(organizationId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
  const db = getDb();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_org_id', ${organizationId}, true)`);
    return fn(tx as unknown as Db);
  });
}
