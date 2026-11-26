import { dayMonth } from "./dayMonth";

// The staff admin's words for when (26 Nov, Alex; the staff spec): Last in reads `Today`, `Yesterday`, `3 days ago`,
// else the day as d/m; With us `3 months`. Pure, for the server and the browser alike.

const DAY = 86_400_000;
const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Whole calendar days from `iso` to now (0 today). */
export function daysAgo(iso: string, now = new Date()): number {
  return Math.round((startOf(now) - startOf(new Date(iso))) / DAY);
}

/** `Now` (the last 15 minutes, only with `now: true`), `Today`, `Yesterday`, `3 days ago` up to a week, else `9/11`.
 *  Null for never. */
export function lastInWords(iso: string | null | undefined, opts: { now?: boolean } = {}): string | null {
  if (!iso || Number.isNaN(Date.parse(iso))) return null;
  const at = new Date(iso);
  if (opts.now && Date.now() - at.getTime() < 15 * 60_000) return "Now";
  const n = daysAgo(iso);
  if (n <= 0) return "Today";
  if (n === 1) return "Yesterday";
  if (n < 7) return `${n} days ago`;
  return dayMonth(at);
}

/** How long since a day, in the largest whole unit: `8 days`, `7 weeks`, `3 months`, `1 year`. */
export function lengthSince(iso: string, now = new Date()): string {
  const days = Math.max(0, daysAgo(iso, now));
  if (days < 14) return `${days} ${days === 1 ? "day" : "days"}`;
  if (days < 61) return `${Math.floor(days / 7)} weeks`;
  const months = Math.floor(days / 30.44);
  if (months < 12) return `${months} months`;
  const years = Math.floor(days / 365.25);
  return `${years} ${years === 1 ? "year" : "years"}`;
}
