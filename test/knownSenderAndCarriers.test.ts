import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import type { EmailConnector, EmailMessage, EmailThread } from "../src/types.js";

process.env.CATEGORY_PROFILE_PATH = "config/category-profile.json";
const { freshTestDb } = await import("./_pgTestDb.js");
const db = await freshTestDb();
const { processIncomingMessage, ackPolicySuppression } = await import("../src/pipeline/processIncoming.js");
const { getCategory } = await import("../src/settings.js");
const { setClientForTesting } = await import("../src/ai/client.js");
const { isAutomatedMessage } = await import("../src/pipeline/automatedSender.js");
const { emailInDomains } = await import("../src/utils.js");

let classification: Record<string, unknown> = {};
let lastClassifierSystem = "";
setClientForTesting({
  messages: {
    async create(params: { system?: string; tools?: Array<{ name: string }> }) {
      const name = params.tools?.[0]?.name;
      if (name === "classify_email") lastClassifierSystem = String(params.system ?? "");
      const input =
        name === "classify_email"
          ? { categoryId: "suivi_dossier", urgency: "normal", summary: "Test.", requiresAcknowledgement: true, ...classification }
          : { subject: "Re", body: "Bien recu." };
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
    bodyText: "Bonjour, merci de valider en urgence.",
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
  } as unknown as EmailConnector;
}

async function carnet(threadId: string) {
  return (await db.listShadowLogEntries(500)).find((e) => e.threadId === threadId);
}

test("an unknown sender flagged suspicious is filed as suspect and not followed", async () => {
  classification = { suspicious: true, suspicionReason: "Demande urgente sans contexte." };
  const m = msg("unk-1", "t-unk-1", { from: { email: "sales@stranger-corp.com" } });
  await processIncomingMessage(connectorFor({ id: "t-unk-1", messages: [m] }), m);
  classification = {};
  assert.equal((await carnet("t-unk-1"))?.categoryId, "suspect");
  assert.equal((await db.getThreadRow("t-unk-1"))?.status, "skipped");
  assert.match(lastClassifierSystem, /deja ecrit 0 fois/);
});

test("a known partner flagged suspicious keeps its real category, is followed, and gets no accuse", async () => {
  // History: the team already answered a thread from this domain.
  const earlier = msg("kn-0", "t-kn-0", { from: { email: "boss@vellmann.example" }, subject: "Demande de prix" });
  await processIncomingMessage(connectorFor({ id: "t-kn-0", messages: [earlier] }), earlier);
  await db.setThreadHumanReplied("t-kn-0");

  classification = { suspicious: true, suspicionReason: "Demande urgente courte." };
  const m = msg("kn-1", "t-kn-1", { from: { email: "other@vellmann.example" }, subject: "Validation de dossier" });
  await processIncomingMessage(connectorFor({ id: "t-kn-1", messages: [m] }), m);
  classification = {};

  const entry = await carnet("t-kn-1");
  assert.equal(entry?.categoryId, "suivi_dossier", "not hidden in Suspect");
  assert.equal(entry?.ackSkipReason, "suspect");
  assert.equal(entry?.ackDrafted, false);
  const row = await db.getThreadRow("t-kn-1");
  assert.equal(row?.status, "ack_sent", "followed: the team gets a reminder if nobody answers");
  assert.ok(row?.due_at);
  assert.match(lastClassifierSystem, /correspondant connu/);
});

test("the classifier is told when our team already wrote in the conversation", async () => {
  const team = msg("ctx-team", "t-ctx", { isFromUs: true, from: { email: "k@oceanlink-global.com" }, receivedAt: new Date(Date.now() - 3_600_000) });
  const m = msg("ctx-in", "t-ctx", { from: { email: "rates@agent-five.com" }, subject: "Re: Quotation Request" });
  await processIncomingMessage(connectorFor({ id: "t-ctx", messages: [team, m] }), m);
  assert.match(lastClassifierSystem, /deja ecrit 1 message\(s\) dans cette conversation/);
  assert.match(lastClassifierSystem, /tarif_partenaire/);
});

test("carrier domains never get an accuse but stay followed; other partners do", async () => {
  const category = await getCategory("documents");
  const carrier = msg("car-1", "t-car-1", { from: { email: "gscmrc@coscon.com" } });
  assert.equal((await ackPolicySuppression(category, carrier, new Date("2026-10-17T10:00:00Z")))?.code, "armateur");
  const sub = msg("car-2", "t-car-2", { from: { email: "billing@service.hlag.com" } });
  assert.equal((await ackPolicySuppression(category, sub, new Date("2026-10-17T10:00:00Z")))?.code, "armateur");
  const partner = msg("car-3", "t-car-3", { from: { email: "ops@bwlturkey.com" } });
  assert.equal(await ackPolicySuppression(category, partner, new Date("2026-10-17T10:00:00Z")), undefined);

  await processIncomingMessage(connectorFor({ id: "t-car-4", messages: [] }), msg("car-4", "t-car-4", { from: { email: "gscmrc@coscon.com" }, receivedAt: new Date("2026-10-17T10:00:00Z") }));
  assert.equal((await carnet("t-car-4"))?.ackDrafted, false);
});

test("Portnet is treated as a robot even without a noreply address", () => {
  assert.equal(isAutomatedMessage(msg("p", "t-p", { from: { email: "gu@portnet.ma" } })), true);
  assert.equal(isAutomatedMessage(msg("q", "t-q", { from: { email: "chef@portnet.com" } })), false);
  assert.equal(emailInDomains("a@service.hlag.com", ["hlag.com"]), true);
  assert.equal(emailInDomains("a@nothlag.com", ["hlag.com"]), false);
});
