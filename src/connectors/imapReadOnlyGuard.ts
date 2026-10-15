/**
 * Garde-fou "boite en lecture seule" du connecteur IMAP — regle n°1 du
 * projet: on ne marque rien comme lu, on ne deplace rien, on ne supprime
 * rien. La lecture doit rester strictement passive.
 *
 * Liste BLANCHE (fail-closed): toute commande IMAP absente de cette liste
 * est refusee AVANT d'atteindre le reseau, y compris une commande qu'une
 * future version d'imapflow ajouterait d'elle-meme (ex: un SELECT implicite
 * via ensureSelectedMailbox, un CLOSE qui expurgerait les messages marques
 * \Deleted, un APPEND...). Ce controle ne remplace pas un code appelant
 * correct (EXAMINE + BODY.PEEK) — il garantit qu'une erreur de ce code ou de
 * la bibliotheque ne peut pas, elle, toucher la boite.
 */

export class ImapWriteBlockedError extends Error {
  constructor(command: string, reason: string) {
    super(`Commande IMAP refusee par le garde-fou lecture seule: ${command} (${reason}).`);
    this.name = "ImapWriteBlockedError";
  }
}

/**
 * Commandes sans aucun effet sur le contenu ou les drapeaux de la boite.
 * Volontairement absentes: SELECT (ouvre en lecture-ecriture — EXAMINE a la
 * place), STORE/UID STORE (drapeaux, dont \Seen), COPY/MOVE/APPEND,
 * EXPUNGE/UID EXPUNGE, CLOSE (expurge les \Deleted si la boite etait ouverte
 * en ecriture), UNSELECT, CREATE/DELETE/RENAME, SUBSCRIBE/UNSUBSCRIBE,
 * SETQUOTA, SETACL, SETMETADATA, IDLE (inutile ici, desactive).
 */
const ALLOWED_COMMANDS = new Set([
  "CAPABILITY",
  "ID",
  "LOGIN",
  "AUTHENTICATE",
  "STARTTLS",
  "COMPRESS",
  "ENABLE",
  "NAMESPACE",
  "LIST",
  "LSUB",
  "XLIST",
  "STATUS",
  "EXAMINE",
  "SEARCH",
  "UID SEARCH",
  "FETCH",
  "UID FETCH",
  "NOOP",
  "LOGOUT",
]);

interface ImapAttribute {
  type?: string;
  value?: unknown;
  section?: unknown;
}

/**
 * Elements FETCH qui posent implicitement \Seen (RFC 3501 §6.4.5): BODY[...]
 * et BINARY[...] sans .PEEK, ainsi que RFC822 et RFC822.TEXT. RFC822.HEADER
 * et RFC822.SIZE, eux, ne modifient rien.
 */
function findSeenSettingFetchItem(attributes: unknown): string | undefined {
  const stack: unknown[] = [attributes];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    if (!current || typeof current !== "object") continue;
    const attr = current as ImapAttribute;
    if (Array.isArray(attr.value)) stack.push(attr.value);
    if (typeof attr.value !== "string") continue;
    const value = attr.value.toUpperCase();
    // imapflow represente "BODY.PEEK[...]" comme un ATOM de valeur
    // "BODY.PEEK" portant une propriete "section" — un ATOM "BODY"/"BINARY"
    // avec section est donc la variante qui marque comme lu.
    if (attr.section !== undefined && !value.endsWith(".PEEK")) return value;
    if (/^(BODY|BINARY)\[/.test(value)) return value;
    if (value === "RFC822" || value === "RFC822.TEXT") return value;
  }
  return undefined;
}

export function assertReadOnlyImapCommand(command: string, attributes?: unknown): void {
  const normalized = command.toUpperCase().trim().replace(/\s+/g, " ");
  if (!ALLOWED_COMMANDS.has(normalized)) {
    throw new ImapWriteBlockedError(normalized, "commande hors liste blanche");
  }
  if (normalized === "FETCH" || normalized === "UID FETCH") {
    const offending = findSeenSettingFetchItem(attributes);
    if (offending) {
      throw new ImapWriteBlockedError(normalized, `${offending} marquerait le message comme lu — BODY.PEEK obligatoire`);
    }
  }
}

type ExecFn = (command: string, attributes?: unknown, options?: unknown) => Promise<unknown>;

/**
 * Intercepte le point de passage unique de toutes les commandes imapflow
 * (ImapFlow#exec — chaque commande de la bibliotheque, LOGIN compris, passe
 * par la) pour y appliquer assertReadOnlyImapCommand avant tout envoi. Si
 * une future version d'imapflow renommait ce point d'entree, on refuse de
 * fonctionner plutot que de tourner sans garde-fou.
 */
export function installReadOnlyGuard(client: object): void {
  const target = client as { exec?: ExecFn };
  const original = target.exec;
  if (typeof original !== "function") {
    throw new Error(
      "Garde-fou IMAP lecture seule impossible a installer (ImapFlow#exec introuvable) — connexion refusee par securite."
    );
  }
  target.exec = function guardedExec(this: unknown, command: string, attributes?: unknown, options?: unknown) {
    try {
      assertReadOnlyImapCommand(command, attributes);
    } catch (err) {
      return Promise.reject(err);
    }
    return original.call(this, command, attributes, options);
  };
}
