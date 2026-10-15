import { config } from "./config.js";
import { getStoredStage, setStoredStage } from "./db.js";

/**
 * Etape d'activation du deploiement — remplace l'ancienne variable
 * d'environnement SHADOW_MODE. Stockee en base, basculee a la main depuis
 * /etape (jamais de bascule automatique).
 *
 * POINT D'ENTREE UNIQUE pour savoir si un envoi a le droit de partir: tout
 * chemin qui ecrit vers l'exterieur (accuse, relance, rappel interne,
 * rapport du matin, brouillon, reponse directe) doit appeler
 * isSendAllowed(<action>) juste avant l'envoi, plutot que de comparer
 * l'etape lui-meme.
 *
 * Fail-closed: toute erreur de lecture (base indisponible, valeur
 * corrompue) est traitee comme l'etape 0 — un doute ne doit jamais
 * declencher un envoi.
 */
export type Stage = 0 | 1 | 2 | 3;

export const STAGES: ReadonlyArray<{ stage: Stage; label: string; description: string }> = [
  {
    stage: 0,
    label: "Silencieux",
    description:
      "Rien n'est envoyé. L'IA lit, classe et crée les catégories ; accusés et relances sont rédigés et visibles dans le back-office seulement.",
  },
  {
    stage: 1,
    label: "Envoi réel",
    description:
      "Les accusés, les relances et les rappels à l'équipe partent vraiment. Le rapport du matin peut être activé en envoi.",
  },
  {
    stage: 2,
    label: "Brouillons",
    description: "En plus de l'étape 1, l'IA dépose des brouillons de réponse pour l'équipe.",
  },
  {
    stage: 3,
    label: "Réponse directe",
    description:
      "En plus de l'étape 2, l'IA répond seule sur les petites catégories ; les sujets importants restent à un humain.",
  },
];

/**
 * Chaque type d'envoi et l'etape minimale a partir de laquelle il part
 * reellement. "rapport_matin" garde en plus son propre interrupteur
 * d'envoi; "brouillon" et "reponse_directe" n'ont pas encore de chemin
 * d'envoi dans le code: ils sont declares ici pour que ces fonctionnalites
 * se branchent sur le meme garde-fou des leur arrivee.
 */
export type SendAction =
  | "accuse"
  | "relance_externe"
  | "rappel_interne"
  | "rapport_matin"
  | "brouillon"
  | "reponse_directe";

const MINIMUM_STAGE: Record<SendAction, Stage> = {
  accuse: 1,
  relance_externe: 1,
  rappel_interne: 1,
  rapport_matin: 1,
  brouillon: 2,
  reponse_directe: 3,
};

export function minimumStageFor(action: SendAction): Stage {
  return MINIMUM_STAGE[action];
}

export function isStage(value: unknown): value is Stage {
  return value === 0 || value === 1 || value === 2 || value === 3;
}

let lastKnownStage: Stage = 0;

/** Etape effective: celle choisie dans /etape, plafonnee par MAX_STAGE. */
export async function getStage(): Promise<Stage> {
  let effective: Stage = 0;
  try {
    const { stage } = await getStoredStage();
    effective = isStage(stage) ? (Math.min(stage, config.maxStage) as Stage) : 0;
  } catch (err) {
    console.error("[etape] lecture impossible, etape 0 (silencieux) appliquee par securite:", err);
    effective = 0;
  }
  lastKnownStage = effective;
  return effective;
}

/**
 * Derniere etape lue par getStage(), pour un affichage synchrone (bandeau
 * du back-office). Ne jamais s'en servir pour decider d'un envoi.
 */
export function getLastKnownStage(): Stage {
  return lastKnownStage;
}

export async function isSendAllowed(action: SendAction): Promise<boolean> {
  return (await getStage()) >= MINIMUM_STAGE[action];
}

/**
 * Changement d'etape depuis le back-office. Monter se fait d'une etape a
 * la fois (0 -> 1 -> 2 -> 3), pour qu'aucun clic ne saute une periode de
 * validation ; descendre est toujours permis, d'un coup, jusqu'a 0.
 */
export async function changeStage(target: Stage): Promise<void> {
  if (!isStage(target)) throw new Error("Étape inconnue.");
  if (target > config.maxStage) {
    throw new Error(`Ce déploiement est verrouillé à l'étape ${config.maxStage} maximum (variable MAX_STAGE).`);
  }
  const current = await getStage();
  if (target > current + 1) {
    throw new Error(`Passez d'abord par l'étape ${current + 1} : on monte d'une étape à la fois.`);
  }
  await setStoredStage(target);
  lastKnownStage = target;
}
