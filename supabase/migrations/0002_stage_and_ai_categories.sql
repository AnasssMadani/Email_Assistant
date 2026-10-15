-- Etape d'activation (0 silencieux, 1 envoi reel, 2 brouillons, 3 reponse
-- directe) — remplace la variable d'environnement SHADOW_MODE. Stockee en
-- base pour etre basculee depuis le back-office (/etape) sans redeploiement.
-- Une seule ligne (id = 1). Absente ou illisible = etape 0 (voir src/stage.ts).
CREATE TABLE IF NOT EXISTS app_settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  stage INTEGER NOT NULL DEFAULT 0,
  stage_updated_at TEXT
);

-- Historique des changements d'etape: trace datee de chaque bascule, a
-- rapprocher de la validation ecrite de la direction du client.
CREATE TABLE IF NOT EXISTS stage_changes (
  id BIGSERIAL PRIMARY KEY,
  from_stage INTEGER NOT NULL,
  to_stage INTEGER NOT NULL,
  changed_at TEXT NOT NULL
);

-- Categories creees par la classification quand aucune ne convient (voir
-- createCategoryFromAi dans db.ts). created_at sert au plafond journalier.
ALTER TABLE categories ADD COLUMN IF NOT EXISTS created_by_ai INTEGER NOT NULL DEFAULT 0;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS created_at TEXT;
