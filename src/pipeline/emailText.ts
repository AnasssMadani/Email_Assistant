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
  if (cleaned.length === 0) return text;
  // Texte deja aplati sur une seule ligne (anciennes captures, ou HTML mal
  // converti): les marqueurs ci-dessus, cherches en debut de ligne, ne
  // peuvent pas le voir. On coupe alors au premier marqueur trouve en
  // plein milieu du texte — seulement sur un texte aplati, pour ne jamais
  // tronquer un email normal qui contiendrait "From: Ningbo ... Sent:".
  if ((cleaned.match(/\n/g) ?? []).length > 2) return cleaned;
  const inline = cutAtInlineQuoteMarker(cleaned);
  return inline.length > 0 ? inline : cleaned;
}

// Marqueurs d'historique cherches n'importe ou dans le texte (pas seulement
// en debut de ligne). Volontairement stricts: un en-tete "De : X" ne compte
// que suivi d'un "Envoye :" / "Sent :" a courte distance.
const INLINE_MARKERS: RegExp[] = [
  /-{2,}\s*(original message|message d['’]origine|message original|mensaje original|ursprüngliche nachricht)\s*-*/i,
  /\b(de|from|gönderen|von|da|desde)\s*:\s*\S.{0,200}?\s(envoy[ée]|sent|gönderildi|gesendet|enviado|inviato)\s*:/i,
  /\b(on|le|el|am)\s[^\n]{3,250}?\s(wrote|a écrit|escribió|schrieb|şunu yazdı)\s*:/i,
  /\b(envoyé de mon|sent from my) (iphone|ipad|android|samsung|mobile)/i,
];

function cutAtInlineQuoteMarker(text: string): string {
  let cut = -1;
  for (const re of INLINE_MARKERS) {
    const m = re.exec(text);
    if (m && m.index > 0 && (cut < 0 || m.index < cut)) cut = m.index;
  }
  return cut > 0 ? text.slice(0, cut).trim() : text;
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  laquo: "«",
  raquo: "»",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  euro: "€",
  eacute: "é",
  egrave: "è",
  ecirc: "ê",
  agrave: "à",
  acirc: "â",
  ccedil: "ç",
  ocirc: "ô",
  ucirc: "û",
  ugrave: "ù",
  icirc: "î",
  iuml: "ï",
  Eacute: "É",
  Agrave: "À",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    }
    return NAMED_ENTITIES[code] ?? NAMED_ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/**
 * Conversion HTML -> texte quand un email n'a pas de partie texte exploitable.
 * Garde les retours a la ligne (sans eux, stripQuotedHistory ne retrouve plus
 * les en-tetes "De : / Envoye :" de l'historique), retire le contenu des
 * balises <style>/<script>/<head> (sinon du CSS se retrouve dans le texte lu
 * par l'IA et dans le corpus de l'equipe) et decode les entites (&nbsp;...).
 */
/**
 * Partie "texte" qui contient en realite du HTML (certains logiciels
 * d'agents, ex: les avis d'arrivee et factures de Norvex, envoient le code
 * HTML dans la partie text/plain). Telle quelle, l'IA ne lit que des balises
 * et le carnet les affiche. Prudent: seul un texte qui COMMENCE par une
 * balise de structure HTML est concerne, pas un email qui cite "<lien>".
 */
export function looksLikeHtml(text: string): boolean {
  return /^\s*<(!doctype\s+html|html|head|body|meta|style|div|p|table|span)\b/i.test(text);
}

export function htmlToText(html: string): string {
  const withBreaks = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(head|style|script|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote|ul|ol|pre|section|article|header|footer)\s*>/gi, "\n")
    .replace(/<(p|div|tr|h[1-6]|table|blockquote|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/t[dh]\s*>/gi, " ")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(withBreaks)
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}


/**
 * Nettoyage d'une reponse de l'equipe avant de s'en servir pour apprendre
 * (corpus, note de style). Rattrape aussi les reponses deja enregistrees
 * avant la correction de htmlToText: texte aplati, entites HTML brutes,
 * reste de CSS ("body { line-height: 1.5; }"), historique cite.
 */
export function cleanReplyForLearning(text: string): string {
  if (!text) return text;
  const noCss = removeCssRules(decodeEntities(text));
  return stripQuotedHistory(noCss.replace(/[ \t]{2,}/g, " ").trim());
}

/** Contenu d'accolades qui ressemble a des declarations CSS ("margin:0cm; font-size:11pt"). */
const CSS_DECLARATIONS = /^\s*(?:[a-z-]+\s*:\s*[^;{}]*;?\s*)+$/i;
const CSS_COMMON_PROPERTY =
  /^\s*(?:color|margin|padding|font|display|width|height|border|background|line-height|text-align|mso-[a-z-]+|[a-z]+-(?:top|bottom|left|right|size|family|weight|color|width|height|style))[a-z-]*\s*:/i;
/** Un morceau de selecteur CSS: ".MsoNormal", "p.MsoNormal", "#id", "@page", "a:link", "body", ",", ">"... */
const CSS_SELECTOR_TOKEN =
  /^(?:[,>+~]|@[\w-]+|[\w-]*[.#:][\w\-.#:()]*,?|(?:html|body|p|div|span|a|table|td|tr|th|li|ul|ol|img|font|blockquote|h[1-6])(?:[.#:][\w\-.#:()]*)?,?)$/i;

/**
 * Retire les regles CSS restees dans le texte ("p.MsoNormal {margin:0cm}")
 * sans toucher aux mots qui les precedent: on ne remonte, avant l'accolade,
 * que sur des morceaux qui ont la forme d'un selecteur.
 */
function removeCssRules(text: string): string {
  // \u0000 marque l'emplacement de chaque regle retiree (absent d'un email texte).
  let out = text.replace(/\u0000/g, "");
  for (;;) {
    let changed = false;
    out = out.replace(/\{([^{}]{0,400})\}/g, (whole, inner: string) => {
      // Une seule declaration sans ";" ("{Note: urgent}") peut etre du texte:
      // on n'y touche que si la propriete est une propriete CSS courante.
      if (!CSS_DECLARATIONS.test(inner) || (!inner.includes(";") && !CSS_COMMON_PROPERTY.test(inner))) return whole;
      changed = true;
      return "\u0000";
    });
    if (!changed) return out;
    out = out.replace(/([^\u0000]*)\u0000/g, (_whole, before: string) => {
      const tokens = before.split(/(\s+)/);
      let i = tokens.length - 1;
      while (i >= 0 && (tokens[i].trim() === "" || CSS_SELECTOR_TOKEN.test(tokens[i]))) i--;
      return tokens.slice(0, i + 1).join("") + " ";
    });
  }
}
