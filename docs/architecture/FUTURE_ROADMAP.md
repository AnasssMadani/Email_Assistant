# FUTURE ROADMAP — DO NOT IMPLEMENT YET

## Purpose

This document is the persistent roadmap for the AI Email Operations SaaS.

The current implementation intentionally focuses on the foundation and the first
reliable shipped product. Do NOT implement Phase 3+ early unless explicitly instructed
by the user. When the current phase is complete, use this document to understand
exactly what comes next.

## CURRENT TARGET

Complete:

```
Phase 0 → Phase 1 → Phase 2 → Phase 2.5
```

The shipped product should provide:

- reliable Gmail / Microsoft 365 ingestion
- proper threading
- multi-tenant architecture
- inbox
- accusé automation
- relance automation
- human approval
- AI-generated replies as an opt-in feature
- auditability
- cost visibility
- reliable sending
- shadow-mode verification

Do not consider the product "finished AI employee" at this stage.

## PHASE 3 — CONTROLLED AI

After Phase 2.5 has collected sufficient real-world approval/correction data, implement:

### 3.1 Policy Engine

Create deterministic policies controlling what AI may do.

Examples:

- topic restrictions
- confidence thresholds
- customer restrictions
- monetary thresholds
- approval requirements
- business-hour rules
- VIP handling
- escalation rules

Policies must be evaluated outside the LLM. The LLM can recommend an action but cannot
authorize itself.

### 3.2 Risk Engine

Introduce explicit risk levels:

```
LOW
MEDIUM
HIGH
CRITICAL
```

Calculate risk using:

- topic
- action
- confidence
- customer context
- monetary impact
- policy
- historical performance

Risk determines whether the AI can:

- answer automatically
- draft only
- request approval
- escalate immediately

### 3.3 Knowledge Base

Build the company's AI knowledge system.

Supported sources:

- website
- URLs
- FAQs
- PDFs
- DOCX
- TXT
- internal documentation
- company policies
- product documentation

Pipeline:

```
source → parser → normalization → chunking → embedding → pgvector
```

Add retrieval before AI response generation. Responses should retain source attribution.

## PHASE 4 — AUTONOMOUS EMAIL AGENT

Once the policy/risk/knowledge foundations are reliable:

### 4.1 Topic-Level Autonomy

Every category gets an autonomy state:

```
OBSERVE
DRAFT
APPROVAL_REQUIRED
AUTO_REPLY
```

Track performance per topic. Do not give the AI global autonomy.

Example:

```
Delivery: AUTO_REPLY
Pricing:  AUTO_REPLY
Returns:  APPROVAL_REQUIRED
Refunds:  HUMAN_ONLY
Legal:    HUMAN_ONLY
```

### 4.2 Autonomy Center

Create a dashboard showing:

- topic
- volume
- confidence
- correction rate
- approval rate
- escalation rate
- risk
- current autonomy
- recommended autonomy

The system may RECOMMEND increasing autonomy. It must NEVER silently increase its own
authority. The administrator must explicitly approve an autonomy increase.

## PHASE 5 — TOOL USE AND BUSINESS ACTIONS

After reliable response automation, create a typed tool framework.

Initial tools may include:

```
get_customer
get_order
search_orders
get_invoice
check_refund_eligibility
create_refund
update_customer
create_ticket
schedule_followup
send_email
escalate_to_human
```

Every tool must have:

- schema
- permission requirements
- risk level
- audit trail
- idempotency where required

Never allow arbitrary LLM API calls, SQL, shell commands, or code execution.

## PHASE 6 — BUSINESS INTEGRATIONS

Add connectors only based on real customer demand.

Potential connectors:

- HubSpot
- Salesforce
- Shopify
- Stripe
- Zendesk
- Slack
- custom REST APIs

Use a provider-independent integration interface. Do not build every integration
speculatively.

## PHASE 7 — AI EVALUATION SYSTEM

Build a permanent evaluation framework.

Create a dataset of real anonymized/authorized examples.

Each case should measure:

- intent accuracy
- policy compliance
- response quality
- action correctness
- escalation correctness
- hallucination rate
- tool correctness

Every major change to model, prompt, policy, retrieval, or tool definitions must be
evaluated before production rollout.

## PHASE 8 — CUSTOMER MEMORY

Build structured customer memory.

Store useful facts such as:

- identity
- company
- customer tier
- previous interactions
- relevant preferences
- previous issues

Memory must be:

- structured
- inspectable
- tenant-scoped
- editable
- deletable
- auditable

Do not create an uncontrolled permanent memory blob.

## PHASE 9 — PROACTIVE AI OPERATIONS

Once the AI reliably handles inbound email, enable proactive workflows such as:

- follow-ups
- unanswered customer detection
- SLA breach detection
- internal reminders
- pending-document reminders
- customer reactivation
- unresolved conversation monitoring

The AI should eventually detect work rather than only react to incoming emails.

## PHASE 10 — AI OPERATIONS EMPLOYEE

Long-term product objective:

```
EMAIL
  ↓
CUSTOMER
  ↓
CRM
  ↓
ORDERS
  ↓
TICKETS
  ↓
CALENDAR
  ↓
INTERNAL COMMUNICATION
  ↓
BUSINESS ACTIONS
```

The final product is NOT merely "AI that answers emails." The final product is "AI that
operates email-driven business processes." Email is the first interface and entry point.

## IMPORTANT DEVELOPMENT RULE

Always finish and stabilize the current phase before starting the next.

At the end of each phase:

1. run tests
2. run integration tests
3. verify production behavior
4. document architecture changes
5. document known limitations
6. update this roadmap with completed items
7. define the exact next implementation milestone

Do not implement future phases merely because their architecture has already been
described.

## CURRENT STATUS

Claude must maintain a status section below this line. Update it after every major
milestone.

```
Phase 0:   MOSTLY COMPLETE (foundation built; no live Supabase project provisioned yet)
Phase 1:   IN PROGRESS (ingestion/threading logic ported; incremental sync not done)
Phase 2:   IN PROGRESS (cost-model pipeline built end-to-end; not yet deployed/verified live)
Phase 2.5: NOT COMPLETE
Phase 3:   NOT STARTED
Phase 4:   NOT STARTED
Phase 5:   NOT STARTED
Phase 6:   NOT STARTED
Phase 7:   NOT STARTED
Phase 8:   NOT STARTED
Phase 9:   NOT STARTED
Phase 10:  NOT STARTED
```

When a phase is complete, mark it COMPLETE and add a short summary of what was actually
implemented. Never mark a phase complete based only on planned code.

### Phase 0 progress log

- 2026-08-28: Monorepo skeleton (npm workspaces), legacy app moved unchanged to
  `legacy/` (still deployable, 90/90 tests green, own CI job). Built and typechecked
  end-to-end, in dependency order: `packages/shared` (zod config, pino logger, typed
  errors, AES-256-GCM crypto, cross-cutting EmailMessage/EmailConnector types),
  `packages/db` (Drizzle schema for Phase 1–2 tables + hand-written RLS policy SQL,
  migration generated and inspected), `packages/queue` (pg-boss interface — see
  refonte-plan.md for why pg-boss over Redis/BullMQ), `packages/email` (Gmail/Graph
  connectors ported from legacy with DB-backed encrypted token storage instead of
  files, per-mailbox rate limiter), `packages/ai` (provider-independent model
  gateway; Anthropic is the only file importing the SDK; per-model usage/pricing),
  `packages/core` (free rule-based pre-filter, template engine for $0 accusé/relance,
  Haiku-based classification, the full pre_reply/post_reply relance loop and
  discoverOutbound ported with every documented invariant preserved — 14 passing
  unit tests on the pure logic), `packages/auth` (Supabase JWT verification +
  membership resolution), `apps/api` (Fastify — OAuth connect flow, org-scoped
  threads/me routes, boot-tested), `apps/worker` (pg-boss job handlers wiring the
  whole pipeline together, ported from legacy's scheduler.ts tick structure),
  `apps/web` (Next.js — login/dashboard/inbox/connections, builds clean).
  CI updated to build+typecheck+test both `legacy/` and the new monorepo.

  **Explicitly NOT done** (do not treat as complete): no Supabase project has
  actually been provisioned/migrated against (schema is generated and inspected,
  never applied to a live database); Gmail/Graph incremental sync (historyId/delta)
  is not implemented — still polls, like legacy (see `packages/email/README.md`);
  no integration/e2e test has run against a real mailbox or a real Postgres; the
  Next.js app has no thread-detail view, no org switcher, and no signup/invite flow
  (an org's first user is provisioned manually); AI-drafted (opt-in) accusé/relance
  are implemented but unexercised; Phase 2.5 (human approval, ai_runs/ai_decisions/
  approvals tables) has not been started.

## DECISION PRINCIPLE

When choosing between:

A) building a sophisticated feature early, and
B) collecting evidence through real production usage first,

prefer B unless there is a clear technical dependency. The AI should earn autonomy from
evidence. It should not receive autonomy because we designed an impressive architecture.
