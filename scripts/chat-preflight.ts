// The cut-over's boot checks, run ahead on the night's database (Step 5 of docs/database-plan.md, before the flip), so a
// refused boot is found while the live build still serves:
//   DATABASE_URL=postgres://… npx tsx scripts/chat-preflight.ts
// It runs exactly what a CHAT_STORE=pg boot runs first (app/lib/chat/preflight.ts: the functions, indexes, sequence,
// columns and once_keys' key there; every read statement run read-only; every write statement run on client -1 inside one
// transaction rolled back; the wipe and toPrepare only planned), then checks chat's pool options take on this server
// (statement_timeout 5s, lock_timeout 2s, as chat/pg.ts refuses otherwise), who holds the lease (pg/lease.ts), and the
// counts the night's pre-checks read. It never changes a row, and starts no store or writer.

import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { chatPreflight } from "../app/lib/chat/preflight";
import { LEASE_KEY } from "../app/lib/pg/lease";

const url = process.env.DATABASE_URL;
if (!url || !url.startsWith("postgres")) {
  console.error("DATABASE_URL must be a postgres:// URL.");
  process.exit(2);
}

async function main() {
  const pool = new pg.Pool({ connectionString: url, max: 2, application_name: "norcoach-chat-preflight" });
  let failed = false;
  try {
    const db = drizzle(pool);
    try {
      await chatPreflight(db as never);
      console.log("ok   preflight: functions, indexes, sequence, columns, once_keys' key; every statement runs");
    } catch (error) {
      failed = true;
      console.error(`FAIL ${error instanceof Error ? error.message : error}`);
    }
    // Chat's own pool options, as chat/pg.ts sets and checks them.
    const chat = new pg.Client({ connectionString: url, application_name: "norcoach-chat-preflight", options: "-c statement_timeout=5000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=10000" });
    try {
      await chat.connect();
      const r = (await chat.query("SELECT current_setting('statement_timeout') AS st, current_setting('lock_timeout') AS lt")).rows[0];
      if (r.st === "5s" && r.lt === "2s") console.log("ok   chat's pool options take (statement_timeout 5s, lock_timeout 2s)");
      else {
        failed = true;
        console.error(`FAIL chat's pool options don't take: statement_timeout ${r.st}, lock_timeout ${r.lt}`);
      }
    } catch (error) {
      failed = true;
      console.error(`FAIL chat's pool options: ${error instanceof Error ? error.message : error}`);
    } finally {
      await chat.end().catch(() => {});
    }
    const q = async (text: string, values: unknown[] = []) => (await pool.query(text, values)).rows;
    const holder = await q(
      `SELECT a.pid, a.application_name, a.backend_start FROM pg_locks l JOIN pg_stat_activity a USING (pid)
        WHERE l.locktype = 'advisory' AND l.classid = $1 AND l.objid = $2 AND l.objsubid = 2`,
      [LEASE_KEY[0], LEASE_KEY[1]]
    );
    console.log(holder.length ? `info the lease is held by ${holder.map((h) => `${h.application_name} (pid ${h.pid}, since ${new Date(h.backend_start).toISOString()})`).join(", ")}` : "info the lease is free (no instance of a build that takes it is running)");
    const counts = (await q(`SELECT count(*)::int AS n, max(id) AS max, count(*) FILTER (WHERE created_at_tz IS NULL)::int AS no_tz, count(*) FILTER (WHERE text IS NULL)::int AS no_text FROM chat_messages`))[0];
    console.log(`info chat_messages: ${counts.n} rows, max id ${counts.max}, created_at_tz null ${counts.no_tz}, text null ${counts.no_text}`);
    const coachless = await q(`SELECT count(*)::int AS n FROM clients WHERE coach_id IS NULL`).catch(() => null);
    if (coachless) console.log(`info clients with no coach: ${coachless[0].n}`);
    const kvChat = (await q(`SELECT count(*)::int AS n FROM kv WHERE key = 'chat_messages'`))[0];
    if (kvChat.n) {
      failed = true;
      console.error("FAIL kv holds a key chat_messages");
    } else console.log("ok   no kv key chat_messages");
  } finally {
    await pool.end().catch(() => {});
  }
  console.log(failed ? "NOT READY" : "READY (the boot's strays limit is checked by the boot itself: see P3 in the runbook)");
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
