import { and, eq } from "drizzle-orm";
import { withOrg, ackTemplates, relanceTemplates, type RelancePhase } from "@global-link/db";

export async function getAckTemplateBody(
  organizationId: string,
  categoryId: string,
  language: "fr" | "en"
): Promise<string | undefined> {
  const [row] = await withOrg(organizationId, (db) =>
    db.select().from(ackTemplates).where(and(eq(ackTemplates.categoryId, categoryId), eq(ackTemplates.language, language))).limit(1)
  );
  return row?.body;
}

export async function getRelanceTemplateBody(
  organizationId: string,
  categoryId: string,
  phase: RelancePhase,
  language: "fr" | "en"
): Promise<string | undefined> {
  const [row] = await withOrg(organizationId, (db) =>
    db
      .select()
      .from(relanceTemplates)
      .where(and(eq(relanceTemplates.categoryId, categoryId), eq(relanceTemplates.phase, phase), eq(relanceTemplates.language, language)))
      .limit(1)
  );
  return row?.body;
}
