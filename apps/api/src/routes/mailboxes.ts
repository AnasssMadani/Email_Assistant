import type { FastifyInstance, FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, mailboxes, type MailboxProvider } from "@global-link/db";
import { createEmailConnector } from "@global-link/email";
import {
  buildGmailAuthUrl,
  exchangeCodeForGmailToken,
  buildGraphAuthUrl,
  exchangeCodeForGraphToken,
} from "@global-link/email";
import { requireAuth, requireOrgAccess } from "../authPlugin.js";
import { createOAuthState, verifyOAuthState } from "../oauthState.js";

/**
 * Mailbox connection (Phase 1 "Connections" flow). The OAuth start route requires
 * an authenticated org member (requireAuth + requireOrgAccess); the callback route
 * is necessarily unauthenticated (Google/Microsoft redirect the browser there
 * directly, with no way to attach a bearer token) — its ONLY trust anchor is the
 * signed `state` param, see oauthState.ts.
 *
 * A placeholder row is created before the token exchange because
 * exchangeCodeFor*Token() needs a mailboxId to persist tokens against, but the
 * mailbox's real address is only known AFTER exchanging the code — see the
 * `pending:` placeholder below, replaced with the real address once known.
 */
export async function registerMailboxRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/api/v1/organizations/:organizationId/mailboxes/:provider/start",
    { preHandler: [requireAuth, requireOrgAccess()] },
    async (request, reply) => {
      const provider = (request.params as { provider: string }).provider as MailboxProvider;
      if (provider !== "gmail" && provider !== "graph") {
        return reply.code(400).send({ error: "provider must be 'gmail' or 'graph'." });
      }

      const [placeholder] = await getDb()
        .insert(mailboxes)
        .values({ organizationId: request.organizationId!, provider, emailAddress: `pending:${randomUUID()}@placeholder.local` })
        .returning({ id: mailboxes.id });

      const state = createOAuthState(request.organizationId!, placeholder.id);
      const url = provider === "gmail" ? buildGmailAuthUrl(state) : buildGraphAuthUrl(state);
      return reply.send({ authorizeUrl: url });
    }
  );

  app.get("/auth/gmail/callback", async (request, reply) => {
    const { code, state } = request.query as { code?: string; state?: string };
    if (!code || !state) return reply.code(400).send({ error: "Missing code or state." });
    return completeOAuthCallback(reply, "gmail", state, () => exchangeCodeForGmailToken(verifyOAuthState(state).mailboxId, code));
  });

  app.get("/auth/graph/callback", async (request, reply) => {
    const { code, state } = request.query as { code?: string; state?: string };
    if (!code || !state) return reply.code(400).send({ error: "Missing code or state." });
    return completeOAuthCallback(reply, "graph", state, () => exchangeCodeForGraphToken(verifyOAuthState(state).mailboxId, code));
  });

  async function completeOAuthCallback(
    reply: FastifyReply,
    provider: MailboxProvider,
    state: string,
    exchange: () => Promise<void>
  ) {
    let mailboxId: string;
    try {
      mailboxId = verifyOAuthState(state).mailboxId;
    } catch {
      return reply.code(400).send({ error: "Invalid OAuth state." });
    }

    try {
      await exchange();
      const connector = createEmailConnector({ id: mailboxId, provider });
      const emailAddress = await connector.getOwnEmailAddress();
      await getDb().update(mailboxes).set({ emailAddress, connectedAt: new Date(), updatedAt: new Date() }).where(eq(mailboxes.id, mailboxId));
      return reply.send({ connected: true, emailAddress });
    } catch (err) {
      return reply.code(500).send({ error: `Failed to complete ${provider} connection: ${(err as Error).message}` });
    }
  }
}
