/**
 * Free, deterministic pre-filter — runs BEFORE any AI call. See
 * docs/architecture/refonte-plan.md "The cost model": this is the single biggest
 * cost lever (30-50% of inbound is typically bulk mail) precisely because it costs
 * zero tokens. Every match is logged to `prefilter_log` by the caller (see
 * packages/core/src/intake.ts) with the rule that fired, so a drop is auditable —
 * never a silent discard.
 *
 * Deliberately conservative: a rule only fires on strong, standard signals (List-*
 * headers, Auto-Submitted, well-known no-reply patterns). When unsure, this returns
 * `drop: false` and lets the (cheap) classifier decide — a missed spam email costs
 * a fraction of a cent; a wrongly dropped real client email is the actual failure
 * mode this must never cause.
 */

import type { EmailMessage } from "@global-link/shared";

export interface PrefilterResult {
  drop: boolean;
  rule?: string;
}

const NO_REPLY_PATTERN = /^(no-?reply|do-?not-?reply|noreply|mailer-daemon|postmaster)@/i;

/** Our own internal rappel notifications, sent to the connected mailbox itself — see CLAUDE.md "Rules carried over". Matched on sender identity by the caller (own mailbox address), this only checks the subject marker. */
const OWN_RAPPEL_SUBJECT_PREFIX = "[Rappel]";

export function evaluatePrefilter(message: Pick<EmailMessage, "subject" | "headers"> & { fromEmail: string }): PrefilterResult {
  const h = message.headers;

  if (message.subject.startsWith(OWN_RAPPEL_SUBJECT_PREFIX)) {
    // Final check (sender == own mailbox) is the caller's job — see intake.ts —
    // since this function has no notion of "our own address".
    return { drop: true, rule: "own_rappel_echo" };
  }

  if (h["list-unsubscribe"] || h["list-id"] || h["list-post"]) {
    return { drop: true, rule: "list_header" };
  }

  const precedence = h["precedence"]?.toLowerCase();
  if (precedence === "bulk" || precedence === "list" || precedence === "junk") {
    return { drop: true, rule: "precedence_bulk" };
  }

  const autoSubmitted = h["auto-submitted"]?.toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") {
    return { drop: true, rule: "auto_submitted" };
  }

  if (h["x-auto-response-suppress"]) {
    return { drop: true, rule: "auto_response_suppress" };
  }

  // Bounce/DSN reports: empty Return-Path, or the standard DSN content type.
  if (h["return-path"] === "<>" || h["content-type"]?.includes("report-type=delivery-status")) {
    return { drop: true, rule: "bounce_or_dsn" };
  }

  if (h["content-type"]?.includes("report-type=disposition-notification")) {
    return { drop: true, rule: "read_receipt" };
  }

  if (NO_REPLY_PATTERN.test(message.fromEmail)) {
    return { drop: true, rule: "no_reply_sender" };
  }

  if (h["content-class"] === "urn:content-classes:calendarmessage" || h["content-type"]?.includes("text/calendar")) {
    return { drop: true, rule: "calendar_invite" };
  }

  return { drop: false };
}
