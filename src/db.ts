import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import type { ThreadStatus } from "./types.js";

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
`);

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

export default db;
