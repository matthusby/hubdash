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

/** An openai-compatibility provider as the proxy's config endpoint lists it, with each key's auth-index. */
interface OpenAICompatibility {
  name?: string | null;
  disabled?: boolean;
  "api-key-entries"?: { "auth-index"?: string | null }[] | null;
}

/** Z.ai's response as returned: an envelope holding the coding plan's tier and a token limit per window. */
interface ZaiQuota {
  data?: {
    level?: string | null;
    limits?: {
      type?: string | null;
      /** 3 = hours, 5 = months, 6 = weeks. */
      unit?: number | null;
      /** How many of the unit the window spans. */
      number?: number | null;
      percentage?: number | null;
      /** Epoch milliseconds. */
      nextResetTime?: number | null;
    }[] | null;
  } | null;
}

const ANTIGRAVITY_WINDOWS: Record<string, number> = { "5h": FIVE_HOURS, weekly: ONE_WEEK };

/** Z.ai's token windows by `unit`: `number` hours, or its 7-day week. The monthly limit counts MCP calls, not tokens,
 * so it stays out. */
const ZAI_WINDOW_SECONDS: Record<number, (number: number) => number> = { 3: (hours) => hours * 3600, 6: () => ONE_WEEK };

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

/** A Z.ai coding plan's token limits (5-hour, weekly) are shared by all its models. */
export function zaiLimits(quota: ZaiQuota): Limit[] {
  return (quota.data?.limits ?? [])
    .flatMap((limit) => {
      const window = limit.type === "TOKENS_LIMIT" ? ZAI_WINDOW_SECONDS[limit.unit ?? -1] : undefined;
      if (!window || limit.percentage == null || !limit.nextResetTime) return [];
      return [
        {
          scope: null,
          usedPercent: limit.percentage,
          resetsAt: new Date(limit.nextResetTime).toISOString(),
          windowSeconds: window(limit.number ?? 1),
        },
      ];
    })
    .sort((a, b) => a.windowSeconds - b.windowSeconds);
}

/** One credential per enabled key, under the provider name the proxy routes and the usage log record it by. */
export function compatCredentials(entries: OpenAICompatibility[]): Credential[] {
  return entries.flatMap((entry) =>
    entry.disabled
      ? []
      : (entry["api-key-entries"] ?? []).flatMap((key) =>
          key["auth-index"]
            ? [
                {
                  provider: `openai-compatible-${(entry.name ?? "").trim().toLowerCase()}`,
                  auth_index: key["auth-index"],
                  label: entry.name ?? undefined,
                },
              ]
            : [],
        ),
  );
}

/** Unspent, unexpired reset grants, batched by what they refill and when they expire, soonest expiry first. */
export function claudeResets(grants: ClaudeResetGrants | null | undefined, now: number = Date.now()): Resets | null {
  if (!grants) return null;
  if (!grants.eligible) return { unavailable: grants.ineligible_reason ?? "not eligible" };
  const batches = new Map<string, { kind: string; count: number; expiresAt: string | null }>();
  for (const grant of grants.grants ?? []) {
    if ((grant.resets_left ?? 0) <= 0 || (grant.ends_at && Date.parse(grant.ends_at) <= now)) continue;
    const kind = grantKind(grant);
    const key = `${kind} ${grant.ends_at ?? ""}`;
    const batch = batches.get(key) ?? { kind, count: 0, expiresAt: grant.ends_at ?? null };
    batch.count += grant.resets_left!;
    batches.set(key, batch);
  }
  const live = [...batches.values()].sort(
    (a, b) =>
      (a.expiresAt ? Date.parse(a.expiresAt) : Infinity) - (b.expiresAt ? Date.parse(b.expiresAt) : Infinity),
  );
  return { available: live.reduce((sum, g) => sum + g.count, 0), grants: live };
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

/** Call the proxy's management API at `path`, version included: not every route exists on both /v0 and /v8. */
async function management<T>(config: LimitsConfig, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${config.proxyUrl}${path}`, {
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
    "/v8/management/requests/api-call",
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

/** Z.ai's coding plan reports a token limit per window and the plan's tier. */
async function zaiAccount(config: LimitsConfig, credential: Credential): Promise<AccountLimits> {
  const quota = await asAccount<ZaiQuota>(config, credential.auth_index, "https://api.z.ai/api/monitor/usage/quota/limit");
  return {
    label: accountLabel(credential),
    plan: quota.data?.level ?? null,
    limits: zaiLimits(quota),
    resets: null,
    error: null,
  };
}

/** Codex's credits, batched by expiry date; the count comes from usage, which is the authoritative one. */
function codexResets(usage: CodexUsage, credits: CodexResetCredits): Resets | null {
  const available = usage.rate_limit_reset_credits?.available_count;
  if (available == null) return null;
  const counts = new Map<string, number>();
  for (const credit of credits.credits ?? []) {
    if (credit.status !== "available" || !credit.expires_at) continue;
    counts.set(credit.expires_at, (counts.get(credit.expires_at) ?? 0) + 1);
  }
  const grants = [...counts.entries()].sort().map(([expiresAt, count]) => ({ kind: "credit", count, expiresAt }));
  return { available, grants };
}

const accountLabel = (credential: Credential): string =>
  credential.email || credential.label || credential.auth_index;

/** Keys configured under openai-compatibility. The credentials listing only covers auth files, so these come from
 * the config endpoint, which also gives each key the auth-index that api-call needs. */
async function compatKeys(config: LimitsConfig): Promise<Credential[]> {
  const listing = await management<{ "openai-compatibility"?: OpenAICompatibility[] }>(
    config,
    "/v0/management/openai-compatibility",
  );
  return compatCredentials(listing["openai-compatibility"] ?? []);
}

const fetchers: Record<string, (config: LimitsConfig, c: Credential) => Promise<AccountLimits>> = {
  claude: claudeAccount,
  codex: codexAccount,
  antigravity: antigravityAccount,
  "openai-compatible-zai-coding-plan": zaiAccount,
};

/** Limits for every enabled account the proxy knows, grouped by provider. */
export async function fetchLimits(config: LimitsConfig): Promise<Map<string, AccountLimits[]>> {
  const [{ files }, compat] = await Promise.all([
    management<{ files: Credential[] }>(config, "/v8/management/credentials"),
    // Losing these keys must not stall the auth-file accounts' limits too.
    compatKeys(config).catch((error: Error): Credential[] => {
      console.error(`openai-compatibility keys unavailable: ${error.message}`);
      return [];
    }),
  ]);
  const accounts = await Promise.all(
    [...files, ...compat]
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
