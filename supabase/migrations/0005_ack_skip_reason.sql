-- Pourquoi aucun accuse n'a ete redige pour un email (ia | categorie | equipe |
-- sensible). NULL = accuse redige, ou pas encore traite. Affiche dans le carnet.
ALTER TABLE shadow_log ADD COLUMN IF NOT EXISTS ack_skip_reason TEXT;
