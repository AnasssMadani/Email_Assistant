import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EmailConnector, EmailMessage, EmailThread, NotificationParams, SendReplyParams } from "../src/types.js";

// Isolated DB (its own file, its own dynamic import), rather than sharing
// relanceCheck.test.ts's file-scoped DB — this test asserts exact send
// counts across many dossiers in one runRelanceCheck() call, which would be
// fragile if it had to reason about leftover state from unrelated tests.
const dir = mkdtempSync(path.join(tmpdir(), "accuse-relance-budget-test-"));
process.env.DB_PATH = path.join(dir, "budget.db");
process.env.CATEGORIES_CONFIG_PATH = path.resolve("config/categories.json");

const { runRelanceCheck } = await import("../src/pipeline/relanceCheck.js");
const { config } = await import("../src/config.js");
const { addThreadRelanceStep, getThreadRow, listPipelineErrors, setThreadAckSent, upsertThreadReceived } =
  await import("../src/db.js");

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

test("runRelanceCheck never sends more external relances in one cycle than the configured cap, even if many dossiers are due at once", async () => {
  // Regression: a scheduler catching up (or simply many dossiers becoming
  // due in the same cycle — e.g. after aggressively short test SLAs) fired
  // an external relance for every single one of them in one go, observed
  // live as 8 emails landing at once. This reproduces "more due dossiers
  // than the cap allows" and asserts the excess is deferred, not sent.
  const dossierCount = config.maxExternalRelancesPerCycle + 3;
  const threadIds: string[] = [];
  const threadsById = new Map<string, EmailThread>();
  let sendReplyCalls = 0;

  for (let i = 0; i < dossierCount; i++) {
    const threadId = `t-burst-${i}`;
    threadIds.push(threadId);
    const dueAt = new Date(Date.now() - 60_000).toISOString();

    upsertThreadReceived({
      threadId,
      subject: `Devis ${i}`,
      senderEmail: `client${i}@example.com`,
      senderName: null,
      categoryId: "devis",
      urgency: "normal",
      slaMinutes: 1,
      status: "ack_sent",
      dueAt,
    });
    setThreadAckSent(threadId);
    // Une seule etape externe, deja due (delai 0 depuis l'echeance passee).
    addThreadRelanceStep(threadId, { channel: "external", delayMinutes: 0 }, "pre_reply");

    threadsById.set(threadId, {
      id: threadId,
      messages: [fakeMessage({ id: `m-${i}`, threadId, isFromUs: false })],
    });
  }

  const connector: EmailConnector = {
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
    async getThread(threadId: string) {
      const thread = threadsById.get(threadId);
      if (!thread) throw new Error(`unexpected threadId ${threadId}`);
      return thread;
    },
    async sendReply(_params: SendReplyParams) {
      sendReplyCalls++;
      return { id: `sent-${sendReplyCalls}` };
    },
    async createDraftReply(_params: SendReplyParams) {
      return { id: "draft-1" };
    },
    async deleteDraft() {},
    async sendNotification(_params: NotificationParams) {
      return { id: "notif-1" };
    },
  };

  await runRelanceCheck(connector);

  // This test environment has no ANTHROPIC_API_KEY, so a dossier that gets
  // past the budget gate still fails at draftRelance() and never reaches
  // connector.sendReply — sendReplyCalls stays 0 regardless of the cap.
  // That failure is itself the useful signal here: it's logged as a
  // pipeline error, so "how many dossiers got far enough to attempt a
  // send" is directly observable as the pipeline-error count, which is
  // exactly what the budget gate is supposed to bound. A dossier deferred
  // by the budget returns *before* draftRelance is ever called, so it logs
  // nothing and its relance_count stays untouched.
  assert.equal(sendReplyCalls, 0);

  const attempted = listPipelineErrors(100).filter((e) => e.context === "relance_check");
  assert.equal(attempted.length, config.maxExternalRelancesPerCycle);

  const untouchedCount = threadIds.filter((id) => getThreadRow(id)?.relance_count === 0).length;
  assert.equal(untouchedCount, dossierCount);
});
