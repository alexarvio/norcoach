import { sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { CHAT_ONCE_PREFIX_SQL, CHAT_PG } from "../chat/mode";

// The saves taken once (lib/once.ts) in a table of their own (18 Nov, step 4 of docs/database-plan.md, part B).
//
// once.ts works as before, on getData().once_keys; what changed is where the mirror keeps them: the `once_keys` table
// (schema.ts), written in the same transaction as the rows of the save that took the key, where they were one value
// in kv. So a later step that writes a row straight to Postgres can write its key in that transaction too, and a
// retry after a crash between the two can't add the row twice.
//
// For a rollback, the list is also still written whole to kv under "once_keys" in the same save (ROLLBACK_KV_COPIES):
// the builds before step 4 read it there, and keep knowing every key taken. Since the two are written together, the
// kv copy is the latest whichever build saved last; so at every boot, before the store loads, the table is made
// exactly that copy (a build before step 4 that ran meanwhile added and let go of keys only there). Migration 0017
// did the same once, when it made the table. Drop the copy and this step (step 5) once nothing writes a key
// straight to the table without it, and no rollback past step 4 is wanted.

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyDb = PgDatabase<any, any, any>;

/**
 * Every key of kv's "once_keys" list as a table row, exactly as store.ts's toRecord writes it: a field that is missing
 * or doesn't fit its column (a non-number `at`, a non-text `redirect`) is null with its name in extra.__absent and,
 * when it was there, its value in extra; any other field in extra. A row with no text key is left out (once.ts could
 * never match it). The same statement is in drizzle/0017_once_keys.sql.
 */
export const ONCE_KEYS_FROM_KV = `INSERT INTO "once_keys" ("key", "at", "result", "redirect", "extra", "created_at")
SELECT
  e->>'key',
  CASE WHEN jsonb_typeof(e->'at') = 'number' THEN (e->>'at')::double precision END,
  CASE WHEN e ? 'result' AND jsonb_typeof(e->'result') NOT IN ('null', 'string') THEN e->'result' END,
  CASE WHEN jsonb_typeof(e->'redirect') = 'string' THEN e->>'redirect' END,
  NULLIF(
    (e - 'key' - 'at' - 'result' - 'redirect')
    || CASE WHEN e ? 'at' AND jsonb_typeof(e->'at') NOT IN ('number', 'null') THEN jsonb_build_object('at', e->'at') ELSE '{}'::jsonb END
    || CASE WHEN jsonb_typeof(e->'result') = 'string' THEN jsonb_build_object('result', e->'result') ELSE '{}'::jsonb END
    || CASE WHEN e ? 'redirect' AND jsonb_typeof(e->'redirect') NOT IN ('string', 'null') THEN jsonb_build_object('redirect', e->'redirect') ELSE '{}'::jsonb END
    || COALESCE((
      SELECT jsonb_build_object('__absent', jsonb_agg(v.f ORDER BY v.o))
      FROM (VALUES
        (1, 'at', NOT (e ? 'at') OR jsonb_typeof(e->'at') NOT IN ('number', 'null')),
        (2, 'result', NOT (e ? 'result') OR jsonb_typeof(e->'result') = 'string'),
        (3, 'redirect', NOT (e ? 'redirect') OR jsonb_typeof(e->'redirect') NOT IN ('string', 'null'))
      ) AS v(o, f, absent)
      WHERE v.absent
      HAVING count(*) > 0
    ), '{}'::jsonb),
    '{}'::jsonb
  ),
  CASE WHEN jsonb_typeof(e->'at') = 'number' AND (e->>'at')::double precision BETWEEN -62135596800000 AND 253402300799999
    THEN to_timestamp(trunc((e->>'at')::double precision) / 1000.0) END
FROM "kv", jsonb_array_elements(CASE WHEN jsonb_typeof("kv"."value") = 'array' THEN "kv"."value" ELSE '[]'::jsonb END) AS e
WHERE "kv"."key" = 'once_keys' AND jsonb_typeof(e) = 'object' AND jsonb_typeof(e->'key') = 'string'
ON CONFLICT ("key") DO NOTHING`;

/**
 * Before the store loads: the table made exactly kv's copy, when there is one (see above). How many keys it holds
 * then, or null when kv has no copy and the table stays as it is.
 */
export async function onceKeysFromKvCopy(db: AnyDb): Promise<number | null> {
  return db.transaction(async (tx) => {
    // First, before kv is read (19 Nov review, as pg/healthWorkouts.ts): an instance still saving during a deploy (memory
    // mode never waits on the lease) can't write a key between the read and the delete, so an older copy never goes
    // over a newer key.
    await tx.execute(sql`LOCK TABLE "once_keys" IN EXCLUSIVE MODE`);
    const has = (await tx.execute(sql`SELECT 1 AS one FROM "kv" WHERE "key" = 'once_keys' AND jsonb_typeof("value") = 'array'`)) as { rows?: unknown[] };
    if (!(has.rows ?? []).length) return null;
    // With CHAT_STORE=pg (Step 5's cut-over) a chat insert writes its key straight to the table, in its own statement;
    // kv's copy has it only from the next save on, so a day of those keys is kept rather than replaced (a send retried
    // across a deploy is the outbox's usual case). kv's copy then fills in the rest, its own rows staying as they are.
    if (CHAT_PG) await tx.execute(sql`DELETE FROM "once_keys" WHERE NOT ("key" ~ ${CHAT_ONCE_PREFIX_SQL}::text AND "created_at" > now() - interval '1 day')`);
    else await tx.execute(sql`DELETE FROM "once_keys"`);
    await tx.execute(sql.raw(ONCE_KEYS_FROM_KV));
    const n = (await tx.execute(sql`SELECT count(*)::int AS n FROM "once_keys"`)) as { rows?: { n: number }[] };
    return Number(n.rows?.[0]?.n ?? 0);
  });
}
