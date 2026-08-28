import { OAuth2Client } from "google-auth-library";
import { loadConfig, ConfigError } from "@global-link/shared";
import { createDbTokenStore, type MailboxTokenStore, type MailboxTokens } from "./tokenStore.js";

export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.compose",
];

export function createOAuthClient(): OAuth2Client {
  const env = loadConfig();
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new ConfigError(
      "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing. Create a 'Web application' OAuth client in Google Cloud Console."
    );
  }
  return new OAuth2Client(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_REDIRECT_URI);
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

/** Exchanges an OAuth code and persists the resulting tokens for `mailboxId` (see tokenStore.ts). */
export async function exchangeCodeForGmailToken(
  mailboxId: string,
  code: string,
  store: MailboxTokenStore = createDbTokenStore()
): Promise<void> {
  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.access_token || !tokens.refresh_token) {
    throw new Error("Google did not return an access_token/refresh_token pair (missing access_type=offline?).");
  }
  await store.save(mailboxId, {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: tokens.expiry_date ?? Date.now() + 3600_000,
  });
}

/**
 * Returns an OAuth2Client authorized for `mailboxId`, wired to persist a token
 * refresh back to the same row — the equivalent of the legacy app's
 * `client.on("tokens", ...)` file rewrite, now writing to Postgres. Google does not
 * always return a fresh refresh_token on refresh; when it doesn't, the previously
 * stored one is kept rather than being overwritten with `undefined`.
 */
export async function getAuthorizedClient(
  mailboxId: string,
  store: MailboxTokenStore = createDbTokenStore()
): Promise<OAuth2Client> {
  const existing = await store.load(mailboxId);
  if (!existing) {
    throw new Error(`No Gmail tokens stored for mailbox ${mailboxId}. Connect it via the OAuth flow first.`);
  }

  const client = createOAuthClient();
  client.setCredentials({
    access_token: existing.accessToken,
    refresh_token: existing.refreshToken,
    expiry_date: existing.expiresAt,
  });

  client.on("tokens", (newTokens) => {
    const merged: MailboxTokens = {
      accessToken: newTokens.access_token ?? existing.accessToken,
      refreshToken: newTokens.refresh_token ?? existing.refreshToken,
      expiresAt: newTokens.expiry_date ?? Date.now() + 3600_000,
    };
    void store.save(mailboxId, merged);
  });

  return client;
}
