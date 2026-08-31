import "./_settingsEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverOutboundOnlyThreads } from "../src/pipeline/discoverOutbound.js";
import { getThreadRow, setThreadHumanReplied, upsertThreadReceived } from "../src/db.js";
import type { EmailConnector, EmailMessage, EmailThread, NotificationParams, SendReplyParams } from "../src/types.js";

function fakeSentMessage(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id: "msg-1",
    threadId: "thread-outbound-1",
    from: { email: "us@example.com" },
    to: [{ email: "prospect@example.com", name: "Prospect" }],
    subject: "Devis conteneur 40ft",
    bodyText: "Voici notre devis...",
    receivedAt: new Date(),
    isFromUs: true,
    ...overrides,
  };
}

function fakeConnector(sentMessages: EmailMessage[]): EmailConnector {
  return {
    name: "gmail",
    async getOwnEmailAddress() {
      return "us@example.com";
    },
    async listRecentInboxMessages() {
      return [];
    },
    async listRecentSentMessages() {
      return sentMessages;
    },
    async getThread(): Promise<EmailThread> {
      throw new Error("not used in this test");
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

test("a brand-new outbound thread gets registered as awaiting_client_reply", async () => {
  const sentAt = new Date();
  const connector = fakeConnector([fakeSentMessage({ id: "msg-new", threadId: "thread-new", receivedAt: sentAt })]);

  await discoverOutboundOnlyThreads(connector);

  const row = getThreadRow("thread-new");
  assert.equal(row?.status, "awaiting_client_reply");
  assert.equal(row?.sender_email, "prospect@example.com");
  assert.equal(row?.category_id, "autre");
  assert.equal(row?.human_replied_at, sentAt.toISOString());
  // BUG-005: marque comme decouvert en sortie, pour que les KPI du dashboard
  // client (emailsTraites, delaiMoyenReponseMinutes) puissent l'exclure.
  assert.equal(row?.origin, "outbound");
});

test("BUG-004: a thread already in post_reply (human_replied_at set) is never downgraded back to 'received' by a later upsertThreadReceived", () => {
  // Reproduit la course discoverOutbound / pollInbox: l'equipe repond a la
  // main avant que l'email entrant n'ait ete scrute. discoverOutbound cree
  // le dossier en awaiting_client_reply avec human_replied_at pose ; le
  // pollInbox retardataire ne doit PAS faire regresser ce dossier en
  // "received", ni reculer son due_at, sous peine d'un etat incoherent
  // (phase pre_reply + human_replied_at deja non nul).
  const threadId = "thread-race";
  upsertThreadReceived({
    threadId,
    subject: "Devis urgent",
    senderEmail: "client@example.com",
    senderName: null,
    categoryId: "devis",
    urgency: "normal",
    slaMinutes: 1440,
    status: "awaiting_client_reply",
    dueAt: null,
    origin: "outbound",
  });
  setThreadHumanReplied(threadId, new Date(Date.now() - 60_000).toISOString());
  const before = getThreadRow(threadId)!;
  assert.ok(before.human_replied_at);

  upsertThreadReceived({
    threadId,
    subject: "Devis urgent",
    senderEmail: "client@example.com",
    senderName: null,
    categoryId: "devis",
    urgency: "normal",
    slaMinutes: 1440,
    status: "received",
    dueAt: new Date(Date.now() + 1440 * 60_000).toISOString(),
  });

  const after = getThreadRow(threadId)!;
  assert.notEqual(after.status, "received");
  assert.equal(after.status, before.status);
  assert.equal(after.due_at, before.due_at);
  assert.equal(after.human_replied_at, before.human_replied_at);
});

test("a thread that already has a dossier is left untouched", async () => {
  upsertThreadReceived({
    threadId: "thread-existing",
    subject: "Deja suivi",
    senderEmail: "client@example.com",
    senderName: null,
    categoryId: "devis",
    urgency: "normal",
    slaMinutes: 1440,
    status: "ack_sent",
    dueAt: new Date().toISOString(),
  });

  const connector = fakeConnector([
    fakeSentMessage({ id: "msg-existing", threadId: "thread-existing" }),
  ]);

  await discoverOutboundOnlyThreads(connector);

  const row = getThreadRow("thread-existing");
  assert.equal(row?.status, "ack_sent");
  assert.equal(row?.category_id, "devis");
});

test("messages sent before the pipeline started observing are ignored", async () => {
  const oldMessage = fakeSentMessage({
    id: "msg-old",
    threadId: "thread-old",
    receivedAt: new Date(Date.now() - 1000 * 3600 * 24 * 30),
  });
  const connector = fakeConnector([oldMessage]);

  await discoverOutboundOnlyThreads(connector);

  assert.equal(getThreadRow("thread-old"), undefined);
});
