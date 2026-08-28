import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { requireSupabaseJwtSecret, AppError, TenantMismatchError } from "@global-link/shared";
import { getDb, memberships, type MembershipRole } from "@global-link/db";

/**
 * Verifies a Supabase Auth access token (HS256, signed with the project's JWT
 * secret — Project Settings → API → JWT Secret) and returns the Supabase user id
 * (`sub` claim). Supabase Auth owns credentials/signup/password reset entirely;
 * this platform only ever needs to know "which authenticated user is this" and
 * "which organization(s) can they act as" — see packages/db `memberships`.
 */
export interface SupabaseJwtClaims {
  sub: string;
  email?: string;
  role?: string;
}

export function verifySupabaseAccessToken(token: string): SupabaseJwtClaims {
  try {
    const decoded = jwt.verify(token, requireSupabaseJwtSecret(), { algorithms: ["HS256"] });
    if (typeof decoded !== "object" || !decoded || typeof decoded.sub !== "string") {
      throw new Error("Token payload missing sub claim.");
    }
    return decoded as SupabaseJwtClaims;
  } catch (err) {
    throw new AppError("UNAUTHORIZED", "Invalid or expired session token.", err);
  }
}

export interface OrgMembership {
  organizationId: string;
  role: MembershipRole;
}

/**
 * A user can belong to more than one organization (e.g. an agency managing
 * several client mailboxes) — callers that need to act on a specific org must be
 * given that org id explicitly (from the request, validated against this list),
 * never assume the first membership. See docs/architecture/refonte-plan.md
 * "Never trust a client-provided organization_id" — this list is what a caller
 * validates a requested org id against, not a substitute for that check.
 */
export async function listMembershipsForUser(userId: string): Promise<OrgMembership[]> {
  const rows = await getDb().select().from(memberships).where(eq(memberships.userId, userId));
  return rows.map((r) => ({ organizationId: r.organizationId, role: r.role }));
}

export async function assertMembership(userId: string, organizationId: string): Promise<OrgMembership> {
  const orgs = await listMembershipsForUser(userId);
  const match = orgs.find((m) => m.organizationId === organizationId);
  if (!match) {
    throw new TenantMismatchError("User is not a member of the requested organization.");
  }
  return match;
}
