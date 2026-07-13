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
  deleteDraft(draftId: string): Promise<void>;
}

export interface CategoryConfig {
  id: string;
  label: string;
  slaHours: number;
  acknowledgeAutomatically: boolean;
}

export type RelanceChannel = "internal" | "external";

/**
 * Une etape d'une sequence de relance: se declenche a due_at + delayMinutes,
 * "internal" ne fait que journaliser un rappel, "external" envoie une
 * relance au demandeur. Une sequence appartient soit a une categorie
 * (comportement par defaut), soit a un dossier precis (surcharge qui
 * remplace entierement la sequence de la categorie pour ce dossier).
 * En minutes (pas en heures) pour permettre des delais courts en test
 * sans attendre des heures, tout en restant utilisable en production
 * (1440 = 1 jour).
 */
export interface RelanceStep {
  order: number;
  channel: RelanceChannel;
  delayMinutes: number;
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
