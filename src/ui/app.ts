import { pace } from "../pace.ts";
import {
  TOKEN_KINDS,
  emptyTokens,
  totalTokens,
  type AccountLimits,
  type Limit,
  type ProviderCard,
  type Range,
  type Summary,
  type Tokens,
  type UsageSeries,
} from "../types.ts";
import { KIND_LABELS, renderChart, type ChartPoint, type TokenKind } from "./chart.ts";
import * as fmt from "./format.ts";

const SUMMARY_POLL_MS = 60_000;
const USAGE_POLL_MS = 5 * 60_000;
const PROVIDER_NAMES: Record<string, string> = { claude: "Claude", codex: "Codex" };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const state = {
  summary: null as Summary | null,
  series: null as UsageSeries | null,
  range: (localStorage.getItem("range") as Range | null) ?? "week",
  provider: localStorage.getItem("provider") ?? "all",
  view: localStorage.getItem("view") ?? "chart",
  hidden: new Set<TokenKind>(JSON.parse(localStorage.getItem("hidden") ?? "[]")),
};

const providerName = (p: string) => PROVIDER_NAMES[p] ?? p;

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function limitHtml(limit: Limit, now: number): string {
  const p = pace(limit, now);
  const resetsAt = Date.parse(limit.resetsAt);
  const left = Math.max(0, 100 - limit.usedPercent);
  const exhausted = limit.usedPercent >= 100;
  const overPace = !exhausted && p.runsOutAt !== null;

  let estimate = '<span class="muted">too early to estimate</span>';
  if (exhausted) estimate = `<span class="pace-warning">limit reached</span>`;
  else if (p.runsOutAt !== null) estimate = `<span class="pace-warning">runs out ~${fmt.moment(p.runsOutAt, now)}</span>`;
  else if (p.projectedPercent !== null) estimate = `~${fmt.percent(100 - p.projectedPercent)} left at reset`;

  return `
    <div class="limit">
      <div class="limit-row">
        <span class="limit-name">${escape(limit.name)}</span>
        <span class="num">${fmt.percent(limit.usedPercent)} used · <strong>${fmt.percent(left)} left</strong></span>
      </div>
      <div class="meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${limit.usedPercent}"
           aria-label="${escape(limit.name)} usage">
        <div class="meter-fill ${exhausted ? "exhausted" : overPace ? "over-pace" : ""}"
             style="width:${Math.min(limit.usedPercent, 100)}%"></div>
        <div class="meter-elapsed" style="left:${p.elapsedFraction * 100}%" title="Window progress"></div>
      </div>
      <div class="limit-row limit-detail">
        <span class="num">${fmt.percent(p.elapsedFraction * 100)} through · resets ${fmt.moment(resetsAt, now)}</span>
        <span class="num">${estimate}</span>
      </div>
    </div>`;
}

function accountHtml(account: AccountLimits, showLabel: boolean, now: number): string {
  const head = showLabel || account.plan
    ? `<div class="account-head"><span>${escape(account.label)}</span><span>${escape(account.plan ?? "")}</span></div>`
    : "";
  if (account.error) {
    return `<div class="account">${head}<div class="account-error">Limits unavailable: ${escape(account.error)}</div></div>`;
  }
  const resets = account.resetsAvailable === null
    ? ""
    : `<div class="resets"><span>Resets available</span><span class="num"><strong>${account.resetsAvailable}</strong>${
        account.nextResetExpiry ? ` <span class="muted">· next expires ${fmt.moment(Date.parse(account.nextResetExpiry), now)}</span>` : ""
      }</span></div>`;
  const limits = account.limits.length
    ? account.limits.map((l) => limitHtml(l, now)).join("")
    : '<div class="account-error">No limits reported</div>';
  return `<div class="account">${head}${limits}${resets}</div>`;
}

function statHtml(label: string, t: Tokens): string {
  return `
    <div class="stat">
      <div class="stat-label">${label}</div>
      <div class="stat-value num" title="${fmt.tokensFull(totalTokens(t))} tokens">${fmt.tokens(totalTokens(t))}</div>
      <div class="stat-detail num">${fmt.tokens(t.input)} in · ${fmt.tokens(t.cacheRead + t.cacheWrite)} cache · ${fmt.tokens(t.output)} out</div>
    </div>`;
}

function cardHtml(card: ProviderCard, now: number): string {
  const multiple = card.accounts.length > 1;
  return `
    <article class="panel card">
      <div class="card-head"><h2>${escape(providerName(card.provider))}</h2></div>
      <div class="stats">${statHtml("Today", card.today)}${statHtml("Last 30 days", card.last30Days)}</div>
      ${card.accounts.map((a) => accountHtml(a, multiple, now)).join("")}
    </article>`;
}

function renderSummary(): void {
  const summary = state.summary;
  if (!summary) return;
  const now = Date.now();
  $("cards").innerHTML = summary.providers.map((c) => cardHtml(c, now)).join("");
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

function points(): ChartPoint[] {
  return (state.series?.buckets ?? []).map((bucket) => {
    const tokens = emptyTokens();
    for (const [provider, t] of Object.entries(bucket.byProvider)) {
      if (state.provider !== "all" && provider !== state.provider) continue;
      for (const k of TOKEN_KINDS) tokens[k] += t[k];
    }
    return { start: bucket.start, tokens };
  });
}

const shownKinds = (): TokenKind[] => TOKEN_KINDS.filter((k) => !state.hidden.has(k));

function renderLegend(): void {
  $("legend").innerHTML = TOKEN_KINDS.map(
    (k) => `<button type="button" data-kind="${k}" aria-pressed="${!state.hidden.has(k)}">
      <span class="swatch" style="background:var(--series-${k})"></span>${KIND_LABELS[k]}</button>`,
  ).join("");
}

function renderUsage(): void {
  syncPressed($("range"), state.range);
  syncPressed($("view"), state.view);
  renderLegend();
  const series = state.series;
  if (!series) return;
  const data = points();
  const showTable = state.view === "table";
  $("chart").hidden = showTable;
  $("table").hidden = !showTable;
  if (showTable) renderTable(data, series);
  else renderChart($("chart"), data, shownKinds(), series.bucketSize, (i, e) => showTooltip(data, series, i, e));
}

function renderTable(data: ChartPoint[], series: UsageSeries): void {
  const kinds = shownKinds();
  const rows = [...data].reverse().map(
    (p) => `<tr><td>${fmt.bucketLabel(p.start, series.bucketSize, false)}</td>${kinds
      .map((k) => `<td class="num">${fmt.tokensFull(p.tokens[k])}</td>`)
      .join("")}<td class="num">${fmt.tokensFull(kinds.reduce((s, k) => s + p.tokens[k], 0))}</td></tr>`,
  );
  $("table").innerHTML = `<table><thead><tr><th>${
    series.bucketSize === "hour" ? "Hour" : series.bucketSize === "week" ? "Week" : "Day"
  }</th>${kinds.map((k) => `<th>${KIND_LABELS[k]}</th>`).join("")}<th>Total</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

function showTooltip(data: ChartPoint[], series: UsageSeries, index: number | null, event?: MouseEvent): void {
  const tooltip = $("tooltip");
  const point = index === null ? undefined : data[index];
  if (!point || !event) {
    tooltip.hidden = true;
    return;
  }
  const kinds = shownKinds();
  tooltip.innerHTML = `
    <div class="tooltip-title">${fmt.bucketLabel(point.start, series.bucketSize, false)}</div>
    ${[...kinds].reverse().map((k) => `<div class="tooltip-row"><span class="swatch" style="background:var(--series-${k})"></span>
      <span>${KIND_LABELS[k]}</span><span class="num">${fmt.tokens(point.tokens[k])}</span></div>`).join("")}
    <div class="tooltip-total"><span>Total</span><span class="num">${fmt.tokens(kinds.reduce((s, k) => s + point.tokens[k], 0))}</span></div>`;
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
    const value = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-value]")?.dataset.value;
    if (value) handler(value);
  });
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
  renderProviderFilter();
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
