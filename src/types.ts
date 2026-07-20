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
  // Determine par le connecteur (comparaison de l'adresse expediteur a la
  // notre propre adresse) — jamais par classifyEmail() ou toute autre
  // deduction IA a partir du contenu. Toute vue admin ou client qui affiche
  // un jour un email ou un historique de fil doit distinguer "envoye par
  // nous" de "recu du client" en lisant CE champ, pas en l'inferant du
  // texte. Aucune vue actuelle (Journal, dossiers, dashboard client) n'
  // affiche encore de contenu de message brut — les deux dashboards ne
  // montrent que des metadonnees de dossier et des rappels (toujours des
  // actions "nous"), donc la direction y est deja sans ambiguite par
  // construction ; cette regle s'applique a la prochaine vue qui affichera
  // un vrai historique de fil.
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
  /**
   * Remet un message a l'etat "non lu". Gmail et Graph marquent
   * automatiquement tout le fil comme lu des qu'on y envoie une reponse
   * (l'accuse automatique dans ce cas) — sans ce correctif, l'email du
   * client disparait visuellement de la liste des nouveaux messages non lus
   * de l'equipe alors que personne chez nous ne l'a reellement encore lu.
   */
  markMessageUnread(messageId: string): Promise<void>;
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
  /** Delai promis au client dans l'accuse de reception, en minutes (permet un reglage plus fin qu'en heures, coherent avec les etapes de relance deja en minutes). */
  slaMinutes: number;
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
  /** Relance PRE-reponse envoyee (personne chez nous n'a encore repondu de fond). Distinct de post_reply_relance_sent: les deux phases ne doivent jamais partager la meme valeur de statut, sinon l'UI ne peut plus savoir laquelle des deux sequences afficher. */
  | "relance_sent"
  /** Un humain a envoye une reponse de fond (ex: le devis) — on attend maintenant la reponse DU CLIENT a ce message, aucune relance post-reponse envoyee pour l'instant. */
  | "awaiting_client_reply"
  /** Relance POST-reponse envoyee (le client reste silencieux apres notre reponse de fond). */
  | "post_reply_relance_sent"
  | "closed";
