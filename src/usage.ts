import { Database } from "bun:sqlite";
import { emptyTokens, type Bucket, type BucketSize, type Range, type Tokens, type UsageSeries } from "./types.ts";

const HOUR_MS = 3_600_000;

interface HourRow extends Tokens {
  hour: number;
  provider: string;
}

/** Read-only view over CPA Manager Plus's usage_events table. */
export class UsageStore {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { readonly: true });
  }

  /** Per-hour, per-provider token sums since `sinceMs`. Cached input is never counted as input. */
  hourly(sinceMs: number): HourRow[] {
    return this.db
      .query<HourRow, [number]>(
        `select timestamp_ms / ${HOUR_MS} as hour, provider,
                sum(normalized_uncached_input_tokens) as input,
                sum(normalized_cache_read_tokens) as cacheRead,
                sum(normalized_cache_creation_tokens) as cacheWrite,
                sum(output_tokens) as output
           from usage_events
          where timestamp_ms >= ?
          group by hour, provider`,
      )
      .all(Math.floor(sinceMs / HOUR_MS) * HOUR_MS);
  }

  totals(sinceMs: number): Map<string, Tokens> {
    const totals = new Map<string, Tokens>();
    for (const row of this.hourly(sinceMs)) {
      addTokens((totals.get(row.provider) ?? set(totals, row.provider, emptyTokens())), row);
    }
    return totals;
  }

  series(range: Range, now: Date = new Date()): UsageSeries {
    const { bucketSize, count } = RANGE_SPEC[range];
    const starts = bucketStarts(bucketSize, count, now);
    const buckets = new Map<number, Bucket>(
      starts.map((start) => [start, { start: new Date(start).toISOString(), byProvider: {} }]),
    );

    for (const row of this.hourly(starts[0]!)) {
      const bucket = buckets.get(bucketStart(row.hour * HOUR_MS, bucketSize));
      if (!bucket) continue;
      addTokens((bucket.byProvider[row.provider] ??= emptyTokens()), row);
    }
    return { range, bucketSize, buckets: [...buckets.values()] };
  }
}

const RANGE_SPEC: Record<Range, { bucketSize: BucketSize; count: number }> = {
  day: { bucketSize: "hour", count: 24 },
  week: { bucketSize: "day", count: 7 },
  month: { bucketSize: "day", count: 30 },
  "6m": { bucketSize: "week", count: 26 },
};

/** Local-time start of the bucket containing `ms`; weeks start on Monday. */
export function bucketStart(ms: number, size: BucketSize): number {
  const d = new Date(ms);
  if (size === "hour") {
    d.setMinutes(0, 0, 0);
  } else {
    d.setHours(0, 0, 0, 0);
    if (size === "week") d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  }
  return d.getTime();
}

/** The last `count` bucket starts, ending with the bucket that contains `now`. */
export function bucketStarts(size: BucketSize, count: number, now: Date): number[] {
  const starts: number[] = [];
  const d = new Date(bucketStart(now.getTime(), size));
  for (let i = 0; i < count; i++) {
    starts.unshift(d.getTime());
    if (size === "hour") d.setHours(d.getHours() - 1);
    else d.setDate(d.getDate() - (size === "week" ? 7 : 1));
  }
  return starts;
}

export function startOfToday(now: Date = new Date()): number {
  return bucketStart(now.getTime(), "day");
}

function addTokens(into: Tokens, from: Tokens): void {
  into.input += from.input;
  into.cacheRead += from.cacheRead;
  into.cacheWrite += from.cacheWrite;
  into.output += from.output;
}

function set<K, V>(map: Map<K, V>, key: K, value: V): V {
  map.set(key, value);
  return value;
}
