import cron from "node-cron";
import { config } from "./config.js";
import { createEmailConnector } from "./connectors/index.js";
import { discoverOutboundOnlyThreads } from "./pipeline/discoverOutbound.js";
import { processIncomingMessage } from "./pipeline/processIncoming.js";
import { runRelanceCheck } from "./pipeline/relanceCheck.js";
import { recordPipelineError } from "./db.js";

// Un traitement d'email (classification + accuse + 3 brouillons, plusieurs
// appels Claude) peut prendre plus de temps que l'intervalle de scrutation.
// Ces verrous empechent un cycle de demarrer avant que le precedent soit
// termine - sans ca, deux cycles qui se chevauchent peuvent traiter le
// meme email deux fois avant qu'il soit marque comme traite.
let pollInProgress = false;
let relanceCheckInProgress = false;
let discoverOutboundInProgress = false;

async function pollInbox(): Promise<void> {
  if (pollInProgress) {
    console.log("[scrutation boite] cycle precedent encore en cours, on saute celui-ci.");
    return;
  }
  pollInProgress = true;
  try {
    // Resolue a chaque cycle plutot que capturee une seule fois au demarrage
    // du planificateur: sinon, connecter (ou changer de) boite via l'UI web
    // apres coup n'a aucun effet tant que le processus n'est pas redemarre —
    // le planificateur continue silencieusement de scruter l'ancienne boite.
    const connector = createEmailConnector();
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

async function checkRelances(): Promise<void> {
  if (relanceCheckInProgress) return;
  relanceCheckInProgress = true;
  try {
    await runRelanceCheck(createEmailConnector());
  } catch (err) {
    console.error("[verification relances] erreur:", err);
  } finally {
    relanceCheckInProgress = false;
  }
}

async function discoverOutbound(): Promise<void> {
  if (discoverOutboundInProgress) return;
  discoverOutboundInProgress = true;
  try {
    await discoverOutboundOnlyThreads(createEmailConnector());
  } catch (err) {
    console.error("[decouverte envois] erreur:", err);
    recordPipelineError("discover_outbound", null, (err as Error).message);
  } finally {
    discoverOutboundInProgress = false;
  }
}

export function startScheduler(): void {
  console.log(`Connecteur actif au demarrage: ${createEmailConnector().name}`);
  console.log(`Scrutation boite: ${config.pollIntervalCron}`);
  console.log(`Verification relances: ${config.relanceCheckCron}`);

  void pollInbox();
  void discoverOutbound();

  cron.schedule(config.pollIntervalCron, () => void pollInbox());
  cron.schedule(config.pollIntervalCron, () => void discoverOutbound());
  cron.schedule(config.relanceCheckCron, () => void checkRelances());
}
