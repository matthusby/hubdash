import type { BucketSize } from "../types.ts";

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const full = new Intl.NumberFormat("en");

export const tokens = (n: number): string => compact.format(n);
export const tokensFull = (n: number): string => full.format(n);
export const percent = (n: number): string => `${Math.round(n)}%`;

/** "5-hour", "Weekly", "30-day": a limit's window as a column heading. */
export function windowName(seconds: number): string {
  if (seconds === 5 * 3600) return "5-hour";
  if (seconds === 7 * 86400) return "Weekly";
  return seconds % 86400 === 0 ? `${seconds / 86400}-day` : `${Math.round(seconds / 3600)}-hour`;
}

const time = new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" });
const weekdayTime = new Intl.DateTimeFormat("en", { weekday: "short", hour: "numeric", minute: "2-digit" });
const monthDay = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });
const stampFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

/** "1:09 PM" today, "Tue 9:00 AM" within a week, otherwise "Nov 25". */
export function moment(ms: number, now: number = Date.now()): string {
  const days = (ms - now) / 86_400_000;
  if (Math.abs(days) < 1 && new Date(ms).getDate() === new Date(now).getDate()) return time.format(ms);
  if (Math.abs(days) < 6.5) return weekdayTime.format(ms);
  return monthDay.format(ms);
}

/** "Dec 1, 2026, 12:00 AM": the absolute date and time, where moment's is relative. */
export const stamp = (ms: number): string => stampFormat.format(ms);

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

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "claude-opus-5-5" → "Opus 5.5", "gpt-6.1-sol" → "GPT-6.1 Sol"; unknown ids pass through. */
export function modelName(id: string): string {
  const claude = /^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8})?$/.exec(id);
  if (claude) return `${capitalize(claude[1]!)} ${claude[2]}.${claude[3]}`;
  const gpt = /^gpt-([\d.]+)(?:-([a-z]+))?$/.exec(id);
  if (gpt) return `GPT-${gpt[1]}${gpt[2] ? ` ${capitalize(gpt[2])}` : ""}`;
  return id;
}
