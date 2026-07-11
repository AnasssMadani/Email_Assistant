import { getValidGraphAccessToken } from "./graphAuth.js";
import type { EmailConnector, EmailMessage, EmailThread, SendReplyParams } from "../types.js";

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
}

async function graphFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getValidGraphAccessToken();
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: 'outlook.body-content-type="text"',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Microsoft Graph ${path} -> ${res.status}: ${await res.text()}`);
  }
  if (res.status === 202 || res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

function escapeODataString(value: string): string {
  return value.replace(/'/g, "''");
}

const MESSAGE_SELECT =
  "id,conversationId,subject,from,toRecipients,receivedDateTime,body,internetMessageId";

/**
 * Connecteur Microsoft Graph (Outlook / Microsoft 365).
 *
 * Utilise les permissions delegees (Mail.Read, Mail.Send, Mail.ReadWrite,
 * User.Read) obtenues via le flux OAuth de la page de connexion
 * (src/web/server.ts -> /auth/graph/*), donc toujours au nom du compte qui
 * s'est connecte — jamais un acces applicatif a l'ensemble du tenant.
 *
 * "threadId" correspond a conversationId cote Graph (il n'y a pas de notion
 * de thread separee comme chez Gmail). "rfcMessageId" correspond a
 * internetMessageId, l'equivalent Graph de l'en-tete RFC "Message-ID".
 */
export class GraphConnector implements EmailConnector {
  readonly name = "graph" as const;
  private ownEmailCache: string | null = null;

  async getOwnEmailAddress(): Promise<string> {
    if (this.ownEmailCache) return this.ownEmailCache;
    const me = await graphFetch<{ mail?: string; userPrincipalName: string }>(
      "/me?$select=mail,userPrincipalName"
    );
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
      subject: msg.subject ?? "(sans objet)",
      bodyText: msg.body?.content ?? msg.bodyPreview ?? "",
      receivedAt: new Date(msg.receivedDateTime),
      isFromUs: email.toLowerCase() === ownEmail.toLowerCase(),
    };
  }

  async listRecentInboxMessages(maxResults = 25): Promise<EmailMessage[]> {
    const ownEmail = await this.getOwnEmailAddress();
    const data = await graphFetch<{ value: GraphMessage[] }>(
      `/me/mailFolders/inbox/messages?$top=${maxResults}&$orderby=receivedDateTime desc&$select=${MESSAGE_SELECT}`
    );
    return data.value
      .map((m) => this.toEmailMessage(m, ownEmail))
      .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
  }

  async getThread(threadId: string): Promise<EmailThread> {
    const ownEmail = await this.getOwnEmailAddress();
    const filter = encodeURIComponent(`conversationId eq '${escapeODataString(threadId)}'`);
    const data = await graphFetch<{ value: GraphMessage[] }>(
      `/me/messages?$filter=${filter}&$orderby=receivedDateTime asc&$select=${MESSAGE_SELECT}`
    );
    return { id: threadId, messages: data.value.map((m) => this.toEmailMessage(m, ownEmail)) };
  }

  private async findLatestMessageId(conversationId: string): Promise<string> {
    const filter = encodeURIComponent(`conversationId eq '${escapeODataString(conversationId)}'`);
    const data = await graphFetch<{ value: { id: string }[] }>(
      `/me/messages?$filter=${filter}&$orderby=receivedDateTime desc&$top=1&$select=id`
    );
    const id = data.value[0]?.id;
    if (!id) {
      throw new Error(`Aucun message trouve pour la conversation ${conversationId}.`);
    }
    return id;
  }

  private async buildReplyDraft(params: SendReplyParams): Promise<string> {
    const originalId = await this.findLatestMessageId(params.threadId);
    const draft = await graphFetch<{ id: string }>(`/me/messages/${originalId}/createReply`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    await graphFetch(`/me/messages/${draft.id}`, {
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
    await graphFetch(`/me/messages/${draftId}/send`, { method: "POST" });
    return { id: draftId };
  }

  async createDraftReply(params: SendReplyParams): Promise<{ id: string }> {
    const draftId = await this.buildReplyDraft(params);
    return { id: draftId };
  }
}
