import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import type { CategoryConfig, RelanceChannel, RelanceStep, ThreadStatus, UrgencyThreshold } from "./types.js";

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
    -- SLA exprime en minutes (remplace sla_hours cote UI/logique — celle-ci
    -- reste ecrite pour compatibilite avec les bases anterieures a la
    -- bascule, ou la colonne est NOT NULL).
    sla_minutes REAL,
    status TEXT NOT NULL,
    received_at TEXT NOT NULL,
    ack_sent_at TEXT,
    due_at TEXT,
    last_relance_at TEXT,
    relance_count INTEGER NOT NULL DEFAULT 0,
    human_replied_at TEXT,
    post_reply_relance_count INTEGER NOT NULL DEFAULT 0,
    -- Vrai si la reponse de fond envoyee au client (ex: devis) contenait une
    -- piece jointe (PDF, etc.) — permet a la relance post-reponse d'y faire
    -- reference sans l'inventer. Renseigne automatiquement quand le
    -- pipeline detecte la reponse (Gmail/Graph exposent l'info nativement).
    outbound_had_attachment INTEGER NOT NULL DEFAULT 0,
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
    -- Idem threads.sla_minutes: source de verite cote UI/logique, sla_hours
    -- reste ecrite pour compatibilite avec les bases anterieures.
    sla_minutes REAL,
    acknowledge_automatically INTEGER NOT NULL,
    sort_order INTEGER NOT NULL,
    -- Filtre anti-spam des rappels internes: une categorie peut nudger
    -- l'equipe systematiquement, seulement au-dela d'une urgence donnee, ou
    -- jamais (0 + 'high') — evite une notification pour chaque demande
    -- banale restee sans reponse.
    internal_alerts_enabled INTEGER NOT NULL DEFAULT 1,
    internal_alerts_min_urgency TEXT NOT NULL DEFAULT 'normal'
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

  -- Un enregistrement par appel Claude (classification, accuse, relance,
  -- brouillons) — sert au compteur de consommation/cout affiche dans
  -- l'admin (page /consommation). call_type identifie l'appel, model le
  -- modele utilise (permet de re-tarifer correctement si le modele change).
  CREATE TABLE IF NOT EXISTS ai_usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_type TEXT NOT NULL,
    thread_id TEXT,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  -- Empreinte de chaque email envoye automatiquement (accuse, relance) par
  -- dossier. checkPreReplyThread doit distinguer "un humain a repondu de
  -- fond" de "notre propre relance automatique vient d'etre envoyee" — les
  -- deux sont des messages isFromUs dans le meme fil, impossibles a
  -- differencier par simple presence. Sans cette table, la relance
  -- pre-reponse elle-meme etait detectee comme LA reponse humaine au cycle
  -- suivant, ce qui faisait basculer le dossier en post-reponse et
  -- declenchait une deuxieme relance client pour une reponse qui n'a
  -- jamais existe.
  CREATE TABLE IF NOT EXISTS automated_sent_bodies (
    thread_id TEXT NOT NULL,
    body_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (thread_id, body_hash)
  );
`);

ensureDelayMinutesColumn();
ensureThreadPostReplyColumns();
ensureThreadAttachmentColumn();
ensureCategoryAlertColumns();
ensureSlaMinutesColumns();
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

/** Migration additive: ajoute outbound_had_attachment sur threads si absente. */
function ensureThreadAttachmentColumn(): void {
  const columns = db.prepare("PRAGMA table_info(threads)").all() as unknown as { name: string }[];
  if (!columns.some((c) => c.name === "outbound_had_attachment")) {
    db.exec("ALTER TABLE threads ADD COLUMN outbound_had_attachment INTEGER NOT NULL DEFAULT 0");
  }
}

/**
 * Migration additive: le SLA est desormais regle et affiche en minutes (plus
 * granulaire, coherent avec les etapes de relance deja en minutes) plutot
 * qu'en heures. Ajoute sla_minutes sur categories et threads si absente, et
 * retro-remplit a partir de sla_hours * 60 pour ne pas perdre les reglages
 * existants. sla_hours reste ecrite en parallele a chaque insertion/mise a
 * jour (voir toCategoryConfig/updateCategory/upsertThreadReceived) car cette
 * colonne est NOT NULL sur les bases anterieures a cette migration.
 */
function ensureSlaMinutesColumns(): void {
  const categoryColumns = db.prepare("PRAGMA table_info(categories)").all() as unknown as { name: string }[];
  if (!categoryColumns.some((c) => c.name === "sla_minutes")) {
    db.exec("ALTER TABLE categories ADD COLUMN sla_minutes REAL");
  }
  db.exec("UPDATE categories SET sla_minutes = sla_hours * 60 WHERE sla_minutes IS NULL");

  const threadColumns = db.prepare("PRAGMA table_info(threads)").all() as unknown as { name: string }[];
  if (!threadColumns.some((c) => c.name === "sla_minutes")) {
    db.exec("ALTER TABLE threads ADD COLUMN sla_minutes REAL");
  }
  db.exec("UPDATE threads SET sla_minutes = sla_hours * 60 WHERE sla_minutes IS NULL");
}

/** Migration additive: ajoute les colonnes de filtre des rappels internes sur categories si absentes. */
function ensureCategoryAlertColumns(): void {
  const columns = db.prepare("PRAGMA table_info(categories)").all() as unknown as { name: string }[];
  if (!columns.some((c) => c.name === "internal_alerts_enabled")) {
    db.exec("ALTER TABLE categories ADD COLUMN internal_alerts_enabled INTEGER NOT NULL DEFAULT 1");
  }
  if (!columns.some((c) => c.name === "internal_alerts_min_urgency")) {
    db.exec("ALTER TABLE categories ADD COLUMN internal_alerts_min_urgency TEXT NOT NULL DEFAULT 'normal'");
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

/**
 * Reglages par defaut du filtre anti-spam des rappels internes, a l'amorçage
 * initial uniquement (modifiable ensuite depuis /reglages sans redeploiement).
 * Choix par defaut: les categories a fort enjeu (reclamation, devis, suivi)
 * alertent l'equipe; les categories a bas enjeu ou volume eleve (information,
 * candidature, non classifie) restent silencieuses par defaut pour ne pas
 * noyer la boite de l'equipe sous des rappels pour des demandes banales.
 */
function defaultAlertSettingsFor(categoryId: string): { enabled: boolean; minUrgency: UrgencyThreshold } {
  switch (categoryId) {
    case "reclamation":
      return { enabled: true, minUrgency: "low" };
    case "devis":
    case "suivi_dossier":
      return { enabled: true, minUrgency: "normal" };
    default:
      return { enabled: false, minUrgency: "high" };
  }
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
      `INSERT INTO categories (
        id, label, sla_hours, sla_minutes, acknowledge_automatically, sort_order,
        internal_alerts_enabled, internal_alerts_min_urgency
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    seed.categories.forEach((cat, index) => {
      const alerts = defaultAlertSettingsFor(cat.id);
      insert.run(
        cat.id,
        cat.label,
        cat.slaHours,
        cat.slaHours * 60,
        cat.acknowledgeAutomatically ? 1 : 0,
        index,
        alerts.enabled ? 1 : 0,
        alerts.minUrgency
      );
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
  sla_minutes: number | null;
  status: ThreadStatus;
  received_at: string;
  ack_sent_at: string | null;
  due_at: string | null;
  last_relance_at: string | null;
  relance_count: number;
  human_replied_at: string | null;
  post_reply_relance_count: number;
  outbound_had_attachment: number;
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
  slaMinutes: number;
  status: ThreadStatus;
  dueAt: string | null;
}): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO threads (
      thread_id, subject, sender_email, sender_name, category_id, urgency,
      sla_hours, sla_minutes, status, received_at, due_at, relance_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    ON CONFLICT(thread_id) DO UPDATE SET
      subject = excluded.subject,
      category_id = excluded.category_id,
      urgency = excluded.urgency,
      sla_hours = excluded.sla_hours,
      sla_minutes = excluded.sla_minutes,
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
    params.slaMinutes / 60,
    params.slaMinutes,
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

/**
 * Bascule un dossier en "attente de reponse client": un humain vient
 * d'envoyer une reponse de fond (ex: le devis). `repliedAt` optionnel pour
 * les dossiers decouverts a posteriori (voir discoverOutbound.ts), afin que
 * l'ancrage de la sequence post-reponse soit l'heure reelle d'envoi, pas
 * l'heure de decouverte par le pipeline.
 */
export function setThreadHumanReplied(threadId: string, repliedAt?: string, hadAttachment = false): void {
  const now = new Date().toISOString();
  const humanRepliedAt = repliedAt ?? now;
  db.prepare(
    `UPDATE threads SET
      status = 'awaiting_client_reply',
      human_replied_at = ?,
      outbound_had_attachment = ?,
      updated_at = ?
     WHERE thread_id = ?`
  ).run(humanRepliedAt, hadAttachment ? 1 : 0, now, threadId);
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

/**
 * Dossiers ou un humain a repondu et on attend desormais la reponse du
 * client a ce message — que la sequence post-reponse ait deja envoye une
 * relance ou non. Sans inclure 'post_reply_relance_sent', un dossier
 * cessait d'etre reexamine des sa premiere relance post-reponse envoyee.
 */
export function listThreadsAwaitingClientReply(): ThreadRow[] {
  return db
    .prepare(
      `SELECT * FROM threads
       WHERE status IN ('awaiting_client_reply', 'post_reply_relance_sent')
       AND human_replied_at IS NOT NULL`
    )
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
  sla_minutes: number | null;
  acknowledge_automatically: number;
  sort_order: number;
  internal_alerts_enabled: number;
  internal_alerts_min_urgency: string;
}

function toCategoryConfig(row: CategoryRow): CategoryConfig {
  return {
    id: row.id,
    label: row.label,
    slaMinutes: row.sla_minutes ?? row.sla_hours * 60,
    acknowledgeAutomatically: row.acknowledge_automatically === 1,
    internalAlertsEnabled: row.internal_alerts_enabled === 1,
    internalAlertsMinUrgency: (row.internal_alerts_min_urgency as UrgencyThreshold) || "normal",
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
  patch: {
    label: string;
    slaMinutes: number;
    acknowledgeAutomatically: boolean;
    internalAlertsEnabled: boolean;
    internalAlertsMinUrgency: UrgencyThreshold;
  }
): void {
  db.prepare(
    `UPDATE categories SET
      label = ?,
      sla_hours = ?,
      sla_minutes = ?,
      acknowledge_automatically = ?,
      internal_alerts_enabled = ?,
      internal_alerts_min_urgency = ?
     WHERE id = ?`
  ).run(
    patch.label,
    patch.slaMinutes / 60,
    patch.slaMinutes,
    patch.acknowledgeAutomatically ? 1 : 0,
    patch.internalAlertsEnabled ? 1 : 0,
    patch.internalAlertsMinUrgency,
    id
  );
}

const COMBINING_DIACRITICS = new RegExp("[\\u0300-\\u036f]", "g");

function slugify(label: string): string {
  const base = label
    .normalize("NFD")
    .replace(COMBINING_DIACRITICS, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return base || "categorie";
}

function uniqueCategoryId(base: string): string {
  const existing = new Set(
    (db.prepare("SELECT id FROM categories").all() as unknown as { id: string }[]).map((r) => r.id)
  );
  if (!existing.has(base)) return base;
  let n = 2;
  while (existing.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

/**
 * Cree une categorie a la volee depuis /reglages, sans redeploiement ni
 * edition de config/categories.json. L'id est derive automatiquement du
 * libelle (slug), pour eviter de demander a l'admin de choisir un
 * identifiant technique. Une sequence de relance minimale par defaut est
 * ecrite immediatement (1 rappel interne a J+1, 1 relance externe a J+3
 * apres reponse) pour que la categorie soit utilisable des sa creation.
 */
export function createCategory(params: {
  label: string;
  slaMinutes: number;
  acknowledgeAutomatically: boolean;
}): CategoryConfig {
  const id = uniqueCategoryId(slugify(params.label));
  const maxOrderRow = db.prepare("SELECT COALESCE(MAX(sort_order), -1) AS maxOrder FROM categories").get() as {
    maxOrder: number;
  };
  db.prepare(
    `INSERT INTO categories (
      id, label, sla_hours, sla_minutes, acknowledge_automatically, sort_order,
      internal_alerts_enabled, internal_alerts_min_urgency
    ) VALUES (?, ?, ?, ?, ?, ?, 1, 'normal')`
  ).run(
    id,
    params.label,
    params.slaMinutes / 60,
    params.slaMinutes,
    params.acknowledgeAutomatically ? 1 : 0,
    maxOrderRow.maxOrder + 1
  );

  writeSteps("pre_reply", "category", id, [{ channel: "internal", delayMinutes: 1440 }]);
  writeSteps("post_reply", "category", id, [{ channel: "external", delayMinutes: 3 * 1440 }]);

  return toCategoryConfig(
    db.prepare("SELECT * FROM categories WHERE id = ?").get(id) as unknown as CategoryRow
  );
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

  // `relance_steps` (pre_reply) predates delay_minutes: sur une base creee
  // avant la bascule heures->minutes, sa colonne delay_hours est restee
  // NOT NULL (CREATE TABLE IF NOT EXISTS ne modifie jamais une table
  // existante). Ne jamais fournir delay_hours ici faisait donc echouer tout
  // ajout/suppression d'etape avec "NOT NULL constraint failed:
  // relance_steps.delay_hours" sur ces bases-la. On la renseigne toujours
  // (calculee depuis delayMinutes), ce qui reste compatible avec les bases
  // recentes ou la colonne est nullable. post_reply_relance_steps n'a jamais
  // eu cette colonne, donc pas concernee.
  if (table === "relance_steps") {
    const insert = db.prepare(
      `INSERT INTO relance_steps (owner_type, owner_id, step_order, channel, delay_hours, delay_minutes)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    steps.forEach((step, index) => {
      insert.run(ownerType, ownerId, index + 1, step.channel, step.delayMinutes / 60, step.delayMinutes);
    });
    return;
  }

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

// ---------- Consommation IA (tokens Claude, pour le compteur /consommation) ----------

export interface AiUsageEventRow {
  id: number;
  call_type: string;
  thread_id: string | null;
  model: string;
  input_tokens: number;
  output_tokens: number;
  created_at: string;
}

export function recordAiUsage(params: {
  callType: string;
  threadId: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
}): void {
  db.prepare(
    `INSERT INTO ai_usage_events (call_type, thread_id, model, input_tokens, output_tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    params.callType,
    params.threadId,
    params.model,
    params.inputTokens,
    params.outputTokens,
    new Date().toISOString()
  );
}

export function listRecentAiUsage(limit = 50): AiUsageEventRow[] {
  return db
    .prepare("SELECT * FROM ai_usage_events ORDER BY created_at DESC LIMIT ?")
    .all(limit) as unknown as AiUsageEventRow[];
}

export interface AiUsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface AiUsageSummary {
  since: string;
  total: AiUsageTotals;
  byCallType: Array<{ callType: string } & AiUsageTotals>;
}

/** Agrege la consommation depuis `sinceIso` (ex: debut du mois courant) — total et repartition par type d'appel. */
export function getAiUsageSummarySince(sinceIso: string): AiUsageSummary {
  const total = db
    .prepare(
      `SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens
       FROM ai_usage_events WHERE created_at >= ?`
    )
    .get(sinceIso) as unknown as AiUsageTotals;

  const byCallType = db
    .prepare(
      `SELECT call_type AS callType, COUNT(*) AS calls,
              COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens
       FROM ai_usage_events WHERE created_at >= ?
       GROUP BY call_type
       ORDER BY (SUM(input_tokens) + SUM(output_tokens)) DESC`
    )
    .all(sinceIso) as unknown as Array<{ callType: string } & AiUsageTotals>;

  return { since: sinceIso, total, byCallType };
}

// ---------- Empreintes des envois automatiques (distinguer un humain d'une relance) ----------

/**
 * Le corps est envoye tel quel (fins de ligne \n) dans le MIME brut, mais
 * Gmail/Graph normalisent frequemment les fins de ligne (\r\n) au stockage
 * — le texte relu via l'API peut donc differer octet pour octet de celui
 * envoye, sans aucune difference de CONTENU reelle. Un hash strict sur le
 * texte brut ratait alors la correspondance et laissait passer notre propre
 * accuse/relance comme "reponse humaine". On normalise tous les espaces
 * (fins de ligne comprises) avant de hasher, pour ne comparer que le
 * contenu textuel reel.
 */
function normalizeForHash(bodyText: string): string {
  return bodyText.replace(/\s+/g, " ").trim();
}

function hashBody(bodyText: string): string {
  return createHash("sha256").update(normalizeForHash(bodyText)).digest("hex");
}

/** A appeler juste apres l'envoi reussi d'un accuse ou d'une relance automatique. */
export function markBodySentByAutomation(threadId: string, bodyText: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO automated_sent_bodies (thread_id, body_hash, created_at) VALUES (?, ?, ?)"
  ).run(threadId, hashBody(bodyText), new Date().toISOString());
}

/** Vrai si ce texte exact a deja ete envoye par l'automation pour ce dossier (donc pas une reponse humaine). */
export function wasBodySentByAutomation(threadId: string, bodyText: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM automated_sent_bodies WHERE thread_id = ? AND body_hash = ?")
    .get(threadId, hashBody(bodyText));
  return row !== undefined;
}

export default db;
