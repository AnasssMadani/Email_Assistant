import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM helper for encrypting OAuth tokens at rest — ported unchanged from the
 * legacy app's `src/crypto.ts`. The legacy app wrote the result to a token JSON file
 * on disk; the platform stores it in `mailboxes.encrypted_access_token` /
 * `encrypted_refresh_token` instead (see packages/email/src/tokenStore.ts), but the
 * cipher and format are identical.
 */
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

function loadKey(hexKey: string): Buffer {
  const key = Buffer.from(hexKey, "hex");
  if (key.length !== 32) {
    throw new Error("ENCRYPTION_KEY must be 32 bytes hex-encoded (64 characters).");
  }
  return key;
}

/** Encrypts a JSON-serializable value. Returns "iv:authTag:ciphertext" hex-encoded. */
export function encryptJson(value: unknown, hexKey: string): string {
  const key = loadKey(hexKey);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf-8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

export function decryptJson<T>(payload: string, hexKey: string): T {
  const key = loadKey(hexKey);
  const [ivHex, authTagHex, ciphertextHex] = payload.split(":");
  if (!ivHex || !authTagHex || !ciphertextHex) {
    throw new Error("Invalid encrypted token payload format.");
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, "hex")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf-8")) as T;
}

/** True if `raw` looks like an encryptJson payload, as opposed to plain JSON. */
export function looksEncrypted(raw: string): boolean {
  return /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/i.test(raw.trim());
}
