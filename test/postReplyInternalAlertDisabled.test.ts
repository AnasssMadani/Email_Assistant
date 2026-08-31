import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EmailConnector, EmailMessage, EmailThread, NotificationParams, SendReplyParams } from "../src/types.js";

// Regression: l'equipe veut etre alertee quand ELLE n'a pas repondu a temps
// (pre_reply), pas quand c'est le CLIENT qui reste silencieux apres leur
// reponse (post_reply) - ce second cas n'appelle aucune action de leur part
// et ne doit plus jamais envoyer de vrai rappel interne, quelle que soit la
// categorie/urgence configuree.
const dir = mkdtempSync(path.join(tmpdir(), "post-reply-internal-alert-test-"));
process.env.DB_PATH = path.join(dir, "post-reply-internal-alert.db");
process.env.CATEGORIES_CONFIG_PATH = path.resolve("config/categories.json");

const { checkPreReplyThread, checkPostReplyThread } = await import("../src/pipeline/relanceCheck.js");
const {
  addThreadRelanceStep,
  getThreadRow,
  hasReminderStep,
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

function fakeConnector(thread: EmailThread, onSendNotification: () => void): EmailConnector {
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
    async sendNotification(_params: NotificationParams) {
      onSendNotification();
      return { id: "notif-1" };
    },
    async markMessageUnread() {},
  };
}

// "devis" a internal_alerts_enabled=1/min_urgency=normal par defaut (voir
// defaultAlertSettingsFor dans db.ts) - un cas ou l'alerte SERAIT partie si
// le rappel interne post-reponse n'etait pas desactive intentionnellement.
test("checkPostReplyThread never sends a real internal notification when the client goes silent after our reply, even with alerts enabled for the category", async () => {
  const threadId = "t-post-reply-internal-disabled";
  let notificationCalls = 0;

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
  addThreadRelanceStep(threadId, { channel: "internal", delayMinutes: 0 }, "post_reply");

  const ourReply = fakeMessage({ id: "m-our-reply", threadId, isFromUs: true, receivedAt: new Date(Date.now() - 20_000) });
  const connector = fakeConnector({ id: threadId, messages: [ourReply] }, () => notificationCalls++);

  const row = getThreadRow(threadId)!;
  await checkPostReplyThread(connector, row, { order: 1, channel: "internal", delayMinutes: 0 });

  assert.equal(notificationCalls, 0);
  assert.equal(hasReminderStep(threadId, "relance_interne"), false);
  assert.equal(hasReminderStep(threadId, "relance_interne_filtree"), true);
  const after = getThreadRow(threadId);
  assert.equal(after?.post_reply_relance_count, 1); // sequence advances regardless
});

// Contraste avec le test ci-dessus: le rappel interne PRE-reponse (equipe en
// retard) doit lui continuer a partir reellement pour une categorie dont les
// alertes sont activees - seule la variante post-reponse est desactivee.
test("checkPreReplyThread still sends a real internal notification when the team hasn't answered in time", async () => {
  const threadId = "t-pre-reply-internal-still-real";
  let notificationCalls = 0;

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
  addThreadRelanceStep(threadId, { channel: "internal", delayMinutes: 0 }, "pre_reply");

  const clientMessage = fakeMessage({ id: "m-client", threadId, isFromUs: false });
  const connector = fakeConnector({ id: threadId, messages: [clientMessage] }, () => notificationCalls++);

  const row = getThreadRow(threadId)!;
  await checkPreReplyThread(connector, row, { order: 1, channel: "internal", delayMinutes: 0 });

  assert.equal(notificationCalls, 1);
  assert.equal(hasReminderStep(threadId, "relance_interne"), true);
});
