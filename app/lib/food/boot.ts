// The food diary's boot work (quest 8 part 1), on the notes' pattern (notes/boot.ts, untouched): what a FOOD_STORE=pg boot
// does to the seven tables before any request, and what a memory boot of this build does after one.
//
//   pg boot (under the lease): what migration 0021 makes is checked; calorie_logs' twins on (client_id, date) are moved
//   to food_twins and the unique rule made, only where the rule is missing (a memory boot dropped it, or the first pg
//   boot); kv's `food_pg` mark is set by the boot's own save; the JSON import's food goes into the tables first.
//   memory boot: when kv holds `food_pg` (a pg instance before it), the unique rule is dropped (a twin a memory-mode save
//   might make must never fail it) and the mark taken out by the boot's save. The lease is waited for (pg/runtime.ts).

import { sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { Data } from "../db";
import { insertRowsOnce } from "../pg/store";
import { FOOD_PG_MARK, FOOD_TABLES } from "./mode";
import { FOOD_ORDER_STAMPS, putOnClient, readOrders, reconcileOrders, restampAll, stampsOf, type OrderClient } from "./orders";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyDb = PgDatabase<any, any, any>;
type Row = Record<string, unknown>;
const rowsOf = (r: unknown): Row[] => ((r as { rows?: Row[] })?.rows ?? []) as Row[];
const log = (m: string) => console.log(`[food] ${m}`);

/** The unique rule a pg boot makes (and a memory boot drops). */
export const FOOD_CALORIE_UNIQUE = "calorie_logs_client_date_uq";

const NEEDED_INDEXES = [
  "calorie_logs_client_date_idx",
  "food_days_client_date_idx",
  "food_entries_client_date_idx",
  "food_entries_client_meal_idx",
  "food_meals_client_idx",
  "meal_photos_client_date_idx",
  "meal_photos_path_idx",
  "saved_days_client_idx",
  "saved_meals_client_idx",
  "saved_meals_picture_idx",
  "food_ops_at_idx",
];

/** What FOOD_STORE=pg leans on and is missing: migration 0021's objects (and, with `unique`, the pg boot's rule). */
export async function foodProblems(db: AnyDb, opts: { unique: boolean }): Promise<string[]> {
  const out: string[] = [];
  for (const t of [...FOOD_TABLES, "food_ops", "food_twins", "food_meal_orders"]) {
    if (rowsOf(await db.execute(sql`SELECT to_regclass(${t}) IS NOT NULL AS ok`))[0]?.ok !== true) out.push(`the table ${t} is missing`);
  }
  const have = new Set(rowsOf(await db.execute(sql`SELECT c.relname AS name FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE i.indisvalid`)).map((r) => String(r.name)));
  for (const i of [...NEEDED_INDEXES, ...(opts.unique ? [FOOD_CALORIE_UNIQUE] : [])]) if (!have.has(i)) out.push(`the index ${i} is missing or not valid`);
  if (rowsOf(await db.execute(sql`SELECT to_regclass('saved_days_id_seq') IS NOT NULL AS ok`))[0]?.ok !== true) out.push("the sequence saved_days_id_seq is missing");
  return out;
}

/** kv holds the mark a pg boot left (a memory boot of this build then waits for the lease and drops the unique rule). */
export async function kvHoldsFoodMark(db: AnyDb): Promise<boolean> {
  return rowsOf(await db.execute(sql`SELECT 1 FROM kv WHERE key = ${FOOD_PG_MARK}`)).length > 0;
}

/**
 * The pg boot's work, under the lease. calorie_logs' twins on (client_id, date) moved out (food_twins keeps them whole),
 * of each the client's own figure kept before the phone's (a typed figure wins while it is there: the phone's sync never
 * updates a row not its own), then the lowest id (what the Calories eaten box and a typed figure update: setCalorieLog
 * finds the first), pending Alex's answer (docs/database-plan.md, the food item's question 1); a twin already in
 * food_twins is overwritten with its current row, never deleted unkept. Then the unique rule. Only where the rule is
 * missing. Answers what it did, counts only.
 */
export async function foodBootPg(db: AnyDb): Promise<{ twins: number; unique: "made" | "there" }> {
  const there = rowsOf(await db.execute(sql`SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = ${FOOD_CALORIE_UNIQUE} AND i.indisvalid`)).length > 0;
  if (there) return { twins: 0, unique: "there" };
  let twins = 0;
  await db.transaction(async (tx) => {
    const q = (s: ReturnType<typeof sql>) => (tx as unknown as AnyDb).execute(s);
    await q(sql`LOCK TABLE calorie_logs IN SHARE ROW EXCLUSIVE MODE`);
    await q(sql.raw(`DROP INDEX IF EXISTS "${FOOD_CALORIE_UNIQUE}"`));
    const moved = rowsOf(
      await q(sql`WITH ranked AS (
          SELECT id, row_number() OVER (PARTITION BY client_id, date ORDER BY (COALESCE(extra->>'source', '') = 'health'), id) AS n FROM calorie_logs WHERE client_id IS NOT NULL AND date IS NOT NULL
        ), gone AS (
          INSERT INTO food_twins (tbl, id, row) SELECT 'calorie_logs', c.id, to_jsonb(c) FROM calorie_logs c JOIN ranked r ON r.id = c.id WHERE r.n > 1
          ON CONFLICT (tbl, id) DO UPDATE SET row = EXCLUDED.row, removed_at = now() RETURNING id
        )
        DELETE FROM calorie_logs WHERE id IN (SELECT id FROM ranked WHERE n > 1) RETURNING id`)
    );
    twins = moved.length;
    await q(sql.raw(`CREATE UNIQUE INDEX "${FOOD_CALORIE_UNIQUE}" ON "calorie_logs" ("client_id", "date")`));
  });
  if (twins) {
    console.error(`[food] !!! ${twins} calorie log twin${twins === 1 ? "" : "s"} on (client, day) moved to food_twins, of each the client's own figure (else the phone's) with the lowest id kept`);
    import("@sentry/nextjs")
      .then((S) => S.captureMessage(`Food twins moved: ${twins}`, { level: "warning", tags: { alert: "food-twins" } }))
      .catch(() => {});
  }
  log(`pg: unique rule made on calorie_logs (client, day)${twins ? `, ${twins} twins moved` : ""}`);
  return { twins, unique: "made" };
}

/** A memory boot of this build: the unique rule dropped, and kv's mark taken out by the boot's save. True when the store changed. */
export async function foodBootMemory(db: AnyDb, data: Partial<Data>): Promise<boolean> {
  try {
    await db.execute(sql.raw(`DROP INDEX IF EXISTS "${FOOD_CALORIE_UNIQUE}"`));
  } catch (error) {
    // Left in place, the rule would fail the store's whole save on the first calorie twin a memory save makes (its
    // upserts go before its deletes), every save of every table after it: the boot stops here instead, before any request.
    const still = await db
      .execute(sql`SELECT 1 FROM pg_class WHERE relname = ${FOOD_CALORIE_UNIQUE} AND relkind = 'i'`)
      .then((r) => rowsOf(r).length > 0)
      .catch(() => true);
    if (still) throw new Error(`[food] Refusing to start in memory mode: the unique rule ${FOOD_CALORIE_UNIQUE} on calorie_logs could not be dropped (${error instanceof Error ? error.message.split("\n")[0] : String(error)}); drop it by hand (docs/database-plan.md, the food item's rollback) and deploy again`);
    console.error("[food] the unique rule's drop failed, and it isn't there:", error instanceof Error ? error.message.split("\n")[0] : error);
  }
  const d = data as unknown as Record<string, unknown>;
  // The stamps of the mirrors (food/orders.ts) mean nothing once memory holds the truth: out with the mark.
  const stamps = FOOD_ORDER_STAMPS in d ? stampsOf(d) : null;
  if (!(FOOD_PG_MARK in d)) {
    if (!stamps) return false;
    delete d[FOOD_ORDER_STAMPS];
    return true;
  }
  // The meal orders back onto the clients first (after this build's pg mode the table is the truth; a client row's copy
  // may have missed a commit's save), so this build and every build after it read every card's place. The table is left.
  if (markHasOrders(d[FOOD_PG_MARK])) await ordersIntoStore(db, data, stamps ?? {});
  delete d[FOOD_PG_MARK];
  delete d[FOOD_ORDER_STAMPS];
  log("memory: the food diary is in memory again (the mark a pg boot left is taken out)");
  return true;
}

/** The mark of a pg boot of this build (`orders`: its meal orders are in food_meal_orders, the clients' their mirrors). */
const markHasOrders = (mark: unknown) => !!mark && typeof mark === "object" && (mark as { orders?: unknown }).orders === 1;
const clientsOf = (data: Partial<Data>) => ((data as unknown as { clients?: OrderClient[] }).clients ?? []) as OrderClient[];
const run = (db: AnyDb) => async (s: ReturnType<typeof sql>) => rowsOf(await db.execute(s));

/** A memory boot after this build's pg mode: the table's meal orders onto the clients whose copy is behind it. */
async function ordersIntoStore(db: AnyDb, data: Partial<Data>, stamps: Record<string, string>) {
  if (rowsOf(await db.execute(sql`SELECT to_regclass('food_meal_orders') IS NOT NULL AS ok`))[0]?.ok !== true) return;
  const rows = await readOrders(run(db), null);
  const { toStore, toTable } = reconcileOrders(rows, clientsOf(data), stamps);
  let put = 0;
  for (const { client, order } of toStore) if (putOnClient(client, order)) put++;
  log(`memory: meal orders from food_meal_orders (${rows.size} rows): ${put} put onto the clients${toTable.length ? `, ${toTable.length} kept as they are (changed since by another build, or with no row)` : ""} (the table left as it is)`);
}

/**
 * A pg boot's meal orders (quest 8 part 1, question 3), under the lease, before the boot's save (food/orders.ts). After
 * a pg boot of this build (kv's mark says `orders`) the table is the truth: its order onto each client whose mirror is
 * the one this build stamped (a crash came before the save of a later one), the client's into the table where another
 * build changed it since, rows of clients gone deleted. After anything else (memory mode, the first flip, an import),
 * the clients' orders are the truth and the table is made from them again, whole. Then every mirror stamped and the
 * mark set, saying `orders`; the boot's save writes the clients, the stamps and the mark together. True when the
 * store changed.
 */
export async function foodBootPgStore(db: AnyDb, data: Partial<Data>, opts: { fresh: boolean }): Promise<boolean> {
  const d = data as unknown as Record<string, unknown>;
  const clients = clientsOf(data);
  let changed = false;
  if (!opts.fresh && markHasOrders(d[FOOD_PG_MARK])) {
    const rows = await readOrders(run(db), null);
    const { toStore, toTable, orphans } = reconcileOrders(rows, clients, stampsOf(d));
    let put = 0;
    for (const { client, order } of toStore) if (putOnClient(client, order)) put++;
    if (put) changed = true;
    if (toTable.length || orphans.length) {
      await db.transaction(async (tx) => {
        const q = (s: ReturnType<typeof sql>) => (tx as unknown as AnyDb).execute(s);
        for (const t of toTable) {
          if (t.order == null) await q(sql`DELETE FROM food_meal_orders WHERE client_id = ${t.clientId}::int`);
          else
            await q(sql`INSERT INTO food_meal_orders (client_id, meal_order, updated_at) VALUES (${t.clientId}::int, ${JSON.stringify(t.order)}::jsonb, now())
              ON CONFLICT (client_id) DO UPDATE SET meal_order = EXCLUDED.meal_order, updated_at = EXCLUDED.updated_at`);
        }
        if (orphans.length) await q(sql`DELETE FROM food_meal_orders WHERE client_id = ANY(${`{${orphans.join(",")}}`}::int[])`);
      });
    }
    log(`pg: meal orders from food_meal_orders (${rows.size} rows): ${put} put onto the clients, ${toTable.length} taken from the clients (changed since by another build, or with no row), ${orphans.length} of clients gone deleted`);
  } else {
    const seed = [...new Map(clients.filter((c) => Array.isArray(c.meal_order)).map((c) => [c.id, c] as const)).values()];
    await db.transaction(async (tx) => {
      const q = (s: ReturnType<typeof sql>) => (tx as unknown as AnyDb).execute(s);
      await q(sql`DELETE FROM food_meal_orders`);
      for (let i = 0; i < seed.length; i += 500) {
        const batch = JSON.stringify(seed.slice(i, i + 500).map((c) => ({ client_id: c.id, meal_order: c.meal_order })));
        await q(sql`INSERT INTO food_meal_orders (client_id, meal_order) SELECT client_id, meal_order FROM jsonb_to_recordset(${batch}::jsonb) AS x(client_id int, meal_order jsonb)`);
      }
    });
    log(`pg: food_meal_orders made from the clients' meal orders, ${seed.length} rows`);
  }
  if (restampAll(d, clients)) changed = true;
  return markFoodPg(data) || changed;
}

/** The pg boot's mark, in the store (kv) from the boot's own save: a memory boot after it knows to wait for the lease. */
export function markFoodPg(data: Partial<Data>): boolean {
  const d = data as unknown as Record<string, unknown>;
  if (markHasOrders(d[FOOD_PG_MARK])) return false;
  // `orders`: this build's (a pg boot keeps its meal orders in food_meal_orders); an older mark without it is replaced.
  d[FOOD_PG_MARK] = { at: new Date().toISOString(), orders: 1 };
  return true;
}

/** The JSON import's food (FOOD_STORE=pg on an empty database), into the tables as the writer writes rows, then out of what loads. */
export async function importFood(db: AnyDb, raw: Partial<Data>) {
  const r = raw as Record<string, unknown>;
  dropImportedStamps(r);
  if (r._food_in_postgres) {
    if (process.env.ALLOW_JSON_WITHOUT_FOOD !== "1") {
      throw new Error(
        "[store] Refusing to start: the JSON to import was written with FOOD_STORE=pg and holds no food diary (it is in Postgres). Restore the database instead (scripts/restore-pg-backup.mjs), or set ALLOW_JSON_WITHOUT_FOOD=1 to start without it."
      );
    }
    delete r._food_in_postgres;
  }
  for (const t of FOOD_TABLES) {
    const list = r[t];
    delete r[t];
    if (!Array.isArray(list) || !list.length) continue;
    const n = await insertRowsOnce(db, t, list);
    log(`${t}: ${n} rows of the JSON imported into the table (FOOD_STORE=pg)`);
  }
}

/** A memory boot's import of a JSON a pg instance wrote (its food in Postgres): refused unless asked. */
export function checkFoodJson(raw: Partial<Data>) {
  const r = raw as Record<string, unknown>;
  dropImportedStamps(r);
  if (!r._food_in_postgres) return;
  if (process.env.ALLOW_JSON_WITHOUT_FOOD !== "1") {
    throw new Error(
      "[store] Refusing to start: the JSON to import was written with FOOD_STORE=pg and holds no food diary (it is in Postgres). Restore the database instead (scripts/restore-pg-backup.mjs), or set ALLOW_JSON_WITHOUT_FOOD=1 to start without it."
    );
  }
  delete r._food_in_postgres;
}

/**
 * A JSON's stamps of the mirrors never come into a new database (the review's fix, 20 Nov): they speak of the
 * food_meal_orders of the database that wrote it, and this one's is empty, so a boot reading them would put no order
 * on every client (orders.ts). This build's JSONs leave them out (rows.ts withFoodKeys); one written before is put
 * right here. A JSON memory mode wrote never holds them: nothing changes for it.
 */
function dropImportedStamps(r: Record<string, unknown>) {
  if (!(FOOD_ORDER_STAMPS in r)) return;
  delete r[FOOD_ORDER_STAMPS];
  log("import: the JSON's meal-order stamps left out (they belong to the database that wrote it)");
}

/** Each table's highest id (FOOD_STORE=pg: memory no longer holds the rows raiseCounters reads). */
export async function foodMaxIds(db: AnyDb): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of FOOD_TABLES) out[t] = Number(rowsOf(await db.execute(sql.raw(`SELECT COALESCE(MAX(id), 0)::bigint AS m FROM "${t}"`)))[0]?.m ?? 0);
  return out;
}
