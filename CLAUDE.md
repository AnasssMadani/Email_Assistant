# Global Link — AI Email Operations Platform (monorepo)

This repository is mid-refonte: a working single-tenant pilot (`legacy/`) is being
replaced, phase by phase, by a multi-tenant platform in `apps/` + `packages/`. Read
`docs/architecture/refonte-plan.md` for the full plan and rationale, and
`docs/architecture/FUTURE_ROADMAP.md` for what comes after Phase 2.5 — **do not
implement anything in that roadmap ahead of its phase** unless explicitly asked.

## Two codebases, one migration

- `legacy/` — the original Express + `node:sqlite` app (accusé/relance for one Gmail
  mailbox). Still deployable as-is (its own `package.json`, own `README.md`, own
  `CLAUDE.md` with the detailed pipeline gotchas). **Do not break it** while it is still
  serving production; it is retired only once `apps/` reaches Phase 2 parity.
- `apps/` + `packages/` — the new monorepo. npm workspaces, no Docker required for
  local dev (Supabase Postgres is cloud-hosted; see each package's README for env vars).

## Monorepo layout

```
apps/
  web/      Next.js — dashboard, inbox, AI review, settings
  api/      Fastify — /api/v1, OAuth callbacks, provider webhooks
  worker/   pg-boss job handlers (ingest, classify, send, relance-check)
packages/
  shared/   zod-validated config, typed errors, logger, domain types
  db/       Drizzle schema + migrations + org-scoped repositories (Supabase Postgres)
  email/    EmailConnector + gmail/graph adapters (ported from legacy/src/connectors)
  ai/       model gateway — the ONLY package allowed to import @anthropic-ai/sdk
  core/     domain logic: prefilter, classify, templates, relance, policy (pure functions)
  queue/    thin queue interface, pg-boss implementation (no Redis/BullMQ — see plan)
  auth/     sessions, RBAC, org context
```

## Rules carried over from the legacy pipeline (still apply)

These are hard-won production fixes from `legacy/CLAUDE.md`. Anything in `packages/core`
that reimplements relance/accusé logic must preserve them:

- Human-reply detection is by **counting** `automated_outbound_count`, never by matching
  message content or ids.
- A category's relance sequence is **frozen per-dossier** the first time it is examined;
  editing the category later must never reach dossiers already in flight.
- Relance step delays within one sequence must be **strictly increasing**.
- External (client-facing) relances are capped per cycle by a shared budget — never
  batch-send to many clients at once as a side effect of catch-up.
- Our own internal `[Rappel]` notifications must never be re-ingested as client email.
- Dates render through a timezone-aware formatter — never bare `toLocaleString()`.

## Standing constraint (unchanged from legacy)

Never risk sending duplicate, excessive, or confusing emails to real clients. When in
doubt about a pipeline change's blast radius, default to a stricter guard (budget cap,
dedup, skip) over a looser one.

## Verification workflow

1. Typecheck per workspace: `NODE_OPTIONS="--max-old-space-size=4096" npx tsc --noEmit`
   from that workspace's directory (plain `tsc` OOMs on this machine).
2. `npm test -w <workspace>` (or `npm run typecheck --workspaces --if-present` at root).
3. For `legacy/`, its own verification workflow in `legacy/CLAUDE.md` still applies
   unchanged.
4. `git add` explicit files (never `-A`), commit, push — only when asked.
