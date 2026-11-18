// Real instants beside the text stamps (18 Nov, step 4 of docs/database-plan.md, part C).
//
// The app writes its times as text in two ways: localStamp's "YYYY-MM-DD HH:MM:SS", server-local with no zone
// (Europe/Amsterdam on Railway), and toISOString's "…T…Z" in UTC. Read as text they sort wrong around midnight and
// whenever the two clocks differ, so a query that filters or sorts by time (step 5 on) can't use them. Each such stamp
// gets a timestamptz column beside it, filled from the text by the app's own reading rule (stampMs, targetRule.ts):
// local text is Amsterdam wall time, ISO with a zone is that instant. The app keeps reading the text; nothing reads
// these columns yet.
//
// Here, in JS, for the mirror's writer (store.ts fills the column on every upsert); in SQL as norcoach_stamp() in
// migration 0016, for the backfill. The two agree to the millisecond, the hour that happens twice at the end of
// summer time included (the earlier of the two, as new Date(y, m, d, h…) reads it), and the hour skipped in spring
// (read with the offset before it). Where they could ever differ, the boot puts it right (store.ts derivedStale).
//
// Amsterdam is written out rather than taken from the process's zone: a server started without TZ set reads the same.

const ZONE = "Europe/Amsterdam";
const HOUR = 3_600_000;
const DAY = 86_400_000;

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/;
const LOCAL_STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

let parts: Intl.DateTimeFormat | null | undefined;
function formatter(): Intl.DateTimeFormat | null {
  if (parts === undefined) {
    try {
      parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: ZONE,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      parts = null; // no zone data: the process's own zone below, as stampMs reads it
    }
  }
  return parts;
}

// Amsterdam's offset changes only on whole UTC hours, so one look per hour is enough.
const offsets = new Map<number, number>();
/** Amsterdam's offset from UTC at instant `t` (ms). */
function offsetAt(t: number): number {
  const hour = Math.floor(t / HOUR);
  let o = offsets.get(hour);
  if (o === undefined) {
    const at = hour * HOUR;
    const f: Record<string, number> = {};
    for (const p of formatter()!.formatToParts(new Date(at))) if (p.type !== "literal") f[p.type] = Number(p.value);
    o = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second) - at;
    if (offsets.size > 200_000) offsets.clear();
    offsets.set(hour, o);
  }
  return o;
}

/** Amsterdam wall time as an instant, read as new Date(y, m - 1, d, h, mi, s, ms) reads local time there. */
function amsterdam(y: number, mo: number, d: number, h: number, mi: number, s: number, ms: number): number {
  if (!formatter()) return new Date(y, mo - 1, d, h, mi, s, ms).getTime();
  const wall = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  if (!Number.isFinite(wall)) return NaN;
  const before = offsetAt(wall - DAY);
  const after = offsetAt(wall + DAY);
  const fits = [...new Set([before, after])].map((o) => wall - o).filter((t) => offsetAt(t) === wall - t);
  // Twice (autumn): the earlier. Never (spring): the offset before the jump.
  return fits.length ? Math.min(...fits) : wall - before;
}

/** The instant a stored text stamp means (ms since 1970), or null when it means none. As stampMs reads it. */
export function stampInstantMs(at: unknown): number | null {
  if (typeof at !== "string" || !at) return null;
  let ms: number;
  const local = LOCAL_STAMP.test(at) || (!ZONED.test(at) && LOCAL.test(at)) ? LOCAL.exec(at) : null;
  if (local) {
    const frac = local[7] ? Number(local[7].slice(0, 3).padEnd(3, "0")) : 0;
    ms = amsterdam(+local[1], +local[2], +local[3], +local[4], +local[5], local[6] ? +local[6] : 0, frac);
  } else if (ZONED.test(at) || DATE_ONLY.test(at)) {
    ms = Date.parse(at);
  } else {
    return null;
  }
  return inColumnRange(ms) ? ms : null;
}

// What a timestamptz column takes from the ISO text the writer sends: years 0001 to 9999. Year 0000 (or an offset
// landing in it) is valid to Date.parse but refused by Postgres, which would fail the whole save; past 9999
// toISOString writes "+010000-…", refused too. Outside it the instant is NULL, as norcoach_stamp() reads it.
const FIRST_MS = -62135596800000; // 0001-01-01T00:00:00.000Z
const LAST_MS = 253402300799999; // 9999-12-31T23:59:59.999Z
function inColumnRange(ms: number): boolean {
  return Number.isFinite(ms) && ms >= FIRST_MS && ms <= LAST_MS;
}

/** As stampInstantMs, as the ISO text the column is written with. */
export function stampInstant(at: unknown): string | null {
  const ms = stampInstantMs(at);
  return ms == null ? null : new Date(ms).toISOString();
}

/** A count of milliseconds (once_keys' `at`) as the instant the column holds (whole ms, as new Date keeps it), or null. */
export function msInstantMs(at: unknown): number | null {
  if (typeof at !== "number" || !inColumnRange(at)) return null;
  return new Date(at).getTime();
}

/** A count of milliseconds (once_keys' `at`) as the ISO text the column is written with. */
export function msInstant(at: unknown): string | null {
  const ms = msInstantMs(at);
  return ms == null ? null : new Date(ms).toISOString();
}
