// The logged sets' boot work (quest 10), on the check-ins' pattern (checkins/boot.ts, untouched): what a SETS_STORE=pg
// boot does to the table before any request, and what a memory boot of this build does after one.
//
//   pg boot (under the lease, after prepareStore, before the boot's save; each step its own transaction):
//     1. tombstones: the sets of plan rows a coach's removal took out of memory, whose DELETE never committed, deleted;
//        and the home-gym pins whose UPDATE never committed, written;
//     2. where the unique rule is missing (a memory boot dropped it, or the first pg boot): twins kept aside in
//        set_twins (reason `twin`), the rule made: one set per row and set number, the one memory's boot twin drop keeps
//        (db.ts newerSetTwin: the newer stamp read as text, then the higher id), so both modes keep the same row;
//     3. sets of no row memory holds (orphans) counted and said, never moved; the client column put right from memory's
//        rows and days (pg/store.ts repairDerivedPg);
//     4. kv's `sets_pg` mark, set by the boot's own save.
//   memory boot: the unique rule dropped every time, the mark taken out, a tombstone or pin left finished in memory. The
//   lease is waited for when kv holds the mark or the rule is there (pg/runtime.ts).

import { sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { newerSetTwin, type Data, type SetLogRow } from "../db";
import { fromRecord, insertRowsOnce, repairDerivedPg, setClientMapOf } from "../pg/store";
import { set_logs } from "../pg/schema";
import { SETS_PG_MARK, SETS_REMOVING, SETS_TABLES } from "./mode";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyDb = PgDatabase<any, any, any>;
type Row = Record<string, unknown>;
const rowsOf = (r: unknown): Row[] => ((r as { rows?: Row[] })?.rows ?? []) as Row[];
const log = (m: string) => console.log(`[sets] ${m}`);
const ints = (ids: Iterable<number>) => `{${[...ids].filter((n) => Number.isInteger(n)).join(",")}}`;
const GYM_PINS = "sets_gym_pins";

/** The unique rule a pg boot makes (and a memory boot drops). */
export const SETS_UNIQUE = "set_logs_assignment_set_uq";
const NEEDED_INDEXES = ["set_logs_assignment_idx", "set_logs_client_idx", "set_logs_client_row_idx", "set_logs_client_tz_idx", "set_logs_odd_idx"];

/** What SETS_STORE=pg leans on and is missing: migration 0025's objects (and, with `unique`, the pg boot's rule). */
export async function setsProblems(db: AnyDb, opts: { unique: boolean }): Promise<string[]> {
  const out: string[] = [];
  for (const t of [...SETS_TABLES, "set_twins"]) if (rowsOf(await db.execute(sql`SELECT to_regclass(${t}) IS NOT NULL AS ok`))[0]?.ok !== true) out.push(`the table ${t} is missing`);
  const col = rowsOf(await db.execute(sql`SELECT 1 FROM information_schema.columns WHERE table_name = 'set_logs' AND column_name = 'client_id'`));
  if (!col.length) out.push("the column set_logs.client_id is missing");
  const have = new Set(rowsOf(await db.execute(sql`SELECT c.relname AS name FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE i.indisvalid`)).map((r) => String(r.name)));
  for (const i of [...NEEDED_INDEXES, ...(opts.unique ? [SETS_UNIQUE] : [])]) if (!have.has(i)) out.push(`the index ${i} is missing or not valid`);
  if (rowsOf(await db.execute(sql`SELECT to_regclass('set_logs_id_seq') IS NOT NULL AS ok`))[0]?.ok !== true) out.push("the sequence set_logs_id_seq is missing");
  return out;
}

/** A pg instance was here before this memory boot: kv holds its mark, or the unique rule is there. This boot then waits for the lease. */
export async function kvHoldsSetsMark(db: AnyDb): Promise<boolean> {
  if (rowsOf(await db.execute(sql`SELECT 1 FROM kv WHERE key = ${SETS_PG_MARK}`)).length > 0) return true;
  return rowsOf(await db.execute(sql`SELECT 1 FROM pg_class WHERE relname = ${SETS_UNIQUE} AND relkind = 'i'`)).length > 0;
}

const say = (alert: string, message: string) => {
  console.error(`[sets] !!! ${message}`);
  import("@sentry/nextjs")
    .then((S) => S.captureMessage(message, { level: "warning", tags: { alert } }))
    .catch(() => {});
};

type Tomb = Record<string, { client?: number; rows?: number[] }>;
type Pins = Record<string, { client?: number; rows?: number[]; gym?: number; upTo?: number }>;
// chat-door: notes-door: food-door: checkins-door: kv keys by their own names (the tombstones, the pins, the mark), never a walk.
const keyOf = <T>(data: Partial<Data>, key: string): T => {
  const t = (data as unknown as Record<string, unknown>)[key];
  return (t && typeof t === "object" && !Array.isArray(t) ? t : {}) as T;
};

/**
 * The twin pass's keeper of each (row, set number) group, chosen exactly as prepareStore's memory twin drop chooses
 * (newerSetTwin over the rows in id order): the ids to keep aside. A NULL key is grouped as the template string groups it
 * (`null:3`), so pg keeps what memory would.
 */
export function setTwinsToMove(rows: readonly SetLogRow[]): number[] {
  const best = new Map<string, SetLogRow>();
  for (const sl of rows) {
    const key = `${sl.workout_assignment_id}:${sl.set_number}`;
    const cur = best.get(key);
    if (!cur || newerSetTwin(sl, cur)) best.set(key, sl);
  }
  const keep = new Set([...best.values()].map((s) => s.id));
  return rows.filter((s) => !keep.has(s.id)).map((s) => s.id);
}

/** The pg boot's work (above), under the lease, on the prepared store. True when the store changed (the boot's save writes it). */
export async function setsBootPg(db: AnyDb, data: Data): Promise<boolean> {
  let changed = false;
  // chat-door: notes-door: food-door: checkins-door: two kv keys by their own names (the tombstones, the mark), never a walk.
  const d = data as unknown as Record<string, unknown>;
  // 1. Tombstones and pins.
  const tomb = keyOf<Tomb>(data, SETS_REMOVING);
  if (Object.keys(tomb).length) {
    const live = new Set(data.workout_assignments.map((w) => w.id));
    let deleted = 0;
    for (const t of Object.values(tomb)) {
      const rows = (t.rows ?? []).filter((r) => Number.isInteger(r) && !live.has(r));
      if (rows.length) deleted += rowsOf(await db.execute(sql`DELETE FROM set_logs WHERE workout_assignment_id = ANY(${ints(rows)}::int[]) RETURNING id`)).length;
    }
    delete d[SETS_REMOVING];
    changed = true;
    log(`pg: ${Object.keys(tomb).length} removal(s) finished, ${deleted} set(s) deleted`);
  }
  const pins = keyOf<Pins>(data, GYM_PINS);
  if (Object.keys(pins).length) {
    for (const p of Object.values(pins)) {
      if (!p.rows?.length || !Number.isInteger(p.gym) || !Number.isInteger(p.upTo)) continue;
      await db.execute(
        sql`UPDATE set_logs SET extra = jsonb_set(COALESCE(extra, '{}'::jsonb), '{gym_id}', to_jsonb(${p.gym}::int)) WHERE workout_assignment_id = ANY(${ints(p.rows)}::int[]) AND id <= ${p.upTo}::int AND (extra->'gym_id' IS NULL OR jsonb_typeof(extra->'gym_id') = 'null')`
      );
    }
    delete d[GYM_PINS];
    changed = true;
    log(`pg: ${Object.keys(pins).length} home-gym pin(s) finished`);
  }
  // 2. The unique rule, where missing: twins kept aside as memory's boot drop chooses them.
  const there = rowsOf(await db.execute(sql`SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = ${SETS_UNIQUE} AND i.indisvalid`)).length > 0;
  if (!there) {
    let twins = 0;
    await db.transaction(async (tx) => {
      const q = (s: ReturnType<typeof sql>) => (tx as unknown as AnyDb).execute(s);
      await q(sql.raw(`LOCK TABLE "set_logs" IN SHARE ROW EXCLUSIVE MODE`));
      await q(sql.raw(`DROP INDEX IF EXISTS "${SETS_UNIQUE}"`));
      // The groups with more than one set (NULLs grouped together, as memory's key string does), read whole, by id.
      const groups = rowsOf(await q(sql`SELECT s.* FROM set_logs s JOIN (SELECT workout_assignment_id AS w, set_number AS n FROM set_logs GROUP BY 1, 2 HAVING count(*) > 1) g ON g.w IS NOT DISTINCT FROM s.workout_assignment_id AND g.n IS NOT DISTINCT FROM s.set_number ORDER BY s.id`));
      const move = setTwinsToMove(groups.map((r) => fromRecord(set_logs, r) as unknown as SetLogRow));
      if (move.length) {
        await q(sql`INSERT INTO set_twins (tbl, id, row, reason) SELECT 'set_logs', s.id, to_jsonb(s), 'twin' FROM set_logs s WHERE s.id = ANY(${ints(move)}::int[])
          ON CONFLICT (tbl, id) DO UPDATE SET row = EXCLUDED.row, reason = EXCLUDED.reason, moved_at = now()`);
        await q(sql`DELETE FROM set_logs WHERE id = ANY(${ints(move)}::int[])`);
      }
      twins = move.length;
      // A unique index lets NULLs repeat: a NULL-key twin memory would drop is moved above, the rest are not twins to it.
      await q(sql.raw(`CREATE UNIQUE INDEX "${SETS_UNIQUE}" ON "set_logs" ("workout_assignment_id", "set_number")`));
    });
    if (twins) say("sets-twins", `Set twins moved to set_twins: ${twins}`);
    log(`pg: unique rule made on set_logs${twins ? `, ${twins} twins moved` : ""}`);
  }
  // 3. Orphans counted; the client column put right.
  const rows = data.workout_assignments.map((w) => w.id);
  const orphans = Number(rowsOf(await db.execute(sql`SELECT count(*)::int AS n FROM set_logs WHERE workout_assignment_id IS NULL OR NOT (workout_assignment_id = ANY(${ints(rows)}::int[]))`))[0]?.n ?? 0);
  if (orphans) say("sets-orphans", `Sets of no row memory holds: ${orphans} (kept, invisible as before; look at them)`);
  const map = setClientMapOf(data.workout_assignments, data.program_days);
  const fixed = await repairDerivedPg(db, "set_logs", [...map].map(([id, client_id]) => ({ id, client_id })));
  const top = Number(rowsOf(await db.execute(sql`SELECT COALESCE(MAX(id), 0)::bigint AS m, count(*)::int AS n FROM set_logs`))[0]?.m ?? 0);
  log(`pg: max id ${top}, orphans ${orphans}, client ids written again ${fixed}`);
  // 4. The mark.
  if (!d[SETS_PG_MARK]) {
    d[SETS_PG_MARK] = { at: new Date().toISOString(), v: 1 };
    changed = true;
  }
  return changed;
}

/**
 * A memory boot of this build: a tombstone or pin left finished on what loaded, the unique rule dropped every time, and
 * after a pg boot the mark taken out by the boot's save. True when the store changed.
 */
export async function setsBootMemory(db: AnyDb, raw: Partial<Data>, opts: { marked: boolean }): Promise<boolean> {
  let changed = false;
  const d = raw as unknown as Record<string, unknown>;
  const list = d.set_logs;
  if (SETS_REMOVING in d) {
    const live = new Set((raw.workout_assignments ?? []).map((w) => w.id));
    const dead = new Set(Object.values(keyOf<Tomb>(raw, SETS_REMOVING)).flatMap((t) => (t.rows ?? []).filter((r) => !live.has(r))));
    if (Array.isArray(list) && dead.size) d.set_logs = list.filter((s) => !dead.has((s as { workout_assignment_id?: number }).workout_assignment_id as number));
    delete d[SETS_REMOVING];
    changed = true;
    log("memory: a removal a pg instance left finished");
  }
  if (GYM_PINS in d) {
    const cur = d.set_logs;
    for (const p of Object.values(keyOf<Pins>(raw, GYM_PINS))) {
      const rows = new Set(p.rows ?? []);
      if (Array.isArray(cur)) for (const s of cur as SetLogRow[]) if (rows.has(s.workout_assignment_id) && s.gym_id == null && s.id <= (p.upTo ?? 0)) s.gym_id = p.gym ?? null;
    }
    delete d[GYM_PINS];
    changed = true;
    log("memory: a home-gym pin a pg instance left finished");
  }
  try {
    await db.execute(sql.raw(`DROP INDEX IF EXISTS "${SETS_UNIQUE}"`));
  } catch (error) {
    const still = await db
      .execute(sql`SELECT 1 FROM pg_class WHERE relname = ${SETS_UNIQUE} AND relkind = 'i'`)
      .then((x) => rowsOf(x).length > 0)
      .catch(() => true);
    if (still) throw new Error(`[sets] Refusing to start in memory mode: the unique rule ${SETS_UNIQUE} could not be dropped (${error instanceof Error ? error.message.split("\n")[0] : String(error)}); drop it by hand (docs/database-plan.md, the sets item's rollback) and deploy again`);
  }
  if (!opts.marked) return changed;
  if (SETS_PG_MARK in d) {
    delete d[SETS_PG_MARK];
    changed = true;
  }
  log("memory: the logged sets are in memory again (the unique rule dropped, the mark a pg boot left taken out)");
  return changed;
}

/** The JSON import's sets (SETS_STORE=pg on an empty database), into the table, then out of what loads. */
export async function importSets(db: AnyDb, raw: Partial<Data>) {
  const r = raw as Record<string, unknown>;
  if (r._sets_in_postgres) {
    if (process.env.ALLOW_JSON_WITHOUT_SETS !== "1") throw new Error("[store] Refusing to start: the JSON to import was written with SETS_STORE=pg and holds no logged sets (they are in Postgres). Restore the database instead (scripts/restore-pg-backup.mjs), or set ALLOW_JSON_WITHOUT_SETS=1 to start without them.");
    delete r._sets_in_postgres;
  }
  const list = r.set_logs;
  delete r.set_logs;
  if (!Array.isArray(list) || !list.length) return;
  const n = await insertRowsOnce(db, "set_logs", list);
  log(`set_logs: ${n} rows of the JSON imported into the table (SETS_STORE=pg)`);
}

/** A memory boot's import of a JSON a pg instance wrote (its sets in Postgres): refused unless asked. */
export function checkSetsJson(raw: Partial<Data>) {
  const r = raw as Record<string, unknown>;
  if (!r._sets_in_postgres) return;
  if (process.env.ALLOW_JSON_WITHOUT_SETS !== "1") throw new Error("[store] Refusing to start: the JSON to import was written with SETS_STORE=pg and holds no logged sets (they are in Postgres). Restore the database instead (scripts/restore-pg-backup.mjs), or set ALLOW_JSON_WITHOUT_SETS=1 to start without them.");
  delete r._sets_in_postgres;
}

/** The table's highest id (SETS_STORE=pg: memory no longer holds the rows raiseCounters reads). */
export async function setsMaxId(db: AnyDb): Promise<number> {
  return Number(rowsOf(await db.execute(sql.raw(`SELECT COALESCE(MAX(id), 0)::bigint AS m FROM "set_logs"`)))[0]?.m ?? 0);
}
