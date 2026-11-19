import index from "./ui/index.html";
import { fetchLimits, type ProxyConfig } from "./limits.ts";
import { RANGES, emptyTokens, type AccountLimits, type Range, type Summary } from "./types.ts";
import { UsageStore, startOfToday } from "./usage.ts";

const HOME = process.env.HOME ?? "";
const PORT = Number(process.env.PORT ?? 18400);
const LIMITS_REFRESH_MS = 5 * 60_000;
const MANUAL_REFRESH_MIN_MS = 30_000;
const THIRTY_DAYS_MS = 30 * 86_400_000;
const PROVIDER_ORDER = ["claude", "codex"];

const proxy: ProxyConfig = {
  url: process.env.PROXY_URL ?? "http://127.0.0.1:8317",
  managementKey: await readSecret(process.env.SECRETS_FILE ?? `${HOME}/cliproxyapi/secrets.env`, "MGMT_KEY"),
};
const usage = new UsageStore(process.env.USAGE_DB ?? `${HOME}/cpamp/data/usage.sqlite`);

let limits = new Map<string, AccountLimits[]>();
let limitsFetchedAt: Date | null = null;
let inflight: Promise<void> | null = null;

function refreshLimits(): Promise<void> {
  inflight ??= fetchLimits(proxy)
    .then((fresh) => {
      limits = fresh;
      limitsFetchedAt = new Date();
    })
    .catch((error: Error) => console.error(`limits refresh failed: ${error.message}`))
    .finally(() => (inflight = null));
  return inflight;
}

function summary(): Summary {
  const today = usage.totals(startOfToday());
  const last30Days = usage.totals(Date.now() - THIRTY_DAYS_MS);
  const providers = [...new Set([...limits.keys(), ...last30Days.keys()])].sort(
    (a, b) => rank(a) - rank(b) || a.localeCompare(b),
  );
  return {
    providers: providers.map((provider) => ({
      provider,
      accounts: limits.get(provider) ?? [],
      today: today.get(provider) ?? emptyTokens(),
      last30Days: last30Days.get(provider) ?? emptyTokens(),
    })),
    limitsFetchedAt: limitsFetchedAt?.toISOString() ?? null,
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
