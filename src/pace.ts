import type { Limit, Trend } from "./types.ts";

export interface Pace {
  elapsedFraction: number;
  /** Usage at reset if the current rate holds; null until enough of the window has passed. */
  projectedPercent: number | null;
  /** Epoch ms when the limit runs out at the current rate; null if it won't before reset. */
  runsOutAt: number | null;
  /** True when the projection follows the recent burn rate instead of the whole window. */
  fromTrend: boolean;
  /** Recent burn rate in percent/hour, when known. */
  trendRate: number | null;
}

const MIN_ELAPSED_FRACTION = 0.05;
/** How far back the burn-rate estimate looks. */
const TREND_SPAN_MS = 6 * 3_600_000;

export function pace(limit: Limit, now: number, trend: Trend | null = null): Pace {
  const windowMs = limit.windowSeconds * 1000;
  const resetsAt = Date.parse(limit.resetsAt);
  const elapsedMs = windowMs - (resetsAt - now);
  const elapsedFraction = Math.min(Math.max(elapsedMs / windowMs, 0), 1);

  // A recent burn rate beats the whole-window average: usage comes in bursts, so the
  // window pace underestimates until late. An idle rate means no run-out we can see.
  if (trend) {
    const rate = Math.max(trend.percentPerHour, 0);
    const runsOutAt = rate > 0 && limit.usedPercent > 0 && limit.usedPercent < 100
      ? now + ((100 - limit.usedPercent) / rate) * 3_600_000
      : null;
    const projectedPercent = rate > 0
      ? Math.min(100, limit.usedPercent + rate * ((resetsAt - now) / 3_600_000))
      : limit.usedPercent;
    return { elapsedFraction, projectedPercent, runsOutAt, fromTrend: true, trendRate: rate > 0 ? rate : null };
  }

  if (elapsedFraction < MIN_ELAPSED_FRACTION) {
    return { elapsedFraction, projectedPercent: null, runsOutAt: null, fromTrend: false, trendRate: null };
  }

  const projectedPercent = limit.usedPercent / elapsedFraction;
  const runsOutAt =
    projectedPercent > 100 && limit.usedPercent > 0 && limit.usedPercent < 100
      ? now + ((100 - limit.usedPercent) * elapsedMs) / limit.usedPercent
      : null;

  return { elapsedFraction, projectedPercent, runsOutAt, fromTrend: false, trendRate: null };
}

/** Burn rate over the last few hours of uninterrupted samples, in percent/hour; null when idle or unknown.
 *  A sample where usage drops is a refill: only the stretch since then counts. */
export function trendOf(samples: { t: number; used: number }[], now: number): Trend | null {
  let start = samples.length - 1;
  while (
    start > 0 &&
    samples[start - 1]!.used <= samples[start]!.used &&
    now - samples[start - 1]!.t <= TREND_SPAN_MS
  ) {
    start--;
  }
  const run = samples.slice(start);
  if (run.length < 2) return null;

  const t0 = run[0]!.t;
  const xs = run.map((s) => (s.t - t0) / 3_600_000);
  const ys = run.map((s) => s.used);
  const meanX = xs.reduce((a, b) => a + b) / xs.length;
  const meanY = ys.reduce((a, b) => a + b) / ys.length;
  let cov = 0;
  let varX = 0;
  for (let i = 0; i < run.length; i++) {
    cov += (xs[i]! - meanX) * (ys[i]! - meanY);
    varX += (xs[i]! - meanX) ** 2;
  }
  const slope = varX > 0 ? cov / varX : 0;
  return slope > 0 ? { percentPerHour: slope } : null;
}
