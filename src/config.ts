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
  // En pause par defaut (a la demande): l'accuse, les relances et les
  // notifications continuent de fonctionner normalement, seuls les 3
  // brouillons de reponse ne sont plus generes ni deposes. Remettre a
  // "true" pour les reactiver, sans autre changement de code.
  draftRepliesEnabled: process.env.ENABLE_DRAFT_REPLIES === "true",
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
    // Identifiants separes pour le dashboard client (/client/...) — jamais
    // le meme compte que l'admin, meme format de hash (voir
    // npm run auth:hash-password). Si absents, le dashboard client s'ouvre
    // sans mot de passe (meme convention que l'admin ci-dessus) — a ne
    // jamais laisser ainsi hors localhost.
    clientUsername: process.env.CLIENT_USERNAME ?? "",
    clientPasswordHash: process.env.CLIENT_PASSWORD_HASH ?? "",
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
  // Fuseau d'affichage des dates dans l'admin. Sans ceci, toLocaleString()
  // rend dans le fuseau du serveur d'hebergement (souvent UTC), pas celui de
  // l'equipe — un decalage silencieux d'1h+ selon ou l'app est deployee.
  timezone: process.env.APP_TIMEZONE ?? "Africa/Casablanca",
  // Garde-fou anti-rafale: nombre maximal de relances EXTERNES (celles vues
  // par un client) que le planificateur peut envoyer en un seul cycle de
  // verification. Un rattrapage apres arret du planificateur, ou simplement
  // beaucoup de dossiers configures avec des delais courts arrivant a
  // echeance au meme moment, ne doit jamais se traduire par une rafale
  // d'emails identiques envoyes d'un coup a plusieurs clients — le surplus
  // attend simplement le cycle suivant. Les rappels internes (jamais vus
  // par un client) ne sont pas concernes par cette limite.
  maxExternalRelancesPerCycle: Number(process.env.MAX_EXTERNAL_RELANCES_PER_CYCLE ?? 5),
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
