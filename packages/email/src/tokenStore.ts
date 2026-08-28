import { eq } from "drizzle-orm";
import { getDb, mailboxes } from "@global-link/db";
import { decryptJson, encryptJson, requireEncryptionKey } from "@global-link/shared";

/**
 * Replaces the legacy app's per-provider token JSON files
 * (`GOOGLE_TOKEN_PATH`/`AZURE_TOKEN_PATH`, one mailbox per process) with per-mailbox
 * rows in Postgres — what makes more than one connected mailbox possible at all.
 * Same AES-256-GCM cipher as before (`@global-link/shared` crypto), now applied to
 * a DB column instead of a file.
 */
export interface MailboxTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export interface MailboxTokenStore {
  load(mailboxId: string): Promise<MailboxTokens | null>;
  save(mailboxId: string, tokens: MailboxTokens): Promise<void>;
}

/**
 * Note: reads/writes go through `getDb()` directly, not `withOrg()` — the caller
 * (apps/api's OAuth callback, or the worker refreshing a token mid-sync) has
 * already resolved the mailbox id from an org-scoped lookup by the time it reaches
 * here, and RLS still applies to the connection itself. Kept as a distinct helper
 * so a future direct token-table lookup doesn't need an organizationId plumbed
 * through every connector call.
 */
export function createDbTokenStore(): MailboxTokenStore {
  return {
    async load(mailboxId) {
      const db = getDb();
      const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId)).limit(1);
      if (!row?.encryptedAccessToken || !row.encryptedRefreshToken) return null;
      const key = requireEncryptionKey();
      return {
        accessToken: decryptJson<string>(row.encryptedAccessToken, key),
        refreshToken: decryptJson<string>(row.encryptedRefreshToken, key),
        expiresAt: row.tokenExpiresAt ? row.tokenExpiresAt.getTime() : 0,
      };
    },
    async save(mailboxId, tokens) {
      const db = getDb();
      const key = requireEncryptionKey();
      await db
        .update(mailboxes)
        .set({
          encryptedAccessToken: encryptJson(tokens.accessToken, key),
          encryptedRefreshToken: encryptJson(tokens.refreshToken, key),
          tokenExpiresAt: new Date(tokens.expiresAt),
          updatedAt: new Date(),
        })
        .where(eq(mailboxes.id, mailboxId));
    },
  };
}
