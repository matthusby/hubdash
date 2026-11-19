import type { Limit } from "./types.ts";

export interface Pace {
  elapsedFraction: number;
  /** Usage at reset if the current rate holds; null until enough of the window has passed. */
  projectedPercent: number | null;
  /** Epoch ms when the limit runs out at the current rate; null if it won't before reset. */
  runsOutAt: number | null;
}

const MIN_ELAPSED_FRACTION = 0.05;

export function pace(limit: Limit, now: number): Pace {
  const windowMs = limit.windowSeconds * 1000;
  const elapsedMs = windowMs - (Date.parse(limit.resetsAt) - now);
  const elapsedFraction = Math.min(Math.max(elapsedMs / windowMs, 0), 1);

  if (elapsedFraction < MIN_ELAPSED_FRACTION) {
    return { elapsedFraction, projectedPercent: null, runsOutAt: null };
  }

  const projectedPercent = limit.usedPercent / elapsedFraction;
  const runsOutAt =
    projectedPercent > 100 && limit.usedPercent > 0 && limit.usedPercent < 100
      ? now + ((100 - limit.usedPercent) * elapsedMs) / limit.usedPercent
      : null;

  return { elapsedFraction, projectedPercent, runsOutAt };
}
