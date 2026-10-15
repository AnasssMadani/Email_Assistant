import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { freshTestDb } from "./_pgTestDb.js";
import type { EmailConnector, EmailMessage, EmailThread } from "../src/types.js";

const db = await freshTestDb();
const { processIncomingMessage, ackSuppression } = await import("../src/pipeline/processIncoming.js");
const { setClientForTesting } = await import("../src/ai/client.js");

let needsHumanReply = false;
let ackBody = "Merci, nous revenons vers vous.";
setClientForTesting({
  messages: {
    async create(params: { tools?: Array<{ name: string }> }) {
      const name = params.tools?.[0]?.name;
      const input =
        name === "classify_email"
          ? { categoryId: "suivi_dossier", urgency: "normal", summary: "Test.", requiresAcknowledgement: true, needsHumanReply }
          : { subject: "Re", body: ackBody };
      return { content: [{ type: "tool_use", input }], usage: { input_tokens: 10, output_tokens: 10 } };
    },
  },
} as unknown as Anthropic);

function msg(id: string, threadId: string, over: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id,
    threadId,
    rfcMessageId: `<${id}@x>`,
    from: { email: "client@example.com" },
    to: [{ email: "info@oceanlink-global.com" }],
    subject: "Dossier 3899",
    bodyText: "Bonjour",
    receivedAt: new Date(Date.now() - 60_000),
    isFromUs: false,
    hasAttachments: false,
    ...over,
  };
}
const sent: string[] = [];
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
    async sendReply(p) {
      sent.push(p.threadId);
      return { id: "sent" };
    },
    async sendNotification() {
      return { id: "n" };
    },
  };
}

test("ackSuppression: team already replied, sensitive subject, or neither", () => {
  const incoming = msg("in", "t");
  const team = msg("team", "t", { isFromUs: true, receivedAt: new Date(Date.now() - 120_000) });
  assert.equal(ackSuppression({}, { id: "t", messages: [incoming] }, incoming, 0), undefined);
  assert.equal(ackSuppression({}, { id: "t", messages: [team, incoming] }, incoming, 0)?.code, "equipe");
  // Our own earlier automated accuse does not count as a human reply.
  assert.equal(ackSuppression({}, { id: "t", messages: [team, incoming] }, incoming, 1), undefined);
  assert.equal(ackSuppression({ needsHumanReply: true }, { id: "t", messages: [incoming] }, incoming, 0)?.code, "sensible");
});

test("a sensitive email gets no accuse but the dossier is still followed", async () => {
  needsHumanReply = true;
  const m = msg("m-pay", "t-pay");
  await processIncomingMessage(connectorFor({ id: "t-pay", messages: [m] }), m);
  const entry = (await db.listShadowLogEntries(100)).find((e) => e.threadId === "t-pay");
  assert.equal(entry?.ackSkipReason, "sensible");
  assert.equal(entry?.ackDrafted, false);
  assert.equal((await db.getThreadRow("t-pay"))?.status, "ack_sent");
  needsHumanReply = false;
});

test("no accuse when the team already replied in the thread", async () => {
  const team = msg("team-1", "t-team", { isFromUs: true, receivedAt: new Date(Date.now() - 600_000) });
  const m = msg("m-team", "t-team");
  await processIncomingMessage(connectorFor({ id: "t-team", messages: [team, m] }), m);
  const entry = (await db.listShadowLogEntries(100)).find((e) => e.threadId === "t-team");
  assert.equal(entry?.ackSkipReason, "equipe");
  assert.equal(entry?.ackDrafted, false);
});

test("a normal email still gets its accuse drafted in silent mode", async () => {
  const m = msg("m-ok", "t-ok");
  await processIncomingMessage(connectorFor({ id: "t-ok", messages: [m] }), m);
  const entry = (await db.listShadowLogEntries(100)).find((e) => e.threadId === "t-ok");
  assert.equal(entry?.ackDrafted, true);
  assert.equal(entry?.ackSkipReason, null);
  assert.equal(sent.length, 0);
});

test("a real send is refused while the brand voice still has a placeholder", async () => {
  await db.setStoredStage(1);
  ackBody = "Merci.\n\nL'equipe\n[coordonnées / site web]";
  const m = msg("m-ph", "t-ph");
  await processIncomingMessage(connectorFor({ id: "t-ph", messages: [m] }), m);
  assert.equal(sent.length, 0, "nothing sent");
  assert.equal((await db.getThreadRow("t-ph"))?.status, "ai_error");
});
