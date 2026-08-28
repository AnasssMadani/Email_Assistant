import { loadConfig, ConfigError } from "@global-link/shared";
import { createDbTokenStore, type MailboxTokenStore } from "./tokenStore.js";

export const GRAPH_SCOPES = [
  "offline_access",
  "https://graph.microsoft.com/Mail.Read",
  "https://graph.microsoft.com/Mail.Send",
  "https://graph.microsoft.com/Mail.ReadWrite",
  "https://graph.microsoft.com/User.Read",
].join(" ");

function authority(): string {
  return `https://login.microsoftonline.com/${loadConfig().AZURE_TENANT_ID || "common"}`;
}

export function requireAzureCredentials(): void {
  const env = loadConfig();
  if (!env.AZURE_CLIENT_ID || !env.AZURE_CLIENT_SECRET) {
    throw new ConfigError("AZURE_CLIENT_ID / AZURE_CLIENT_SECRET missing. Register an app in the tenant's Azure AD.");
  }
}

export function buildGraphAuthUrl(state: string): string {
  requireAzureCredentials();
  const env = loadConfig();
  const url = new URL(`${authority()}/oauth2/v2.0/authorize`);
  url.searchParams.set("client_id", env.AZURE_CLIENT_ID as string);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", env.AZURE_REDIRECT_URI ?? "");
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", GRAPH_SCOPES);
  url.searchParams.set("state", state);
  return url.toString();
}

interface GraphTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

async function requestToken(body: URLSearchParams, previousRefreshToken?: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}> {
  const res = await fetch(`${authority()}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Microsoft authentication failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as GraphTokenResponse;
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? previousRefreshToken ?? "",
    expiresAt: Date.now() + json.expires_in * 1000,
  };
}

export async function exchangeCodeForGraphToken(
  mailboxId: string,
  code: string,
  store: MailboxTokenStore = createDbTokenStore()
): Promise<void> {
  requireAzureCredentials();
  const env = loadConfig();
  const body = new URLSearchParams({
    client_id: env.AZURE_CLIENT_ID as string,
    client_secret: env.AZURE_CLIENT_SECRET as string,
    grant_type: "authorization_code",
    code,
    redirect_uri: env.AZURE_REDIRECT_URI ?? "",
    scope: GRAPH_SCOPES,
  });
  const tokens = await requestToken(body);
  await store.save(mailboxId, tokens);
}

/** Returns a valid access token for `mailboxId`, refreshing (and persisting the refresh) if it has expired within the next minute. */
export async function getValidGraphAccessToken(
  mailboxId: string,
  store: MailboxTokenStore = createDbTokenStore()
): Promise<string> {
  requireAzureCredentials();
  const existing = await store.load(mailboxId);
  if (!existing) {
    throw new Error(`No Microsoft tokens stored for mailbox ${mailboxId}. Connect it via the OAuth flow first.`);
  }
  if (Date.now() < existing.expiresAt - 60_000) {
    return existing.accessToken;
  }
  const env = loadConfig();
  const body = new URLSearchParams({
    client_id: env.AZURE_CLIENT_ID as string,
    client_secret: env.AZURE_CLIENT_SECRET as string,
    grant_type: "refresh_token",
    refresh_token: existing.refreshToken,
    scope: GRAPH_SCOPES,
  });
  const refreshed = await requestToken(body, existing.refreshToken);
  await store.save(mailboxId, refreshed);
  return refreshed.accessToken;
}
