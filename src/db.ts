import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import type { CategoryConfig, RelanceChannel, RelanceStep, ThreadStatus } from "./types.js";

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
    sort_order INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS relance_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_type TEXT NOT NULL CHECK (owner_type IN ('category', 'thread')),
    owner_id TEXT NOT NULL,
    step_order INTEGER NOT NULL,
    channel TEXT NOT NULL CHECK (channel IN ('internal', 'external')),
    delay_hours REAL NOT NULL,
    UNIQUE(owner_type, owner_id, step_order)
  );

  CREATE TABLE IF NOT EXISTS pipeline_errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    context TEXT NOT NULL,
    thread_id TEXT,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

seedIfNeeded();

/** Forme du fichier JSON d'amorçage historique (config/categories.json) — figee, distincte du modele runtime actuel. */
interface CategoriesSeedFile {
  categories: Array<{
    id: string;
    label: string;
    slaHours: number;
    acknowledgeAutomatically: boolean;
    allowExternalRelance: boolean;
  }>;
  relance: {
    internalReminderAfterHours: number;
    externalRelanceAfterHours: number;
    maxRelances: number;
  };
}

function seedIfNeeded(): void {
  const categoryCount = db.prepare("SELECT COUNT(*) AS n FROM categories").get() as { n: number };
  const stepOwnerCount = db
    .prepare("SELECT COUNT(*) AS n FROM relance_steps WHERE owner_type = 'category'")
    .get() as { n: number };
  if (categoryCount.n > 0 && stepOwnerCount.n > 0) return;

  const raw = readFileSync(path.resolve(config.categoriesConfigPath), "utf-8");
  const seed = JSON.parse(raw) as CategoriesSeedFile;
  const seedById = new Map(seed.categories.map((cat) => [cat.id, cat]));

  if (categoryCount.n === 0) {
    const insert = db.prepare(
      `INSERT INTO categories (id, label, sla_hours, acknowledge_automatically, sort_order)
       VALUES (?, ?, ?, ?, ?)`
    );
    seed.categories.forEach((cat, index) => {
      insert.run(cat.id, cat.label, cat.slaHours, cat.acknowledgeAutomatically ? 1 : 0, index);
    });
  }

  if (stepOwnerCount.n === 0) {
    const existingCategoryIds = (
      db.prepare("SELECT id FROM categories").all() as unknown as { id: string }[]
    ).map((r) => r.id);

    for (const categoryId of existingCategoryIds) {
      const fromSeed = seedById.get(categoryId);
      const steps = fromSeed
        ? [
            { channel: "internal" as const, delayHours: seed.relance.internalReminderAfterHours },
            {
              channel: fromSeed.allowExternalRelance ? ("external" as const) : ("internal" as const),
              delayHours: seed.relance.internalReminderAfterHours + seed.relance.externalRelanceAfterHours,
            },
          ]
        : [{ channel: "internal" as const, delayHours: 24 }];
      writeSteps("category", categoryId, steps);
    }
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
  db.prepare("DELETE FROM relance_steps WHERE owner_type = 'thread' AND owner_id = ?").run(threadId);
  db.prepare("DELETE FROM threads WHERE thread_id = ?").run(threadId);
}

interface CategoryRow {
  id: string;
  label: string;
  sla_hours: number;
  acknowledge_automatically: number;
  sort_order: number;
}

function toCategoryConfig(row: CategoryRow): CategoryConfig {
  return {
    id: row.id,
    label: row.label,
    slaHours: row.sla_hours,
    acknowledgeAutomatically: row.acknowledge_automatically === 1,
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
  patch: { label: string; slaHours: number; acknowledgeAutomatically: boolean }
): void {
  db.prepare(
    `UPDATE categories SET
      label = ?,
      sla_hours = ?,
      acknowledge_automatically = ?
     WHERE id = ?`
  ).run(patch.label, patch.slaHours, patch.acknowledgeAutomatically ? 1 : 0, id);
}

// ---------- Sequences de relance (par categorie ou surcharge par dossier) ----------

interface RelanceStepRow {
  step_order: number;
  channel: string;
  delay_hours: number;
}

function readSteps(ownerType: "category" | "thread", ownerId: string): RelanceStep[] {
  const rows = db
    .prepare(
      "SELECT step_order, channel, delay_hours FROM relance_steps WHERE owner_type = ? AND owner_id = ? ORDER BY step_order ASC"
    )
    .all(ownerType, ownerId) as unknown as RelanceStepRow[];
  return rows.map((r) => ({
    order: r.step_order,
    channel: r.channel as RelanceChannel,
    delayHours: r.delay_hours,
  }));
}

function writeSteps(
  ownerType: "category" | "thread",
  ownerId: string,
  steps: Array<{ channel: RelanceChannel; delayHours: number }>
): void {
  db.prepare("DELETE FROM relance_steps WHERE owner_type = ? AND owner_id = ?").run(ownerType, ownerId);
  const insert = db.prepare(
    "INSERT INTO relance_steps (owner_type, owner_id, step_order, channel, delay_hours) VALUES (?, ?, ?, ?, ?)"
  );
  steps.forEach((step, index) => {
    insert.run(ownerType, ownerId, index + 1, step.channel, step.delayHours);
  });
}

export function getCategoryRelanceSteps(categoryId: string): RelanceStep[] {
  return readSteps("category", categoryId);
}

export function addCategoryRelanceStep(
  categoryId: string,
  step: { channel: RelanceChannel; delayHours: number }
): void {
  writeSteps("category", categoryId, [...readSteps("category", categoryId), step]);
}

export function deleteCategoryRelanceStep(categoryId: string, order: number): void {
  writeSteps(
    "category",
    categoryId,
    readSteps("category", categoryId).filter((s) => s.order !== order)
  );
}

export function hasThreadRelanceOverride(threadId: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM relance_steps WHERE owner_type = 'thread' AND owner_id = ? LIMIT 1")
    .get(threadId);
  return row !== undefined;
}

export function getThreadRelanceOverride(threadId: string): RelanceStep[] {
  return readSteps("thread", threadId);
}

export function addThreadRelanceStep(
  threadId: string,
  step: { channel: RelanceChannel; delayHours: number }
): void {
  writeSteps("thread", threadId, [...readSteps("thread", threadId), step]);
}

export function deleteThreadRelanceStep(threadId: string, order: number): void {
  writeSteps(
    "thread",
    threadId,
    readSteps("thread", threadId).filter((s) => s.order !== order)
  );
}

export function clearThreadRelanceOverride(threadId: string): void {
  db.prepare("DELETE FROM relance_steps WHERE owner_type = 'thread' AND owner_id = ?").run(threadId);
}

export function getEffectiveRelanceSteps(
  threadId: string,
  categoryId: string
): { steps: RelanceStep[]; isCustom: boolean } {
  const overrideSteps = readSteps("thread", threadId);
  if (overrideSteps.length > 0) return { steps: overrideSteps, isCustom: true };
  return { steps: readSteps("category", categoryId), isCustom: false };
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

// ---------- Erreurs du pipeline (visibles depuis le Journal) ----------

export interface PipelineErrorRow {
  id: number;
  context: string;
  thread_id: string | null;
  message: string;
  created_at: string;
}

export function recordPipelineError(context: string, threadId: string | null, message: string): void {
  db.prepare(
    "INSERT INTO pipeline_errors (context, thread_id, message, created_at) VALUES (?, ?, ?, ?)"
  ).run(context, threadId, message, new Date().toISOString());
}

export function listPipelineErrors(limit = 100): PipelineErrorRow[] {
  return db
    .prepare("SELECT * FROM pipeline_errors ORDER BY created_at DESC LIMIT ?")
    .all(limit) as unknown as PipelineErrorRow[];
}

// ---------- Brouillons deposes (pour nettoyage a la cloture d'un dossier) ----------

export interface DraftRow {
  id: number;
  thread_id: string;
  connector_draft_id: string;
  variant: string;
  label: string;
  created_at: string;
}

export function listDraftsForThread(threadId: string): DraftRow[] {
  return db
    .prepare("SELECT * FROM drafts WHERE thread_id = ?")
    .all(threadId) as unknown as DraftRow[];
}

export function deleteDraftRows(threadId: string): void {
  db.prepare("DELETE FROM drafts WHERE thread_id = ?").run(threadId);
}

export default db;
