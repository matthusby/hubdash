import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageStore, bucketStart, bucketStarts } from "../src/usage.ts";

process.env.TZ = "America/Chicago";
const dir = mkdtempSync(join(tmpdir(), "hubdash-"));
afterAll(() => rmSync(dir, { recursive: true }));

describe("buckets", () => {
  test("weeks start on Monday in local time", () => {
    const thursday = new Date(2026, 10, 19, 15, 30).getTime();
    expect(new Date(bucketStart(thursday, "week"))).toEqual(new Date(2026, 10, 16));
  });

  test("days step across the DST change without drifting off midnight", () => {
    const starts = bucketStarts("day", 3, new Date(2026, 2, 9, 12));
    expect(starts.map((s) => new Date(s).getHours())).toEqual([0, 0, 0]);
    expect(new Date(starts[0]!).getDate()).toBe(7);
  });
});

test("series sums uncached input, cache, and output per provider and model into local-day buckets", () => {
  const path = join(dir, "usage.sqlite");
  const db = new Database(path);
  db.run(`create table usage_events (timestamp_ms integer, provider text, model text, normalized_uncached_input_tokens integer,
    normalized_cache_read_tokens integer, normalized_cache_creation_tokens integer, output_tokens integer)`);
  const insert = db.prepare("insert into usage_events values (?, ?, ?, ?, ?, ?, ?)");
  const now = new Date(2026, 10, 19, 15);
  insert.run(new Date(2026, 10, 19, 9).getTime(), "claude", "claude-opus-5-5", 10, 1000, 100, 50);
  insert.run(new Date(2026, 10, 19, 14).getTime(), "claude", "claude-fable-5-2", 5, 500, 0, 25);
  insert.run(new Date(2026, 10, 18, 23, 30).getTime(), "codex", "gpt-6.1-sol", 7, 70, 0, 3);
  insert.run(new Date(2026, 10, 1).getTime(), "codex", "gpt-6.1-sol", 999, 999, 999, 999);
  db.close();

  const series = new UsageStore(path).series("week", now);
  expect(series.buckets).toHaveLength(7);
  const [yesterday, today] = series.buckets.slice(-2);
  expect(today!.byProvider).toEqual({
    claude: {
      "claude-opus-5-5": { input: 10, cacheRead: 1000, cacheWrite: 100, output: 50 },
      "claude-fable-5-2": { input: 5, cacheRead: 500, cacheWrite: 0, output: 25 },
    },
  });
  expect(yesterday!.byProvider).toEqual({ codex: { "gpt-6.1-sol": { input: 7, cacheRead: 70, cacheWrite: 0, output: 3 } } });
});

describe("history", () => {
  test("daily sums tokens per local day and hourlyTotals zero-fills from the start of the day", () => {
    const path = join(dir, "history.sqlite");
    const db = new Database(path);
    db.run(`create table usage_events (timestamp_ms integer, provider text, model text, normalized_uncached_input_tokens integer,
      normalized_cache_read_tokens integer, normalized_cache_creation_tokens integer, output_tokens integer)`);
    const insert = db.prepare("insert into usage_events values (?, ?, ?, ?, ?, ?, ?)");
    insert.run(new Date(2026, 10, 19, 10).getTime(), "claude", "claude-opus-5-5", 10, 0, 0, 0);
    insert.run(new Date(2026, 10, 19, 10, 30).getTime(), "claude", "claude-opus-5-5", 5, 0, 0, 0);
    insert.run(new Date(2026, 10, 19, 14).getTime(), "codex", "gpt-6.1-sol", 1, 2, 3, 4);
    insert.run(new Date(2026, 10, 18, 23).getTime(), "codex", "gpt-6.1-sol", 7, 0, 0, 0);
    db.close();

    const store = new UsageStore(path);
    const now = new Date(2026, 10, 19, 15);
    const days = store.daily(new Date(2026, 10, 18).getTime());
    expect(days).toEqual([
      { start: new Date(2026, 10, 18).toISOString(), tokens: { input: 7, cacheRead: 0, cacheWrite: 0, output: 0 } },
      { start: new Date(2026, 10, 19).toISOString(), tokens: { input: 16, cacheRead: 2, cacheWrite: 3, output: 4 } },
    ]);

    const hours = store.hourlyTotals(new Date(2026, 10, 19).getTime(), now);
    expect(hours).toHaveLength(16);
    expect(hours[10]).toEqual({ start: new Date(2026, 10, 19, 10).toISOString(), total: 15 });
    expect(hours[9]).toEqual({ start: new Date(2026, 10, 19, 9).toISOString(), total: 0 });
    expect(hours[14]).toEqual({ start: new Date(2026, 10, 19, 14).toISOString(), total: 10 });
  });

  test("topModel picks the busiest model since the given time", () => {
    const path = join(dir, "top.sqlite");
    const db = new Database(path);
    db.run(`create table usage_events (timestamp_ms integer, provider text, model text, normalized_uncached_input_tokens integer,
      normalized_cache_read_tokens integer, normalized_cache_creation_tokens integer, output_tokens integer)`);
    const insert = db.prepare("insert into usage_events values (?, ?, ?, ?, ?, ?, ?)");
    insert.run(new Date(2026, 10, 19, 10).getTime(), "claude", "claude-opus-5-5", 10, 10, 10, 10);
    insert.run(new Date(2026, 10, 19, 11).getTime(), "claude", "claude-opus-5-5", 5, 5, 5, 5);
    insert.run(new Date(2026, 10, 19, 12).getTime(), "codex", "gpt-6.1-sol", 10, 0, 0, 0);
    db.close();

    const store = new UsageStore(path);
    expect(store.topModel(new Date(2026, 10, 19).getTime())).toEqual({
      model: "claude-opus-5-5",
      tokens: { input: 15, cacheRead: 15, cacheWrite: 15, output: 15 },
    });
  });
});
