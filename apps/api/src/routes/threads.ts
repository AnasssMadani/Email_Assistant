import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { withOrg, emailThreads } from "@global-link/db";
import { requireAuth, requireOrgAccess } from "../authPlugin.js";

/** GET /api/v1/organizations/:organizationId/threads — Phase 1 Inbox list. Pagination/filtering left minimal deliberately; the Inbox UI (apps/web) is what actually needs richer querying, added when that page is built. */
export async function registerThreadRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/api/v1/organizations/:organizationId/threads",
    { preHandler: [requireAuth, requireOrgAccess()] },
    async (request) => {
      const rows = await withOrg(request.organizationId!, (db) =>
        db
          .select()
          .from(emailThreads)
          .where(eq(emailThreads.organizationId, request.organizationId!))
          .orderBy(desc(emailThreads.updatedAt))
          .limit(100)
      );
      return { threads: rows };
    }
  );
}
