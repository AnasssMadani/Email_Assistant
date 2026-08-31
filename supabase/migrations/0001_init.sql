-- Global Link — schema Postgres/Supabase initial.
--
-- Remplace la base SQLite locale (node:sqlite). Choix deliberes par rapport
-- a l'ancien schema:
-- - Plus de colonne sla_hours (categories/threads) ni de detection de
--   colonne heritee allow_external_relance: ce sont des residus de
--   migrations SQLite anterieures, sans equivalent a porter sur une base
--   neuve.
-- - Les horodatages ("_at") restent des colonnes TEXT au format ISO 8601
--   UTC (ex: 2026-01-01T12:00:00.000Z), pas TIMESTAMPTZ — c'est un choix
--   deliberement conservateur: tout le code applicatif (formatDateTime,
--   comparaisons SQL >=/<=, snapshots JSON serialises) suppose deja des
--   chaines ISO, exactement comme sous SQLite. Un TIMESTAMPTZ natif
--   forcerait node-postgres a renvoyer des objets Date (ou des chaines au
--   format Postgres, differentes d'ISO 8601), avec un risque de regression
--   sur des dizaines de points de lecture pour un gain purement cosmetique.
--   Les comparaisons >=/<= sur ces colonnes restent correctes en TEXT tant
--   que toutes les valeurs sont ecrites au meme format ISO UTC — deja le
--   cas partout dans le code.
-- - Memes raisons pour les booleens: colonnes INTEGER (0/1), pas BOOLEAN
--   natif — le code applicatif compare deja avec `=== 1` / ecrit `? 1 : 0`
--   partout ; passer a BOOLEAN natif (node-postgres renvoie alors un vrai
--   `true`/`false`) casserait silencieusement ces comparaisons.
-- - Aucune contrainte FOREIGN KEY: le schema SQLite d'origine n'en avait
--   pas non plus (ex: threads.category_id n'a jamais ete contraint), et
--   Phase 2 doit pouvoir supprimer une categorie en reassignant ses
--   dossiers cote application, sans lutter contre une FK.

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  sla_minutes INTEGER NOT NULL,
  acknowledge_automatically INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL,
  -- Filtre anti-spam des rappels internes: une categorie peut nudger
  -- l'equipe systematiquement, seulement au-dela d'une urgence donnee, ou
  -- jamais (0 + 'high').
  internal_alerts_enabled INTEGER NOT NULL DEFAULT 1,
  internal_alerts_min_urgency TEXT NOT NULL DEFAULT 'normal',
  -- Phase 2 (classification): description libre + exemples, tous deux
  -- injectes dans le prompt de classification pour desambiguiser des
  -- categories proches (ex: "devis" vs "demande d'information"). Vide par
  -- defaut, non bloquant tant que Phase 2 n'exploite pas encore ces champs.
  description TEXT NOT NULL DEFAULT '',
  examples TEXT NOT NULL DEFAULT '',
  -- Phase 2: remplace le test sur l'id litteral "spam_newsletter" — une
  -- categorie ignoree n'est ni stockee ni accusee. Exactement une categorie
  -- doit etre is_fallback=1 (remplace le test sur l'id litteral "autre").
  is_ignored INTEGER NOT NULL DEFAULT 0,
  is_fallback INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS threads (
  thread_id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  sender_email TEXT NOT NULL,
  sender_name TEXT,
  category_id TEXT NOT NULL,
  urgency TEXT NOT NULL,
  sla_minutes INTEGER NOT NULL,
  status TEXT NOT NULL,
  received_at TEXT NOT NULL,
  ack_sent_at TEXT,
  due_at TEXT,
  last_relance_at TEXT,
  relance_count INTEGER NOT NULL DEFAULT 0,
  human_replied_at TEXT,
  post_reply_relance_count INTEGER NOT NULL DEFAULT 0,
  -- Vrai si la reponse de fond envoyee au client (ex: devis) contenait une
  -- piece jointe — permet a la relance post-reponse d'y faire reference.
  outbound_had_attachment INTEGER NOT NULL DEFAULT 0,
  -- Nombre de messages envoyes AUTOMATIQUEMENT par le pipeline dans ce fil
  -- (accuse + chaque relance) — sert a detecter une vraie reponse humaine
  -- par comptage (voir incrementAutomatedOutboundCount dans db.ts).
  automated_outbound_count INTEGER NOT NULL DEFAULT 0,
  -- 'inbound': dossier ouvert par un email CLIENT recu. 'outbound': dossier
  -- decouvert par discoverOutbound.ts a partir d'un envoi a froid.
  origin TEXT NOT NULL DEFAULT 'inbound',
  -- Gel de la sequence de relance au premier examen (voir
  -- freezeRelanceStepsSnapshot dans db.ts) — evite qu'un reglage de
  -- categorie modifie plus tard ne rejaillisse sur un dossier deja en cours.
  pre_reply_relance_snapshot TEXT,
  post_reply_relance_snapshot TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS processed_messages (
  message_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  processed_at TEXT NOT NULL
);

-- step_type identifie precisement QUELLE etape du cycle de vie ce rappel
-- represente (accuse / relance interne / relance externe avant ou apres
-- reponse...) — source de verite fiable, jamais a deduire du texte libre
-- de `note`.
CREATE TABLE IF NOT EXISTS reminders (
  id BIGSERIAL PRIMARY KEY,
  thread_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  note TEXT,
  step_type TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reminders_thread ON reminders(thread_id, step_type);

CREATE TABLE IF NOT EXISTS relance_steps (
  id BIGSERIAL PRIMARY KEY,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('category', 'thread')),
  owner_id TEXT NOT NULL,
  step_order INTEGER NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('internal', 'external')),
  delay_minutes REAL NOT NULL,
  UNIQUE(owner_type, owner_id, step_order)
);

-- Sequence distincte declenchee APRES qu'un humain a envoye une reponse de
-- fond (ex: le devis): on attend alors la reponse DU CLIENT a ce message.
CREATE TABLE IF NOT EXISTS post_reply_relance_steps (
  id BIGSERIAL PRIMARY KEY,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('category', 'thread')),
  owner_id TEXT NOT NULL,
  step_order INTEGER NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('internal', 'external')),
  delay_minutes REAL NOT NULL,
  UNIQUE(owner_type, owner_id, step_order)
);

CREATE TABLE IF NOT EXISTS pipeline_errors (
  id BIGSERIAL PRIMARY KEY,
  context TEXT NOT NULL,
  thread_id TEXT,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Un enregistrement par appel Claude (classification, accuse, relance) —
-- sert au compteur de consommation/cout affiche dans l'admin (/consommation).
CREATE TABLE IF NOT EXISTS ai_usage_events (
  id BIGSERIAL PRIMARY KEY,
  call_type TEXT NOT NULL,
  thread_id TEXT,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

-- Mode "carnet"/test (shadowModeEnabled): une ligne par classification (et,
-- si applicable, accuse REDIGE mais jamais envoye ni depose).
CREATE TABLE IF NOT EXISTS shadow_log (
  id BIGSERIAL PRIMARY KEY,
  thread_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  urgency TEXT,
  original_subject TEXT NOT NULL,
  sender_email TEXT NOT NULL,
  sender_name TEXT,
  received_body TEXT NOT NULL,
  ack_subject TEXT NOT NULL DEFAULT '',
  ack_body TEXT NOT NULL DEFAULT '',
  ack_drafted INTEGER NOT NULL DEFAULT 0,
  reviewed_ok INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- Corpus des vraies reponses de fond envoyees par l'equipe, par categorie —
-- relu par la passe d'analyse (corpusAnalysis.ts) pour generer une note de
-- style par categorie (table category_playbooks).
CREATE TABLE IF NOT EXISTS human_reply_corpus (
  id BIGSERIAL PRIMARY KEY,
  thread_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  reply_body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Lien d'invitation a usage unique permettant au client de connecter sa
-- propre messagerie (OAuth) sans identifiants admin — voir
-- requireAuthOrInvite dans web/server.ts. used_at ET revoked_at sont deux
-- facons distinctes d'invalider un token.
CREATE TABLE IF NOT EXISTS connect_invites (
  token TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_provider TEXT,
  revoked_at TEXT
);

-- Ligne unique (id=1) — ton de marque, remplace le fichier
-- config/brand-voice.md comme source modifiable depuis /ton-de-marque (un
-- fichier sur disque ne survit pas a un redeploiement Render).
CREATE TABLE IF NOT EXISTS brand_voice (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  content TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Note de style par categorie, generee par la passe d'analyse du corpus
-- (corpusAnalysis.ts) — remplace config/category-playbooks/<id>.md pour la
-- meme raison que brand_voice ci-dessus.
CREATE TABLE IF NOT EXISTS category_playbooks (
  category_id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Prompts editables (classification, accuse, relance pre/post-reponse) —
-- schema pret des Phase 1, exploite par la page /prompts introduite en
-- Phase 2. Vide (non exploite) tant que Phase 2 n'a pas charge de valeurs.
CREATE TABLE IF NOT EXISTS prompts (
  key TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
