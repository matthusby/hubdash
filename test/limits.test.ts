import { describe, expect, test } from "bun:test";
import {
  antigravityLimits,
  claudeLimits,
  claudeResets,
  codexLimits,
  compatCredentials,
  zaiLimits,
} from "../src/limits.ts";

describe("claudeLimits", () => {
  test("reads the session, weekly, and model-scoped weekly limits", () => {
    const limits = claudeLimits({
      limits: [
        { kind: "session", group: "session", percent: 11, resets_at: "2026-11-19T19:09:59Z", scope: null },
        { kind: "weekly_all", group: "weekly", percent: 10, resets_at: "2026-11-25T15:59:59Z", scope: null },
        { kind: "weekly_scoped", group: "weekly", percent: 0, resets_at: "2026-11-25T16:00:00Z",
          scope: { model: { display_name: "Fable" } } },
      ],
    });
    expect(limits.map((l) => [l.scope, l.usedPercent, l.windowSeconds])).toEqual([
      [null, 11, 18000],
      [null, 10, 604800],
      ["Fable", 0, 604800],
    ]);
  });
});

describe("claudeResets", () => {
  const now = Date.parse("2026-11-20T00:00:00Z");
  const full = { type: "full", resets_left: 1, ends_at: "2026-12-10T22:00:00Z", clears: ["five_hour", "seven_day"] };
  const fable = { type: "full", resets_left: 1, ends_at: "2027-03-09T07:59:00Z", gives_back_weekly: true };

  test("counts unspent, unexpired grants by what they refill, soonest expiry first", () => {
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
      grants: [
        { kind: "session", count: 1, expiresAt: "2026-12-01T00:00:00Z" },
        { kind: "full", count: 1, expiresAt: "2026-12-10T22:00:00Z" },
        { kind: "Fable", count: 3, expiresAt: "2027-03-09T07:59:00Z" },
      ],
    });
  });

  test("keeps same-kind grants with different expiries separate", () => {
    const grants = [
      { resets_left: 1, ends_at: "2026-12-15T00:00:00Z", clears: ["five_hour"] },
      { resets_left: 1, ends_at: "2026-12-01T00:00:00Z", clears: ["five_hour"] },
    ];
    expect(claudeResets({ eligible: true, grants }, now)).toEqual({
      available: 2,
      grants: [
        { kind: "session", count: 1, expiresAt: "2026-12-01T00:00:00Z" },
        { kind: "session", count: 1, expiresAt: "2026-12-15T00:00:00Z" },
      ],
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
      { scope: null, usedPercent: 30, resetsAt: new Date(1795706019000).toISOString(), windowSeconds: 604800 },
    ]);

    const session = { used_percent: 5, limit_window_seconds: 18000, reset_at: 1795600000 };
    expect(codexLimits({ rate_limit: { primary_window: weekly, secondary_window: session } }).map((l) => l.windowSeconds))
      .toEqual([18000, 604800]);
  });
});

describe("antigravityLimits", () => {
  const fiveHour = "2026-11-21T04:42:12Z";
  const weekly = "2026-11-27T23:42:12Z";

  test("scopes each group's buckets to the group, 5-hour first", () => {
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
    expect(limits.map((l) => [l.scope, l.usedPercent, l.windowSeconds])).toEqual([
      ["Gemini", 60, 18000],
      ["Gemini", 25, 604800],
      ["Gemini 4 Argon", 0, 604800],
    ]);
  });

  test("reads a bucket with no remaining fraction as exhausted", () => {
    const limits = antigravityLimits({
      groups: [{ displayName: "Claude and GPT models", buckets: [{ window: "5h", resetTime: fiveHour }] }],
    });
    expect(limits.map((l) => [l.scope, l.usedPercent])).toEqual([["Claude and GPT", 100]]);
  });
});

describe("zaiLimits", () => {
  const quota = {
    code: 200,
    msg: "Operation successful",
    data: {
      level: "pro",
      limits: [
        { type: "TIME_LIMIT", unit: 5, number: 1, usage: 1000, currentValue: 0, percentage: 0, nextResetTime: 1796269604999 },
        { type: "TOKENS_LIMIT", unit: 6, number: 7, percentage: 4, nextResetTime: 1796086800000 },
        { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 21, nextResetTime: 1795485646320 },
      ],
    },
    success: true,
  };

  test("reads the token windows shortest first and leaves out the monthly MCP call limit", () => {
    expect(zaiLimits(quota)).toEqual([
      { scope: null, usedPercent: 21, resetsAt: new Date(1795485646320).toISOString(), windowSeconds: 18000 },
      { scope: null, usedPercent: 4, resetsAt: new Date(1796086800000).toISOString(), windowSeconds: 604800 },
    ]);
  });

  test("skips a window with no percentage or reset time", () => {
    const data = {
      limits: [
        { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 12 },
        { type: "TOKENS_LIMIT", unit: 3, number: 5, nextResetTime: 1795485646320 },
      ],
    };
    expect(zaiLimits({ data })).toEqual([]);
  });
});

test("compatCredentials addresses each enabled key under the name the proxy routes it by, without its key", () => {
  const entries = [
    {
      name: "ZAI Coding Plan",
      "api-key-entries": [{ "api-key": "sk-secret", "auth-index": "index-1" }, { "api-key": "sk-secret" }],
    },
    { name: "other", disabled: true, "api-key-entries": [{ "auth-index": "index-2" }] },
  ];
  expect(compatCredentials(entries)).toEqual([
    { provider: "openai-compatible-zai coding plan", auth_index: "index-1", label: "ZAI Coding Plan" },
  ]);
});
