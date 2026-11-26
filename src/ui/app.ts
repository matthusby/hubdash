import { pace } from "../pace.ts";
import {
  TOKEN_KINDS,
  totalTokens,
  type AccountLimits,
  type Bucket,
  type Limit,
  type ProviderCard,
  type Range,
  type Resets,
  type Summary,
  type Tokens,
  type UsageSeries,
} from "../types.ts";
import { KIND_LABELS, pointTotal, renderChart, type ChartPoint, type Series, type TokenKind } from "./chart.ts";
import * as fmt from "./format.ts";

const SUMMARY_POLL_MS = 60_000;
const USAGE_POLL_MS = 5 * 60_000;
const MODEL_SLOTS = 4;
const OTHER = "__other__";
const PROVIDER_NAMES: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  antigravity: "Antigravity",
  "openai-compatible-zai-coding-plan": "Z.ai",
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const state = {
  summary: null as Summary | null,
  series: null as UsageSeries | null,
  range: (localStorage.getItem("range") as Range | null) ?? "week",
  provider: localStorage.getItem("provider") ?? "all",
  view: localStorage.getItem("view") ?? "chart",
  hidden: new Set<TokenKind>(JSON.parse(localStorage.getItem("hidden") ?? "[]")),
  model: localStorage.getItem("model") ?? "all",
  stack: localStorage.getItem("stack") ?? "type",
};

function setModel(model: string): void {
  state.model = model;
  localStorage.setItem("model", model);
}

const providerName = (p: string) => PROVIDER_NAMES[p] ?? p;

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The limits table: a row per provider and model group, a column per window, then resets and tokens. */
function limitsHtml(cards: ProviderCard[], now: number): string {
  const windows = [...new Set(cards.flatMap((c) => c.accounts.flatMap((a) => a.limits.map((l) => l.windowSeconds))))]
    .sort((a, b) => a - b);
  return `
    <table>
      <colgroup>
        <col class="col-provider" /><col class="col-group" />${windows.map(() => "<col />").join("")}
        <col class="col-num" /><col class="col-num" /><col class="col-num" />
      </colgroup>
      <thead><tr>
        <th></th><th></th>${windows.map((w) => `<th>${fmt.windowName(w)}</th>`).join("")}
        <th class="num-col">Resets</th><th class="num-col">Today</th><th class="num-col">30 days</th>
      </tr></thead>
      ${cards.map((c) => providerRows(c, windows, now)).join("")}
    </table>`;
}

function providerRows(card: ProviderCard, windows: number[], now: number): string {
  const labelled = card.accounts.length > 1;
  const rows = card.accounts.length
    ? card.accounts.flatMap((a) => accountRows(a, labelled, windows, now))
    : [`<td></td><td colspan="${windows.length + 1}" class="note">No limits</td>`];
  const span = `rowspan="${rows.length}"`;
  const plan = !labelled && card.accounts[0]?.plan ? `<span class="plan">${escape(card.accounts[0].plan)}</span>` : "";
  const provider = `<th ${span} class="provider">${escape(providerName(card.provider))}${plan}</th>`;
  const tokens = [card.today, card.last30Days]
    .map((t) => `<td ${span} class="num-col" title="${tokensDetail(t)}">${fmt.tokens(totalTokens(t))}</td>`)
    .join("");
  return `<tbody>${rows.map((cells, i) => `<tr>${i === 0 ? provider : ""}${cells}${i === 0 ? tokens : ""}</tr>`).join("")}</tbody>`;
}

/** Cells for each of an account's rows: one per model group, unscoped ("All models") first. */
function accountRows(account: AccountLimits, labelled: boolean, windows: number[], now: number): string[] {
  const scopes = [...new Set(account.limits.map((l) => l.scope))].sort((a, b) => Number(a !== null) - Number(b !== null));
  const name = `${account.label}${account.plan ? ` · ${account.plan}` : ""}`;
  const label = labelled ? `<span class="account" title="${escape(name)}">${escape(name)}</span>` : "";
  const note = account.error ? `Limits unavailable: ${escape(account.error)}` : scopes.length ? null : "No limits reported";
  const rows = note
    ? [`<td class="group">${label}</td><td colspan="${windows.length}" class="note">${note}</td>`]
    : scopes.map((scope, i) => {
        const group = scope ?? "All models";
        const cells = windows.map((w) => {
          const limit = account.limits.find((l) => l.scope === scope && l.windowSeconds === w);
          return limit ? limitCell(limit, `${group} ${fmt.windowName(w)}`, now) : "<td></td>";
        });
        return `<td class="group">${escape(group)}${i === 0 ? label : ""}</td>${cells.join("")}`;
      });
  rows[0] += `<td rowspan="${rows.length}" class="num-col">${resetsHtml(account.resets)}</td>`;
  return rows;
}

/** How much is left and when it resets, or a warning if it runs out first; the rest is on hover. */
function limitCell(limit: Limit, name: string, now: number): string {
  const p = pace(limit, now);
  const resetsAt = fmt.moment(Date.parse(limit.resetsAt), now);
  const exhausted = limit.usedPercent >= 100;
  const overPace = !exhausted && p.runsOutAt !== null;

  let when = resetsAt;
  if (exhausted) when = `<span class="pace-warning">limit reached</span>`;
  else if (p.runsOutAt !== null) when = `<span class="pace-warning">runs out ~${fmt.moment(p.runsOutAt, now)}</span>`;

  const detail = [
    `${fmt.percent(limit.usedPercent)} used`,
    `${fmt.percent(p.elapsedFraction * 100)} through the window`,
    `resets ${resetsAt}`,
    exhausted || overPace ? "" : p.projectedPercent === null
      ? "too early to estimate"
      : `~${fmt.percent(100 - p.projectedPercent)} left at reset at this pace`,
  ].filter(Boolean).join(" · ");

  return `
    <td><div class="limit" title="${escape(detail)}">
      <span class="limit-left num"><strong>${fmt.percent(Math.max(0, 100 - limit.usedPercent))}</strong> left</span>
      <div class="meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${limit.usedPercent}"
           aria-label="${escape(name)} usage">
        <div class="meter-fill ${exhausted ? "exhausted" : overPace ? "over-pace" : ""}"
             style="width:${Math.min(limit.usedPercent, 100)}%"></div>
        <div class="meter-elapsed" style="left:${p.elapsedFraction * 100}%"></div>
      </div>
      <span class="limit-when num">${when}</span>
    </div></td>`;
}

const UNAVAILABLE_REASONS: Record<string, string> = {
  cli_version: "Claude Code version too old; raise CLAUDE_CODE_VERSION",
};

/** The count of resets the account can spend; what each batch refills and when it expires is on hover. */
function resetsHtml(resets: Resets | null): string {
  if (!resets) return '<span class="muted">–</span>';
  if ("unavailable" in resets) {
    const reason = UNAVAILABLE_REASONS[resets.unavailable] ?? resets.unavailable;
    return `<span class="muted" title="Resets unknown: ${escape(reason)}">?</span>`;
  }
  const detail = resets.grants
    .map((g) => `${g.count}× ${g.kind}${g.expiresAt ? ` · expires ${fmt.stamp(Date.parse(g.expiresAt))}` : ""}`)
    .join("\n");
  return `<span title="${escape(detail)}">${resets.available}</span>`;
}

const tokensDetail = (t: Tokens) =>
  `${fmt.tokensFull(totalTokens(t))} tokens: ${fmt.tokens(t.input)} in · ${fmt.tokens(t.cacheRead + t.cacheWrite)} cache · ${fmt.tokens(t.output)} out`;

function renderSummary(): void {
  const summary = state.summary;
  if (!summary) return;
  const now = Date.now();
  const limits = $("limits");
  limits.hidden = summary.providers.length === 0;
  limits.innerHTML = limitsHtml(summary.providers, now);
  $("updated").textContent = summary.limitsFetchedAt
    ? `Limits updated ${fmt.ago(Date.parse(summary.limitsFetchedAt), now)}`
    : "Limits not loaded yet";
  renderProviderFilter();
}

function renderProviderFilter(): void {
  const providers = ["all", ...(state.summary?.providers.map((c) => c.provider) ?? [])];
  const group = $("provider");
  const key = providers.join(",");
  if (group.dataset.key !== key) {
    group.dataset.key = key;
    group.innerHTML = providers
      .map((p) => `<button type="button" data-value="${escape(p)}">${p === "all" ? "All" : escape(providerName(p))}</button>`)
      .join("");
  }
  syncPressed(group, state.provider);
}

interface ModelUsage {
  provider: string;
  model: string;
  tokens: Tokens;
}

const matchesProvider = (provider: string) => state.provider === "all" || provider === state.provider;

function bucketUsage(bucket: Bucket): ModelUsage[] {
  return Object.entries(bucket.byProvider).flatMap(([provider, models]) =>
    Object.entries(models).map(([model, tokens]) => ({ provider, model, tokens })),
  );
}

function providerOf(model: string): string | undefined {
  for (const bucket of state.series?.buckets ?? []) {
    for (const [provider, models] of Object.entries(bucket.byProvider)) if (model in models) return provider;
  }
}

/** Models in the current range under the provider filter, busiest first. */
function rankedModels(): { model: string; provider: string }[] {
  const totals = new Map<string, { model: string; provider: string; total: number }>();
  for (const bucket of state.series?.buckets ?? []) {
    for (const { provider, model, tokens } of bucketUsage(bucket)) {
      if (!matchesProvider(provider)) continue;
      const entry = totals.get(model) ?? set(totals, model, { model, provider, total: 0 });
      entry.total += totalTokens(tokens);
    }
  }
  return [...totals.values()].sort((a, b) => b.total - a.total);
}

const stackBy = (): "type" | "model" => (state.model === "all" && state.stack === "model" ? "model" : "type");

const modelSeries = (models: string[]): Series[] =>
  models.map((model, i) => ({ key: model, label: fmt.modelName(model), color: `var(--slot-${i + 1})` }));

/** Chart layers; model stacking keeps the top slots and folds the rest into Other. */
function chartSeries(ranked: string[]): Series[] {
  if (stackBy() === "type") {
    return TOKEN_KINDS.filter((k) => !state.hidden.has(k)).map((k) => ({
      key: k,
      label: KIND_LABELS[k],
      color: `var(--slot-${TOKEN_KINDS.indexOf(k) + 1})`,
    }));
  }
  if (ranked.length <= MODEL_SLOTS) return modelSeries(ranked);
  return [...modelSeries(ranked.slice(0, MODEL_SLOTS)), { key: OTHER, label: "Other", color: "var(--slot-other)" }];
}

function points(series: Series[]): ChartPoint[] {
  const byModel = stackBy() === "model";
  const keys = new Set(series.map((s) => s.key));
  return (state.series?.buckets ?? []).map((bucket) => {
    const values: Record<string, number> = Object.fromEntries(series.map((s) => [s.key, 0]));
    for (const { provider, model, tokens } of bucketUsage(bucket)) {
      if (!matchesProvider(provider) || (state.model !== "all" && model !== state.model)) continue;
      if (byModel) {
        const key = keys.has(model) ? model : OTHER;
        values[key] = (values[key] ?? 0) + totalTokens(tokens);
      } else {
        for (const s of series) values[s.key] = (values[s.key] ?? 0) + tokens[s.key as TokenKind];
      }
    }
    return { start: bucket.start, values };
  });
}

function renderModelFilter(ranked: { model: string; provider: string }[]): void {
  const option = (model: string) =>
    `<option value="${escape(model)}">${escape(fmt.modelName(model))}</option>`;
  const known = ranked.some((r) => r.model === state.model);
  const groups = [...new Set(ranked.map((r) => r.provider))].map((provider) => {
    const options = ranked.filter((r) => r.provider === provider).map((r) => option(r.model)).join("");
    return state.provider === "all" ? `<optgroup label="${escape(providerName(provider))}">${options}</optgroup>` : options;
  });
  const select = $<HTMLSelectElement>("model");
  select.innerHTML = [
    '<option value="all">All models</option>',
    state.model === "all" || known ? "" : option(state.model),
    ...groups,
  ].join("");
  select.value = state.model;
}

function renderLegend(series: Series[]): void {
  const legend = $("legend");
  if (stackBy() === "model") {
    legend.setAttribute("aria-label", "Models");
    legend.innerHTML = series
      .map((s) => `<span class="chip"><span class="swatch" style="background:${s.color}"></span>${escape(s.label)}</span>`)
      .join("");
    return;
  }
  legend.setAttribute("aria-label", "Token types (click to show or hide)");
  legend.innerHTML = TOKEN_KINDS.map(
    (k) => `<button type="button" data-kind="${k}" aria-pressed="${!state.hidden.has(k)}">
      <span class="swatch" style="background:var(--slot-${TOKEN_KINDS.indexOf(k) + 1})"></span>${KIND_LABELS[k]}</button>`,
  ).join("");
}

function renderUsage(): void {
  syncPressed($("range"), state.range);
  syncPressed($("view"), state.view);
  syncPressed($("stack"), stackBy());
  const modelStack = $("stack").querySelector<HTMLButtonElement>('[data-value="model"]')!;
  modelStack.disabled = state.model !== "all";
  modelStack.title = modelStack.disabled ? "Choose All models to stack by model" : "";

  const ranked = rankedModels();
  renderModelFilter(ranked);
  const rankedIds = ranked.map((r) => r.model);
  const series = chartSeries(rankedIds);
  renderLegend(series);

  const usage = state.series;
  if (!usage) return;
  const showTable = state.view === "table";
  $("chart").hidden = showTable;
  $("table").hidden = !showTable;
  if (showTable) {
    const columns = stackBy() === "model" ? modelSeries(rankedIds) : series;
    renderTable(points(columns), columns, usage);
  } else {
    const data = points(series);
    const empty = series.length === 0 ? "All token types hidden" : "No usage in this range";
    renderChart($("chart"), data, series, usage.bucketSize, empty, (i, e) => showTooltip(data, series, usage, i, e));
  }
}

function renderTable(data: ChartPoint[], columns: Series[], usage: UsageSeries): void {
  const rows = [...data].reverse().map(
    (p) => `<tr><td>${fmt.bucketLabel(p.start, usage.bucketSize, false)}</td>${columns
      .map((s) => `<td class="num">${fmt.tokensFull(p.values[s.key] ?? 0)}</td>`)
      .join("")}<td class="num">${fmt.tokensFull(pointTotal(p, columns))}</td></tr>`,
  );
  $("table").innerHTML = `<table><thead><tr><th>${
    usage.bucketSize === "hour" ? "Hour" : usage.bucketSize === "week" ? "Week" : "Day"
  }</th>${columns.map((s) => `<th>${escape(s.label)}</th>`).join("")}<th>Total</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

function showTooltip(data: ChartPoint[], series: Series[], usage: UsageSeries, index: number | null, event?: MouseEvent): void {
  const tooltip = $("tooltip");
  const point = index === null ? undefined : data[index];
  if (!point || !event) {
    tooltip.hidden = true;
    return;
  }
  tooltip.innerHTML = `
    <div class="tooltip-title">${fmt.bucketLabel(point.start, usage.bucketSize, false)}</div>
    ${[...series].reverse().map((s) => `<div class="tooltip-row"><span class="swatch" style="background:${s.color}"></span>
      <span>${escape(s.label)}</span><span class="num">${fmt.tokens(point.values[s.key] ?? 0)}</span></div>`).join("")}
    <div class="tooltip-total"><span>Total</span><span class="num">${fmt.tokens(pointTotal(point, series))}</span></div>`;
  tooltip.hidden = false;

  const panel = tooltip.offsetParent as HTMLElement;
  const box = panel.getBoundingClientRect();
  const x = event.clientX - box.left;
  const flip = x + tooltip.offsetWidth + 24 > box.width;
  tooltip.style.left = `${flip ? x - tooltip.offsetWidth - 16 : x + 16}px`;
  tooltip.style.top = `${event.clientY - box.top - tooltip.offsetHeight / 2}px`;
}

function syncPressed(group: HTMLElement, value: string): void {
  for (const button of group.querySelectorAll<HTMLButtonElement>("button[data-value]")) {
    button.setAttribute("aria-pressed", String(button.dataset.value === value));
  }
}

function onSegment(id: string, handler: (value: string) => void): void {
  $(id).addEventListener("click", (e) => {
    const value = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-value]:not(:disabled)")?.dataset.value;
    if (value) handler(value);
  });
}

function set<K, V>(map: Map<K, V>, key: K, value: V): V {
  map.set(key, value);
  return value;
}

async function loadSummary(refresh = false): Promise<void> {
  const response = await fetch(refresh ? "/api/refresh" : "/api/summary", { method: refresh ? "POST" : "GET" });
  state.summary = (await response.json()) as Summary;
  renderSummary();
}

async function loadUsage(): Promise<void> {
  const response = await fetch(`/api/usage?range=${state.range}`);
  state.series = (await response.json()) as UsageSeries;
  renderUsage();
}

onSegment("range", (value) => {
  state.range = value as Range;
  localStorage.setItem("range", value);
  void loadUsage();
});
onSegment("provider", (value) => {
  state.provider = value;
  localStorage.setItem("provider", value);
  const modelProvider = providerOf(state.model);
  if (modelProvider && !matchesProvider(modelProvider)) setModel("all");
  renderProviderFilter();
  renderUsage();
});
onSegment("stack", (value) => {
  state.stack = value;
  localStorage.setItem("stack", value);
  renderUsage();
});
$("model").addEventListener("change", (e) => {
  setModel((e.target as HTMLSelectElement).value);
  renderUsage();
});
onSegment("view", (value) => {
  state.view = value;
  localStorage.setItem("view", value);
  renderUsage();
});
$("legend").addEventListener("click", (e) => {
  const kind = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-kind]")?.dataset.kind as TokenKind | undefined;
  if (!kind) return;
  if (state.hidden.has(kind)) state.hidden.delete(kind);
  else state.hidden.add(kind);
  localStorage.setItem("hidden", JSON.stringify([...state.hidden]));
  renderUsage();
});
$("refresh").addEventListener("click", async (e) => {
  const button = e.currentTarget as HTMLButtonElement;
  button.classList.add("spinning");
  await Promise.all([loadSummary(true), loadUsage()]);
  button.classList.remove("spinning");
});
new ResizeObserver(() => state.view === "chart" && renderUsage()).observe($("chart"));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void Promise.all([loadSummary(), loadUsage()]);
});
setInterval(() => document.visibilityState === "visible" && void loadSummary(), SUMMARY_POLL_MS);
setInterval(() => document.visibilityState === "visible" && void loadUsage(), USAGE_POLL_MS);

renderUsage();
void Promise.all([loadSummary(), loadUsage()]);
