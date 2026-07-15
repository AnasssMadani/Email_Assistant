import "./_settingsEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPreReplyThread, checkPostReplyThread } from "../src/pipeline/relanceCheck.js";
import {
  addThreadRelanceStep,
  getThreadRow,
  incrementPostReplyRelance,
  incrementRelance,
  setThreadAckSent,
  setThreadHumanReplied,
  upsertThreadReceived,
  type ThreadRow,
} from "../src/db.js";
import type { EmailConnector, EmailMessage, EmailThread, NotificationParams, SendReplyParams } from "../src/types.js";

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

function fakeConnector(thread: EmailThread): EmailConnector {
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
      return { id: "sent-1" };
    },
    async createDraftReply(_params: SendReplyParams) {
      return { id: "draft-1" };
    },
    async deleteDraft() {},
    async sendNotification(_params: NotificationParams) {
      return { id: "notif-1" };
    },
  };
}

test("checkPreReplyThread still detects a human reply after the pre-reply sequence is exhausted (step=undefined)", async () => {
  const threadId = "t-exhausted-pre-reply";
  const ackSentAt = new Date(Date.now() - 60_000).toISOString();

  upsertThreadReceived({
    threadId,
    subject: "Devis",
    senderEmail: "client@example.com",
    senderName: null,
    categoryId: "devis",
    urgency: "normal",
    slaMinutes: 1,
    status: "ack_sent",
    dueAt: new Date(Date.now() - 30_000).toISOString(),
  });
  setThreadAckSent(threadId);
  // Sequence a une seule etape, deja consommee (relance_count=1 >= steps.length):
  // reproduit exactement l'etat "sequence epuisee" observe en production.
  addThreadRelanceStep(threadId, { channel: "internal", delayMinutes: 0 }, "pre_reply");
  incrementRelance(threadId, "relance_sent");

  const clientMessage = fakeMessage({ id: "m-client", threadId, isFromUs: false });
  const ourRealReply = fakeMessage({
    id: "m-reply",
    threadId,
    isFromUs: true,
    receivedAt: new Date(),
    bodyText: "Voici votre devis en piece jointe.",
  });
  const connector = fakeConnector({ id: threadId, messages: [clientMessage, ourRealReply] });

  // Avant le correctif, cette fonction exigeait un RelanceStep concret et
  // n'etait jamais appelee du tout une fois la sequence epuisee — la reponse
  // humaine n'etait donc jamais detectee.
  await checkPreReplyThread(connector, getThreadRow(threadId) as ThreadRow, undefined);

  const row = getThreadRow(threadId);
  assert.equal(row?.status, "awaiting_client_reply");
  assert.ok(row?.human_replied_at);
});

test("checkPostReplyThread still detects the client's reply after the post-reply sequence is exhausted (step=undefined)", async () => {
  const threadId = "t-exhausted-post-reply";
  const humanRepliedAt = new Date(Date.now() - 60_000).toISOString();

  upsertThreadReceived({
    threadId,
    subject: "Devis",
    senderEmail: "client@example.com",
    senderName: null,
    categoryId: "devis",
    urgency: "normal",
    slaMinutes: 1,
    status: "ack_sent",
    dueAt: new Date(Date.now() - 30_000).toISOString(),
  });
  setThreadHumanReplied(threadId, humanRepliedAt);
  incrementPostReplyRelance(threadId, "relance_sent");

  const ourReply = fakeMessage({ id: "m-our-reply", threadId, isFromUs: true, receivedAt: new Date(Date.now() - 55_000) });
  const clientFinallyReplied = fakeMessage({
    id: "m-client-reply",
    threadId,
    isFromUs: false,
    receivedAt: new Date(),
    bodyText: "Merci, ca me convient.",
  });
  const connector = fakeConnector({ id: threadId, messages: [ourReply, clientFinallyReplied] });

  await checkPostReplyThread(connector, getThreadRow(threadId) as ThreadRow, undefined);

  const row = getThreadRow(threadId);
  assert.equal(row?.status, "responded");
});
