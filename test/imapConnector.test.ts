import { test, after } from "node:test";
import assert from "node:assert/strict";
import { ImapFlow } from "imapflow";
import { freshTestDb } from "./_pgTestDb.js";
import { startFakeImapServer, type FakeImapServer, type FakeMailbox } from "./_fakeImapServer.js";

const { markMessageProcessed, listSmtpSentMessages } = await freshTestDb();
const { ImapSmtpConnector } = await import("../src/connectors/imapConnector.js");
const { assertReadOnlyImapCommand, installReadOnlyGuard, ImapWriteBlockedError } = await import(
  "../src/connectors/imapReadOnlyGuard.js"
);
const { decodeImapThreadId, encodeImapThreadId, threadRootFromHeaders } = await import("../src/connectors/imapIds.js");
const { threadIdMatchesConnector } = await import("../src/pipeline/relanceCheck.js");

const OWN = "contact@globallink.ma";

/**
 * Seules commandes qu'un serveur IMAP doit JAMAIS recevoir du connecteur.
 * Volontairement redefinie ici (et non importee du garde-fou): le test doit
 * echouer si la liste blanche du code s'elargissait a une commande
 * d'ecriture.
 */
const READ_ONLY_WIRE_COMMANDS = new Set([
  "CAPABILITY",
  "ID",
  "LOGIN",
  "ENABLE",
  "NAMESPACE",
  "LIST",
  "LSUB",
  "EXAMINE",
  "FETCH",
  "UID FETCH",
  "SEARCH",
  "UID SEARCH",
  "NOOP",
  "LOGOUT",
]);

function mail(headers: Record<string, string>, body = "Bonjour,\r\nmerci.\r\n"): string {
  const lines = Object.entries({ Date: "Wed, 01 Oct 2026 10:00:00 +0000", ...headers }).map(([k, v]) => `${k}: ${v}`);
  return `${lines.join("\r\n")}\r\n\r\n${body}`;
}

function fixtureMailboxes(): Record<string, FakeMailbox> {
  return {
    INBOX: {
      uidValidity: 7,
      messages: [
        {
          uid: 101,
          raw: mail({
            From: '"Li Wei" <li.wei@shipper.cn>',
            To: OWN,
            Subject: "Demande de devis conteneur",
            "Message-ID": "<root-1@shipper.cn>",
          }),
        },
        {
          uid: 102,
          raw: [
            "From: Ayse <ayse@freight.tr>",
            `To: ${OWN}`,
            "Subject: Grille tarifaire",
            "Message-ID: <pj-1@freight.tr>",
            "Date: Wed, 01 Oct 2026 11:00:00 +0000",
            "MIME-Version: 1.0",
            'Content-Type: multipart/mixed; boundary="b1"',
            "",
            "--b1",
            "Content-Type: text/plain; charset=UTF-8",
            "",
            "Ci-joint notre grille.",
            "--b1",
            'Content-Type: application/pdf; name="grille.pdf"',
            'Content-Disposition: attachment; filename="grille.pdf"',
            "Content-Transfer-Encoding: base64",
            "",
            "JVBERi0xLjQK",
            "--b1--",
            "",
          ].join("\r\n"),
          bodyStructure:
            '(("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 22 1 NIL NIL NIL NIL)("APPLICATION" "PDF" ("NAME" "grille.pdf") NIL NIL "BASE64" 12 NIL ("ATTACHMENT" ("FILENAME" "grille.pdf")) NIL NIL) "MIXED" ("BOUNDARY" "b1") NIL NIL NIL)',
        },
        {
          // Reponse du client dans le fil 1 (References commence par la racine).
          uid: 103,
          raw: mail({
            From: "li.wei@shipper.cn",
            To: OWN,
            Subject: "Re: Demande de devis conteneur",
            "Message-ID": "<reply-2@shipper.cn>",
            "In-Reply-To": "<team-1@globallink.ma>",
            References: "<root-1@shipper.cn> <team-1@globallink.ma>",
            Date: "Thu, 02 Oct 2026 09:00:00 +0000",
          }),
          flags: ["\\Seen"],
        },
      ],
    },
    "INBOX.Sent": {
      uidValidity: 9,
      specialUse: "\\Sent",
      messages: [
        {
          // Reponse humaine envoyee depuis Roundcube (copie dans Envoyes).
          uid: 5,
          raw: mail({
            From: `Global Link <${OWN}>`,
            To: "li.wei@shipper.cn",
            Subject: "Re: Demande de devis conteneur",
            "Message-ID": "<team-1@globallink.ma>",
            "In-Reply-To": "<root-1@shipper.cn>",
            References: "<root-1@shipper.cn>",
            Date: "Wed, 01 Oct 2026 15:00:00 +0000",
          }),
          flags: ["\\Seen"],
        },
        {
          // Brouillon jamais envoye: ne doit pas compter comme message du fil.
          uid: 6,
          raw: mail({
            From: OWN,
            To: "li.wei@shipper.cn",
            Subject: "Re: Demande de devis conteneur",
            "Message-ID": "<draft-1@globallink.ma>",
            References: "<root-1@shipper.cn>",
          }),
          flags: ["\\Draft"],
        },
      ],
    },
  };
}

const servers: FakeImapServer[] = [];
after(async () => {
  for (const s of servers) await s.close();
});

let uidValiditySeed = 1000;

async function setup(options: { user?: string; mailboxAddress?: string; copyMailbox?: boolean } = {}) {
  // UIDVALIDITY distinct par test: les ids de message (dossier + UIDVALIDITY
  // + UID) restent uniques alors que la base de test est partagee par tout
  // le fichier (processed_messages, smtp_sent_messages).
  const mailboxes = fixtureMailboxes();
  if (options.copyMailbox) {
    // Boite copie: tout arrive dans sa boite de reception (redirection cPanel
    // pour les emails recus, Cci Roundcube pour les reponses de l'equipe),
    // et son propre dossier Envoyes reste vide.
    const sent = mailboxes["INBOX.Sent"].messages;
    mailboxes.INBOX.messages.push(...sent.filter((m) => !m.flags?.includes("\\Draft")).map((m) => ({ ...m, uid: m.uid + 200, flags: [] })));
    mailboxes["INBOX.Sent"].messages = [];
  }
  for (const mb of Object.values(mailboxes)) mb.uidValidity = ++uidValiditySeed;
  const server = await startFakeImapServer(mailboxes);
  servers.push(server);
  const sent: Record<string, unknown>[] = [];
  const connector = new ImapSmtpConnector({
    settings: {
      imap: {
        host: "127.0.0.1",
        port: server.port,
        secure: false,
        user: options.user ?? OWN,
        password: "test-password",
        mailboxAddress: options.mailboxAddress ?? "",
        inboxFolder: "INBOX",
        sentFolder: "",
        threadLookbackDays: 60,
        allowInsecureForTesting: true,
      },
      smtp: { host: "smtp.test", port: 465, secure: true, user: "", password: "", fromAddress: "" },
    },
    createTransport: () => ({
      async sendMail(message) {
        sent.push(message as Record<string, unknown>);
        return {};
      },
    }),
  });
  return { server, connector, sent };
}

function snapshotFlags(server: FakeImapServer): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(server.mailboxes).map(([name, mb]) => [name, mb.messages.map((m) => [m.uid, m.flags ?? []])])
    )
  );
}

function assertOnlyReadOnlyCommands(server: FakeImapServer): void {
  const offending = server.commands.filter((c) => !READ_ONLY_WIRE_COMMANDS.has(c.command));
  assert.deepEqual(offending, [], `commandes d'ecriture recues par le serveur: ${JSON.stringify(offending)}`);
  for (const c of server.commands.filter((c) => c.command === "FETCH" || c.command === "UID FETCH")) {
    const withoutPeek = c.line.toUpperCase().replace(/BODY\.PEEK\[/g, "").replace(/BINARY\.PEEK\[/g, "");
    assert.ok(!/BODY\[|BINARY\[|RFC822(\.TEXT)?(\s|\)|$)/.test(withoutPeek), `FETCH sans PEEK: ${c.line}`);
  }
}

// ---------- Garde-fou (unitaire) ----------

test("guard rejects every mailbox-writing IMAP command", () => {
  for (const command of [
    "SELECT",
    "STORE",
    "UID STORE",
    "COPY",
    "UID COPY",
    "MOVE",
    "UID MOVE",
    "APPEND",
    "EXPUNGE",
    "UID EXPUNGE",
    "CLOSE",
    "UNSELECT",
    "CREATE",
    "DELETE",
    "RENAME",
    "SUBSCRIBE",
    "UNSUBSCRIBE",
    "IDLE",
    "SETMETADATA",
  ]) {
    assert.throws(() => assertReadOnlyImapCommand(command), ImapWriteBlockedError, command);
  }
});

test("guard allows passive commands, and FETCH only with BODY.PEEK", () => {
  for (const command of ["CAPABILITY", "LOGIN", "EXAMINE", "LIST", "UID SEARCH", "NOOP", "LOGOUT"]) {
    assert.doesNotThrow(() => assertReadOnlyImapCommand(command));
  }
  const peek = [{ type: "SEQUENCE", value: "1:*" }, [{ type: "ATOM", value: "UID" }, { type: "ATOM", value: "BODY.PEEK", section: [] }]];
  assert.doesNotThrow(() => assertReadOnlyImapCommand("UID FETCH", peek));

  const body = [{ type: "SEQUENCE", value: "1" }, [{ type: "ATOM", value: "BODY", section: [] }]];
  assert.throws(() => assertReadOnlyImapCommand("UID FETCH", body), ImapWriteBlockedError);
  assert.throws(() => assertReadOnlyImapCommand("FETCH", [{ type: "SEQUENCE", value: "1" }, [{ type: "ATOM", value: "RFC822" }]]), ImapWriteBlockedError);
  assert.throws(() => assertReadOnlyImapCommand("FETCH", [{ type: "SEQUENCE", value: "1" }, { type: "ATOM", value: "BODY[TEXT]" }]), ImapWriteBlockedError);
});

test("guard stops write commands from a real imapflow client before they reach the server", async () => {
  const server = await startFakeImapServer(fixtureMailboxes());
  servers.push(server);
  const before = snapshotFlags(server);
  const client = new ImapFlow({
    host: "127.0.0.1",
    port: server.port,
    secure: false,
    doSTARTTLS: false,
    auth: { user: OWN, pass: "x" },
    logger: false,
    disableAutoIdle: true,
  });
  installReadOnlyGuard(client);
  await client.connect();
  // Une operation d'ecriture ne doit jamais aboutir: soit imapflow la
  // refuse lui-meme (boite ouverte en lecture seule -> false), soit le
  // garde-fou la rejette. Dans les deux cas, rien n'atteint le serveur
  // (verifie par assertOnlyReadOnlyCommands plus bas).
  const notPerformed = async (op: Promise<unknown>) => {
    const outcome = await op.then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    );
    if ("value" in outcome) assert.ok(!outcome.value, `operation d'ecriture reussie: ${JSON.stringify(outcome.value)}`);
  };
  try {
    // mailboxOpen sans readOnly = SELECT: refuse par le garde-fou.
    await assert.rejects(client.mailboxOpen("INBOX"), ImapWriteBlockedError);
    await client.mailboxOpen("INBOX", { readOnly: true });
    await notPerformed(client.messageFlagsAdd("1:*", ["\\Seen"]));
    await notPerformed(client.messageFlagsRemove("1:*", ["\\Seen"]));
    await notPerformed(client.messageDelete("1:*"));
    await notPerformed(client.messageMove("1:*", "INBOX.Sent"));
    await notPerformed(client.messageCopy("1:*", "INBOX.Sent"));
    await notPerformed(client.append("INBOX", "Subject: x\r\n\r\nx"));
    await notPerformed(client.mailboxCreate("Archive"));
    await notPerformed(client.mailboxDelete("INBOX.Sent"));
    await notPerformed(client.mailboxClose());

    // Et au niveau du point d'entree unique des commandes (ce qu'imapflow
    // emettrait si ses propres controles changeaient): rejet systematique.
    const exec = (client as unknown as { exec: (c: string, a?: unknown) => Promise<unknown> }).exec.bind(client);
    const atom = (value: string) => ({ type: "ATOM", value });
    const seq = { type: "SEQUENCE", value: "1:*" };
    const attempts: Array<[string, unknown]> = [
      ["SELECT", [atom("INBOX")]],
      ["STORE", [seq, atom("+FLAGS"), [atom("\\Seen")]]],
      ["UID STORE", [seq, atom("-FLAGS"), [atom("\\Seen")]]],
      ["COPY", [seq, atom("INBOX.Sent")]],
      ["UID MOVE", [seq, atom("INBOX.Sent")]],
      ["APPEND", [atom("INBOX"), { type: "LITERAL", value: "Subject: x\r\n\r\nx" }]],
      ["EXPUNGE", undefined],
      ["UID EXPUNGE", [seq]],
      ["CLOSE", undefined],
      ["DELETE", [atom("INBOX.Sent")]],
      // BODY[] sans PEEK poserait \Seen.
      ["FETCH", [seq, [atom("UID"), { type: "ATOM", value: "BODY", section: [] }]]],
    ];
    for (const [command, attributes] of attempts) {
      await assert.rejects(exec(command, attributes), ImapWriteBlockedError, command);
    }
  } finally {
    await client.logout();
  }
  assertOnlyReadOnlyCommands(server);
  assert.equal(snapshotFlags(server), before, "aucun drapeau ne doit avoir change");
});

// ---------- Connecteur de bout en bout contre le serveur factice ----------

test("reading inbox, sent folder and a thread issues only EXAMINE / UID SEARCH / BODY.PEEK and changes no flag", async () => {
  const { server, connector } = await setup();
  const before = snapshotFlags(server);

  const inbox = await connector.listRecentInboxMessages(25);
  const sentFolder = await connector.listRecentSentMessages(25);
  const thread = await connector.getThread(inbox[0].threadId);
  await connector.close();

  assert.equal(inbox.length, 3);
  assert.equal(sentFolder.length, 1, "le brouillon \\Draft est ignore");
  assert.ok(thread.messages.length > 0);

  assertOnlyReadOnlyCommands(server);
  const examines = server.commands.filter((c) => c.command === "EXAMINE");
  assert.ok(examines.length >= 3, "chaque dossier est ouvert par EXAMINE");
  assert.ok(server.commands.some((c) => c.command === "UID FETCH" && /BODY\.PEEK\[\]/i.test(c.line)));
  assert.ok(server.commands.some((c) => c.command === "LOGOUT"), "la session est fermee proprement");
  assert.equal(snapshotFlags(server), before, "lecture passive: aucun drapeau (\\Seen compris) ne change");
});

test("messages are mapped with stable ids, thread root, isFromUs and attachment flag", async () => {
  const { connector } = await setup();
  const inbox = await connector.listRecentInboxMessages(25);
  await connector.close();

  const [first, withPdf, clientReply] = inbox;
  assert.equal(first.from.email, "li.wei@shipper.cn");
  assert.equal(first.from.name, "Li Wei");
  assert.equal(first.subject, "Demande de devis conteneur");
  assert.equal(first.rfcMessageId, "<root-1@shipper.cn>");
  assert.equal(first.isFromUs, false);
  assert.equal(first.hasAttachments, false);
  assert.match(first.id, /^imap\./);
  assert.ok(threadIdMatchesConnector(first.threadId, "imap"));
  assert.ok(!threadIdMatchesConnector(first.threadId, "gmail"));
  assert.ok(!threadIdMatchesConnector(first.threadId, "graph"));
  assert.ok(!threadIdMatchesConnector("19f674320b53b27a", "imap"));

  assert.equal(withPdf.hasAttachments, true);
  assert.match(withPdf.bodyText, /Ci-joint notre grille/);

  // La reponse du client (References: <root-1> ...) rejoint le meme dossier.
  assert.equal(clientReply.threadId, first.threadId);
  assert.deepEqual(decodeImapThreadId(first.threadId), { kind: "root", rootMessageId: "<root-1@shipper.cn>" });
});

test("already-processed messages are not downloaded again", async () => {
  const { server, connector } = await setup();
  const all = await connector.listRecentInboxMessages(25);
  await markMessageProcessed(all[0].id, all[0].threadId);
  server.commands.length = 0;

  const again = await connector.listRecentInboxMessages(25);
  await connector.close();
  assert.deepEqual(
    again.map((m) => m.id),
    all.slice(1).map((m) => m.id)
  );
  const contentFetch = server.commands.find((c) => c.command === "UID FETCH");
  assert.ok(contentFetch && !/\b101\b/.test(contentFetch.line.split(" ").slice(0, 4).join(" ")));
});

test("copy-mailbox mode: logged in as a dedicated box, the team's Bcc'd reply still counts as ours", async () => {
  const { connector, server } = await setup({ user: "assistant@globallink.ma", mailboxAddress: OWN, copyMailbox: true });
  assert.equal(await connector.getOwnEmailAddress(), OWN);
  const inbox = await connector.listRecentInboxMessages(25);
  const thread = await connector.getThread(inbox[0].threadId);
  await connector.close();

  assert.equal(inbox.filter((m) => m.isFromUs).length, 1, "la reponse de l'equipe, recue en Cci, est reconnue comme la notre");
  assert.deepEqual(
    thread.messages.map((m) => [m.rfcMessageId, m.isFromUs]),
    [
      ["<root-1@shipper.cn>", false],
      ["<team-1@globallink.ma>", true],
      ["<reply-2@shipper.cn>", false],
    ]
  );
  assertOnlyReadOnlyCommands(server);
});

test("getThread gathers inbox + sent messages of the conversation, skipping drafts", async () => {
  const { connector } = await setup();
  const inbox = await connector.listRecentInboxMessages(25);
  const thread = await connector.getThread(inbox[0].threadId);
  await connector.close();

  assert.deepEqual(
    thread.messages.map((m) => [m.rfcMessageId, m.isFromUs]),
    [
      ["<root-1@shipper.cn>", false],
      ["<team-1@globallink.ma>", true],
      ["<reply-2@shipper.cn>", false],
    ]
  );
});

test("sendReply goes out over SMTP only, chains References from the thread root, and shows up in getThread", async () => {
  const { server, connector, sent } = await setup();
  const inbox = await connector.listRecentInboxMessages(25);
  const incoming = inbox[0];
  server.commands.length = 0;

  const { id } = await connector.sendReply({
    threadId: incoming.threadId,
    to: incoming.from.email,
    subject: `Re: ${incoming.subject}`,
    bodyText: "Nous accusons bonne reception de votre demande.",
    inReplyToMessageId: incoming.rfcMessageId,
  });
  assert.equal(server.commands.length, 0, "un envoi ne doit emettre aucune commande IMAP (pas d'APPEND dans Envoyes)");

  assert.equal(sent.length, 1);
  assert.equal(sent[0].messageId, id);
  assert.equal(sent[0].from, OWN);
  assert.equal(sent[0].inReplyTo, "<root-1@shipper.cn>");
  assert.deepEqual(sent[0].references, ["<root-1@shipper.cn>"]);
  assert.equal((await listSmtpSentMessages(incoming.threadId)).length, 1);

  const thread = await connector.getThread(incoming.threadId);
  await connector.close();
  const ours = thread.messages.filter((m) => m.rfcMessageId === id);
  assert.equal(ours.length, 1);
  assert.equal(ours[0].isFromUs, true);
  assertOnlyReadOnlyCommands(server);
});

test("a server-side copy of our own SMTP send is not counted twice", async () => {
  const { server, connector } = await setup();
  const inbox = await connector.listRecentInboxMessages(25);
  const incoming = inbox[0];
  const { id } = await connector.sendReply({
    threadId: incoming.threadId,
    to: incoming.from.email,
    subject: "Re: copie",
    bodyText: "Accuse.",
    inReplyToMessageId: incoming.rfcMessageId,
  });
  // Hebergeur qui conserverait malgre tout une copie dans Envoyes.
  server.mailboxes["INBOX.Sent"].messages.push({
    uid: 7,
    raw: mail({ From: OWN, To: incoming.from.email, Subject: "Re: copie", "Message-ID": id, References: "<root-1@shipper.cn>" }),
  });

  const thread = await connector.getThread(incoming.threadId);
  await connector.close();
  assert.equal(thread.messages.filter((m) => m.rfcMessageId === id).length, 1);
});

test("connector refuses to read a mailbox the server opened read-write despite EXAMINE", async () => {
  const { server, connector } = await setup();
  server.answerReadWrite = true;
  await assert.rejects(connector.listRecentInboxMessages(25), /lecture-ecriture/);
  await connector.close();
  assert.ok(!server.commands.some((c) => c.command === "UID FETCH"));
});

test("thread root derivation follows References, then In-Reply-To, then Message-ID", () => {
  assert.equal(
    threadRootFromHeaders({ messageId: "<c@x>", inReplyTo: "<b@x>", references: "<a@x> <b@x>" }),
    "<a@x>"
  );
  assert.equal(threadRootFromHeaders({ messageId: "<c@x>", inReplyTo: "<b@x>" }), "<b@x>");
  assert.equal(threadRootFromHeaders({ messageId: "c@x" }), "<c@x>");
  const single = encodeImapThreadId(undefined, { folder: "INBOX", uidValidity: "7", uid: 42 });
  assert.deepEqual(decodeImapThreadId(single), { kind: "single", ref: { folder: "INBOX", uidValidity: "7", uid: 42 } });
  assert.ok(/^[A-Za-z0-9._-]+$/.test(encodeImapThreadId("<a+b/c@x>", { folder: "INBOX", uidValidity: "1", uid: 1 })));
});
