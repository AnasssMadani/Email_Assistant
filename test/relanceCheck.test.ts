import "./_settingsEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPreReplyThread, checkPostReplyThread } from "../src/pipeline/relanceCheck.js";
import {
  addThreadRelanceStep,
  getThreadRow,
  incrementPostReplyRelance,
  incrementRelance,
  markBodySentByAutomation,
  markMessageIdSentByAutomation,
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

test("checkPreReplyThread does not mistake its own already-sent relance for a human reply", async () => {
  // Regression: observed live — a pre-reply relance was sent, then on the
  // very next check cycle the system found that SAME relance in the
  // refetched thread (isFromUs, timestamped after ack_sent_at) and treated
  // it as "a human answered the client", flipping the dossier into
  // post-reply and firing a second, unwarranted relance about a reply that
  // never happened.
  const threadId = "t-self-relance-not-a-reply";
  const ackSentAt = new Date(Date.now() - 5 * 60_000).toISOString();
  const relanceBody = "Nous vous informons que votre dossier est toujours en cours de traitement.";

  upsertThreadReceived({
    threadId,
    subject: "Devis",
    senderEmail: "client@example.com",
    senderName: null,
    categoryId: "devis",
    urgency: "normal",
    slaMinutes: 1,
    status: "ack_sent",
    dueAt: new Date(Date.now() - 4 * 60_000).toISOString(),
  });
  setThreadAckSent(threadId);
  // Simule ce que checkPreReplyThread fait lui-meme apres avoir envoye la
  // relance: marquer son propre corps comme automatique pour ce dossier.
  markBodySentByAutomation(threadId, relanceBody);
  addThreadRelanceStep(threadId, { channel: "internal", delayMinutes: 0 }, "pre_reply");
  incrementRelance(threadId, "relance_sent");

  const clientMessage = fakeMessage({ id: "m-client", threadId, isFromUs: false });
  const ourOwnRelanceRefetched = fakeMessage({
    id: "m-relance",
    threadId,
    isFromUs: true,
    receivedAt: new Date(Date.now() - 60_000),
    bodyText: relanceBody,
  });
  const connector = fakeConnector({ id: threadId, messages: [clientMessage, ourOwnRelanceRefetched] });

  await checkPreReplyThread(connector, getThreadRow(threadId) as ThreadRow, undefined);

  const row = getThreadRow(threadId);
  // Ne doit PAS avoir bascule en post-reponse: aucune reponse humaine reelle.
  assert.notEqual(row?.status, "awaiting_client_reply");
  assert.equal(row?.human_replied_at, null);
});

test("checkPreReplyThread recognizes its own send by message id even when the re-fetched body text differs", async () => {
  // The body-hash check is a fallback for connectors (Graph) that don't
  // preserve message ids across send/refetch — but on Gmail specifically,
  // the id IS reliable, and must be enough on its own even if the body text
  // ends up slightly different after the MIME round-trip (line-ending
  // normalization, encoding quirks, etc.), which is exactly the gap that
  // let an acknowledgement slip through as "a human reply" in production.
  const threadId = "t-self-ack-detected-by-id-only";
  const sentAckId = "gmail-ack-message-id-123";

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
  markMessageIdSentByAutomation(threadId, sentAckId);

  const clientMessage = fakeMessage({ id: "m-client", threadId, isFromUs: false });
  const ackRefetchedWithDifferentWhitespace = fakeMessage({
    id: sentAckId,
    threadId,
    isFromUs: true,
    receivedAt: new Date(),
    // Deliberately NOT identical to whatever was hashed at send time —
    // proves the id match alone is sufficient, independent of the body.
    bodyText: "Bonjour,\r\n\r\nNous avons bien reçu votre message.\r\n\r\n",
  });
  const connector = fakeConnector({ id: threadId, messages: [clientMessage, ackRefetchedWithDifferentWhitespace] });

  await checkPreReplyThread(connector, getThreadRow(threadId) as ThreadRow, undefined);

  const row = getThreadRow(threadId);
  assert.notEqual(row?.status, "awaiting_client_reply");
  assert.equal(row?.human_replied_at, null);
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
