export interface Limit {
  name: string;
  usedPercent: number;
  resetsAt: string;
  windowSeconds: number;
}

export interface AccountLimits {
  label: string;
  plan: string | null;
  limits: Limit[];
  resetsAvailable: number | null;
  nextResetExpiry: string | null;
  error: string | null;
}

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

export interface Summary {
  providers: ProviderCard[];
  limitsFetchedAt: string | null;
}

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
