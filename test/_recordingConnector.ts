import type { EmailConnector, EmailThread } from "../src/types.js";

/** Methodes d'un connecteur qui ne font que LIRE la boite. */
export const READ_METHODS = ["getOwnEmailAddress", "listRecentInboxMessages", "listRecentSentMessages", "getThread"];

/**
 * Faux connecteur qui journalise CHAQUE methode appelee par le pipeline,
 * y compris une methode qui n'existe pas (encore) dans EmailConnector:
 * l'acces passe par un Proxy, donc un futur `connector.markAsRead(...)`
 * ou `connector.moveToFolder(...)` apparaitrait dans `calls` (et
 * planterait) au lieu de passer inapercu.
 */
export function recordingConnector(thread: EmailThread, name: "gmail" | "graph" = "gmail") {
  const calls: string[] = [];
  const impl: Record<string, (...args: unknown[]) => Promise<unknown>> = {
    async getOwnEmailAddress() {
      return "us@example.com";
    },
    async listRecentInboxMessages() {
      return [];
    },
    async listRecentSentMessages() {
      return [];
    },
    async getThread() {
      return thread;
    },
    async sendReply() {
      return { id: "sent-1" };
    },
    async sendNotification() {
      return { id: "notif-1" };
    },
  };
  const connector = new Proxy({} as EmailConnector, {
    get(_target, prop) {
      if (prop === "name") return name;
      if (prop === "then") return undefined; // jamais traite comme une promesse
      return (...args: unknown[]) => {
        calls.push(String(prop));
        const fn = impl[String(prop)];
        if (!fn) throw new Error(`Methode de connecteur inattendue: ${String(prop)}`);
        return fn(...args);
      };
    },
  });
  return { connector, calls };
}
