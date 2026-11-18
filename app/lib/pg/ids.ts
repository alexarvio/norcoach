import { sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";

// Ids from Postgres for the tables that will leave memory (18 Nov, step 4 of docs/database-plan.md, part A).
//
// Until now every id came from the in-memory counters (`_seq`), saved by the mirror. Once a table is written to
// Postgres directly (step 5 on), a row can commit before the counter it took its id from is saved; a crash between the
// two would hand that id out again after the restart, and a child row would point at another client's parent. So
// these tables, and the parents a moving table points at, take their ids from a Postgres sequence each
// (`<table>_id_seq`, migration 0015), which never gives a number twice, crash or not.
//
// allocId stays synchronous: ids are drawn ahead in blocks (BLOCK nextval()s in one query, refilled in the background
// when fewer than LOW are left), and handed out from memory. The rules that keep them unique:
//   - at every boot, before any id is handed out, each sequence is raised to at least the highest id its table holds
//     and its `_seq` counter (setval GREATEST), so ids handed out by an older build meanwhile (a rollback, which counts
//     from `_seq`) are never given again;
//   - every id handed out is higher than every one before it in this process: a drawn id at or under `_seq` is
//     skipped, and `_seq` is raised to each id handed out (db.ts nextId), so a rollback to a build that counts from
//     `_seq` never collides either;
//   - when the block runs dry (a burst: a programme copied, a run of reminders) or Postgres can't be reached, the id is
//     `_seq` + 1 as it always was, never waiting on the database; the next refill first raises the sequence past it.
// Nothing else may call nextval() on these sequences while ids are counted in memory too: a direct insert (step 5)
// takes its id from allocId like everything else. One server, as now; two servers need the refill's setval made safe
// (it reads and sets in one statement, which only one writer keeps right).

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyDb = PgDatabase<any, any, any>;

/** The tables whose ids come from their sequence: those that will move (step 6) and the parents they point at. */
export const SEQUENCED_TABLES = [
  "chat_messages",
  "coach_activity",
  "food_entries",
  "calorie_logs",
  "food_days",
  "food_meals",
  "saved_meals",
  "meal_photos",
  "metric_entries",
  "set_logs",
  "workout_assignments",
  "program_days",
] as const;

export const sequenceOf = (table: string) => `${table}_id_seq`;

const BLOCK = 200;
const LOW = 100;
/** After a refill fails, the wait before the next try (a take asks again). */
const RETRY_MS = 5_000;

const rowsOf = (result: unknown): Record<string, unknown>[] => ((result as { rows?: Record<string, unknown>[] }).rows ?? []) as Record<string, unknown>[];
const log = (message: string) => console.log(`[ids] ${message}`);

type Pool = {
  ids: number[];
  refilling: Promise<void> | null;
  failedAt: number;
  /** Ids handed out from `_seq` since the last refill: the sequence may be behind them. */
  fallbacks: number;
};

export class IdPools {
  private pools = new Map<string, Pool>();

  constructor(
    private db: AnyDb,
    /** The live `_seq` counters (db.ts's store), read at each refill. */
    private seq: () => Record<string, number>
  ) {
    for (const t of SEQUENCED_TABLES) this.pools.set(t, { ids: [], refilling: null, failedAt: 0, fallbacks: 0 });
  }

  /**
   * At boot, before any id is handed out: each sequence raised to its table's highest id and its counter, then a block
   * drawn. Never stops the boot: a table whose sequence can't be raised (a missing sequence, an id past its range)
   * counts from `_seq` as before, and its next refill raises it first.
   */
  async start(): Promise<void> {
    const seq = this.seq();
    let ready = 0;
    for (const t of SEQUENCED_TABLES) {
      const pool = this.pools.get(t)!;
      try {
        const max = Number(rowsOf(await this.db.execute(sql.raw(`SELECT COALESCE(MAX(id), 0)::bigint AS max FROM "${t}"`)))[0]?.max ?? 0);
        const floor = Math.max(max, seq[t] ?? 0);
        const at = await this.raise(t, floor);
        if (at > floor + BLOCK * 50) log(`${sequenceOf(t)} is at ${at}, well past ${t}'s highest id and counter ${floor}`);
        await this.draw(t);
        ready++;
      } catch (error) {
        console.error(`[ids] ${sequenceOf(t)} could not be raised at boot; ${t} counts its ids in memory until a refill raises it:`, error instanceof Error ? error.message : error);
        pool.fallbacks++;
        pool.failedAt = Date.now();
      }
    }
    log(`sequences ready for ${ready} of ${SEQUENCED_TABLES.length} tables`);
  }

  /** The sequence at least `floor` (never lowered); where it now stands. */
  private async raise(table: string, floor: number): Promise<number> {
    const r = await this.db.execute(sql`SELECT setval(${sequenceOf(table)}::regclass, GREATEST(nextval(${sequenceOf(table)}::regclass), ${floor}::bigint)) AS at`);
    return Number(rowsOf(r)[0]?.at);
  }

  private async draw(table: string) {
    const pool = this.pools.get(table)!;
    const r = await this.db.execute(sql`SELECT nextval(${sequenceOf(table)}::regclass) AS id FROM generate_series(1, ${BLOCK})`);
    const drawn = rowsOf(r)
      .map((row) => Number(row.id))
      .filter((id) => Number.isSafeInteger(id))
      .sort((a, b) => a - b);
    const floor = this.seq()[table] ?? 0;
    const last = pool.ids.length ? pool.ids[pool.ids.length - 1] : floor;
    for (const id of drawn) if (id > floor && id > last) pool.ids.push(id);
  }

  private refill(table: string) {
    const pool = this.pools.get(table)!;
    if (pool.refilling || Date.now() - pool.failedAt < RETRY_MS) return;
    pool.refilling = (async () => {
      try {
        // Ids handed out from the counter meanwhile: the sequence goes past them first, so it never gives them again.
        if (pool.fallbacks) {
          const n = pool.fallbacks;
          await this.raise(table, this.seq()[table] ?? 0);
          pool.fallbacks -= n;
          log(`${table}: ${n} id${n === 1 ? "" : "s"} counted in memory while the block was empty; the sequence is past them`);
        }
        await this.draw(table);
        pool.failedAt = 0;
      } catch (error) {
        if (!pool.failedAt) console.error(`[ids] could not draw ids for ${table} (counting in memory until it works):`, error instanceof Error ? error.message : error);
        pool.failedAt = Date.now();
      } finally {
        pool.refilling = null;
      }
    })();
    void pool.refilling;
  }

  /**
   * The next id for `table` above `counter` (its `_seq`), from the block; null when the table has no sequence or the
   * block is empty, and the caller counts from `_seq` (db.ts nextId), which raises `_seq` to whichever it hands out.
   */
  take(table: string, counter: number): number | null {
    const pool = this.pools.get(table);
    if (!pool) return null;
    let id: number | null = null;
    while (pool.ids.length) {
      const next = pool.ids.shift()!;
      if (next > counter) {
        id = next;
        break;
      }
    }
    if (id == null) pool.fallbacks++;
    if (pool.ids.length < LOW) this.refill(table);
    return id;
  }

  /** For /api/timing and the tests: ids left in each block. */
  left(): Record<string, number> {
    return Object.fromEntries([...this.pools].map(([t, p]) => [t, p.ids.length]));
  }

  /** Settles once every refill running now is done (the tests). */
  async settled(): Promise<void> {
    await Promise.all([...this.pools.values()].map((p) => p.refilling));
  }
}
