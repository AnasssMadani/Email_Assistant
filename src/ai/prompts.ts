import type { EmailMessage, EmailThread } from "../types.js";

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

function formatMessage(m: EmailMessage): string {
  return [
    `De: ${m.from.name ? `${m.from.name} <${m.from.email}>` : m.from.email}`,
    `Date: ${m.receivedAt.toISOString()}`,
    `Objet: ${m.subject}`,
    "Message:",
    m.bodyText.slice(0, 4000),
  ].join("\n");
}
