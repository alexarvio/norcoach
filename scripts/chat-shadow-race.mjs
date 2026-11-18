// Two people reacting at once never lose one (18 Nov, Step 5 of docs/database-plan.md): the cut-over's reaction
// statement (app/lib/chat/statements.ts writeSql.react, norcoach_react in drizzle/0018_chat_shadow.sql) run from two
// connections at the same moment on one row, 200 times; both reactions must be there every time.
// For staging, against a real Postgres (pglite has one connection, so it can't race):
//   DATABASE_URL=postgres://… node scripts/chat-shadow-race.mjs
// It works on a table of its own, chat_race_probe (made and dropped here), with chat_messages' `extra` column: never
// chat_messages, and never chat_messages_shadow, whose 10-minute compare with the real table would count a probe row
// as a write round the door and resync it away mid-race (a false difference in the shadow week's totals).

import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url || !url.startsWith("postgres")) {
  console.error("DATABASE_URL must be a postgres:// URL (staging).");
  process.exit(2);
}
const ID = -424242;
const ROUNDS = Number(process.env.ROUNDS) || 200;
const REACT = `UPDATE chat_race_probe SET extra = norcoach_react(extra, $2::text, $3::text) WHERE id = $1::int RETURNING id`;

const a = new pg.Client({ connectionString: url, application_name: "norcoach-chat-race-a" });
const b = new pg.Client({ connectionString: url, application_name: "norcoach-chat-race-b" });
await a.connect();
await b.connect();
let lost = 0;
try {
  const exists = await a.query(`SELECT to_regproc('norcoach_react') AS f`);
  if (!exists.rows[0].f) throw new Error("norcoach_react is missing: is migration 0018 applied?");
  await a.query(`CREATE TABLE IF NOT EXISTS chat_race_probe (id integer PRIMARY KEY, extra jsonb)`);
  await a.query(`DELETE FROM chat_race_probe WHERE id = $1`, [ID]);
  await a.query(`INSERT INTO chat_race_probe (id) VALUES ($1)`, [ID]);
  for (let i = 0; i < ROUNDS; i++) {
    await a.query(`UPDATE chat_race_probe SET extra = $2::jsonb WHERE id = $1`, [ID, i % 3 === 0 ? null : JSON.stringify({ pinned: true })]);
    // A holds the row a moment inside its transaction; B's statement starts meanwhile, waits on the lock, and must read
    // A's committed version when it goes (EvalPlanQual), not the one it saw when it started.
    const first = (async () => {
      await a.query("BEGIN");
      await a.query(REACT, [ID, "coach", "👍"]);
      await a.query("SELECT pg_sleep(0.02)");
      await a.query("COMMIT");
    })();
    await new Promise((r) => setTimeout(r, 5));
    const second = b.query(REACT, [ID, "client", "❤️"]);
    await Promise.all([first, second]);
    const { rows } = await a.query(`SELECT extra FROM chat_race_probe WHERE id = $1`, [ID]);
    const r = rows[0]?.extra?.reactions ?? {};
    if (r.coach !== "👍" || r.client !== "❤️") {
      lost++;
      console.error(`round ${i}: lost a reaction`, JSON.stringify(rows[0]?.extra));
    }
  }
} finally {
  await a.query(`DROP TABLE IF EXISTS chat_race_probe`).catch(() => {});
  await a.end();
  await b.end();
}
console.log(lost ? `${lost} of ${ROUNDS} rounds lost a reaction` : `ok: ${ROUNDS} rounds, both reactions kept every time`);
process.exit(lost ? 1 : 0);
