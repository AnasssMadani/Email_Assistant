-- Row-level tenant isolation — the database-layer guard described in
-- docs/architecture/refonte-plan.md "Multi-tenancy". Applied AFTER drizzle-kit's
-- generated table migrations (see src/migrate.ts).
--
-- SETUP REQUIRED ONCE PER SUPABASE PROJECT (not something this file can do, since it
-- runs as the migration owner role): create a dedicated Postgres role for
-- apps/api and apps/worker to connect as, e.g.:
--
--   create role app_runtime login password '...';
--   grant usage on schema public to app_runtime;
--   grant select, insert, update, delete on all tables in schema public to app_runtime;
--
-- RLS is bypassed for the table OWNER regardless of FORCE ROW LEVEL SECURITY, so
-- migrations must keep running as the owner/migration role, and DATABASE_URL for
-- apps/worker must point at app_runtime, never the owner — otherwise every policy
-- below is silently a no-op.

do $$
declare
  tbl text;
begin
  for tbl in
    select unnest(array[
      'memberships', 'mailboxes', 'categories', 'relance_steps', 'ack_templates',
      'relance_templates', 'email_threads', 'emails', 'email_attachments',
      'reminders', 'ai_usage_events', 'pipeline_errors', 'prefilter_log',
      'connect_invites'
    ])
  loop
    execute format('alter table %I enable row level security', tbl);
    execute format('alter table %I force row level security', tbl);
    execute format(
      'create policy tenant_isolation on %I using (organization_id = current_setting(''app.current_org_id'', true)::uuid) with check (organization_id = current_setting(''app.current_org_id'', true)::uuid)',
      tbl
    );
  end loop;
end $$;

-- organizations itself has no organization_id column (it IS the tenant row) — a
-- membership-based policy instead: a session may see an organization only if
-- app.current_org_id has been set to it (set by withOrg() after the app already
-- verified the caller's membership at the application layer).
alter table organizations enable row level security;
alter table organizations force row level security;
create policy tenant_isolation on organizations
  using (id = current_setting('app.current_org_id', true)::uuid);

-- model_pricing is platform-level reference data (not tenant-owned) — readable by
-- every authenticated app connection, writable only by the migration/owner role.
-- Guarded: app_runtime may not exist yet on a first-time migration run before the
-- one-time setup above has been done — this grant is then a manual follow-up.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_runtime') then
    execute 'grant select on model_pricing to app_runtime';
  end if;
end $$;
