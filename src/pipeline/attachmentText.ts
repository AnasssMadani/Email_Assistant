import type { EmailAttachment } from "../types.js";

/**
 * Lecture du contenu des pieces jointes (PDF et texte) pour donner plus de
 * contexte a l'IA. Lecture seule: on n'extrait que du TEXTE, jamais rien n'est
 * execute ni ouvert dans la boite. Le texte extrait reste une donnee non
 * fiable (voir formatAttachments dans prompts.ts): une piece jointe peut
 * contenir des consignes destinees a tromper l'IA.
 *
 * Bornes volontairement strictes (cout en tokens et memoire): au-dela, la
 * piece jointe est signalee mais pas lue.
 */

/** Taille maximale d'une piece jointe que l'on accepte de telecharger et lire. */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
/** Nombre maximal de pages PDF lues. */
export const MAX_PDF_PAGES = 12;
/** Caracteres conserves par piece jointe. */
export const MAX_ATTACHMENT_CHARS = 8000;
/** Nombre maximal de pieces jointes lues par email. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 4;

const TEXT_TYPES = new Set(["text/plain", "text/csv", "text/tab-separated-values"]);

export function isReadableAttachmentType(contentType: string | undefined, filename: string | undefined): boolean {
  const type = (contentType ?? "").toLowerCase();
  const name = (filename ?? "").toLowerCase();
  if (type === "application/pdf" || name.endsWith(".pdf")) return true;
  if (TEXT_TYPES.has(type)) return true;
  return /\.(txt|csv|tsv)$/.test(name);
}

function isPdf(contentType: string | undefined, filename: string | undefined, content: Buffer): boolean {
  if ((contentType ?? "").toLowerCase() === "application/pdf" || (filename ?? "").toLowerCase().endsWith(".pdf")) return true;
  return content.subarray(0, 5).toString("latin1") === "%PDF-";
}

function tidy(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cut(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_ATTACHMENT_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_ATTACHMENT_CHARS).trimEnd(), truncated: true };
}

/**
 * Extrait le texte d'une piece jointe deja telechargee. Ne leve jamais:
 * un PDF illisible (scanne, protege, corrompu) devient une note, pas une
 * erreur qui bloquerait le traitement de l'email.
 */
export async function extractAttachment(params: {
  filename: string;
  contentType: string;
  content: Buffer;
}): Promise<EmailAttachment> {
  const { filename, contentType, content } = params;
  const base = { filename, contentType, size: content.length };
  if (content.length > MAX_ATTACHMENT_BYTES) return { ...base, note: "too_large" };

  try {
    if (isPdf(contentType, filename, content)) {
      // Import tardif: la librairie n'est chargee que si un PDF arrive.
      const { getDocumentProxy, extractText } = await import("unpdf");
      const pdf = await getDocumentProxy(new Uint8Array(content));
      const pages = pdf.numPages;
      const extracted = await extractText(pdf, { mergePages: false });
      const perPage = (extracted.text as string[]).slice(0, MAX_PDF_PAGES);
      const raw = tidy(perPage.join("\n\n"));
      if (raw.length < 20) return { ...base, pages, note: "no_text" };
      const { text, truncated } = cut(raw);
      return { ...base, pages, text, ...(truncated || pages > MAX_PDF_PAGES ? { note: "truncated" as const } : {}) };
    }
    if (isReadableAttachmentType(contentType, filename)) {
      const raw = tidy(content.toString("utf-8"));
      if (!raw) return { ...base, note: "no_text" };
      const { text, truncated } = cut(raw);
      return { ...base, text, ...(truncated ? { note: "truncated" as const } : {}) };
    }
  } catch {
    return { ...base, note: "unreadable" };
  }
  return { ...base, note: "unsupported" };
}
