export interface EmailAddress {
  name?: string;
  email: string;
}

export interface EmailMessage {
  id: string;
  threadId: string;
  /** Valeur de l'en-tete RFC "Message-ID" (utilisee pour le chainage In-Reply-To/References), distincte de l'id interne du fournisseur. */
  rfcMessageId?: string;
  from: EmailAddress;
  to: EmailAddress[];
  subject: string;
  bodyText: string;
  receivedAt: Date;
  isFromUs: boolean;
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

export interface EmailConnector {
  readonly name: "gmail" | "graph";
  getOwnEmailAddress(): Promise<string>;
  listRecentInboxMessages(maxResults?: number): Promise<EmailMessage[]>;
  getThread(threadId: string): Promise<EmailThread>;
  sendReply(params: SendReplyParams): Promise<{ id: string }>;
  createDraftReply(params: SendReplyParams): Promise<{ id: string }>;
}

export interface CategoryConfig {
  id: string;
  label: string;
  slaHours: number;
  acknowledgeAutomatically: boolean;
  allowExternalRelance: boolean;
}

export interface RelanceConfig {
  internalReminderAfterHours: number;
  externalRelanceAfterHours: number;
  maxRelances: number;
}

export interface CategoriesFile {
  categories: CategoryConfig[];
  relance: RelanceConfig;
}

export interface ClassificationResult {
  categoryId: string;
  urgency: "low" | "normal" | "high";
  summary: string;
  requiresAcknowledgement: boolean;
}

export interface ReplyDraft {
  variant: "A" | "B" | "C";
  label: string;
  subject: string;
  body: string;
}

export type ThreadStatus =
  | "received"
  | "skipped"
  | "ack_sent"
  | "drafts_ready"
  | "responded"
  | "relance_sent"
  | "closed";
