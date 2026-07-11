import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { CategoriesFile } from "./types.js";

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
  relanceCheckCron: process.env.RELANCE_CHECK_CRON ?? "*/30 * * * *",
  dbPath: process.env.DB_PATH ?? "./data/app.db",
  categoriesConfigPath: process.env.CATEGORIES_CONFIG_PATH ?? "./config/categories.json",
  brandVoicePath: process.env.BRAND_VOICE_PATH ?? "./config/brand-voice.md",
  connectionStatePath: process.env.CONNECTION_STATE_PATH ?? "./data/connection.json",
  emailConnector: (process.env.EMAIL_CONNECTOR ?? "gmail") as "gmail" | "graph",
};

export function requireAnthropicApiKey(): string {
  return config.anthropicApiKey || required("ANTHROPIC_API_KEY");
}

export function loadCategories(): CategoriesFile {
  const raw = readFileSync(path.resolve(config.categoriesConfigPath), "utf-8");
  return JSON.parse(raw) as CategoriesFile;
}

export function loadBrandVoice(): string {
  return readFileSync(path.resolve(config.brandVoicePath), "utf-8");
}

export function getCategory(categoryId: string): CategoriesFile["categories"][number] {
  const { categories } = loadCategories();
  const found = categories.find((c) => c.id === categoryId);
  if (found) return found;
  const fallback = categories.find((c) => c.id === "autre");
  if (fallback) return fallback;
  throw new Error(`Categorie inconnue: ${categoryId}, et aucune categorie "autre" de repli.`);
}
