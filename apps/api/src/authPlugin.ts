import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { verifySupabaseAccessToken, assertMembership } from "@global-link/auth";

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
    /** Set only after requireOrgAccess validates the :organizationId param/body against the caller's memberships — see "Never trust a client-provided organization_id". */
    organizationId?: string;
  }
}

/** Extracts and verifies the Supabase Auth bearer token; does NOT resolve an organization — see requireOrgAccess for that. */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return reply.code(401).send({ error: "Missing bearer token." });
  }
  try {
    const claims = verifySupabaseAccessToken(header.slice("Bearer ".length));
    request.userId = claims.sub;
  } catch {
    return reply.code(401).send({ error: "Invalid or expired session." });
  }
}

/**
 * Validates that the authenticated user is a member of the organization named in
 * the route — the ONLY sanctioned way an organizationId reaches a handler. Never
 * read `request.params.organizationId` directly in a handler; read
 * `request.organizationId` after this ran.
 */
export function requireOrgAccess(paramName = "organizationId") {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!request.userId) {
      return reply.code(401).send({ error: "requireAuth must run before requireOrgAccess." });
    }
    const requested = (request.params as Record<string, string>)[paramName];
    if (!requested) {
      return reply.code(400).send({ error: `Missing :${paramName} route param.` });
    }
    try {
      await assertMembership(request.userId, requested);
      request.organizationId = requested;
    } catch {
      return reply.code(403).send({ error: "Not a member of this organization." });
    }
  };
}

export default fp(async (_app: FastifyInstance) => {
  // Registered as a plugin only so requireAuth/requireOrgAccess's module augmentation
  // above is guaranteed loaded before routes reference request.userId/organizationId.
});
