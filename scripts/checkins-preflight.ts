// The check-in figures' cut-over checks, run ahead on the night's database (quest 9, Step 6 of docs/database-plan.md,
// before CHECKINS_STORE=pg is set), so a refused boot is found while the live build still serves:
//   TZ=Europe/Amsterdam DATABASE_URL=postgres://… npx tsx scripts/checkins-preflight.ts [--with-unique]
// Read only: what migration 0023 makes (app/lib/checkins/boot.ts checkInsProblems), then the night's pre-checks: P1 each
// table's count and highest id, against `_seq`; P2 figure twins on (metric, period) and which row the rule keeps; P3
// note twins on (client, kind, period); P4 figures of no metric and notes of no client (counted, never moved); P5 periods
// that are no day, or hold a NUL, a lone surrogate or non-ASCII; P6 logged_at's formats; P7 step counts over 200,000 (the
// pg boot keeps them aside, as memory drops them); P8 `extra` keys other than source and __absent; P9 kv keys named like
// the tables; P10 metric twins the merge would merge (after the one-time rename); P11 kv's tombstones; P12 the metric
// definitions' sequence against MAX(id) and `_seq`. --with-unique makes both unique rules inside a transaction rolled
// back (they fail, and say so, while twins are there). It never changes a row, and starts no store or writer.

import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { checkInsProblems, CHECKINS_ENTRY_UNIQUE, CHECKINS_NOTE_UNIQUE } from "../app/lib/checkins/boot";
import { CHECKINS_REMOVING, CHECKINS_TABLES } from "../app/lib/checkins/mode";

if (!process.env.TZ) process.env.TZ = "Europe/Amsterdam";
const url = process.env.DATABASE_URL;
if (!url || !url.startsWith("postgres")) {
  console.error("DATABASE_URL must be a postgres:// URL.");
  process.exit(2);
}
const withUnique = process.argv.includes("--with-unique");
class RolledBack extends Error {}
type Row = Record<string, unknown>;
const DAY = "^[0-9]{4}-[0-9]{2}-[0-9]{2}$";

async function main() {
  const pool = new pg.Pool({ connectionString: url, max: 2, application_name: "norcoach-checkins-preflight" });
  let failed = false;
  const fail = (what: string) => {
    failed = true;
    console.error(`FAIL ${what}`);
  };
  try {
    const db = drizzle(pool);
    const any = db as never;
    const rows = async (q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as { rows: Row[] }).rows;
    for (const p of await checkInsProblems(any, { unique: false })) fail(p);
    const seq = ((await rows(sql`SELECT value FROM kv WHERE key = '_seq'`))[0]?.value ?? {}) as Record<string, number>;
    // P1
    for (const t of [...CHECKINS_TABLES, "metric_definitions"]) {
      const r = (await rows(sql.raw(`SELECT count(*)::int AS n, COALESCE(max(id), 0)::int AS m FROM "${t}"`)))[0];
      console.log(`P1 ${t}: ${r.n} rows, max id ${r.m}, _seq ${seq[t] ?? "none"}${Number(seq[t] ?? 0) < Number(r.m) ? " (behind: the boot raises it)" : ""}`);
    }
    // P2
    const p2 = (
      await rows(sql`WITH ranked AS (
          SELECT id, (COALESCE(extra->>'source', '') = 'health') AS phone, row_number() OVER (PARTITION BY metric_definition_id, period COLLATE "C" ORDER BY (COALESCE(extra->>'source', '') = 'health'), id) AS n,
                 count(*) OVER (PARTITION BY metric_definition_id, period COLLATE "C") AS c
          FROM metric_entries WHERE metric_definition_id IS NOT NULL AND period IS NOT NULL)
        SELECT count(*) FILTER (WHERE n = 1 AND c > 1)::int AS keys, count(*) FILTER (WHERE n > 1)::int AS moved,
               count(*) FILTER (WHERE n = 1 AND c > 1 AND phone)::int AS kept_phone FROM ranked`)
    )[0];
    console.log(`P2 figure twins on (metric, period): ${p2.keys} keys, ${p2.moved} rows the pg boot moves to checkin_twins (the client's own figure kept before the phone's, then the lowest id; ${p2.kept_phone} keys keep a phone figure: no typed one)`);
    // P3
    const p3 = (await rows(sql`SELECT count(*)::int AS keys, COALESCE(sum(c - 1), 0)::int AS moved FROM (SELECT count(*) AS c FROM check_in_notes WHERE client_id IS NOT NULL AND kind IS NOT NULL AND period IS NOT NULL GROUP BY client_id, kind, period COLLATE "C" HAVING count(*) > 1) x`))[0];
    console.log(`P3 note twins on (client, kind, period): ${p3.keys} keys, ${p3.moved} rows the pg boot moves (the lowest id kept)`);
    // P4
    const p4 = (
      await rows(sql`SELECT
        (SELECT count(*)::int FROM metric_entries e WHERE e.metric_definition_id IS NULL OR NOT EXISTS (SELECT 1 FROM metric_definitions d WHERE d.id = e.metric_definition_id)) AS figures,
        (SELECT count(*)::int FROM check_in_notes n WHERE n.client_id IS NULL OR NOT EXISTS (SELECT 1 FROM clients c WHERE c.id = n.client_id)) AS notes,
        (SELECT count(*)::int FROM metric_definitions d WHERE d.client_id IS NULL OR NOT EXISTS (SELECT 1 FROM clients c WHERE c.id = d.client_id)) AS defs`)
    )[0];
    console.log(`P4 orphans: ${p4.figures} figures of no metric, ${p4.notes} notes of no client, ${p4.defs} metrics of no client (kept where they are, invisible as before; the boot counts them)`);
    // P5
    const p5 = (
      await rows(sql`SELECT
        count(*) FILTER (WHERE period IS NULL)::int AS none,
        count(*) FILTER (WHERE period IS NOT NULL AND period !~ ${DAY}::text)::int AS odd,
        count(*) FILTER (WHERE period ~ '[^\x01-\x7f]')::int AS non_ascii,
        count(*) FILTER (WHERE period LIKE '%' || chr(65533) || '%')::int AS replaced
      FROM metric_entries`)
    )[0];
    const p5n = (await rows(sql`SELECT count(*) FILTER (WHERE period IS NULL OR period !~ ${DAY}::text)::int AS odd FROM check_in_notes`))[0];
    console.log(`P5 periods: figures ${p5.none} none, ${p5.odd} not a day, ${p5.non_ascii} non-ASCII (${p5.replaced} with a replaced character); notes ${p5n.odd} not a day (a NUL can't be stored: the writer took it out)`);
    // P6
    const p6 = (
      await rows(sql`SELECT
        count(*) FILTER (WHERE logged_at IS NULL)::int AS absent,
        count(*) FILTER (WHERE logged_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$')::int AS local,
        count(*) FILTER (WHERE logged_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T')::int AS iso,
        count(*) FILTER (WHERE logged_at IS NOT NULL AND logged_at_tz IS NULL)::int AS unreadable
      FROM metric_entries`)
    )[0];
    console.log(`P6 logged_at: ${p6.absent} absent, ${p6.local} local stamps, ${p6.iso} ISO, ${p6.unreadable} with no instant (unreadable)`);
    // P7
    const p7 = (await rows(sql`SELECT count(*)::int AS n FROM metric_entries e JOIN metric_definitions d ON d.id = e.metric_definition_id WHERE d.name ~* '\msteps?\M' AND e.value > 200000`))[0];
    console.log(`P7 step counts over 200,000: ${p7.n} (the pg boot keeps them aside in checkin_twins, as memory drops them)`);
    // P8
    const p8 = await rows(sql`SELECT k, count(*)::int AS n FROM metric_entries, jsonb_object_keys(CASE WHEN jsonb_typeof(extra) = 'object' THEN extra ELSE '{}'::jsonb END) AS k WHERE k NOT IN ('source', '__absent') GROUP BY k`);
    console.log(`P8 extra keys besides source and __absent: ${p8.length ? p8.map((r) => `${r.k} ${r.n}`).join(", ") : "none"}`);
    // P9
    const p9 = await rows(sql`SELECT key FROM kv WHERE key IN (SELECT jsonb_array_elements_text(${JSON.stringify([...CHECKINS_TABLES, "checkin_twins"])}::jsonb))`);
    if (p9.length) fail(`P9 kv holds keys named like check-in tables: ${p9.map((r) => String(r.key)).join(", ")}`);
    else console.log("P9 kv: no key named like a check-in table");
    // P10: what the merge would merge, the one-time rename applied first as prepareStore does.
    const p10 = (
      await rows(sql`SELECT count(*)::int AS groups, COALESCE(sum(c - 1), 0)::int AS twins FROM (
        SELECT count(*) AS c FROM metric_definitions
        GROUP BY client_id, COALESCE((extra->>'phase_id'), 'standing'), frequency,
                 lower(btrim(CASE WHEN name = 'Self satisfaction during the week' THEN 'Satisfaction with the week' ELSE name END)),
                 CASE WHEN extra->>'retired_at' IS NOT NULL THEN 'retired' ELSE 'live' END
        HAVING count(*) > 1) x`)
    )[0];
    console.log(`P10 metric twins the merge would merge: ${p10.groups} groups, ${p10.twins} definitions (their figures moved onto the keeper, the rest kept aside)`);
    // P11
    const p11 = (await rows(sql`SELECT value FROM kv WHERE key = ${CHECKINS_REMOVING}`))[0]?.value as Record<string, unknown> | undefined;
    console.log(`P11 removals left (tombstones): ${p11 ? Object.keys(p11).length : 0}`);
    // P12
    const p12 = (await rows(sql`SELECT (SELECT last_value FROM metric_definitions_id_seq)::int AS seq, (SELECT COALESCE(max(id), 0) FROM metric_definitions)::int AS m`).catch(() => [{ seq: null, m: null }]))[0];
    console.log(`P12 metric_definitions_id_seq ${p12.seq ?? "missing"}, max id ${p12.m}, _seq ${seq.metric_definitions ?? "none"} (the boot raises the sequence past both)`);
    if (withUnique) {
      for (const [name, table, on] of [
        [CHECKINS_ENTRY_UNIQUE, "metric_entries", `("metric_definition_id", "period" COLLATE "C")`],
        [CHECKINS_NOTE_UNIQUE, "check_in_notes", `("client_id", "kind", "period" COLLATE "C")`],
      ]) {
        try {
          await db.transaction(async (tx) => {
            await tx.execute(sql.raw(`CREATE UNIQUE INDEX "${name}_preflight" ON "${table}" ${on}`));
            throw new RolledBack();
          });
        } catch (error) {
          if (!(error instanceof RolledBack)) fail(`the unique rule on ${table} can't be made yet (twins still there? the boot moves them): ${error instanceof Error ? error.message.split("\n")[0] : error}`);
          else console.log(`unique rule on ${table}: can be made (rolled back)`);
        }
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
