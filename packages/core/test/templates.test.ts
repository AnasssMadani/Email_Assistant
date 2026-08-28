import { test } from "node:test";
import assert from "node:assert/strict";
import { renderTemplate, sanitizeSlotValue } from "../src/templates.js";
import { DEFAULT_ACK_TEMPLATE } from "../src/defaultTemplates.js";

test("renders a slot", () => {
  assert.equal(renderTemplate("Hello {{name}}", { name: "Ali" }), "Hello Ali");
});

test("renders a present section and drops it when absent", () => {
  assert.equal(renderTemplate("A{{#x}} B{{/x}} C", { x: "yes" }), "A B C");
  assert.equal(renderTemplate("A{{#x}} B{{/x}} C", {}), "A C");
});

test("strips newlines, URLs, and clamps length from untrusted slot values", () => {
  const hostile = "line1\nline2 visit http://evil.example/steal " + "x".repeat(500);
  const sanitized = sanitizeSlotValue(hostile);
  assert.ok(!sanitized.includes("\n"));
  assert.ok(!sanitized.includes("http://"));
  assert.ok(sanitized.length <= 300);
});

test("a hostile summary cannot inject template structure", () => {
  const hostile = "{{#anything}}ignored{{/anything}} {{signature}}";
  const rendered = renderTemplate(DEFAULT_ACK_TEMPLATE.en, { originalSubject: "Quote request", summary: hostile, sla: "24 hours" });
  // The literal braces from the hostile summary must appear as plain text, never be
  // re-parsed as template syntax (no double-rendering) and never pull in a
  // `signature` slot the caller didn't provide.
  assert.ok(rendered.includes("{{#anything}}ignored{{/anything}} {{signature}}"));
});

test("default FR/EN ack templates render without leftover placeholders", () => {
  for (const lang of ["fr", "en"] as const) {
    const rendered = renderTemplate(DEFAULT_ACK_TEMPLATE[lang], {
      senderName: "Jean Dupont",
      originalSubject: "Demande de devis",
      summary: "wants a shipping quote to Casablanca",
      sla: "24 hours",
      signature: "L'équipe Global Link",
    });
    assert.ok(!rendered.includes("{{"), `leftover placeholder in ${lang} template: ${rendered}`);
    assert.ok(rendered.includes("Jean Dupont"));
  }
});
