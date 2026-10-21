import { test } from "node:test";
import assert from "node:assert/strict";
import { freshTestDb } from "./_pgTestDb.js";
import { cleanReplyForLearning, htmlToText, looksLikeHtml, stripQuotedHistory } from "../src/pipeline/emailText.js";
import { isAutomatedMessage } from "../src/pipeline/automatedSender.js";
import type { EmailMessage } from "../src/types.js";

// officeHours.ts lit ses reglages en base: le pool de test doit exister avant son import.
await freshTestDb();
const { isWithinOfficeHours, parseOfficeHours, DEFAULT_OFFICE_HOURS } = await import("../src/officeHours.js");

test("htmlToText keeps line breaks, drops style blocks and decodes entities", () => {
  const html = `<html><head><style>body { color: red; } p.x { margin: 0 }</style></head><body>
    <p>Hi&nbsp;dear,</p><div>Please find the B/L&nbsp;draft.<br>Thanks &amp; regards</div>
    <blockquote>Le 12 oct. 2026, X a &eacute;crit :<br>old</blockquote></body></html>`;
  const text = htmlToText(html);
  assert.ok(!text.includes("color: red"), text);
  assert.ok(!text.includes("&nbsp;"), text);
  assert.match(text, /Hi dear,\n+Please find the B\/L draft\.\nThanks & regards/);
  assert.match(text, /a écrit/);
});

test("looksLikeHtml spots HTML code sent as plain text, not emails that quote a <link>", () => {
  assert.equal(looksLikeHtml("<html><head><meta http- equiv='Content- Type'></head><body><p>Bonjour</p></body></html>"), true);
  assert.equal(looksLikeHtml("  <!DOCTYPE html><html><body>x</body></html>"), true);
  assert.equal(looksLikeHtml("<p style='font-size: 16px'>Bonjour,</p><p>Merci de trouver ci joint notre quotation</p>"), true);
  assert.equal(looksLikeHtml("<https://www.bwlturkey.com/> Hi dear, draft HBL attached"), false);
  assert.equal(looksLikeHtml("<photo.png> Bonjour, ci-joint la facture"), false);
  assert.equal(looksLikeHtml("Bonjour,\nVoir <p> dans le code.\nMerci"), false);
});

test("stripQuotedHistory cuts a flattened reply at an inline quote marker", () => {
  const flat = "Hi dear The shipper confirmed to you the booking ? Envoyé de mon iPhone Le 16 oct. 2026 à 10:02, Karim a écrit : > old text";
  assert.equal(stripQuotedHistory(flat), "Hi dear The shipper confirmed to you the booking ?");
});

test("stripQuotedHistory leaves a normal multi-line email untouched by inline markers", () => {
  const body = "Bonjour,\nLe client a écrit hier pour confirmer.\nMerci\nKarim";
  assert.equal(stripQuotedHistory(body), body);
});

test("cleanReplyForLearning removes CSS and entities left by HTML-only emails", () => {
  const dirty = "Noted with thanks&nbsp; p.MsoNormal {margin:0cm; font-size:11pt} De : Agent Envoyé : lundi Objet : RE: booking";
  assert.equal(cleanReplyForLearning(dirty), "Noted with thanks");
  assert.equal(
    cleanReplyForLearning("body { line-height: 1.5; } a:link, span.x {color:blue} Bien reçu, merci {voir PJ}"),
    "Bien reçu, merci {voir PJ}"
  );
  assert.equal(cleanReplyForLearning("Ref. ABC {Note: urgent}"), "Ref. ABC {Note: urgent}");
});

function from(email: string, over: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id: "1",
    threadId: "t",
    from: { email },
    to: [],
    subject: "x",
    bodyText: "",
    receivedAt: new Date(),
    isFromUs: false,
    hasAttachments: false,
    ...over,
  };
}

test("isAutomatedMessage: robot addresses and auto-submitted headers, not people", () => {
  assert.equal(isAutomatedMessage(from("mycustomerservice-noreply@cma-cgm.com")), true);
  assert.equal(isAutomatedMessage(from("mymsc.noreply@msc.com")), true);
  assert.equal(isAutomatedMessage(from("MAILER-DAEMON@mail.example.com")), true);
  assert.equal(isAutomatedMessage(from("charge_notification2@maersk.com")), true);
  assert.equal(isAutomatedMessage(from("k.khallaf@oceanlink-global.com")), false);
  assert.equal(isAutomatedMessage(from("noreen@agent.com")), false);
  assert.equal(isAutomatedMessage(from("ops@agent.com", { isAutomated: true })), true);
});

test("office hours: weekdays inside the window only, evaluated in the client's time zone", () => {
  const hours = DEFAULT_OFFICE_HOURS; // lun-ven 08:30-18:30
  assert.equal(isWithinOfficeHours(new Date("2026-10-19T10:00:00Z"), hours, "UTC"), true); // lundi
  assert.equal(isWithinOfficeHours(new Date("2026-10-19T08:29:00Z"), hours, "UTC"), false);
  assert.equal(isWithinOfficeHours(new Date("2026-10-19T18:30:00Z"), hours, "UTC"), false);
  assert.equal(isWithinOfficeHours(new Date("2026-10-17T10:00:00Z"), hours, "UTC"), false); // samedi
  // 23:30 UTC dimanche = 08:30 lundi a Tokyo (UTC+9).
  assert.equal(isWithinOfficeHours(new Date("2026-10-18T23:30:00Z"), hours, "Asia/Tokyo"), true);
});

test("parseOfficeHours falls back to defaults on garbage", () => {
  assert.deepEqual(parseOfficeHours("not json"), DEFAULT_OFFICE_HOURS);
  assert.deepEqual(parseOfficeHours(JSON.stringify({ days: [6, 9, 1], start: "25:00", end: "17:00" })), {
    days: [1, 6],
    start: DEFAULT_OFFICE_HOURS.start,
    end: "17:00",
  });
});
