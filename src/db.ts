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
    human_replied_at TEXT,
    post_reply_relance_count INTEGER NOT NULL DEFAULT 0,
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
    delay_hours REAL,
    delay_minutes REAL,
    UNIQUE(owner_type, owner_id, step_order)
  );

  -- Sequence distincte declenchee APRES qu'un humain a envoye une reponse de
  -- fond (ex: le devis): on attend alors la reponse DU CLIENT a ce message,
  -- et on le relance lui si il reste silencieux. Table separee de
  -- relance_steps (plutot qu'une colonne "phase") pour eviter tout conflit
  -- avec la contrainte UNIQUE existante lors de la migration en production.
  CREATE TABLE IF NOT EXISTS post_reply_relance_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_type TEXT NOT NULL CHECK (owner_type IN ('category', 'thread')),
    owner_id TEXT NOT NULL,
    step_order INTEGER NOT NULL,
    channel TEXT NOT NULL CHECK (channel IN ('internal', 'external')),
    delay_minutes REAL NOT NULL,
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

ensureDelayMinutesColumn();
ensureThreadPostReplyColumns();
seedIfNeeded();

/**
 * Migration additive: les deploiements anterieurs a la bascule heures->minutes
 * n'ont que delay_hours. Ajoute delay_minutes si absente (ALTER TABLE ADD
 * COLUMN, sans danger sur une table existante) et retro-remplit a partir de
 * delay_hours * 60 pour ne pas perdre les sequences deja configurees.
 */
function ensureDelayMinutesColumn(): void {
  const columns = db.prepare("PRAGMA table_info(relance_steps)").all() as unknown as {
    name: string;
  }[];
  if (columns.some((c) => c.name === "delay_minutes")) return;
  db.exec("ALTER TABLE relance_steps ADD COLUMN delay_minutes REAL");
  db.exec("UPDATE relance_steps SET delay_minutes = delay_hours * 60 WHERE delay_minutes IS NULL");
}

/** Migration additive: ajoute les colonnes du cycle "post-reponse" sur threads si absentes. */
function ensureThreadPostReplyColumns(): void {
  const columns = db.prepare("PRAGMA table_info(threads)").all() as unknown as { name: string }[];
  if (!columns.some((c) => c.name === "human_replied_at")) {
    db.exec("ALTER TABLE threads ADD COLUMN human_replied_at TEXT");
  }
  if (!columns.some((c) => c.name === "post_reply_relance_count")) {
    db.exec("ALTER TABLE threads ADD COLUMN post_reply_relance_count INTEGER NOT NULL DEFAULT 0");
  }
}

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
  const postReplyStepOwnerCount = db
    .prepare("SELECT COUNT(*) AS n FROM post_reply_relance_steps WHERE owner_type = 'category'")
    .get() as { n: number };
  if (categoryCount.n > 0 && stepOwnerCount.n > 0 && postReplyStepOwnerCount.n > 0) return;

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

  const existingCategoryIds = (
    db.prepare("SELECT id FROM categories").all() as unknown as { id: string }[]
  ).map((r) => r.id);

  if (stepOwnerCount.n === 0) {
    for (const categoryId of existingCategoryIds) {
      const fromSeed = seedById.get(categoryId);
      const steps = fromSeed
        ? [
            { channel: "internal" as const, delayMinutes: seed.relance.internalReminderAfterHours * 60 },
            {
              channel: fromSeed.allowExternalRelance ? ("external" as const) : ("internal" as const),
              delayMinutes:
                (seed.relance.internalReminderAfterHours + seed.relance.externalRelanceAfterHours) * 60,
            },
          ]
        : [{ channel: "internal" as const, delayMinutes: 24 * 60 }];
      writeSteps("pre_reply", "category", categoryId, steps);
    }
  }

  if (postReplyStepOwnerCount.n === 0) {
    // Une fois qu'un humain a envoye une reponse de fond (devis, etc.), une
    // seule relance externe par defaut apres 3 jours si le client n'a pas
    // repondu — ajustable par categorie depuis /reglages.
    for (const categoryId of existingCategoryIds) {
      writeSteps("post_reply", "category", categoryId, [{ channel: "external", delayMinutes: 3 * 1440 }]);
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
  human_replied_at: string | null;
  post_reply_relance_count: number;
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

/** Bascule un dossier en "attente de reponse client": un humain vient d'envoyer une reponse de fond (ex: le devis). */
export function setThreadHumanReplied(threadId: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE threads SET
      status = 'awaiting_client_reply',
      human_replied_at = ?,
      updated_at = ?
     WHERE thread_id = ?`
  ).run(now, now, threadId);
}

export function incrementPostReplyRelance(threadId: string, status: ThreadStatus): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE threads SET
      post_reply_relance_count = post_reply_relance_count + 1,
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

/** Dossiers ou un humain a repondu et on attend desormais la reponse du client a ce message. */
export function listThreadsAwaitingClientReply(): ThreadRow[] {
  return db
    .prepare(`SELECT * FROM threads WHERE status = 'awaiting_client_reply' AND human_replied_at IS NOT NULL`)
    .all() as unknown as ThreadRow[];
}

export function deleteThreadData(threadId: string): void {
  db.prepare("DELETE FROM reminders WHERE thread_id = ?").run(threadId);
  db.prepare("DELETE FROM drafts WHERE thread_id = ?").run(threadId);
  db.prepare("DELETE FROM processed_messages WHERE thread_id = ?").run(threadId);
  db.prepare("DELETE FROM relance_steps WHERE owner_type = 'thread' AND owner_id = ?").run(threadId);
  db.prepare("DELETE FROM post_reply_relance_steps WHERE owner_type = 'thread' AND owner_id = ?").run(threadId);
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

/**
 * "pre_reply" (par defaut): sequence qui nudge notre equipe tant que
 * personne n'a repondu de fond au client. "post_reply": sequence qui
 * relance LE CLIENT une fois qu'un humain lui a envoye une reponse de fond
 * (ex: le devis) et qu'il reste silencieux. Deux tables separees
 * (relance_steps / post_reply_relance_steps) plutot qu'une colonne "phase",
 * pour ne pas toucher a la contrainte UNIQUE existante de relance_steps.
 */
export type RelancePhase = "pre_reply" | "post_reply";

type StepTable = "relance_steps" | "post_reply_relance_steps";

function tableFor(phase: RelancePhase): StepTable {
  return phase === "post_reply" ? "post_reply_relance_steps" : "relance_steps";
}

interface RelanceStepRow {
  step_order: number;
  channel: string;
  delay_minutes: number;
}

function readSteps(
  phase: RelancePhase,
  ownerType: "category" | "thread",
  ownerId: string
): RelanceStep[] {
  const rows = db
    .prepare(
      `SELECT step_order, channel, delay_minutes FROM ${tableFor(phase)} WHERE owner_type = ? AND owner_id = ? ORDER BY step_order ASC`
    )
    .all(ownerType, ownerId) as unknown as RelanceStepRow[];
  return rows.map((r) => ({
    order: r.step_order,
    channel: r.channel as RelanceChannel,
    delayMinutes: r.delay_minutes,
  }));
}

function writeSteps(
  phase: RelancePhase,
  ownerType: "category" | "thread",
  ownerId: string,
  steps: Array<{ channel: RelanceChannel; delayMinutes: number }>
): void {
  const table = tableFor(phase);
  db.prepare(`DELETE FROM ${table} WHERE owner_type = ? AND owner_id = ?`).run(ownerType, ownerId);
  const insert = db.prepare(
    `INSERT INTO ${table} (owner_type, owner_id, step_order, channel, delay_minutes) VALUES (?, ?, ?, ?, ?)`
  );
  steps.forEach((step, index) => {
    insert.run(ownerType, ownerId, index + 1, step.channel, step.delayMinutes);
  });
}

export function getCategoryRelanceSteps(
  categoryId: string,
  phase: RelancePhase = "pre_reply"
): RelanceStep[] {
  return readSteps(phase, "category", categoryId);
}

export function addCategoryRelanceStep(
  categoryId: string,
  step: { channel: RelanceChannel; delayMinutes: number },
  phase: RelancePhase = "pre_reply"
): void {
  writeSteps(phase, "category", categoryId, [...readSteps(phase, "category", categoryId), step]);
}

export function deleteCategoryRelanceStep(
  categoryId: string,
  order: number,
  phase: RelancePhase = "pre_reply"
): void {
  writeSteps(
    phase,
    "category",
    categoryId,
    readSteps(phase, "category", categoryId).filter((s) => s.order !== order)
  );
}

export function hasThreadRelanceOverride(threadId: string, phase: RelancePhase = "pre_reply"): boolean {
  const row = db
    .prepare(`SELECT 1 FROM ${tableFor(phase)} WHERE owner_type = 'thread' AND owner_id = ? LIMIT 1`)
    .get(threadId);
  return row !== undefined;
}

export function getThreadRelanceOverride(
  threadId: string,
  phase: RelancePhase = "pre_reply"
): RelanceStep[] {
  return readSteps(phase, "thread", threadId);
}

export function addThreadRelanceStep(
  threadId: string,
  step: { channel: RelanceChannel; delayMinutes: number },
  phase: RelancePhase = "pre_reply"
): void {
  writeSteps(phase, "thread", threadId, [...readSteps(phase, "thread", threadId), step]);
}

export function deleteThreadRelanceStep(
  threadId: string,
  order: number,
  phase: RelancePhase = "pre_reply"
): void {
  writeSteps(
    phase,
    "thread",
    threadId,
    readSteps(phase, "thread", threadId).filter((s) => s.order !== order)
  );
}

export function clearThreadRelanceOverride(threadId: string, phase: RelancePhase = "pre_reply"): void {
  db.prepare(`DELETE FROM ${tableFor(phase)} WHERE owner_type = 'thread' AND owner_id = ?`).run(threadId);
}

export function getEffectiveRelanceSteps(
  threadId: string,
  categoryId: string,
  phase: RelancePhase = "pre_reply"
): { steps: RelanceStep[]; isCustom: boolean } {
  const overrideSteps = readSteps(phase, "thread", threadId);
  if (overrideSteps.length > 0) return { steps: overrideSteps, isCustom: true };
  return { steps: readSteps(phase, "category", categoryId), isCustom: false };
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
