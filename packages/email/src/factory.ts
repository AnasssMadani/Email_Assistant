import type { EmailConnector } from "@global-link/shared";
import { GmailConnector } from "./gmailConnector.js";
import { GraphConnector } from "./graphConnector.js";

export interface MailboxRef {
  id: string;
  provider: "gmail" | "graph";
}

/**
 * Replaces the legacy app's `createEmailConnector()` (one global connector for the
 * single connected mailbox, re-read from `connectionState.json` every scheduler
 * tick). Now takes an explicit mailbox — apps/worker resolves the set of mailboxes
 * due for a sync pass and builds one connector per mailbox, per cycle, so a
 * reconnect via the dashboard takes effect on the very next job without a process
 * restart (same intent as the legacy comment, different mechanism).
 */
export function createEmailConnector(mailbox: MailboxRef): EmailConnector {
  switch (mailbox.provider) {
    case "gmail":
      return new GmailConnector(mailbox.id);
    case "graph":
      return new GraphConnector(mailbox.id);
    default:
      throw new Error(`Unknown mailbox provider: ${mailbox.provider satisfies never}`);
  }
}
