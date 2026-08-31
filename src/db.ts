import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPool } from "./dbPool.js";
import { config } from "./config.js";
import type { CategoryConfig, RelanceChannel, RelanceStep, ThreadStatus, UrgencyThreshold } from "./types.js";

const pool = getPool();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(__dirname, "..", "supabase", "migrations", "0001_init.sql");

async function ensureSchema(): Promise<void> {
  const sql = readFileSync(SCHEMA_PATH, "utf-8");
  await pool.query(sql);
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

/**
 * Amorçage initial des categories/sequences depuis config/categories.json —
 * une seule fois, a la premiere connexion a une base vide. Editable ensuite
 * exclusivement depuis /reglages: ce fichier n'est plus jamais relu apres
 * ce premier amorçage.
 */
async function seedIfNeeded(): Promise<void> {
  const categoryCount = await pool.query<{ n: string }>("SELECT COUNT(*) AS n FROM categories");
  const stepOwnerCount = await pool.query<{ n: string }>(
    "SELECT COUNT(*) AS n FROM relance_steps WHERE owner_type = 'category'"
  );
  const postReplyStepOwnerCount = await pool.query<{ n: string }>(
    "SELECT COUNT(*) AS n FROM post_reply_relance_steps WHERE owner_type = 'category'"
  );
  const hasCategories = Number(categoryCount.rows[0].n) > 0;
  const hasSteps = Number(stepOwnerCount.rows[0].n) > 0;
  const hasPostReplySteps = Number(postReplyStepOwnerCount.rows[0].n) > 0;
  if (hasCategories && hasSteps && hasPostReplySteps) return;

  const raw = readFileSync(path.resolve(config.categoriesConfigPath), "utf-8");
  const seed = JSON.parse(raw) as CategoriesSeedFile;
  const seedById = new Map(seed.categories.map((cat) => [cat.id, cat]));

  if (!hasCategories) {
    for (let index = 0; index < seed.categories.length; index++) {
      const cat = seed.categories[index];
      const alerts = defaultAlertSettingsFor(cat.id);
      await pool.query(
        `INSERT INTO categories (
          id, label, sla_minutes, acknowledge_automatically, sort_order,
          internal_alerts_enabled, internal_alerts_min_urgency, is_ignored, is_fallback
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          cat.id,
          cat.label,
          Math.round(cat.slaHours * 60),
          cat.acknowledgeAutomatically ? 1 : 0,
          index,
          alerts.enabled ? 1 : 0,
          alerts.minUrgency,
          cat.id === "spam_newsletter" ? 1 : 0,
          cat.id === "autre" ? 1 : 0,
        ]
      );
    }
  }

  const existingCategoryIds = (await pool.query<{ id: string }>("SELECT id FROM categories")).rows.map(
    (r) => r.id
  );

  if (!hasSteps) {
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
      await writeSteps("pre_reply", "category", categoryId, steps);
    }
  }

  if (!hasPostReplySteps) {
    // Une fois qu'un humain a envoye une reponse de fond (devis, etc.), une
    // seule relance externe par defaut apres 3 jours si le client n'a pas
    // repondu — ajustable par categorie depuis /reglages.
    for (const categoryId of existingCategoryIds) {
      await writeSteps("post_reply", "category", categoryId, [{ channel: "external", delayMinutes: 3 * 1440 }]);
    }
  }
}

/**
 * Amorce la ligne unique `brand_voice` depuis config/brand-voice.md, une
 * seule fois (base vide) — modifiable ensuite exclusivement depuis
 * /ton-de-marque, ce fichier n'est plus jamais relu apres ce premier
 * amorçage. Absence de fichier de depart tolerée (n'empeche pas le
 * demarrage): la ligne reste alors simplement absente jusqu'a la premiere
 * sauvegarde depuis /ton-de-marque.
 */
async function seedBrandVoiceIfNeeded(): Promise<void> {
  const existing = await pool.query("SELECT 1 FROM brand_voice WHERE id = 1");
  if (existing.rowCount) return;
  let content: string;
  try {
    content = readFileSync(path.resolve(config.brandVoicePath), "utf-8");
  } catch {
    return;
  }
  await pool.query(
    "INSERT INTO brand_voice (id, content, updated_at) VALUES (1, $1, $2) ON CONFLICT (id) DO NOTHING",
    [content, new Date().toISOString()]
  );
}

await ensureSchema();
await seedIfNeeded();
await seedBrandVoiceIfNeeded();

export interface ThreadRow {
  thread_id: string;
  subject: string;
  sender_email: string;
  sender_name: string | null;
  category_id: string;
  urgency: string;
  sla_minutes: number;
  status: ThreadStatus;
  received_at: string;
  ack_sent_at: string | null;
  due_at: string | null;
  last_relance_at: string | null;
  relance_count: number;
  human_replied_at: string | null;
  post_reply_relance_count: number;
  outbound_had_attachment: number;
  automated_outbound_count: number;
  origin: "inbound" | "outbound";
  created_at: string;
  updated_at: string;
}

export async function isMessageProcessed(messageId: string): Promise<boolean> {
  const result = await pool.query("SELECT 1 FROM processed_messages WHERE message_id = $1", [messageId]);
  return (result.rowCount ?? 0) > 0;
}

export async function markMessageProcessed(messageId: string, threadId: string): Promise<void> {
  await pool.query(
    "INSERT INTO processed_messages (message_id, thread_id, processed_at) VALUES ($1, $2, $3) ON CONFLICT (message_id) DO NOTHING",
    [messageId, threadId, new Date().toISOString()]
  );
}

export async function upsertThreadReceived(params: {
  threadId: string;
  subject: string;
  senderEmail: string;
  senderName: string | null;
  categoryId: string;
  urgency: string;
  slaMinutes: number;
  status: ThreadStatus;
  dueAt: string | null;
  origin?: "inbound" | "outbound";
}): Promise<void> {
  const now = new Date().toISOString();
  await pool.query(
    `INSERT INTO threads (
      thread_id, subject, sender_email, sender_name, category_id, urgency,
      sla_minutes, status, received_at, due_at, relance_count, origin, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, $11, $12, $13)
    ON CONFLICT (thread_id) DO UPDATE SET
      subject = excluded.subject,
      category_id = excluded.category_id,
      urgency = excluded.urgency,
      sla_minutes = excluded.sla_minutes,
      -- Ne jamais retrograder un dossier deja passe en post-reponse
      -- (human_replied_at deja pose): un entrant qui arrive en retard sur un
      -- fil ou l'equipe a deja repondu (course avec discoverOutbound, voir
      -- CLAUDE.md/audit BUG-004) ne doit pas repasser le statut a "received"
      -- ni reculer l'echeance due_at — sinon le dossier oscille entre les
      -- deux phases et pollue le corpus/les metriques de reponse humaine.
      status = CASE WHEN threads.human_replied_at IS NOT NULL THEN threads.status ELSE excluded.status END,
      due_at = CASE WHEN threads.human_replied_at IS NOT NULL THEN threads.due_at ELSE excluded.due_at END,
      updated_at = excluded.updated_at`,
    [
      params.threadId,
      params.subject,
      params.senderEmail,
      params.senderName,
      params.categoryId,
      params.urgency,
      params.slaMinutes,
      params.status,
      now,
      params.dueAt,
      params.origin ?? "inbound",
      now,
      now,
    ]
  );
}

export async function setThreadStatus(threadId: string, status: ThreadStatus): Promise<void> {
  await pool.query("UPDATE threads SET status = $1, updated_at = $2 WHERE thread_id = $3", [
    status,
    new Date().toISOString(),
    threadId,
  ]);
}

export async function setThreadAckSent(threadId: string): Promise<void> {
  const now = new Date().toISOString();
  await pool.query("UPDATE threads SET status = 'ack_sent', ack_sent_at = $1, updated_at = $2 WHERE thread_id = $3", [
    now,
    now,
    threadId,
  ]);
}

export async function getThreadRow(threadId: string): Promise<ThreadRow | undefined> {
  const result = await pool.query<ThreadRow>("SELECT * FROM threads WHERE thread_id = $1", [threadId]);
  return result.rows[0];
}

/**
 * "accuse": accuse de reception envoye.
 * "relance_interne": rappel interne REELLEMENT envoye a l'equipe (pre ou
 * post-reponse).
 * "relance_interne_filtree": etape de rappel interne evaluee mais filtree
 * (urgence sous le seuil configure) — la sequence avance sans notifier
 * personne. Distinct de "relance_interne" expres: le client ne doit jamais
 * voir "equipe alertee" pour une alerte qui n'a en realite pas ete envoyee.
 * "relance_externe_pre_reponse" / "relance_externe_post_reponse": relance
 * envoyee au client, avant ou apres notre reponse de fond.
 */
export type ReminderStepType =
  | "accuse"
  | "relance_interne"
  | "relance_interne_filtree"
  | "relance_externe_pre_reponse"
  | "relance_externe_post_reponse";

export async function recordReminder(
  threadId: string,
  kind: "internal" | "external",
  note: string,
  stepType?: ReminderStepType
): Promise<void> {
  await pool.query(
    "INSERT INTO reminders (thread_id, kind, note, step_type, created_at) VALUES ($1, $2, $3, $4, $5)",
    [threadId, kind, note, stepType ?? null, new Date().toISOString()]
  );
}

/** Cette etape a-t-elle deja eu lieu pour ce dossier ? */
export async function hasReminderStep(threadId: string, stepType: ReminderStepType): Promise<boolean> {
  const result = await pool.query("SELECT 1 FROM reminders WHERE thread_id = $1 AND step_type = $2 LIMIT 1", [
    threadId,
    stepType,
  ]);
  return (result.rowCount ?? 0) > 0;
}

export async function incrementRelance(threadId: string, status: ThreadStatus): Promise<void> {
  const now = new Date().toISOString();
  await pool.query(
    `UPDATE threads SET
      relance_count = relance_count + 1,
      last_relance_at = $1,
      status = $2,
      updated_at = $3
     WHERE thread_id = $4`,
    [now, status, now, threadId]
  );
}

/**
 * Bascule un dossier en "attente de reponse client": un humain vient
 * d'envoyer une reponse de fond (ex: le devis). `repliedAt` optionnel pour
 * les dossiers decouverts a posteriori (voir discoverOutbound.ts), afin que
 * l'ancrage de la sequence post-reponse soit l'heure reelle d'envoi, pas
 * l'heure de decouverte par le pipeline.
 */
export async function setThreadHumanReplied(
  threadId: string,
  repliedAt?: string,
  hadAttachment = false
): Promise<void> {
  const now = new Date().toISOString();
  const humanRepliedAt = repliedAt ?? now;
  await pool.query(
    `UPDATE threads SET
      status = 'awaiting_client_reply',
      human_replied_at = $1,
      outbound_had_attachment = $2,
      updated_at = $3
     WHERE thread_id = $4`,
    [humanRepliedAt, hadAttachment ? 1 : 0, now, threadId]
  );
}

export async function incrementPostReplyRelance(threadId: string, status: ThreadStatus): Promise<void> {
  const now = new Date().toISOString();
  await pool.query(
    `UPDATE threads SET
      post_reply_relance_count = post_reply_relance_count + 1,
      last_relance_at = $1,
      status = $2,
      updated_at = $3
     WHERE thread_id = $4`,
    [now, status, now, threadId]
  );
}

export async function listRecentThreads(limit = 100): Promise<ThreadRow[]> {
  const result = await pool.query<ThreadRow>("SELECT * FROM threads ORDER BY updated_at DESC LIMIT $1", [limit]);
  return result.rows;
}

export async function listThreadsAwaitingReply(): Promise<ThreadRow[]> {
  const result = await pool.query<ThreadRow>(
    `SELECT * FROM threads
     WHERE status IN ('ack_sent', 'drafts_ready', 'relance_sent')
     AND due_at IS NOT NULL`
  );
  return result.rows;
}

/**
 * Dossiers ou un humain a repondu et on attend desormais la reponse du
 * client a ce message — que la sequence post-reponse ait deja envoye une
 * relance ou non. Sans inclure 'post_reply_relance_sent', un dossier
 * cessait d'etre reexamine des sa premiere relance post-reponse envoyee.
 */
export async function listThreadsAwaitingClientReply(): Promise<ThreadRow[]> {
  const result = await pool.query<ThreadRow>(
    `SELECT * FROM threads
     WHERE status IN ('awaiting_client_reply', 'post_reply_relance_sent')
     AND human_replied_at IS NOT NULL`
  );
  return result.rows;
}

export async function deleteThreadData(threadId: string): Promise<void> {
  await pool.query("DELETE FROM reminders WHERE thread_id = $1", [threadId]);
  await pool.query("DELETE FROM processed_messages WHERE thread_id = $1", [threadId]);
  await pool.query("DELETE FROM relance_steps WHERE owner_type = 'thread' AND owner_id = $1", [threadId]);
  await pool.query("DELETE FROM post_reply_relance_steps WHERE owner_type = 'thread' AND owner_id = $1", [
    threadId,
  ]);
  await pool.query("DELETE FROM threads WHERE thread_id = $1", [threadId]);
}

interface CategoryRow {
  id: string;
  label: string;
  sla_minutes: number;
  acknowledge_automatically: number;
  sort_order: number;
  internal_alerts_enabled: number;
  internal_alerts_min_urgency: string;
  description: string;
  examples: string;
  is_ignored: number;
  is_fallback: number;
}

function toCategoryConfig(row: CategoryRow): CategoryConfig {
  return {
    id: row.id,
    label: row.label,
    slaMinutes: row.sla_minutes,
    acknowledgeAutomatically: row.acknowledge_automatically === 1,
    internalAlertsEnabled: row.internal_alerts_enabled === 1,
    internalAlertsMinUrgency: (row.internal_alerts_min_urgency as UrgencyThreshold) || "normal",
  };
}

export async function listCategories(): Promise<CategoryConfig[]> {
  const result = await pool.query<CategoryRow>("SELECT * FROM categories ORDER BY sort_order ASC");
  return result.rows.map(toCategoryConfig);
}

export async function updateCategory(
  id: string,
  patch: {
    label: string;
    slaMinutes: number;
    acknowledgeAutomatically: boolean;
    internalAlertsEnabled: boolean;
    internalAlertsMinUrgency: UrgencyThreshold;
  }
): Promise<void> {
  await pool.query(
    `UPDATE categories SET
      label = $1,
      sla_minutes = $2,
      acknowledge_automatically = $3,
      internal_alerts_enabled = $4,
      internal_alerts_min_urgency = $5
     WHERE id = $6`,
    [
      patch.label,
      patch.slaMinutes,
      patch.acknowledgeAutomatically ? 1 : 0,
      patch.internalAlertsEnabled ? 1 : 0,
      patch.internalAlertsMinUrgency,
      id,
    ]
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

async function uniqueCategoryId(base: string): Promise<string> {
  const existing = new Set((await pool.query<{ id: string }>("SELECT id FROM categories")).rows.map((r) => r.id));
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
export async function createCategory(params: {
  label: string;
  slaMinutes: number;
  acknowledgeAutomatically: boolean;
}): Promise<CategoryConfig> {
  const id = await uniqueCategoryId(slugify(params.label));
  const maxOrderRow = await pool.query<{ maxorder: number }>(
    "SELECT COALESCE(MAX(sort_order), -1) AS maxOrder FROM categories"
  );
  await pool.query(
    `INSERT INTO categories (
      id, label, sla_minutes, acknowledge_automatically, sort_order,
      internal_alerts_enabled, internal_alerts_min_urgency
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      params.label,
      params.slaMinutes,
      params.acknowledgeAutomatically ? 1 : 0,
      maxOrderRow.rows[0].maxorder + 1,
      1,
      "normal",
    ]
  );

  await writeSteps("pre_reply", "category", id, [{ channel: "internal", delayMinutes: 1440 }]);
  await writeSteps("post_reply", "category", id, [{ channel: "external", delayMinutes: 3 * 1440 }]);

  const created = await pool.query<CategoryRow>("SELECT * FROM categories WHERE id = $1", [id]);
  return toCategoryConfig(created.rows[0]);
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

async function readSteps(phase: RelancePhase, ownerType: "category" | "thread", ownerId: string): Promise<RelanceStep[]> {
  const result = await pool.query<RelanceStepRow>(
    `SELECT step_order, channel, delay_minutes FROM ${tableFor(phase)} WHERE owner_type = $1 AND owner_id = $2 ORDER BY step_order ASC`,
    [ownerType, ownerId]
  );
  return result.rows.map((r) => ({
    order: r.step_order,
    channel: r.channel as RelanceChannel,
    delayMinutes: r.delay_minutes,
  }));
}

async function writeSteps(
  phase: RelancePhase,
  ownerType: "category" | "thread",
  ownerId: string,
  steps: Array<{ channel: RelanceChannel; delayMinutes: number }>
): Promise<void> {
  const table = tableFor(phase);
  await pool.query(`DELETE FROM ${table} WHERE owner_type = $1 AND owner_id = $2`, [ownerType, ownerId]);

  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    await pool.query(
      `INSERT INTO ${table} (owner_type, owner_id, step_order, channel, delay_minutes) VALUES ($1, $2, $3, $4, $5)`,
      [ownerType, ownerId, index + 1, step.channel, step.delayMinutes]
    );
  }
}

export async function getCategoryRelanceSteps(
  categoryId: string,
  phase: RelancePhase = "pre_reply"
): Promise<RelanceStep[]> {
  return readSteps(phase, "category", categoryId);
}

export async function addCategoryRelanceStep(
  categoryId: string,
  step: { channel: RelanceChannel; delayMinutes: number },
  phase: RelancePhase = "pre_reply"
): Promise<void> {
  const existing = await readSteps(phase, "category", categoryId);
  await writeSteps(phase, "category", categoryId, [...existing, step]);
}

export async function deleteCategoryRelanceStep(
  categoryId: string,
  order: number,
  phase: RelancePhase = "pre_reply"
): Promise<void> {
  const existing = await readSteps(phase, "category", categoryId);
  await writeSteps(phase, "category", categoryId, existing.filter((s) => s.order !== order));
}

export async function hasThreadRelanceOverride(threadId: string, phase: RelancePhase = "pre_reply"): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM ${tableFor(phase)} WHERE owner_type = 'thread' AND owner_id = $1 LIMIT 1`,
    [threadId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getThreadRelanceOverride(
  threadId: string,
  phase: RelancePhase = "pre_reply"
): Promise<RelanceStep[]> {
  return readSteps(phase, "thread", threadId);
}

export async function addThreadRelanceStep(
  threadId: string,
  step: { channel: RelanceChannel; delayMinutes: number },
  phase: RelancePhase = "pre_reply"
): Promise<void> {
  const existing = await readSteps(phase, "thread", threadId);
  await writeSteps(phase, "thread", threadId, [...existing, step]);
}

export async function deleteThreadRelanceStep(
  threadId: string,
  order: number,
  phase: RelancePhase = "pre_reply"
): Promise<void> {
  const existing = await readSteps(phase, "thread", threadId);
  await writeSteps(phase, "thread", threadId, existing.filter((s) => s.order !== order));
}

export async function clearThreadRelanceOverride(threadId: string, phase: RelancePhase = "pre_reply"): Promise<void> {
  await pool.query(`DELETE FROM ${tableFor(phase)} WHERE owner_type = 'thread' AND owner_id = $1`, [threadId]);
}

function snapshotColumnFor(phase: RelancePhase): "pre_reply_relance_snapshot" | "post_reply_relance_snapshot" {
  return phase === "post_reply" ? "post_reply_relance_snapshot" : "pre_reply_relance_snapshot";
}

async function readRelanceStepsSnapshot(threadId: string, phase: RelancePhase): Promise<RelanceStep[] | null> {
  const column = snapshotColumnFor(phase);
  const result = await pool.query<{ snapshot: string | null }>(
    `SELECT ${column} AS snapshot FROM threads WHERE thread_id = $1`,
    [threadId]
  );
  const snapshot = result.rows[0]?.snapshot;
  if (!snapshot) return null;
  try {
    return JSON.parse(snapshot) as RelanceStep[];
  } catch {
    return null;
  }
}

/**
 * Fige la sequence de relance d'un dossier au moment ou runRelanceCheck
 * l'examine pour la premiere fois dans une phase donnee: copie les etapes
 * ACTUELLES de la categorie dans une colonne dediee au dossier (JSON), pour
 * que les lectures suivantes utilisent ce cliche plutot que de relire la
 * categorie en direct a chaque cycle. Sans ce gel, modifier les delais d'une
 * categorie plus tard rejaillirait immediatement sur tous les dossiers deja
 * en cours qui l'utilisent — y compris des relances externes envoyees a des
 * clients bien plus tot ou plus tard que prevu, simplement parce que
 * l'administrateur a corrige un reglage pour les PROCHAINS dossiers.
 * Idempotent (n'ecrase jamais un gel deja pris) et sans effet si le dossier
 * a deja une sequence personnalisee (owner_type='thread').
 */
export async function freezeRelanceStepsSnapshot(
  threadId: string,
  categoryId: string,
  phase: RelancePhase
): Promise<void> {
  if (await hasThreadRelanceOverride(threadId, phase)) return;
  const column = snapshotColumnFor(phase);
  const result = await pool.query<{ snapshot: string | null }>(
    `SELECT ${column} AS snapshot FROM threads WHERE thread_id = $1`,
    [threadId]
  );
  const row = result.rows[0];
  if (!row || row.snapshot !== null) return;

  const steps = await readSteps(phase, "category", categoryId);
  await pool.query(`UPDATE threads SET ${column} = $1 WHERE thread_id = $2`, [JSON.stringify(steps), threadId]);
}

export async function getEffectiveRelanceSteps(
  threadId: string,
  categoryId: string,
  phase: RelancePhase = "pre_reply"
): Promise<{ steps: RelanceStep[]; isCustom: boolean }> {
  const overrideSteps = await readSteps(phase, "thread", threadId);
  if (overrideSteps.length > 0) return { steps: overrideSteps, isCustom: true };

  const snapshot = await readRelanceStepsSnapshot(threadId, phase);
  if (snapshot) return { steps: snapshot, isCustom: false };

  return { steps: await readSteps(phase, "category", categoryId), isCustom: false };
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

export async function listReminders(limit = 150): Promise<ReminderRow[]> {
  const result = await pool.query<ReminderRow>(
    `SELECT r.id, r.thread_id, r.kind, r.note, r.created_at, t.subject, t.sender_email
     FROM reminders r
     JOIN threads t ON t.thread_id = r.thread_id
     ORDER BY r.created_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

/**
 * Rappels/relances (reels ou "mode test" — voir shadowModeEnabled) d'UN
 * dossier precis, du plus recent au plus ancien — utilise sur la page de
 * detail du dossier pour revoir l'integralite de ce que le pipeline a
 * rédigé le concernant (accuse via /carnet, relances ici), avant d'activer
 * les envois reels.
 */
export async function listRemindersForThread(threadId: string): Promise<ReminderRow[]> {
  const result = await pool.query<ReminderRow>(
    `SELECT r.id, r.thread_id, r.kind, r.note, r.created_at, t.subject, t.sender_email
     FROM reminders r
     JOIN threads t ON t.thread_id = r.thread_id
     WHERE r.thread_id = $1
     ORDER BY r.created_at DESC`,
    [threadId]
  );
  return result.rows;
}

// ---------- Erreurs du pipeline (visibles depuis le Journal) ----------

export interface PipelineErrorRow {
  id: number;
  context: string;
  thread_id: string | null;
  message: string;
  created_at: string;
}

export async function recordPipelineError(context: string, threadId: string | null, message: string): Promise<void> {
  await pool.query("INSERT INTO pipeline_errors (context, thread_id, message, created_at) VALUES ($1, $2, $3, $4)", [
    context,
    threadId,
    message,
    new Date().toISOString(),
  ]);
}

export async function listPipelineErrors(limit = 100): Promise<PipelineErrorRow[]> {
  const result = await pool.query<PipelineErrorRow>("SELECT * FROM pipeline_errors ORDER BY created_at DESC LIMIT $1", [
    limit,
  ]);
  return result.rows;
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

export async function recordAiUsage(params: {
  callType: string;
  threadId: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
}): Promise<void> {
  await pool.query(
    `INSERT INTO ai_usage_events (call_type, thread_id, model, input_tokens, output_tokens, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [params.callType, params.threadId, params.model, params.inputTokens, params.outputTokens, new Date().toISOString()]
  );
}

export async function listRecentAiUsage(limit = 50): Promise<AiUsageEventRow[]> {
  const result = await pool.query<AiUsageEventRow>("SELECT * FROM ai_usage_events ORDER BY created_at DESC LIMIT $1", [
    limit,
  ]);
  return result.rows;
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
export async function getAiUsageSummarySince(sinceIso: string): Promise<AiUsageSummary> {
  const totalResult = await pool.query<{ calls: string; inputtokens: string; outputtokens: string }>(
    `SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens
     FROM ai_usage_events WHERE created_at >= $1`,
    [sinceIso]
  );
  const totalRow = totalResult.rows[0];
  const total: AiUsageTotals = {
    calls: Number(totalRow.calls),
    inputTokens: Number(totalRow.inputtokens),
    outputTokens: Number(totalRow.outputtokens),
  };

  const byCallTypeResult = await pool.query<{
    calltype: string;
    calls: string;
    inputtokens: string;
    outputtokens: string;
  }>(
    `SELECT call_type AS callType, COUNT(*) AS calls,
            COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens
     FROM ai_usage_events WHERE created_at >= $1
     GROUP BY call_type
     ORDER BY (SUM(input_tokens) + SUM(output_tokens)) DESC`,
    [sinceIso]
  );
  const byCallType = byCallTypeResult.rows.map((r) => ({
    callType: r.calltype,
    calls: Number(r.calls),
    inputTokens: Number(r.inputtokens),
    outputTokens: Number(r.outputtokens),
  }));

  return { since: sinceIso, total, byCallType };
}

// ---------- Compteur des envois automatiques (distinguer un humain d'une relance) ----------

/**
 * A appeler juste apres l'envoi reussi d'un accuse ou d'une relance
 * automatique. checkPreReplyThread compare ensuite le nombre de messages
 * isFromUs reellement presents dans le fil relu a ce compteur: au-dela,
 * l'exces est forcement humain — sans avoir a faire correspondre le
 * contenu ou l'id d'un message precis (voir le commentaire sur la colonne
 * automated_outbound_count pour l'historique des deux approches qui ont
 * echoue avant celle-ci).
 */
export async function incrementAutomatedOutboundCount(threadId: string): Promise<void> {
  await pool.query("UPDATE threads SET automated_outbound_count = automated_outbound_count + 1 WHERE thread_id = $1", [
    threadId,
  ]);
}

// ==================== Invitations de connexion ====================

export interface ConnectInviteRow {
  token: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  used_provider: string | null;
  revoked_at: string | null;
}

/** 256 bits — meme precedent que les tokens de session (auth.ts), hors de portee d'un brute-force. */
export async function createConnectInvite(expiresInDays: number): Promise<{ token: string; expiresAt: string }> {
  const token = randomBytes(32).toString("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();
  await pool.query("INSERT INTO connect_invites (token, created_at, expires_at) VALUES ($1, $2, $3)", [
    token,
    now.toISOString(),
    expiresAt,
  ]);
  return { token, expiresAt };
}

/** Usage unique: un token deja consomme (used_at) ou revoque (revoked_at) n'est plus valide, meme avant expiration. */
export async function getValidConnectInvite(token: string): Promise<ConnectInviteRow | undefined> {
  const result = await pool.query<ConnectInviteRow>(
    `SELECT * FROM connect_invites
     WHERE token = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > $2`,
    [token, new Date().toISOString()]
  );
  return result.rows[0];
}

export async function consumeConnectInvite(token: string, provider: "gmail" | "graph"): Promise<void> {
  await pool.query("UPDATE connect_invites SET used_at = $1, used_provider = $2 WHERE token = $3", [
    new Date().toISOString(),
    provider,
    token,
  ]);
}

export async function revokeConnectInvite(token: string): Promise<void> {
  await pool.query("UPDATE connect_invites SET revoked_at = $1 WHERE token = $2", [new Date().toISOString(), token]);
}

export async function listConnectInvites(limit = 50): Promise<ConnectInviteRow[]> {
  const result = await pool.query<ConnectInviteRow>("SELECT * FROM connect_invites ORDER BY created_at DESC LIMIT $1", [
    limit,
  ]);
  return result.rows;
}

// ==================== Mode carnet / test (shadow mode) ====================

export interface CarnetEntry {
  id: number;
  threadId: string;
  categoryId: string;
  categoryLabel: string;
  urgency: string | null;
  originalSubject: string;
  senderEmail: string;
  senderName: string | null;
  receivedBody: string;
  ackDrafted: boolean;
  ackSubject: string;
  ackBody: string;
  reviewedOk: boolean;
  createdAt: string;
  rappelEnvoye: boolean;
  humanReplyDelayMinutes: number | null;
}

interface CarnetEntryRow {
  id: number;
  thread_id: string;
  category_id: string;
  category_label: string | null;
  urgency: string | null;
  original_subject: string;
  sender_email: string;
  sender_name: string | null;
  received_body: string;
  ack_drafted: number;
  ack_subject: string;
  ack_body: string;
  reviewed_ok: number;
  created_at: string;
  rappel_envoye: boolean;
  received_at: string | null;
  human_replied_at: string | null;
}

function toCarnetEntry(row: CarnetEntryRow): CarnetEntry {
  const humanReplyDelayMinutes =
    row.received_at && row.human_replied_at
      ? Math.max(
          0,
          Math.round((new Date(row.human_replied_at).getTime() - new Date(row.received_at).getTime()) / 60_000)
        )
      : null;
  return {
    id: row.id,
    threadId: row.thread_id,
    categoryId: row.category_id,
    categoryLabel: row.category_label ?? "Autre",
    urgency: row.urgency,
    originalSubject: row.original_subject,
    senderEmail: row.sender_email,
    senderName: row.sender_name,
    receivedBody: row.received_body,
    ackDrafted: row.ack_drafted === 1,
    ackSubject: row.ack_subject,
    ackBody: row.ack_body,
    reviewedOk: row.reviewed_ok === 1,
    createdAt: row.created_at,
    rappelEnvoye: row.rappel_envoye === true,
    humanReplyDelayMinutes,
  };
}

/**
 * Journalise TOUTE classification (peu importe si un accuse suit) — sans ca,
 * un email classe "pas d'accuse necessaire" (bruit, ou
 * requiresAcknowledgement=false) n'est visible nulle part avec son contenu,
 * rendant impossible de juger si l'IA l'a bien classifie. L'accuse, s'il y
 * en a un, est ajoute ensuite via recordAckDraft (ack_drafted passe a 1).
 */
export async function recordClassification(params: {
  threadId: string;
  messageId: string;
  categoryId: string;
  urgency: string;
  originalSubject: string;
  senderEmail: string;
  senderName: string | null;
  receivedBody: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO shadow_log (
      thread_id, message_id, category_id, urgency, original_subject, sender_email, sender_name,
      received_body, ack_subject, ack_body, ack_drafted, reviewed_ok, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '', '', 0, 0, $9)`,
    [
      params.threadId,
      params.messageId,
      params.categoryId,
      params.urgency,
      params.originalSubject,
      params.senderEmail,
      params.senderName,
      params.receivedBody,
      new Date().toISOString(),
    ]
  );
}

/**
 * Complete la ligne de classification (voir recordClassification) une fois
 * l'accuse redige, en mode carnet/test. Si aucune ligne prealable n'existe
 * (ex: retraitement manuel via POST /dossiers/:threadId/traiter, qui ne
 * repasse pas par classifyEmail), insere une ligne directement plutot que de
 * perdre cet accuse.
 */
export async function recordAckDraft(params: {
  threadId: string;
  messageId: string;
  categoryId: string;
  originalSubject: string;
  senderEmail: string;
  senderName: string | null;
  receivedBody: string;
  ackSubject: string;
  ackBody: string;
}): Promise<void> {
  const result = await pool.query(
    "UPDATE shadow_log SET ack_subject = $1, ack_body = $2, ack_drafted = 1 WHERE message_id = $3",
    [params.ackSubject, params.ackBody, params.messageId]
  );
  if (!result.rowCount) {
    await pool.query(
      `INSERT INTO shadow_log (
        thread_id, message_id, category_id, urgency, original_subject, sender_email, sender_name,
        received_body, ack_subject, ack_body, ack_drafted, reviewed_ok, created_at
      ) VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, $8, $9, 1, 0, $10)`,
      [
        params.threadId,
        params.messageId,
        params.categoryId,
        params.originalSubject,
        params.senderEmail,
        params.senderName,
        params.receivedBody,
        params.ackSubject,
        params.ackBody,
        new Date().toISOString(),
      ]
    );
  }
}

export async function listShadowLogEntries(limit = 500): Promise<CarnetEntry[]> {
  const result = await pool.query<CarnetEntryRow>(
    `SELECT
      s.id, s.thread_id, s.category_id, c.label AS category_label, s.urgency, s.original_subject,
      s.sender_email, s.sender_name, s.received_body, s.ack_drafted, s.ack_subject, s.ack_body,
      s.reviewed_ok, s.created_at, t.received_at, t.human_replied_at,
      (rr.thread_id IS NOT NULL) AS rappel_envoye
     FROM shadow_log s
     LEFT JOIN categories c ON c.id = s.category_id
     LEFT JOIN threads t ON t.thread_id = s.thread_id
     LEFT JOIN (
       SELECT DISTINCT thread_id FROM reminders WHERE step_type = 'relance_interne'
     ) rr ON rr.thread_id = s.thread_id
     ORDER BY s.created_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows.map(toCarnetEntry);
}

export async function setShadowLogReviewed(id: number, reviewed: boolean): Promise<void> {
  await pool.query("UPDATE shadow_log SET reviewed_ok = $1 WHERE id = $2", [reviewed ? 1 : 0, id]);
}

/**
 * Purge shadow_log au-dela de config.shadowLogRetentionDays (voir
 * scheduler.ts) — corrige la contradiction relevee par l'audit securite
 * (SEC-003): la page /confidentialite promettait une retention/purge que le
 * code n'appliquait jamais. received_body/ack_body contiennent le corps
 * integral des emails (factures, RIB...) — ne pas les garder indefiniment.
 * Retourne le nombre de lignes supprimees (journalisation uniquement).
 */
export async function purgeShadowLogOlderThan(days: number): Promise<number> {
  const cutoffIso = new Date(Date.now() - days * 86_400_000).toISOString();
  const result = await pool.query("DELETE FROM shadow_log WHERE created_at < $1", [cutoffIso]);
  return result.rowCount ?? 0;
}

export async function recordHumanReplyCorpus(params: {
  threadId: string;
  categoryId: string;
  replyBody: string;
}): Promise<void> {
  await pool.query(
    "INSERT INTO human_reply_corpus (thread_id, category_id, reply_body, created_at) VALUES ($1, $2, $3, $4)",
    [params.threadId, params.categoryId, params.replyBody, new Date().toISOString()]
  );
}

export async function listCategoriesWithCorpus(): Promise<string[]> {
  const result = await pool.query<{ category_id: string }>("SELECT DISTINCT category_id FROM human_reply_corpus");
  return result.rows.map((r) => r.category_id);
}

export async function listHumanReplyCorpusByCategory(categoryId: string): Promise<string[]> {
  const result = await pool.query<{ reply_body: string }>(
    "SELECT reply_body FROM human_reply_corpus WHERE category_id = $1 ORDER BY created_at ASC",
    [categoryId]
  );
  return result.rows.map((r) => r.reply_body);
}

// ==================== Ton de marque & notes de style (Phase 1: en base) ====================

/** Ton de marque courant — remplace loadBrandVoice() (fichier disque) de l'ancienne version SQLite. */
export async function getBrandVoice(): Promise<string> {
  const result = await pool.query<{ content: string }>("SELECT content FROM brand_voice WHERE id = 1");
  return result.rows[0]?.content ?? "";
}

/** Ecrit le ton de marque depuis la page /ton-de-marque — evite d'avoir a editer un fichier ou redeployer pour ajuster le style des emails generes. */
export async function setBrandVoice(content: string): Promise<void> {
  await pool.query(
    `INSERT INTO brand_voice (id, content, updated_at) VALUES (1, $1, $2)
     ON CONFLICT (id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
    [content, new Date().toISOString()]
  );
}

/**
 * Note de style pour une categorie — remplace loadCategoryPlaybook()
 * (fichier disque) de l'ancienne version SQLite. Chaine vide tant qu'aucune
 * analyse de corpus n'a encore tourne pour cette categorie: absence de ligne
 * n'est pas une erreur, juste "pas encore de note de style".
 */
export async function getCategoryPlaybook(categoryId: string): Promise<string> {
  const result = await pool.query<{ content: string }>("SELECT content FROM category_playbooks WHERE category_id = $1", [
    categoryId,
  ]);
  return result.rows[0]?.content ?? "";
}

export async function setCategoryPlaybook(categoryId: string, content: string): Promise<void> {
  await pool.query(
    `INSERT INTO category_playbooks (category_id, content, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (category_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
    [categoryId, content, new Date().toISOString()]
  );
}
