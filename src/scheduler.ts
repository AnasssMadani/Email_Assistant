import cron from "node-cron";
import { config } from "./config.js";
import { createEmailConnector } from "./connectors/index.js";
import { processIncomingMessage } from "./pipeline/processIncoming.js";
import { runRelanceCheck } from "./pipeline/relanceCheck.js";
import type { EmailConnector } from "./types.js";

async function pollInbox(connector: EmailConnector): Promise<void> {
  try {
    const messages = await connector.listRecentInboxMessages(25);
    for (const message of messages) {
      await processIncomingMessage(connector, message);
    }
  } catch (err) {
    console.error("[scrutation boite] erreur:", err);
  }
}

async function checkRelances(connector: EmailConnector): Promise<void> {
  try {
    await runRelanceCheck(connector);
  } catch (err) {
    console.error("[verification relances] erreur:", err);
  }
}

export function startScheduler(): void {
  const connector = createEmailConnector();

  console.log(`Connecteur actif: ${connector.name}`);
  console.log(`Scrutation boite: ${config.pollIntervalCron}`);
  console.log(`Verification relances: ${config.relanceCheckCron}`);

  void pollInbox(connector);

  cron.schedule(config.pollIntervalCron, () => void pollInbox(connector));
  cron.schedule(config.relanceCheckCron, () => void checkRelances(connector));
}
