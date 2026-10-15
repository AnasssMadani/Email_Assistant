import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { freshTestDb } from "./_pgTestDb.js";
import { READ_METHODS, recordingConnector } from "./_recordingConnector.js";

// Regle n°1: la boite du client est en LECTURE SEULE. On ne marque rien
// comme lu/non lu, on ne deplace rien, on ne supprime rien, on ne depose
// aucun brouillon. Seuls deux envois sont permis (accuse/relance dans le
// fil, rappel interne), qui ajoutent un message a "Envoyes" sans toucher
// aux messages existants. Ces tests appellent CHAQUE methode des deux
// connecteurs reels, contre une API simulee qui journalise toute requete.

const tokenDir = mkdtempSync(path.join(tmpdir(), "readonly-"));
const graphTokenPath = path.join(tokenDir, "graph-token.json");
writeFileSync(graphTokenPath, JSON.stringify({ access_token: "tok", refresh_token: "r", expires_at: Date.now() + 3_600_000 }));
process.env.AZURE_CLIENT_ID = "test-client";
process.env.AZURE_CLIENT_SECRET = "test-secret";
process.env.AZURE_TOKEN_PATH = graphTokenPath;

delete process.env.SHADOW_MODE; // envois reels: on verifie qu'ils restent les seules ecritures
const db = await freshTestDb(); // GmailConnector.listByLabel interroge aussi isMessageProcessed
const { processIncomingMessage } = await import("../src/pipeline/processIncoming.js");
const { setClientForTesting } = await import("../src/ai/client.js");
const { GraphConnector } = await import("../src/connectors/graphConnector.js");
const { GmailConnector } = await import("../src/connectors/gmailConnector.js");
const { GRAPH_SCOPES } = await import("../src/connectors/graphAuth.js");
const { GMAIL_SCOPES } = await import("../src/connectors/gmailAuth.js");

const ALLOWED_CONNECTOR_METHODS = [
  "constructor",
  "getOwnEmailAddress",
  "listRecentInboxMessages",
  "listRecentSentMessages",
  "getThread",
  "sendReply",
  "sendNotification",
];

async function exerciseConnector(connector: InstanceType<typeof GraphConnector> | InstanceType<typeof GmailConnector>) {
  await connector.getOwnEmailAddress();
  await connector.listRecentInboxMessages(5);
  await connector.listRecentSentMessages(5);
  await connector.getThread("conv-1");
  await connector.sendReply({
    threadId: "conv-1",
    to: "client@example.com",
    subject: "Re: Devis",
    bodyText: "Bien recu.",
    inReplyToMessageId: "<m1@example.com>",
  });
  await connector.sendNotification({ to: "team@example.com", subject: "[Rappel] x", bodyText: "y" });
}

test("connectors expose no method beyond reading and the two allowed sends", () => {
  for (const cls of [GraphConnector, GmailConnector]) {
    const publicMethods = Object.getOwnPropertyNames(cls.prototype).filter(
      (m) => typeof (cls.prototype as Record<string, unknown>)[m] === "function"
    );
    // Les methodes privees TypeScript restent visibles au runtime: on ne
    // tolere que les aides de lecture connues.
    const extra = publicMethods.filter(
      (m) => !ALLOWED_CONNECTOR_METHODS.includes(m) && !["getGmail", "toEmailMessage", "listByLabel", "listByFolder", "findLatestMessageId"].includes(m)
    );
    assert.deepEqual(extra, [], `${cls.name} expose une methode inattendue`);
  }
});

test("OAuth scopes requested never grant write access to existing mail", () => {
  assert.deepEqual([...GMAIL_SCOPES].sort(), [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
  ]);
  const graphScopes = GRAPH_SCOPES.split(" ");
  assert.ok(!graphScopes.some((s) => /ReadWrite/i.test(s)), GRAPH_SCOPES);
  assert.ok(graphScopes.includes("https://graph.microsoft.com/Mail.Read"));
  assert.ok(graphScopes.includes("https://graph.microsoft.com/Mail.Send"));
});

test("GraphConnector: only GETs, plus exactly one /reply and one /sendMail — no draft, no PATCH, no DELETE", async () => {
  const requests: { method: string; path: string }[] = [];
  const originalFetch = globalThis.fetch;
  const message = {
    id: "m1",
    conversationId: "conv-1",
    subject: "Devis",
    from: { emailAddress: { address: "client@example.com" } },
    toRecipients: [{ emailAddress: { address: "us@example.com" } }],
    receivedDateTime: new Date().toISOString(),
    body: { content: "Bonjour" },
    internetMessageId: "<m1@example.com>",
    hasAttachments: false,
    isDraft: false,
  };
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    requests.push({ method, path: url.pathname.replace("/v1.0", "") });
    if (method !== "GET") return new Response(null, { status: 202 });
    if (url.pathname.endsWith("/me")) return Response.json({ mail: "us@example.com", userPrincipalName: "us@example.com" });
    return Response.json({ value: [message] });
  }) as typeof fetch;

  try {
    await exerciseConnector(new GraphConnector());
  } finally {
    globalThis.fetch = originalFetch;
  }

  const writes = requests.filter((r) => r.method !== "GET");
  assert.deepEqual(writes, [
    { method: "POST", path: "/me/messages/m1/reply" },
    { method: "POST", path: "/me/sendMail" },
  ]);
  assert.ok(!requests.some((r) => /createReply|draft|\/move|\/copy/i.test(r.path)));
});

test("GmailConnector: only reads plus messages.send — no modify, trash, delete or drafts", async () => {
  const calls: string[] = [];
  const responses: Record<string, unknown> = {
    "users.getProfile": { data: { emailAddress: "us@example.com" } },
    "users.messages.list": { data: { messages: [{ id: "g1" }] } },
    "users.messages.get": {
      data: {
        id: "g1",
        threadId: "conv-1",
        payload: { headers: [{ name: "From", value: "client@example.com" }], mimeType: "text/plain", body: { data: "" } },
      },
    },
    "users.threads.get": { data: { messages: [] } },
    "users.messages.send": { data: { id: "sent-1" } },
  };
  // N'importe quel chemin (users.messages.modify, users.drafts.create,
  // users.messages.trash...) est intercepte et journalise par ce Proxy.
  const fakeApi = (pathSoFar: string[]): unknown =>
    new Proxy(() => {}, {
      get: (_t, prop) => (prop === "then" ? undefined : fakeApi([...pathSoFar, String(prop)])),
      apply: async () => {
        const key = pathSoFar.join(".");
        calls.push(key);
        return responses[key] ?? { data: {} };
      },
    });

  const connector = new GmailConnector();
  (connector as unknown as { gmailPromise: Promise<unknown> }).gmailPromise = Promise.resolve(fakeApi([]));
  await exerciseConnector(connector);

  const allowed = new Set(Object.keys(responses));
  assert.deepEqual(calls.filter((c) => !allowed.has(c)), []);
  assert.equal(calls.filter((c) => c === "users.messages.send").length, 2); // accuse + rappel
});

test("live mode: an accusé is one sendReply and nothing else — the client's email is never re-marked unread", async () => {
  setClientForTesting({
    messages: {
      async create(params: { tool_choice?: { name?: string } }) {
        const input =
          params.tool_choice?.name === "classify_email"
            ? { categoryId: "devis", urgency: "normal", summary: "Demande de devis", requiresAcknowledgement: true }
            : { subject: "Re: Devis", body: "Bien recu." };
        return {
          content: [{ type: "tool_use", id: "tu-1", name: params.tool_choice?.name, input }],
          usage: { input_tokens: 10, output_tokens: 10 },
        };
      },
    },
  } as unknown as Anthropic);

  const threadId = "t-live-ack";
  const message = {
    id: "t-live-ack-m1",
    threadId,
    rfcMessageId: "<t-live-ack@example.com>",
    from: { email: "client@example.com" },
    to: [{ email: "us@example.com" }],
    subject: "Devis",
    bodyText: "Combien coute un conteneur ?",
    receivedAt: new Date(),
    isFromUs: false,
    hasAttachments: false,
  };
  const { connector, calls } = recordingConnector({ id: threadId, messages: [message] });

  await processIncomingMessage(connector, message);

  assert.deepEqual(calls.filter((c) => !READ_METHODS.includes(c)), ["sendReply"]);
  assert.equal((await db.getThreadRow(threadId))?.status, "ack_sent");
});
