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
  /** Vrai si le message contient au moins une piece jointe (PDF, etc.) — permet a une relance automatique d'y faire reference sans l'inventer. */
  hasAttachments: boolean;
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

export interface EmailConnector {
  readonly name: "gmail" | "graph";
  getOwnEmailAddress(): Promise<string>;
  listRecentInboxMessages(maxResults?: number): Promise<EmailMessage[]>;
  /** Messages envoyes par nous, y compris ceux qui n'ont jamais recu de message entrant (devis envoye a froid, etc.). */
  listRecentSentMessages(maxResults?: number): Promise<EmailMessage[]>;
  getThread(threadId: string): Promise<EmailThread>;
  sendReply(params: SendReplyParams): Promise<{ id: string }>;
  createDraftReply(params: SendReplyParams): Promise<{ id: string }>;
  deleteDraft(draftId: string): Promise<void>;
  /** Email autonome, hors fil client (pas de threadId) — utilise pour les notifications internes (rappels). */
  sendNotification(params: NotificationParams): Promise<{ id: string }>;
}

/**
 * Seuil d'urgence minimal (tel que classifie par Claude) a partir duquel un
 * rappel interne genere une vraie notification email plutot qu'une simple
 * ligne au Journal. "low" = toujours alerter (aucun filtre), "high" = alerter
 * uniquement sur les dossiers juges urgents — evite de notifier l'equipe pour
 * chaque demande banale restee sans reponse.
 */
export type UrgencyThreshold = "low" | "normal" | "high";

export interface CategoryConfig {
  id: string;
  label: string;
  slaHours: number;
  acknowledgeAutomatically: boolean;
  internalAlertsEnabled: boolean;
  internalAlertsMinUrgency: UrgencyThreshold;
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
  /** Un humain a envoye une reponse de fond (ex: le devis) — on attend maintenant la reponse DU CLIENT a ce message. */
  | "awaiting_client_reply"
  | "closed";
