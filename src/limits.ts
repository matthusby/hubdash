import type { AccountLimits, Limit, Resets } from "./types.ts";

const FIVE_HOURS = 5 * 3600;
const ONE_WEEK = 7 * 86400;

export interface LimitsConfig {
  proxyUrl: string;
  managementKey: string;
  /** Sent as Claude Code's User-Agent; Anthropic hides reset grants from old versions. */
  claudeCodeVersion: string;
  /** Sent as Antigravity Hub's User-Agent; Google hides the Gemini quota groups from old or unversioned clients. */
  antigravityVersion: string;
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
  cedar_ember?: ClaudeResetGrants | null;
}

interface ClaudeResetGrant {
  resets_left?: number | null;
  ends_at?: string | null;
  type?: string | null;
  clears?: string[] | null;
  gives_back_weekly?: boolean | null;
}

interface ClaudeResetGrants {
  eligible?: boolean | null;
  ineligible_reason?: string | null;
  grants?: ClaudeResetGrant[] | null;
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

interface AntigravityQuotaSummary {
  groups?: {
    displayName?: string | null;
    buckets?: { window?: string | null; remainingFraction?: number | null; resetTime?: string | null }[] | null;
  }[] | null;
}

const ANTIGRAVITY_WINDOWS: Record<string, number> = { "5h": FIVE_HOURS, weekly: ONE_WEEK };

export function claudeLimits(usage: ClaudeUsage): Limit[] {
  return (usage.limits ?? []).flatMap((limit) => {
    if (limit.percent == null || !limit.resets_at) return [];
    const session = limit.group === "session";
    return [
      {
        scope: limit.scope?.model?.display_name ?? null,
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
              scope: null,
              usedPercent: w.used_percent,
              resetsAt: new Date(w.reset_at * 1000).toISOString(),
              windowSeconds: w.limit_window_seconds,
            },
          ]
        : [],
    )
    .sort((a, b) => a.windowSeconds - b.windowSeconds);
}

/** Antigravity's models share limits in groups ("Gemini Models"), each with a 5-hour and/or weekly bucket. */
export function antigravityLimits(summary: AntigravityQuotaSummary): Limit[] {
  return (summary.groups ?? []).flatMap((group) => {
    const scope = group.displayName?.replace(/ models$/i, "") || null;
    return (group.buckets ?? [])
      .flatMap((bucket) => {
        const windowSeconds = ANTIGRAVITY_WINDOWS[bucket.window ?? ""];
        if (!windowSeconds || !bucket.resetTime) return [];
        return [
          {
            scope,
            // Protobuf JSON omits zero values, so an exhausted bucket has no remainingFraction.
            usedPercent: (1 - (bucket.remainingFraction ?? 0)) * 100,
            resetsAt: bucket.resetTime,
            windowSeconds,
          },
        ];
      })
      .sort((a, b) => a.windowSeconds - b.windowSeconds);
  });
}

/** Unspent, unexpired reset grants, counted by what they refill. */
export function claudeResets(grants: ClaudeResetGrants | null | undefined, now: number = Date.now()): Resets | null {
  if (!grants) return null;
  if (!grants.eligible) return { unavailable: grants.ineligible_reason ?? "not eligible" };
  const live = (grants.grants ?? []).filter(
    (g) => (g.resets_left ?? 0) > 0 && !(g.ends_at && Date.parse(g.ends_at) <= now),
  );
  const counts = new Map<string, number>();
  for (const grant of live) counts.set(grantKind(grant), (counts.get(grantKind(grant)) ?? 0) + grant.resets_left!);
  return {
    available: live.reduce((sum, g) => sum + g.resets_left!, 0),
    nextExpiry: live.flatMap((g) => (g.ends_at ? [g.ends_at] : [])).sort()[0] ?? null,
    kinds: [...counts].map(([kind, count]) => ({ kind, count })),
  };
}

/** A grant that gives back the week's Fable use is a Fable reset whatever its type says, as in Claude Code. */
function grantKind(grant: ClaudeResetGrant): string {
  if (grant.gives_back_weekly) return "Fable";
  if (grant.type === "session" || grant.type === "weekly" || grant.type === "full") return grant.type;
  const clears = grant.clears ?? [];
  const session = clears.includes("five_hour");
  const other = clears.some((c) => c !== "five_hour");
  return session && !other ? "session" : other && !session ? "weekly" : "full";
}

export function nextResetExpiry(credits: CodexResetCredits): string | null {
  const expiries = (credits.credits ?? [])
    .filter((c) => c.status === "available" && c.expires_at)
    .map((c) => c.expires_at as string)
    .sort();
  return expiries[0] ?? null;
}

async function management<T>(config: LimitsConfig, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${config.proxyUrl}/v8/management${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${config.managementKey}`, "Content-Type": "application/json" },
  });
  if (!response.ok) throw new Error(`proxy ${path} returned ${response.status}`);
  return (await response.json()) as T;
}

/** Call an upstream URL as one account; the proxy substitutes its token for $TOKEN$. */
async function asAccount<T>(
  config: LimitsConfig,
  authIndex: string,
  url: string,
  { method = "GET", header = {} }: { method?: "GET" | "POST"; header?: Record<string, string> } = {},
): Promise<T> {
  const { status_code, body } = await management<{ status_code: number; body: unknown }>(
    config,
    "/requests/api-call",
    {
      method: "POST",
      body: JSON.stringify({
        authIndex,
        method,
        url,
        header: { Authorization: "Bearer $TOKEN$", ...header },
      }),
    },
  );
  if (status_code !== 200) throw new Error(`${new URL(url).host} returned ${status_code}`);
  return (typeof body === "string" ? JSON.parse(body) : body) as T;
}

async function claudeAccount(config: LimitsConfig, credential: Credential): Promise<AccountLimits> {
  const usage = await asAccount<ClaudeUsage>(
    config,
    credential.auth_index,
    "https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1",
    {
      header: {
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": `claude-cli/${config.claudeCodeVersion} (external, cli)`,
      },
    },
  );
  return {
    label: accountLabel(credential),
    plan: null,
    limits: claudeLimits(usage),
    resets: claudeResets(usage.cedar_ember),
    error: null,
  };
}

async function codexAccount(config: LimitsConfig, credential: Credential): Promise<AccountLimits> {
  const [usage, credits] = await Promise.all([
    asAccount<CodexUsage>(config, credential.auth_index, "https://chatgpt.com/backend-api/wham/usage"),
    asAccount<CodexResetCredits>(
      config,
      credential.auth_index,
      "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
    ),
  ]);
  return {
    label: accountLabel(credential),
    plan: usage.plan_type ?? null,
    limits: codexLimits(usage),
    resets: codexResets(usage, credits),
    error: null,
  };
}

async function antigravityAccount(config: LimitsConfig, credential: Credential): Promise<AccountLimits> {
  const summary = await asAccount<AntigravityQuotaSummary>(
    config,
    credential.auth_index,
    "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
    { method: "POST", header: { "User-Agent": `antigravity/hub/${config.antigravityVersion} darwin/arm64` } },
  );
  return {
    label: accountLabel(credential),
    plan: null,
    limits: antigravityLimits(summary),
    resets: null,
    error: null,
  };
}

function codexResets(usage: CodexUsage, credits: CodexResetCredits): Resets | null {
  const available = usage.rate_limit_reset_credits?.available_count;
  return available == null ? null : { available, nextExpiry: nextResetExpiry(credits), kinds: [] };
}

const accountLabel = (credential: Credential): string =>
  credential.email || credential.label || credential.auth_index;

const fetchers: Record<string, (config: LimitsConfig, c: Credential) => Promise<AccountLimits>> = {
  claude: claudeAccount,
  codex: codexAccount,
  antigravity: antigravityAccount,
};

/** Limits for every enabled account the proxy knows, grouped by provider. */
export async function fetchLimits(config: LimitsConfig): Promise<Map<string, AccountLimits[]>> {
  const { files } = await management<{ files: Credential[] }>(config, "/credentials");
  const accounts = await Promise.all(
    files
      .filter((c) => !c.disabled && fetchers[c.provider])
      .map(async (c) => {
        const account = await fetchers[c.provider]!(config, c).catch(
          (error: Error): AccountLimits => ({
            label: accountLabel(c),
            plan: null,
            limits: [],
            resets: null,
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
