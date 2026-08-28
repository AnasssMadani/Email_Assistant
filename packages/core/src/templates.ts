/**
 * Slot-templated accusé/relance rendering — the default path (ackMode: "template"),
 * costing zero LLM tokens. See docs/architecture/refonte-plan.md "The templated
 * accusé, working from day 1".
 *
 * Supported syntax, deliberately minimal (not a general template language):
 *   {{slot}}              — inserts a sanitized slot value, or "" if absent/empty
 *   {{#slot}}...{{/slot}} — renders the block only if `slot` is present and non-empty
 *
 * Every slot value is treated as untrusted (subject/summary derive from the
 * customer's own email) and sanitized before insertion: newlines stripped, length
 * clamped, bare URLs removed. The template's own structure is fixed text the tenant
 * wrote — a hostile email body can make a sentence read oddly, it cannot change
 * which sentences exist, add a new paragraph, or alter what gets sent next. This is
 * strictly safer than an LLM prompt built from the same untrusted content.
 */

export type TemplateSlots = Record<string, string | undefined>;

const MAX_SLOT_LENGTH = 300;
const URL_PATTERN = /\bhttps?:\/\/\S+/gi;

export function sanitizeSlotValue(raw: string | undefined): string {
  if (!raw) return "";
  return raw
    .replace(/\r?\n/g, " ")
    .replace(URL_PATTERN, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SLOT_LENGTH);
}

const SECTION_PATTERN = /\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g;
const SLOT_PATTERN = /\{\{(\w+)\}\}/g;

export function renderTemplate(body: string, rawSlots: TemplateSlots): string {
  const slots: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawSlots)) {
    slots[key] = sanitizeSlotValue(value);
  }

  const withSections = body.replace(SECTION_PATTERN, (_match, key: string, inner: string) =>
    slots[key] ? inner : ""
  );

  return withSections.replace(SLOT_PATTERN, (_match, key: string) => slots[key] ?? "");
}
