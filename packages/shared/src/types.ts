/**
 * Cross-cutting domain types shared by packages/email (adapters), packages/core
 * (pipeline), packages/ai (prompts) and apps/worker — ported from the legacy app's
 * `src/types.ts`, kept intentionally unchanged where the semantics are load-bearing
 * (see the `isFromUs` note below).
 */

export interface EmailAddress {
  name?: string;
  email: string;
}

export interface EmailMessage {
  id: string;
  threadId: string;
  /** RFC "Message-ID" header, for In-Reply-To/References threading — distinct from the provider's internal id. */
  rfcMessageId?: string;
  from: EmailAddress;
  to: EmailAddress[];
  subject: string;
  bodyText: string;
  receivedAt: Date;
  /**
   * Set by the connector by comparing the sender address to our own mailbox address —
   * NEVER by classification or any other content-based inference. Any view that shows
   * raw thread history must read this field to distinguish "sent by us" from "received
   * from the client", never infer it from text.
   */
  isFromUs: boolean;
  /** True if the message has at least one attachment — lets a relance reference it without inventing content. */
  hasAttachments: boolean;
  /**
   * Lower-cased header name → value, for the small set of headers the free
   * pre-filter needs (List-Unsubscribe, Precedence, Auto-Submitted, ...) — see
   * packages/core/src/prefilter.ts. NOT a full raw-header dump; connectors populate
   * only what prefilter.ts reads, to keep parsing cheap on every message.
   */
  headers: Record<string, string | undefined>;
}

export interface EmailThread {
  id: string;
  messages: EmailMessage[];
}

export interface SendReplyParams {
  threadId: string;
  to: string;
  subject: string;
  bodyText: string;
  inReplyToMessageId?: string;
}

export interface NotificationParams {
  to: string;
  subject: string;
  bodyText: string;
}

/**
 * Port implemented by packages/email's gmail/graph adapters. Pipeline code
 * (packages/core) depends only on this interface, never on googleapis or
 * @microsoft/microsoft-graph-client directly.
 */
export interface EmailConnector {
  readonly name: "gmail" | "graph";
  getOwnEmailAddress(): Promise<string>;
  listRecentInboxMessages(maxResults?: number): Promise<EmailMessage[]>;
  listRecentSentMessages(maxResults?: number): Promise<EmailMessage[]>;
  getThread(threadId: string): Promise<EmailThread>;
  sendReply(params: SendReplyParams): Promise<{ id: string }>;
  createDraftReply(params: SendReplyParams): Promise<{ id: string }>;
  deleteDraft(draftId: string): Promise<void>;
  sendNotification(params: NotificationParams): Promise<{ id: string }>;
  markMessageUnread(messageId: string): Promise<void>;
}

export type UrgencyThreshold = "low" | "normal" | "high";

export type RelanceChannel = "internal" | "external";

export type RelancePhase = "pre_reply" | "post_reply";

/** Fires at anchor time + delayMinutes. Delays within one sequence must be strictly increasing (see CLAUDE.md). */
export interface RelanceStep {
  order: number;
  channel: RelanceChannel;
  delayMinutes: number;
}

export type AckMode = "template" | "ai";

export interface ClassificationResult {
  categoryId: string;
  urgency: "low" | "normal" | "high";
  summary: string;
  requiresAcknowledgement: boolean;
  /** Reply language, decided by the classifier rather than a separate drafting-time instruction — see refonte-plan.md cost model. */
  language: "fr" | "en";
}

export type ThreadStatus =
  | "received"
  | "skipped"
  | "ack_sent"
  | "responded"
  | "relance_sent"
  | "awaiting_client_reply"
  | "post_reply_relance_sent"
  | "closed";
