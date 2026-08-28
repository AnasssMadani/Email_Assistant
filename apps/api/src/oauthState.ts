import { createHmac, randomBytes } from "node:crypto";
import { requireEncryptionKey } from "@global-link/shared";

/**
 * Signed OAuth `state` param — carries which mailbox/org this callback belongs to,
 * and doubles as the anti-CSRF nonce (unlike legacy's server.ts, which kept a pure
 * nonce in `state` and the return target in a separate `oauth_from` cookie; here
 * there is only one thing to carry, so one signed token does both jobs).
 */
export interface OAuthStatePayload {
  organizationId: string;
  mailboxId: string;
  nonce: string;
}

function sign(payload: string): string {
  return createHmac("sha256", requireEncryptionKey()).update(payload).digest("hex");
}

export function createOAuthState(organizationId: string, mailboxId: string): string {
  const payload: OAuthStatePayload = { organizationId, mailboxId, nonce: randomBytes(16).toString("hex") };
  const json = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${json}.${sign(json)}`;
}

export function verifyOAuthState(state: string): OAuthStatePayload {
  const [json, signature] = state.split(".");
  if (!json || !signature || sign(json) !== signature) {
    throw new Error("Invalid or tampered OAuth state.");
  }
  return JSON.parse(Buffer.from(json, "base64url").toString("utf-8")) as OAuthStatePayload;
}
