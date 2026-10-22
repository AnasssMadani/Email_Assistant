-- Texte extrait des pièces jointes lisibles (PDF, texte) à l'arrivée d'un
-- email: l'IA s'en sert pour classer et rédiger, et on le garde pour les
-- brouillons de réponse sans avoir à relire la boîte. La boîte reste en lecture
-- seule: seul le TEXTE est copié, jamais le fichier lui-même.
CREATE TABLE IF NOT EXISTS message_attachments (
  message_id   TEXT        NOT NULL,
  thread_id    TEXT        NOT NULL,
  filename     TEXT        NOT NULL,
  content_type TEXT        NOT NULL,
  size_bytes   INTEGER     NOT NULL DEFAULT 0,
  pages        INTEGER,
  extracted_text TEXT,
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, filename)
);
CREATE INDEX IF NOT EXISTS message_attachments_thread_idx ON message_attachments (thread_id);
