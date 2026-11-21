// What the coach-wide reads of the food diary and the check-in figures take (21 Nov, the bounded slices of
// docs/database-plan.md's food and check-in items): the predicates, once, for the SQL the doors run (food/slices.ts,
// checkins/slices.ts), the partial indexes migration 0024 makes (schema.ts repeats these strings word for word, so the
// planner proves a query implies its index), and the JS the narrow views and the shadows run over rows in memory.
//
// An event of the coach's feed is a group of rows (activityFeeds, queries.ts): a food day (a client's entries and their
// calorie logs on a date), a calorie log alone, a check-in (a client's typed figures of one frequency in a period and
// its note). Its moment is the latest of its rows' stamps as the readers read them (stampMs), else midday of its day.
// A slice takes whole groups, chosen by a superset of "its moment is at or after T": a row stamped at or after
// T − STAMP_MARGIN_MS (the stored instant, pg/stamps.ts, read in Amsterdam; the readers read the process's zone: the
// same in Amsterdam, never more than 14 hours apart elsewhere), or a row with no stamp dated on or after T's local day
// (a group with no stamp at all files at its midday), or an odd row (a stamp or a day the readers and the instant might
// read otherwise, or a value the column couldn't hold; kept whole with its group, few). A group none of whose rows is
// any of those has its moment before T (its stamps before T, or its day before T's), so a reader keeping only the events
// at or after T reads exactly what the whole history gives; a group a slice holds in part (another span's rows, say the
// newest period of a metric) is one none of whose rows is any of those, so its built moment is before T too.
//
// No imports but the stamps, so schema.ts, the doors and the scripts can all read it.

import { stampInstantMs } from "./stamps";

/**
 * How far a stored instant may sit from the readers' own reading of the same stamp: a second where the process runs in
 * Amsterdam's zone (Railway's TZ, where the two readings of the two clean shapes agree to the millisecond, pg/stamps.ts),
 * else 36 hours (any zone on earth). Read once at load against the process's own clock across two years of hours, both
 * DST changes included; never a wrong answer either way, only a wider window.
 */
export const STAMP_MARGIN_MS = zoneIsAmsterdam() ? 1000 : 36 * 3_600_000;
/** How many of a client's newest rows a candidate looks through before giving up (food/slices.ts, checkins/slices.ts). */
export const CANDIDATE_LOOKAHEAD = 50;
function zoneIsAmsterdam(): boolean {
  try {
    const p = (v: number) => String(v).padStart(2, "0");
    const same = (y: number, mo: number, d: number, h: number, mi: number, s: number) =>
      stampInstantMs(`${y}-${p(mo)}-${p(d)} ${p(h)}:${p(mi)}:${p(s)}`) === new Date(y, mo - 1, d, h, mi, s).getTime();
    for (let t = Date.UTC(2025, 0, 1); t < Date.UTC(2027, 0, 1); t += 3_600_000 * 7 + 60_000 * 13) {
      const d = new Date(t);
      if (!same(d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds())) return false;
    }
    // The hour that happens twice in autumn, and the one skipped in spring.
    return same(2026, 10, 25, 2, 30, 0) && same(2026, 3, 29, 2, 30, 0) && same(2025, 10, 26, 2, 0, 0) && same(2025, 3, 30, 2, 59, 59);
  } catch {
    return false;
  }
}

/** A day as the readers write one (YYYY-MM-DD, ASCII digits). */
export const DAY_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const LOCAL_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$/;
const ISO_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?(Z|[+-][0-9]{2}:[0-9]{2})$/;

// ---- SQL (immutable: the partial indexes hold them) ----------------------------------------------------------------

const DAY_SQL = `'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`;
/** A stamp of the two shapes the app writes, on which the readers and the stored instant agree. */
const clean = (s: string) => `(${s} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$' OR ${s} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,3})?(Z|[+-][0-9]{2}:[0-9]{2})$')`;
/** A stamp there is (the readers skip none and ''). */
const stamped = (s: string) => `(${s} IS NOT NULL AND ${s} <> '')`;
/** A stamp the readers may read otherwise than the instant: not one of the two shapes, or no instant for it. */
const oddStamp = (s: string, tz: string) => `(${stamped(s)} AND (${tz} IS NULL OR NOT ${clean(s)}))`;
const notDay = (d: string) => `(NOT (COALESCE(${d}, '') ~ ${DAY_SQL}))`;

// Each takes the table's alias with its dot ("e."), or none (the indexes).
export const SQL_NONHEALTH = (a = "") => `((${a}extra ->> 'source') IS DISTINCT FROM 'health')`;
export const SQL_DAY = (d: string) => `(${d} ~ ${DAY_SQL})`;
/** No stamp: none or '', and not one the column couldn't hold (kept in extra). */
// (A NULL extra holds nothing: every NOT over it is COALESCEd, so a row with none reads as the JS reads it.)
export const SQL_BLANK = (s: string, a = "") => `((${a}${s} IS NULL OR ${a}${s} = '') AND NOT COALESCE(${a}extra ? '${s}', false))`;
export const SQL_STAMPED = (s: string, a = "") => stamped(`${a}${s}`);

/** A food entry the slices keep whole wherever its client is read: an odd day or stamp. */
export const SQL_ODD_ENTRY = (a = "") => `(${notDay(`${a}date`)} OR (${a}extra ? 'logged_at') OR ${oddStamp(`${a}logged_at`, `${a}logged_at_tz`)})`;
/** A calorie log the same (the phone's are no event of the client's, never odd). */
export const SQL_ODD_CALORIE = (a = "") => `(${SQL_NONHEALTH(a)} AND (${notDay(`${a}date`)} OR (${a}extra ? 'logged_at') OR ${oddStamp(`${a}logged_at`, `${a}logged_at_tz`)}))`;
/** A figure the client typed (as activityFeeds counts one): a value, not the phone's. */
export const SQL_TYPED = (a = "") => `(${a}value IS NOT NULL AND ${SQL_NONHEALTH(a)})`;
/** A typed figure the slices keep whole: a value the column couldn't hold (kept in extra), an odd period or stamp. */
export const SQL_ODD_FIGURE = (a = "") =>
  `((${a}value IS NOT NULL OR (${a}extra ? 'value')) AND ${SQL_NONHEALTH(a)} AND ((${a}extra ? 'value') OR ${notDay(`${a}period`)} OR (${a}extra ? 'logged_at') OR ${oddStamp(`${a}logged_at`, `${a}logged_at_tz`)}))`;
/** A check-in note the slices keep whole: an odd period or stamp. */
export const SQL_ODD_NOTE = (a = "") => `(${notDay(`${a}period`)} OR (${a}extra ? 'created_at') OR ${oddStamp(`${a}created_at`, `${a}created_at_tz`)})`;
/** A day photo or saved meal that may still want its look (prepareAllChatMedia filters further, storage.ts). */
export const SQL_NOLOOK_PHOTO = `(NOT COALESCE(jsonb_typeof(extra -> 'thumb') = 'string' AND (extra ->> 'thumb') <> '', false))`;
export const SQL_NOLOOK_SAVED = `((extra -> 'picture') IS NOT NULL AND jsonb_typeof(extra -> 'picture') <> 'null' AND NOT COALESCE(jsonb_typeof(extra -> 'picture_thumb') = 'string' AND (extra ->> 'picture_thumb') <> '', false))`;

// ---- The same in JS, over rows as the store holds them ----------------------------------------------------------------

type Any = Record<string, unknown>;
const isStamped = (s: unknown) => s != null && s !== "";
const isOddStamp = (s: unknown) => (s != null && typeof s !== "string") || (typeof s === "string" && s !== "" && (stampInstantMs(s) == null || !(LOCAL_RE.test(s) || ISO_RE.test(s))));
const isNotDay = (d: unknown) => typeof d !== "string" || !DAY_RE.test(d);
export const nonHealth = (r: Any) => r.source !== "health";
export const isDay = (d: unknown): d is string => typeof d === "string" && DAY_RE.test(d);
export const isBlank = (s: unknown) => !isStamped(s);
/** The stored instant of a stamp (what logged_at_tz / created_at_tz hold), or null. */
export const instantOf = (s: unknown) => stampInstantMs(s);

export const oddEntry = (r: Any) => isNotDay(r.date) || isOddStamp(r.logged_at);
export const oddCalorie = (r: Any) => nonHealth(r) && (isNotDay(r.date) || isOddStamp(r.logged_at));
export const typedFigure = (r: Any) => r.value != null && nonHealth(r);
export const oddFigure = (r: Any) => r.value != null && nonHealth(r) && (typeof r.value !== "number" || isNotDay(r.period) || isOddStamp(r.logged_at));
export const oddNote = (r: Any) => isNotDay(r.period) || isOddStamp(r.created_at);
export const noLookPhoto = (r: Any) => !(typeof r.thumb === "string" && r.thumb !== "");
export const noLookSaved = (r: Any) => r.picture != null && !(typeof r.picture_thumb === "string" && r.picture_thumb !== "");

// ---- The readers' own clock (queries.ts), for the doors' counts and cuts ----------------------------------------------

/** queries.ts stampMs, word for word: "YYYY-MM-DD HH:MM:SS" in the process's zone, anything else as Date reads it. */
export function readerStampMs(at: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(at);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  return new Date(at).getTime();
}
/** queries.ts middayMs. */
export const readerMiddayMs = (day: string) => readerStampMs(`${day} 12:00:00`);
/** queries.ts latestOf (a first unreadable stamp keeps the group's moment unreadable, as there). */
export const readerLatestOf = (a: string | null, b: string | undefined | null) => (b && (!a || readerStampMs(b) > readerStampMs(a)) ? b : a);

/** The process's local day of an instant (queries.ts localDateStr). */
function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
/** The day on or after which a group none of whose rows has a stamp may have its moment (its midday) at or after T. */
export function dayBound(t: number): string {
  // A day before T's local day has its midday before T, whatever the zone.
  return Number.isFinite(t) ? localDay(t) : "0000-00-00";
}
/** The ISO text of an instant for SQL (−∞ as the earliest a column holds). */
export const isoOf = (t: number) => (Number.isFinite(t) ? new Date(Math.max(t, -62135596800000)).toISOString() : "0001-01-01T00:00:00.000Z");

/** The Feed's rounds (coachTop): the newest n are inside the first window holding n, 3 days doubled each round, then all. */
export const TOP_ROUNDS_DAYS = [3, 6, 12, 24, 48, 96, 192, 384, 768, 1536];
