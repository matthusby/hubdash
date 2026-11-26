export interface Limit {
  /** The models the limit covers ("Fable", "Gemini"); null when it covers all of them. */
  scope: string | null;
  usedPercent: number;
  resetsAt: string;
  windowSeconds: number;
}

export interface AccountLimits {
  label: string;
  plan: string | null;
  limits: Limit[];
  resets: Resets | null;
  error: string | null;
}

/** Limit resets the account can spend, or why the provider won't say. A grant batch shares a kind and expiry;
 * batches are sorted soonest expiry first. */
export type Resets =
  | { available: number; grants: { kind: string; count: number; expiresAt: string | null }[] }
  | { unavailable: string };

export interface Tokens {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export interface ProviderCard {
  provider: string;
  accounts: AccountLimits[];
  today: Tokens;
  last30Days: Tokens;
}

/** Token total for one time bucket, keyed by its local start. */
export interface Total { start: string; total: number }

export interface Summary {
  providers: ProviderCard[];
  limitsFetchedAt: string | null;
  /** Per-hour totals since the start of today, zero-filled; the sparkline under the today stat. */
  todayHourly: Total[];
  /** Per-day totals over the last 7 local days, zero-filled; the week stat and its sparkline. */
  weekDaily: Total[];
  /** The busiest model over the last 7 days; null when nothing ran. */
  topModel: ModelTotal | null;
}

/** One day's tokens, keyed by its local-midnight start. */
export interface DayTotal { start: string; tokens: Tokens }

/** The busiest model over a period. */
export interface ModelTotal { model: string; tokens: Tokens }

export const RANGES = ["day", "week", "month", "6m"] as const;
export type Range = (typeof RANGES)[number];
export type BucketSize = "hour" | "day" | "week";

export interface Bucket {
  start: string;
  /** provider → model → tokens */
  byProvider: Record<string, Record<string, Tokens>>;
}

export interface UsageSeries {
  range: Range;
  bucketSize: BucketSize;
  buckets: Bucket[];
}

export const TOKEN_KINDS = ["input", "cacheRead", "cacheWrite", "output"] as const;

export const emptyTokens = (): Tokens => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });

export const totalTokens = (t: Tokens): number => t.input + t.cacheRead + t.cacheWrite + t.output;
