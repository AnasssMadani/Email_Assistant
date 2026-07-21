import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EmailConnector, EmailMessage, EmailThread, NotificationParams, SendReplyParams } from "../src/types.js";

// Regression: mode carnet ("rien ne part jamais vers le client") must cover
// EVERY external relance, not just the accusé — a real deploy sent live
// "relance post-réponse" emails to real client addresses because only the
// accusé path was guarded by shadowModeEnabled, not checkPreReplyThread/
// checkPostReplyThread's external branches.
const dir = mkdtempSync(path.join(tmpdir(), "shadow-mode-relance-test-"));
process.env.DB_PATH = path.join(dir, "shadow-relance.db");
process.env.CATEGORIES_CONFIG_PATH = path.resolve("config/categories.json");
process.env.SHADOW_MODE = "true";

const { checkPreReplyThread, checkPostReplyThread } = await import("../src/pipeline/relanceCheck.js");
const {
  addThreadRelanceStep,
  getThreadRow,
  setThreadAckSent,
  setThreadHumanReplied,
  upsertThreadReceived,
} = await import("../src/db.js");

function fakeMessage(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id: "msg-1",
    threadId: "t-1",
    from: { email: "client@example.com" },
    to: [{ email: "us@example.com" }],
    subject: "Devis",
    bodyText: "Combien coute...",
    receivedAt: new Date(),
    isFromUs: false,
    hasAttachments: false,
    ...overrides,
  };
}

function fakeConnector(thread: EmailThread, onSendReply: () => void): EmailConnector {
  return {
    name: "gmail",
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
      return thread;
    },
    async sendReply(_params: SendReplyParams) {
      onSendReply();
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

test("checkPreReplyThread never sends a real external relance when shadowModeEnabled, but still advances the sequence", async () => {
  const threadId = "t-shadow-pre-reply-external";
  let sendReplyCalls = 0;

  upsertThreadReceived({
    threadId,
    subject: "Devis",
    senderEmail: "client@example.com",
    senderName: null,
    categoryId: "devis",
    urgency: "normal",
    slaMinutes: 1,
    status: "ack_sent",
    dueAt: new Date(Date.now() - 60_000).toISOString(),
  });
  setThreadAckSent(threadId);
  addThreadRelanceStep(threadId, { channel: "external", delayMinutes: 0 }, "pre_reply");

  const clientMessage = fakeMessage({ id: "m-client", threadId, isFromUs: false });
  const connector = fakeConnector({ id: threadId, messages: [clientMessage] }, () => sendReplyCalls++);

  const row = getThreadRow(threadId)!;
  await checkPreReplyThread(connector, row, { order: 1, channel: "external", delayMinutes: 0 });

  assert.equal(sendReplyCalls, 0);
  const after = getThreadRow(threadId);
  assert.equal(after?.relance_count, 1); // sequence advanced despite no real send
});

test("checkPostReplyThread never sends a real external relance when shadowModeEnabled, but still advances the sequence", async () => {
  const threadId = "t-shadow-post-reply-external";
  let sendReplyCalls = 0;

  upsertThreadReceived({
    threadId,
    subject: "Devis",
    senderEmail: "client@example.com",
    senderName: null,
    categoryId: "devis",
    urgency: "normal",
    slaMinutes: 1,
    status: "ack_sent",
    dueAt: new Date(Date.now() - 60_000).toISOString(),
  });
  setThreadHumanReplied(threadId, new Date(Date.now() - 30_000).toISOString());

  const ourReply = fakeMessage({ id: "m-our-reply", threadId, isFromUs: true, receivedAt: new Date(Date.now() - 20_000) });
  const connector = fakeConnector({ id: threadId, messages: [ourReply] }, () => sendReplyCalls++);

  const row = getThreadRow(threadId)!;
  await checkPostReplyThread(connector, row, { order: 1, channel: "external", delayMinutes: 0 });

  assert.equal(sendReplyCalls, 0);
  const after = getThreadRow(threadId);
  assert.equal(after?.post_reply_relance_count, 1); // sequence advanced despite no real send
});
