import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { CLAUDE_MODEL, getClient } from "./client.js";
import { recordUsage, withRetry } from "./structured.js";
import { loadBrandVoice } from "../config.js";
import { formatSingleMessage, LANGUAGE_INSTRUCTION } from "./prompts.js";
import type { CategoryConfig, EmailMessage, EmailThread } from "../types.js";

export interface RelanceDraft {
  subject: string;
  body: string;
}

/**
 * "pre_reply": personne chez nous n'a encore repondu de fond au client —
 * relance qui rassure ("toujours en cours de traitement"). "post_reply":
 * un humain a deja envoye une reponse de fond (ex: le devis) et le client
 * reste silencieux — relance qui fait un suivi sur cette reponse precise.
 */
export type RelancePhase = "pre_reply" | "post_reply";

const relanceSchema = z.object({
  subject: z.string().min(1),
  body: z.string().min(1),
});

export async function draftRelance(
  thread: EmailThread,
  anchorMessage: EmailMessage,
  category: CategoryConfig,
  phase: RelancePhase = "pre_reply",
  hadAttachment = false
): Promise<RelanceDraft> {
  return withRetry(
    () => draftRelanceOnce(thread, anchorMessage, category, phase, hadAttachment),
    phase === "post_reply" ? "relance post-réponse" : "relance"
  );
}

async function draftRelanceOnce(
  thread: EmailThread,
  anchorMessage: EmailMessage,
  category: CategoryConfig,
  phase: RelancePhase,
  hadAttachment: boolean
): Promise<RelanceDraft> {
  const client = getClient();
  const brandVoice = loadBrandVoice();

  const tool: Anthropic.Tool = {
    name: "write_relance",
    description: "Redige un email de relance courtois pour un dossier reste sans reponse.",
    input_schema: {
      type: "object",
      properties: {
        subject: { type: "string" },
        body: { type: "string" },
      },
      required: ["subject", "body"],
    },
  };

  const system =
    phase === "post_reply"
      ? [
          "Tu rediges un email de relance, pour un client qui n'a pas repondu",
          "a notre reponse de fond precedente (ex: un devis envoye).",
          "",
          "IMPORTANT: le message affiche ci-dessous comme \"Nouveau message a traiter\" est",
          "NOTRE PROPRE dernier message envoye au client, pas le sien. Ne redige pas une",
          "reponse a ce message: redige une relance A SON SUJET, adressee au client, qui",
          "fait suite a ce que nous lui avons deja envoye.",
          "",
          LANGUAGE_INSTRUCTION,
          "",
          brandVoice,
          "",
          "Regles:",
          "- Ton courtois, jamais insistant ni culpabilisant.",
          "- Ne t'appuie que sur le contenu reel du message affiche ci-dessous comme",
          "  \"Nouveau message a traiter\" (notre propre dernier envoi) pour decrire ce que",
          "  nous avons deja transmis au client. N'affirme jamais qu'un devis, un prix ou",
          "  une information detaillee a ete envoye si ce message ne le montre pas",
          "  explicitement — un simple accuse de reception n'est PAS une reponse de fond,",
          "  ne le presente jamais comme tel.",
          "- Rappelle brievement l'objet de notre reponse precedente (ex: le devis envoye),",
          "  sans en repeter le contenu detaille.",
          "- Demande si le client a des questions ou une decision a partager, sans mettre",
          "  la pression ni fixer d'ultimatum.",
          `- Cette demande relevait de la categorie "${category.label}".`,
          ...(hadAttachment
            ? [
                "- Notre reponse precedente contenait une piece jointe (ex: grille tarifaire en PDF):",
                "  mentionne explicitement qu'un document etait joint a ce message et invite le",
                "  client a le consulter s'il ne l'a pas encore vu — sans decrire ni inventer son",
                "  contenu, que tu ne connais pas.",
              ]
            : []),
        ].join("\n")
      : (() => {
          // pre_reply: on met en avant notre dernier message envoye (accuse ou
          // relance precedente) pour que chaque relance assure une continuite
          // naturelle plutot que de repartir de zero a chaque fois.
          const lastOutbound = [...thread.messages].reverse().find((m) => m.isFromUs);
          const continuityBlock = lastOutbound
            ? [
                "",
                "Notre dernier message envoye a ce demandeur dans ce fil (a ne pas repeter mot",
                "pour mot, mais dont tu dois assurer la continuite naturelle — ne pas",
                "redemander une information deja demandee ici, ne pas repeter une promesse",
                "deja faite):",
                `"""${lastOutbound.bodyText.slice(0, 2000)}"""`,
              ]
            : [];
          return [
            "Tu rediges un email de relance, pour un dossier client reste sans",
            "reponse malgre l'accuse de reception deja envoye.",
            "",
            LANGUAGE_INSTRUCTION,
            "",
            brandVoice,
            "",
            "Regles:",
            "- Ton courtois, jamais culpabilisant envers le destinataire.",
            "- Rappelle brievement l'objet de la demande initiale.",
            "- Indique que le dossier est toujours en cours de traitement.",
            "- Ne promets pas de nouveau delai precis s'il n'est pas confirme.",
            "- Le retard est de notre cote, jamais du sien: ne dis jamais que nous",
            "  attendons une reponse, une precision ou une information de sa part,",
            "  sauf si notre dernier message (fourni ci-dessous) le demande",
            "  explicitement mot pour mot. Par defaut, personne ne lui a rien",
            "  demande — n'invente aucune question, precision ou echange qui ne",
            "  figure pas litteralement dans ce message.",
            `- Cette demande relevait de la categorie "${category.label}".`,
            ...continuityBlock,
          ].join("\n");
        })();

  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 700,
    system,
    tools: [tool],
    tool_choice: { type: "tool", name: "write_relance" },
    messages: [{ role: "user", content: formatSingleMessage(anchorMessage) }],
  });
  recordUsage(phase === "post_reply" ? "relance_post_reponse" : "relance_pre_reponse", thread.id, response.usage);

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
  );
  if (!toolUse) {
    throw new Error("Claude n'a pas retourne de relance structuree.");
  }
  return relanceSchema.parse(toolUse.input);
}
