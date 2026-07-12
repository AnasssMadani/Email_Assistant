import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReplySubject } from "../src/utils.js";

test("buildReplySubject adds Re: when missing", () => {
  assert.equal(buildReplySubject("Demande de devis"), "Re: Demande de devis");
});

test("buildReplySubject does not double-prefix an existing Re:", () => {
  assert.equal(buildReplySubject("Re: Demande de devis"), "Re: Demande de devis");
  assert.equal(buildReplySubject("re : Demande de devis"), "re : Demande de devis");
});

test("buildReplySubject trims surrounding whitespace", () => {
  assert.equal(buildReplySubject("  Demande de devis  "), "Re: Demande de devis");
});
