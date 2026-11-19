// The food diary's cut-over checks, run ahead on the night's database (quest 8 part 1, Step 6 of docs/database-plan.md,
// before FOOD_STORE=pg is set), so a refused boot is found while the live build still serves:
//   TZ=Europe/Amsterdam DATABASE_URL=postgres://… npx tsx scripts/food-preflight.ts [--with-unique]
// Read only: what migration 0021 makes (app/lib/food/boot.ts foodProblems), then the night's pre-checks: P1 each table's
// count and highest id; P2 calorie_logs twins on (client, day) (the boot moves them, the client's own figure, then the lowest id, kept); P3 food_days
// and meal_photos twins on their day keys (counted only: no unique rule is planned for them); P4 entries whose kcal or
// macros are absent, null or not a number; P6 pictures outside their client's /uploads/meals/<client>/ folder; P7
// saved_meal_id stamps that are not a whole number, or point at no saved meal; P8 rows of no client (counted); P9 kv keys
// named like a food table.
// --with-unique makes the unique rule on calorie_logs inside a transaction rolled back (it fails, and says so, while twins
// are there). It never changes a row, and starts no store or writer.

import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { foodProblems, FOOD_CALORIE_UNIQUE } from "../app/lib/food/boot";
import { FOOD_TABLES } from "../app/lib/food/mode";

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
  const pool = new pg.Pool({ connectionString: url, max: 2, application_name: "norcoach-food-preflight" });
  let failed = false;
  const fail = (what: string) => {
    failed = true;
    console.error(`FAIL ${what}`);
  };
  try {
    const db = drizzle(pool);
    const any = db as never;
    const rows = async (q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as { rows: Row[] }).rows;
    for (const p of await foodProblems(any, { unique: false })) fail(p);
    // P1
    for (const t of FOOD_TABLES) {
      const r = (await rows(sql.raw(`SELECT count(*)::int AS n, COALESCE(max(id), 0)::int AS m FROM "${t}"`)))[0];
      console.log(`P1 ${t}: ${r.n} rows, max id ${r.m}`);
    }
    // P2
    const twins = (await rows(sql`SELECT count(*)::int AS n FROM (SELECT client_id, date FROM calorie_logs GROUP BY client_id, date HAVING count(*) > 1) x`))[0];
    console.log(`P2 calorie_logs twins on (client, day): ${twins.n} keys (the pg boot keeps one of each, the client's own figure before the phone's then the lowest id, and moves the rest to food_twins)`);
    // P3
    for (const [t, key] of [
      ["food_days", "client_id, date"],
      ["meal_photos", "client_id, date, meal"],
    ]) {
      const r = (await rows(sql.raw(`SELECT count(*)::int AS n FROM (SELECT 1 FROM "${t}" GROUP BY ${key} HAVING count(*) > 1) x`)))[0];
      console.log(`P3 ${t} twins on (${key}): ${r.n} keys (counted only)`);
    }
    // P4
    const p4 = (await rows(sql`SELECT count(*)::int AS n FROM food_entries WHERE kcal IS NULL OR protein IS NULL OR carbs IS NULL OR fat IS NULL OR kcal = 'NaN'::float8`))[0];
    console.log(`P4 entries with a figure absent, null or NaN: ${p4.n}`);
    // P6
    const p6 = (await rows(sql`SELECT
        (SELECT count(*)::int FROM meal_photos WHERE file_path IS NOT NULL AND file_path NOT LIKE '/uploads/meals/' || client_id || '/%') AS photos,
        (SELECT count(*)::int FROM saved_meals WHERE extra->>'picture' IS NOT NULL AND extra->>'picture' NOT LIKE '/uploads/meals/' || client_id || '/%') AS saved,
        (SELECT count(*)::int FROM saved_days d WHERE (extra->>'picture' IS NOT NULL AND extra->>'picture' NOT LIKE '/uploads/meals/' || client_id || '/%')
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(d.extra->'cards') = 'array' THEN d.extra->'cards' ELSE '[]'::jsonb END) c
                     WHERE c->>'picture' IS NOT NULL AND c->>'picture' NOT LIKE '/uploads/meals/' || d.client_id || '/%')) AS days`))[0];
    // A saved day's picture outside its client's folder matters: the pg write's picture clean-up looks for a file's saved
    // days among its own client's alone (rows.ts unusedPictures), so such a file could be trashed while another shows it.
    if (p6.days) fail(`P6 ${p6.days} saved days show a picture outside their client's folder`);
    console.log(`P6 pictures outside their client's folder: ${p6.photos} day photos, ${p6.saved} saved meals, ${p6.days} saved days`);
    // P7
    const p7 = (await rows(sql`SELECT
        count(*) FILTER (WHERE extra ? 'saved_meal_id' AND jsonb_typeof(extra->'saved_meal_id') <> 'number' AND jsonb_typeof(extra->'saved_meal_id') <> 'null')::int AS odd,
        count(*) FILTER (WHERE jsonb_typeof(extra->'saved_meal_id') = 'number' AND NOT EXISTS (SELECT 1 FROM saved_meals s WHERE s.id = (e.extra->>'saved_meal_id')::numeric))::int AS dangling
      FROM food_entries e`))[0];
    console.log(`P7 saved_meal_id: ${p7.odd} not a number, ${p7.dangling} pointing at no saved meal (kept as they are; read as no link)`);
    // P8: rows whose client is gone (an erase's write that committed between its sweeps, the reset's clients): counted only.
    for (const t of FOOD_TABLES) {
      const r = (await rows(sql.raw(`SELECT count(*)::int AS n FROM "${t}" f WHERE f.client_id IS NULL OR NOT EXISTS (SELECT 1 FROM clients c WHERE c.id = f.client_id)`)))[0];
      if (r.n) console.log(`P8 ${t}: ${r.n} rows of no client (kept; the backup's JSON keeps them whole)`);
    }
    // P9
    const p9 = await rows(sql`SELECT key FROM kv WHERE key IN (SELECT jsonb_array_elements_text(${JSON.stringify(FOOD_TABLES)}::jsonb))`);
    if (p9.length) fail(`P9 kv holds keys named like food tables: ${p9.map((r) => String(r.key)).join(", ")}`);
    else console.log("P9 kv: no key named like a food table");
    if (withUnique) {
      try {
        await db.transaction(async (tx) => {
          await tx.execute(sql.raw(`CREATE UNIQUE INDEX "${FOOD_CALORIE_UNIQUE}_preflight" ON "calorie_logs" ("client_id", "date")`));
          throw new RolledBack();
        });
      } catch (error) {
        if (!(error instanceof RolledBack)) fail(`the unique rule can't be made yet (twins still there?): ${error instanceof Error ? error.message.split("\n")[0] : error}`);
        else console.log("unique rule: can be made (rolled back)");
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
