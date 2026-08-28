// Doit etre importe avant tout module import-ant ../src/config.js dans ce
// process de test (node:test isole chaque fichier .test.ts dans son propre
// processus, donc muter process.env ici est sans danger pour les autres tests).
process.env.SETUP_USERNAME = "test-admin";
process.env.SETUP_PASSWORD = "correct-horse-battery-staple";
// dotenv (loaded by config.ts) does not override vars already set above, but
// it WILL load SETUP_PASSWORD_HASH from a real local .env if this is left
// unset here — pin it explicitly so a developer's .env can't leak into the test.
process.env.SETUP_PASSWORD_HASH = "";
