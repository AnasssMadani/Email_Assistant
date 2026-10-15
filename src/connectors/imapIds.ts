/**
 * Identifiants du connecteur IMAP. IMAP n'a ni id de message global ni
 * notion de fil (contrairement a Gmail/Graph): on les construit ici, de
 * facon stable et sans jamais rien ecrire dans la boite.
 *
 * - Id de message: dossier + UIDVALIDITY + UID (le triplet que la RFC 3501
 *   garantit unique et stable tant que UIDVALIDITY ne change pas).
 * - Id de fil: le Message-ID "racine" du fil — premier element de
 *   References, a defaut In-Reply-To, a defaut le propre Message-ID du
 *   message. Toute reponse correctement chainee (la notre comprise: voir
 *   sendReply, qui remet la racine en tete de References) porte cette
 *   racine, ce qui permet a getThread de retrouver le fil par une simple
 *   recherche d'en-tete (SEARCH HEADER — lecture seule).
 *
 * Tout est prefixe "imap." et encode en base64url: sans "/", "<", ">" ni
 * "@" — l'id passe tel quel dans une URL de l'admin (/dossiers/:threadId) et
 * ne peut jamais etre confondu avec un id Gmail (hexadecimal) ou un
 * conversationId Graph (voir threadIdMatchesConnector dans relanceCheck.ts).
 */

export interface ImapMessageRef {
  folder: string;
  uidValidity: string;
  uid: number;
}

export type DecodedImapThreadId =
  | { kind: "root"; rootMessageId: string }
  /** Message sans en-tete Message-ID (rare, souvent du spam): fil a un seul message, retrouve par son UID. */
  | { kind: "single"; ref: ImapMessageRef };

const b64 = (value: string) => Buffer.from(value, "utf-8").toString("base64url");
const unb64 = (value: string) => Buffer.from(value, "base64url").toString("utf-8");

export function encodeImapMessageId(ref: ImapMessageRef): string {
  return `imap.${b64(ref.folder)}.${ref.uidValidity}.${ref.uid}`;
}

export function decodeImapMessageId(id: string): ImapMessageRef | undefined {
  const match = id.match(/^imap\.([A-Za-z0-9_-]+)\.(\d+)\.(\d+)$/);
  if (!match) return undefined;
  return { folder: unb64(match[1]), uidValidity: match[2], uid: Number(match[3]) };
}

/** Normalise un Message-ID en "<partie@domaine>" — undefined si vide ou manifestement invalide. */
export function normalizeMessageId(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  const inner = trimmed.match(/<([^<>\s]+)>/)?.[1] ?? trimmed.replace(/^<|>$/g, "");
  if (!inner || /\s/.test(inner)) return undefined;
  return `<${inner}>`;
}

/** Decoupe un en-tete References (ou la forme tableau de mailparser) en Message-IDs normalises, dans l'ordre. */
export function parseReferences(raw: string | string[] | undefined | null): string[] {
  if (!raw) return [];
  const joined = Array.isArray(raw) ? raw.join(" ") : raw;
  return (joined.match(/<[^<>\s]+>/g) ?? []).map((id) => normalizeMessageId(id)).filter((id): id is string => !!id);
}

export function threadRootFromHeaders(headers: {
  messageId?: string | null;
  references?: string | string[] | null;
  inReplyTo?: string | null;
}): string | undefined {
  return (
    parseReferences(headers.references)[0] ??
    normalizeMessageId(headers.inReplyTo) ??
    normalizeMessageId(headers.messageId)
  );
}

export function encodeImapThreadId(rootMessageId: string | undefined, fallback: ImapMessageRef): string {
  return rootMessageId ? `imap.t.${b64(rootMessageId)}` : `imap.u.${encodeImapMessageId(fallback).slice("imap.".length)}`;
}

export function decodeImapThreadId(threadId: string): DecodedImapThreadId | undefined {
  if (threadId.startsWith("imap.t.")) {
    const root = normalizeMessageId(unb64(threadId.slice("imap.t.".length)));
    return root ? { kind: "root", rootMessageId: root } : undefined;
  }
  if (threadId.startsWith("imap.u.")) {
    const ref = decodeImapMessageId(`imap.${threadId.slice("imap.u.".length)}`);
    return ref ? { kind: "single", ref } : undefined;
  }
  return undefined;
}
