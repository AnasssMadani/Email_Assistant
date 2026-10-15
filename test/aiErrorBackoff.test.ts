import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { freshTestDb } from "./_pgTestDb.js";
import type { EmailConnector, EmailMessage } from "../src/types.js";

const { getThreadRow, isMessageProcessed, listPipelineErrors, listRemindersForThread } = await freshTestDb();
const { processIncomingMessage } = await import("../src/pipeline/processIncoming.js");
const { setClientForTesting } = await import("../src/ai/client.js");
const { config } = await import("../src/config.js");

let aiCalls = 0;
let aiWorks = false;
setClientForTesting({
  messages: {
    async create() {
      aiCalls++;
      if (!aiWorks) throw new Error("401 invalid x-api-key");
      return {
        content: [{ type: "tool_use", input: { categoryId: "autre", urgency: "normal", summary: "Test.", requiresAcknowledgement: false } }],
        usage: { input_tokens: 10, output_tokens: 10 },
      };
    },
  },
} as unknown as Anthropic);

let getThreadCalls = 0;
const message: EmailMessage = {
  id: "m-ai-1",
  threadId: "t-ai-1",
  from: { email: "client@example.com" },
  to: [{ email: "us@example.com" }],
  subject: "Demande de devis",
  bodyText: "Bonjour, un devis svp.",
  receivedAt: new Date(),
  isFromUs: false,
  hasAttachments: false,
};
const connector: EmailConnector = {
  name: "imap",
  async getOwnEmailAddress() {
    return "us@example.com";
  },
  async listRecentInboxMessages() {
    return [];
  },
  async listRecentSentMessages() {
    return [];
  },
  async getThread() {
    getThreadCalls++;
    return { id: message.threadId, messages: [message] };
  },
  async sendReply() {
    return { id: "sent" };
  },
  async sendNotification() {
    return { id: "notif" };
  },
};

async function traces() {
  const errors = (await listPipelineErrors(1000)).filter((e) => e.thread_id === message.threadId);
  const reminders = await listRemindersForThread(message.threadId);
  return { errors: errors.length, reminders: reminders.length };
}

test("a failing AI leaves one trace, then pauses retries during the backoff", async () => {
  config.aiRetryBackoffMinutes = 15;

  await processIncomingMessage(connector, message);
  assert.equal((await getThreadRow(message.threadId))?.status, "ai_error");
  assert.equal(await isMessageProcessed(message.id), false);
  assert.deepEqual(await traces(), { errors: 1, reminders: 1 });
  const callsAfterFirst = aiCalls;
  const threadCallsAfterFirst = getThreadCalls;

  // Next polling cycles inside the backoff: no AI call, no mailbox read, no new rows.
  await processIncomingMessage(connector, message);
  await processIncomingMessage(connector, message);
  assert.equal(aiCalls, callsAfterFirst);
  assert.equal(getThreadCalls, threadCallsAfterFirst);
  assert.deepEqual(await traces(), { errors: 1, reminders: 1 });
});

test("after the backoff the email is retried, still without duplicating the trace", async () => {
  config.aiRetryBackoffMinutes = 0;
  const before = aiCalls;

  await processIncomingMessage(connector, message);
  assert.ok(aiCalls > before);
  assert.equal((await getThreadRow(message.threadId))?.status, "ai_error");
  assert.equal(await isMessageProcessed(message.id), false);
  assert.deepEqual(await traces(), { errors: 1, reminders: 1 });
});

test("once the AI answers again the dossier leaves the error state", async () => {
  config.aiRetryBackoffMinutes = 0;
  aiWorks = true;

  await processIncomingMessage(connector, message);
  assert.notEqual((await getThreadRow(message.threadId))?.status, "ai_error");
  assert.equal(await isMessageProcessed(message.id), true);
});
