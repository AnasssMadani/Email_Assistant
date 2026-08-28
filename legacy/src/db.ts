import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import type { CategoryConfig, RelanceChannel, RelanceStep, ThreadStatus, UrgencyThreshold } from "./types.js";

mkdirSync(path.dirname(path.resolve(config.dbPath)), { recursive: true });
const db = new DatabaseSync(path.resolve(config.dbPath));

/** Les 6 categories metier du mode carnet — voir ensurePiloteCarnetCategories plus bas. Declaree ici (plutot qu'a cote de cette fonction) pour etre initialisee avant son appel au chargement du module. */
const CARNET_BUSINESS_CATEGORY_IDS = [
  "devis",
  "reclamation",
  "suivi_dossier",
  "demande_facture",
  "disponibilite_bad",
  "relance_paiement_soa",
];

/**
 * Certaines bases de production plus anciennes portent encore une colonne
 * categories.allow_external_relance (NOT NULL, sans defaut) heritee d'un
 * modele abandonne depuis (remplace par relance_steps/
 * post_reply_relance_steps) — absente du CREATE TABLE actuel, donc jamais
 * recreee sur une base neuve, mais toujours presente sur les bases deja
 * migrees, ou toute insertion qui l'omet echoue avec "NOT NULL constraint
 * failed". On la detecte a chaque insertion plutot que de tenter une
 * migration destructive (SQLite ne sait pas retirer une contrainte NOT NULL
 * sans recreer la table) — valeur figee a 0, plus lue nulle part dans le
 * code actuel.
 */
function insertCategoryRow(params: {
  id: string;
  label: string;
  slaHours: number;
  slaMinutes: number;
  acknowledgeAutomatically: 0 | 1;
  sortOrder: number;
  internalAlertsEnabled: 0 | 1;
  internalAlertsMinUrgency: string;
}): void {
  const hasLegacyAllowExternalRelance = (
    db.prepare("PRAGMA table_info(categories)").all() as unknown as { name: string }[]
  ).some((c) => c.name === "allow_external_relance");

  const columns = [
    "id",
    "label",
    "sla_hours",
    "sla_minutes",
    "acknowledge_automatically",
    "sort_order",
    "internal_alerts_enabled",
    "internal_alerts_min_urgency",
  ];
  const values: Array<string | number> = [
    params.id,
    params.label,
    params.slaHours,
    params.slaMinutes,
    params.acknowledgeAutomatically,
    params.sortOrder,
    params.internalAlertsEnabled,
    params.internalAlertsMinUrgency,
  ];
  if (hasLegacyAllowExternalRelance) {
    columns.push("allow_external_relance");
    values.push(0);
  }

  db.prepare(
    `INSERT INTO categories (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`
  ).run(...values);
}

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
    -- Nombre de messages envoyes AUTOMATIQUEMENT par le pipeline dans ce
    -- fil (accuse + chaque relance) — permet de detecter une vraie reponse
    -- humaine par simple comptage: si le fil relu contient plus de messages
    -- isFromUs que cette valeur, l'exces est forcement humain, quel que
    -- soit son contenu ou son id. Remplace une correspondance exacte
    -- (hash de corps, puis id de message) qui echouait encore en
    -- production a cause d'alterations du texte au round-trip Gmail/Graph
    -- (fins de ligne, encodage) — le comptage ne depend d'aucun des deux.
    automated_outbound_count INTEGER NOT NULL DEFAULT 0,
    -- Tag manuel (aucune detection automatique possible: toute l'equipe
    -- repond depuis la MEME boite connectee, sans en-tete distinguant qui a
    -- personnellement tape la reponse) — choisi depuis la page de detail du
    -- dossier une fois traite. Sert uniquement au tableau de performance
    -- /performance (regroupement par employe), jamais lu par le pipeline.
    handled_by_employee_id INTEGER,
    -- 'inbound': dossier ouvert par un email CLIENT recu (received_at = heure
    -- reelle de reception). 'outbound': dossier decouvert par
    -- discoverOutbound.ts a partir d'un envoi a froid (devis, suivi...) —
    -- received_at y vaut l'heure de DECOUVERTE par le pipeline, pas une
    -- reception client, une semantique differente qui fausse les KPI de
    -- delai de reponse si elle n'est pas distinguee (voir getClientMonthlyStats).
    origin TEXT NOT NULL DEFAULT 'inbound',
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

  -- step_type identifie precisement QUELLE etape du cycle de vie ce rappel
  -- represente (accuse / relance interne / relance externe avant ou apres
  -- reponse...) — kind seul ('internal'/'external') ne suffit pas a
  -- distinguer un accuse d'une relance externe avant reponse, les deux etant
  -- 'external'. Sert de base fiable aux cases a cocher du dashboard client
  -- (EXISTS ... WHERE step_type = ?) plutot que de deviner depuis le texte
  -- de note, qui peut changer de formulation avec le temps.
  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    note TEXT,
    step_type TEXT,
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

  -- Mode "carnet" (semaine pilote, voir shadowModeEnabled): une ligne par
  -- accuse REDIGE par l'IA mais jamais envoye ni depose en brouillon —
  -- l'equivalent carnet de "accuse envoye a X" pour la page /carnet.
  CREATE TABLE IF NOT EXISTS shadow_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    category_id TEXT NOT NULL,
    original_subject TEXT NOT NULL,
    sender_email TEXT NOT NULL,
    sender_name TEXT,
    received_body TEXT NOT NULL,
    ack_subject TEXT NOT NULL,
    ack_body TEXT NOT NULL,
    reviewed_ok INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  -- Corpus des vraies reponses de fond envoyees par l'equipe cette semaine,
  -- par categorie — relu par la passe d'analyse (corpusAnalysis.ts) pour
  -- generer une note de style par categorie (config/category-playbooks/).
  CREATE TABLE IF NOT EXISTS human_reply_corpus (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    category_id TEXT NOT NULL,
    reply_body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  -- Lien d'invitation a usage unique permettant au client de connecter sa
  -- propre messagerie (OAuth) sans identifiants admin — voir
  -- requireClientAuthOrInvite dans web/server.ts. used_at ET revoked_at sont
  -- deux facons distinctes d'invalider un token (utilise avec succes, vs
  -- retire manuellement avant usage) — l'UI admin affiche un statut different
  -- pour chacune.
  CREATE TABLE IF NOT EXISTS connect_invites (
    token TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    used_provider TEXT,
    revoked_at TEXT
  );

  -- Roster manuel pour le tag "traite par" (voir threads.handled_by_employee_id)
  -- et le tableau de performance /performance. active=0 (desactive plutot que
  -- supprime) retire l'employe des listes de selection pour un nouveau
  -- dossier, sans perdre son nom sur les dossiers deja tagges par le passe.
  CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

`);

ensureDelayMinutesColumn();
ensureThreadPostReplyColumns();
ensureThreadAttachmentColumn();
ensureCategoryAlertColumns();
ensureSlaMinutesColumns();
ensureAutomatedOutboundCountColumn();
ensureRelanceSnapshotColumns();
ensureReminderStepTypeColumn();
ensureShadowLogClassificationColumns();
ensureThreadOriginColumn();
ensureThreadHandledByColumn();
ensureRemindersIndex();
enableWal();
seedIfNeeded();
ensurePiloteCarnetCategories();

/**
 * Migration additive: shadow_log ne couvrait au depart que les emails ayant
 * reellement eu un accuse redige — un email classe "pas d'accuse necessaire"
 * (categorie bruit, ou requiresAcknowledgement=false) n'apparaissait alors
 * NULLE PART avec son contenu, rendant impossible de juger si l'IA l'a bien
 * classifie. urgency + ack_drafted permettent desormais de journaliser
 * TOUTE classification (voir recordClassification dans processIncoming.ts),
 * l'accuse restant optionnel (ack_drafted=0 tant qu'aucun n'a ete redige).
 */
function ensureShadowLogClassificationColumns(): void {
  const columns = db.prepare("PRAGMA table_info(shadow_log)").all() as unknown as { name: string }[];
  if (!columns.some((c) => c.name === "urgency")) {
    db.exec("ALTER TABLE shadow_log ADD COLUMN urgency TEXT");
  }
  if (!columns.some((c) => c.name === "ack_drafted")) {
    db.exec("ALTER TABLE shadow_log ADD COLUMN ack_drafted INTEGER NOT NULL DEFAULT 1");
  }
}

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

/** Migration additive: ajoute handled_by_employee_id sur threads si absente (voir table employees). */
function ensureThreadHandledByColumn(): void {
  const columns = db.prepare("PRAGMA table_info(threads)").all() as unknown as { name: string }[];
  if (!columns.some((c) => c.name === "handled_by_employee_id")) {
    db.exec("ALTER TABLE threads ADD COLUMN handled_by_employee_id INTEGER");
  }
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

/** Migration additive: ajoute automated_outbound_count sur threads si absente. */
function ensureAutomatedOutboundCountColumn(): void {
  const columns = db.prepare("PRAGMA table_info(threads)").all() as unknown as { name: string }[];
  if (!columns.some((c) => c.name === "automated_outbound_count")) {
    db.exec("ALTER TABLE threads ADD COLUMN automated_outbound_count INTEGER NOT NULL DEFAULT 0");
  }
}

/**
 * Migration additive: colonnes de gel de la sequence de relance (voir
 * freezeRelanceStepsSnapshot ci-dessous). Nullable et vide par defaut — les
 * dossiers deja en cours au moment de cette migration se figent au premier
 * cycle de verification qui les relit, sur la base de la categorie telle
 * qu'elle est a ce moment-la.
 */
/** Migration additive: ajoute step_type sur reminders si absente. */
function ensureReminderStepTypeColumn(): void {
  const columns = db.prepare("PRAGMA table_info(reminders)").all() as unknown as { name: string }[];
  if (!columns.some((c) => c.name === "step_type")) {
    db.exec("ALTER TABLE reminders ADD COLUMN step_type TEXT");
  }
}

function ensureRelanceSnapshotColumns(): void {
  const columns = db.prepare("PRAGMA table_info(threads)").all() as unknown as { name: string }[];
  if (!columns.some((c) => c.name === "pre_reply_relance_snapshot")) {
    db.exec("ALTER TABLE threads ADD COLUMN pre_reply_relance_snapshot TEXT");
  }
  if (!columns.some((c) => c.name === "post_reply_relance_snapshot")) {
    db.exec("ALTER TABLE threads ADD COLUMN post_reply_relance_snapshot TEXT");
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

/** Migration additive: ajoute threads.origin ('inbound'/'outbound') si absente — voir CREATE TABLE threads. */
function ensureThreadOriginColumn(): void {
  const columns = db.prepare("PRAGMA table_info(threads)").all() as unknown as { name: string }[];
  if (!columns.some((c) => c.name === "origin")) {
    db.exec("ALTER TABLE threads ADD COLUMN origin TEXT NOT NULL DEFAULT 'inbound'");
  }
}

/**
 * Index additif sur reminders(thread_id, step_type): la seule table qui
 * grossit sans borne et qui est reellement filtree par une requete cablee
 * (hasReminderStep, appelee plusieurs fois par vue du dashboard client).
 * Gain nul aujourd'hui (quelques milliers de lignes), mais evite un scan
 * lineaire une fois la table a plusieurs dizaines de milliers de lignes.
 */
function ensureRemindersIndex(): void {
  db.exec("CREATE INDEX IF NOT EXISTS idx_reminders_thread ON reminders(thread_id, step_type)");
}

/**
 * Le scheduler (ecriture) et le serveur web (lecture) partagent le meme
 * fichier DB dans le meme process — WAL permet a une lecture de ne jamais
 * attendre une ecriture en cours (et inversement), au lieu du mode DELETE
 * par defaut qui peut brievement verrouiller la base entiere.
 */
function enableWal(): void {
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
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

/**
 * Amorçage ponctuel du mode carnet (semaine pilote, transitaire): relabellise
 * les 3 categories metier deja existantes, ajoute les 3 nouvelles, et les
 * regle sur "toujours alerter l'equipe" (urgence min 'low'). Se declenche
 * une seule fois: si "disponibilite_bad" existe deja, ce bloc a deja tourne,
 * on ne reapplique rien pour ne jamais ecraser un reglage modifie depuis
 * /reglages entre temps. N'affecte pas demande_information/candidature (hors
 * perimetre metier pour ce client) ni les sequences post_reply (relances
 * apres une vraie reponse humaine — comportement existant, inchange). Le
 * delai du rappel lui-meme n'est pas fige ici — libre a /reglages de
 * l'ajuster par la suite, la sequence pre_reply de ces categories n'est plus
 * jamais reecrasee automatiquement.
 */
function ensurePiloteCarnetCategories(): void {
  const already = db.prepare("SELECT 1 FROM categories WHERE id = 'disponibilite_bad'").get();
  if (already) return;

  const relabel: Array<{ id: string; label: string }> = [
    { id: "devis", label: "Demande de devis" },
    { id: "reclamation", label: "Réclamation" },
    { id: "suivi_dossier", label: "Suivi de dossier" },
  ];
  const updateLabel = db.prepare("UPDATE categories SET label = ? WHERE id = ?");
  for (const cat of relabel) {
    updateLabel.run(cat.label, cat.id);
  }

  const newCategories: Array<{ id: string; label: string; slaHours: number }> = [
    { id: "demande_facture", label: "Demande de facture", slaHours: 24 },
    // Souvent urgent (marchandise potentiellement bloquee, frais de
    // stockage qui courent) — SLA plus court par defaut, ajustable ensuite.
    { id: "disponibilite_bad", label: "Disponibilité de BAD", slaHours: 4 },
    { id: "relance_paiement_soa", label: "Relance de paiement SOA", slaHours: 48 },
  ];
  const maxOrderRow = db
    .prepare("SELECT COALESCE(MAX(sort_order), -1) AS m FROM categories")
    .get() as { m: number };
  newCategories.forEach((cat, index) => {
    insertCategoryRow({
      id: cat.id,
      label: cat.label,
      slaHours: cat.slaHours,
      slaMinutes: cat.slaHours * 60,
      acknowledgeAutomatically: 1,
      sortOrder: maxOrderRow.m + 1 + index,
      internalAlertsEnabled: 1,
      internalAlertsMinUrgency: "low",
    });
  });

  const updateAlerts = db.prepare(
    "UPDATE categories SET internal_alerts_enabled = 1, internal_alerts_min_urgency = 'low' WHERE id = ?"
  );
  for (const id of CARNET_BUSINESS_CATEGORY_IDS) {
    updateAlerts.run(id);
  }

  // Amorce initiale unique: un seul rappel interne a 30 min pour les 6
  // categories metier (les 3 nouvelles n'ont sinon AUCUNE etape — seedIfNeeded
  // a deja tourne avant leur creation ci-dessus — et les 3 relabelisees
  // gardent sinon le defaut generique de config/categories.json). Comme le
  // reste de cette fonction, ne s'applique qu'une fois: modifiable ensuite
  // librement depuis /reglages, plus jamais reecrasee automatiquement.
  for (const id of CARNET_BUSINESS_CATEGORY_IDS) {
    writeSteps("pre_reply", "category", id, [{ channel: "internal", delayMinutes: 30 }]);
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
  automated_outbound_count: number;
  handled_by_employee_id: number | null;
  origin: "inbound" | "outbound";
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
  origin?: "inbound" | "outbound";
}): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO threads (
      thread_id, subject, sender_email, sender_name, category_id, urgency,
      sla_hours, sla_minutes, status, received_at, due_at, relance_count, origin, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    ON CONFLICT(thread_id) DO UPDATE SET
      subject = excluded.subject,
      category_id = excluded.category_id,
      urgency = excluded.urgency,
      sla_hours = excluded.sla_hours,
      sla_minutes = excluded.sla_minutes,
      -- Ne jamais retrograder un dossier deja passe en post-reponse
      -- (human_replied_at deja pose): un entrant qui arrive en retard sur un
      -- fil ou l'equipe a deja repondu (course avec discoverOutbound, voir
      -- CLAUDE.md/audit BUG-004) ne doit pas repasser le statut a "received"
      -- ni reculer l'echeance due_at — sinon le dossier oscille entre les
      -- deux phases et pollue le corpus/les metriques de reponse humaine.
      status = CASE WHEN threads.human_replied_at IS NOT NULL THEN threads.status ELSE excluded.status END,
      due_at = CASE WHEN threads.human_replied_at IS NOT NULL THEN threads.due_at ELSE excluded.due_at END,
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
    params.origin ?? "inbound",
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

/**
 * "accuse": accuse de reception envoye.
 * "relance_interne": rappel interne REELLEMENT envoye a l'equipe (pre ou
 * post-reponse — le dashboard client n'affiche qu'une case generique, peu
 * importe la phase).
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

export function recordReminder(
  threadId: string,
  kind: "internal" | "external",
  note: string,
  stepType?: ReminderStepType
): void {
  db.prepare(
    "INSERT INTO reminders (thread_id, kind, note, step_type, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(threadId, kind, note, stepType ?? null, new Date().toISOString());
}

/** Utilise par le dashboard client: cette etape a-t-elle deja eu lieu pour ce dossier ? */
export function hasReminderStep(threadId: string, stepType: ReminderStepType): boolean {
  const row = db
    .prepare("SELECT 1 FROM reminders WHERE thread_id = ? AND step_type = ? LIMIT 1")
    .get(threadId, stepType);
  return row !== undefined;
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
  insertCategoryRow({
    id,
    label: params.label,
    slaHours: params.slaMinutes / 60,
    slaMinutes: params.slaMinutes,
    acknowledgeAutomatically: params.acknowledgeAutomatically ? 1 : 0,
    sortOrder: maxOrderRow.maxOrder + 1,
    internalAlertsEnabled: 1,
    internalAlertsMinUrgency: "normal",
  });

  writeSteps("pre_reply", "category", id, [{ channel: "internal", delayMinutes: 1440 }]);
  writeSteps("post_reply", "category", id, [{ channel: "external", delayMinutes: 3 * 1440 }]);

  return toCategoryConfig(
    db.prepare("SELECT * FROM categories WHERE id = ?").get(id) as unknown as CategoryRow
  );
}

// ---------- Employes (tag manuel "traite par", voir threads.handled_by_employee_id) ----------

export interface Employee {
  id: number;
  name: string;
  active: boolean;
}

function toEmployee(row: { id: number; name: string; active: number }): Employee {
  return { id: row.id, name: row.name, active: row.active === 1 };
}

/** includeInactive=true pour afficher l'historique (un dossier tague par un employe depuis desactive doit garder son nom lisible). */
export function listEmployees(includeInactive = false): Employee[] {
  const rows = db
    .prepare(
      includeInactive
        ? "SELECT * FROM employees ORDER BY active DESC, name ASC"
        : "SELECT * FROM employees WHERE active = 1 ORDER BY name ASC"
    )
    .all() as unknown as Array<{ id: number; name: string; active: number }>;
  return rows.map(toEmployee);
}

export function createEmployee(name: string): Employee {
  const result = db
    .prepare("INSERT INTO employees (name, active, created_at) VALUES (?, 1, ?)")
    .run(name, new Date().toISOString());
  return { id: Number(result.lastInsertRowid), name, active: true };
}

/** Desactiver plutot que supprimer: retire l'employe des listes de selection sans perdre son nom sur les dossiers deja tagges. */
export function setEmployeeActive(id: number, active: boolean): void {
  db.prepare("UPDATE employees SET active = ? WHERE id = ?").run(active ? 1 : 0, id);
}

/** null pour retirer le tag (dossier redevenu "non assigne"). */
export function setThreadHandledBy(threadId: string, employeeId: number | null): void {
  db.prepare("UPDATE threads SET handled_by_employee_id = ?, updated_at = ? WHERE thread_id = ?").run(
    employeeId,
    new Date().toISOString(),
    threadId
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

function snapshotColumnFor(phase: RelancePhase): "pre_reply_relance_snapshot" | "post_reply_relance_snapshot" {
  return phase === "post_reply" ? "post_reply_relance_snapshot" : "pre_reply_relance_snapshot";
}

function readRelanceStepsSnapshot(threadId: string, phase: RelancePhase): RelanceStep[] | null {
  const column = snapshotColumnFor(phase);
  const row = db.prepare(`SELECT ${column} AS snapshot FROM threads WHERE thread_id = ?`).get(threadId) as
    | { snapshot: string | null }
    | undefined;
  if (!row?.snapshot) return null;
  try {
    return JSON.parse(row.snapshot) as RelanceStep[];
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
export function freezeRelanceStepsSnapshot(threadId: string, categoryId: string, phase: RelancePhase): void {
  if (hasThreadRelanceOverride(threadId, phase)) return;
  const column = snapshotColumnFor(phase);
  const row = db.prepare(`SELECT ${column} AS snapshot FROM threads WHERE thread_id = ?`).get(threadId) as
    | { snapshot: string | null }
    | undefined;
  if (!row || row.snapshot !== null) return;

  const steps = readSteps(phase, "category", categoryId);
  db.prepare(`UPDATE threads SET ${column} = ? WHERE thread_id = ?`).run(JSON.stringify(steps), threadId);
}

export function getEffectiveRelanceSteps(
  threadId: string,
  categoryId: string,
  phase: RelancePhase = "pre_reply"
): { steps: RelanceStep[]; isCustom: boolean } {
  const overrideSteps = readSteps(phase, "thread", threadId);
  if (overrideSteps.length > 0) return { steps: overrideSteps, isCustom: true };

  const snapshot = readRelanceStepsSnapshot(threadId, phase);
  if (snapshot) return { steps: snapshot, isCustom: false };

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
export function incrementAutomatedOutboundCount(threadId: string): void {
  db.prepare(
    "UPDATE threads SET automated_outbound_count = automated_outbound_count + 1 WHERE thread_id = ?"
  ).run(threadId);
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
export function createConnectInvite(expiresInDays: number): { token: string; expiresAt: string } {
  const token = randomBytes(32).toString("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(
    "INSERT INTO connect_invites (token, created_at, expires_at) VALUES (?, ?, ?)"
  ).run(token, now.toISOString(), expiresAt);
  return { token, expiresAt };
}

/** Usage unique: un token deja consomme (used_at) ou revoque (revoked_at) n'est plus valide, meme avant expiration. */
export function getValidConnectInvite(token: string): ConnectInviteRow | undefined {
  return db
    .prepare(
      `SELECT * FROM connect_invites
       WHERE token = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`
    )
    .get(token, new Date().toISOString()) as ConnectInviteRow | undefined;
}

export function consumeConnectInvite(token: string, provider: "gmail" | "graph"): void {
  db.prepare("UPDATE connect_invites SET used_at = ?, used_provider = ? WHERE token = ?").run(
    new Date().toISOString(),
    provider,
    token
  );
}

export function revokeConnectInvite(token: string): void {
  db.prepare("UPDATE connect_invites SET revoked_at = ? WHERE token = ?").run(new Date().toISOString(), token);
}

export function listConnectInvites(limit = 50): ConnectInviteRow[] {
  return db
    .prepare("SELECT * FROM connect_invites ORDER BY created_at DESC LIMIT ?")
    .all(limit) as unknown as ConnectInviteRow[];
}

// ==================== Mode carnet (semaine pilote) ====================

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
  rappel_envoye: number;
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
    rappelEnvoye: row.rappel_envoye === 1,
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
export function recordClassification(params: {
  threadId: string;
  messageId: string;
  categoryId: string;
  urgency: string;
  originalSubject: string;
  senderEmail: string;
  senderName: string | null;
  receivedBody: string;
}): void {
  db.prepare(
    `INSERT INTO shadow_log (
      thread_id, message_id, category_id, urgency, original_subject, sender_email, sender_name,
      received_body, ack_subject, ack_body, ack_drafted, reviewed_ok, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', '', 0, 0, ?)`
  ).run(
    params.threadId,
    params.messageId,
    params.categoryId,
    params.urgency,
    params.originalSubject,
    params.senderEmail,
    params.senderName,
    params.receivedBody,
    new Date().toISOString()
  );
}

/**
 * Complete la ligne de classification (voir recordClassification) une fois
 * l'accuse redige, en mode carnet. Si aucune ligne prealable n'existe (ex:
 * retraitement manuel via POST /dossiers/:threadId/traiter, qui ne repasse
 * pas par classifyEmail), insere une ligne directement plutot que de perdre
 * cet accuse.
 */
export function recordAckDraft(params: {
  threadId: string;
  messageId: string;
  categoryId: string;
  originalSubject: string;
  senderEmail: string;
  senderName: string | null;
  receivedBody: string;
  ackSubject: string;
  ackBody: string;
}): void {
  const result = db
    .prepare("UPDATE shadow_log SET ack_subject = ?, ack_body = ?, ack_drafted = 1 WHERE message_id = ?")
    .run(params.ackSubject, params.ackBody, params.messageId);
  if (Number(result.changes) === 0) {
    db.prepare(
      `INSERT INTO shadow_log (
        thread_id, message_id, category_id, urgency, original_subject, sender_email, sender_name,
        received_body, ack_subject, ack_body, ack_drafted, reviewed_ok, created_at
      ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 1, 0, ?)`
    ).run(
      params.threadId,
      params.messageId,
      params.categoryId,
      params.originalSubject,
      params.senderEmail,
      params.senderName,
      params.receivedBody,
      params.ackSubject,
      params.ackBody,
      new Date().toISOString()
    );
  }
}

export function listShadowLogEntries(limit = 500): CarnetEntry[] {
  const rows = db
    .prepare(
      `SELECT
        s.id, s.thread_id, s.category_id, c.label AS category_label, s.urgency, s.original_subject,
        s.sender_email, s.sender_name, s.received_body, s.ack_drafted, s.ack_subject, s.ack_body,
        s.reviewed_ok, s.created_at, t.received_at, t.human_replied_at,
        EXISTS(
          SELECT 1 FROM reminders r WHERE r.thread_id = s.thread_id AND r.step_type = 'relance_interne'
        ) AS rappel_envoye
       FROM shadow_log s
       LEFT JOIN categories c ON c.id = s.category_id
       LEFT JOIN threads t ON t.thread_id = s.thread_id
       ORDER BY s.created_at DESC
       LIMIT ?`
    )
    .all(limit) as unknown as CarnetEntryRow[];
  return rows.map(toCarnetEntry);
}

export function setShadowLogReviewed(id: number, reviewed: boolean): void {
  db.prepare("UPDATE shadow_log SET reviewed_ok = ? WHERE id = ?").run(reviewed ? 1 : 0, id);
}

/**
 * Purge shadow_log au-dela de config.shadowLogRetentionDays (voir
 * scheduler.ts) — corrige la contradiction relevee par l'audit securite
 * (SEC-003): la page /confidentialite promettait une retention/purge que le
 * code n'appliquait jamais. received_body/ack_body contiennent le corps
 * integral des emails (factures, RIB...) — ne pas les garder indefiniment.
 * Retourne le nombre de lignes supprimees (journalisation uniquement).
 */
export function purgeShadowLogOlderThan(days: number): number {
  const cutoffIso = new Date(Date.now() - days * 86_400_000).toISOString();
  const result = db.prepare("DELETE FROM shadow_log WHERE created_at < ?").run(cutoffIso);
  return Number(result.changes);
}

export function recordHumanReplyCorpus(params: { threadId: string; categoryId: string; replyBody: string }): void {
  db.prepare(
    "INSERT INTO human_reply_corpus (thread_id, category_id, reply_body, created_at) VALUES (?, ?, ?, ?)"
  ).run(params.threadId, params.categoryId, params.replyBody, new Date().toISOString());
}

export function listCategoriesWithCorpus(): string[] {
  const rows = db.prepare("SELECT DISTINCT category_id FROM human_reply_corpus").all() as unknown as {
    category_id: string;
  }[];
  return rows.map((r) => r.category_id);
}

export function listHumanReplyCorpusByCategory(categoryId: string): string[] {
  const rows = db
    .prepare("SELECT reply_body FROM human_reply_corpus WHERE category_id = ? ORDER BY created_at ASC")
    .all(categoryId) as unknown as { reply_body: string }[];
  return rows.map((r) => r.reply_body);
}

// ---------- Performance / KPI (voir /performance dans web/server.ts) ----------

export interface LateBuckets {
  under30: number;
  under60: number;
  under240: number;
  over240: number;
}

export interface CategoryPerformanceRow {
  categoryId: string;
  categoryLabel: string;
  received: number;
  onTime: number;
  late: number;
  lateBuckets: LateBuckets;
  escalations: number;
  avgResponseMinutes: number | null;
}

export interface EmployeePerformanceRow {
  employeeId: number;
  employeeName: string;
  handled: number;
  onTime: number;
  late: number;
  lateBuckets: LateBuckets;
  avgResponseMinutes: number | null;
}

function emptyLateBuckets(): LateBuckets {
  return { under30: 0, under60: 0, under240: 0, over240: 0 };
}

function bumpLateBucket(buckets: LateBuckets, minutesLate: number): void {
  if (minutesLate <= 30) buckets.under30++;
  else if (minutesLate <= 60) buckets.under60++;
  else if (minutesLate <= 240) buckets.under240++;
  else buckets.over240++;
}

interface PerformanceAccumulator {
  count: number;
  onTime: number;
  late: number;
  lateBuckets: LateBuckets;
  responseMinutes: number[];
}

function newPerformanceAccumulator(): PerformanceAccumulator {
  return { count: 0, onTime: 0, late: 0, lateBuckets: emptyLateBuckets(), responseMinutes: [] };
}

/**
 * "En retard" se juge contre due_at (l'echeance SLA), jamais contre le delai
 * de reponse brut — un dossier repondu en 2h peut etre "a l'heure" (SLA 24h)
 * ou "en retard" (SLA 1h). Un dossier encore ouvert et deja hors delai compte
 * aussi en retard (nowMs sert d'ancrage provisoire tant qu'il n'est pas
 * cloture), sauf s'il est deja cloture sans reponse humaine enregistree (rien
 * a mesurer). received_at sert uniquement a l'avgResponseMinutes affiche a
 * titre indicatif, pas au jugement a l'heure/en retard.
 */
function foldThreadIntoAccumulator(
  acc: PerformanceAccumulator,
  row: { received_at: string; due_at: string | null; human_replied_at: string | null; status: string },
  nowMs: number
): void {
  acc.count++;
  if (row.human_replied_at) {
    acc.responseMinutes.push(
      Math.max(0, (new Date(row.human_replied_at).getTime() - new Date(row.received_at).getTime()) / 60_000)
    );
  }
  if (!row.due_at) return;
  const dueAtMs = new Date(row.due_at).getTime();
  if (row.human_replied_at) {
    const lateMinutes = Math.round((new Date(row.human_replied_at).getTime() - dueAtMs) / 60_000);
    if (lateMinutes <= 0) acc.onTime++;
    else {
      acc.late++;
      bumpLateBucket(acc.lateBuckets, lateMinutes);
    }
  } else if (dueAtMs < nowMs && row.status !== "closed") {
    acc.late++;
    bumpLateBucket(acc.lateBuckets, Math.round((nowMs - dueAtMs) / 60_000));
  }
}

function averageOrNull(values: number[]): number | null {
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
}

/**
 * Performance par categorie sur [sinceIso, untilIso): volume recu, a l'heure
 * vs en retard (vs SLA), et nombre de dossiers ayant necessite au moins un
 * vrai rappel interne avant reponse (escalade — signe qu'un dossier a ete
 * oublie plutot que traite dans les temps). Exclut origin='outbound' comme
 * getClientMonthlyStats (BUG-005/BUG-002): received_at y vaut l'heure de
 * DECOUVERTE, pas de reception, ce qui fausserait volume et delais.
 */
export function getCategoryPerformance(sinceIso: string, untilIso: string): CategoryPerformanceRow[] {
  const rows = db
    .prepare(
      // <= plutot que <: untilIso vaut "maintenant" au moment de l'appel —
      // un dossier recu dans la meme milliseconde ne doit pas etre exclu
      // (observe en test: flaky de facon intermittente avec un "<" strict).
      `SELECT thread_id, category_id, received_at, due_at, human_replied_at, status
       FROM threads
       WHERE received_at >= ? AND received_at <= ? AND status != 'skipped' AND origin != 'outbound'`
    )
    .all(sinceIso, untilIso) as unknown as Array<{
      thread_id: string;
      category_id: string;
      received_at: string;
      due_at: string | null;
      human_replied_at: string | null;
      status: string;
    }>;

  const escalatedThreadIds = new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT thread_id FROM reminders
           WHERE step_type = 'relance_interne' AND created_at >= ? AND created_at < ?`
        )
        .all(sinceIso, untilIso) as unknown as Array<{ thread_id: string }>
    ).map((r) => r.thread_id)
  );

  const byCategory = new Map<string, PerformanceAccumulator & { escalations: Set<string> }>();
  const nowMs = Date.now();
  for (const row of rows) {
    const acc = byCategory.get(row.category_id) ?? { ...newPerformanceAccumulator(), escalations: new Set<string>() };
    foldThreadIntoAccumulator(acc, row, nowMs);
    if (escalatedThreadIds.has(row.thread_id)) acc.escalations.add(row.thread_id);
    byCategory.set(row.category_id, acc);
  }

  const categoryLabels = new Map(listCategories().map((c) => [c.id, c.label]));
  return Array.from(byCategory.entries())
    .map(([categoryId, acc]) => ({
      categoryId,
      categoryLabel: categoryLabels.get(categoryId) ?? categoryId,
      received: acc.count,
      onTime: acc.onTime,
      late: acc.late,
      lateBuckets: acc.lateBuckets,
      escalations: acc.escalations.size,
      avgResponseMinutes: averageOrNull(acc.responseMinutes),
    }))
    .sort((a, b) => b.received - a.received);
}

/**
 * Performance par employe sur [sinceIso, untilIso): uniquement les dossiers
 * tagges "traite par" (voir threads.handled_by_employee_id) ET repondus dans
 * la fenetre (ancrage human_replied_at, pas received_at — un employe est jugé
 * sur QUAND il a repondu, pas sur quand le client a ecrit). Un dossier non
 * tague n'apparait dans aucune ligne — normal tant que le tag reste manuel.
 */
export function getEmployeePerformance(sinceIso: string, untilIso: string): EmployeePerformanceRow[] {
  const rows = db
    .prepare(
      // <= plutot que <: meme raison que getCategoryPerformance ci-dessus.
      `SELECT thread_id, handled_by_employee_id, received_at, due_at, human_replied_at, status
       FROM threads
       WHERE handled_by_employee_id IS NOT NULL
         AND human_replied_at >= ? AND human_replied_at <= ?
         AND status != 'skipped' AND origin != 'outbound'`
    )
    .all(sinceIso, untilIso) as unknown as Array<{
      thread_id: string;
      handled_by_employee_id: number;
      received_at: string;
      due_at: string | null;
      human_replied_at: string | null;
      status: string;
    }>;

  const byEmployee = new Map<number, PerformanceAccumulator>();
  const nowMs = Date.now();
  for (const row of rows) {
    const acc = byEmployee.get(row.handled_by_employee_id) ?? newPerformanceAccumulator();
    foldThreadIntoAccumulator(acc, row, nowMs);
    byEmployee.set(row.handled_by_employee_id, acc);
  }

  const employeeNames = new Map(listEmployees(true).map((e) => [e.id, e.name]));
  return Array.from(byEmployee.entries())
    .map(([employeeId, acc]) => ({
      employeeId,
      employeeName: employeeNames.get(employeeId) ?? `#${employeeId}`,
      handled: acc.count,
      onTime: acc.onTime,
      late: acc.late,
      lateBuckets: acc.lateBuckets,
      avgResponseMinutes: averageOrNull(acc.responseMinutes),
    }))
    .sort((a, b) => b.handled - a.handled);
}

// ==================== Projections dashboard client ====================
//
// Le dashboard client (/client/...) n'a jamais acces aux lignes completes
// de la base — chaque fonction ci-dessous ne renvoie QUE les champs
// autorises pour ce public. Ne jamais faire lire un ThreadRow/CategoryRow
// complet par une vue client puis filtrer a l'affichage: un champ ajoute
// plus tard sur ces tables (cout, id technique, config de relance...)
// fuiterait sans qu'on y pense. threadId/categoryId restent presents dans
// ces DTO uniquement comme identifiants de routage (URL, formulaires) —
// jamais affiches comme "ID" dans une vue.

export interface ClientThreadSummary {
  threadId: string;
  subject: string;
  senderEmail: string;
  senderName: string | null;
  categoryLabel: string;
  dueAt: string | null;
  receivedAt: string;
  resolved: boolean;
}

export interface ClientThreadChecklist {
  accuseEnvoye: { done: boolean; at: string | null };
  relanceInterne: { done: boolean };
  relanceClientAvantReponse: { done: boolean };
  reponseEquipe: { done: boolean; at: string | null; delayLabel: string | null };
  relanceApresReponse: { done: boolean };
  cloture: { done: boolean };
}

export interface ClientThreadDetail extends ClientThreadSummary {
  checklist: ClientThreadChecklist;
}


export interface ClientSendHistoryEntry {
  sentence: string;
  at: string;
}

export interface ClientCategorySummary {
  id: string;
  label: string;
  slaMinutes: number;
}

interface ClientThreadRow {
  thread_id: string;
  subject: string;
  sender_email: string;
  sender_name: string | null;
  category_label: string | null;
  due_at: string | null;
  received_at: string;
  status: string;
}

function toClientThreadSummary(row: ClientThreadRow): ClientThreadSummary {
  return {
    threadId: row.thread_id,
    subject: row.subject,
    senderEmail: row.sender_email,
    senderName: row.sender_name,
    categoryLabel: row.category_label ?? "Autre",
    dueAt: row.due_at,
    receivedAt: row.received_at,
    resolved: row.status === "closed",
  };
}

/** "3h", "45 min", "2.5 j" — lisible dans un contexte client, pas une duree ISO brute. */
function formatHumanDelay(fromIso: string, toIso: string): string {
  const minutes = Math.max(0, Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  if (hours < 48) return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`;
  const days = hours / 24;
  return `${Number.isInteger(days) ? days : days.toFixed(1)} j`;
}

/**
 * Exclut les dossiers "skipped" (spam/newsletter/communication interne):
 * jamais accuses, jamais de vraie demande client — n'ont rien a faire dans
 * une liste de dossiers cote client.
 */
export function listClientThreads(limit = 200): ClientThreadSummary[] {
  const rows = db
    .prepare(
      `SELECT t.thread_id, t.subject, t.sender_email, t.sender_name, c.label AS category_label,
              t.due_at, t.received_at, t.status
       FROM threads t
       LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.status != 'skipped'
       ORDER BY t.updated_at DESC
       LIMIT ?`
    )
    .all(limit) as unknown as ClientThreadRow[];
  return rows.map(toClientThreadSummary);
}

export function getClientThreadDetail(threadId: string): ClientThreadDetail | undefined {
  const row = db
    .prepare(
      `SELECT t.thread_id, t.subject, t.sender_email, t.sender_name, c.label AS category_label,
              t.due_at, t.received_at, t.status, t.ack_sent_at, t.human_replied_at
       FROM threads t
       LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.thread_id = ?`
    )
    .get(threadId) as unknown as (ClientThreadRow & { ack_sent_at: string | null; human_replied_at: string | null }) | undefined;
  if (!row) return undefined;

  return {
    ...toClientThreadSummary(row),
    checklist: {
      accuseEnvoye: { done: row.ack_sent_at !== null, at: row.ack_sent_at },
      relanceInterne: { done: hasReminderStep(threadId, "relance_interne") },
      relanceClientAvantReponse: { done: hasReminderStep(threadId, "relance_externe_pre_reponse") },
      reponseEquipe: {
        done: row.human_replied_at !== null,
        at: row.human_replied_at,
        delayLabel: row.human_replied_at ? formatHumanDelay(row.received_at, row.human_replied_at) : null,
      },
      relanceApresReponse: { done: hasReminderStep(threadId, "relance_externe_post_reponse") },
      cloture: { done: row.status === "closed" },
    },
  };
}

export interface ClientPeriodKpis {
  processed: number;
  deltaProcessedPct: number | null;
  slaPct: number;
  deltaSlaPts: number | null;
  avgResponseMinutes: number | null;
  deltaResponseMinutes: number | null;
  openCount: number;
}

export interface ClientVolumePoint {
  label: string;
  value: number;
}

export interface ClientCategoryShare {
  label: string;
  pct: number;
}

interface ClientWindowStats {
  processed: number;
  onTime: number;
  late: number;
  avgResponseMinutes: number | null;
}

/**
 * Meme logique "a l'heure vs en retard (vs due_at)" que getCategoryPerformance
 * (tableau de performance admin), appliquee ici a une fenetre pour la page
 * d'accueil client — aucun champ non client-safe expose par l'appelant.
 */
function clientWindowStats(sinceIso: string, untilIso: string): ClientWindowStats {
  const rows = db
    .prepare(
      // <= plutot que <: meme raison que getCategoryPerformance (db.ts).
      `SELECT due_at, human_replied_at, received_at, status FROM threads
       WHERE received_at >= ? AND received_at <= ? AND status != 'skipped' AND origin != 'outbound'`
    )
    .all(sinceIso, untilIso) as unknown as Array<{
      due_at: string | null;
      human_replied_at: string | null;
      received_at: string;
      status: string;
    }>;

  let onTime = 0;
  let late = 0;
  const responseMinutes: number[] = [];
  const nowMs = Date.now();
  for (const row of rows) {
    if (row.human_replied_at) {
      responseMinutes.push(
        Math.max(0, (new Date(row.human_replied_at).getTime() - new Date(row.received_at).getTime()) / 60_000)
      );
    }
    if (!row.due_at) continue;
    const dueAtMs = new Date(row.due_at).getTime();
    if (row.human_replied_at) {
      const lateMinutes = Math.round((new Date(row.human_replied_at).getTime() - dueAtMs) / 60_000);
      if (lateMinutes <= 0) onTime++;
      else late++;
    } else if (dueAtMs < nowMs && row.status !== "closed") {
      late++;
    }
  }
  return {
    processed: rows.length,
    onTime,
    late,
    avgResponseMinutes: responseMinutes.length
      ? responseMinutes.reduce((sum, v) => sum + v, 0) / responseMinutes.length
      : null,
  };
}

/**
 * KPI de la page d'accueil client pour une fenetre glissante de periodDays
 * jours, avec la variation vs la fenetre precedente de meme duree.
 * openCount est un instantane ("actuellement ouverts"), pas filtre par
 * periode — un delta fiable demanderait un historique d'etat que la base ne
 * conserve pas, donc aucun delta n'est renvoye pour ce champ plutot que d'en
 * inventer un trompeur. slaPct vaut 100 par defaut quand rien n'est encore
 * mesurable sur la fenetre (aucun dossier avec echeance passee ou repondu) —
 * "rien a signaler" plutot qu'un pourcentage arbitraire.
 */
export function getClientPeriodKpis(periodDays: number): ClientPeriodKpis {
  const now = Date.now();
  const currentSinceIso = new Date(now - periodDays * 86_400_000).toISOString();
  const currentUntilIso = new Date(now).toISOString();
  const previousSinceIso = new Date(now - 2 * periodDays * 86_400_000).toISOString();
  const previousUntilIso = currentSinceIso;

  const current = clientWindowStats(currentSinceIso, currentUntilIso);
  const previous = clientWindowStats(previousSinceIso, previousUntilIso);

  const currentMeasured = current.onTime + current.late;
  const previousMeasured = previous.onTime + previous.late;
  const slaPct = currentMeasured > 0 ? Math.round((current.onTime / currentMeasured) * 100) : 100;
  const previousSlaPct = previousMeasured > 0 ? Math.round((previous.onTime / previousMeasured) * 100) : null;

  const openCount = (
    db
      .prepare("SELECT COUNT(*) AS n FROM threads WHERE status NOT IN ('closed', 'skipped') AND origin != 'outbound'")
      .get() as { n: number }
  ).n;

  return {
    processed: current.processed,
    deltaProcessedPct:
      previous.processed > 0 ? Math.round(((current.processed - previous.processed) / previous.processed) * 100) : null,
    slaPct,
    deltaSlaPts: previousSlaPct !== null ? slaPct - previousSlaPct : null,
    avgResponseMinutes: current.avgResponseMinutes !== null ? Math.round(current.avgResponseMinutes) : null,
    deltaResponseMinutes:
      current.avgResponseMinutes !== null && previous.avgResponseMinutes !== null
        ? Math.round(current.avgResponseMinutes - previous.avgResponseMinutes)
        : null,
    openCount,
  };
}

function countClientThreadsReceived(sinceIso: string, untilIso: string): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM threads WHERE received_at >= ? AND received_at < ? AND status != 'skipped' AND origin != 'outbound'"
      )
      .get(sinceIso, untilIso) as { n: number }
  ).n;
}

function capitalizeFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Serie du graphique de volume de la page d'accueil client: 7 jours -> 7
 * barres quotidiennes, 30 jours -> 5 barres hebdomadaires, 90 jours -> une
 * barre par mois calendaire touche par la fenetre.
 */
export function getClientVolumeSeries(periodDays: number): ClientVolumePoint[] {
  const now = new Date();

  if (periodDays <= 7) {
    const points: ClientVolumePoint[] = [];
    for (let i = 6; i >= 0; i--) {
      const dayStart = new Date(now);
      dayStart.setHours(0, 0, 0, 0);
      dayStart.setDate(dayStart.getDate() - i);
      const dayEnd = new Date(dayStart.getTime() + 86_400_000);
      points.push({
        label: capitalizeFirst(dayStart.toLocaleDateString("fr-FR", { weekday: "short" })),
        value: countClientThreadsReceived(dayStart.toISOString(), dayEnd.toISOString()),
      });
    }
    return points;
  }

  if (periodDays <= 30) {
    const points: ClientVolumePoint[] = [];
    for (let i = 0; i < 5; i++) {
      const bucketStart = new Date(now.getTime() - (30 - i * 6) * 86_400_000);
      const bucketEnd = new Date(bucketStart.getTime() + 6 * 86_400_000);
      points.push({
        label: `S${i + 1}`,
        value: countClientThreadsReceived(bucketStart.toISOString(), bucketEnd.toISOString()),
      });
    }
    return points;
  }

  const start = new Date(now.getTime() - periodDays * 86_400_000);
  const points: ClientVolumePoint[] = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
  while (cursor <= now) {
    const monthStart = new Date(cursor);
    const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
    points.push({
      label: capitalizeFirst(monthStart.toLocaleDateString("fr-FR", { month: "short" })),
      value: countClientThreadsReceived(monthStart.toISOString(), monthEnd.toISOString()),
    });
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return points;
}

/**
 * Repartition en % par categorie sur la fenetre, pour le graphique de la
 * page d'accueil client — regroupe tout au-dela des 5 premieres categories
 * sous "Autre" pour rester lisible.
 */
export function getClientCategoryShare(periodDays: number): ClientCategoryShare[] {
  const sinceIso = new Date(Date.now() - periodDays * 86_400_000).toISOString();
  const rows = db
    .prepare(
      `SELECT c.label AS label, COUNT(*) AS n
       FROM threads t
       LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.received_at >= ? AND t.status != 'skipped' AND t.origin != 'outbound'
       GROUP BY t.category_id
       ORDER BY n DESC`
    )
    .all(sinceIso) as unknown as Array<{ label: string | null; n: number }>;

  const total = rows.reduce((sum, r) => sum + r.n, 0);
  if (total === 0) return [];

  const top = rows.slice(0, 5);
  const rest = rows.slice(5);
  const restTotal = rest.reduce((sum, r) => sum + r.n, 0);

  const shares = top.map((r) => ({ label: r.label ?? "Autre", pct: Math.round((r.n / total) * 100) }));
  if (restTotal > 0) shares.push({ label: "Autre", pct: Math.round((restTotal / total) * 100) });
  return shares;
}

function clientSendHistorySentence(stepType: string, subject: string, senderEmail: string): string {
  switch (stepType) {
    case "accuse":
      return `Accusé de réception envoyé à ${senderEmail} pour "${subject}".`;
    case "relance_interne":
      return `Rappel interne envoyé à l'équipe pour "${subject}".`;
    case "relance_externe_pre_reponse":
      return `Relance envoyée à ${senderEmail} pour "${subject}".`;
    case "relance_externe_post_reponse":
      return `Relance de suivi envoyée à ${senderEmail} pour "${subject}".`;
    default:
      return `Action automatique effectuée pour "${subject}".`;
  }
}

/**
 * Version lisible du Journal admin, en phrases completes — exclut
 * entierement les erreurs de pipeline (jamais interrogees ici: elles vivent
 * dans une table separee, pipeline_errors, jamais lue par le dashboard
 * client) et les rappels internes filtres (rien n'a ete envoye).
 */
export function listClientSendHistory(limit = 100): ClientSendHistoryEntry[] {
  const rows = db
    .prepare(
      `SELECT r.step_type AS step_type, r.created_at AS created_at, t.subject AS subject, t.sender_email AS sender_email
       FROM reminders r
       JOIN threads t ON t.thread_id = r.thread_id
       WHERE r.step_type IN ('accuse', 'relance_interne', 'relance_externe_pre_reponse', 'relance_externe_post_reponse')
       ORDER BY r.created_at DESC
       LIMIT ?`
    )
    .all(limit) as unknown as Array<{ step_type: string; created_at: string; subject: string; sender_email: string }>;

  return rows.map((r) => ({
    sentence: clientSendHistorySentence(r.step_type, r.subject, r.sender_email),
    at: r.created_at,
  }));
}

/**
 * Categories editables par le client — exclut "spam_newsletter" et "interne":
 * ces deux n'ont jamais d'accuse (acknowledgeAutomatically=false) et n'ont
 * donc aucun delai de reponse pertinent a afficher ou ajuster.
 */
export function listClientCategories(): ClientCategorySummary[] {
  return listCategories()
    .filter((c) => c.id !== "spam_newsletter" && c.id !== "interne")
    .map((c) => ({ id: c.id, label: c.label, slaMinutes: c.slaMinutes }));
}

/**
 * Mise a jour limitee au delai de reponse promis (SLA) — jamais le libelle,
 * l'activation de l'accuse automatique, ou la sequence de relance: ce sont
 * les leviers reserves a l'admin (voir cahier des charges, "A exclure").
 */
export function updateClientCategorySla(categoryId: string, slaMinutes: number): void {
  db.prepare("UPDATE categories SET sla_hours = ?, sla_minutes = ? WHERE id = ?").run(
    slaMinutes / 60,
    slaMinutes,
    categoryId
  );
}

export default db;
