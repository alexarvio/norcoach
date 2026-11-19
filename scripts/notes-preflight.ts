// The notifications' cut-over checks, run ahead on the night's database (quest 7, Step 6 of docs/database-plan.md,
// before NOTES_STORE=pg is set), so a refused boot is found while the live build still serves:
//   TZ=Europe/Amsterdam DATABASE_URL=postgres://… npx tsx scripts/notes-preflight.ts [--with-unique]
// (the server's zone: P6 reads the stamps as the app does; the script sets it itself when it is unset).
// Read only: what migration 0020 makes (indexes valid, the shadow, twins and ops tables, the sequence, the columns;
// app/lib/notes/preflight.ts notesProblems), every read statement run in a read-only transaction, then the night's
// pre-checks P1-P6 (counts, twins, stamps, words, kv keys, the message-id backfill as a dry run) and who holds the lease.
// --with-unique also makes the unique rule a pg boot makes and runs every write statement on client -1, all inside one
// transaction rolled back (the CREATE INDEX holds writes to coach_activity for its few milliseconds; it fails, and says
// so, while twins are there). It never changes a row, and starts no store or writer.

import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { notesProblems, NOTES_UNIQUE } from "../app/lib/notes/preflight";
import { readSql, writeSql, noteParams } from "../app/lib/notes/statements";
import { backfillMessageIds } from "../app/lib/notes/boot";
import { LEASE_KEY } from "../app/lib/pg/lease";

// The server's zone before any date is read (Node reads TZ again when it changes).
if (!process.env.TZ) process.env.TZ = "Europe/Amsterdam";
if (process.env.TZ !== "Europe/Amsterdam") console.log(`WARN TZ is ${process.env.TZ}, not the server's Europe/Amsterdam: P6 reads stamps in it`);
const url = process.env.DATABASE_URL;
if (!url || !url.startsWith("postgres")) {
  console.error("DATABASE_URL must be a postgres:// URL.");
  process.exit(2);
}
const withUnique = process.argv.includes("--with-unique");
class RolledBack extends Error {}

async function main() {
  const pool = new pg.Pool({ connectionString: url, max: 2, application_name: "norcoach-notes-preflight" });
  let failed = false;
  const fail = (what: string) => {
    failed = true;
    console.error(`FAIL ${what}`);
  };
  try {
    const db = drizzle(pool);
    const any = db as never;
    const problems = await notesProblems(any, { unique: false });
    if (problems.length) problems.forEach(fail);
    else console.log("ok   migration 0020: indexes valid, shadow, twins and ops tables, sequence, columns");
    const T = "coach_activity" as const;
    try {
      for (const q of [
        readSql.newest(T, -1, 500),
        readSql.whole(T, -1),
        readSql.keys(T, -1, ["preflight:-1"]),
        readSql.family(T, -1, "photos-remind:", ""),
        readSql.ids(T, [-1]),
        readSql.owner(T, -1),
        readSql.chatNote(T, -1, -1, "preflight"),
        readSql.chatNote(T, -1, -1, null),
        readSql.unreadClients(T),
        readSql.reminderKeys(T, [{ clientId: -1, key: "reminder:x:-1:2000-01-01" }]),
        readSql.unreadReminders(T, [-1]),
        readSql.claimedTokens(["preflight"]),
        readSql.export(T, [-1]),
        readSql.page(T, 2147483646, 1),
        readSql.strays(T),
      ])
        await db.transaction(async (tx) => void (await tx.execute(q)), { accessMode: "read only" });
      console.log("ok   every read statement runs");
    } catch (error) {
      fail(`a read statement: ${error instanceof Error ? error.message : error}`);
    }
    const q = async (text: string, values: unknown[] = []) => (await pool.query(text, values)).rows;
    // P1-P5, the night's pre-checks.
    const c = (await q(`SELECT count(*)::int AS n, max(id) AS max, count(*) FILTER (WHERE kind = 'reminder')::int AS reminders, count(*) FILTER (WHERE created_at_tz IS NULL)::int AS no_tz FROM coach_activity`))[0];
    console.log(`info P1 coach_activity: ${c.n} rows, max id ${c.max}, ${c.reminders} reminders, created_at_tz null ${c.no_tz}`);
    const twins = (await q(`SELECT count(*)::int AS groups, COALESCE(sum(n - 1), 0)::int AS extra FROM (SELECT client_id, dedupe_key, count(*) n FROM coach_activity WHERE dedupe_key IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1) t`))[0];
    console.log(`${twins.groups ? "WARN" : "ok  "} P2 twins on (client, key): ${twins.groups} groups, ${twins.extra} rows the pg boot would move to coach_activity_twins (the lowest id of each kept, made unread where a twin is: 19 Nov, Alex)`);
    const stamps = (await q(`SELECT count(*) FILTER (WHERE created_at IS NULL)::int AS nulls, count(*) FILTER (WHERE created_at !~ '^[ -~]*$')::int AS non_ascii, count(*) FILTER (WHERE created_at !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$')::int AS not_iso, count(DISTINCT client_id) FILTER (WHERE created_at IS NULL OR created_at !~ '^[ -~]*$')::int AS stray_clients FROM coach_activity`))[0];
    console.log(`info P3 stamps: null ${stamps.nulls}, non-ASCII ${stamps.non_ascii}, not ISO-Z ${stamps.not_iso}; ${stamps.stray_clients} clients read whole`);
    const words = (await q(`SELECT count(*)::int AS n FROM coach_activity WHERE message IS NULL`))[0];
    console.log(`info P4 rows with no words: ${words.n}`);
    for (const key of ["coach_activity", "notes_outbox", "notes_outbox_dead"]) {
      const n = (await q(`SELECT count(*)::int AS n FROM kv WHERE key = $1`, [key]))[0].n;
      if (n) {
        if (key === "notes_outbox") console.log("WARN P5 kv holds notes_outbox: a NOTES_STORE=pg instance ran (a memory boot of this build applies it)");
        else if (key === "notes_outbox_dead") console.log("WARN P5 kv holds notes_outbox_dead: ops the table refused; look at them before the night");
        else fail(`P5 kv holds a key ${key}`);
      } else console.log(`ok   P5 no kv key ${key}`);
    }
    const links = await backfillMessageIds(any, { dryRun: true });
    console.log(`info P6 the backfill would link ${links.linked} coach notes to their message (${links.ambiguous} ambiguous, ${links.none} with no match: photo-only, edited, deleted; left by words)`);
    const holder = await q(
      `SELECT a.pid, a.application_name, a.backend_start FROM pg_locks l JOIN pg_stat_activity a USING (pid)
        WHERE l.locktype = 'advisory' AND l.classid = $1 AND l.objid = $2 AND l.objsubid = 2`,
      [LEASE_KEY[0], LEASE_KEY[1]]
    );
    console.log(holder.length ? `info the lease is held by ${holder.map((h) => `${h.application_name} (pid ${h.pid}, since ${new Date(h.backend_start).toISOString()})`).join(", ")}` : "info the lease is free");
    if (withUnique) {
      try {
        await db.transaction(async (tx) => {
          // Never a long hold on the live table: the index waits 2 s at most for the store's saves, and builds within 30 s,
          // else this fails (and says so) with nothing changed.
          await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
          await tx.execute(sql`SET LOCAL statement_timeout = '30s'`);
          await tx.execute(sql.raw(`CREATE UNIQUE INDEX "${NOTES_UNIQUE}_preflight" ON coach_activity (client_id, md5(dedupe_key)) WHERE dedupe_key IS NOT NULL`));
          await tx.execute(sql`CREATE TABLE IF NOT EXISTS coach_activity_ops (token text PRIMARY KEY NOT NULL, at timestamp with time zone DEFAULT now() NOT NULL, outcome text)`);
          const row = { id: -1, client_id: -1, message: "preflight", created_at: new Date().toISOString(), kind: "general" as const, read: false, action_tab: null, action_label: null, action_ref: null, dedupe_key: "preflight:-1" };
          const rows = async (s: ReturnType<typeof sql>) => ((await tx.execute(s)) as unknown as { rows: unknown[] }).rows;
          if ((await rows(writeSql.insertKeyed(T, noteParams(row)))).length !== 1) throw new Error("the keyed insert wrote nothing");
          if ((await rows(writeSql.insertKeyed(T, noteParams({ ...row, id: -2 })))).length !== 0) throw new Error("the key's rule did not hold a second row");
          await rows(writeSql.lockKeyed(T, -1, "preflight:-1"));
          await rows(writeSql.update(T, noteParams({ ...row, message: "preflight 2" })));
          await rows(writeSql.insertPlain(T, noteParams({ ...row, id: -3, dedupe_key: null })));
          await rows(writeSql.read(T, -1, -1));
          await rows(writeSql.readCoachNotes(T, -1));
          await rows(writeSql.readAll(T, -1));
          await rows(writeSql.tickOff(T, -1, [-1]));
          await rows(writeSql.reword(T, -1, -1, "preflight 3"));
          await rows(writeSql.drop(T, -1, "preflight:-1"));
          await rows(writeSql.delete(T, -1, -3));
          await rows(writeSql.clientDelete(T, -1));
          if ((await rows(writeSql.claimOp("preflight"))).length !== 1) throw new Error("an op's token could not be claimed");
          throw new RolledBack();
        });
      } catch (error) {
        if (error instanceof RolledBack) console.log("ok   the unique rule can be made, and every write statement runs (rolled back)");
        else fail(`with the unique rule: ${error instanceof Error ? error.message : error}`);
      }
    }
  } finally {
    await pool.end().catch(() => {});
  }
  console.log(failed ? "NOT READY" : withUnique ? "READY" : "READY (reads; run again with --with-unique at the night for the writes)");
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
