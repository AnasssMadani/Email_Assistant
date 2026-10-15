import { test } from "node:test";
import assert from "node:assert/strict";
import { stripQuotedHistory } from "../src/pipeline/emailText.js";

test("keeps only the latest message of an Outlook (Turkish) thread", () => {
  const body = [
    "pls send ohbl urgently",
    "",
    "thx",
    "[cid:image001.jpg@01DD5CBD.77B025F0]",
    "",
    "Mr. Nedim Cagin | Commercial Director",
    "",
    "________________________________",
    "Gönderen: k.khallaf@oceanlink-global.com <k.khallaf@oceanlink-global.com>",
    "Gönderildi: 15 Ekim 2026 Perşembe 17:54",
    "Kime: BWL Nedim <nedim.cagin@bwlturkey.com>",
    "Konu: RE: BWL / REF NO: 3899",
    "",
    "Need to solve this problem",
  ].join("\n");
  const out = stripQuotedHistory(body);
  assert.equal(out, "pls send ohbl urgently\n\nthx\n\nMr. Nedim Cagin | Commercial Director");
});

test("handles French, English 'wrote' and quoted '>' lines", () => {
  assert.equal(stripQuotedHistory("Merci.\n\nDe : a@b.com\nEnvoyé : jeudi\nÀ : c@d.com\nObjet : x\n\nancien"), "Merci.");
  assert.equal(stripQuotedHistory("Thanks\n\nOn Thu, 15 Oct 2026 at 14:39, Bob <b@x.com> wrote:\n> old"), "Thanks");
  assert.equal(stripQuotedHistory("Salut\n\nLe 15/10/2026 à 14:39, Bob a écrit :\n> vieux"), "Salut");
  assert.equal(stripQuotedHistory("Réponse\n> citation\nfin"), "Réponse\nfin");
});

test("returns the text untouched when nothing precedes the marker or no marker exists", () => {
  const forwarded = "From: a@b.com\nSent: Monday\nTo: c@d.com\nSubject: s\n\nbody";
  assert.equal(stripQuotedHistory(forwarded), forwarded);
  assert.equal(stripQuotedHistory("Simple message"), "Simple message");
  assert.equal(stripQuotedHistory("From: la mer, c'est beau"), "From: la mer, c'est beau");
  assert.equal(stripQuotedHistory(""), "");
});
