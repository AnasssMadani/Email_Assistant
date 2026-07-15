import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Variable d'environnement manquante: ${name}. Copiez .env.example vers .env et completez-la.`
    );
  }
  return value;
}

export const config = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  // PORT: injectee automatiquement par la plupart des PaaS (Render, Railway,
  // Heroku...). WEB_PORT reste prioritaire pour un usage local/personnalise.
  webPort: Number(process.env.WEB_PORT ?? process.env.PORT ?? 4300),
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    redirectUri: process.env.GOOGLE_REDIRECT_URI ?? "http://localhost:4300/auth/gmail/callback",
    tokenPath: process.env.GOOGLE_TOKEN_PATH ?? "./data/gmail-token.json",
  },
  azure: {
    clientId: process.env.AZURE_CLIENT_ID ?? "",
    clientSecret: process.env.AZURE_CLIENT_SECRET ?? "",
    tenantId: process.env.AZURE_TENANT_ID ?? "common",
    redirectUri: process.env.AZURE_REDIRECT_URI ?? "http://localhost:4300/auth/graph/callback",
    tokenPath: process.env.AZURE_TOKEN_PATH ?? "./data/graph-token.json",
  },
  pollIntervalCron: process.env.POLL_INTERVAL_CRON ?? "*/2 * * * *",
  // Cadence de verification des relances/rappels dus. A 30 min (l'ancien
  // defaut), une relance ciblee a 15 min pouvait arriver avec jusqu'a 45 min
  // de retard reel. Alignee sur pollIntervalCron pour des delais courts
  // (quelques minutes, meme jour) fiables — reste ajustable via l'env si
  // besoin d'un intervalle different.
  relanceCheckCron: process.env.RELANCE_CHECK_CRON ?? "*/2 * * * *",
  dbPath: process.env.DB_PATH ?? "./data/app.db",
  categoriesConfigPath: process.env.CATEGORIES_CONFIG_PATH ?? "./config/categories.json",
  brandVoicePath: process.env.BRAND_VOICE_PATH ?? "./config/brand-voice.md",
  connectionStatePath: process.env.CONNECTION_STATE_PATH ?? "./data/connection.json",
  emailConnector: (process.env.EMAIL_CONNECTOR ?? "gmail") as "gmail" | "graph",
  // Cle AES-256 (64 caracteres hexadecimaux) pour chiffrer les jetons OAuth au
  // repos. Generer avec: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  // Si absente, les jetons restent en clair sur disque (avertissement au demarrage).
  encryptionKey: process.env.ENCRYPTION_KEY ?? "",
  // Destinataire des rappels internes (email). Vide par defaut: la
  // notification part alors vers la messagerie connectee elle-meme, comme
  // un pense-bete dans sa propre boite plutot que dans le vide.
  notificationEmail: process.env.NOTIFICATION_EMAIL ?? "",
  auth: {
    username: process.env.SETUP_USERNAME ?? "",
    // Format "salt:hash" genere par `npm run auth:hash-password -- "motdepasse"`.
    passwordHash: process.env.SETUP_PASSWORD_HASH ?? "",
    // Ancien mode de passe en clair, conserve uniquement pour compatibilite
    // ascendante. A migrer vers SETUP_PASSWORD_HASH.
    legacyPlaintextPassword: process.env.SETUP_PASSWORD ?? "",
  },
  branding: {
    name: process.env.BRAND_NAME ?? "Accusé & Relance",
    primaryColor: process.env.BRAND_PRIMARY_COLOR ?? "#16202A",
    logoUrl: process.env.BRAND_LOGO_URL ?? "",
  },
  // Tarifs Claude en $ par million de tokens, utilises uniquement pour l'estimation
  // de cout affichee dans /consommation — ce sont des valeurs indicatives par
  // defaut, a verifier/ajuster sur la page de tarification Anthropic actuelle
  // pour le modele reellement facture (voir CLAUDE_MODEL dans src/ai/client.ts).
  pricing: {
    inputPerMillionTokensUsd: Number(process.env.CLAUDE_INPUT_PRICE_PER_MTOK ?? 3),
    outputPerMillionTokensUsd: Number(process.env.CLAUDE_OUTPUT_PRICE_PER_MTOK ?? 15),
  },
};

export function requireAnthropicApiKey(): string {
  return config.anthropicApiKey || required("ANTHROPIC_API_KEY");
}

export function loadBrandVoice(): string {
  return readFileSync(path.resolve(config.brandVoicePath), "utf-8");
}

/** Ecrit le ton de marque depuis la page /ton-de-marque — evite d'avoir a editer le fichier a la main ou redeployer pour ajuster le style des emails generes. */
export function saveBrandVoice(content: string): void {
  writeFileSync(path.resolve(config.brandVoicePath), content, "utf-8");
}
