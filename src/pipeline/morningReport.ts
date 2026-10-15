import { config } from "../config.js";
import { createEmailConnector } from "../connectors/index.js";
import {
  claimMorningReportSend,
  countAcknowledgedThreadsBetween,
  countClassifiedEmailsBetween,
  countClassifiedEmailsByCategory,
  countPipelineErrorsBetween,
  countReminderStepsBetween,
  countSkippedThreadsBetween,
  getAppSetting,
  getMorningReportByDate,
  insertMorningReportIfAbsent,
  listCategories,
  listThreadsByStatus,
  loadAllRelanceSteps,
  markMessageProcessed,
  recordMorningReportSendResult,
  recordPipelineError,
  resolveEffectiveSteps,
  setAppSetting,
  type MorningReportRow,
  type ThreadRowWithSnapshots,
} from "../db.js";
import { dailyReportWindow } from "../timezone.js";
import type { EmailConnector, RelanceChannel, ThreadStatus } from "../types.js";

/**
 * Rapport du matin: photographie, a heure fixe (9 h a Casablanca par
 * defaut), de ce qui s'est passe depuis le rapport precedent et de ce qui
 * attend l'equipe. Toujours genere et stocke (visible dans /rapport); son
 * envoi par email est un interrupteur distinct du back-office, et reste
 * bloque en mode silencieux (SHADOW_MODE) quel que soit cet interrupteur —
 * a l'etape 0 rien ne part, rapport compris.
 */

export const MORNING_REPORT_SUBJECT_PREFIX = "[Rapport]";

const PRE_REPLY_STATUSES: ThreadStatus[] = ["ack_sent", "drafts_ready", "relance_sent"];
const POST_REPLY_STATUSES: ThreadStatus[] = ["awaiting_client_reply", "post_reply_relance_sent"];
/** Au-dela, le rapport resume ("et N autres") plutot que de lister — l'email doit rester lisible. */
const MAX_LISTED_ITEMS = 25;
const UPCOMING_HORIZON_MS = 24 * 60 * 60_000;

interface ThreadRef {
  threadId: string;
  subject: string;
  senderEmail: string;
  senderName: string | null;
  categoryLabel: string;
  urgency: string;
}

export type NeedsHumanReason = "ai_error" | "overdue" | "urgent";

export interface NeedsHumanItem extends ThreadRef {
  reason: NeedsHumanReason;
  /** Echeance depassee (overdue) ou date de reception (ai_error, urgent). */
  since: string;
}

export interface UpcomingRelance extends ThreadRef {
  phase: "pre_reply" | "post_reply";
  fireAt: string;
}

export interface MorningReportData {
  version: 1;
  /** null pour un apercu en direct (non stocke). */
  reportDate: string | null;
  periodStart: string;
  periodEnd: string;
  nightStart: string;
  generatedAt: string;
  shadowMode: boolean;
  received: {
    total: number;
    night: number;
    byCategory: Array<{ categoryId: string; label: string; count: number }>;
    /** Dossiers apparus sur la periode et toujours en echec IA (classification ou accuse). */
    aiErrors: number;
  };
  acknowledgements: {
    /** Envoyes, ou rediges sans envoi si shadowMode. */
    count: number;
    /** Nouveaux dossiers classes "pas d'accuse necessaire". */
    skipped: number;
  };
  relances: {
    externalPreReply: number;
    externalPostReply: number;
    /** Mode silencieux: redigees et journalisees, jamais envoyees. */
    testPreReply: number;
    testPostReply: number;
    internalSent: number;
    internalFiltered: number;
  };
  pending: {
    awaitingTeam: number;
    awaitingTeamOverdue: number;
    awaitingClient: number;
    /** Relances CLIENT (externes) prevues dans les 24 h suivant la generation, les plus proches d'abord. */
    upcoming: UpcomingRelance[];
    upcomingTotal: number;
  };
  needsHuman: {
    total: number;
    items: NeedsHumanItem[];
  };
  pipelineErrors: number;
}

function toRef(row: ThreadRowWithSnapshots, labels: Map<string, string>): ThreadRef {
  return {
    threadId: row.thread_id,
    subject: row.subject,
    senderEmail: row.sender_email,
    senderName: row.sender_name,
    categoryLabel: labels.get(row.category_id) ?? row.category_id,
    urgency: row.urgency,
  };
}

function nextExternalFireAt(
  row: ThreadRowWithSnapshots,
  phase: "pre_reply" | "post_reply",
  steps: Awaited<ReturnType<typeof loadAllRelanceSteps>>
): number | null {
  const anchor = phase === "pre_reply" ? row.due_at : row.human_replied_at;
  if (!anchor) return null;
  const effective = resolveEffectiveSteps(row, phase, steps);
  const index = phase === "pre_reply" ? row.relance_count : row.post_reply_relance_count;
  const next = effective[index];
  if (!next || (next.channel as RelanceChannel) !== "external") return null;
  return new Date(anchor).getTime() + next.delayMinutes * 60_000;
}

/** Ordre d'affichage de "A traiter": le plus grave d'abord, puis le plus ancien. */
function needsHumanRank(item: NeedsHumanItem): number {
  if (item.reason === "overdue" && item.urgency === "high") return 0;
  if (item.reason === "ai_error") return 1;
  if (item.reason === "overdue") return 2;
  return 3;
}

/**
 * Calcule le contenu d'un rapport pour la periode [start, end[. `now` sert
 * aux etats "a l'instant" (retards, relances a venir) — egal a `end` pour le
 * rapport planifie, a l'heure courante pour un apercu en direct.
 */
export async function computeMorningReport(params: {
  reportDate: string | null;
  start: Date;
  end: Date;
  nightStart: Date;
  now: Date;
}): Promise<MorningReportData> {
  const startIso = params.start.toISOString();
  const endIso = params.end.toISOString();
  const nowMs = params.now.getTime();

  const categories = await listCategories();
  const labels = new Map(categories.map((c) => [c.id, c.label]));
  const order = new Map(categories.map((c, i) => [c.id, i]));

  const byCategory = (await countClassifiedEmailsByCategory(startIso, endIso))
    .map((r) => ({ categoryId: r.categoryId, label: labels.get(r.categoryId) ?? r.categoryId, count: r.count }))
    .sort((a, b) => b.count - a.count || (order.get(a.categoryId) ?? 999) - (order.get(b.categoryId) ?? 999));
  const total = byCategory.reduce((sum, r) => sum + r.count, 0);
  const night = await countClassifiedEmailsBetween(params.nightStart.toISOString(), endIso);

  const steps = await countReminderStepsBetween(startIso, endIso);

  const aiErrorRows = await listThreadsByStatus(["ai_error"]);
  const awaitingTeamRows = await listThreadsByStatus(PRE_REPLY_STATUSES);
  const awaitingClientRows = await listThreadsByStatus(POST_REPLY_STATUSES);

  const needsHuman: NeedsHumanItem[] = [];
  for (const row of aiErrorRows) {
    needsHuman.push({ ...toRef(row, labels), reason: "ai_error", since: row.received_at });
  }
  let awaitingTeamOverdue = 0;
  for (const row of awaitingTeamRows) {
    if (row.due_at && new Date(row.due_at).getTime() < nowMs) {
      awaitingTeamOverdue++;
      needsHuman.push({ ...toRef(row, labels), reason: "overdue", since: row.due_at });
    } else if (row.urgency === "high") {
      needsHuman.push({ ...toRef(row, labels), reason: "urgent", since: row.received_at });
    }
  }
  needsHuman.sort((a, b) => needsHumanRank(a) - needsHumanRank(b) || a.since.localeCompare(b.since));

  const preSteps = await loadAllRelanceSteps("pre_reply");
  const postSteps = await loadAllRelanceSteps("post_reply");
  const upcoming: UpcomingRelance[] = [];
  const horizon = nowMs + UPCOMING_HORIZON_MS;
  for (const [rows, phase, all] of [
    [awaitingTeamRows, "pre_reply", preSteps],
    [awaitingClientRows, "post_reply", postSteps],
  ] as const) {
    for (const row of rows) {
      const fireAt = nextExternalFireAt(row, phase, all);
      if (fireAt !== null && fireAt <= horizon) {
        upcoming.push({ ...toRef(row, labels), phase, fireAt: new Date(fireAt).toISOString() });
      }
    }
  }
  upcoming.sort((a, b) => a.fireAt.localeCompare(b.fireAt));

  return {
    version: 1,
    reportDate: params.reportDate,
    periodStart: startIso,
    periodEnd: endIso,
    nightStart: params.nightStart.toISOString(),
    generatedAt: new Date().toISOString(),
    shadowMode: config.shadowModeEnabled,
    received: {
      total,
      night,
      byCategory,
      aiErrors: aiErrorRows.filter((r) => r.received_at >= startIso && r.received_at < endIso).length,
    },
    acknowledgements: {
      count: await countAcknowledgedThreadsBetween(startIso, endIso),
      skipped: await countSkippedThreadsBetween(startIso, endIso),
    },
    relances: {
      externalPreReply: steps.relance_externe_pre_reponse ?? 0,
      externalPostReply: steps.relance_externe_post_reponse ?? 0,
      testPreReply: steps.relance_externe_test_pre_reponse ?? 0,
      testPostReply: steps.relance_externe_test_post_reponse ?? 0,
      internalSent: steps.relance_interne ?? 0,
      internalFiltered: steps.relance_interne_filtree ?? 0,
    },
    pending: {
      awaitingTeam: awaitingTeamRows.length,
      awaitingTeamOverdue,
      awaitingClient: awaitingClientRows.length,
      upcoming: upcoming.slice(0, MAX_LISTED_ITEMS),
      upcomingTotal: upcoming.length,
    },
    needsHuman: { total: needsHuman.length, items: needsHuman.slice(0, MAX_LISTED_ITEMS) },
    pipelineErrors: await countPipelineErrorsBetween(startIso, endIso),
  };
}

export function parseMorningReportContent(row: MorningReportRow): MorningReportData {
  return JSON.parse(row.content) as MorningReportData;
}

/** Rapport "du jour" (dernier echu), cree s'il n'existe pas encore — jamais recalcule ensuite. */
export async function generateDailyMorningReport(now: Date = new Date()): Promise<MorningReportRow> {
  const window = dailyReportWindow(now, config.morningReport.hour, config.morningReport.nightStartHour, config.timezone);
  const existing = await getMorningReportByDate(window.reportDate);
  if (existing) return existing;
  const data = await computeMorningReport({ ...window, now });
  return insertMorningReportIfAbsent({
    reportDate: window.reportDate,
    periodStart: window.start.toISOString(),
    periodEnd: window.end.toISOString(),
    content: JSON.stringify(data),
  });
}

/** Apercu en direct, de la fin du dernier rapport jusqu'a maintenant — calcule a la demande, jamais stocke ni envoye. */
export async function computeLiveMorningReport(now: Date = new Date()): Promise<MorningReportData> {
  const { hour, nightStartHour } = config.morningReport;
  const window = dailyReportWindow(now, hour, nightStartHour, config.timezone);
  // Fenetre du PROCHAIN rapport: meme debut, meme debut de nuit (qui peut
  // encore etre dans le futur — la nuit compte alors simplement 0 email).
  const next = dailyReportWindow(new Date(window.end.getTime() + 25 * 3_600_000), hour, nightStartHour, config.timezone);
  return computeMorningReport({ reportDate: null, start: window.end, end: now, nightStart: next.nightStart, now });
}

// ---------- Reglages d'envoi (back-office) ----------

const SEND_ENABLED_KEY = "morning_report_send_enabled";
const RECIPIENTS_KEY = "morning_report_recipients";
const MAX_RECIPIENTS = 10;
const EMAIL_PATTERN = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

export interface MorningReportSendSettings {
  enabled: boolean;
  /** Vide = destinataire par defaut (NOTIFICATION_EMAIL, sinon la messagerie connectee). */
  recipients: string[];
}

export async function getMorningReportSendSettings(): Promise<MorningReportSendSettings> {
  const enabled = (await getAppSetting(SEND_ENABLED_KEY)) === "1";
  const raw = (await getAppSetting(RECIPIENTS_KEY)) ?? "";
  return { enabled, recipients: raw ? raw.split(",").filter(Boolean) : [] };
}

/** Lance une erreur lisible (affichee telle quelle dans /rapport) si une adresse est invalide. */
export function parseRecipients(raw: string): string[] {
  const list = raw
    .split(/[\s,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const unique = [...new Set(list)];
  const invalid = unique.filter((email) => !EMAIL_PATTERN.test(email));
  if (invalid.length) throw new Error(`Adresse(s) invalide(s) : ${invalid.join(", ")}`);
  if (unique.length > MAX_RECIPIENTS) throw new Error(`${MAX_RECIPIENTS} destinataires maximum.`);
  return unique;
}

export async function saveMorningReportSendSettings(settings: MorningReportSendSettings): Promise<void> {
  await setAppSetting(SEND_ENABLED_KEY, settings.enabled ? "1" : "0");
  await setAppSetting(RECIPIENTS_KEY, settings.recipients.join(","));
}

// ---------- Envoi ----------

export type MorningReportSendOutcome = "sent" | "partial" | "failed" | "shadow" | "disabled" | "already" | "late";

/**
 * Envoie le rapport s'il doit l'etre, au plus une fois — garde-fous dans
 * l'ordre: mode silencieux (jamais d'envoi), interrupteur du back-office,
 * deja reserve/envoye, trop tard (voir config.morningReport.sendCutoffHours),
 * puis reservation atomique en base avant tout envoi reel.
 */
export async function sendMorningReportIfDue(
  row: MorningReportRow,
  getConnector: () => EmailConnector,
  now: Date = new Date()
): Promise<MorningReportSendOutcome> {
  if (config.shadowModeEnabled) return "shadow";
  const settings = await getMorningReportSendSettings();
  if (!settings.enabled) return "disabled";
  if (row.send_claimed_at) return "already";
  const cutoff = new Date(row.period_end).getTime() + config.morningReport.sendCutoffHours * 3_600_000;
  if (now.getTime() > cutoff) return "late";
  if (!(await claimMorningReportSend(row.id))) return "already";

  const sentTo: string[] = [];
  const errors: string[] = [];
  try {
    const connector = getConnector();
    const recipients = settings.recipients.length
      ? settings.recipients
      : [config.notificationEmail || (await connector.getOwnEmailAddress())];
    const data = parseMorningReportContent(row);
    const subject = buildMorningReportSubject(data);
    const bodyText = renderMorningReportText(data);
    for (const to of recipients) {
      try {
        const sent = await connector.sendNotification({ to, subject, bodyText });
        // Meme precaution que pour les rappels internes: la copie "Envoyes"
        // ne doit pas etre prise pour un envoi a froid (voir aussi le
        // garde-fou sur le prefixe dans discoverOutbound.ts).
        if (sent.id) await markMessageProcessed(sent.id, sent.id);
        sentTo.push(to);
      } catch (err) {
        errors.push(`${to}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    errors.push((err as Error).message);
  }

  const error = errors.length ? errors.join(" | ") : null;
  await recordMorningReportSendResult(row.id, { sentTo, error });
  if (error) {
    await recordPipelineError("morning_report", null, `Envoi du rapport du ${row.report_date}: ${error}`);
  }
  if (!error) return "sent";
  return sentTo.length ? "partial" : "failed";
}

/** Point d'entree du planificateur (9 h + rattrapage au demarrage): genere le rapport du jour s'il manque, puis l'envoie si c'est du. */
export async function runMorningReport(
  now: Date = new Date(),
  getConnector: () => EmailConnector = createEmailConnector
): Promise<MorningReportSendOutcome> {
  const row = await generateDailyMorningReport(now);
  return sendMorningReportIfDue(row, getConnector, now);
}

// ---------- Rendu texte (email) ----------

const URGENCY_LABELS: Record<string, string> = { low: "faible", normal: "normale", high: "haute" };

const NEEDS_HUMAN_LABELS: Record<NeedsHumanReason, string> = {
  overdue: "Délai promis dépassé",
  ai_error: "Échec IA, à traiter à la main",
  urgent: "Urgent, sans réponse",
};

export function needsHumanLabel(reason: NeedsHumanReason): string {
  return NEEDS_HUMAN_LABELS[reason];
}

function formatLocal(iso: string, options: Intl.DateTimeFormatOptions): string {
  return new Date(iso).toLocaleString("fr-FR", { timeZone: config.timezone, ...options });
}

export function formatReportDay(data: MorningReportData): string {
  return formatLocal(data.periodEnd, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

export function formatReportTime(iso: string): string {
  return formatLocal(iso, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function buildMorningReportSubject(data: MorningReportData): string {
  // Le prefixe doit rester EN TETE (voir INTERNAL_SUBJECT_PREFIXES, utils.ts).
  return `${MORNING_REPORT_SUBJECT_PREFIX} Rapport du matin — ${formatReportDay(data)}`;
}

function senderLabel(ref: ThreadRef): string {
  return ref.senderName ? `${ref.senderName} <${ref.senderEmail}>` : ref.senderEmail;
}

export function renderMorningReportText(data: MorningReportData): string {
  const sep = "--------------------------------------------------";
  const lines: string[] = [];
  const ackVerb = data.shadowMode ? "rédigés (mode silencieux, non envoyés)" : "envoyés";

  lines.push(`RAPPORT DU MATIN — ${formatReportDay(data).toUpperCase()}`);
  lines.push(`Période : du ${formatReportTime(data.periodStart)} au ${formatReportTime(data.periodEnd)}`);
  lines.push("");

  lines.push(sep, "EN BREF", sep);
  lines.push(`Emails reçus : ${data.received.total} (dont ${data.received.night} la nuit)`);
  lines.push(`Accusés ${ackVerb} : ${data.acknowledgements.count}`);
  lines.push(`À traiter par l'équipe : ${data.needsHuman.total}`);
  lines.push(`Relances client prévues dans les 24 h : ${data.pending.upcomingTotal}`);
  lines.push("");

  lines.push(sep, "EMAILS REÇUS PAR CATÉGORIE", sep);
  if (data.received.byCategory.length === 0) {
    lines.push("Aucun email classé sur la période.");
  } else {
    for (const row of data.received.byCategory) lines.push(`${row.label} : ${row.count}`);
  }
  if (data.received.aiErrors > 0) lines.push(`Non classés (échec IA) : ${data.received.aiErrors}`);
  lines.push("");

  lines.push(sep, "ACCUSÉS ET RELANCES", sep);
  lines.push(`Accusés de réception ${ackVerb} : ${data.acknowledgements.count}`);
  lines.push(`Sans accusé (pas nécessaire) : ${data.acknowledgements.skipped}`);
  if (data.shadowMode) {
    lines.push(`Relances client rédigées (non envoyées) : ${data.relances.testPreReply + data.relances.testPostReply}`);
  } else {
    lines.push(`Relances client envoyées avant notre réponse : ${data.relances.externalPreReply}`);
    lines.push(`Relances client envoyées après notre réponse : ${data.relances.externalPostReply}`);
  }
  lines.push(`Rappels envoyés à l'équipe : ${data.relances.internalSent}`);
  lines.push("");

  lines.push(sep, `À TRAITER PAR L'ÉQUIPE (${data.needsHuman.total})`, sep);
  if (data.needsHuman.total === 0) {
    lines.push("Rien en attente.");
  } else {
    for (const item of data.needsHuman.items) {
      const when = item.reason === "overdue" ? `échéance ${formatReportTime(item.since)}` : `reçu ${formatReportTime(item.since)}`;
      lines.push(`• ${needsHumanLabel(item.reason)} — ${item.subject}`);
      lines.push(`  ${senderLabel(item)} · ${item.categoryLabel} · urgence ${URGENCY_LABELS[item.urgency] ?? item.urgency} · ${when}`);
    }
    const rest = data.needsHuman.total - data.needsHuman.items.length;
    if (rest > 0) lines.push(`… et ${rest} autre(s), voir le back-office.`);
  }
  lines.push("");

  lines.push(sep, "SUIVIS EN COURS", sep);
  lines.push(`En attente d'une réponse de l'équipe : ${data.pending.awaitingTeam} (dont ${data.pending.awaitingTeamOverdue} en retard)`);
  lines.push(`En attente d'une réponse du client : ${data.pending.awaitingClient}`);
  if (data.pending.upcomingTotal > 0) {
    lines.push("");
    lines.push(`Relances client prévues dans les 24 h${data.shadowMode ? " (seront seulement rédigées, mode silencieux)" : ""} :`);
    for (const item of data.pending.upcoming) {
      lines.push(`• ${formatReportTime(item.fireAt)} — ${item.subject} (${senderLabel(item)})`);
    }
    const rest = data.pending.upcomingTotal - data.pending.upcoming.length;
    if (rest > 0) lines.push(`… et ${rest} autre(s).`);
  }

  if (data.pipelineErrors > 0) {
    lines.push("");
    lines.push(`⚠ ${data.pipelineErrors} erreur(s) technique(s) sur la période — voir le Journal du back-office.`);
  }

  return lines.join("\n");
}
