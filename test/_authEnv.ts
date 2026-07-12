// Doit etre importe avant tout module import-ant ../src/config.js dans ce
// process de test (node:test isole chaque fichier .test.ts dans son propre
// processus, donc muter process.env ici est sans danger pour les autres tests).
process.env.SETUP_USERNAME = "test-admin";
process.env.SETUP_PASSWORD = "correct-horse-battery-staple";
