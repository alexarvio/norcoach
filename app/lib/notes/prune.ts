// The nightly clean-up of old read check-in reminders (19 Nov, Alex: "lets go with your suggestion"). A reminder the
// client has read and that is more than 30 days old is deleted for good: about four rows in five of the table, never in
// the notification list (notificationTypes.ts isListed), though they took room in the bell's newest 50 (accepted). The
// last 30 nightly backups still hold one deleted (backup.ts KEEP_SNAPSHOTS), then it is gone everywhere; the clean-up
// runs only once that night's backup is in the bucket (instrumentation.ts).
//
// One rule, two ways: `prunableIds` on the store's rows (memory mode), `pruneOn` as statements on a table (NOTES_STORE=pg
// on coach_activity; the write shadow on coach_activity_shadow, to compare). Both take the same rows, oldest first (the
// instant, then id), up to the same cap, so the shadow can match them id for id.
//
// What is never deleted: a reminder not read; one 30 days old or less (created_at_tz, the instant the writer stamps); a
// reminder whose key the job still counts as its own (`keep`: every client's due keys and the keys of the period each
// item is in now, queries.ts reminderKeysInPlay), since the job sends a key again once no row holds it, read or not; a
// photo key of a sheet the calendar could still open again (`photosFrom`: a new start date or rhythm hands the open
// sheet back to the calendar, which picks one at most a sheet's length back); a row a write still queued points at (pg
// mode: its id or its key). A key of a period that is over is never asked again.

import { sql } from "drizzle-orm";
import type { NoteRow } from "../db";
import { stampInstantMs } from "../pg/stamps";
import type { Q, Row } from "./pg";
import type { NotesTable } from "./statements";

/** Days a read reminder is kept. */
export const PRUNE_DAYS = 30;
/** Rows looked at a statement (pg): the page read, then those of it to go deleted by id. */
export const PRUNE_PAGE = 2000;
/** Rows deleted a night at most: the first nights take 50,000 each until the backlog is gone, then about a day's worth. */
export const PRUNE_MAX = 50_000;
/** Memory mode: rows looked at between two breaths of the event loop, so a request waits a few ms at most. */
const SLICE = 20_000;
/** The index the page reads on (made by a NOTES_STORE=pg boot, notes/boot.ts): the read reminders, oldest first. */
export const PRUNE_INDEX = "coach_activity_read_reminder_idx";

export type PruneSpec = {
  /** The instant before which a reminder may go (ISO). */
  cutoff: string;
  /** `client\u0000key` pairs the job still counts as its own. */
  keep: ReadonlySet<string>;
  /** A photo key (`reminder:photos:<client>:<day>`) of this day or later stays: the calendar could open it again. */
  photosFrom: string;
  /** Rows a write still queued points at (pg mode). */
  skipIds: ReadonlySet<number>;
  skipKeys: ReadonlySet<string>;
  max: number;
};

/**
 * When the next night's clean-up is: 04:30 server time (TZ=Europe/Amsterdam on Railway), the quietest hour, after the
 * 03:15 backup (backup.ts msUntilNextRun) has taken the night's copy.
 */
export function msUntilPrune(now = new Date()): number {
  const next = new Date(now);
  next.setHours(4, 30, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

export const prunePair = (clientId: number, key: string) => `${clientId}\u0000${key}`;

/** A row whose `read` the writer marked absent (`extra.__absent`): read as not read, as readAll's statement does. */
const readAbsent = (r: NoteRow) => {
  const absent = (r as unknown as { extra?: { __absent?: unknown } }).extra?.__absent;
  return Array.isArray(absent) && absent.includes("read");
};

const PHOTO_KEY = /^reminder:photos:\d+:(\d{4}-\d{2}-\d{2})$/;

function keyKept(clientId: number, key: unknown, spec: PruneSpec): boolean {
  if (typeof key !== "string") return false;
  if (spec.keep.has(prunePair(clientId, key)) || spec.skipKeys.has(key)) return true;
  const photo = PHOTO_KEY.exec(key);
  return !!photo && photo[1] >= spec.photosFrom;
}

/** Memory mode's rule for one row: the statements' WHERE and the filter after it, in one. */
export function prunable(r: NoteRow, spec: PruneSpec, cutoffMs: number): boolean {
  if (!r || r.kind !== "reminder" || r.read !== true || readAbsent(r)) return false;
  const ms = stampInstantMs(r.created_at);
  if (ms == null || ms >= cutoffMs) return false;
  return !spec.skipIds.has(r.id) && !keyKept(r.client_id, r.dedupe_key, spec);
}

/** Memory mode: the ids to go, oldest first up to the cap (as the statements page), then by id. Looked at a slice at a
 *  time, the event loop let go between, over the list as it stood when it began. */
export async function prunableIds(rows: readonly NoteRow[], spec: PruneSpec): Promise<number[]> {
  const cutoffMs = Date.parse(spec.cutoff);
  const found: { id: number; ms: number }[] = [];
  for (let i = 0; i < rows.length; i += SLICE) {
    for (const r of rows.slice(i, i + SLICE)) if (prunable(r, spec, cutoffMs)) found.push({ id: r.id, ms: stampInstantMs(r.created_at)! });
    if (i + SLICE < rows.length) await new Promise((r) => setImmediate(r));
  }
  found.sort((a, b) => a.ms - b.ms || a.id - b.id);
  return found
    .slice(0, spec.max)
    .map((f) => f.id)
    .sort((a, b) => a - b);
}

/** The table's own reading of the rule (the read column as the writer leaves it; created_at_tz as the writer stamps). */
const OLD_READ = (cutoff: string) =>
  sql`kind = 'reminder' AND read IS TRUE AND NOT jsonb_exists(COALESCE(extra -> '__absent', '[]'::jsonb), 'read') AND created_at_tz < ${cutoff}::timestamptz`;

export const pruneSql = {
  /** A page of the old read reminders after a place (the instant, then id), oldest first, on PRUNE_INDEX where it is:
   *  what the keep list is asked of, in JS. The instant comes back as text, so the next page starts exactly after it. */
  page: (t: NotesTable, cutoff: string, after: { tz: string; id: number } | null, n: number) =>
    sql`SELECT id, client_id, dedupe_key, created_at_tz::text AS tz FROM ${sql.identifier(t)} WHERE ${OLD_READ(cutoff)} AND (created_at_tz, id) > (${after?.tz ?? "-infinity"}::timestamptz, ${after?.id ?? 0}::int) ORDER BY created_at_tz, id LIMIT ${n}::int`,
  /** Those of the page to go, by id, the rule asked again in the same transaction (a row read back to unread stays). */
  delete: (t: NotesTable, cutoff: string, ids: readonly number[]) =>
    sql`DELETE FROM ${sql.identifier(t)} WHERE id IN (SELECT (v)::int FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb) v) AND ${OLD_READ(cutoff)} RETURNING id`,
  /** The index the page reads on (a pg boot; IF NOT EXISTS, so only the first builds it). */
  index: () => sql.raw(`CREATE INDEX IF NOT EXISTS "${PRUNE_INDEX}" ON coach_activity (created_at_tz, id) WHERE kind = 'reminder' AND read IS TRUE`),
};

/**
 * The statements on a table: a page at a time (each its own transaction through `tx`, so no connection is held all
 * night and a reset can come between), the ids gone pushed into `gone` as each page commits (so a failure part way
 * still says what went), by id. `go()` false stops before the next page (a reset under way).
 */
export async function pruneOn(
  t: NotesTable,
  spec: PruneSpec,
  tx: (fn: (q: Q) => Promise<number[]>) => Promise<number[]>,
  go: () => boolean = () => true,
  gone: number[] = []
): Promise<number[]> {
  let after: { tz: string; id: number } | null = null;
  while (gone.length < spec.max && go()) {
    const at: { last: { tz: string; id: number } | null; seen: number } = { last: null, seen: 0 };
    const part = await tx(async (q) => {
      const page: Row[] = await q(pruneSql.page(t, spec.cutoff, after, PRUNE_PAGE));
      at.seen = page.length;
      if (!page.length) return [];
      const end = page[page.length - 1];
      at.last = { tz: String(end.tz), id: Number(end.id) };
      const ids = page
        .filter((r) => !spec.skipIds.has(Number(r.id)) && !keyKept(Number(r.client_id), r.dedupe_key, spec))
        .map((r) => Number(r.id))
        .slice(0, spec.max - gone.length);
      if (!ids.length) return [];
      return (await q(pruneSql.delete(t, spec.cutoff, ids))).map((r) => Number(r.id));
    });
    gone.push(...part);
    if (at.seen < PRUNE_PAGE || !at.last) break;
    after = at.last;
    // Between pages, the event loop free for the requests waiting.
    await new Promise((r) => setImmediate(r));
  }
  return [...gone].sort((a, b) => a - b);
}
