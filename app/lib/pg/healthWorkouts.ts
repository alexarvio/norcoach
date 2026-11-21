import { eq, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { health_workouts, kv } from "./schema";
import { cleanJson, cleanText, insertRowsOnce, toRecord } from "./store";

// The phone's workouts (lib/healthSync.ts) in a table of their own since 19 Nov (Step 6 of docs/database-plan.md),
// still in memory: the store's writer upserts and deletes them row by row, keyed (client_id, store, platform_id) as the
// sync matches them, so a workout dropped and added again in one save is one upsert.
//
// For a rollback to the builds before it (d100513), which read the list as one value in kv, the list is also written
// whole to kv under "health_workouts" in the same save (ROLLBACK_KV_COPIES), so kv's copy is the latest whichever build
// saved last. So at every boot, before the store loads, the table is made exactly that copy (as pg/onceKeys.ts does),
// and memory takes the copy itself, in its own order: the coach's Activity sorts the workouts stably, so where two tie
// the order decides which shows, and it is then exactly the order the build before saw. Drop the copy and this move
// (Build B: its migration deletes the kv row) once no rollback past this build is wanted.

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyDb = PgDatabase<any, any, any>;
type Row = Record<string, unknown>;

export type HealthMove = {
  /** The rows the table holds, in the copy's order: memory takes these. */
  kept: unknown[];
  /** How many rows kv's copy held. */
  kvRows: number;
  /** Rows left out for a key already kept (the first kept, as the sync's rows.find takes the first). */
  twins: number;
  /** Rows left out for having no usable key, or not being an object. */
  unusable: number;
  /** Rows kept whose store or platform_id was cleaned (cleanText). */
  cleaned: number;
  /** kv's value was not a list: the table was left as it is. */
  broken: boolean;
  /** The kept rows' ids rise all the way down (the table's own load order would give the same list). */
  orderById: boolean;
};

const isRow = (value: unknown): value is Row => !!value && typeof value === "object" && !Array.isArray(value);

/**
 * A list as the table can hold it, in its order: each row's key fields cleaned as Postgres will hold them (cleanText;
 * a real phone's ids never change), the first row a key kept, rows with no usable key (toRecord: a client_id, store
 * or platform_id missing or not fitting its column) or that can't be written as JSON left out, and non-objects too.
 */
export function healthWorkoutsKept(list: unknown[]): Omit<HealthMove, "kvRows" | "broken"> {
  const kept: unknown[] = [];
  const seen = new Set<string>();
  let twins = 0;
  let unusable = 0;
  let cleaned = 0;
  let orderById = true;
  let lastId = -Infinity;
  for (const el of list) {
    if (!isRow(el)) {
      unusable++;
      continue;
    }
    const record = toRecord(health_workouts, el);
    if (record.client_id == null || record.store == null || record.platform_id == null || cleanJson(record) == null) {
      unusable++;
      continue;
    }
    const store = cleanText(record.store as string);
    const platformId = cleanText(record.platform_id as string);
    const key = JSON.stringify([record.client_id, store, platformId]);
    if (seen.has(key)) {
      twins++;
      continue;
    }
    seen.add(key);
    let row: Row = el;
    if (store !== el.store || platformId !== el.platform_id) {
      row = { ...el, store, platform_id: platformId };
      cleaned++;
    }
    const id = typeof row.id === "number" ? row.id : NaN;
    if (!(id > lastId)) orderById = false;
    lastId = id;
    kept.push(row);
  }
  return { kept, twins, unusable, cleaned, orderById };
}

/**
 * Before the store loads: the table made exactly kv's copy, cleaned as healthWorkoutsKept cleans it, in one
 * transaction. Null when kv has no copy (never synced, or a later build dropped it) and the table stays as it is;
 * `broken` when the copy is not a list, the table left as it is too. Not caught: a failure stops the boot with nothing
 * changed.
 */
export async function healthWorkoutsFromKvCopy(db: AnyDb): Promise<HealthMove | null> {
  return db.transaction(async (tx) => {
    // First, before kv is read: in memory mode the lease is never waited on, so during a deploy the instance before
    // can still be saving. Its save writes the workouts' rows, then kv's copy, in one transaction; this lock waits for
    // one that already wrote rows (so the copy read next is the one it committed) and makes one that hasn't wait for
    // this boot. So no workout comes in between the read, the delete and the count (READ COMMITTED reads afresh each
    // statement), which would fail the boot on the count, or put an older copy over a newer row.
    await tx.execute(sql`LOCK TABLE "health_workouts" IN EXCLUSIVE MODE`);
    const [r] = (await tx.select().from(kv).where(eq(kv.key, "health_workouts"))) as { value: unknown }[];
    if (!r) return null;
    if (!Array.isArray(r.value)) return { kept: [], kvRows: 0, twins: 0, unusable: 0, cleaned: 0, broken: true, orderById: true };
    const m = healthWorkoutsKept(r.value);
    await tx.execute(sql`DELETE FROM "health_workouts"`);
    // A savepoint inside this transaction; keys deduplicated above, so its ON CONFLICT DO NOTHING never skips a row.
    await insertRowsOnce(tx as unknown as AnyDb, "health_workouts", m.kept);
    const counted = (await tx.execute(sql`SELECT count(*)::int AS n FROM "health_workouts"`)) as { rows?: { n: number }[] };
    const n = Number(counted.rows?.[0]?.n ?? -1);
    if (n !== m.kept.length) throw new Error(`[store] health_workouts: ${n} rows written of ${m.kept.length}`);
    return { ...m, kvRows: r.value.length, broken: false };
  });
}
