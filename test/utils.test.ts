import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReplySubject, urgencyMeetsThreshold } from "../src/utils.js";

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

test("urgencyMeetsThreshold: 'low' minimum always alerts, regardless of urgency", () => {
  assert.equal(urgencyMeetsThreshold("low", "low"), true);
  assert.equal(urgencyMeetsThreshold("normal", "low"), true);
  assert.equal(urgencyMeetsThreshold("high", "low"), true);
});

test("urgencyMeetsThreshold: 'high' minimum only alerts on high urgency", () => {
  assert.equal(urgencyMeetsThreshold("low", "high"), false);
  assert.equal(urgencyMeetsThreshold("normal", "high"), false);
  assert.equal(urgencyMeetsThreshold("high", "high"), true);
});

test("urgencyMeetsThreshold: 'normal' minimum excludes only low urgency", () => {
  assert.equal(urgencyMeetsThreshold("low", "normal"), false);
  assert.equal(urgencyMeetsThreshold("normal", "normal"), true);
  assert.equal(urgencyMeetsThreshold("high", "normal"), true);
});
