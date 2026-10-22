-- Brouillons de réponse rédigés par l'IA pour l'équipe. Ils restent dans
-- l'application (page du dossier): jamais déposés dans la boîte mail (rule
-- n°1, lecture seule) et jamais envoyés tout seuls. Un humain relit, complète
-- les [[champs]] manquants et envoie lui-même.
CREATE TABLE IF NOT EXISTS reply_drafts (
  id           BIGSERIAL PRIMARY KEY,
  thread_id    TEXT        NOT NULL,
  message_id   TEXT        NOT NULL,
  category_id  TEXT        NOT NULL DEFAULT 'autre',
  should_reply INTEGER     NOT NULL DEFAULT 1,
  reason       TEXT        NOT NULL DEFAULT '',
  subject      TEXT        NOT NULL DEFAULT '',
  body         TEXT        NOT NULL DEFAULT '',
  missing      TEXT        NOT NULL DEFAULT '[]',
  confidence   TEXT        NOT NULL DEFAULT 'low',
  source       TEXT        NOT NULL DEFAULT 'auto',
  -- Avis de l'équipe sur la page Brouillons: 'bon' (tel quel), 'retouche' (à corriger), 'inutilisable'. NULL = pas encore relu.
  verdict      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reply_drafts_thread_idx ON reply_drafts (thread_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS reply_drafts_message_idx ON reply_drafts (message_id) WHERE source = 'auto';
