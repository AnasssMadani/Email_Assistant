import { test } from "node:test";
import assert from "node:assert/strict";
import { freshTestDb } from "./_pgTestDb.js";
import type { EmailConnector, NotificationParams, SendReplyParams } from "../src/types.js";

// Base isolee: les comptages exacts ci-dessous seraient instables sur une base partagee.
const {
  getMorningReportByDate,
  listPipelineErrors,
  recordClassification,
  recordPipelineError,
  recordReminder,
  setThreadAckSent,
  setThreadHumanReplied,
  upsertThreadReceived,
} = await freshTestDb();
const {
  computeMorningReport,
  generateDailyMorningReport,
  parseRecipients,
  renderMorningReportText,
  saveMorningReportSendSettings,
  sendMorningReportIfDue,
} = await import("../src/pipeline/morningReport.js");
const { config } = await import("../src/config.js");

const MINUTE = 60_000;

function notificationConnector(sent: NotificationParams[], opts: { fail?: boolean } = {}): EmailConnector {
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
      throw new Error("not used");
    },
    async sendReply(_params: SendReplyParams) {
      throw new Error("a morning report must never reply inside a client thread");
    },
    async sendNotification(params: NotificationParams) {
      if (opts.fail) throw new Error("SMTP indisponible");
      sent.push(params);
      return { id: `report-${sent.length}` };
    },
    async markMessageUnread() {},
  };
}

async function classify(threadId: string, categoryId: string): Promise<void> {
  await recordClassification({
    threadId,
    messageId: `${threadId}-msg`,
    categoryId,
    urgency: "normal",
    originalSubject: `Sujet ${threadId}`,
    senderEmail: `${threadId}@client.example`,
    senderName: null,
    receivedBody: "...",
  });
}

async function thread(threadId: string, opts: { urgency?: string; dueInMinutes?: number | null; status?: "received" | "skipped" | "ai_error" }) {
  await upsertThreadReceived({
    threadId,
    subject: `Sujet ${threadId}`,
    senderEmail: `${threadId}@client.example`,
    senderName: null,
    categoryId: "devis",
    urgency: opts.urgency ?? "normal",
    slaMinutes: 60,
    status: opts.status ?? "received",
    dueAt: opts.dueInMinutes == null ? null : new Date(Date.now() + opts.dueInMinutes * MINUTE).toISOString(),
  });
}

test("computeMorningReport counts emails by category, acks, relances, pending follow-ups and items needing a human", async () => {
  await classify("t-overdue", "devis");
  await classify("t-urgent", "devis");
  await classify("t-info", "demande_information");

  await thread("t-overdue", { dueInMinutes: -10 });
  await setThreadAckSent("t-overdue");
  await thread("t-urgent", { urgency: "high", dueInMinutes: 120 });
  await setThreadAckSent("t-urgent");
  await thread("t-ai", { status: "ai_error" });
  await thread("t-skip", { status: "skipped" });
  // Devis: relance post-reponse externe par defaut a J+3 — notre reponse
  // date de J-3 + 1 h, donc la relance client tombe dans l'heure.
  await thread("t-client", {});
  await setThreadHumanReplied("t-client", new Date(Date.now() - (3 * 1440 - 60) * MINUTE).toISOString());

  await recordReminder("t-overdue", "external", "relance", "relance_externe_pre_reponse");
  await recordReminder("t-overdue", "internal", "rappel", "relance_interne");
  await recordReminder("t-overdue", "internal", "texte libre sans step_type");
  await recordPipelineError("relance_check", "t-overdue", "boom");

  const now = new Date();
  const report = await computeMorningReport({
    reportDate: "2026-10-15",
    start: new Date(now.getTime() - 60 * MINUTE),
    end: new Date(now.getTime() + MINUTE),
    nightStart: new Date(now.getTime() - 30 * MINUTE),
    now,
  });

  assert.equal(report.received.total, 3);
  assert.equal(report.received.night, 3);
  assert.deepEqual(
    report.received.byCategory.map((r) => [r.categoryId, r.count]),
    [
      ["devis", 2],
      ["demande_information", 1],
    ]
  );
  assert.equal(report.received.byCategory[0].label, "Demande de devis");
  assert.equal(report.received.aiErrors, 1);
  assert.equal(report.acknowledgements.count, 2);
  assert.equal(report.acknowledgements.skipped, 1);
  assert.equal(report.relances.externalPreReply, 1);
  assert.equal(report.relances.internalSent, 1);
  assert.equal(report.pipelineErrors, 1);

  assert.deepEqual(
    report.needsHuman.items.map((i) => [i.threadId, i.reason]),
    [
      ["t-ai", "ai_error"],
      ["t-overdue", "overdue"],
      ["t-urgent", "urgent"],
    ]
  );
  assert.equal(report.pending.awaitingTeam, 2);
  assert.equal(report.pending.awaitingTeamOverdue, 1);
  assert.equal(report.pending.awaitingClient, 1);
  assert.deepEqual(
    report.pending.upcoming.map((u) => [u.threadId, u.phase]),
    [["t-client", "post_reply"]]
  );

  const text = renderMorningReportText(report);
  assert.match(text, /Demande de devis : 2/);
  assert.match(text, /Délai promis dépassé — Sujet t-overdue/);
});

test("the morning report text says acks were only drafted in silent mode", async () => {
  const now = new Date();
  const window = { reportDate: null, start: new Date(now.getTime() - MINUTE), end: now, nightStart: now, now };
  config.shadowModeEnabled = true;
  try {
    assert.match(renderMorningReportText(await computeMorningReport(window)), /Accusés rédigés \(mode silencieux, non envoyés\)/);
  } finally {
    config.shadowModeEnabled = false;
  }
  assert.match(renderMorningReportText(await computeMorningReport(window)), /Accusés envoyés : /);
});

test("generateDailyMorningReport creates one report per local day and never recomputes it", async () => {
  const now = new Date();
  const first = await generateDailyMorningReport(now);
  await classify("t-late-arrival", "devis");
  const second = await generateDailyMorningReport(now);
  assert.equal(second.id, first.id);
  assert.equal(second.content, first.content);
});

test("silent mode never sends the report, even with sending enabled", async () => {
  const sent: NotificationParams[] = [];
  await saveMorningReportSendSettings({ enabled: true, recipients: ["direction@example.com"] });
  const row = await generateDailyMorningReport(new Date());
  config.shadowModeEnabled = true;
  try {
    assert.equal(await sendMorningReportIfDue(row, () => notificationConnector(sent)), "shadow");
  } finally {
    config.shadowModeEnabled = false;
  }
  assert.equal(sent.length, 0);
  assert.equal((await getMorningReportByDate(row.report_date))?.send_claimed_at, null);
});

test("sending stays off until the back-office toggle is on", async () => {
  const sent: NotificationParams[] = [];
  await saveMorningReportSendSettings({ enabled: false, recipients: [] });
  const row = await generateDailyMorningReport(new Date());
  assert.equal(await sendMorningReportIfDue(row, () => notificationConnector(sent)), "disabled");
  assert.equal(sent.length, 0);
});

test("with the toggle on, the report goes once to each recipient and never twice", async () => {
  const sent: NotificationParams[] = [];
  await saveMorningReportSendSettings({ enabled: true, recipients: ["direction@example.com", "boss@example.com"] });
  const row = await generateDailyMorningReport(new Date());
  const now = new Date(new Date(row.period_end).getTime() + MINUTE);

  assert.equal(await sendMorningReportIfDue(row, () => notificationConnector(sent), now), "sent");
  assert.deepEqual(
    sent.map((s) => s.to),
    ["direction@example.com", "boss@example.com"]
  );
  assert.ok(sent[0].subject.startsWith("[Rapport] Rapport du matin"));
  const stored = await getMorningReportByDate(row.report_date);
  assert.equal(stored?.sent_to, "direction@example.com, boss@example.com");

  // Rattrapage au demarrage, second processus... : jamais de second envoi.
  assert.equal(await sendMorningReportIfDue(stored!, () => notificationConnector(sent), now), "already");
  assert.equal(await sendMorningReportIfDue(row, () => notificationConnector(sent), now), "already");
  assert.equal(sent.length, 2);
});

test("two concurrent send attempts on the same report send it only once", async () => {
  const sent: NotificationParams[] = [];
  await saveMorningReportSendSettings({ enabled: true, recipients: ["direction@example.com"] });
  const row = await generateDailyMorningReport(new Date(Date.now() - 24 * 60 * MINUTE));
  const now = new Date(new Date(row.period_end).getTime() + MINUTE);
  const outcomes = await Promise.all([
    sendMorningReportIfDue(row, () => notificationConnector(sent), now),
    sendMorningReportIfDue(row, () => notificationConnector(sent), now),
  ]);
  assert.deepEqual(outcomes.sort(), ["already", "sent"]);
  assert.equal(sent.length, 1);
});

test("a report not sent within the cutoff after 9:00 stays in the back-office instead of going out late", async () => {
  const sent: NotificationParams[] = [];
  await saveMorningReportSendSettings({ enabled: true, recipients: [] });
  const row = await generateDailyMorningReport(new Date(Date.now() - 2 * 24 * 60 * MINUTE));
  const now = new Date(new Date(row.period_end).getTime() + (config.morningReport.sendCutoffHours * 60 + 1) * MINUTE);
  assert.equal(await sendMorningReportIfDue(row, () => notificationConnector(sent), now), "late");
  assert.equal(sent.length, 0);
  assert.equal((await getMorningReportByDate(row.report_date))?.send_claimed_at, null);
});

test("a failed send is recorded and visible, and is not retried automatically", async () => {
  const sent: NotificationParams[] = [];
  await saveMorningReportSendSettings({ enabled: true, recipients: [] });
  const row = await generateDailyMorningReport(new Date(Date.now() - 3 * 24 * 60 * MINUTE));
  const now = new Date(new Date(row.period_end).getTime() + MINUTE);
  assert.equal(await sendMorningReportIfDue(row, () => notificationConnector(sent, { fail: true }), now), "failed");
  const stored = await getMorningReportByDate(row.report_date);
  assert.match(stored?.send_error ?? "", /SMTP indisponible/);
  assert.ok((await listPipelineErrors()).some((e) => e.context === "morning_report"));
  assert.equal(await sendMorningReportIfDue(stored!, () => notificationConnector(sent), now), "already");
  assert.equal(sent.length, 0);
});

test("parseRecipients accepts comma/semicolon/space separated addresses and rejects invalid ones", () => {
  assert.deepEqual(parseRecipients(" A@x.ma; b@y.com,  a@x.ma "), ["a@x.ma", "b@y.com"]);
  assert.deepEqual(parseRecipients(""), []);
  assert.throws(() => parseRecipients("direction@x.ma, pas-une-adresse"), /pas-une-adresse/);
});
