import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

function loadKey(hexKey: string): Buffer {
  const key = Buffer.from(hexKey, "hex");
  if (key.length !== 32) {
    throw new Error("ENCRYPTION_KEY doit faire 32 octets encodes en hexadecimal (64 caracteres).");
  }
  return key;
}

/** Chiffre un objet JSON avec AES-256-GCM. Retourne "iv:authTag:ciphertext" en hexadecimal. */
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
    throw new Error("Format de jeton chiffre invalide.");
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, "hex")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf-8")) as T;
}

/** Vrai si la chaine ressemble a une charge utile chiffree par encryptJson (par opposition a du JSON brut). */
export function looksEncrypted(raw: string): boolean {
  return /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/i.test(raw.trim());
}
