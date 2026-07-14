import cron from "node-cron";
import { config } from "./config.js";
import { createEmailConnector } from "./connectors/index.js";
import { discoverOutboundOnlyThreads } from "./pipeline/discoverOutbound.js";
import { processIncomingMessage } from "./pipeline/processIncoming.js";
import { runRelanceCheck } from "./pipeline/relanceCheck.js";
import { recordPipelineError } from "./db.js";
import type { EmailConnector } from "./types.js";

// Un traitement d'email (classification + accuse + 3 brouillons, plusieurs
// appels Claude) peut prendre plus de temps que l'intervalle de scrutation.
// Ces verrous empechent un cycle de demarrer avant que le precedent soit
// termine - sans ca, deux cycles qui se chevauchent peuvent traiter le
// meme email deux fois avant qu'il soit marque comme traite.
let pollInProgress = false;
let relanceCheckInProgress = false;
let discoverOutboundInProgress = false;

async function pollInbox(connector: EmailConnector): Promise<void> {
  if (pollInProgress) {
    console.log("[scrutation boite] cycle precedent encore en cours, on saute celui-ci.");
    return;
  }
  pollInProgress = true;
  try {
    const messages = await connector.listRecentInboxMessages(25);
    for (const message of messages) {
      // Isole chaque message: une erreur (Claude, API email, etc.) ne doit
      // jamais empecher le traitement des messages suivants du meme cycle,
      // ni des cycles suivants si le meme message echoue de facon repetee.
      try {
        await processIncomingMessage(connector, message);
      } catch (err) {
        console.error(`[scrutation boite] erreur sur le message ${message.id}:`, err);
        recordPipelineError("process_incoming", message.threadId || null, (err as Error).message);
      }
    }
  } catch (err) {
    console.error("[scrutation boite] erreur:", err);
    recordPipelineError("process_incoming", null, (err as Error).message);
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

async function discoverOutbound(connector: EmailConnector): Promise<void> {
  if (discoverOutboundInProgress) return;
  discoverOutboundInProgress = true;
  try {
    await discoverOutboundOnlyThreads(connector);
  } catch (err) {
    console.error("[decouverte envois] erreur:", err);
    recordPipelineError("discover_outbound", null, (err as Error).message);
  } finally {
    discoverOutboundInProgress = false;
  }
}

export function startScheduler(): void {
  const connector = createEmailConnector();

  console.log(`Connecteur actif: ${connector.name}`);
  console.log(`Scrutation boite: ${config.pollIntervalCron}`);
  console.log(`Verification relances: ${config.relanceCheckCron}`);

  void pollInbox(connector);
  void discoverOutbound(connector);

  cron.schedule(config.pollIntervalCron, () => void pollInbox(connector));
  cron.schedule(config.pollIntervalCron, () => void discoverOutbound(connector));
  cron.schedule(config.relanceCheckCron, () => void checkRelances(connector));
}
