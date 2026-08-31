// Doit etre importe en tout premier — voir _authEnv.ts. Hors production
// (NODE_ENV non "production"), identifiants admin absents.
delete process.env.NODE_ENV;
process.env.SETUP_USERNAME = "";
process.env.SETUP_PASSWORD = "";
process.env.SETUP_PASSWORD_HASH = "";
