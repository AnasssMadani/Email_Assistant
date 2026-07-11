import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";

export const GRAPH_SCOPES = [
  "offline_access",
  "https://graph.microsoft.com/Mail.Read",
  "https://graph.microsoft.com/Mail.Send",
  "https://graph.microsoft.com/Mail.ReadWrite",
  "https://graph.microsoft.com/User.Read",
].join(" ");

interface GraphTokenSet {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

function authority(): string {
  return `https://login.microsoftonline.com/${config.azure.tenantId || "common"}`;
}

function tokenPath(): string {
  return path.resolve(config.azure.tokenPath);
}

export function requireAzureCredentials(): void {
  if (!config.azure.clientId || !config.azure.clientSecret) {
    throw new Error(
      "AZURE_CLIENT_ID / AZURE_CLIENT_SECRET manquants dans .env. " +
        "Enregistrez une application dans l'Azure AD du client (voir README)."
    );
  }
}

export function buildGraphAuthUrl(state: string): string {
  requireAzureCredentials();
  const url = new URL(`${authority()}/oauth2/v2.0/authorize`);
  url.searchParams.set("client_id", config.azure.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", config.azure.redirectUri);
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", GRAPH_SCOPES);
  url.searchParams.set("state", state);
  return url.toString();
}

export function saveGraphToken(tokens: GraphTokenSet): void {
  mkdirSync(path.dirname(tokenPath()), { recursive: true });
  writeFileSync(tokenPath(), JSON.stringify(tokens, null, 2), "utf-8");
}

export function loadGraphToken(): GraphTokenSet | null {
  if (!existsSync(tokenPath())) return null;
  return JSON.parse(readFileSync(tokenPath(), "utf-8")) as GraphTokenSet;
}

async function requestToken(body: URLSearchParams): Promise<GraphTokenSet> {
  const res = await fetch(`${authority()}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Echec de l'authentification Microsoft (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  const existing = loadGraphToken();
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token ?? existing?.refresh_token ?? "",
    expires_at: Date.now() + json.expires_in * 1000,
  };
}

export async function exchangeCodeForGraphToken(code: string): Promise<GraphTokenSet> {
  requireAzureCredentials();
  const body = new URLSearchParams({
    client_id: config.azure.clientId,
    client_secret: config.azure.clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: config.azure.redirectUri,
    scope: GRAPH_SCOPES,
  });
  const tokens = await requestToken(body);
  saveGraphToken(tokens);
  return tokens;
}

export async function getValidGraphAccessToken(): Promise<string> {
  requireAzureCredentials();
  const tokens = loadGraphToken();
  if (!tokens) {
    throw new Error(
      "Aucun compte Microsoft connecte. Utilisez la page de connexion (npm run setup)."
    );
  }
  if (Date.now() < tokens.expires_at - 60_000) {
    return tokens.access_token;
  }
  const body = new URLSearchParams({
    client_id: config.azure.clientId,
    client_secret: config.azure.clientSecret,
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    scope: GRAPH_SCOPES,
  });
  const refreshed = await requestToken(body);
  saveGraphToken(refreshed);
  return refreshed.access_token;
}
