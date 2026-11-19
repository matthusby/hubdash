import { describe, expect, test } from "bun:test";
import { claudeLimits, codexLimits, nextResetExpiry } from "../src/limits.ts";

describe("claudeLimits", () => {
  test("names the session, weekly, and model-scoped weekly limits", () => {
    const limits = claudeLimits({
      limits: [
        { kind: "session", group: "session", percent: 11, resets_at: "2026-11-19T19:09:59Z", scope: null },
        { kind: "weekly_all", group: "weekly", percent: 10, resets_at: "2026-11-25T15:59:59Z", scope: null },
        { kind: "weekly_scoped", group: "weekly", percent: 0, resets_at: "2026-11-25T16:00:00Z",
          scope: { model: { display_name: "Fable" } } },
      ],
    });
    expect(limits.map((l) => [l.name, l.usedPercent, l.windowSeconds])).toEqual([
      ["5-hour", 11, 18000],
      ["Weekly", 10, 604800],
      ["Weekly · Fable", 0, 604800],
    ]);
  });
});

describe("codexLimits", () => {
  test("reads both windows shortest first and skips missing ones", () => {
    const weekly = { used_percent: 30, limit_window_seconds: 604800, reset_at: 1795706019 };
    expect(codexLimits({ rate_limit: { primary_window: weekly, secondary_window: null } })).toEqual([
      { name: "Weekly", usedPercent: 30, resetsAt: new Date(1795706019000).toISOString(), windowSeconds: 604800 },
    ]);

    const session = { used_percent: 5, limit_window_seconds: 18000, reset_at: 1795600000 };
    expect(codexLimits({ rate_limit: { primary_window: weekly, secondary_window: session } }).map((l) => l.name))
      .toEqual(["5-hour", "Weekly"]);
  });
});

test("nextResetExpiry picks the soonest available credit", () => {
  expect(nextResetExpiry({
    credits: [
      { status: "available", expires_at: "2026-12-12T22:43:43Z" },
      { status: "redeemed", expires_at: "2026-11-20T00:00:00Z" },
      { status: "available", expires_at: "2026-11-30T20:19:35Z" },
    ],
  })).toBe("2026-11-30T20:19:35Z");
  expect(nextResetExpiry({ credits: [] })).toBeNull();
});
