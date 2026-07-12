import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import type { CategoryConfig, RelanceConfig, ThreadStatus } from "./types.js";

mkdirSync(path.dirname(path.resolve(config.dbPath)), { recursive: true });
const db = new DatabaseSync(path.resolve(config.dbPath));

db.exec(`
  CREATE TABLE IF NOT EXISTS threads (
    thread_id TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    sender_email TEXT NOT NULL,
    sender_name TEXT,
    category_id TEXT NOT NULL,
    urgency TEXT NOT NULL,
    sla_hours REAL NOT NULL,
    status TEXT NOT NULL,
    received_at TEXT NOT NULL,
    ack_sent_at TEXT,
    due_at TEXT,
    last_relance_at TEXT,
    relance_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS processed_messages (
    message_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    processed_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    connector_draft_id TEXT NOT NULL,
    variant TEXT NOT NULL,
    label TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    sla_hours REAL NOT NULL,
    acknowledge_automatically INTEGER NOT NULL,
    allow_external_relance INTEGER NOT NULL,
    sort_order INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS relance_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    internal_reminder_after_hours REAL NOT NULL,
    external_relance_after_hours REAL NOT NULL,
    max_relances INTEGER NOT NULL
  );
`);

seedSettingsIfEmpty();

interface CategoriesSeedFile {
  categories: CategoryConfig[];
  relance: RelanceConfig;
}

function seedSettingsIfEmpty(): void {
  const categoryCount = db.prepare("SELECT COUNT(*) AS n FROM categories").get() as { n: number };
  const settingsCount = db.prepare("SELECT COUNT(*) AS n FROM relance_settings").get() as {
    n: number;
  };
  if (categoryCount.n > 0 && settingsCount.n > 0) return;

  const raw = readFileSync(path.resolve(config.categoriesConfigPath), "utf-8");
  const seed = JSON.parse(raw) as CategoriesSeedFile;

  if (categoryCount.n === 0) {
    const insert = db.prepare(
      `INSERT INTO categories (id, label, sla_hours, acknowledge_automatically, allow_external_relance, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    seed.categories.forEach((cat, index) => {
      insert.run(
        cat.id,
        cat.label,
        cat.slaHours,
        cat.acknowledgeAutomatically ? 1 : 0,
        cat.allowExternalRelance ? 1 : 0,
        index
      );
    });
  }

  if (settingsCount.n === 0) {
    db.prepare(
      `INSERT INTO relance_settings (id, internal_reminder_after_hours, external_relance_after_hours, max_relances)
       VALUES (1, ?, ?, ?)`
    ).run(
      seed.relance.internalReminderAfterHours,
      seed.relance.externalRelanceAfterHours,
      seed.relance.maxRelances
    );
  }
}

export interface ThreadRow {
  thread_id: string;
  subject: string;
  sender_email: string;
  sender_name: string | null;
  category_id: string;
  urgency: string;
  sla_hours: number;
  status: ThreadStatus;
  received_at: string;
  ack_sent_at: string | null;
  due_at: string | null;
  last_relance_at: string | null;
  relance_count: number;
  created_at: string;
  updated_at: string;
}

export function isMessageProcessed(messageId: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM processed_messages WHERE message_id = ?")
    .get(messageId);
  return row !== undefined;
}

export function markMessageProcessed(messageId: string, threadId: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO processed_messages (message_id, thread_id, processed_at) VALUES (?, ?, ?)"
  ).run(messageId, threadId, new Date().toISOString());
}

export function upsertThreadReceived(params: {
  threadId: string;
  subject: string;
  senderEmail: string;
  senderName: string | null;
  categoryId: string;
  urgency: string;
  slaHours: number;
  status: ThreadStatus;
  dueAt: string | null;
}): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO threads (
      thread_id, subject, sender_email, sender_name, category_id, urgency,
      sla_hours, status, received_at, due_at, relance_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    ON CONFLICT(thread_id) DO UPDATE SET
      subject = excluded.subject,
      category_id = excluded.category_id,
      urgency = excluded.urgency,
      sla_hours = excluded.sla_hours,
      status = excluded.status,
      due_at = excluded.due_at,
      updated_at = excluded.updated_at`
  ).run(
    params.threadId,
    params.subject,
    params.senderEmail,
    params.senderName,
    params.categoryId,
    params.urgency,
    params.slaHours,
    params.status,
    now,
    params.dueAt,
    now,
    now
  );
}

export function setThreadStatus(threadId: string, status: ThreadStatus): void {
  db.prepare("UPDATE threads SET status = ?, updated_at = ? WHERE thread_id = ?").run(
    status,
    new Date().toISOString(),
    threadId
  );
}

export function setThreadAckSent(threadId: string): void {
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE threads SET status = 'ack_sent', ack_sent_at = ?, updated_at = ? WHERE thread_id = ?"
  ).run(now, now, threadId);
}

export function getThreadRow(threadId: string): ThreadRow | undefined {
  return db.prepare("SELECT * FROM threads WHERE thread_id = ?").get(threadId) as
    | ThreadRow
    | undefined;
}

export function recordDraft(params: {
  threadId: string;
  connectorDraftId: string;
  variant: string;
  label: string;
}): void {
  db.prepare(
    "INSERT INTO drafts (thread_id, connector_draft_id, variant, label, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(params.threadId, params.connectorDraftId, params.variant, params.label, new Date().toISOString());
}

export function recordReminder(threadId: string, kind: "internal" | "external", note: string): void {
  db.prepare(
    "INSERT INTO reminders (thread_id, kind, note, created_at) VALUES (?, ?, ?, ?)"
  ).run(threadId, kind, note, new Date().toISOString());
}

export function incrementRelance(threadId: string, status: ThreadStatus): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE threads SET
      relance_count = relance_count + 1,
      last_relance_at = ?,
      status = ?,
      updated_at = ?
     WHERE thread_id = ?`
  ).run(now, status, now, threadId);
}

export function listRecentThreads(limit = 100): ThreadRow[] {
  return db
    .prepare("SELECT * FROM threads ORDER BY updated_at DESC LIMIT ?")
    .all(limit) as unknown as ThreadRow[];
}

export function listThreadsAwaitingReply(): ThreadRow[] {
  return db
    .prepare(
      `SELECT * FROM threads
       WHERE status IN ('ack_sent', 'drafts_ready', 'relance_sent')
       AND due_at IS NOT NULL`
    )
    .all() as unknown as ThreadRow[];
}

export function deleteThreadData(threadId: string): void {
  db.prepare("DELETE FROM reminders WHERE thread_id = ?").run(threadId);
  db.prepare("DELETE FROM drafts WHERE thread_id = ?").run(threadId);
  db.prepare("DELETE FROM processed_messages WHERE thread_id = ?").run(threadId);
  db.prepare("DELETE FROM threads WHERE thread_id = ?").run(threadId);
}

interface CategoryRow {
  id: string;
  label: string;
  sla_hours: number;
  acknowledge_automatically: number;
  allow_external_relance: number;
  sort_order: number;
}

function toCategoryConfig(row: CategoryRow): CategoryConfig {
  return {
    id: row.id,
    label: row.label,
    slaHours: row.sla_hours,
    acknowledgeAutomatically: row.acknowledge_automatically === 1,
    allowExternalRelance: row.allow_external_relance === 1,
  };
}

export function listCategories(): CategoryConfig[] {
  const rows = db
    .prepare("SELECT * FROM categories ORDER BY sort_order ASC")
    .all() as unknown as CategoryRow[];
  return rows.map(toCategoryConfig);
}

export function updateCategory(
  id: string,
  patch: { label: string; slaHours: number; acknowledgeAutomatically: boolean; allowExternalRelance: boolean }
): void {
  db.prepare(
    `UPDATE categories SET
      label = ?,
      sla_hours = ?,
      acknowledge_automatically = ?,
      allow_external_relance = ?
     WHERE id = ?`
  ).run(
    patch.label,
    patch.slaHours,
    patch.acknowledgeAutomatically ? 1 : 0,
    patch.allowExternalRelance ? 1 : 0,
    id
  );
}

interface RelanceSettingsRow {
  internal_reminder_after_hours: number;
  external_relance_after_hours: number;
  max_relances: number;
}

export function getRelanceSettingsRow(): RelanceConfig {
  const row = db
    .prepare("SELECT * FROM relance_settings WHERE id = 1")
    .get() as unknown as RelanceSettingsRow;
  return {
    internalReminderAfterHours: row.internal_reminder_after_hours,
    externalRelanceAfterHours: row.external_relance_after_hours,
    maxRelances: row.max_relances,
  };
}

export function updateRelanceSettingsRow(patch: RelanceConfig): void {
  db.prepare(
    `UPDATE relance_settings SET
      internal_reminder_after_hours = ?,
      external_relance_after_hours = ?,
      max_relances = ?
     WHERE id = 1`
  ).run(patch.internalReminderAfterHours, patch.externalRelanceAfterHours, patch.maxRelances);
}

export interface ReminderRow {
  id: number;
  thread_id: string;
  kind: "internal" | "external";
  note: string | null;
  created_at: string;
  subject: string;
  sender_email: string;
}

export function listReminders(limit = 150): ReminderRow[] {
  return db
    .prepare(
      `SELECT r.id, r.thread_id, r.kind, r.note, r.created_at, t.subject, t.sender_email
       FROM reminders r
       JOIN threads t ON t.thread_id = r.thread_id
       ORDER BY r.created_at DESC
       LIMIT ?`
    )
    .all(limit) as unknown as ReminderRow[];
}

export default db;
