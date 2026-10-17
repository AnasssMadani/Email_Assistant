import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import type { ThreadRow } from "../src/db.js";
import type { EmailConnector, EmailMessage, EmailThread } from "../src/types.js";

// Ce fichier teste le profil metier: il est active avant la creation de la base.
process.env.CATEGORY_PROFILE_PATH = "config/category-profile.json";
const { freshTestDb } = await import("./_pgTestDb.js");
const db = await freshTestDb();
const { processIncomingMessage, ackPolicySuppression, normalizeSubject, extractReferences } = await import(
  "../src/pipeline/processIncoming.js"
);
const { checkPreReplyThread } = await import("../src/pipeline/relanceCheck.js");
const { getCategory } = await import("../src/settings.js");
const { setClientForTesting } = await import("../src/ai/client.js");

let classifyCalls = 0;
let classification: Record<string, unknown> = {};
setClientForTesting({
  messages: {
    async create(params: { tools?: Array<{ name: string }> }) {
      const name = params.tools?.[0]?.name;
      if (name === "classify_email") classifyCalls++;
      const input =
        name === "classify_email"
          ? { categoryId: "devis", urgency: "normal", summary: "Test.", requiresAcknowledgement: true, ...classification }
          : { subject: "Re", body: "Bien recu, nous revenons vers vous." };
      return { content: [{ type: "tool_use", input }], usage: { input_tokens: 10, output_tokens: 10 } };
    },
  },
} as unknown as Anthropic);

function msg(id: string, threadId: string, over: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id,
    threadId,
    rfcMessageId: `<${id}@x>`,
    from: { email: "ops@agent-one.com" },
    to: [{ email: "info@oceanlink-global.com" }],
    subject: `Sujet ${id}`,
    bodyText: "Bonjour, merci de confirmer.",
    receivedAt: new Date(Date.now() - 60_000),
    isFromUs: false,
    hasAttachments: false,
    ...over,
  };
}

function connectorFor(thread: EmailThread): EmailConnector {
  return {
    name: "imap",
    async getOwnEmailAddress() {
      return "info@oceanlink-global.com";
    },
    async listRecentInboxMessages() {
      return [];
    },
    async listRecentSentMessages() {
      return [];
    },
    async getThread() {
      return thread;
    },
    async sendReply() {
      throw new Error("aucun envoi attendu en etape 0");
    },
    async sendNotification() {
      throw new Error("aucun envoi attendu en etape 0");
    },
  };
}

async function carnet(threadId: string) {
  return (await db.listShadowLogEntries(500)).find((e) => e.threadId === threadId);
}

test("business profile: new categories, renamed labels, ack per category, untouched SLA", async () => {
  const byId = new Map((await db.listCategories()).map((c) => [c.id, c]));
  for (const id of ["nouvelle_demande", "tarif_partenaire", "documents", "facturation_paiement", "notification_transporteur", "suspect"]) {
    assert.ok(byId.has(id), `${id} exists`);
  }
  assert.equal(byId.get("devis")?.label, "Demande de cotation");
  assert.equal(byId.get("spam_newsletter")?.label, "Publicite / newsletter");
  assert.equal(byId.get("suivi_dossier")?.ackSchedule, "outside_hours");
  assert.equal(byId.get("suivi_dossier")?.acknowledgeAutomatically, true);
  assert.equal(byId.get("facturation_paiement")?.acknowledgeAutomatically, false);
  assert.equal(byId.get("reclamation")?.acknowledgeAutomatically, false);
  assert.equal(byId.get("notification_transporteur")?.internalAlertsEnabled, false);
  assert.ok(byId.get("suivi_dossier")?.description.length, "description filled");
  // New categories never relance the client by default.
  for (const id of ["nouvelle_demande", "documents", "facturation_paiement"]) {
    const { steps } = await db.getEffectiveRelanceSteps(`none-${id}`, id, "pre_reply");
    assert.ok(steps.every((s) => s.channel === "internal"), id);
    assert.deepEqual((await db.getEffectiveRelanceSteps(`none-${id}`, id, "post_reply")).steps, []);
  }
});

test("a robot sender is filed without calling the AI and never gets an accuse", async () => {
  const before = classifyCalls;
  const m = msg("robot", "t-robot", { from: { email: "mycustomerservice-noreply@cma-cgm.com" }, subject: "DO status" });
  await processIncomingMessage(connectorFor({ id: "t-robot", messages: [m] }), m);
  assert.equal(classifyCalls, before, "no AI call");
  const entry = await carnet("t-robot");
  assert.equal(entry?.ackSkipReason, "automatique");
  assert.equal(entry?.categoryId, "notification_transporteur");
  assert.equal((await db.getThreadRow("t-robot"))?.status, "skipped");
});

test("a suspicious email goes to the suspect category with no accuse", async () => {
  classification = { suspicious: true, suspicionReason: "Nom d'entreprise sans rapport avec le domaine." };
  const m = msg("phish", "t-phish", { from: { email: "sales@chinazbx.com.cn" }, subject: "LESCHACO RFQ" });
  await processIncomingMessage(connectorFor({ id: "t-phish", messages: [m] }), m);
  classification = {};
  const entry = await carnet("t-phish");
  assert.equal(entry?.categoryId, "suspect");
  assert.equal(entry?.ackSkipReason, "suspect");
  assert.equal(entry?.ackDrafted, false);
  assert.equal((await db.getThreadRow("t-phish"))?.status, "skipped");
});

test("the dossier keeps the email's own date and counts the team messages already in the thread", async () => {
  const sentAt = new Date(Date.now() - 3 * 3_600_000);
  const team = msg("team-prior", "t-prior", {
    isFromUs: true,
    from: { email: "k.khallaf@oceanlink-global.com" },
    receivedAt: new Date(sentAt.getTime() - 3_600_000),
  });
  const m = msg("in-prior", "t-prior", { receivedAt: sentAt, subject: "Booking EVLC261016273" });
  await processIncomingMessage(connectorFor({ id: "t-prior", messages: [team, m] }), m);
  const row = (await db.getThreadRow("t-prior")) as ThreadRow;
  assert.equal(new Date(row.received_at).getTime(), sentAt.getTime());
  assert.equal(row.prior_outbound_count, 1);
  assert.equal((await carnet("t-prior"))?.ackSkipReason, "equipe");

  // The team's earlier message is not a reply to this email: the dossier stays open.
  await checkPreReplyThread(connectorFor({ id: "t-prior", messages: [team, m] }), row, undefined);
  assert.equal((await db.getThreadRow("t-prior"))?.human_replied_at, null);

  // A new team message after it is.
  const reply = msg("team-new", "t-prior", {
    isFromUs: true,
    from: { email: "k.khallaf@oceanlink-global.com" },
    receivedAt: new Date(),
    bodyText: "Booking confirmé.\n\nLe 17 oct. 2026, ops a écrit :\n> Bonjour, merci de confirmer.",
  });
  await checkPreReplyThread(
    connectorFor({ id: "t-prior", messages: [team, m, reply] }),
    (await db.getThreadRow("t-prior")) as ThreadRow,
    undefined
  );
  const after = await db.getThreadRow("t-prior");
  assert.equal(after?.status, "awaiting_client_reply");
  const example = (await db.listRecentCorpusExamples(20)).find((e) => e.replyBody === "Booking confirmé.");
  assert.ok(example, "cleaned reply recorded");
  assert.equal(example?.clientAsk, "Bonjour, merci de confirmer.");
});

test("one accuse per conversation: a split thread with the same subject or reference is a duplicate", async () => {
  const first = msg("dup-1", "t-dup-1", { from: { email: "a@agent-two.com" }, subject: "RE: Booking SHPSIL26100406-08 / Casablanca" });
  await processIncomingMessage(connectorFor({ id: "t-dup-1", messages: [first] }), first);
  assert.equal((await carnet("t-dup-1"))?.ackDrafted, true);

  const sameRef = msg("dup-2", "t-dup-2", { from: { email: "b@agent-two.com" }, subject: "TR: urgent SHPSIL26100406-08" });
  await processIncomingMessage(connectorFor({ id: "t-dup-2", messages: [sameRef] }), sameRef);
  assert.equal((await carnet("t-dup-2"))?.ackSkipReason, "doublon");

  // Webmail: another person at gmail.com with the same subject is a different client.
  const g1 = msg("gm-1", "t-gm-1", { from: { email: "client.a@gmail.com" }, subject: "Demande de prix" });
  const g2 = msg("gm-2", "t-gm-2", { from: { email: "client.b@gmail.com" }, subject: "Demande de prix" });
  await processIncomingMessage(connectorFor({ id: "t-gm-1", messages: [g1] }), g1);
  await processIncomingMessage(connectorFor({ id: "t-gm-2", messages: [g2] }), g2);
  assert.equal((await carnet("t-gm-2"))?.ackDrafted, true);
});

test("outside-hours categories only acknowledge at night and on weekends", async () => {
  const category = await getCategory("suivi_dossier");
  const monday = new Date("2026-10-19T10:00:00Z"); // 11:00 a Casablanca
  const saturday = new Date("2026-10-17T10:00:00Z");
  const m1 = msg("oh-1", "t-oh-1", { from: { email: "x@agent-three.com" }, subject: "Free time", receivedAt: monday });
  assert.equal((await ackPolicySuppression(category, m1, monday))?.code, "heures_bureau");
  const m2 = msg("oh-2", "t-oh-2", { from: { email: "x@agent-four.com" }, subject: "Free time", receivedAt: saturday });
  assert.equal(await ackPolicySuppression(category, m2, saturday), undefined);
  assert.equal((await ackPolicySuppression(await getCategory("facturation_paiement"), m2, saturday))?.code, "categorie");
});

test("subject normalization and reference extraction", () => {
  assert.equal(normalizeSubject("RE: TR: Ynt: Fwd:  Booking  Tanger"), "booking tanger");
  assert.deepEqual(extractReferences("RE: BL EVLC261016273 / cntr 279853802 / Casablanca 2026"), ["EVLC261016273", "279853802"]);
  assert.deepEqual(extractReferences("Demande de cotation urgente"), []);
});
