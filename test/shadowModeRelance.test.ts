import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { freshTestDb } from "./_pgTestDb.js";
import type { EmailConnector, EmailMessage, EmailThread, NotificationParams, SendReplyParams } from "../src/types.js";

// Regression: l'etape 0 ("rien ne part jamais") must cover EVERY send path,
// not just the accusé — a real deploy once sent live "relance post-réponse"
// emails to real client addresses because only the accusé path was guarded
// (then by SHADOW_MODE), not checkPreReplyThread/checkPostReplyThread's
// external branches. No env lock here: stage 0 must come from the database
// default alone (a fresh database starts silent).
process.env.SHADOW_MODE = "false";
process.env.MAX_STAGE = "3";

const {
  addThreadRelanceStep,
  getThreadRow,
  hasReminderStep,
  listRemindersForThread,
  setStoredStage,
  setThreadAckSent,
  setThreadHumanReplied,
  upsertThreadReceived,
} = await freshTestDb();
const { getStage } = await import("../src/stage.js");
const { sendAcknowledgement } = await import("../src/pipeline/processIncoming.js");
const { checkPreReplyThread, checkPostReplyThread } = await import("../src/pipeline/relanceCheck.js");
const { setClientForTesting } = await import("../src/ai/client.js");

// Mode test rédige quand même le texte de la relance (voir relanceCheck.ts)
// pour qu'il soit journalisé et relisible — donc draftRelance() appelle
// bien Claude ici, sans clé API reelle dans cet environnement de test.
setClientForTesting({
  messages: {
    async create() {
      return {
        content: [{ type: "tool_use", input: { subject: "Re: Devis", body: "Relance factice pour le test." } }],
        usage: { input_tokens: 10, output_tokens: 10 },
      };
    },
  },
} as unknown as Anthropic);

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

function fakeConnector(
  thread: EmailThread,
  onSendReply: () => void,
  onSendNotification: () => void = () => {}
): EmailConnector {
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
    async sendNotification(_params: NotificationParams) {
      onSendNotification();
      return { id: "notif-1" };
    },
    async markMessageUnread() {},
  };
}

test("a fresh database starts at stage 0 (silent)", async () => {
  assert.equal(await getStage(), 0);
});

test("checkPreReplyThread never sends a real external relance at stage 0, but still advances the sequence", async () => {
  const threadId = "t-shadow-pre-reply-external";
  let sendReplyCalls = 0;

  await upsertThreadReceived({
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
  await setThreadAckSent(threadId);
  await addThreadRelanceStep(threadId, { channel: "external", delayMinutes: 0 }, "pre_reply");

  const clientMessage = fakeMessage({ id: "m-client", threadId, isFromUs: false });
  const connector = fakeConnector({ id: threadId, messages: [clientMessage] }, () => sendReplyCalls++);

  const row = (await getThreadRow(threadId))!;
  await checkPreReplyThread(connector, row, { order: 1, channel: "external", delayMinutes: 0 });

  assert.equal(sendReplyCalls, 0);
  const after = await getThreadRow(threadId);
  assert.equal(after?.relance_count, 1); // sequence advanced despite no real send

  // Le texte redige par Claude doit rester consultable — mode test n'est pas
  // un simple "rien ne se passe", c'est "rien n'est envoye mais tout est
  // redige et journalise pour revue".
  const reminders = await listRemindersForThread(threadId);
  assert.ok(reminders.some((r) => r.note?.includes("[Mode test]") && r.note?.includes("Relance factice pour le test.")));
});

test("checkPostReplyThread never sends a real external relance at stage 0, but still advances the sequence", async () => {
  const threadId = "t-shadow-post-reply-external";
  let sendReplyCalls = 0;

  await upsertThreadReceived({
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
  await setThreadHumanReplied(threadId, new Date(Date.now() - 30_000).toISOString());

  const ourReply = fakeMessage({ id: "m-our-reply", threadId, isFromUs: true, receivedAt: new Date(Date.now() - 20_000) });
  const connector = fakeConnector({ id: threadId, messages: [ourReply] }, () => sendReplyCalls++);

  const row = (await getThreadRow(threadId))!;
  await checkPostReplyThread(connector, row, { order: 1, channel: "external", delayMinutes: 0 });

  assert.equal(sendReplyCalls, 0);
  const after = await getThreadRow(threadId);
  assert.equal(after?.post_reply_relance_count, 1); // sequence advanced despite no real send

  const reminders = await listRemindersForThread(threadId);
  assert.ok(reminders.some((r) => r.note?.includes("[Mode test]") && r.note?.includes("Relance factice pour le test.")));
});

test("sendAcknowledgement drafts but never sends the accusé at stage 0", async () => {
  const threadId = "t-stage0-ack";
  let sendReplyCalls = 0;
  await upsertThreadReceived({
    threadId,
    subject: "Devis",
    senderEmail: "client@example.com",
    senderName: null,
    categoryId: "devis",
    urgency: "normal",
    slaMinutes: 60,
    status: "received",
    dueAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const incoming = fakeMessage({ id: "m-stage0-ack", threadId });
  const connector = fakeConnector({ id: threadId, messages: [incoming] }, () => sendReplyCalls++);
  const { listCategories } = await import("../src/db.js");
  const devis = (await listCategories()).find((c) => c.id === "devis")!;

  await sendAcknowledgement(connector, { id: threadId, messages: [incoming] }, incoming, devis);

  assert.equal(sendReplyCalls, 0);
  const after = await getThreadRow(threadId);
  assert.ok(after?.ack_sent_at); // le dossier avance quand meme en pre_reply
  assert.equal(after?.automated_outbound_count, 0); // rien n'a rejoint le fil
  assert.equal(await hasReminderStep(threadId, "accuse"), false);
});

test("checkPreReplyThread never sends the internal team rappel at stage 0, but still advances the sequence", async () => {
  const threadId = "t-stage0-internal";
  let notificationCalls = 0;
  await upsertThreadReceived({
    threadId,
    subject: "Reclamation",
    senderEmail: "client@example.com",
    senderName: null,
    categoryId: "reclamation", // alerte equipe activee des l'urgence basse par defaut
    urgency: "high",
    slaMinutes: 1,
    status: "ack_sent",
    dueAt: new Date(Date.now() - 60_000).toISOString(),
  });
  await setThreadAckSent(threadId);
  const clientMessage = fakeMessage({ id: "m-stage0-internal", threadId });
  const connector = fakeConnector({ id: threadId, messages: [clientMessage] }, () => {}, () => notificationCalls++);

  await checkPreReplyThread(connector, (await getThreadRow(threadId))!, { order: 1, channel: "internal", delayMinutes: 0 });

  assert.equal(notificationCalls, 0);
  assert.equal((await getThreadRow(threadId))?.relance_count, 1);
  assert.equal(await hasReminderStep(threadId, "relance_interne"), false);
  assert.equal(await hasReminderStep(threadId, "relance_interne_filtree"), true);
});

test("at stage 1, a dossier whose accusé was never really sent (opened at stage 0) gets no client relance", async () => {
  const threadId = "t-stage1-no-real-ack";
  let sendReplyCalls = 0;
  await upsertThreadReceived({
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
  await setThreadAckSent(threadId); // accuse redige a l'etape 0: automated_outbound_count reste 0
  const clientMessage = fakeMessage({ id: "m-stage1-no-ack", threadId });
  const connector = fakeConnector({ id: threadId, messages: [clientMessage] }, () => sendReplyCalls++);

  await setStoredStage(1);
  try {
    await checkPreReplyThread(connector, (await getThreadRow(threadId))!, { order: 1, channel: "external", delayMinutes: 0 });
  } finally {
    await setStoredStage(0);
  }

  assert.equal(sendReplyCalls, 0);
  assert.equal((await getThreadRow(threadId))?.relance_count, 1);
  const reminders = await listRemindersForThread(threadId);
  assert.ok(reminders.some((r) => r.note?.startsWith("[Non envoyé]")));
});
