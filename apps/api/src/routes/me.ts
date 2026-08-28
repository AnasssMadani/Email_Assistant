import type { FastifyInstance } from "fastify";
import { listMembershipsForUser } from "@global-link/auth";
import { requireAuth } from "../authPlugin.js";

/** GET /api/v1/me — the authenticated user's organization memberships, so a client can resolve which org to act as. TODO: an org-switcher UI once a user commonly belongs to more than one (see docs/architecture/refonte-plan.md, out of scope for Phase 1). */
export async function registerMeRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/me", { preHandler: [requireAuth] }, async (request) => {
    const memberships = await listMembershipsForUser(request.userId!);
    return { userId: request.userId, memberships };
  });
}
