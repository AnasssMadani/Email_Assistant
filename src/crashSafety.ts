import { recordPipelineError } from "./db.js";

/**
 * Filet de securite final, a importer en tout premier par chaque point
 * d'entree (main.ts, index.ts). Depuis Node 15, une promesse rejetee sans
 * .catch() ni try/catch termine tout le process par defaut — un risque reel
 * ici car Express 4 ne redirige PAS automatiquement l'erreur d'un handler de
 * route async vers le middleware d'erreur (contrairement a une erreur
 * synchrone, qu'Express 4 rattrape nativement). Sans ce filet, une seule
 * panne passagere (base de donnees, API Claude en rupture de credits, appel
 * OAuth qui echoue) pouvait faire planter tout le service — page web ET
 * pipeline de fond — au lieu de rester une simple ligne dans le Journal.
 * Journalisation best-effort: si meme recordPipelineError echoue (ex: base
 * injoignable), le process continue quand meme plutot que de re-planter.
 */
process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  console.error("[erreur non geree] promesse rejetee sans handler:", reason);
  recordPipelineError("web_request", null, `Promesse rejetee non geree: ${message}`).catch(() => {});
});

process.on("uncaughtException", (err) => {
  console.error("[erreur non geree] exception non rattrapee:", err);
  recordPipelineError("web_request", null, `Exception non rattrapee: ${err.message}`).catch(() => {});
});
