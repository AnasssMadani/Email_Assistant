export function buildReplySubject(originalSubject: string): string {
  const trimmed = originalSubject.trim();
  return /^re\s*:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}
