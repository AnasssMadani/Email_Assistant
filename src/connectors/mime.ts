import type { gmail_v1 } from "googleapis";

export function decodeBase64Url(data: string): string {
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf-8");
}

export function encodeBase64Url(input: string): string {
  return Buffer.from(input, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function getHeader(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string
): string | undefined {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? undefined;
}

export function extractPlainText(part: gmail_v1.Schema$MessagePart | undefined): string {
  if (!part) return "";

  if (part.mimeType === "text/plain" && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }

  if (part.parts && part.parts.length > 0) {
    for (const child of part.parts) {
      const text = extractPlainText(child);
      if (text) return text;
    }
  }

  if (!part.parts && part.mimeType === "text/html" && part.body?.data) {
    return decodeBase64Url(part.body.data).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }

  return "";
}

export function parseAddress(raw: string | undefined): { name?: string; email: string } {
  if (!raw) return { email: "" };
  const match = raw.match(/^\s*(?:"?([^"<]*)"?\s*)?<?([^<>\s]+@[^<>\s]+)>?\s*$/);
  if (!match) return { email: raw.trim() };
  const [, name, email] = match;
  return { name: name?.trim() || undefined, email: email.trim() };
}

export function buildRawMimeMessage(params: {
  from: string;
  to: string;
  subject: string;
  bodyText: string;
  inReplyToMessageId?: string;
  references?: string;
}): string {
  const lines = [
    `From: ${params.from}`,
    `To: ${params.to}`,
    `Subject: ${encodeSubject(params.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 7bit",
  ];

  if (params.inReplyToMessageId) {
    lines.push(`In-Reply-To: ${params.inReplyToMessageId}`);
  }
  if (params.references) {
    lines.push(`References: ${params.references}`);
  }

  const raw = `${lines.join("\r\n")}\r\n\r\n${params.bodyText}`;
  return encodeBase64Url(raw);
}

function encodeSubject(subject: string): string {
  if (/^[\x00-\x7F]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, "utf-8").toString("base64")}?=`;
}
