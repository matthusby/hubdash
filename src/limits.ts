import type { AccountLimits, Limit } from "./types.ts";

const FIVE_HOURS = 5 * 3600;
const ONE_WEEK = 7 * 86400;

export interface ProxyConfig {
  url: string;
  managementKey: string;
}

interface Credential {
  provider: string;
  auth_index: string;
  email?: string;
  label?: string;
  disabled?: boolean;
}

interface ClaudeUsage {
  limits?: {
    kind?: string | null;
    group?: string | null;
    percent?: number | null;
    resets_at?: string | null;
    scope?: { model?: { display_name?: string | null } | null } | null;
  }[] | null;
}

interface CodexWindow {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_at?: number;
}

interface CodexUsage {
  plan_type?: string;
  rate_limit?: { primary_window?: CodexWindow | null; secondary_window?: CodexWindow | null } | null;
  rate_limit_reset_credits?: { available_count?: number } | null;
}

interface CodexResetCredits {
  credits?: { status?: string; expires_at?: string }[];
}

export function claudeLimits(usage: ClaudeUsage): Limit[] {
  return (usage.limits ?? []).flatMap((limit) => {
    if (limit.percent == null || !limit.resets_at) return [];
    const session = limit.group === "session";
    const model = limit.scope?.model?.display_name;
    return [
      {
        name: session ? "5-hour" : model ? `Weekly · ${model}` : "Weekly",
        usedPercent: limit.percent,
        resetsAt: limit.resets_at,
        windowSeconds: session ? FIVE_HOURS : ONE_WEEK,
      },
    ];
  });
}

export function codexLimits(usage: CodexUsage): Limit[] {
  const windows = [usage.rate_limit?.primary_window, usage.rate_limit?.secondary_window];
  return windows
    .flatMap((w) =>
      w?.used_percent != null && w.limit_window_seconds && w.reset_at
        ? [
            {
              name: windowName(w.limit_window_seconds),
              usedPercent: w.used_percent,
              resetsAt: new Date(w.reset_at * 1000).toISOString(),
              windowSeconds: w.limit_window_seconds,
            },
          ]
        : [],
    )
    .sort((a, b) => a.windowSeconds - b.windowSeconds);
}

export function nextResetExpiry(credits: CodexResetCredits): string | null {
  const expiries = (credits.credits ?? [])
    .filter((c) => c.status === "available" && c.expires_at)
    .map((c) => c.expires_at as string)
    .sort();
  return expiries[0] ?? null;
}

function windowName(seconds: number): string {
  if (seconds === FIVE_HOURS) return "5-hour";
  if (seconds === ONE_WEEK) return "Weekly";
  return seconds % 86400 === 0 ? `${seconds / 86400}-day` : `${Math.round(seconds / 3600)}-hour`;
}

async function management<T>(proxy: ProxyConfig, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${proxy.url}/v8/management${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${proxy.managementKey}`, "Content-Type": "application/json" },
  });
  if (!response.ok) throw new Error(`proxy ${path} returned ${response.status}`);
  return (await response.json()) as T;
}

/** GET an upstream URL as one account; the proxy substitutes its token for $TOKEN$. */
async function asAccount<T>(
  proxy: ProxyConfig,
  authIndex: string,
  url: string,
  header: Record<string, string> = {},
): Promise<T> {
  const { status_code, body } = await management<{ status_code: number; body: unknown }>(
    proxy,
    "/requests/api-call",
    {
      method: "POST",
      body: JSON.stringify({
        authIndex,
        method: "GET",
        url,
        header: { Authorization: "Bearer $TOKEN$", ...header },
      }),
    },
  );
  if (status_code !== 200) throw new Error(`${new URL(url).host} returned ${status_code}`);
  return (typeof body === "string" ? JSON.parse(body) : body) as T;
}

async function claudeAccount(proxy: ProxyConfig, credential: Credential): Promise<AccountLimits> {
  const usage = await asAccount<ClaudeUsage>(
    proxy,
    credential.auth_index,
    "https://api.anthropic.com/api/oauth/usage",
    { "anthropic-beta": "oauth-2025-04-20" },
  );
  return {
    label: accountLabel(credential),
    plan: null,
    limits: claudeLimits(usage),
    resetsAvailable: null,
    nextResetExpiry: null,
    error: null,
  };
}

async function codexAccount(proxy: ProxyConfig, credential: Credential): Promise<AccountLimits> {
  const [usage, credits] = await Promise.all([
    asAccount<CodexUsage>(proxy, credential.auth_index, "https://chatgpt.com/backend-api/wham/usage"),
    asAccount<CodexResetCredits>(
      proxy,
      credential.auth_index,
      "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
    ),
  ]);
  return {
    label: accountLabel(credential),
    plan: usage.plan_type ?? null,
    limits: codexLimits(usage),
    resetsAvailable: usage.rate_limit_reset_credits?.available_count ?? null,
    nextResetExpiry: nextResetExpiry(credits),
    error: null,
  };
}

const accountLabel = (credential: Credential): string =>
  credential.email || credential.label || credential.auth_index;

const fetchers: Record<string, (proxy: ProxyConfig, c: Credential) => Promise<AccountLimits>> = {
  claude: claudeAccount,
  codex: codexAccount,
};

/** Limits for every enabled account the proxy knows, grouped by provider. */
export async function fetchLimits(proxy: ProxyConfig): Promise<Map<string, AccountLimits[]>> {
  const { files } = await management<{ files: Credential[] }>(proxy, "/credentials");
  const accounts = await Promise.all(
    files
      .filter((c) => !c.disabled && fetchers[c.provider])
      .map(async (c) => {
        const account = await fetchers[c.provider]!(proxy, c).catch(
          (error: Error): AccountLimits => ({
            label: accountLabel(c),
            plan: null,
            limits: [],
            resetsAvailable: null,
            nextResetExpiry: null,
            error: error.message,
          }),
        );
        return [c.provider, account] as const;
      }),
  );

  const byProvider = new Map<string, AccountLimits[]>();
  for (const [provider, account] of accounts) {
    byProvider.set(provider, [...(byProvider.get(provider) ?? []), account]);
  }
  return byProvider;
}
