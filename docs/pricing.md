# Global Link — Pricing (Accusé & Relance)

This is the company's pricing sheet for the two commercial tiers on top of
the pipeline described in `CLAUDE.md`, plus the cost model used to decide
how many processed emails each tier can include for free.

All prices in Moroccan dirhams (MAD/dhs), excluding tax. USD→MAD conversion
used below: **1 USD ≈ 10 MAD** (round number for planning; adjust to the
live rate before printing a contract).

## 1. The two tiers

### Automation — 6 500 dhs/month
No admin UI (matches the "automation" deployable, `src/index.ts`).

- Automatic classification of every incoming email (`src/ai/classify.ts`)
- Instant, personalized acknowledgement (accusé) per category
- Internal team nudges (relance interne) — unlimited, never throttled
- Client-facing relances (pre-reply and post-reply sequences) per the
  configured steps
- 1 connected mailbox (Gmail or Outlook/Graph)
- Included volume: **1 800 processed emails/month** (see §3)
- Overage: **5 dhs per additional email** beyond the included volume

### Interface + AI Assistant — 20 000 dhs/month
Everything in Automation, plus:

- Admin dashboard (`src/main.ts` / `src/web/server.ts`): category and
  relance-sequence configuration, brand-voice tuning, AI usage/cost view
  (`/consommation`), error journal, manual reclassification & immediate
  relance triggers
- **"Super intelligent" AI assistant**: the 3 AI-drafted reply suggestions
  per email (`src/ai/draftReplies.ts`, `ENABLE_DRAFT_REPLIES=true` —
  disabled by default in the base tier), so agents pick and send rather
  than write from scratch
- Read-only client dashboard (`/client`) included as a standard add-on —
  lets the end customer track their own dossiers without exposing
  internal data (see "never expose" list in `CLAUDE.md`)
- Included volume: **2 500 processed emails/month** (see §3)
- Overage: **8 dhs per additional email** beyond the included volume

Optional add-ons (either tier): extra connected mailbox (+1 500 dhs/month
each), one-time onboarding/setup (mailbox connection, category taxonomy,
brand-voice + corpus calibration): **3 000 dhs one-time**. Annual
prepay discount: **-10%**.

## 2. What "one processed email" costs us in AI

One "email" = one dossier that enters the pipeline: 1 classification call,
plus (conditionally) the drafting calls it triggers downstream. Estimated
from the actual prompts/`max_tokens` in `src/ai/*.ts`, using Claude Sonnet 5
pricing (`config.pricing`: $3/MTok in, $15/MTok out).

| Call | Fires on | Est. input tok | Est. output tok | Cost/call ($) | Weight | Weighted $ |
|---|---|---:|---:|---:|---:|---:|
| `classifyEmail` | 100% of emails | 650 | 90 | 0.00330 | 1.00 | 0.00330 |
| `draftAcknowledgement` | ~80% (auto-ack categories) | 950 | 180 | 0.00555 | 0.80 | 0.00444 |
| `draftRelance` (pre-reply) | ~25% of dossiers | 750 | 140 | 0.00435 | 0.25 | 0.00109 |
| `draftRelance` (post-reply) | ~15% of dossiers | 750 | 140 | 0.00435 | 0.15 | 0.00065 |
| **Automation tier total** | | | | | | **≈ $0.0095 → ≈ 0.10 dhs/email** |
| `draftReplies` (3 drafts) | ~80%, Interface tier only | 1 300 | 900 | 0.01740 | 0.80 | 0.01390 |
| **Interface tier total** | | | | | | **≈ $0.0234 → ≈ 0.23 dhs/email** |

So even fully loaded, one email costs roughly **10 centimes** (Automation)
or **23 centimes** (Interface) in Claude usage — three to four orders of
magnitude below the subscription price.

## 3. How the free/included volume was set

Policy: cap the AI-cost budget at **3% of tier revenue**, leaving the
other 97% for infrastructure, support, and margin — then convert that
budget into an email count and round down for a clean number.

| Tier | Revenue | 3% AI budget | Cost/email | Raw capacity | Included (rounded) |
|---|---:|---:|---:|---:|---:|
| Automation | 6 500 dhs | 195 dhs | 0.10 dhs | ≈ 1 950 emails | **1 800** |
| Interface + AI | 20 000 dhs | 600 dhs | 0.23 dhs | ≈ 2 564 emails | **2 500** |

At the included cap, AI spend is still under **200 dhs** (Automation) or
**600 dhs** (Interface) per client per month — even a client who blows
through the overage rate 5x over is nowhere near putting AI cost above a
few percent of what they're paying.

**Free trial, same math**: a 14-day trial capped at 300 emails costs the
company ≈ 300 × 0.10 dhs ≈ **30 dhs** in AI usage (Automation feature set) —
negligible, so a generous no-card trial is easy to justify.

### Refining these numbers later
These are estimates from prompt structure, not measured traffic. Once a
client has a week or two of real usage, pull actual average tokens/email
from the `ai_usage_events` table (exposed at `/consommation`) and redo the
table in §2 with real averages instead of the estimates above — the
formula (cost/email → 3% of revenue → included volume) stays the same.

## 4. Margin summary

| Tier | Price | AI cost at full included volume | AI cost as % of revenue |
|---|---:|---:|---:|
| Automation | 6 500 dhs | ≈ 180 dhs | ≈ 2.8% |
| Interface + AI | 20 000 dhs | ≈ 575 dhs | ≈ 2.9% |

Everything else (hosting, support, dashboard, onboarding) comes out of the
remaining ~97% of revenue.
