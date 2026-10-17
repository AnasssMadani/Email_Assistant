import { config } from "./config.js";
import { getAppSetting, setAppSetting } from "./db.js";
import { localPartsInZone } from "./timezone.js";

/**
 * Heures de bureau de l'equipe, dans le fuseau du client (config.timezone).
 * Une categorie reglee "accuse hors heures de bureau" n'accuse que lorsque
 * l'equipe n'est pas la: en journee, elle repond elle-meme en quelques
 * minutes, et un accuse "nous revenons vers vous" arriverait a cote de la
 * vraie reponse. Reglable dans /reglages, sans redeploiement.
 */
export interface OfficeHours {
  /** Jours ouvres, 1 = lundi ... 7 = dimanche. */
  days: number[];
  /** "HH:MM", heure locale. */
  start: string;
  end: string;
}

const SETTING_KEY = "office_hours";

export const DEFAULT_OFFICE_HOURS: OfficeHours = { days: [1, 2, 3, 4, 5], start: "08:30", end: "18:30" };

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseOfficeHours(raw: string | undefined): OfficeHours {
  if (!raw) return DEFAULT_OFFICE_HOURS;
  try {
    const value = JSON.parse(raw) as Partial<OfficeHours>;
    const days = Array.isArray(value.days)
      ? [...new Set(value.days.map(Number).filter((d) => Number.isInteger(d) && d >= 1 && d <= 7))].sort()
      : DEFAULT_OFFICE_HOURS.days;
    const start = typeof value.start === "string" && TIME.test(value.start) ? value.start : DEFAULT_OFFICE_HOURS.start;
    const end = typeof value.end === "string" && TIME.test(value.end) ? value.end : DEFAULT_OFFICE_HOURS.end;
    return { days, start, end };
  } catch {
    return DEFAULT_OFFICE_HOURS;
  }
}

export async function getOfficeHours(): Promise<OfficeHours> {
  return parseOfficeHours(await getAppSetting(SETTING_KEY));
}

export async function setOfficeHours(hours: OfficeHours): Promise<void> {
  const clean = parseOfficeHours(JSON.stringify(hours));
  await setAppSetting(SETTING_KEY, JSON.stringify(clean));
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** Vrai si `date` tombe pendant les heures de bureau (jour ouvre, entre start inclus et end exclu). */
export function isWithinOfficeHours(date: Date, hours: OfficeHours, timeZone: string = config.timezone): boolean {
  const parts = localPartsInZone(date, timeZone);
  // Jour de la semaine local: calcule sur la date murale, pas sur l'instant UTC.
  const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay() || 7;
  if (!hours.days.includes(weekday)) return false;
  const minute = parts.hour * 60 + parts.minute;
  return minute >= minutesOf(hours.start) && minute < minutesOf(hours.end);
}
