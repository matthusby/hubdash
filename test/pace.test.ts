import { describe, expect, test } from "bun:test";
import { pace, trendOf } from "../src/pace.ts";

const HOUR = 3_600_000;
const now = Date.parse("2026-11-19T12:00:00Z");
const fiveHour = (usedPercent: number, resetsInHours: number) => ({
  scope: null,
  usedPercent,
  resetsAt: new Date(now + resetsInHours * HOUR).toISOString(),
  windowSeconds: 5 * 3600,
});

describe("pace", () => {
  test("projects usage at reset from the elapsed fraction", () => {
    const p = pace(fiveHour(20, 3), now);
    expect(p.elapsedFraction).toBeCloseTo(0.4);
    expect(p.projectedPercent).toBeCloseTo(50);
    expect(p.runsOutAt).toBeNull();
  });

  test("estimates when the limit runs out when ahead of pace", () => {
    const p = pace(fiveHour(60, 3), now);
    expect(p.projectedPercent).toBeCloseTo(150);
    // 60% took 2h, so the last 40% takes another 80 minutes.
    expect(p.runsOutAt).toBe(now + (80 / 60) * HOUR);
  });

  test("holds back an estimate early in the window", () => {
    const p = pace(fiveHour(3, 4.9), now);
    expect(p.projectedPercent).toBeNull();
    expect(p.runsOutAt).toBeNull();
  });

  test("has no run-out time once the limit is reached", () => {
    expect(pace(fiveHour(100, 1), now).runsOutAt).toBeNull();
  });

  test("uses the recent burn rate over the window average when a trend is known", () => {
    const p = pace(fiveHour(87, 10), now, { percentPerHour: 4 });
    expect(p.fromTrend).toBe(true);
    expect(p.trendRate).toBe(4);
    // 13% left at 4%/h runs out in 3h15m, long before the reset in 10h.
    expect(p.runsOutAt).toBe(now + 3.25 * HOUR);
    expect(p.projectedPercent).toBe(100);
  });

  test("an idle trend predicts no run-out", () => {
    const p = pace(fiveHour(87, 10), now, { percentPerHour: 0 });
    expect(p.runsOutAt).toBeNull();
    expect(p.trendRate).toBeNull();
    expect(p.projectedPercent).toBe(87);
  });
});

describe("trendOf", () => {
  test("fits a slope to the recent hourly samples", () => {
    const samples = [4, 5, 6, 7].map((used, i) => ({ t: now - (3 - i) * HOUR, used }));
    expect(trendOf(samples, now)).toEqual({ percentPerHour: 1 });
  });

  test("a refill splits the series: only the stretch since the drop counts", () => {
    const samples = [
      { t: now - 4 * HOUR, used: 2 },
      { t: now - 3 * HOUR, used: 7 },
      { t: now - 2 * HOUR, used: 3 },
      { t: now - 1 * HOUR, used: 5 },
    ];
    expect(trendOf(samples, now)).toEqual({ percentPerHour: 2 });
  });

  test("flat usage means no trend", () => {
    const samples = [5, 5, 5].map((used, i) => ({ t: now - (2 - i) * HOUR, used }));
    expect(trendOf(samples, now)).toBeNull();
  });
});
