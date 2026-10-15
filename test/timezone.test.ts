import { test } from "node:test";
import assert from "node:assert/strict";
import { dailyReportWindow, localPartsInZone, zonedTimeToUtc } from "../src/timezone.js";

// Valeurs exactes sur des fuseaux aux regles stables (UTC+1 fixe, Paris):
// les regles du Maroc changent d'une version de tzdata a l'autre (Ramadan,
// retour eventuel a UTC+0), donc Casablanca n'est verifie que par des
// proprietes qui ne dependent pas de la version d'ICU embarquee par Node.
const FIXED_UTC1 = "Etc/GMT-1";
const PARIS = "Europe/Paris";
const CASABLANCA = "Africa/Casablanca";

test("zonedTimeToUtc converts a local wall time, including across a DST change", () => {
  assert.equal(zonedTimeToUtc(2026, 10, 15, 9, 0, FIXED_UTC1).toISOString(), "2026-10-15T08:00:00.000Z");
  assert.equal(zonedTimeToUtc(2026, 3, 28, 9, 0, PARIS).toISOString(), "2026-03-28T08:00:00.000Z"); // UTC+1
  assert.equal(zonedTimeToUtc(2026, 3, 30, 9, 0, PARIS).toISOString(), "2026-03-30T07:00:00.000Z"); // UTC+2
});

test("dailyReportWindow: after 9:00 local, the window is yesterday 9:00 → today 9:00, night from yesterday 18:00", () => {
  const w = dailyReportWindow(new Date("2026-10-15T08:30:00Z"), 9, 18, FIXED_UTC1);
  assert.equal(w.reportDate, "2026-10-15");
  assert.equal(w.start.toISOString(), "2026-10-14T08:00:00.000Z");
  assert.equal(w.end.toISOString(), "2026-10-15T08:00:00.000Z");
  assert.equal(w.nightStart.toISOString(), "2026-10-14T17:00:00.000Z");
});

test("dailyReportWindow: before 9:00 local, the latest due report is still yesterday's", () => {
  const w = dailyReportWindow(new Date("2026-10-15T07:59:00Z"), 9, 18, FIXED_UTC1);
  assert.equal(w.reportDate, "2026-10-14");
  assert.equal(w.end.toISOString(), "2026-10-14T08:00:00.000Z");
});

test("dailyReportWindow: exactly at 9:00 local the new report is due (the cron tick itself)", () => {
  const w = dailyReportWindow(new Date("2026-10-15T08:00:00Z"), 9, 18, FIXED_UTC1);
  assert.equal(w.reportDate, "2026-10-15");
});

test("dailyReportWindow: a night start hour before the report hour stays on the report day", () => {
  const w = dailyReportWindow(new Date("2026-10-15T08:30:00Z"), 9, 0, FIXED_UTC1);
  assert.equal(w.nightStart.toISOString(), "2026-10-14T23:00:00.000Z");
});

test("dailyReportWindow: consecutive windows tile with no gap across DST changes (23 h / 25 h days)", () => {
  for (const [zone, year] of [
    [PARIS, 2026],
    [CASABLANCA, 2026],
  ] as const) {
    for (let dayOfYear = 0; dayOfYear < 366; dayOfYear++) {
      const today = dailyReportWindow(new Date(Date.UTC(year, 0, 1 + dayOfYear, 12)), 9, 18, zone);
      const tomorrow = dailyReportWindow(new Date(Date.UTC(year, 0, 2 + dayOfYear, 12)), 9, 18, zone);
      assert.equal(tomorrow.start.toISOString(), today.end.toISOString(), `${zone}: gap after ${today.reportDate}`);
      const local = localPartsInZone(today.end, zone);
      assert.deepEqual([local.hour, local.minute], [9, 0], `${zone}: ${today.reportDate} does not end at 9:00 local`);
    }
  }
});
