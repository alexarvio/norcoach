// The check-in figures' boot work (quest 9), on the food diary's pattern (food/boot.ts, untouched): what a
// CHECKINS_STORE=pg boot does to the two tables before any request, and what a memory boot of this build does after one.
//
//   pg boot (under the lease, after prepareStore, before the boot's save; each step its own transaction):
//     1. tombstones: the figures of a metric a removal took out of memory, whose DELETE never committed, deleted;
//     2. the merge of twin metrics (db.ts mergeDuplicateMetricDefinitions, its body unchanged) on their figures read from
//        Postgres: figures moved onto the keeper, the twin's others kept aside in checkin_twins, the twin definitions
//        then taken out of memory (the boot's save writes that); after prepareStore's rename, as memory mode merges;
//     3. impossible step counts (over 200,000) kept aside in checkin_twins and out of the table, as memory drops them;
//     4. figures whose metric is gone (orphans) counted and said, never moved: they were invisible before, and a
//        definition loadStore skipped as unreadable must never lose its live readings; then (21 Nov) the derived columns
//        (each figure's client, the instants) put right in the tables, as a memory boot's derivedStale would;
//     5. where a unique rule is missing (a memory boot dropped it, or the first pg boot): twins kept aside, the rule made
//        (a figure: one per metric and period, the client's own before the phone's, then the lowest id; a note: one per
//        client, kind and period, the lowest id);
//     6. kv's `checkins_pg` mark, set by the boot's own save.
//   memory boot: the two unique rules dropped every time (a twin a memory-mode save might make must never fail it; a pg
//   boot that made them and died before its save left no mark), the mark taken out; a tombstone left (any boot)
//   finished in memory. The lease is waited for when kv holds the mark or a rule is there (pg/runtime.ts).

import { sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { isStepsMetric, MAX_DAY_STEPS, mergeDuplicateMetricDefinitions, type CheckInEntry, type Data } from "../db";
import { fromRecord, insertRowsOnce, repairDerivedPg } from "../pg/store";
import { metric_entries } from "../pg/schema";
import { CHECKINS_PG_MARK, CHECKINS_REMOVING, CHECKINS_TABLES } from "./mode";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyDb = PgDatabase<any, any, any>;
type Row = Record<string, unknown>;
const rowsOf = (r: unknown): Row[] => ((r as { rows?: Row[] })?.rows ?? []) as Row[];
const log = (m: string) => console.log(`[checkins] ${m}`);
const ints = (ids: Iterable<number>) => `{${[...ids].filter((n) => Number.isInteger(n)).join(",")}}`;

/** The unique rules a pg boot makes (and a memory boot drops). */
export const CHECKINS_ENTRY_UNIQUE = "metric_entries_def_period_uq";
export const CHECKINS_NOTE_UNIQUE = "check_in_notes_client_kind_period_uq";
const RULES: { name: string; table: string; on: string; partition: string; notNull: string; order: string }[] = [
  {
    name: CHECKINS_ENTRY_UNIQUE,
    table: "metric_entries",
    on: `("metric_definition_id", "period" COLLATE "C")`,
    partition: `metric_definition_id, period COLLATE "C"`,
    notNull: `metric_definition_id IS NOT NULL AND period IS NOT NULL`,
    order: `(COALESCE(extra->>'source', '') = 'health'), id`,
  },
  {
    name: CHECKINS_NOTE_UNIQUE,
    table: "check_in_notes",
    on: `("client_id", "kind", "period" COLLATE "C")`,
    partition: `client_id, kind, period COLLATE "C"`,
    notNull: `client_id IS NOT NULL AND kind IS NOT NULL AND period IS NOT NULL`,
    order: "id",
  },
];

const NEEDED_INDEXES = [
  "metric_entries_def_period_idx",
  "metric_entries_logged_idx",
  "metric_entries_odd_period_idx",
  "check_in_notes_client_idx",
  // Migration 0024 (21 Nov): the coach-wide slices (checkins/slices.ts).
  "metric_entries_client_tz_idx",
  "metric_entries_client_period_idx",
  "metric_entries_client_odd_idx",
  "metric_entries_client_blank_idx",
  "check_in_notes_client_tz_idx",
  "check_in_notes_client_period_idx",
  "check_in_notes_odd_idx",
];

/** What CHECKINS_STORE=pg leans on and is missing: migration 0023's objects (and, with `unique`, the pg boot's rules). */
export async function checkInsProblems(db: AnyDb, opts: { unique: boolean }): Promise<string[]> {
  const out: string[] = [];
  for (const t of [...CHECKINS_TABLES, "checkin_twins"]) {
    if (rowsOf(await db.execute(sql`SELECT to_regclass(${t}) IS NOT NULL AS ok`))[0]?.ok !== true) out.push(`the table ${t} is missing`);
  }
  const have = new Set(rowsOf(await db.execute(sql`SELECT c.relname AS name FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE i.indisvalid`)).map((r) => String(r.name)));
  for (const i of [...NEEDED_INDEXES, ...(opts.unique ? RULES.map((r) => r.name) : [])]) if (!have.has(i)) out.push(`the index ${i} is missing or not valid`);
  for (const s of ["check_in_notes_id_seq", "metric_definitions_id_seq", "metric_entries_id_seq"]) {
    if (rowsOf(await db.execute(sql`SELECT to_regclass(${s}) IS NOT NULL AS ok`))[0]?.ok !== true) out.push(`the sequence ${s} is missing`);
  }
  return out;
}

/**
 * A pg instance was here before this memory boot: kv holds the mark a pg boot left, or either unique rule is there (a pg
 * boot that made the rules and died before its save wrote the mark). This boot then waits for the lease.
 */
export async function kvHoldsCheckInsMark(db: AnyDb): Promise<boolean> {
  if (rowsOf(await db.execute(sql`SELECT 1 FROM kv WHERE key = ${CHECKINS_PG_MARK}`)).length > 0) return true;
  const names = `{${RULES.map((r) => r.name).join(",")}}`;
  return rowsOf(await db.execute(sql`SELECT 1 FROM pg_class WHERE relname = ANY(${names}::text[]) AND relkind = 'i'`)).length > 0;
}

type Def = Data["metric_definitions"][number];
const say = (alert: string, message: string) => {
  console.error(`[checkins] !!! ${message}`);
  import("@sentry/nextjs")
    .then((S) => S.captureMessage(message, { level: "warning", tags: { alert } }))
    .catch(() => {});
};

/** The tombstones a removal left (a store key, kept in kv). */
function tombstonesOf(data: Partial<Data>): Record<string, { client?: number; at?: string }> {
  // chat-door: notes-door: food-door: one kv key by its own name (the tombstones), never a walk of the store.
  const t = (data as unknown as Record<string, unknown>)[CHECKINS_REMOVING];
  return t && typeof t === "object" && !Array.isArray(t) ? (t as Record<string, { client?: number; at?: string }>) : {};
}

/**
 * The pg boot's work (above), under the lease, on the prepared store. True when the store changed (definitions merged
 * away, a tombstone cleared, the mark set): the boot's save writes it.
 */
export async function checkInsBootPg(db: AnyDb, data: Data): Promise<boolean> {
  let changed = false;
  // chat-door: notes-door: food-door: two kv keys by their own names (the tombstones, the mark), never a walk of the store.
  const d = data as unknown as Record<string, unknown>;
  // 1. Tombstones.
  const tomb = tombstonesOf(data);
  const tombIds = Object.keys(tomb);
  if (tombIds.length) {
    const live = new Set(data.metric_definitions.map((m) => m.id));
    let deleted = 0;
    for (const key of tombIds) {
      const id = Number(key);
      if (Number.isInteger(id) && !live.has(id)) deleted += rowsOf(await db.execute(sql`DELETE FROM metric_entries WHERE metric_definition_id = ${id}::int RETURNING id`)).length;
    }
    delete d[CHECKINS_REMOVING];
    changed = true;
    log(`pg: ${tombIds.length} removal(s) finished, ${deleted} figure(s) deleted`);
  }
  // 2. The merge of twin metrics, on the prepared store (after its rename), on their figures in Postgres.
  const groups = new Map<string, Def[]>();
  for (const m of data.metric_definitions) {
    const key = `${m.client_id}:${m.phase_id ?? "standing"}:${m.frequency}:${m.name.trim().toLowerCase()}:${m.retired_at ? "retired" : "live"}`;
    const list = groups.get(key) ?? [];
    list.push(m);
    groups.set(key, list);
  }
  const gone = new Set<number>();
  let repointed = 0;
  let aside = 0;
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const ids = list.map((m) => m.id);
    const rows = rowsOf(await db.execute(sql`SELECT * FROM metric_entries WHERE metric_definition_id = ANY(${ints(ids)}::int[]) ORDER BY id`)).map((r) => fromRecord(metric_entries, r) as unknown as CheckInEntry);
    const was = new Map(rows.map((r) => [r.id, r.metric_definition_id] as const));
    const defs = { metric_definitions: [...list] };
    const box = { entries: rows };
    mergeDuplicateMetricDefinitions(defs, box);
    const kept = new Set(defs.metric_definitions.map((m) => m.id));
    const stay = new Set(box.entries.map((r) => r.id));
    const moves = box.entries.filter((r) => was.get(r.id) !== r.metric_definition_id);
    const out = rows.filter((r) => !stay.has(r.id)).map((r) => r.id);
    await db.transaction(async (tx) => {
      const q = (s: ReturnType<typeof sql>) => (tx as unknown as AnyDb).execute(s);
      for (const r of moves) await q(sql`UPDATE metric_entries SET metric_definition_id = ${r.metric_definition_id}::int WHERE id = ${r.id}::int`);
      if (out.length) {
        await q(sql`INSERT INTO checkin_twins (tbl, id, row, reason) SELECT 'metric_entries', e.id, to_jsonb(e), 'merge' FROM metric_entries e WHERE e.id = ANY(${ints(out)}::int[])
          ON CONFLICT (tbl, id) DO UPDATE SET row = EXCLUDED.row, reason = EXCLUDED.reason, moved_at = now()`);
        await q(sql`DELETE FROM metric_entries WHERE id = ANY(${ints(out)}::int[])`);
      }
    });
    repointed += moves.length;
    aside += out.length;
    for (const m of list) if (!kept.has(m.id)) gone.add(m.id);
  }
  if (gone.size) {
    data.metric_definitions = data.metric_definitions.filter((m) => !gone.has(m.id));
    changed = true;
    log(`pg: ${gone.size} twin metric(s) merged, ${repointed} figure(s) moved onto the keeper, ${aside} kept aside in checkin_twins`);
  }
  // 3. Impossible step counts, as memory drops them (db.ts dropImpossibleSteps), kept aside.
  const steps = data.metric_definitions.filter((m) => isStepsMetric(m.name)).map((m) => m.id);
  if (steps.length) {
    const n = await db.transaction(async (tx) => {
      const q = (s: ReturnType<typeof sql>) => (tx as unknown as AnyDb).execute(s);
      const where = sql`metric_definition_id = ANY(${ints(steps)}::int[]) AND value IS NOT NULL AND value > ${MAX_DAY_STEPS}`;
      await q(sql`INSERT INTO checkin_twins (tbl, id, row, reason) SELECT 'metric_entries', e.id, to_jsonb(e), 'steps' FROM metric_entries e WHERE ${where}
        ON CONFLICT (tbl, id) DO UPDATE SET row = EXCLUDED.row, reason = EXCLUDED.reason, moved_at = now()`);
      return rowsOf(await q(sql`DELETE FROM metric_entries WHERE ${where} RETURNING id`)).length;
    });
    if (n) log(`pg: ${n} impossible step count(s) kept aside in checkin_twins`);
  }
  // 4. Orphans, counted.
  const all = data.metric_definitions.map((m) => m.id);
  const orphans = Number(rowsOf(await db.execute(sql`SELECT count(*)::int AS n FROM metric_entries WHERE metric_definition_id IS NULL OR NOT (metric_definition_id = ANY(${ints(all)}::int[]))`))[0]?.n ?? 0);
  const clients = data.clients.map((c) => c.id);
  const lostNotes = Number(rowsOf(await db.execute(sql`SELECT count(*)::int AS n FROM check_in_notes WHERE client_id IS NULL OR NOT (client_id = ANY(${ints(clients)}::int[]))`))[0]?.n ?? 0);
  if (orphans || lostNotes) say("checkins-orphans", `Check-in rows of no metric or client: ${orphans} figure(s), ${lostNotes} note(s) (kept, invisible as before; look at them)`);
  // 4b. The derived columns the coach-wide slices lean on (21 Nov, migration 0024): each figure's client and real instant,
  // each note's instant, put right in the tables from memory's definitions, as a memory boot's derivedStale would (a
  // figure an older build wrote with no def_client_id would be in no slice; pg/store.ts repairDerivedPg).
  const fixedFigures = await repairDerivedPg(db, "metric_entries", data.metric_definitions);
  const fixedNotes = await repairDerivedPg(db, "check_in_notes");
  log(`pg: derived columns written again on ${fixedFigures} figure(s) and ${fixedNotes} note(s)`);
  // 5. The unique rules, where missing.
  for (const r of RULES) {
    const there = rowsOf(await db.execute(sql`SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = ${r.name} AND i.indisvalid`)).length > 0;
    if (there) continue;
    let twins = 0;
    await db.transaction(async (tx) => {
      const q = (s: ReturnType<typeof sql>) => (tx as unknown as AnyDb).execute(s);
      await q(sql.raw(`LOCK TABLE "${r.table}" IN SHARE ROW EXCLUSIVE MODE`));
      await q(sql.raw(`DROP INDEX IF EXISTS "${r.name}"`));
      const moved = rowsOf(
        await q(
          // Only keys the rule compares: a NULL in any of its columns is never a twin (a unique index lets NULLs repeat).
          sql.raw(`WITH ranked AS (
            SELECT id, row_number() OVER (PARTITION BY ${r.partition} ORDER BY ${r.order}) AS n FROM "${r.table}" WHERE ${r.notNull}
          ), gone AS (
            INSERT INTO checkin_twins (tbl, id, row, reason) SELECT '${r.table}', t.id, to_jsonb(t), 'twin' FROM "${r.table}" t JOIN ranked k ON k.id = t.id WHERE k.n > 1
            ON CONFLICT (tbl, id) DO UPDATE SET row = EXCLUDED.row, reason = EXCLUDED.reason, moved_at = now() RETURNING id
          )
          DELETE FROM "${r.table}" WHERE id IN (SELECT id FROM ranked WHERE n > 1) RETURNING id`)
        )
      );
      twins = moved.length;
      await q(sql.raw(`CREATE UNIQUE INDEX "${r.name}" ON "${r.table}" ${r.on}`));
    });
    if (twins) say("checkins-twins", `Check-in twins moved to checkin_twins: ${twins} of ${r.table}`);
    log(`pg: unique rule made on ${r.table}${twins ? `, ${twins} twins moved` : ""}`);
  }
  // 6. The mark.
  if (!d[CHECKINS_PG_MARK]) {
    d[CHECKINS_PG_MARK] = { at: new Date().toISOString(), v: 1 };
    changed = true;
  }
  return changed;
}

/**
 * A memory boot of this build: a tombstone left finished in memory (its figures out of what loaded), and after a pg
 * boot (kv's mark) the unique rules dropped and the mark taken out by the boot's save. True when the store changed.
 */
export async function checkInsBootMemory(db: AnyDb, raw: Partial<Data>, opts: { marked: boolean }): Promise<boolean> {
  let changed = false;
  const d = raw as unknown as Record<string, unknown>;
  const tomb = tombstonesOf(raw);
  if (CHECKINS_REMOVING in d) {
    const live = new Set((raw.metric_definitions ?? []).map((m) => m.id));
    const dead = new Set(Object.keys(tomb).map(Number).filter((id) => Number.isInteger(id) && !live.has(id)));
    const list = d.metric_entries;
    if (Array.isArray(list) && dead.size) d.metric_entries = list.filter((e) => !dead.has((e as { metric_definition_id?: number }).metric_definition_id as number));
    delete d[CHECKINS_REMOVING];
    changed = true;
    log(`memory: ${Object.keys(tomb).length} removal(s) a pg instance left finished`);
  }
  // The rules dropped on every memory boot, mark or not (as food/boot.ts foodBootMemory): a pg boot commits them before
  // its save writes the mark, so a boot that died between leaves them with no mark, and a twin a memory save makes would
  // then fail every save of every table. With none there, DROP INDEX IF EXISTS does nothing.
  for (const r of RULES) {
    try {
      await db.execute(sql.raw(`DROP INDEX IF EXISTS "${r.name}"`));
    } catch (error) {
      const still = await db
        .execute(sql`SELECT 1 FROM pg_class WHERE relname = ${r.name} AND relkind = 'i'`)
        .then((x) => rowsOf(x).length > 0)
        .catch(() => true);
      if (still) throw new Error(`[checkins] Refusing to start in memory mode: the unique rule ${r.name} could not be dropped (${error instanceof Error ? error.message.split("\n")[0] : String(error)}); drop it by hand (docs/database-plan.md, the check-in item's rollback) and deploy again`);
      console.error(`[checkins] the unique rule ${r.name}'s drop failed, and it isn't there:`, error instanceof Error ? error.message.split("\n")[0] : error);
    }
  }
  if (!opts.marked) return changed;
  if (CHECKINS_PG_MARK in d) {
    delete d[CHECKINS_PG_MARK];
    changed = true;
  }
  log("memory: the check-in figures are in memory again (the unique rules dropped, the mark a pg boot left taken out)");
  return changed;
}

/** The JSON import's figures and notes (CHECKINS_STORE=pg on an empty database), into the tables, then out of what loads. */
export async function importCheckIns(db: AnyDb, raw: Partial<Data>) {
  const r = raw as Record<string, unknown>;
  if (r._checkins_in_postgres) {
    if (process.env.ALLOW_JSON_WITHOUT_CHECKINS !== "1") {
      throw new Error(
        "[store] Refusing to start: the JSON to import was written with CHECKINS_STORE=pg and holds no check-in figures (they are in Postgres). Restore the database instead (scripts/restore-pg-backup.mjs), or set ALLOW_JSON_WITHOUT_CHECKINS=1 to start without them."
      );
    }
    delete r._checkins_in_postgres;
  }
  for (const t of CHECKINS_TABLES) {
    const list = r[t];
    delete r[t];
    if (!Array.isArray(list) || !list.length) continue;
    const n = await insertRowsOnce(db, t, list);
    log(`${t}: ${n} rows of the JSON imported into the table (CHECKINS_STORE=pg)`);
  }
}

/** A memory boot's import of a JSON a pg instance wrote (its figures in Postgres): refused unless asked. */
export function checkCheckInsJson(raw: Partial<Data>) {
  const r = raw as Record<string, unknown>;
  if (!r._checkins_in_postgres) return;
  if (process.env.ALLOW_JSON_WITHOUT_CHECKINS !== "1") {
    throw new Error(
      "[store] Refusing to start: the JSON to import was written with CHECKINS_STORE=pg and holds no check-in figures (they are in Postgres). Restore the database instead (scripts/restore-pg-backup.mjs), or set ALLOW_JSON_WITHOUT_CHECKINS=1 to start without them."
    );
  }
  delete r._checkins_in_postgres;
}

/** Each table's highest id (CHECKINS_STORE=pg: memory no longer holds the rows raiseCounters reads). */
export async function checkInsMaxIds(db: AnyDb): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of CHECKINS_TABLES) out[t] = Number(rowsOf(await db.execute(sql.raw(`SELECT COALESCE(MAX(id), 0)::bigint AS m FROM "${t}"`)))[0]?.m ?? 0);
  return out;
}
