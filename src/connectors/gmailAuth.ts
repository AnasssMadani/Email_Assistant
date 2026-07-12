import { OAuth2Client } from "google-auth-library";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { decryptJson, encryptJson, looksEncrypted } from "../crypto.js";

let warnedPlaintextTokens = false;
function warnPlaintextTokensOnce(): void {
  if (warnedPlaintextTokens) return;
  warnedPlaintextTokens = true;
  console.warn(
    "[avertissement] ENCRYPTION_KEY non definie: le jeton Gmail est stocke en clair sur disque. " +
      "Definissez ENCRYPTION_KEY pour le chiffrer au repos."
  );
}

export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.compose",
];

export function createOAuthClient(): OAuth2Client {
  if (!config.google.clientId || !config.google.clientSecret) {
    throw new Error(
      "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET manquants dans .env. " +
        "Creez un identifiant OAuth 'Application web' dans Google Cloud Console."
    );
  }
  return new OAuth2Client(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri
  );
}

export function buildGmailAuthUrl(state: string): string {
  const client = createOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: GMAIL_SCOPES,
    state,
  });
}

export async function exchangeCodeForGmailToken(code: string): Promise<void> {
  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);
  saveToken(tokens);
}

export function saveToken(tokens: unknown): void {
  const tokenPath = path.resolve(config.google.tokenPath);
  mkdirSync(path.dirname(tokenPath), { recursive: true });
  if (config.encryptionKey) {
    writeFileSync(tokenPath, encryptJson(tokens, config.encryptionKey), "utf-8");
  } else {
    warnPlaintextTokensOnce();
    writeFileSync(tokenPath, JSON.stringify(tokens, null, 2), "utf-8");
  }
}

function readToken(tokenPath: string): Record<string, unknown> {
  const raw = readFileSync(tokenPath, "utf-8");
  if (config.encryptionKey && looksEncrypted(raw)) {
    return decryptJson(raw, config.encryptionKey);
  }
  if (!config.encryptionKey) warnPlaintextTokensOnce();
  return JSON.parse(raw);
}

export async function getAuthorizedClient(): Promise<OAuth2Client> {
  const tokenPath = path.resolve(config.google.tokenPath);
  if (!existsSync(tokenPath)) {
    throw new Error(
      `Aucun jeton Gmail trouve (${tokenPath}). Lancez d'abord: npm run gmail:auth`
    );
  }
  const client = createOAuthClient();
  const tokens = readToken(tokenPath);
  client.setCredentials(tokens);

  client.on("tokens", (newTokens) => {
    saveToken({ ...tokens, ...newTokens });
  });

  return client;
}
