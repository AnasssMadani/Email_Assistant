import "./_settingsEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPreReplyThread, checkPostReplyThread } from "../src/pipeline/relanceCheck.js";
import {
  addThreadRelanceStep,
  getThreadRow,
  incrementAutomatedOutboundCount,
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
    async markMessageUnread() {},
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

test("checkPreReplyThread does not mistake its own already-sent ack/relance for a human reply, regardless of exact text", async () => {
  // Regression: two prior approaches (exact body hash, then message id)
  // both still failed live — Gmail/Graph can alter the text or id of a
  // sent message between send and re-fetch (line endings, encoding,
  // Graph's draft-vs-sent id mismatch), so either signal could silently
  // miss a match and let our own ack/relance be treated as "the human
  // replied", prematurely flipping the dossier into post-reply and firing
  // an unwarranted second relance about a reply that never happened.
  // Counting sidesteps this entirely: it never inspects content or id at
  // all, so no round-trip alteration can break it. Two automated sends
  // (ack + one relance) are simulated here, with a re-fetched thread whose
  // isFromUs message text/ids don't match anything we "remember" sending —
  // on the old approaches this would have false-positived.
  const threadId = "t-self-sends-not-a-reply";

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
  incrementAutomatedOutboundCount(threadId); // the ack
  addThreadRelanceStep(threadId, { channel: "internal", delayMinutes: 0 }, "pre_reply");
  incrementRelance(threadId, "relance_sent");
  incrementAutomatedOutboundCount(threadId); // the pre-reply relance

  const clientMessage = fakeMessage({ id: "m-client", threadId, isFromUs: false });
  const ourAckRefetched = fakeMessage({
    id: "ack-id-as-seen-on-refetch",
    threadId,
    isFromUs: true,
    receivedAt: new Date(Date.now() - 90_000),
    bodyText: "Bonjour,\r\n\r\nNous avons bien reçu votre message.\r\n\r\n",
  });
  const ourRelanceRefetched = fakeMessage({
    id: "relance-id-as-seen-on-refetch",
    threadId,
    isFromUs: true,
    receivedAt: new Date(Date.now() - 60_000),
    bodyText: "Votre dossier est toujours en cours de traitement.",
  });
  const connector = fakeConnector({
    id: threadId,
    messages: [clientMessage, ourAckRefetched, ourRelanceRefetched],
  });

  await checkPreReplyThread(connector, getThreadRow(threadId) as ThreadRow, undefined);

  const row = getThreadRow(threadId);
  // Ne doit PAS avoir bascule en post-reponse: aucune reponse humaine reelle,
  // seulement 2 messages isFromUs, exactement le nombre qu'on sait avoir envoye.
  assert.notEqual(row?.status, "awaiting_client_reply");
  assert.equal(row?.human_replied_at, null);
});

test("checkPreReplyThread detects a genuine human reply even after several automated sends", async () => {
  const threadId = "t-real-reply-after-automated-sends";

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
  incrementAutomatedOutboundCount(threadId); // the ack
  addThreadRelanceStep(threadId, { channel: "internal", delayMinutes: 0 }, "pre_reply");
  incrementRelance(threadId, "relance_sent");
  incrementAutomatedOutboundCount(threadId); // the pre-reply relance

  const clientMessage = fakeMessage({ id: "m-client", threadId, isFromUs: false });
  const ourAck = fakeMessage({ id: "m-ack", threadId, isFromUs: true, receivedAt: new Date(Date.now() - 120_000) });
  const ourRelance = fakeMessage({ id: "m-relance", threadId, isFromUs: true, receivedAt: new Date(Date.now() - 60_000) });
  const humanReply = fakeMessage({
    id: "m-human",
    threadId,
    isFromUs: true,
    receivedAt: new Date(),
    bodyText: "Voici votre devis en piece jointe.",
  });
  const connector = fakeConnector({ id: threadId, messages: [clientMessage, ourAck, ourRelance, humanReply] });

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
