import index from "./ui/index.html";
import { fetchLimits, type LimitsConfig } from "./limits.ts";
import { pace, trendOf } from "./pace.ts";
import { RANGES, emptyTokens, totalTokens, type AccountLimits, type Limit, type Range, type Summary } from "./types.ts";
import { UsageStore, bucketStarts, startOfToday } from "./usage.ts";

const HOME = process.env.HOME ?? "";
const PORT = Number(process.env.PORT ?? 18400);
const LIMITS_REFRESH_MS = 5 * 60_000;
const MANUAL_REFRESH_MIN_MS = 30_000;
const THIRTY_DAYS_MS = 30 * 86_400_000;
const HISTORY_MS = 52 * 7 * 86_400_000;
const WEEK_MS = 7 * 86_400_000;
const TREND_KEEP_MS = 12 * 3_600_000;
const PROVIDER_ORDER = ["claude", "codex"];

const limitsConfig: LimitsConfig = {
  proxyUrl: process.env.PROXY_URL ?? "http://127.0.0.1:8317",
  managementKey: await readSecret(process.env.SECRETS_FILE ?? `${HOME}/cliproxyapi/secrets.env`, "MGMT_KEY"),
  claudeCodeVersion: process.env.CLAUDE_CODE_VERSION ?? "2.1.327",
  antigravityVersion: process.env.ANTIGRAVITY_VERSION ?? "2.34.0",
};
const usage = new UsageStore(process.env.USAGE_DB ?? `${HOME}/cpamp/data/usage.sqlite`);

let limits = new Map<string, AccountLimits[]>();
let limitsFetchedAt: Date | null = null;
let inflight: Promise<void> | null = null;

/** Used-percent readings per limit, so a recent burn rate can be estimated. */
const trendSamples = new Map<string, { t: number; used: number }[]>();
const trendKey = (provider: string, label: string, limit: Limit) =>
  `${provider}|${label}|${limit.scope ?? ""}|${limit.windowSeconds}`;

function recordTrends(fresh: Map<string, AccountLimits[]>): void {
  const now = Date.now();
  for (const [provider, accounts] of fresh) {
    for (const account of accounts) {
      for (const limit of account.limits) {
        const key = trendKey(provider, account.label, limit);
        let samples = trendSamples.get(key);
        if (!samples) trendSamples.set(key, (samples = []));
        samples.push({ t: now, used: limit.usedPercent });
        while (samples.length > 1 && now - samples[0]!.t > TREND_KEEP_MS) samples.shift();
      }
    }
  }
}

const trendFor = (provider: string, label: string, limit: Limit, now: number) =>
  trendOf(trendSamples.get(trendKey(provider, label, limit)) ?? [], now);

function refreshLimits(): Promise<void> {
  inflight ??= fetchLimits(limitsConfig)
    .then((fresh) => {
      recordTrends(fresh);
      limits = fresh;
      limitsFetchedAt = new Date();
    })
    .catch((error: Error) => console.error(`limits refresh failed: ${error.message}`))
    .finally(() => (inflight = null));
  return inflight;
}

function summary(): Summary {
  const now = Date.now();
  const today = usage.totals(startOfToday());
  const last30Days = usage.totals(now - THIRTY_DAYS_MS);
  const providers = [...new Set([...limits.keys(), ...last30Days.keys()])].sort(
    (a, b) => rank(a) - rank(b) || a.localeCompare(b),
  );
  const weekDays = new Map(usage.daily(now - WEEK_MS).map((d) => [d.start, totalTokens(d.tokens)]));
  return {
    providers: providers.map((provider) => ({
      provider,
      accounts: (limits.get(provider) ?? []).map((account) => ({
        ...account,
        limits: account.limits.map((limit) => ({ ...limit, trend: trendFor(provider, account.label, limit, now) })),
      })),
      today: today.get(provider) ?? emptyTokens(),
      last30Days: last30Days.get(provider) ?? emptyTokens(),
    })),
    limitsFetchedAt: limitsFetchedAt?.toISOString() ?? null,
    todayHourly: usage.hourlyTotals(startOfToday(), new Date(now)),
    weekDaily: bucketStarts("day", 7, new Date(now)).map(
      (start) => ({ start: new Date(start).toISOString(), total: weekDays.get(new Date(start).toISOString()) ?? 0 }),
    ),
    topModel: usage.topModel(now - WEEK_MS),
  };
}

const rank = (provider: string) => {
  const i = PROVIDER_ORDER.indexOf(provider);
  return i === -1 ? PROVIDER_ORDER.length : i;
};

const isRange = (value: string | null): value is Range => RANGES.includes(value as Range);

async function readSecret(path: string, key: string): Promise<string> {
  const line = (await Bun.file(path).text()).split("\n").find((l) => l.startsWith(`${key}=`));
  if (!line) throw new Error(`${key} not found in ${path}`);
  return line.slice(key.length + 1).trim();
}

void refreshLimits();
setInterval(refreshLimits, LIMITS_REFRESH_MS);

Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  development: process.env.NODE_ENV !== "production",
  routes: {
    "/": index,
    "/api/summary": () => Response.json(summary()),
    "/api/usage": (req) => {
      const range = new URL(req.url).searchParams.get("range");
      return isRange(range)
        ? Response.json(usage.series(range))
        : Response.json({ error: `range must be one of ${RANGES.join(", ")}` }, { status: 400 });
    },
    "/api/history": () => Response.json(usage.daily(Date.now() - HISTORY_MS)),
    "/api/refresh": {
      POST: async () => {
        if (!limitsFetchedAt || Date.now() - limitsFetchedAt.getTime() > MANUAL_REFRESH_MIN_MS) {
          await refreshLimits();
        }
        return Response.json(summary());
      },
    },
  },
});

console.log(`hubdash listening on http://127.0.0.1:${PORT}`);
