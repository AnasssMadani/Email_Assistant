/**
 * Nettoyage d'affichage du corps d'un email: ne garde que le dernier message
 * d'une conversation, sans l'historique cite en dessous.
 *
 * Un email de suivi de dossier peut embarquer des dizaines de reponses
 * imbriquees (parfois 80 Ko): stocke et affiche tel quel, il rend le registre
 * illisible et gonfle la base. Le fil complet reste lisible dans la messagerie.
 * Prudent par construction: sans marqueur reconnu, ou si rien ne precede le
 * marqueur, le texte d'origine est renvoye intact.
 */

// Mots d'en-tete d'une reponse citee, dans les langues rencontrees (fr, en, tr, de, es, it).
const HEADER_FROM = /^(de|from|gönderen|von|da|desde)\s*:\s*\S/i;
const HEADER_OTHER = /^(à|a|to|kime|an|para|envoy[ée]|sent|date|gönderildi|gesendet|enviado|objet|subject|konu|betreff|asunto|oggetto|cc|bilgi)\s*:/i;
const WROTE = /^(on|le|el|am)\s.{3,250}(wrote|a écrit|escribió|schrieb|şunu yazdı)\s*:?\s*$/i;
const ORIGINAL = /^-{2,}\s*(original message|message d['’]origine|message original|mensaje original|ursprüngliche nachricht)\b/i;
const OUTLOOK_RULE = /^_{5,}\s*$/;

function startsQuotedHistory(lines: string[], i: number): boolean {
  const line = lines[i].trim();
  if (ORIGINAL.test(line) || WROTE.test(line)) return true;
  // "On ... <retour a la ligne> ... wrote:" (Gmail casse parfois la ligne).
  if (/^(on|le|el|am)\s/i.test(line) && i + 1 < lines.length && WROTE.test(`${line} ${lines[i + 1].trim()}`)) return true;
  if (HEADER_FROM.test(line)) {
    // Un vrai bloc d'en-tetes: au moins un autre champ (Envoye, A, Objet...) juste en dessous.
    const next = lines.slice(i + 1, i + 7).map((l) => l.trim());
    return next.some((l) => HEADER_OTHER.test(l));
  }
  return false;
}

export function stripQuotedHistory(text: string): string {
  if (!text) return text;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let cut = -1;
  for (let i = 0; i < lines.length; i++) {
    if (startsQuotedHistory(lines, i)) {
      cut = i;
      break;
    }
  }
  let kept = cut >= 0 ? lines.slice(0, cut) : lines;
  // Separateur Outlook ("______") juste avant l'en-tete cite: il part avec lui.
  while (kept.length > 0 && (kept[kept.length - 1].trim() === "" || OUTLOOK_RULE.test(kept[kept.length - 1].trim()))) kept.pop();
  const cleaned = kept
    .filter((l) => !l.trimStart().startsWith(">"))
    .join("\n")
    .replace(/\[cid:[^\]]*\]/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned.length > 0 ? cleaned : text;
}
