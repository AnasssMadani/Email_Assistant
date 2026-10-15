import net from "node:net";

/**
 * Serveur IMAP factice, juste assez complet pour qu'imapflow s'y connecte
 * et que le connecteur IMAP y lise des messages. Son unique role dans les
 * tests: ENREGISTRER chaque commande recue sur le fil, pour prouver qu'aucune
 * commande d'ecriture (SELECT, STORE, COPY, MOVE, APPEND, EXPUNGE, CLOSE...)
 * n'atteint jamais le serveur. Toute commande inconnue est enregistree puis
 * acceptee (OK) — c'est l'assertion des tests qui la rejette, pas le serveur.
 */

export interface FakeMessage {
  uid: number;
  raw: string;
  flags?: string[];
  /** BODYSTRUCTURE brut (syntaxe IMAP) — par defaut un text/plain simple. */
  bodyStructure?: string;
}

export interface FakeMailbox {
  uidValidity: number;
  messages: FakeMessage[];
  specialUse?: string;
}

export interface RecordedCommand {
  tag: string;
  /** Nom de commande normalise, "UID FETCH" pour les variantes UID. */
  command: string;
  line: string;
}

export interface FakeImapServer {
  port: number;
  commands: RecordedCommand[];
  mailboxes: Record<string, FakeMailbox>;
  /** Simule un serveur qui ignorerait EXAMINE (repond READ-WRITE). */
  answerReadWrite: boolean;
  close(): Promise<void>;
}

const CAPABILITIES = "IMAP4rev1 LITERAL+ ID";

function defaultBodyStructure(raw: string): string {
  const body = raw.split(/\r?\n\r?\n/).slice(1).join("\r\n\r\n");
  return `("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "8BIT" ${Buffer.byteLength(body)} ${body.split("\n").length})`;
}

function headerValues(raw: string): string {
  const head = raw.split(/\r?\n\r?\n/)[0];
  return head
    .replace(/\r?\n[ \t]+/g, " ")
    .split(/\r?\n/)
    .filter((l) => /^(message-id|references|in-reply-to):/i.test(l))
    .join("\n");
}

/** "1:*", "3,5", "2:4" -> liste de nombres (bornee par max pour "*"). */
function expandSet(set: string, max: number): number[] {
  const out: number[] = [];
  for (const part of set.split(",")) {
    const [a, b] = part.split(":");
    const start = a === "*" ? max : Number(a);
    const end = b === undefined ? start : b === "*" ? max : Number(b);
    for (let n = Math.min(start, end); n <= Math.max(start, end); n++) out.push(n);
  }
  return out;
}

export async function startFakeImapServer(mailboxes: Record<string, FakeMailbox>): Promise<FakeImapServer> {
  const commands: RecordedCommand[] = [];
  const sockets = new Set<net.Socket>();
  const state: FakeImapServer = {
    port: 0,
    commands,
    mailboxes,
    answerReadWrite: false,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    let pendingLine = "";
    let literalRemaining = 0;
    let selected: string | null = null;

    const send = (text: string) => socket.write(text.endsWith("\r\n") ? text : `${text}\r\n`);
    send(`* OK [CAPABILITY ${CAPABILITIES}] Fake IMAP ready`);

    const handle = (line: string) => {
      const match = line.match(/^(\S+)\s+(\S+)(?:\s+([\s\S]*))?$/);
      if (!match) return;
      const [, tag, rawCmd, rest = ""] = match;
      let command = rawCmd.toUpperCase();
      let args = rest;
      if (command === "UID") {
        const sub = rest.match(/^(\S+)\s*([\s\S]*)$/);
        command = `UID ${sub?.[1].toUpperCase() ?? ""}`;
        args = sub?.[2] ?? "";
      }
      commands.push({ tag, command, line });
      const box = selected ? mailboxes[selected] : undefined;

      switch (command) {
        case "CAPABILITY":
          send(`* CAPABILITY ${CAPABILITIES}`);
          return send(`${tag} OK done`);
        case "LOGIN":
          return send(`${tag} OK [CAPABILITY ${CAPABILITIES}] logged in`);
        case "ID":
          send(`* ID NIL`);
          return send(`${tag} OK done`);
        case "LIST":
        case "LSUB":
          // LIST "" "" = demande du seul separateur hierarchique (RFC 3501).
          if (/""\s*""\s*$/.test(args)) {
            send(`* LIST (\\Noselect) "." ""`);
            return send(`${tag} OK done`);
          }
          for (const [name, mb] of Object.entries(mailboxes)) {
            send(`* ${command} (\\HasNoChildren${mb.specialUse ? ` ${mb.specialUse}` : ""}) "." "${name}"`);
          }
          return send(`${tag} OK done`);
        case "EXAMINE":
        case "SELECT": {
          const name = args.trim().replace(/^"|"$/g, "");
          const mb = mailboxes[name];
          if (!mb) return send(`${tag} NO no such mailbox`);
          selected = name;
          send(`* FLAGS (\\Seen \\Draft \\Deleted \\Flagged \\Answered)`);
          send(`* OK [PERMANENTFLAGS ()] none`);
          send(`* ${mb.messages.length} EXISTS`);
          send(`* 0 RECENT`);
          send(`* OK [UIDVALIDITY ${mb.uidValidity}] uids valid`);
          send(`* OK [UIDNEXT ${Math.max(0, ...mb.messages.map((m) => m.uid)) + 1}] next`);
          const mode = command === "EXAMINE" && !state.answerReadWrite ? "READ-ONLY" : "READ-WRITE";
          return send(`${tag} OK [${mode}] ${command} completed`);
        }
        case "FETCH":
        case "UID FETCH": {
          if (!box) return send(`${tag} BAD no mailbox`);
          const setMatch = args.match(/^(\S+)\s+([\s\S]*)$/);
          const set = setMatch?.[1] ?? "";
          const items = (setMatch?.[2] ?? "").toUpperCase();
          const byUid = command === "UID FETCH";
          const max = byUid ? Math.max(0, ...box.messages.map((m) => m.uid)) : box.messages.length;
          const wanted = new Set(expandSet(set, max));
          box.messages.forEach((msg, index) => {
            const seq = index + 1;
            if (!wanted.has(byUid ? msg.uid : seq)) return;
            const parts = [`UID ${msg.uid}`];
            if (items.includes("FLAGS")) parts.push(`FLAGS (${(msg.flags ?? []).join(" ")})`);
            if (items.includes("INTERNALDATE")) parts.push(`INTERNALDATE "01-Oct-2026 10:00:00 +0000"`);
            if (items.includes("BODYSTRUCTURE")) parts.push(`BODYSTRUCTURE ${msg.bodyStructure ?? defaultBodyStructure(msg.raw)}`);
            const peek = items.match(/BODY(?:\.PEEK)?\[\](?:<(\d+)\.(\d+)>)?/);
            let literal = "";
            if (peek) {
              const bytes = Buffer.from(msg.raw);
              const slice = peek[2] ? bytes.subarray(Number(peek[1]), Number(peek[1]) + Number(peek[2])) : bytes;
              const key = peek[1] ? `BODY[]<${peek[1]}>` : "BODY[]";
              literal = `${key} {${slice.length}}\r\n${slice.toString()}`;
            }
            // BODY[] sans PEEK marque le message comme lu (RFC 3501) — le
            // serveur factice l'applique vraiment, pour qu'un test puisse
            // aussi le constater sur l'etat des drapeaux.
            if (/BODY\[/.test(items) && !/BODY\.PEEK\[/.test(items)) {
              msg.flags = [...new Set([...(msg.flags ?? []), "\\Seen"])];
            }
            const head = parts.join(" ");
            send(`* ${seq} FETCH (${head}${literal ? ` ${literal}` : ""})`);
          });
          return send(`${tag} OK FETCH completed`);
        }
        case "SEARCH":
        case "UID SEARCH": {
          if (!box) return send(`${tag} BAD no mailbox`);
          const needle = args.match(/HEADER\s+\S+\s+"?(<[^"\s]+>)/i)?.[1];
          const hits = box.messages
            .map((m, i) => ({ m, seq: i + 1 }))
            .filter(({ m }) => !needle || headerValues(m.raw).toLowerCase().includes(needle.toLowerCase()))
            .map(({ m, seq }) => (command === "UID SEARCH" ? m.uid : seq));
          send(`* SEARCH${hits.length ? ` ${hits.join(" ")}` : ""}`);
          return send(`${tag} OK SEARCH completed`);
        }
        case "LOGOUT":
          send(`* BYE logging out`);
          send(`${tag} OK LOGOUT completed`);
          socket.end();
          return;
        default:
          // Commandes d'ecriture ou inattendues: enregistrees (c'est ce que
          // les tests verifient) puis acceptees sans effet.
          return send(`${tag} OK done`);
      }
    };

    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (literalRemaining > 0) {
          if (buffer.length < literalRemaining) return;
          pendingLine += buffer.subarray(0, literalRemaining).toString();
          buffer = buffer.subarray(literalRemaining);
          literalRemaining = 0;
          continue;
        }
        const eol = buffer.indexOf("\r\n");
        if (eol === -1) return;
        const piece = buffer.subarray(0, eol).toString();
        buffer = buffer.subarray(eol + 2);
        const literal = piece.match(/\{(\d+)(\+?)\}$/);
        if (literal) {
          pendingLine += piece.slice(0, -literal[0].length);
          literalRemaining = Number(literal[1]);
          if (!literal[2]) send("+ go ahead");
          // Litteral vide: rien a lire, la ligne continue.
          continue;
        }
        const full = pendingLine + piece;
        pendingLine = "";
        handle(full);
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  state.port = (server.address() as net.AddressInfo).port;
  return state;
}
