// Doit etre importe en tout premier — voir _authEnv.ts. Production, admin
// NON configure, client CONFIGURE (SEC-007: la CSRF client ne doit pas
// dependre de la config admin).
process.env.NODE_ENV = "production";
process.env.SETUP_USERNAME = "";
process.env.SETUP_PASSWORD = "";
process.env.SETUP_PASSWORD_HASH = "";
process.env.CLIENT_USERNAME = "test-client";
process.env.CLIENT_PASSWORD_HASH = "deadbeef:deadbeef";
