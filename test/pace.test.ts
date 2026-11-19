import { describe, expect, test } from "bun:test";
import { pace } from "../src/pace.ts";

const HOUR = 3_600_000;
const now = Date.parse("2026-11-19T12:00:00Z");
const fiveHour = (usedPercent: number, resetsInHours: number) => ({
  name: "5-hour",
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
});
