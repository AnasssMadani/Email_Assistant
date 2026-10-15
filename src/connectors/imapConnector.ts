import { randomUUID } from "node:crypto";
import { ImapFlow, type FetchMessageObject, type MessageStructureObject } from "imapflow";
import { simpleParser, type AddressObject } from "mailparser";
import nodemailer, { type SendMailOptions } from "nodemailer";
import { config } from "../config.js";
import { isMessageProcessed, listSmtpSentMessages, recordSmtpSentMessage } from "../db.js";
import { installReadOnlyGuard } from "./imapReadOnlyGuard.js";
import {
  decodeImapThreadId,
  encodeImapMessageId,
  encodeImapThreadId,
  normalizeMessageId,
  parseReferences,
  threadRootFromHeaders,
  type ImapMessageRef,
} from "./imapIds.js";
import type {
  EmailAddress,
  EmailConnector,
  EmailMessage,
  EmailThread,
  NotificationParams,
  SendReplyParams,
} from "../types.js";

export interface ImapSmtpSettings {
  imap: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    password: string;
    /** Adresse partagee surveillee, si differente de user (mode boite copie). Vide = smtp.fromAddress puis user. */
    mailboxAddress?: string;
    /** Domaines dont tout expediteur compte comme "nous". Vide = domaine de mailboxAddress s'il est renseigne. */
    ownDomains?: string[];
    inboxFolder: string;
    sentFolder: string;
    threadLookbackDays: number;
    /** Reserve aux tests (serveur IMAP factice en clair sur 127.0.0.1). */
    allowInsecureForTesting?: boolean;
  };
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    password: string;
    fromAddress: string;
  };
}

/** Sous-ensemble de nodemailer.Transporter reellement utilise — permet d'injecter un transport factice en test. */
export interface SmtpTransport {
  sendMail(message: SendMailOptions): Promise<unknown>;
  close?(): void;
}

/**
 * Taille maximale lue par message (BODY.PEEK[]<0.N>). Un devis arrive
 * souvent avec un PDF ou un Excel de plusieurs Mo, que le pipeline ne lit
 * jamais (voir CLAUDE.md, "Attachments") — et getThread relit chaque fil en
 * attente a chaque cycle. Le texte du message precede les pieces jointes
 * dans un multipart: 256 Ko suffisent largement pour l'en-tete et le corps
 * texte. La presence d'une piece jointe est deduite de BODYSTRUCTURE, pas de
 * ce contenu tronque.
 */
const MAX_SOURCE_BYTES = 256 * 1024;

/** Deconnexion apres inactivite: un connecteur neuf est cree a chaque cycle (scheduler.ts) et l'interface n'a pas de close() — sans ce delai, chaque cycle laisserait une session IMAP ouverte (Dovecot plafonne a ~10 connexions par utilisateur/IP). */
const IDLE_LOGOUT_MS = 5_000;

const FALLBACK_SENT_FOLDERS = ["INBOX.Sent", "Sent", "INBOX.Sent Items", "Sent Items", "Sent Messages"];

function settingsFromConfig(): ImapSmtpSettings {
  return { imap: { ...config.imap }, smtp: { ...config.smtp } };
}

/**
 * Connecteur IMAP (lecture) + SMTP (envoi) pour une boite classique
 * Roundcube/cPanel.
 *
 * REGLE N°1 — la boite est en lecture seule: les dossiers sont ouverts avec
 * EXAMINE (jamais SELECT), le contenu est lu avec BODY.PEEK[] (jamais
 * BODY[], qui poserait \Seen), et aucune commande STORE / COPY / MOVE /
 * APPEND / EXPUNGE / CLOSE / CREATE / DELETE n'est jamais emise. Un
 * garde-fou au niveau du client IMAP (imapReadOnlyGuard.ts) refuse en plus
 * toute commande hors liste blanche AVANT l'envoi reseau.
 *
 * Consequences assumees:
 * - Nos envois SMTP n'apparaissent pas dans la boite (pas de copie deposee
 *   dans "Envoyes": ce serait un APPEND). Ils sont donc memorises en base
 *   (smtp_sent_messages) et reinjectes dans getThread(), pour que le
 *   comptage automated_outbound_count fonctionne comme avec Gmail/Graph.
 */
export class ImapSmtpConnector implements EmailConnector {
  readonly name = "imap" as const;
  private readonly settings: ImapSmtpSettings;
  private readonly createTransport: () => SmtpTransport;

  private client: ImapFlow | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | null = null;
  private sentFolderCache: string | null | undefined = undefined;

  constructor(options: { settings?: ImapSmtpSettings; createTransport?: () => SmtpTransport } = {}) {
    this.settings = options.settings ?? settingsFromConfig();
    this.createTransport = options.createTransport ?? (() => this.defaultTransport());
  }

  /**
   * Adresse de la boite partagee surveillee (comparee pour isFromUs, et
   * "From" des envois). En mode "boite copie" (IMAP_USER = une boite dediee
   * qui recoit une copie de tout le courrier de l'adresse partagee via une
   * redirection cPanel), IMAP_MAILBOX_ADDRESS donne l'adresse partagee: les
   * reponses de l'equipe, recues en Cci dans la boite copie, sont alors bien
   * reconnues comme les notres.
   */
  async getOwnEmailAddress(): Promise<string> {
    return (this.settings.imap.mailboxAddress || this.settings.smtp.fromAddress || this.settings.imap.user).trim();
  }

  /**
   * Expediteur "de chez nous": l'adresse partagee elle-meme, ou une adresse
   * d'un de nos domaines (l'equipe repond depuis prenom@domaine, copie en Cci
   * dans la boite surveillee). Hors mode boite copie sans IMAP_OWN_DOMAINS,
   * seule l'adresse exacte compte, comme avant.
   */
  private isOwnSender(email: string | undefined, ownEmail: string): boolean {
    if (!email) return false;
    const sender = email.toLowerCase();
    if (sender === ownEmail.toLowerCase()) return true;
    const explicit = this.settings.imap.ownDomains ?? [];
    const domains = explicit.length > 0 ? explicit : this.settings.imap.mailboxAddress ? [ownEmail.split("@")[1]?.toLowerCase() ?? ""] : [];
    const senderDomain = sender.split("@")[1];
    return !!senderDomain && domains.filter(Boolean).includes(senderDomain);
  }

  // ---------- Session IMAP (une connexion, operations serialisees) ----------

  private assertConfigured(): void {
    const { host, user, password } = this.settings.imap;
    if (!host || !user || !password) {
      throw new Error("Connecteur IMAP non configure: renseignez IMAP_HOST, IMAP_USER et IMAP_PASSWORD.");
    }
  }

  private async connect(): Promise<ImapFlow> {
    if (this.client?.usable) return this.client;
    this.assertConfigured();
    const { host, port, secure, user, password, allowInsecureForTesting } = this.settings.imap;
    const client = new ImapFlow({
      host,
      port,
      secure,
      auth: { user, pass: password },
      logger: false,
      // IDLE n'a aucune utilite ici (scrutation par cron) et, faute de
      // support serveur, imapflow le remplace par une boucle de NOOP/SELECT.
      disableAutoIdle: true,
      ...(allowInsecureForTesting ? { doSTARTTLS: false } : {}),
    });
    // Installe AVANT connect(): meme LOGIN passe par le garde-fou.
    installReadOnlyGuard(client);
    // Sans ecouteur, une erreur socket asynchrone (coupure reseau, timeout
    // serveur) ferait planter tout le processus Node.
    client.on("error", (err: Error) => {
      console.error("[imap] erreur de connexion:", err.message);
      if (this.client === client) this.client = null;
    });
    client.on("close", () => {
      if (this.client === client) this.client = null;
    });
    await client.connect();
    this.client = client;
    return client;
  }

  private scheduleIdleLogout(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      void this.close();
    }, IDLE_LOGOUT_MS);
    this.idleTimer.unref();
  }

  /** Ferme la session IMAP (LOGOUT). Appelee automatiquement apres inactivite; exposee pour les tests et un arret propre. */
  async close(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const client = this.client;
    this.client = null;
    if (client?.usable) {
      try {
        await client.logout();
      } catch {
        client.close();
      }
    }
  }

  /** Serialise les operations: une seule boite ouverte (EXAMINE) a la fois par connexion. */
  private withImap<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      const client = await this.connect();
      try {
        return await fn(client);
      } finally {
        this.scheduleIdleLogout();
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** EXAMINE (lecture seule) — jamais SELECT. */
  private async examine(client: ImapFlow, folder: string) {
    const mailbox = await client.mailboxOpen(folder, { readOnly: true });
    if (mailbox.readOnly === false) {
      // EXAMINE ignore par le serveur: on n'en lit pas plus.
      throw new Error(`Le serveur IMAP a ouvert "${folder}" en lecture-ecriture malgre EXAMINE — lecture annulee.`);
    }
    return mailbox;
  }

  private async resolveSentFolder(client: ImapFlow): Promise<string | null> {
    if (this.settings.imap.sentFolder) return this.settings.imap.sentFolder;
    if (this.sentFolderCache !== undefined) return this.sentFolderCache;
    const folders = await client.list();
    const special = folders.find((f) => f.specialUse === "\\Sent");
    const byName = FALLBACK_SENT_FOLDERS.map((name) => folders.find((f) => f.path.toLowerCase() === name.toLowerCase())).find(
      (f) => !!f
    );
    this.sentFolderCache = special?.path ?? byName?.path ?? null;
    if (!this.sentFolderCache) {
      console.warn("[imap] dossier des messages envoyes introuvable — renseignez IMAP_SENT_FOLDER.");
    }
    return this.sentFolderCache;
  }

  // ---------- Conversion d'un message IMAP ----------

  private async toEmailMessage(
    folder: string,
    uidValidity: string,
    msg: FetchMessageObject,
    ownEmail: string
  ): Promise<FetchedMessage | null> {
    if (!msg.source) return null;
    const parsed = await simpleParser(msg.source, { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true });
    const ref: ImapMessageRef = { folder, uidValidity, uid: msg.uid };
    const rfcMessageId = normalizeMessageId(parsed.messageId);
    const root = threadRootFromHeaders({
      messageId: parsed.messageId,
      references: parsed.references,
      inReplyTo: parsed.inReplyTo,
    });
    const from = firstAddress(parsed.from);
    const bodyText = parsed.text?.trim()
      ? parsed.text
      : typeof parsed.html === "string"
        ? parsed.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
        : "";
    const message: EmailMessage = {
      id: encodeImapMessageId(ref),
      threadId: encodeImapThreadId(root, ref),
      rfcMessageId,
      from,
      to: allAddresses(parsed.to),
      subject: parsed.subject ?? "(sans objet)",
      bodyText,
      receivedAt: parsed.date ?? (msg.internalDate ? new Date(msg.internalDate) : new Date()),
      isFromUs: this.isOwnSender(from.email, ownEmail),
      hasAttachments: hasAttachmentNode(msg.bodyStructure),
    };
    const chain = [...parseReferences(parsed.references), normalizeMessageId(parsed.inReplyTo), rfcMessageId].filter(
      (id): id is string => !!id
    );
    return { message, chain };
  }

  /** UID FETCH lecture seule: BODY.PEEK[]<0.N> + BODYSTRUCTURE + FLAGS — jamais BODY[]. */
  private async fetchByUids(
    client: ImapFlow,
    folder: string,
    uidValidity: string,
    uids: number[],
    ownEmail: string
  ): Promise<FetchedMessage[]> {
    if (uids.length === 0) return [];
    const fetched: FetchMessageObject[] = [];
    for await (const msg of client.fetch(
      uids.join(","),
      { uid: true, flags: true, bodyStructure: true, internalDate: true, source: { maxLength: MAX_SOURCE_BYTES } },
      { uid: true }
    )) {
      fetched.push(msg);
    }
    const messages: FetchedMessage[] = [];
    for (const msg of fetched) {
      // Brouillon (\Draft) jamais envoye: meme raison que le filtre DRAFT
      // de GmailConnector.getThread (ne pas fausser le comptage isFromUs).
      if (msg.flags?.has("\\Draft")) continue;
      const message = await this.toEmailMessage(folder, uidValidity, msg, ownEmail);
      if (message) messages.push(message);
    }
    return messages;
  }

  private async listRecent(folder: string | "sent", maxResults: number): Promise<EmailMessage[]> {
    const ownEmail = await this.getOwnEmailAddress();
    return this.withImap(async (client) => {
      const path = folder === "sent" ? await this.resolveSentFolder(client) : folder;
      if (!path) return [];
      const mailbox = await this.examine(client, path);
      if (!mailbox.exists) return [];
      const uidValidity = mailbox.uidValidity.toString();
      // Les N derniers par numero de sequence (= ordre d'arrivee): FETCH
      // (UID) seul, sans contenu — puis on ne telecharge que ceux qui n'ont
      // pas deja ete traites (meme optimisation que GmailConnector.listByLabel).
      const start = Math.max(1, mailbox.exists - maxResults + 1);
      const candidateUids: number[] = [];
      for await (const msg of client.fetch(`${start}:*`, { uid: true })) {
        candidateUids.push(msg.uid);
      }
      const processed = await Promise.all(
        candidateUids.map((uid) => isMessageProcessed(encodeImapMessageId({ folder: path, uidValidity, uid })))
      );
      const uids = candidateUids.filter((_uid, i) => !processed[i]);
      const messages = (await this.fetchByUids(client, path, uidValidity, uids, ownEmail)).map((f) => f.message);
      return messages.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
    });
  }

  async listRecentInboxMessages(maxResults = 25): Promise<EmailMessage[]> {
    return this.listRecent(this.settings.imap.inboxFolder, maxResults);
  }

  async listRecentSentMessages(maxResults = 25): Promise<EmailMessage[]> {
    return this.listRecent("sent", maxResults);
  }

  async getThread(threadId: string): Promise<EmailThread> {
    const decoded = decodeImapThreadId(threadId);
    if (!decoded) throw new Error(`Id de fil IMAP invalide: ${threadId}`);
    const ownEmail = await this.getOwnEmailAddress();

    const mailboxMessages = await this.withImap(async (client) => {
      if (decoded.kind === "single") {
        const mailbox = await this.examine(client, decoded.ref.folder);
        if (mailbox.uidValidity.toString() !== decoded.ref.uidValidity) return [];
        const fetched = await this.fetchByUids(client, decoded.ref.folder, decoded.ref.uidValidity, [decoded.ref.uid], ownEmail);
        return fetched.map((f) => f.message);
      }

      const root = decoded.rootMessageId;
      const since = new Date(Date.now() - this.settings.imap.threadLookbackDays * 24 * 60 * 60 * 1000);
      const sentFolder = await this.resolveSentFolder(client);
      const folders = [this.settings.imap.inboxFolder, ...(sentFolder ? [sentFolder] : [])];
      const found: EmailMessage[] = [];
      for (const folder of folders) {
        const mailbox = await this.examine(client, folder);
        if (!mailbox.exists) continue;
        // UID SEARCH (lecture seule): tout message dont le Message-ID est la
        // racine, ou qui la cite dans References / In-Reply-To.
        const uids = await client.search(
          {
            since,
            or: [{ header: { "message-id": root } }, { header: { references: root } }, { header: { "in-reply-to": root } }],
          },
          { uid: true }
        );
        if (!uids || uids.length === 0) continue;
        const messages = await this.fetchByUids(client, folder, mailbox.uidValidity.toString(), uids, ownEmail);
        // SEARCH HEADER est une recherche de sous-chaine: on reverifie que
        // la racine figure exactement dans la chaine de ce message.
        found.push(...messages.filter((f) => f.chain.includes(root)).map((f) => f.message));
      }
      return found;
    });

    // Un meme message peut figurer dans INBOX et dans Envoyes (copie a
    // l'adresse partagee elle-meme): une seule occurrence par Message-ID,
    // comme le ferait Gmail.
    const seen = new Set<string>();
    const deduped = mailboxMessages.filter((m) => {
      if (!m.rfcMessageId) return true;
      if (seen.has(m.rfcMessageId)) return false;
      seen.add(m.rfcMessageId);
      return true;
    });

    // Nos propres envois automatiques (absents de la boite, voir en-tete de
    // classe). Si un serveur en conservait malgre tout une copie, on
    // l'ecarte pour ne pas la compter deux fois — un isFromUs en trop
    // ferait detecter une "reponse humaine" inexistante.
    const ourSends = await listSmtpSentMessages(threadId);
    const ourIds = new Set(ourSends.map((s) => s.rfc_message_id));
    const messages: EmailMessage[] = [
      ...deduped.filter((m) => !m.rfcMessageId || !ourIds.has(m.rfcMessageId)),
      ...ourSends.map(
        (s): EmailMessage => ({
          id: `imap.smtp.${Buffer.from(s.rfc_message_id).toString("base64url")}`,
          threadId,
          rfcMessageId: s.rfc_message_id,
          from: { email: ownEmail },
          to: [{ email: s.to_email }],
          subject: s.subject,
          bodyText: s.body_text,
          receivedAt: new Date(s.sent_at),
          isFromUs: true,
          hasAttachments: false,
        })
      ),
    ].sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());

    return { id: threadId, messages };
  }

  // ---------- Envoi SMTP (n'ecrit jamais dans la boite IMAP) ----------

  private defaultTransport(): SmtpTransport {
    const { host, port, secure, user, password } = this.settings.smtp;
    const authUser = user || this.settings.imap.user;
    const authPass = password || this.settings.imap.password;
    if (!host || !authUser || !authPass) {
      throw new Error("Connecteur SMTP non configure: renseignez SMTP_HOST (et SMTP_USER/SMTP_PASSWORD si differents de l'IMAP).");
    }
    return nodemailer.createTransport({ host, port, secure, auth: { user: authUser, pass: authPass } });
  }

  private newMessageId(ownEmail: string): string {
    const domain = ownEmail.split("@")[1] || "localhost";
    return `<ar.${randomUUID()}@${domain}>`;
  }

  /**
   * Aucun retry ici (comme sendReply Gmail/Graph): un timeout ambigu peut
   * avoir abouti cote serveur, et retenter risquerait un doublon chez le
   * client (contrainte permanente du projet, voir CLAUDE.md).
   */
  private async send(message: SendMailOptions): Promise<void> {
    const transport = this.createTransport();
    try {
      await transport.sendMail(message);
    } finally {
      transport.close?.();
    }
  }

  async sendReply(params: SendReplyParams): Promise<{ id: string }> {
    const ownEmail = await this.getOwnEmailAddress();
    const messageId = this.newMessageId(ownEmail);
    const decoded = decodeImapThreadId(params.threadId);
    const inReplyTo = normalizeMessageId(params.inReplyToMessageId);
    // References commence par la racine du fil: c'est elle que la reponse
    // du client reprendra en tete, et donc elle qui la rattachera a ce
    // meme dossier (voir threadRootFromHeaders).
    const references = [
      ...(decoded?.kind === "root" ? [decoded.rootMessageId] : []),
      ...(inReplyTo ? [inReplyTo] : []),
    ].filter((id, i, all) => all.indexOf(id) === i);

    await this.send({
      from: ownEmail,
      to: params.to,
      subject: params.subject,
      text: params.bodyText,
      messageId,
      ...(inReplyTo ? { inReplyTo } : {}),
      ...(references.length > 0 ? { references } : {}),
    });

    try {
      await recordSmtpSentMessage({
        rfcMessageId: messageId,
        threadId: params.threadId,
        toEmail: params.to,
        subject: params.subject,
        bodyText: params.bodyText,
        sentAt: new Date().toISOString(),
      });
    } catch (err) {
      // L'email est deja parti: surtout ne pas faire echouer l'appel (le
      // pipeline pourrait le considerer comme non envoye et recommencer).
      console.error(`[smtp] envoi ${messageId} reussi mais non memorise en base:`, err);
    }
    return { id: messageId };
  }

  async sendNotification(params: NotificationParams): Promise<{ id: string }> {
    const ownEmail = await this.getOwnEmailAddress();
    const messageId = this.newMessageId(ownEmail);
    await this.send({ from: ownEmail, to: params.to, subject: params.subject, text: params.bodyText, messageId });
    return { id: messageId };
  }
}

interface FetchedMessage {
  message: EmailMessage;
  /** Message-IDs cites par le message (References, In-Reply-To) + le sien — sert a confirmer son appartenance a un fil. */
  chain: string[];
}

function firstAddress(field: AddressObject | AddressObject[] | undefined): EmailAddress {
  return allAddresses(field)[0] ?? { email: "" };
}

function allAddresses(field: AddressObject | AddressObject[] | undefined): EmailAddress[] {
  const objects = Array.isArray(field) ? field : field ? [field] : [];
  return objects
    .flatMap((o) => o.value)
    .flatMap((a) => (a.group ? a.group : [a]))
    .map((a) => ({ name: a.name || undefined, email: a.address ?? "" }))
    .filter((a) => a.email);
}

/** Meme definition que hasAttachmentParts (mime.ts) pour Gmail: toute partie portant un nom de fichier. */
function hasAttachmentNode(node: MessageStructureObject | undefined): boolean {
  if (!node) return false;
  if (node.disposition?.toLowerCase() === "attachment") return true;
  if (node.dispositionParameters?.filename || node.parameters?.name) return true;
  return (node.childNodes ?? []).some((child) => hasAttachmentNode(child));
}

