/**
 * Conversions heure locale ↔ instant UTC dans un fuseau IANA, sans
 * dependance externe (Intl uniquement). Necessaire pour le rapport du matin:
 * "9 h a Casablanca" n'est pas un decalage fixe — le Maroc passe de UTC+1 a
 * UTC+0 pendant le Ramadan, et le serveur d'hebergement tourne souvent en UTC.
 */

export interface LocalDateParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
}

export function localPartsInZone(date: Date, timeZone: string): LocalDateParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute };
}

/** Decalage (ms) du fuseau par rapport a UTC a cet instant precis. */
function zoneOffsetMs(date: Date, timeZone: string): number {
  const p = localPartsInZone(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  const truncated = Math.floor(date.getTime() / 60_000) * 60_000;
  return asUtc - truncated;
}

/** Instant UTC correspondant a une heure murale locale (ex: 9:00 a Casablanca le 15/10). */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): Date {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  // Deux passes: le decalage a l'instant "naif" peut differer de celui a
  // l'instant reel si un changement d'heure tombe entre les deux.
  let ts = wallAsUtc - zoneOffsetMs(new Date(wallAsUtc), timeZone);
  ts = wallAsUtc - zoneOffsetMs(new Date(ts), timeZone);
  return new Date(ts);
}

export function addDays(year: number, month: number, day: number, delta: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day + delta));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export function formatIsoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export interface ReportWindow {
  /** Date locale du rapport (YYYY-MM-DD) — celle du matin ou il est produit. */
  reportDate: string;
  start: Date;
  end: Date;
  /** Debut de la "nuit" (veille a nightStartHour), jamais avant `start`. */
  nightStart: Date;
}

/**
 * Fenetre du dernier rapport quotidien echu a l'instant `now`: de la veille a
 * `hour` jusqu'au jour J a `hour` (heure locale), J etant le dernier jour dont
 * l'heure du rapport est deja passee. Deux rapports consecutifs se touchent
 * exactement, sans trou ni recouvrement, meme en cas de changement d'heure.
 */
export function dailyReportWindow(now: Date, hour: number, nightStartHour: number, timeZone: string): ReportWindow {
  let today = localPartsInZone(now, timeZone);
  let end = zonedTimeToUtc(today.year, today.month, today.day, hour, 0, timeZone);
  if (end.getTime() > now.getTime()) {
    const prev = addDays(today.year, today.month, today.day, -1);
    today = { ...today, ...prev };
    end = zonedTimeToUtc(today.year, today.month, today.day, hour, 0, timeZone);
  }
  const eve = addDays(today.year, today.month, today.day, -1);
  const start = zonedTimeToUtc(eve.year, eve.month, eve.day, hour, 0, timeZone);
  const nightDay = nightStartHour < hour ? today : eve;
  const nightRaw = zonedTimeToUtc(nightDay.year, nightDay.month, nightDay.day, nightStartHour, 0, timeZone);
  const nightStart = nightRaw.getTime() < start.getTime() ? start : nightRaw;
  return { reportDate: formatIsoDate(today.year, today.month, today.day), start, end, nightStart };
}
