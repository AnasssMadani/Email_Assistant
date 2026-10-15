-- Apprentissage manuel: l'admin colle des fils d'emails reels, l'IA en extrait
-- les reponses de l'equipe. On retient d'ou vient chaque exemple (auto = capte
-- dans la boite, manuel = colle), le lot d'import (pour pouvoir l'annuler) et
-- la demande du client a laquelle l'equipe repondait.
ALTER TABLE human_reply_corpus ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE human_reply_corpus ADD COLUMN IF NOT EXISTS batch_id TEXT;
ALTER TABLE human_reply_corpus ADD COLUMN IF NOT EXISTS client_ask TEXT;
