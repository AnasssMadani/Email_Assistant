import { ProviderRateLimitedError } from "@global-link/shared";
import { getValidGraphAccessToken } from "./graphAuth.js";
import { withRateLimit, parseRetryAfterMs } from "./rateLimiter.js";
import type {
  EmailConnector,
  EmailMessage,
  EmailThread,
  NotificationParams,
  SendReplyParams,
} from "@global-link/shared";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

interface GraphEmailAddress {
  emailAddress?: { name?: string; address?: string };
}

interface GraphMessage {
  id: string;
  conversationId: string;
  subject?: string;
  from?: GraphEmailAddress;
  toRecipients?: GraphEmailAddress[];
  receivedDateTime: string;
  body?: { content?: string };
  bodyPreview?: string;
  internetMessageId?: string;
  hasAttachments?: boolean;
  isDraft?: boolean;
  internetMessageHeaders?: { name: string; value: string }[];
}

/** Same header set as packages/email's Gmail path (mime.ts extractPrefilterHeaders) — see packages/core/src/prefilter.ts. */
const PREFILTER_HEADER_NAMES = new Set([
  "list-unsubscribe",
  "list-id",
  "list-post",
  "precedence",
  "auto-submitted",
  "x-auto-response-suppress",
  "return-path",
  "content-type",
  "content-class",
]);

function extractPrefilterHeaders(headers: GraphMessage["internetMessageHeaders"]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const h of headers ?? []) {
    const key = h.name.toLowerCase();
    if (PREFILTER_HEADER_NAMES.has(key)) out[key] = h.value;
  }
  return out;
}

function escapeODataString(value: string): string {
  return value.replace(/'/g, "''");
}

const MESSAGE_SELECT =
  "id,conversationId,subject,from,toRecipients,receivedDateTime,body,internetMessageId,hasAttachments,isDraft,internetMessageHeaders";

/**
 * Ported from legacy/src/connectors/graphConnector.ts. "threadId" is Graph's
 * conversationId; "rfcMessageId" is internetMessageId. Now keyed by mailboxId
 * (delegated permissions, never app-wide tenant access) and rate-limited per
 * mailbox — see rateLimiter.ts for why Graph specifically needs this.
 */
export class GraphConnector implements EmailConnector {
  readonly name = "graph" as const;
  private ownEmailCache: string | null = null;

  constructor(private readonly mailboxId: string) {}

  private async graphFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
    return withRateLimit(this.mailboxId, "graph", async () => {
      const token = await getValidGraphAccessToken(this.mailboxId);
      const res = await fetch(`${GRAPH_BASE}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Prefer: 'outlook.body-content-type="text"',
          ...(init.headers ?? {}),
        },
      });
      if (res.status === 429 || res.status === 503) {
        throw new ProviderRateLimitedError("graph", parseRetryAfterMs(res.headers.get("Retry-After")));
      }
      if (!res.ok) {
        throw new Error(`Microsoft Graph ${path} -> ${res.status}: ${await res.text()}`);
      }
      if (res.status === 202 || res.status === 204) {
        return undefined as T;
      }
      return (await res.json()) as T;
    });
  }

  async getOwnEmailAddress(): Promise<string> {
    if (this.ownEmailCache) return this.ownEmailCache;
    const me = await this.graphFetch<{ mail?: string; userPrincipalName: string }>("/me?$select=mail,userPrincipalName");
    this.ownEmailCache = me.mail || me.userPrincipalName;
    return this.ownEmailCache;
  }

  private toEmailMessage(msg: GraphMessage, ownEmail: string): EmailMessage {
    const fromAddr = msg.from?.emailAddress;
    const email = fromAddr?.address ?? "";
    return {
      id: msg.id,
      threadId: msg.conversationId,
      rfcMessageId: msg.internetMessageId,
      from: { name: fromAddr?.name, email },
      to: (msg.toRecipients ?? [])
        .map((r) => ({ name: r.emailAddress?.name, email: r.emailAddress?.address ?? "" }))
        .filter((a) => a.email),
      subject: msg.subject ?? "(no subject)",
      bodyText: msg.body?.content ?? msg.bodyPreview ?? "",
      receivedAt: new Date(msg.receivedDateTime),
      isFromUs: email.toLowerCase() === ownEmail.toLowerCase(),
      hasAttachments: msg.hasAttachments ?? false,
      headers: extractPrefilterHeaders(msg.internetMessageHeaders),
    };
  }

  private async listByFolder(folder: "inbox" | "sentitems", maxResults: number): Promise<EmailMessage[]> {
    const ownEmail = await this.getOwnEmailAddress();
    const data = await this.graphFetch<{ value: GraphMessage[] }>(
      `/me/mailFolders/${folder}/messages?$top=${maxResults}&$orderby=receivedDateTime desc&$select=${MESSAGE_SELECT}`
    );
    return data.value.map((m) => this.toEmailMessage(m, ownEmail)).sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
  }

  async listRecentInboxMessages(maxResults = 25): Promise<EmailMessage[]> {
    return this.listByFolder("inbox", maxResults);
  }

  async listRecentSentMessages(maxResults = 25): Promise<EmailMessage[]> {
    return this.listByFolder("sentitems", maxResults);
  }

  async getThread(threadId: string): Promise<EmailThread> {
    const ownEmail = await this.getOwnEmailAddress();
    const filter = encodeURIComponent(`conversationId eq '${escapeODataString(threadId)}'`);
    // No $orderby combined with $filter on conversationId — Graph rejects that
    // combination on some mailboxes ("InefficientFilter"); sort client-side instead.
    const data = await this.graphFetch<{ value: GraphMessage[] }>(`/me/messages?$filter=${filter}&$select=${MESSAGE_SELECT}`);
    const messages = data.value
      .filter((m) => !m.isDraft)
      .map((m) => this.toEmailMessage(m, ownEmail))
      .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
    return { id: threadId, messages };
  }

  private async findLatestMessageId(conversationId: string): Promise<string> {
    const filter = encodeURIComponent(`conversationId eq '${escapeODataString(conversationId)}'`);
    const data = await this.graphFetch<{ value: { id: string; receivedDateTime: string; isDraft?: boolean }[] }>(
      `/me/messages?$filter=${filter}&$select=id,receivedDateTime,isDraft`
    );
    const latest = data.value
      .filter((m) => !m.isDraft)
      .reduce<{ id: string; receivedDateTime: string } | undefined>(
        (acc, m) => (!acc || new Date(m.receivedDateTime).getTime() > new Date(acc.receivedDateTime).getTime() ? m : acc),
        undefined
      );
    if (!latest) {
      throw new Error(`No message found for conversation ${conversationId}.`);
    }
    return latest.id;
  }

  private async buildReplyDraft(params: SendReplyParams): Promise<string> {
    const originalId = await this.findLatestMessageId(params.threadId);
    const draft = await this.graphFetch<{ id: string }>(`/me/messages/${originalId}/createReply`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    await this.graphFetch(`/me/messages/${draft.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        subject: params.subject,
        body: { contentType: "Text", content: params.bodyText },
        toRecipients: [{ emailAddress: { address: params.to } }],
      }),
    });
    return draft.id;
  }

  async sendReply(params: SendReplyParams): Promise<{ id: string }> {
    const draftId = await this.buildReplyDraft(params);
    await this.graphFetch(`/me/messages/${draftId}/send`, { method: "POST" });
    return { id: draftId };
  }

  async createDraftReply(params: SendReplyParams): Promise<{ id: string }> {
    const draftId = await this.buildReplyDraft(params);
    return { id: draftId };
  }

  async deleteDraft(draftId: string): Promise<void> {
    try {
      await this.graphFetch(`/me/messages/${draftId}`, { method: "DELETE" });
    } catch (err) {
      if ((err as Error).message.includes("-> 404:")) return;
      throw err;
    }
  }

  async markMessageUnread(messageId: string): Promise<void> {
    await this.graphFetch(`/me/messages/${messageId}`, { method: "PATCH", body: JSON.stringify({ isRead: false }) });
  }

  async sendNotification(params: NotificationParams): Promise<{ id: string }> {
    await this.graphFetch("/me/sendMail", {
      method: "POST",
      body: JSON.stringify({
        message: {
          subject: params.subject,
          body: { contentType: "Text", content: params.bodyText },
          toRecipients: [{ emailAddress: { address: params.to } }],
        },
      }),
    });
    return { id: "" };
  }
}
