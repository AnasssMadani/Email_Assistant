import { hashPasswordForStorage } from "../web/auth.js";

/**
 * Genere un hash scrypt pour SETUP_PASSWORD_HASH, a coller dans .env.
 *
 *   npm run auth:hash-password -- "motdepasse"
 */
const password = process.argv[2];
if (!password) {
  console.error('Usage: npm run auth:hash-password -- "motdepasse"');
  process.exit(1);
}

console.log(`SETUP_PASSWORD_HASH=${hashPasswordForStorage(password)}`);
