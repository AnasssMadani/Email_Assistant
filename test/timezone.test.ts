import { test } from "node:test";
import assert from "node:assert/strict";
import { dailyReportWindow, zonedTimeToUtc } from "../src/timezone.js";

const TZ = "Africa/Casablanca";

test("zonedTimeToUtc: 9:00 in Casablanca is 08:00 UTC normally, 09:00 UTC during the Ramadan switch to UTC+0", () => {
  assert.equal(zonedTimeToUtc(2026, 10, 15, 9, 0, TZ).toISOString(), "2026-10-15T08:00:00.000Z");
  // Ramadan 2026 (~18 fev - 19 mars): le Maroc repasse a UTC+0.
  assert.equal(zonedTimeToUtc(2026, 3, 1, 9, 0, TZ).toISOString(), "2026-03-01T09:00:00.000Z");
});

test("dailyReportWindow: after 9:00 local, the window is yesterday 9:00 → today 9:00, night from yesterday 18:00", () => {
  const w = dailyReportWindow(new Date("2026-10-15T08:30:00Z"), 9, 18, TZ);
  assert.equal(w.reportDate, "2026-10-15");
  assert.equal(w.start.toISOString(), "2026-10-14T08:00:00.000Z");
  assert.equal(w.end.toISOString(), "2026-10-15T08:00:00.000Z");
  assert.equal(w.nightStart.toISOString(), "2026-10-14T17:00:00.000Z");
});

test("dailyReportWindow: before 9:00 local, the latest due report is still yesterday's", () => {
  const w = dailyReportWindow(new Date("2026-10-15T07:59:00Z"), 9, 18, TZ);
  assert.equal(w.reportDate, "2026-10-14");
  assert.equal(w.end.toISOString(), "2026-10-14T08:00:00.000Z");
});

test("dailyReportWindow: exactly at 9:00 local the new report is due (the cron tick itself)", () => {
  const w = dailyReportWindow(new Date("2026-10-15T08:00:00Z"), 9, 18, TZ);
  assert.equal(w.reportDate, "2026-10-15");
});

test("dailyReportWindow: consecutive windows tile with no gap across the Ramadan clock change", () => {
  // Bascule UTC+1 → UTC+0 autour du 15 fevrier 2026: deux rapports
  // consecutifs doivent se toucher exactement (23 h ou 25 h selon le cas).
  for (let day = 10; day <= 22; day++) {
    const today = dailyReportWindow(new Date(Date.UTC(2026, 1, day, 12)), 9, 18, TZ);
    const tomorrow = dailyReportWindow(new Date(Date.UTC(2026, 1, day + 1, 12)), 9, 18, TZ);
    assert.equal(tomorrow.start.toISOString(), today.end.toISOString(), `gap after 2026-02-${day}`);
  }
});

test("dailyReportWindow: a night start hour before the report hour stays on the report day", () => {
  const w = dailyReportWindow(new Date("2026-10-15T08:30:00Z"), 9, 0, TZ);
  assert.equal(w.nightStart.toISOString(), "2026-10-14T23:00:00.000Z");
});
