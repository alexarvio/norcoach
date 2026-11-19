// Two sends at once never post twice (Step 5's cut-over, 19 Nov review; the reactions are scripts/chat-shadow-race.mjs):
// the cut-over's own insert statement (app/lib/chat/statements.ts writeSql.insert, and writeSql.mealLock in the same
// transaction for a meal's comment) run from two connections at the same moment, 200 times each:
//   once key   the same once key from both: exactly one message and one key, the loser writing nothing;
//   meal       a meal's comment from both, each under the meal's lock: exactly one comment.
// For staging, against a real Postgres (pglite has one connection, so it can't race):
//   DATABASE_URL=postgres://… npx tsx scripts/chat-pg-race.ts
// It works on tables of its own, made like chat_messages and once_keys and dropped at the end (never the real ones, nor
// the shadow tables, whose compare would count a probe row).

import pg from "pg";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { writeSql, type ChatTable, type InsertParams, type OnceTable } from "../app/lib/chat/statements";

const url = process.env.DATABASE_URL;
if (!url || !url.startsWith("postgres")) {
  console.error("DATABASE_URL must be a postgres:// URL (staging).");
  process.exit(2);
}
const ROUNDS = Number(process.env.ROUNDS) || 200;
// The probe tables, passed where the statements take a table's name (they are made like the real ones).
const MSG = "chat_race_messages" as unknown as ChatTable;
const ONCE = "chat_race_once" as unknown as OnceTable;
const CLIENT = -424242;

const params = (id: number, once: string | null, meal: { date: string; meal: string } | null): InsertParams => {
  const now = new Date().toISOString();
  return {
    id,
    client_id: CLIENT,
    sender: meal ? "coach" : "client",
    text: `race ${id}`,
    media_path: null,
    media_type: null,
    created_at: now,
    extra: meal ? JSON.stringify({ link: { kind: "food", date: meal.date, meal: meal.meal } }) : null,
    replyTo: null,
    createdAtTz: now,
    once: once ? { key: once, at: Date.now(), extra: null, createdAt: now, result: null } : null,
    meal,
  };
};

async function main() {
  const a = new pg.Client({ connectionString: url, application_name: "norcoach-chat-race-a" });
  const b = new pg.Client({ connectionString: url, application_name: "norcoach-chat-race-b" });
  await a.connect();
  await b.connect();
  const da = drizzle(a);
  const db = drizzle(b);
  const lost: string[] = [];
  try {
    await a.query(`DROP TABLE IF EXISTS chat_race_messages; DROP TABLE IF EXISTS chat_race_once`);
    await a.query(`CREATE TABLE chat_race_messages (LIKE chat_messages INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)`);
    await a.query(`CREATE TABLE chat_race_once (LIKE once_keys INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)`);
    let id = 1;
    for (let i = 0; i < ROUNDS; i++) {
      // The once key: A holds its insert open a moment; B's, started meanwhile, waits on the key, then writes nothing.
      const key = `chat${CLIENT}:race-key-${i}`;
      const pa = params(id++, key, null);
      const pb = params(id++, key, null);
      const first = (async () => {
        await a.query("BEGIN");
        const got = await da.execute(writeSql.insert(MSG, ONCE, pa));
        await a.query("SELECT pg_sleep(0.02)");
        await a.query("COMMIT");
        return got.rows.length;
      })();
      await new Promise((r) => setTimeout(r, 5));
      const second = db.execute(writeSql.insert(MSG, ONCE, pb)).then((r) => r.rows.length);
      const [na, nb] = await Promise.all([first, second]);
      const rows = (await a.query(`SELECT count(*)::int AS n FROM chat_race_messages WHERE id = ANY($1::int[])`, [[pa.id, pb.id]])).rows[0].n;
      const keys = (await a.query(`SELECT count(*)::int AS n FROM chat_race_once WHERE key = $1`, [key])).rows[0].n;
      if (na + nb !== 1 || rows !== 1 || keys !== 1) lost.push(`once round ${i}: answered ${na}+${nb}, ${rows} messages, ${keys} keys`);

      // The meal: both under the meal's lock in their own transaction, as rows.ts runs it.
      const meal = { date: "2000-01-01", meal: `m${i}` };
      const ma = params(id++, null, meal);
      const mb = params(id++, null, meal);
      const one = da.transaction(async (tx) => {
        await tx.execute(writeSql.mealLock(CLIENT, meal.date, meal.meal));
        const got = await tx.execute(writeSql.insert(MSG, ONCE, ma));
        // Held open a moment, so the other's lock waits on this transaction and its insert must see this comment.
        await tx.execute(sql`SELECT pg_sleep(0.02)`);
        return got.rows.length;
      });
      const two = (async () => {
        await new Promise((r) => setTimeout(r, 2));
        return db.transaction(async (tx) => {
          await tx.execute(writeSql.mealLock(CLIENT, meal.date, meal.meal));
          return (await tx.execute(writeSql.insert(MSG, ONCE, mb))).rows.length;
        });
      })();
      const [m1, m2] = await Promise.all([one, two]);
      const comments = (await a.query(`SELECT count(*)::int AS n FROM chat_race_messages WHERE id = ANY($1::int[])`, [[ma.id, mb.id]])).rows[0].n;
      if (m1 + m2 !== 1 || comments !== 1) lost.push(`meal round ${i}: answered ${m1}+${m2}, ${comments} comments`);
    }
  } finally {
    await a.query(`DROP TABLE IF EXISTS chat_race_messages; DROP TABLE IF EXISTS chat_race_once`).catch(() => {});
    await a.end();
    await b.end();
  }
  for (const l of lost.slice(0, 20)) console.error(l);
  console.log(lost.length ? `${lost.length} of ${ROUNDS * 2} rounds went wrong` : `ok: ${ROUNDS} rounds of each, one message and one comment every time`);
  process.exit(lost.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
