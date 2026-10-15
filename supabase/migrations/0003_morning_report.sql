-- Rapport du matin (9 h, heure de Casablanca) — voir src/pipeline/morningReport.ts.
-- Memes conventions que 0001_init.sql: horodatages en TEXT ISO 8601 UTC,
-- booleens en INTEGER 0/1.

-- (Table distincte de app_settings, qui porte l etape d activation, voir 0002.)
-- Reglages simples cle/valeur modifiables depuis le back-office (sans
-- redeploiement), a commencer par l'interrupteur d'envoi du rapport du matin.
CREATE TABLE IF NOT EXISTS app_kv_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Un rapport par jour (report_date = date locale, UNIQUE): un redemarrage ou
-- deux processus qui tournent en meme temps ne peuvent jamais produire deux
-- rapports pour le meme matin. send_claimed_at est pose atomiquement AVANT
-- l'envoi (UPDATE ... WHERE send_claimed_at IS NULL): le meme rapport ne
-- peut jamais partir deux fois, meme en cas de course.
CREATE TABLE IF NOT EXISTS morning_reports (
  id BIGSERIAL PRIMARY KEY,
  report_date TEXT NOT NULL UNIQUE,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  -- Donnees calculees du rapport (JSON) — rendues en HTML dans le
  -- back-office et en texte brut pour l'email.
  content TEXT NOT NULL,
  send_claimed_at TEXT,
  sent_at TEXT,
  sent_to TEXT,
  send_error TEXT
);
