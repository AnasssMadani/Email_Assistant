import { config } from "../config.js";
import { getConnectionState } from "../connectionState.js";
import type { EmailConnector } from "../types.js";
import { GmailConnector } from "./gmailConnector.js";
import { GraphConnector } from "./graphConnector.js";
import { ImapSmtpConnector } from "./imapConnector.js";

export function activeConnectorName(): "gmail" | "graph" | "imap" {
  // IMAP n'a pas de flux de connexion dans l'UI (identifiants en variables
  // d'environnement uniquement): choisi explicitement par EMAIL_CONNECTOR,
  // il prime sur un eventuel etat OAuth Gmail/Graph reste sur disque.
  if (config.emailConnector === "imap") return "imap";
  return getConnectionState()?.provider ?? config.emailConnector;
}

export function createEmailConnector(): EmailConnector {
  switch (activeConnectorName()) {
    case "gmail":
      return new GmailConnector();
    case "graph":
      return new GraphConnector();
    case "imap":
      return new ImapSmtpConnector();
    default:
      throw new Error(`Connecteur inconnu.`);
  }
}
