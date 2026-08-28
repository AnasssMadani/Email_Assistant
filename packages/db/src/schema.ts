import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Drizzle schema for Phase 1–2 (see docs/architecture/refonte-plan.md). Every
 * tenant-owned table carries `organizationId` and has an RLS policy applied in
 * `migrations/0001_rls.sql` — see packages/db/src/client.ts `withOrg` for how the
 * app sets the session's tenant scope. Phase 2.5+ tables (approvals, ai_runs,
 * ai_decisions, policies, knowledge_*, ...) are intentionally NOT defined here yet —
 * they land with their own phase, per docs/architecture/FUTURE_ROADMAP.md.
 */

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull().default("Africa/Casablanca"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type MembershipRole = "owner" | "admin" | "member";

/** `userId` is a Supabase Auth user id (auth.users.id) — Supabase Auth owns credentials, we only map identity to tenant + role. */
export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    role: text("role").$type<MembershipRole>().notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.organizationId, t.userId)]
);

export type MailboxProvider = "gmail" | "graph";

/**
 * `encryptedAccessToken`/`encryptedRefreshToken` replace the legacy app's on-disk
 * token JSON files — encrypted with the same AES-256-GCM scheme (see
 * packages/email's port of legacy/src/crypto.ts), never plaintext at rest.
 */
export const mailboxes = pgTable(
  "mailboxes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    provider: text("provider").$type<MailboxProvider>().notNull(),
    emailAddress: text("email_address").notNull(),
    encryptedAccessToken: text("encrypted_access_token"),
    encryptedRefreshToken: text("encrypted_refresh_token"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    /** Gmail historyId or Graph delta link — cursor for incremental sync (see packages/email). */
    syncCursor: text("sync_cursor"),
    connectedAt: timestamp("connected_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.organizationId, t.emailAddress)]
);

export type UrgencyThreshold = "low" | "normal" | "high";
export type AckMode = "template" | "ai";

export const categories = pgTable(
  "categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Stable slug ("devis", "reclamation", "spam_newsletter", ...) — stable across relabeling, referenced by templates/steps. */
    key: text("key").notNull(),
    label: text("label").notNull(),
    slaMinutes: integer("sla_minutes").notNull(),
    acknowledgeAutomatically: boolean("acknowledge_automatically").notNull().default(true),
    /** Default "template" — see refonte-plan.md cost model. "ai" opts a category into Sonnet-drafted accusés. */
    ackMode: text("ack_mode").$type<AckMode>().notNull().default("template"),
    internalAlertsEnabled: boolean("internal_alerts_enabled").notNull().default(true),
    internalAlertsMinUrgency: text("internal_alerts_min_urgency").$type<UrgencyThreshold>().notNull().default("normal"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.organizationId, t.key)]
);

export type RelanceOwnerType = "category" | "thread";
export type RelanceChannel = "internal" | "external";
export type RelancePhase = "pre_reply" | "post_reply";

/**
 * One sequence per (owner, phase). A `thread` owner row is a manual per-dossier
 * override; the default is the `category` owner row. Step delays within one
 * (owner, phase) sequence MUST be strictly increasing — enforced in
 * packages/core, not the DB, because it depends on sibling rows.
 */
export const relanceSteps = pgTable(
  "relance_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    ownerType: text("owner_type").$type<RelanceOwnerType>().notNull(),
    /** categoryId (uuid) when ownerType='category', threadId (uuid) when ownerType='thread' — polymorphic by design, matches legacy relance_steps. */
    ownerId: uuid("owner_id").notNull(),
    phase: text("phase").$type<RelancePhase>().notNull(),
    stepOrder: integer("step_order").notNull(),
    channel: text("channel").$type<RelanceChannel>().notNull(),
    delayMinutes: real("delay_minutes").notNull(),
  },
  (t) => [unique().on(t.ownerType, t.ownerId, t.phase, t.stepOrder)]
);

export const ackTemplates = pgTable(
  "ack_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    language: text("language").$type<"fr" | "en">().notNull(),
    /** Slot-templated body (Mustache-style `{{summary}}`, `{{sla}}`, ...) — rendered by packages/core's template engine, never interpolated as a prompt. */
    body: text("body").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.categoryId, t.language)]
);

export const relanceTemplates = pgTable(
  "relance_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    phase: text("phase").$type<RelancePhase>().notNull(),
    language: text("language").$type<"fr" | "en">().notNull(),
    body: text("body").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.categoryId, t.phase, t.language)]
);

export type ThreadStatus =
  | "received"
  | "skipped"
  | "ack_sent"
  | "responded"
  | "relance_sent"
  | "awaiting_client_reply"
  | "post_reply_relance_sent"
  | "closed";

export type ThreadOrigin = "inbound" | "outbound";

/** One row per dossier — mirrors legacy `threads`, org/mailbox-scoped instead of singleton. */
export const emailThreads = pgTable(
  "email_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    mailboxId: uuid("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    providerThreadId: text("provider_thread_id").notNull(),
    subject: text("subject").notNull(),
    senderEmail: text("sender_email").notNull(),
    senderName: text("sender_name"),
    categoryId: uuid("category_id").references(() => categories.id),
    urgency: text("urgency").$type<UrgencyThreshold>().notNull().default("normal"),
    slaMinutes: real("sla_minutes"),
    status: text("status").$type<ThreadStatus>().notNull().default("received"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    ackSentAt: timestamp("ack_sent_at", { withTimezone: true }),
    dueAt: timestamp("due_at", { withTimezone: true }),
    relanceCount: integer("relance_count").notNull().default(0),
    humanRepliedAt: timestamp("human_replied_at", { withTimezone: true }),
    postReplyRelanceCount: integer("post_reply_relance_count").notNull().default(0),
    outboundHadAttachment: boolean("outbound_had_attachment").notNull().default(false),
    /** See CLAUDE.md — human-reply detection is by counting, never content/id matching. */
    automatedOutboundCount: integer("automated_outbound_count").notNull().default(0),
    /** Frozen at first relance-check pass (freezeRelanceStepsSnapshot equivalent) — editing a category's steps later must never reach dossiers already in flight. */
    preReplyRelanceSnapshot: jsonb("pre_reply_relance_snapshot"),
    postReplyRelanceSnapshot: jsonb("post_reply_relance_snapshot"),
    origin: text("origin").$type<ThreadOrigin>().notNull().default("inbound"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.mailboxId, t.providerThreadId),
    index("idx_email_threads_org_status").on(t.organizationId, t.status),
    index("idx_email_threads_due_at").on(t.dueAt),
  ]
);

/**
 * Idempotency boundary for ingestion: `(mailboxId, providerMessageId)` unique means
 * the same webhook/notification delivered twice produces one row, not two.
 */
export const emails = pgTable(
  "emails",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => emailThreads.id, { onDelete: "cascade" }),
    mailboxId: uuid("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    providerMessageId: text("provider_message_id").notNull(),
    rfcMessageId: text("rfc_message_id"),
    inReplyTo: text("in_reply_to"),
    referencesHeader: text("references_header"),
    fromEmail: text("from_email").notNull(),
    fromName: text("from_name"),
    toJson: jsonb("to_json").notNull(),
    ccJson: jsonb("cc_json"),
    subject: text("subject").notNull(),
    bodyText: text("body_text").notNull(),
    bodyHtml: text("body_html"),
    isFromUs: boolean("is_from_us").notNull(),
    hasAttachments: boolean("has_attachments").notNull().default(false),
    /** Supabase Storage object key for the raw MIME source, kept alongside the normalized fields above. */
    rawStorageKey: text("raw_storage_key"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.mailboxId, t.providerMessageId),
    index("idx_emails_thread").on(t.threadId),
  ]
);

/** Metadata only — attachment content is never parsed by the pipeline, matching legacy behaviour. Large files live in Supabase Storage. */
export const emailAttachments = pgTable("email_attachments", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  emailId: uuid("email_id")
    .notNull()
    .references(() => emails.id, { onDelete: "cascade" }),
  filename: text("filename").notNull(),
  contentType: text("content_type"),
  sizeBytes: integer("size_bytes"),
  storageKey: text("storage_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ReminderStepType =
  | "accuse"
  | "relance_interne"
  | "relance_interne_filtree"
  | "relance_externe_pre_reponse"
  | "relance_externe_post_reponse";

/** step_type is the source of truth for "did X happen" — never deduce it from `note`'s free text (see CLAUDE.md). */
export const reminders = pgTable(
  "reminders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => emailThreads.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"internal" | "external">().notNull(),
    note: text("note"),
    stepType: text("step_type").$type<ReminderStepType>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_reminders_thread").on(t.threadId, t.stepType)]
);

/** One row per model call — per-model, so /consommation can price classification (Haiku) and drafts (Sonnet) correctly instead of one global rate. */
export const aiUsageEvents = pgTable("ai_usage_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  callType: text("call_type").notNull(),
  threadId: uuid("thread_id").references(() => emailThreads.id, { onDelete: "set null" }),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Per-model $/MTok, so pricing changes (or a new model) don't require redeploys. */
export const modelPricing = pgTable("model_pricing", {
  model: text("model").primaryKey(),
  inputPerMillionTokensUsd: real("input_per_million_tokens_usd").notNull(),
  outputPerMillionTokensUsd: real("output_per_million_tokens_usd").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const pipelineErrors = pgTable("pipeline_errors", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  context: text("context").notNull(),
  threadId: uuid("thread_id").references(() => emailThreads.id, { onDelete: "set null" }),
  message: text("message").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Audit trail for the free rule-based pre-filter (see packages/core) — every dropped
 * message logs which rule matched, so a tenant can inspect what was discarded before
 * any AI call rather than it silently vanishing.
 */
export const prefilterLog = pgTable("prefilter_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  mailboxId: uuid("mailbox_id")
    .notNull()
    .references(() => mailboxes.id, { onDelete: "cascade" }),
  providerMessageId: text("provider_message_id").notNull(),
  rule: text("rule").notNull(),
  subject: text("subject").notNull(),
  senderEmail: text("sender_email").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One-time links letting a client connect their own mailbox without admin credentials — ported from legacy `connect_invites`. */
export const connectInvites = pgTable("connect_invites", {
  token: text("token").primaryKey(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  usedProvider: text("used_provider").$type<MailboxProvider>(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});
