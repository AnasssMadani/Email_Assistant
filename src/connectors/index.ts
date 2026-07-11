import { config } from "../config.js";
import { getConnectionState } from "../connectionState.js";
import type { EmailConnector } from "../types.js";
import { GmailConnector } from "./gmailConnector.js";
import { GraphConnector } from "./graphConnector.js";

export function activeConnectorName(): "gmail" | "graph" {
  return getConnectionState()?.provider ?? config.emailConnector;
}

export function createEmailConnector(): EmailConnector {
  switch (activeConnectorName()) {
    case "gmail":
      return new GmailConnector();
    case "graph":
      return new GraphConnector();
    default:
      throw new Error(`Connecteur inconnu.`);
  }
}
