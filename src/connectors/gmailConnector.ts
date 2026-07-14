import { google, type gmail_v1 } from "googleapis";
import { getAuthorizedClient } from "./gmailAuth.js";
import { extractPlainText, getHeader, hasAttachmentParts, parseAddress, buildRawMimeMessage } from "./mime.js";
import type {
  EmailConnector,
  EmailMessage,
  EmailThread,
  NotificationParams,
  SendReplyParams,
} from "../types.js";

export class GmailConnector implements EmailConnector {
  readonly name = "gmail" as const;
  private gmailPromise: Promise<gmail_v1.Gmail> | null = null;
  private ownEmailCache: string | null = null;

  private async getGmail(): Promise<gmail_v1.Gmail> {
    if (!this.gmailPromise) {
      this.gmailPromise = getAuthorizedClient()
        .then((auth) => google.gmail({ version: "v1", auth }))
        .catch((err) => {
          // Ne pas garder en cache un echec (ex: pas encore connecte au
          // demarrage) - sinon toute reconnexion ulterieure resterait
          // bloquee sur cette meme promesse rejetee indefiniment.
          this.gmailPromise = null;
          throw err;
        });
    }
    return this.gmailPromise;
  }

  async getOwnEmailAddress(): Promise<string> {
    if (this.ownEmailCache) return this.ownEmailCache;
    const gmail = await this.getGmail();
    const profile = await gmail.users.getProfile({ userId: "me" });
    this.ownEmailCache = profile.data.emailAddress ?? "";
    return this.ownEmailCache;
  }

  private toEmailMessage(msg: gmail_v1.Schema$Message, ownEmail: string): EmailMessage {
    const headers = msg.payload?.headers;
    const from = parseAddress(getHeader(headers, "From"));
    const toRaw = getHeader(headers, "To") ?? "";
    const to = toRaw
      .split(",")
      .map((t) => parseAddress(t))
      .filter((a) => a.email);
    const subject = getHeader(headers, "Subject") ?? "(sans objet)";
    const dateHeader = getHeader(headers, "Date");
    const bodyText = extractPlainText(msg.payload);

    return {
      id: msg.id ?? "",
      threadId: msg.threadId ?? "",
      rfcMessageId: getHeader(headers, "Message-ID"),
      from,
      to,
      subject,
      bodyText,
      receivedAt: dateHeader
        ? new Date(dateHeader)
        : new Date(Number(msg.internalDate ?? Date.now())),
      isFromUs: from.email.toLowerCase() === ownEmail.toLowerCase(),
      hasAttachments: hasAttachmentParts(msg.payload),
    };
  }

  private async listByLabel(label: "INBOX" | "SENT", maxResults: number): Promise<EmailMessage[]> {
    const gmail = await this.getGmail();
    const ownEmail = await this.getOwnEmailAddress();
    const list = await gmail.users.messages.list({
      userId: "me",
      labelIds: [label],
      maxResults,
    });

    const ids = list.data.messages ?? [];
    const messages: EmailMessage[] = [];
    for (const { id } of ids) {
      if (!id) continue;
      const full = await gmail.users.messages.get({ userId: "me", id, format: "full" });
      messages.push(this.toEmailMessage(full.data, ownEmail));
    }
    return messages.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
  }

  async listRecentInboxMessages(maxResults = 25): Promise<EmailMessage[]> {
    return this.listByLabel("INBOX", maxResults);
  }

  async listRecentSentMessages(maxResults = 25): Promise<EmailMessage[]> {
    return this.listByLabel("SENT", maxResults);
  }

  async getThread(threadId: string): Promise<EmailThread> {
    const gmail = await this.getGmail();
    const ownEmail = await this.getOwnEmailAddress();
    const thread = await gmail.users.threads.get({ userId: "me", id: threadId, format: "full" });
    const messages = (thread.data.messages ?? [])
      .map((m) => this.toEmailMessage(m, ownEmail))
      .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
    return { id: threadId, messages };
  }

  async sendReply(params: SendReplyParams): Promise<{ id: string }> {
    const gmail = await this.getGmail();
    const ownEmail = await this.getOwnEmailAddress();
    const raw = buildRawMimeMessage({
      from: ownEmail,
      to: params.to,
      subject: params.subject,
      bodyText: params.bodyText,
      inReplyToMessageId: params.inReplyToMessageId,
      references: params.inReplyToMessageId,
    });
    const res = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw, threadId: params.threadId },
    });
    return { id: res.data.id ?? "" };
  }

  async createDraftReply(params: SendReplyParams): Promise<{ id: string }> {
    const gmail = await this.getGmail();
    const ownEmail = await this.getOwnEmailAddress();
    const raw = buildRawMimeMessage({
      from: ownEmail,
      to: params.to,
      subject: params.subject,
      bodyText: params.bodyText,
      inReplyToMessageId: params.inReplyToMessageId,
      references: params.inReplyToMessageId,
    });
    const res = await gmail.users.drafts.create({
      userId: "me",
      requestBody: { message: { raw, threadId: params.threadId } },
    });
    return { id: res.data.id ?? "" };
  }

  async deleteDraft(draftId: string): Promise<void> {
    const gmail = await this.getGmail();
    try {
      await gmail.users.drafts.delete({ userId: "me", id: draftId });
    } catch (err) {
      // Deja envoye ou supprime manuellement par un agent: pas une erreur.
      if ((err as { status?: number }).status === 404) return;
      throw err;
    }
  }

  async sendNotification(params: NotificationParams): Promise<{ id: string }> {
    const gmail = await this.getGmail();
    const ownEmail = await this.getOwnEmailAddress();
    const raw = buildRawMimeMessage({
      from: ownEmail,
      to: params.to,
      subject: params.subject,
      bodyText: params.bodyText,
    });
    // Pas de threadId: c'est une notification autonome, pas une reponse dans
    // le fil du client — sinon elle apparaitrait melangee a sa conversation.
    const res = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
    return { id: res.data.id ?? "" };
  }
}
