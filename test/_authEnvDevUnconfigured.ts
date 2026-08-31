// Doit etre importe en tout premier — voir _authEnv.ts. Hors production
// (NODE_ENV non "production"), identifiants admin/client absents.
delete process.env.NODE_ENV;
process.env.SETUP_USERNAME = "";
process.env.SETUP_PASSWORD = "";
process.env.SETUP_PASSWORD_HASH = "";
process.env.CLIENT_USERNAME = "";
process.env.CLIENT_PASSWORD_HASH = "";
