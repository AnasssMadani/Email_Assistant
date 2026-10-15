import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { freshTestDb } from "./_pgTestDb.js";
import type { EmailConnector, EmailMessage } from "../src/types.js";

const { isMessageProcessed, listReminders } = await freshTestDb();
const { processIncomingMessage } = await import("../src/pipeline/processIncoming.js");
const { setClientForTesting } = await import("../src/ai/client.js");
const { ImapSmtpConnector } = await import("../src/connectors/imapConnector.js");

let aiCalls = 0;
setClientForTesting({
  messages: {
    async create() {
      aiCalls++;
      return {
        content: [{ type: "tool_use", input: { categoryId: "autre", urgency: "normal", summary: "Test.", requiresAcknowledgement: true, subject: "Re", body: "Bien recu." } }],
        usage: { input_tokens: 10, output_tokens: 10 },
      };
    },
  },
} as unknown as Anthropic);

function copy(uid: number, rfc = "<abc@client.com>"): EmailMessage {
  return {
    id: `imap.SU5CT1g.1.${uid}`,
    threadId: "imap.root-abc",
    rfcMessageId: rfc,
    from: { email: "client@example.com" },
    to: [{ email: "info@oceanlink-global.com" }],
    subject: "Demande de devis",
    bodyText: "Bonjour",
    receivedAt: new Date(),
    isFromUs: false,
    hasAttachments: false,
  };
}
const connector: EmailConnector = {
  name: "imap",
  async getOwnEmailAddress() {
    return "info@oceanlink-global.com";
  },
  async listRecentInboxMessages() {
    return [];
  },
  async listRecentSentMessages() {
    return [];
  },
  async getThread() {
    return { id: "imap.root-abc", messages: [copy(1)] };
  },
  async sendReply() {
    return { id: "sent" };
  },
  async sendNotification() {
    return { id: "notif" };
  },
};

test("the same email received through several aliases is processed once", async () => {
  await processIncomingMessage(connector, copy(1)); // info@
  const callsAfterFirst = aiCalls;
  assert.ok(callsAfterFirst > 0);
  const remindersAfterFirst = (await listReminders(1000)).length;

  await processIncomingMessage(connector, copy(2)); // import@
  await processIncomingMessage(connector, copy(3)); // finance@

  assert.equal(aiCalls, callsAfterFirst, "no extra AI call for the copies");
  assert.equal((await listReminders(1000)).length, remindersAfterFirst, "no extra accuse / reminder");
  assert.equal(await isMessageProcessed("imap.SU5CT1g.1.2"), true);
  assert.equal(await isMessageProcessed("imap.SU5CT1g.1.3"), true);
});

test("a different email (other Message-ID) in the same thread is still processed", async () => {
  const before = aiCalls;
  await processIncomingMessage(connector, copy(4, "<other@client.com>"));
  assert.ok(aiCalls > before);
});

test("team replies from personal addresses of our domain count as ours in copy-mailbox mode", () => {
  const settings = (over: Record<string, unknown>) =>
    ({
      imap: { host: "h", port: 993, secure: true, user: "inbox_global@oceanlink-global.com", password: "x", inboxFolder: "INBOX", sentFolder: "", threadLookbackDays: 30, ...over },
      smtp: { host: "", port: 465, secure: true, user: "", password: "", fromAddress: "" },
    }) as never;
  const own = "info@oceanlink-global.com";
  const isOwn = (c: InstanceType<typeof ImapSmtpConnector>, email: string) =>
    (c as unknown as { isOwnSender(e: string, o: string): boolean }).isOwnSender(email, own);

  const copyMode = new ImapSmtpConnector({ settings: settings({ mailboxAddress: own }) });
  assert.equal(isOwn(copyMode, "k.khallaf@oceanlink-global.com"), true);
  assert.equal(isOwn(copyMode, "INFO@oceanlink-global.com"), true);
  assert.equal(isOwn(copyMode, "nedim.cagin@bwlturkey.com"), false);

  // Hors mode boite copie, seule l'adresse exacte compte (comportement inchange).
  const plain = new ImapSmtpConnector({ settings: settings({}) });
  assert.equal(isOwn(plain, "k.khallaf@oceanlink-global.com"), false);

  const explicit = new ImapSmtpConnector({ settings: settings({ ownDomains: ["oceanlink-global.com", "globallink.ma"] }) });
  assert.equal(isOwn(explicit, "x@globallink.ma"), true);
});
