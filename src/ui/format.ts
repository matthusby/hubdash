import type { BucketSize } from "../types.ts";

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const full = new Intl.NumberFormat("en");

export const tokens = (n: number): string => compact.format(n);
export const tokensFull = (n: number): string => full.format(n);
export const percent = (n: number): string => `${Math.round(n)}%`;

const time = new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" });
const weekdayTime = new Intl.DateTimeFormat("en", { weekday: "short", hour: "numeric", minute: "2-digit" });
const monthDay = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });

/** "1:09 PM" today, "Tue 9:00 AM" within a week, otherwise "Nov 25". */
export function moment(ms: number, now: number = Date.now()): string {
  const days = (ms - now) / 86_400_000;
  if (Math.abs(days) < 1 && new Date(ms).getDate() === new Date(now).getDate()) return time.format(ms);
  if (Math.abs(days) < 6.5) return weekdayTime.format(ms);
  return monthDay.format(ms);
}

export function ago(ms: number, now: number = Date.now()): string {
  const minutes = Math.round((now - ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}

const hourLabel = new Intl.DateTimeFormat("en", { hour: "numeric" });
const weekday = new Intl.DateTimeFormat("en", { weekday: "short" });

export function bucketLabel(iso: string, size: BucketSize, short: boolean): string {
  const d = new Date(iso);
  if (size === "hour") return short ? hourLabel.format(d) : `${weekdayTime.format(d)}`;
  if (size === "week") return short ? monthDay.format(d) : `Week of ${monthDay.format(d)}`;
  return short ? monthDay.format(d) : `${weekday.format(d)} ${monthDay.format(d)}`;
}
