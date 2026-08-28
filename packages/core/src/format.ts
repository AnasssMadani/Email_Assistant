/** Ported from legacy/src/ai/prompts.ts formatSlaForPrompt — same rationale: SLA is stored in minutes but must read naturally in a customer-facing message. */
export function formatSlaForHuman(minutes: number): string {
  if (minutes <= 0) return "a few moments";
  if (minutes < 60) return `${minutes} minute${minutes > 1 ? "s" : ""}`;
  const hours = minutes / 60;
  const rounded = Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
  return `${rounded} hour${hours > 1 ? "s" : ""}`;
}
