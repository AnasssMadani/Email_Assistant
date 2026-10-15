import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { freshTestDb } from "./_pgTestDb.js";
import { READ_METHODS, recordingConnector } from "./_recordingConnector.js";
import type { EmailMessage } from "../src/types.js";

// Etape 0 (mode silencieux): RIEN ne part — ni accuse, ni relance client,
// ni rappel interne a l'equipe — et rien n'est ecrit dans la boite. Le
// pipeline ne doit appeler que des methodes de LECTURE du connecteur, sur
// tout le cycle de vie d'un dossier. Regression: le rappel interne
// pre-reponse partait reellement en mode silencieux.
process.env.SHADOW_MODE = "true";

const db = await freshTestDb();
const { processIncomingMessage } = await import("../src/pipeline/processIncoming.js");
const { checkPreReplyThread, checkPostReplyThread, runRelanceCheck } = await import(
  "../src/pipeline/relanceCheck.js"
);
const { setClientForTesting } = await import("../src/ai/client.js");

setClientForTesting({
  messages: {
    async create(params: { tool_choice?: { name?: string } }) {
      const input =
        params.tool_choice?.name === "classify_email"
          ? { categoryId: "devis", urgency: "high", summary: "Demande de devis", requiresAcknowledgement: true }
          : { subject: "Re: Devis", body: "Texte factice pour le test." };
      return {
        content: [{ type: "tool_use", id: "tu-1", name: params.tool_choice?.name, input }],
        usage: { input_tokens: 10, output_tokens: 10 },
      };
    },
  },
} as unknown as Anthropic);

function clientMessage(threadId: string, overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id: `${threadId}-m1`,
    threadId,
    rfcMessageId: `<${threadId}@example.com>`,
    from: { email: "client@example.com" },
    to: [{ email: "us@example.com" }],
    subject: "Devis",
    bodyText: "Combien coute un conteneur ?",
    receivedAt: new Date(Date.now() - 120_000),
    isFromUs: false,
    hasAttachments: false,
    ...overrides,
  };
}

function assertOnlyReads(calls: string[]): void {
  const writes = calls.filter((c) => !READ_METHODS.includes(c));
  assert.deepEqual(writes, [], `appels non-lecture en mode silencieux: ${writes.join(", ")}`);
}

test("silent mode: an incoming client email is classified and its accusé drafted, but nothing is sent or written", async () => {
  const threadId = "t-silent-intake";
  const message = clientMessage(threadId);
  const { connector, calls } = recordingConnector({ id: threadId, messages: [message] });

  await processIncomingMessage(connector, message);

  assertOnlyReads(calls);
  const row = await db.getThreadRow(threadId);
  assert.equal(row?.status, "ack_sent"); // le dossier avance quand meme
  assert.equal(row?.automated_outbound_count, 0); // aucun envoi reel compte
  assert.equal(await db.hasReminderStep(threadId, "accuse"), false);
});

test("silent mode: a due internal rappel is logged as simulated, never sent to the team", async () => {
  const threadId = "t-silent-internal";
  // "devis" a les alertes equipe activees par defaut, et urgence "high"
  // depasse tout seuil: hors mode silencieux, ce rappel partirait.
  await db.upsertThreadReceived({
    threadId,
    subject: "Devis",
    senderEmail: "client@example.com",
    senderName: null,
    categoryId: "devis",
    urgency: "high",
    slaMinutes: 1,
    status: "ack_sent",
    dueAt: new Date(Date.now() - 60_000).toISOString(),
  });
  await db.setThreadAckSent(threadId);
  const { connector, calls } = recordingConnector({ id: threadId, messages: [clientMessage(threadId)] });

  const row = (await db.getThreadRow(threadId))!;
  await checkPreReplyThread(connector, row, { order: 1, channel: "internal", delayMinutes: 0 });

  assertOnlyReads(calls);
  assert.equal(await db.hasReminderStep(threadId, "relance_interne"), false);
  assert.equal(await db.hasReminderStep(threadId, "relance_interne_test"), true);
  const reminders = await db.listRemindersForThread(threadId);
  assert.ok(reminders.some((r) => r.note?.startsWith("[Mode test] Rappel interne")));
  assert.equal((await db.getThreadRow(threadId))?.relance_count, 1); // la sequence avance
});

test("silent mode: a full relance cycle (internal + external, pre and post reply) only ever reads the mailbox", async () => {
  const preId = "t-silent-cycle-pre";
  const postId = "t-silent-cycle-post";
  for (const threadId of [preId, postId]) {
    await db.upsertThreadReceived({
      threadId,
      subject: "Devis",
      senderEmail: "client@example.com",
      senderName: null,
      categoryId: "devis",
      urgency: "high",
      slaMinutes: 1,
      status: "ack_sent",
      dueAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await db.setThreadAckSent(threadId);
  }
  await db.addThreadRelanceStep(preId, { channel: "internal", delayMinutes: 0 }, "pre_reply");
  await db.addThreadRelanceStep(preId, { channel: "external", delayMinutes: 0 }, "pre_reply");
  await db.setThreadHumanReplied(postId, new Date(Date.now() - 30_000).toISOString());
  await db.addThreadRelanceStep(postId, { channel: "external", delayMinutes: 0 }, "post_reply");

  const ourReply = clientMessage(postId, {
    id: `${postId}-reply`,
    isFromUs: true,
    from: { email: "us@example.com" },
    receivedAt: new Date(Date.now() - 20_000),
  });
  const pre = recordingConnector({ id: preId, messages: [clientMessage(preId)] });
  const post = recordingConnector({ id: postId, messages: [ourReply] });

  // Deux passages: le 1er declenche l'etape interne, le 2e l'etape externe.
  for (let i = 0; i < 2; i++) {
    const preRow = (await db.getThreadRow(preId))!;
    const { steps } = await db.getEffectiveRelanceSteps(preId, "devis", "pre_reply");
    await checkPreReplyThread(pre.connector, preRow, steps[preRow.relance_count]);
  }
  const postRow = (await db.getThreadRow(postId))!;
  await checkPostReplyThread(post.connector, postRow, { order: 1, channel: "external", delayMinutes: 0 });
  // Et le cycle planifie complet, sur tous les dossiers de la base.
  await runRelanceCheck(pre.connector);

  assertOnlyReads(pre.calls);
  assertOnlyReads(post.calls);
  assert.equal((await db.getThreadRow(preId))?.relance_count, 2);
  assert.equal((await db.getThreadRow(postId))?.post_reply_relance_count, 1);
  for (const step of ["relance_interne", "relance_externe_pre_reponse", "relance_externe_post_reponse"] as const) {
    assert.equal(await db.hasReminderStep(preId, step), false, step);
    assert.equal(await db.hasReminderStep(postId, step), false, step);
  }
});
