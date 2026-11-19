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

test("series sums uncached input, cache, and output per provider into local-day buckets", () => {
  const path = join(dir, "usage.sqlite");
  const db = new Database(path);
  db.run(`create table usage_events (timestamp_ms integer, provider text, normalized_uncached_input_tokens integer,
    normalized_cache_read_tokens integer, normalized_cache_creation_tokens integer, output_tokens integer)`);
  const insert = db.prepare("insert into usage_events values (?, ?, ?, ?, ?, ?)");
  const now = new Date(2026, 10, 19, 15);
  insert.run(new Date(2026, 10, 19, 9).getTime(), "claude", 10, 1000, 100, 50);
  insert.run(new Date(2026, 10, 19, 14).getTime(), "claude", 5, 500, 0, 25);
  insert.run(new Date(2026, 10, 18, 23, 30).getTime(), "codex", 7, 70, 0, 3);
  insert.run(new Date(2026, 10, 1).getTime(), "codex", 999, 999, 999, 999);
  db.close();

  const series = new UsageStore(path).series("week", now);
  expect(series.buckets).toHaveLength(7);
  const [yesterday, today] = series.buckets.slice(-2);
  expect(today!.byProvider).toEqual({ claude: { input: 15, cacheRead: 1500, cacheWrite: 100, output: 75 } });
  expect(yesterday!.byProvider).toEqual({ codex: { input: 7, cacheRead: 70, cacheWrite: 0, output: 3 } });
});
