-- Message-ID RFC 5322 du message traite: permet d'ignorer les exemplaires
-- multiples d'un meme email (recu via plusieurs adresses redirigees vers la
-- boite copie). Nullable: les lignes existantes n'en ont pas.
ALTER TABLE processed_messages ADD COLUMN IF NOT EXISTS rfc_message_id TEXT;
CREATE INDEX IF NOT EXISTS idx_processed_messages_rfc_message_id ON processed_messages (rfc_message_id);
