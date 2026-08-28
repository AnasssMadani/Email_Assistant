import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluatePrefilter } from "../src/prefilter.js";

function msg(overrides: Partial<{ subject: string; fromEmail: string; headers: Record<string, string | undefined> }>) {
  return { subject: "Devis pour transport", fromEmail: "client@example.com", headers: {}, ...overrides };
}

test("does not drop a normal client email", () => {
  const result = evaluatePrefilter(msg({}));
  assert.equal(result.drop, false);
});

test("drops on List-Unsubscribe header", () => {
  const result = evaluatePrefilter(msg({ headers: { "list-unsubscribe": "<mailto:x@y.com>" } }));
  assert.equal(result.drop, true);
  assert.equal(result.rule, "list_header");
});

test("drops bulk Precedence", () => {
  const result = evaluatePrefilter(msg({ headers: { precedence: "bulk" } }));
  assert.equal(result.drop, true);
  assert.equal(result.rule, "precedence_bulk");
});

test("drops Auto-Submitted != no", () => {
  const result = evaluatePrefilter(msg({ headers: { "auto-submitted": "auto-replied" } }));
  assert.equal(result.drop, true);
  assert.equal(result.rule, "auto_submitted");
});

test("does not drop Auto-Submitted: no", () => {
  const result = evaluatePrefilter(msg({ headers: { "auto-submitted": "no" } }));
  assert.equal(result.drop, false);
});

test("drops a no-reply sender", () => {
  const result = evaluatePrefilter(msg({ fromEmail: "no-reply@carrier.com" }));
  assert.equal(result.drop, true);
  assert.equal(result.rule, "no_reply_sender");
});

test("drops bounce reports (empty Return-Path)", () => {
  const result = evaluatePrefilter(msg({ headers: { "return-path": "<>" } }));
  assert.equal(result.drop, true);
  assert.equal(result.rule, "bounce_or_dsn");
});

test("flags our own [Rappel] echo subject for the caller to verify sender identity", () => {
  const result = evaluatePrefilter(msg({ subject: "[Rappel] Dossier sans réponse — Devis" }));
  assert.equal(result.drop, true);
  assert.equal(result.rule, "own_rappel_echo");
});

test("does not treat a real client subject starting differently as a rappel echo", () => {
  const result = evaluatePrefilter(msg({ subject: "Rappel de notre appel de ce matin" }));
  assert.equal(result.drop, false);
});
