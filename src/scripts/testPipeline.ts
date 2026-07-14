import { classifyEmail } from "../ai/classify.js";
import { draftAcknowledgement } from "../ai/draftAcknowledgement.js";
import { draftThreeReplies } from "../ai/draftReplies.js";
import { getCategory } from "../settings.js";
import type { EmailMessage, EmailThread } from "../types.js";

/**
 * Teste la couche IA (classification, accuse de reception, 3 brouillons)
 * sur un email d'exemple, sans avoir besoin de credentials Gmail/Outlook.
 * Necessite uniquement ANTHROPIC_API_KEY dans .env.
 *
 *   npm run test:pipeline
 */
const sample: EmailMessage = {
  id: "sample-1",
  threadId: "sample-thread-1",
  rfcMessageId: "<sample-1@example.com>",
  from: { name: "Julie Marchand", email: "julie.marchand@example.com" },
  to: [{ email: "contact@client.example" }],
  subject: "Demande de devis — refonte de notre site vitrine",
  bodyText: [
    "Bonjour,",
    "",
    "Nous sommes une PME de 12 personnes dans le secteur du batiment et nous",
    "cherchons a refaire notre site vitrine, qui date de 2015. Nous aimerions",
    "un devis pour une refonte complete incluant un formulaire de contact et",
    "une page dediee a nos realisations.",
    "",
    "Pourriez-vous nous indiquer vos disponibilites pour un premier echange ?",
    "",
    "Cordialement,",
    "Julie Marchand",
    "Directrice, Batiment Marchand SAS",
  ].join("\n"),
  receivedAt: new Date(),
  isFromUs: false,
  hasAttachments: false,
};

const thread: EmailThread = { id: sample.threadId, messages: [sample] };

async function main(): Promise<void> {
  console.log("=== 1. Classification ===");
  const classification = await classifyEmail(thread, sample);
  console.log(classification);

  const category = getCategory(classification.categoryId);
  console.log(
    `\nCategorie resolue: ${category.label} (SLA ${category.slaHours}h, accuse auto: ${category.acknowledgeAutomatically})`
  );

  if (!category.acknowledgeAutomatically || !classification.requiresAcknowledgement) {
    console.log("\nCet email ne declencherait pas d'accuse de reception automatique.");
    return;
  }

  console.log("\n=== 2. Accuse de reception (envoye automatiquement) ===");
  const ack = await draftAcknowledgement(thread, sample, category);
  console.log(`Objet: ${ack.subject}\n\n${ack.body}`);

  console.log("\n=== 3. Trois brouillons de reponse (deposes en brouillon) ===");
  const replies = await draftThreeReplies(thread, sample, category);
  for (const reply of replies) {
    console.log(`\n--- Variante ${reply.variant}: ${reply.label} ---`);
    console.log(`Objet: ${reply.subject}\n\n${reply.body}`);
  }
}

main().catch((err) => {
  console.error("Erreur:", err);
  process.exit(1);
});
