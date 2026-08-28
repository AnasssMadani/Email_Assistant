import { google, type gmail_v1 } from "googleapis";
import { ProviderError, ProviderRateLimitedError } from "@global-link/shared";
import { getAuthorizedClient } from "./gmailAuth.js";
import {
  extractPlainText,
  extractPrefilterHeaders,
  getHeader,
  hasAttachmentParts,
  parseAddress,
  buildRawMimeMessage,
} from "./mime.js";
import { withRateLimit } from "./rateLimiter.js";
import type {
  EmailConnector,
  EmailMessage,
  EmailThread,
  NotificationParams,
  SendReplyParams,
} from "@global-link/shared";

/** Ported from legacy/src/connectors/gmailConnector.ts — see that file's comments for the DRAFT-filtering and threading rationale, unchanged here. Now keyed by mailboxId instead of a single process-wide token file. */
export class GmailConnector implements EmailConnector {
  readonly name = "gmail" as const;
  private gmailPromise: Promise<gmail_v1.Gmail> | null = null;
  private ownEmailCache: string | null = null;

  constructor(private readonly mailboxId: string) {}

  private async getGmail(): Promise<gmail_v1.Gmail> {
    if (!this.gmailPromise) {
      this.gmailPromise = getAuthorizedClient(this.mailboxId)
        .then((auth) => google.gmail({ version: "v1", auth }))
        .catch((err) => {
          this.gmailPromise = null;
          throw err;
        });
    }
    return this.gmailPromise;
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    return withRateLimit(this.mailboxId, "gmail", async () => {
      try {
        return await fn();
      } catch (err) {
        const status = (err as { code?: number; status?: number }).code ?? (err as { status?: number }).status;
        if (status === 429 || status === 403) {
          throw new ProviderRateLimitedError("gmail", undefined);
        }
        throw new ProviderError("gmail", (err as Error).message, err);
      }
    });
  }

  async getOwnEmailAddress(): Promise<string> {
    if (this.ownEmailCache) return this.ownEmailCache;
    const gmail = await this.getGmail();
    const profile = await this.call(() => gmail.users.getProfile({ userId: "me" }));
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
    const subject = getHeader(headers, "Subject") ?? "(no subject)";
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
      receivedAt: dateHeader ? new Date(dateHeader) : new Date(Number(msg.internalDate ?? Date.now())),
      isFromUs: from.email.toLowerCase() === ownEmail.toLowerCase(),
      hasAttachments: hasAttachmentParts(msg.payload),
      headers: extractPrefilterHeaders(headers),
    };
  }

  private async listByLabel(label: "INBOX" | "SENT", maxResults: number): Promise<EmailMessage[]> {
    const gmail = await this.getGmail();
    const ownEmail = await this.getOwnEmailAddress();
    const list = await this.call(() => gmail.users.messages.list({ userId: "me", labelIds: [label], maxResults }));

    const ids = list.data.messages ?? [];
    const messages: EmailMessage[] = [];
    for (const { id } of ids) {
      if (!id) continue;
      const full = await this.call(() => gmail.users.messages.get({ userId: "me", id, format: "full" }));
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
    const thread = await this.call(() => gmail.users.threads.get({ userId: "me", id: threadId, format: "full" }));
    const messages = (thread.data.messages ?? [])
      // threads.get() also returns DRAFT-labeled messages associated with the thread
      // (our own reply drafts, when that feature is enabled) — must be excluded
      // before comparing against automatedOutboundCount, or a draft inflates the
      // "real" message count and trips a false human-reply positive.
      .filter((m) => !m.labelIds?.includes("DRAFT"))
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
    const res = await this.call(() =>
      gmail.users.messages.send({ userId: "me", requestBody: { raw, threadId: params.threadId } })
    );
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
    const res = await this.call(() =>
      gmail.users.drafts.create({ userId: "me", requestBody: { message: { raw, threadId: params.threadId } } })
    );
    return { id: res.data.id ?? "" };
  }

  async deleteDraft(draftId: string): Promise<void> {
    const gmail = await this.getGmail();
    try {
      await this.call(() => gmail.users.drafts.delete({ userId: "me", id: draftId }));
    } catch (err) {
      if ((err as { status?: number }).status === 404) return;
      throw err;
    }
  }

  async markMessageUnread(messageId: string): Promise<void> {
    const gmail = await this.getGmail();
    await this.call(() =>
      gmail.users.messages.modify({ userId: "me", id: messageId, requestBody: { addLabelIds: ["UNREAD"] } })
    );
  }

  async sendNotification(params: NotificationParams): Promise<{ id: string }> {
    const gmail = await this.getGmail();
    const ownEmail = await this.getOwnEmailAddress();
    const raw = buildRawMimeMessage({ from: ownEmail, to: params.to, subject: params.subject, bodyText: params.bodyText });
    // No threadId: a standalone internal notification, not a reply in the client's thread.
    const res = await this.call(() => gmail.users.messages.send({ userId: "me", requestBody: { raw } }));
    return { id: res.data.id ?? "" };
  }
}
