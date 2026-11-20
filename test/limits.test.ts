import { describe, expect, test } from "bun:test";
import { antigravityLimits, claudeLimits, claudeResets, codexLimits, nextResetExpiry } from "../src/limits.ts";

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

describe("claudeResets", () => {
  const now = Date.parse("2026-11-20T00:00:00Z");
  const full = { type: "full", resets_left: 1, ends_at: "2026-12-10T22:00:00Z", clears: ["five_hour", "seven_day"] };
  const fable = { type: "full", resets_left: 1, ends_at: "2027-03-09T07:59:00Z", gives_back_weekly: true };

  test("counts unspent, unexpired grants by what they refill", () => {
    const grants = [
      full,
      fable,
      { ...fable, resets_left: 2 },
      { ...full, resets_left: 0 },
      { ...full, ends_at: "2026-11-01T00:00:00Z" },
      { resets_left: 1, ends_at: "2026-12-01T00:00:00Z", clears: ["five_hour"] },
    ];
    expect(claudeResets({ eligible: true, grants }, now)).toEqual({
      available: 5,
      nextExpiry: "2026-12-01T00:00:00Z",
      kinds: [{ kind: "full", count: 1 }, { kind: "Fable", count: 3 }, { kind: "session", count: 1 }],
    });
  });

  test("reports why an ineligible account has no resets", () => {
    expect(claudeResets({ eligible: false, ineligible_reason: "cli_version", grants: [] }, now))
      .toEqual({ unavailable: "cli_version" });
    expect(claudeResets(null, now)).toBeNull();
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

describe("antigravityLimits", () => {
  const fiveHour = "2026-11-21T04:42:12Z";
  const weekly = "2026-11-27T23:42:12Z";

  test("names each group's buckets, 5-hour first", () => {
    const limits = antigravityLimits({
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [
            { window: "weekly", remainingFraction: 0.75, resetTime: weekly },
            { window: "5h", remainingFraction: 0.4, resetTime: fiveHour },
          ],
        },
        { displayName: "Gemini 4 Argon", buckets: [{ window: "weekly", remainingFraction: 1, resetTime: weekly }] },
      ],
    });
    expect(limits.map((l) => [l.name, l.usedPercent, l.windowSeconds])).toEqual([
      ["5-hour · Gemini", 60, 18000],
      ["Weekly · Gemini", 25, 604800],
      ["Weekly · Gemini 4 Argon", 0, 604800],
    ]);
  });

  test("reads a bucket with no remaining fraction as exhausted", () => {
    const limits = antigravityLimits({
      groups: [{ displayName: "Claude and GPT models", buckets: [{ window: "5h", resetTime: fiveHour }] }],
    });
    expect(limits.map((l) => [l.name, l.usedPercent])).toEqual([["5-hour · Claude and GPT", 100]]);
  });
});
