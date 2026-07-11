import cron from "node-cron";
import { config } from "./config.js";
import { createEmailConnector } from "./connectors/index.js";
import { processIncomingMessage } from "./pipeline/processIncoming.js";
import { runRelanceCheck } from "./pipeline/relanceCheck.js";
import type { EmailConnector } from "./types.js";

// Un traitement d'email (classification + accuse + 3 brouillons, plusieurs
// appels Claude) peut prendre plus de temps que l'intervalle de scrutation.
// Ces verrous empechent un cycle de demarrer avant que le precedent soit
// termine - sans ca, deux cycles qui se chevauchent peuvent traiter le
// meme email deux fois avant qu'il soit marque comme traite.
let pollInProgress = false;
let relanceCheckInProgress = false;

async function pollInbox(connector: EmailConnector): Promise<void> {
  if (pollInProgress) {
    console.log("[scrutation boite] cycle precedent encore en cours, on saute celui-ci.");
    return;
  }
  pollInProgress = true;
  try {
    const messages = await connector.listRecentInboxMessages(25);
    for (const message of messages) {
      await processIncomingMessage(connector, message);
    }
  } catch (err) {
    console.error("[scrutation boite] erreur:", err);
  } finally {
    pollInProgress = false;
  }
}

async function checkRelances(connector: EmailConnector): Promise<void> {
  if (relanceCheckInProgress) return;
  relanceCheckInProgress = true;
  try {
    await runRelanceCheck(connector);
  } catch (err) {
    console.error("[verification relances] erreur:", err);
  } finally {
    relanceCheckInProgress = false;
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
