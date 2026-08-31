// Doit etre importe en tout premier (avant tout module import-ant
// ../src/config.js) — voir _authEnv.ts pour l'explication de l'ordre
// d'evaluation ESM. Simule un deploiement de production sans identifiants
// admin/client configures (SEC-001).
process.env.NODE_ENV = "production";
process.env.SETUP_USERNAME = "";
process.env.SETUP_PASSWORD = "";
process.env.SETUP_PASSWORD_HASH = "";
process.env.CLIENT_USERNAME = "";
process.env.CLIENT_PASSWORD_HASH = "";
