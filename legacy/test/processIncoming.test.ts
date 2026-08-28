import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EmailConnector, EmailMessage, EmailThread, NotificationParams, SendReplyParams } from "../src/types.js";

const dir = mkdtempSync(path.join(tmpdir(), "process-incoming-test-"));
process.env.DB_PATH = path.join(dir, "process-incoming.db");
process.env.CATEGORIES_CONFIG_PATH = path.resolve("config/categories.json");

const { processIncomingMessage } = await import("../src/pipeline/processIncoming.js");
const { getThreadRow, isMessageProcessed } = await import("../src/db.js");

function fakeConnector(onGetThread: () => Promise<EmailThread>): EmailConnector {
  return {
    name: "graph",
    async getOwnEmailAddress() {
      return "us@example.com";
    },
    async listRecentInboxMessages() {
      return [];
    },
    async listRecentSentMessages() {
      return [];
    },
    getThread: onGetThread,
    async sendReply(_params: SendReplyParams) {
      return { id: "sent-1" };
    },
    async createDraftReply(_params: SendReplyParams) {
      return { id: "draft-1" };
    },
    async deleteDraft() {},
    async sendNotification(_params: NotificationParams) {
      return { id: "notif-1" };
    },
    async markMessageUnread() {},
  };
}

function fakeIncomingMessage(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id: "msg-rappel-1",
    threadId: "thread-rappel-1",
    from: { email: "us@example.com" },
    to: [{ email: "us@example.com" }],
    subject: "[Rappel] Devis conteneur",
    bodyText: "Dossier en attente...",
    receivedAt: new Date(),
    isFromUs: false,
    hasAttachments: false,
    ...overrides,
  };
}

test("a self-addressed internal rappel is never treated as a new client email, even if isFromUs comes back false", async () => {
  // Regression: sendInternalNotification (relanceCheck.ts) sends "[Rappel] ..."
  // to the connected mailbox itself when NOTIFICATION_EMAIL isn't set. On some
  // providers the resulting Inbox copy has a different message id than the
  // Sent copy already marked processed there, so it reaches
  // processIncomingMessage looking like a brand-new client email — which
  // would otherwise classify it and send it an automatic accuse.
  let getThreadCalls = 0;
  const connector = fakeConnector(async () => {
    getThreadCalls++;
    throw new Error("should never be called for a [Rappel] subject");
  });

  const message = fakeIncomingMessage();
  await processIncomingMessage(connector, message);

  assert.equal(getThreadCalls, 0);
  assert.equal(getThreadRow(message.threadId), undefined);
  assert.equal(isMessageProcessed(message.id), true);
});

test("a real client email with 'rappel' elsewhere in the subject is not affected (only our exact [Rappel] prefix is filtered)", async () => {
  let getThreadCalls = 0;
  const connector = fakeConnector(async () => {
    getThreadCalls++;
    return { id: "thread-client-rappel", messages: [] };
  });

  const message = fakeIncomingMessage({
    id: "msg-client-1",
    threadId: "thread-client-rappel",
    from: { email: "client@example.com" },
    subject: "Petit rappel de ma demande précédente",
  });

  // La classification echoue sans ANTHROPIC_API_KEY dans cet environnement de
  // test — le signal utile ici est que le garde-fou NE bloque PAS ce message
  // avant meme d'atteindre la lecture du fil (getThread est bien appele).
  await assert.rejects(() => processIncomingMessage(connector, message));
  assert.equal(getThreadCalls, 1);
});
