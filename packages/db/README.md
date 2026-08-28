# @global-link/db

Drizzle schema + migrations for a **Supabase Postgres** project. No local Postgres
container — the dev DB is a Supabase project too (a free/dev-tier one is enough for
Phase 0–2).

## One-time setup (per Supabase project)

1. Create a project at supabase.com. Copy from Project Settings → Database:
   - the **pooled** connection string (port 6543, `?pgbouncer=true`) → `DATABASE_URL`
   - the **direct** connection string (port 5432) → `DIRECT_DATABASE_URL` (migrations
     use session-level features pgbouncer's transaction mode does not support)
2. Run migrations: `npm run migrate -w @global-link/db` (builds then runs
   `src/migrate.ts`, which applies `migrations/*.sql` then
   `migrations-rls/0001_rls.sql`).
3. Create the runtime role apps/worker actually connect as (see the comment at the
   top of `migrations-rls/0001_rls.sql` for the exact SQL) — **never** point
   `DATABASE_URL` at the migration/owner role in a deployed environment, or every RLS
   policy is a silent no-op (table owners bypass RLS regardless of `FORCE ROW LEVEL
   SECURITY`).
4. Re-run `npm run migrate` once more so the `grant select on model_pricing` guard
   picks up the now-existing role.

## Changing the schema

Edit `src/schema.ts`, then `npm run generate -w @global-link/db` to produce a new
`migrations/000N_*.sql` file. Never hand-edit a migration that has already been
applied to a real environment — add a new one instead.

## Why no local Docker Postgres

Per project constraints (see docs/architecture/refonte-plan.md), this environment
avoids local containers. A Supabase dev project stands in as "local Postgres" —
same schema, same RLS behaviour, zero RAM cost.
