// The logged sets' cut-over checks, run ahead on the night's database (quest 10, Step 6 of docs/database-plan.md, before
// SETS_STORE=pg is set), so a refused boot is found while the live build still serves:
//   TZ=Europe/Amsterdam DATABASE_URL=postgres://… npx tsx scripts/sets-preflight.ts [--with-unique]
// Read only: what migration 0025 makes (app/lib/sets/boot.ts setsProblems), then the night's pre-checks: P1 the table's
// count and highest id, against `_seq`; P2 twins on (row, set number) and which the pg boot keeps (memory's keeper,
// db.ts newerSetTwin); P3 sets with a NULL row or set number; P4 sets of no row (orphans: counted, never moved); P5
// logged_at's formats and the odd stamps; P6 `extra` keys; P7 kv keys named like the table; P8 kv's tombstones and
// home-gym pins; P9 the sequence against MAX(id) and `_seq`; P10 client_id NULL or not its row's day's client; and the
// cardio ticks' T1–T6 (migration 0026, below).
// --with-unique makes the unique rules inside a transaction rolled back (it fails, and says so, while twins are there).
// It never changes a row, and starts no store or writer.

import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { setsProblems, setTwinsToMove, SETS_UNIQUE, tickTwinsToMove, TICKS_UNIQUE } from "../app/lib/sets/boot";
import { SETS_REMOVING } from "../app/lib/sets/mode";
import { fromRecord } from "../app/lib/pg/store";
import { cardio_logs, set_logs } from "../app/lib/pg/schema";
import type { CardioTickRow, SetLogRow } from "../app/lib/db";

if (!process.env.TZ) process.env.TZ = "Europe/Amsterdam";
const url = process.env.DATABASE_URL;
if (!url || !url.startsWith("postgres")) {
  console.error("DATABASE_URL must be a postgres:// URL.");
  process.exit(2);
}
const withUnique = process.argv.includes("--with-unique");
class RolledBack extends Error {}
type Row = Record<string, unknown>;

async function main() {
  const pool = new pg.Pool({ connectionString: url, max: 2, application_name: "norcoach-sets-preflight" });
  let failed = false;
  const fail = (what: string) => {
    failed = true;
    console.error(`FAIL ${what}`);
  };
  try {
    const db = drizzle(pool);
    const rows = async (q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as { rows: Row[] }).rows;
    const problems = await setsProblems(db as never, { unique: false });
    for (const p of problems) fail(`migrations 0025 and 0026: ${p}`);
    const seq = (await rows(sql`SELECT value FROM kv WHERE key = '_seq'`))[0]?.value as Record<string, number> | undefined;
    // P1
    const p1 = (await rows(sql`SELECT count(*)::int AS n, COALESCE(MAX(id), 0)::int AS top FROM set_logs`))[0];
    console.log(`P1 set_logs: ${p1.n} rows, highest id ${p1.top}, _seq ${seq?.set_logs ?? "none"}`);
    if (Number(p1.top) > Number(seq?.set_logs ?? 0)) fail("P1 the highest id is past _seq (the boot raises it; look first)");
    // P2, P3
    // Whole rows decoded as the boot decodes them (fromRecord: a stamp kept in `extra` reads as the boot reads it), so the
    // twins named are the ones the boot will move.
    const groups = await rows(sql`SELECT s.* FROM set_logs s JOIN (SELECT workout_assignment_id AS w, set_number AS n FROM set_logs GROUP BY 1, 2 HAVING count(*) > 1) g ON g.w IS NOT DISTINCT FROM s.workout_assignment_id AND g.n IS NOT DISTINCT FROM s.set_number ORDER BY s.id`);
    const move = setTwinsToMove(groups.map((r) => fromRecord(set_logs, r) as unknown as SetLogRow));
    console.log(`P2 twins: ${groups.length} rows in groups of two or more, ${move.length} the pg boot keeps aside (ids ${move.slice(0, 20).join(",")})`);
    const nulls = (await rows(sql`SELECT count(*)::int AS n FROM set_logs WHERE workout_assignment_id IS NULL OR set_number IS NULL`))[0];
    console.log(`P3 sets with a NULL row or set number: ${nulls.n}`);
    // P4
    const orphans = (await rows(sql`SELECT count(*)::int AS n FROM set_logs s WHERE NOT EXISTS (SELECT 1 FROM workout_assignments w WHERE w.id = s.workout_assignment_id)`))[0];
    console.log(`P4 sets of no row: ${orphans.n}`);
    // P5
    const fmt = (await rows(sql`SELECT
        count(*) FILTER (WHERE logged_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$')::int AS local,
        count(*) FILTER (WHERE logged_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T')::int AS iso,
        count(*) FILTER (WHERE logged_at IS NULL OR logged_at = '')::int AS blank,
        count(*) FILTER (WHERE logged_at_tz IS NULL AND logged_at IS NOT NULL AND logged_at <> '')::int AS no_instant FROM set_logs`))[0];
    console.log(`P5 logged_at: ${JSON.stringify(fmt)}`);
    // P6
    const keys = await rows(sql`SELECT k, count(*)::int AS n FROM set_logs, jsonb_object_keys(COALESCE(extra, '{}'::jsonb)) AS k GROUP BY k ORDER BY k`);
    console.log(`P6 extra keys: ${keys.map((r) => `${r.k} ${r.n}`).join(", ") || "none"}`);
    // P7, P8
    const kvs = await rows(sql`SELECT key FROM kv WHERE key IN ('set_logs', 'set_twins', ${SETS_REMOVING}, 'sets_gym_pins', 'sets_pg')`);
    console.log(`P7/P8 kv keys: ${kvs.map((r) => r.key).join(", ") || "none"}`);
    if (kvs.some((r) => r.key === "set_logs" || r.key === "set_twins")) fail("P7 a kv key named like the table");
    // P9
    const sq = (await rows(sql`SELECT last_value::int AS v FROM set_logs_id_seq`))[0];
    console.log(`P9 set_logs_id_seq ${sq?.v} (highest id ${p1.top}, _seq ${seq?.set_logs ?? "none"})`);
    // P10
    const cl = (await rows(sql`SELECT count(*) FILTER (WHERE s.client_id IS NULL)::int AS null_client, count(*) FILTER (WHERE s.client_id IS DISTINCT FROM d.client_id)::int AS stale FROM set_logs s LEFT JOIN workout_assignments w ON w.id = s.workout_assignment_id LEFT JOIN program_days d ON d.id = w.program_day_id`))[0];
    console.log(`P10 client_id: ${cl.null_client} NULL, ${cl.stale} not their row's day's client (the pg boot writes them again)`);
    // The cardio ticks (with the sets since 22 Nov; migration 0026): T1 count and highest id against `_seq`, T2 twins on
    // the entry and which the pg boot keeps (the highest id), T3 ticks of no entry (kept, never moved), T4 a tick whose
    // client_id is not its entry's day's client (each write checks its own client: such a tick could never be unticked
    // in pg mode), T5 the sequences of the ticks and of the cardio entries against MAX(id) and `_seq`, T6 kv keys.
    const t1 = (await rows(sql`SELECT count(*)::int AS n, COALESCE(MAX(id), 0)::int AS top FROM cardio_logs`))[0];
    console.log(`T1 cardio_logs: ${t1.n} rows, highest id ${t1.top}, _seq ${seq?.cardio_logs ?? "none"}`);
    if (Number(t1.top) > Number(seq?.cardio_logs ?? 0)) fail("T1 the highest tick id is past _seq (the boot raises it; look first)");
    const tg = await rows(sql`SELECT t.* FROM cardio_logs t JOIN (SELECT cardio_entry_id AS e FROM cardio_logs WHERE cardio_entry_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1) g ON g.e = t.cardio_entry_id ORDER BY t.id`);
    const tmove = tickTwinsToMove(tg.map((r) => fromRecord(cardio_logs, r) as unknown as CardioTickRow));
    console.log(`T2 tick twins: ${tg.length} rows in groups of two or more, ${tmove.length} the pg boot keeps aside (ids ${tmove.slice(0, 20).join(",")})`);
    const to = (await rows(sql`SELECT count(*)::int AS n FROM cardio_logs t WHERE NOT EXISTS (SELECT 1 FROM cardio_entries c WHERE c.id = t.cardio_entry_id)`))[0];
    console.log(`T3 ticks of no entry: ${to.n}`);
    // A tick with no client is said, never failed: pg mode's untick deletes it (client_id IS NULL allowed) and nothing changes one.
    const tc = (await rows(sql`SELECT count(*) FILTER (WHERE t.client_id IS NOT NULL AND t.client_id <> d.client_id)::int AS n, count(*) FILTER (WHERE t.client_id IS NULL)::int AS no_client FROM cardio_logs t JOIN cardio_entries c ON c.id = t.cardio_entry_id JOIN program_days d ON d.id = c.program_day_id`))[0];
    console.log(`T4 ticks whose client is not their entry's day's: ${tc.n}; with no client: ${tc.no_client}`);
    if (Number(tc.n) > 0) fail("T4 a tick carries another client than its entry's (look first: pg mode could never untick it)");
    for (const t of ["cardio_logs", "cardio_entries"]) {
      const top = (await rows(sql.raw(`SELECT COALESCE(MAX(id), 0)::int AS top FROM "${t}"`)))[0];
      const v = (await rows(sql.raw(`SELECT last_value::int AS v FROM "${t}_id_seq"`)))[0];
      console.log(`T5 ${t}_id_seq ${v?.v} (highest id ${top.top}, _seq ${seq?.[t] ?? "none"})`);
    }
    const tk = await rows(sql`SELECT key FROM kv WHERE key = 'cardio_logs'`);
    if (tk.length) fail("T6 a kv key named like the cardio ticks' table");
    if (withUnique) {
      try {
        await db.transaction(async (tx) => {
          // On the live table: a lock it can't get at once, or a build past 30 s, gives up (never stalls the live writer's saves).
          await (tx as unknown as typeof db).execute(sql`SET LOCAL lock_timeout = '2s'`);
          await (tx as unknown as typeof db).execute(sql`SET LOCAL statement_timeout = '30s'`);
          await (tx as unknown as typeof db).execute(sql.raw(`CREATE UNIQUE INDEX "${SETS_UNIQUE}_probe" ON "set_logs" ("workout_assignment_id", "set_number")`));
          await (tx as unknown as typeof db).execute(sql.raw(`CREATE UNIQUE INDEX "${TICKS_UNIQUE}_probe" ON "cardio_logs" ("cardio_entry_id")`));
          throw new RolledBack();
        });
      } catch (e) {
        if (e instanceof RolledBack) console.log("unique rule: makes (rolled back)");
        else fail(`unique rule: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
      }
    }
  } finally {
    await pool.end();
  }
  console.log(failed ? "NOT READY" : "READY");
  process.exit(failed ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
