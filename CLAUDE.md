# Global Link — Accusé & Relance

Email automation SaaS for a Morocco-based business receiving client/agent emails from
worldwide senders. Core loop: acknowledge incoming emails automatically, classify them by
AI, draft/send follow-up relances if the team doesn't answer in time, and relance the
client again if the team's real answer goes unanswered. Sold as an "automation" tier
(no admin UI) with an "interface" tier upsell (admin dashboard), plus a separate
"client" tier (read-mostly dashboard for the end customer — see Auth model below).

Node/TypeScript, `node:sqlite` (experimental) as the DB, Anthropic Claude
(`CLAUDE_MODEL` in `src/ai/client.ts`) for classification/drafting, Gmail (`googleapis`)
and Microsoft Graph as pluggable connectors behind `EmailConnector` (`src/types.ts`).

## Two deployables, same pipeline

- `src/index.ts` — scheduler only (automation tier). `npm run dev`.
- `src/main.ts` — scheduler + web admin + client dashboard (interface tier). `npm run dev:all`.
- `src/scheduler.ts` — cron loop. Creates a **fresh** connector every tick (via
  `createEmailConnector()`) rather than once at startup, so reconnecting the mailbox
  through the web UI takes effect without a process restart.

## Pipeline flow

1. **Intake** (`src/pipeline/processIncoming.ts`): incoming message → robot senders
   (`src/pipeline/automatedSender.ts`: noreply/mailer-daemon addresses, Auto-Submitted
   headers) are filed without any AI call → `classifyEmail()` (`src/ai/classify.ts`,
   category label + description, also flags `suspicious` phishing → `suspect` category)
   → ack policy (`ackSuppression` + `ackPolicySuppression`: team already replied,
   sensitive subject, category ack mode `never`/`always`/`outside_hours` with office
   hours from `src/officeHours.ts`, one ack per conversation/reference over 7 days) →
   `draftAcknowledgement()` sends the accusé and the dossier enters **pre_reply** phase.
   Every skipped ack records a reason (`AckSkipReason` in `db.ts`, shown in the Carnet).
   `received_at` is the email's own date; `prior_outbound_count` stores our messages
   already in the thread before it, so the human-reply count ignores them.
   - Skips silently: `isFromUs` messages, already-processed message ids, and anything
     whose subject starts with our own `[Rappel] ` prefix (echoes of our own internal
     notifications sent to the connected mailbox itself — see Gotchas).
2. **pre_reply loop** (`src/pipeline/relanceCheck.ts`, `listThreadsAwaitingReply`):
   nobody on the team has answered yet. Steps nudge the team (`internal`) then relance
   the client (`external`) per the dossier's relance sequence. Stops the moment a human
   sends a real reply (detected by counting, see Gotchas).
3. **post_reply loop** (`listThreadsAwaitingClientReply`): a human answered
   (`human_replied_at` set) — now relance the CLIENT if they go silent. Independent step
   sequence from pre_reply, same category-or-thread-override model.
4. Every relance step run is logged via `recordReminder(threadId, kind, note, stepType)`
   — `stepType` is one of `accuse | relance_interne | relance_interne_filtree |
   relance_interne_test | relance_externe_pre_reponse | relance_externe_post_reponse |
   relance_externe_test_pre_reponse | relance_externe_test_post_reponse`
   (`*_test*` = a step that would have gone out but didn't because the activation
   stage is 0 — `src/stage.ts`: stage 0 sends nothing, not even to the team) and is the reliable,
   query-safe source of truth for "did X happen" (used by the client dashboard
   checklist) — never deduce this from the note's free text.
5. `src/pipeline/discoverOutbound.ts`: catches cold outreach (an email we send with no
   prior tracked thread) and registers it directly in post_reply phase, classified via
   the same `classifyEmail()` against the outbound message's own content.

## Directory map

```
src/ai/            classify.ts, draftAcknowledgement.ts, draftRelance.ts (pre/post_reply
                    prompts), draftReplies.ts (paused by default, see config), client.ts
                    (CLAUDE_MODEL), structured.ts (withRetry + AI usage recording)
src/connectors/     gmailConnector.ts, graphConnector.ts (implement EmailConnector),
                    gmailAuth.ts/graphAuth.ts (OAuth), mime.ts (MIME parse/build), index.ts
                    (createEmailConnector() factory, reads config.emailConnector)
src/pipeline/       processIncoming.ts, relanceCheck.ts (core loop + budget), discoverOutbound.ts,
                    draftCleanup.ts, errorTag.ts (tagSource wraps calls for pipeline_errors)
src/web/            server.ts (admin, huge), clientServer.ts (client dashboard router,
                    mounted at /client), auth.ts (sessions/roles/CSRF), shared.ts (escapeHtml,
                    sharedStyles, formatDateTime, csrfField — imported by BOTH server.ts and
                    clientServer.ts; neither imports the other, to avoid a cycle)
src/db.ts           schema + all queries. Client-safe projections live in a dedicated
                    section at the bottom (listClientThreads, getClientThreadDetail, etc.)
                    — never expose a full ThreadRow/CategoryRow to a client view.
src/config.ts       all env vars, one place
src/stage.ts        activation stage (0 silent, 1 real sending, 2 drafts, 3 direct reply) —
                    stored in DB (app_settings), toggled at /etape. isSendAllowed(action) is the
                    ONE gate every send path calls; fails closed to 0; MAX_STAGE env caps it
src/settings.ts     getCategory() — thin wrapper over db.listCategories(), no caching
src/scheduler.ts    cron wiring (pollIntervalCron, relanceCheckCron, both default */2 * * * *)
```

## Data model essentials (`src/db.ts`)

- `threads`: one row per dossier. `status` is a single `ThreadStatus` enum shared by both
  phases — pre_reply and post_reply statuses must never collide (that caused a real
  oscillation bug — see Gotchas).
- `categories`: business categories come from `config/category-profile.json`, applied
  once per `version` at startup (`applyCategoryProfile` in `db.ts`); it never touches an
  existing category's SLA, alerts or steps. Bump `version` to re-apply.
  `ack_schedule` ('always'|'outside_hours') refines `acknowledge_automatically`.
  `sla_minutes` is source of truth, `sla_hours` dual-written for legacy
  schema compat. `internal_alerts_enabled` + `internal_alerts_min_urgency` gate whether a
  pre/post_reply "notify team" step actually sends — filtered alerts still advance the
  sequence but log as `relance_interne_filtree`, never `relance_interne`.
- `relance_steps` / `post_reply_relance_steps`: `owner_type` ('category'|'thread') +
  `owner_id`. A thread-level row means a **manual, human-created override**
  (`hasThreadRelanceOverride`) — distinct from the automatic snapshot below.
- `threads.pre_reply_relance_snapshot` / `post_reply_relance_snapshot` (JSON): each
  dossier freezes the category's steps the first time `runRelanceCheck` examines it
  (`freezeRelanceStepsSnapshot`, idempotent). **Editing a category's delays later never
  reaches dossiers already in flight** — only new ones. `getEffectiveRelanceSteps()`
  checks manual override → snapshot → live category, in that order.
- `reminders.step_type`: see Pipeline flow §4.
- `ai_usage_events`: one row per Claude call (classify/accuse/relance), used by
  `/consommation`. Pricing in `config.pricing`, defaults $3/$15 per MTok (Sonnet 5).

## Auth model (`src/web/auth.ts`)

Sessions carry a `role: "admin" | "client"`. `requireAuth` = admin only. `requireClientAuth`
= client OR admin (admin can preview the client dashboard). Both fall back to "open, with a
console warning" if their respective credentials aren't configured — `SETUP_USERNAME`/
`SETUP_PASSWORD_HASH` for admin, `CLIENT_USERNAME`/`CLIENT_PASSWORD_HASH` for client. Never
leave either unset outside localhost. Generate hashes with
`npm run auth:hash-password -- "password"`.

The Gmail/Graph OAuth reconnect flow (`/auth/{gmail,graph}/{start,callback}`) is shared
by both roles and redirects back to whichever dashboard triggered it via a short-lived
`oauth_from` cookie (not the OAuth `state` param, which stays a pure anti-CSRF nonce).

## What the client dashboard must never expose

AI token/cost figures, the pipeline error journal, relance sequence configuration
(delays, channels, urgency thresholds), manual reclassification/immediate-relance
triggers, or any technical id (thread_id, draft_id, connector name). See
`src/web/clientServer.ts` + the client-safe projections in `db.ts` for the enforced
boundary — extend those, don't bypass them by handing a client view raw admin data.

## Gotchas worth knowing before touching the pipeline

- **Every outbound send goes through `isSendAllowed(action)`** (`src/stage.ts`) — never
  compare the stage yourself, never add a send path without it. Stage 0 drafts and logs
  (notes prefixed `[Mode test]`) but sends nothing, internal team rappels included. At
  stage ≥1 a pre_reply client relance is skipped when `automated_outbound_count === 0`
  (accusé was only drafted at stage 0) so a client never gets a relance without an accusé.
- **Classification may create a category** (`NEW_CATEGORY_ID` in `classify.ts` →
  `createCategoryFromAi` in `db.ts`): it copies the fallback category's settings and
  relance steps (behaviour-neutral), reuses an existing category with the same slug, and is
  capped by `AI_CATEGORIES_MAX_PER_DAY` (rolling 24h) — beyond that, `autre`.

- **"Was this reply automated or human?"** is solved by *counting*
  (`automated_outbound_count` on `threads`, incremented after every automated send),
  never by matching message content or ids — round-tripping through Gmail/Graph can
  alter text slightly, making content/id matching fragile. Both connectors'
  `getThread()` must filter out DRAFT-labeled messages before this count is compared,
  or the 3 draft replies (when enabled) inflate the "real" message count and trip a
  false positive.
- **`draftRepliesEnabled` is off by default** (`config.draftRepliesEnabled`,
  `ENABLE_DRAFT_REPLIES` env var) — accusé/relances/notifications still run normally.
- **Thread-id/connector mismatch**: switching the connected mailbox's provider leaves
  old dossiers with the previous provider's thread-id shape in the DB.
  `threadIdMatchesConnector()` in `relanceCheck.ts` skips them instead of retrying
  forever against the wrong API.
- **Relance step delays must be strictly increasing** within one sequence
  (`clampAfterLastStep` in `server.ts`) — two steps at the same delay resolve to the
  same fire time and send back-to-back, one cron cycle apart.
- **`maxExternalRelancesPerCycle`** (default 5) caps client-facing relances per cycle,
  shared across both loops — internal-only rappels are not throttled.
- Attachments: the pipeline never reads PDF/Excel content, only the plain-text body and
  a boolean `hasAttachments` flag. Classification/accusé/relance on an attachment-only
  email works from the subject line alone.
- Dates: always render through `formatDateTime()` (`shared.ts`) — `config.timezone`
  (default `Africa/Casablanca`), never bare `toLocaleString()`.

## Verification workflow (every change, no exceptions)

1. Typecheck: `NODE_OPTIONS="--max-old-space-size=4096" node ./node_modules/typescript/bin/tsc --noEmit`
   (plain `npm run typecheck` OOMs on this machine — the flag is required).
2. `npm test` (uses `node --test`, glob `test/**/*.test.ts`). Two DB patterns in use:
   shared-file DB via `test/_settingsEnv.ts`/`_authEnv.ts` (older tests) and per-test
   isolated DB via `mkdtempSync` + setting `process.env.DB_PATH` **before** a dynamic
   `import("../src/db.js")` (newer tests — required whenever a test asserts exact
   counts/totals that a shared DB would make flaky).
3. Boot-check via the preview tool (`setup-server` launch config), confirm no server
   errors, stop it.
4. `git add` explicit files (never `-A`), commit, push — only when asked to.

Note: `tsconfig.json` only type-checks `src/` — `test/` files are excluded, so a
breaking change to an exported function's signature is only caught by actually running
`npm test`, not by `tsc --noEmit` alone.

## Read-only mailbox (rule n°1)

The connected mailbox is strictly read-only: never mark read/unread, move, delete,
label, or create drafts. Connectors expose only reads plus `sendReply` /
`sendNotification` (Graph replies use the one-shot `/reply` action, not
`createReply` + draft). OAuth scopes are read + send only (no `gmail.modify`/
`gmail.compose`, no `Mail.ReadWrite`). `test/mailboxReadOnly.test.ts` and
`test/silentModeNoSend.test.ts` enforce this — don't add a write method.

## Standing constraint

Never risk sending duplicate, excessive, or confusing emails to real clients — this has
been an explicit, repeated priority. When in doubt about a pipeline change's blast
radius, default to a stricter guard (budget cap, dedup, skip) over a looser one.
