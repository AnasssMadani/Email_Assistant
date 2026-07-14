import type { EmailMessage, EmailThread } from "../types.js";

/**
 * L'application ne redige qu'en francais ou en anglais — jamais dans une
 * troisieme langue, meme si le client ecrit dans une autre langue (pour ne
 * pas produire une traduction non relue par un humain dans une langue que
 * personne dans l'equipe ne maitrise forcement).
 */
export const LANGUAGE_INSTRUCTION = [
  "Langue de reponse: determine la langue du dernier message du client.",
  "- S'il a ecrit en francais, redige ta reponse en francais.",
  "- S'il a ecrit dans une autre langue (anglais ou toute autre langue),",
  "  redige ta reponse en anglais.",
  "- Ne redige jamais dans une langue autre que le francais ou l'anglais,",
  "  meme si le client a ecrit dans une troisieme langue.",
].join("\n");

export function formatThreadContext(thread: EmailThread, incoming: EmailMessage): string {
  const history = thread.messages.filter((m) => m.id !== incoming.id);
  const historyBlock = history.length
    ? history.map((m) => formatMessage(m)).join("\n\n---\n\n")
    : "(aucun echange precedent dans ce fil)";

  return [
    "Historique du fil de discussion:",
    historyBlock,
    "",
    "Nouveau message a traiter:",
    formatMessage(incoming),
  ].join("\n");
}

/**
 * Version allegee de formatThreadContext: un seul message, sans l'historique
 * complet du fil. Utilisee pour les appels ou le contexte des echanges
 * precedents n'apporte pas assez de valeur pour justifier son cout en tokens
 * (classification, accuse de reception, relance) — contrairement aux 3
 * brouillons de reponse, qui eux beneficient reellement de tout l'historique
 * pour ne pas contredire un echange anterieur. Sur un fil long (nombreux
 * allers-retours), formatThreadContext peut couter plusieurs milliers de
 * tokens en entree a chaque appel; ceci reste borne a un seul message.
 */
export function formatSingleMessage(message: EmailMessage): string {
  return ["Message a traiter:", formatMessage(message)].join("\n");
}

function formatMessage(m: EmailMessage): string {
  return [
    `De: ${m.from.name ? `${m.from.name} <${m.from.email}>` : m.from.email}`,
    `Date: ${m.receivedAt.toISOString()}`,
    `Objet: ${m.subject}`,
    "Message:",
    m.bodyText.slice(0, 4000),
  ].join("\n");
}
