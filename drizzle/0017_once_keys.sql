-- Step 4B (18 Nov, docs/database-plan.md): the saves taken once (app/lib/once.ts) in a table of their own, filled from
-- kv's "once_keys" list exactly as the app's mapping writes a row (app/lib/pg/onceKeys.ts, ONCE_KEYS_FROM_KV: the same
-- statement). The kv list stays: it is the copy a rollback reads, and the boot takes the table from it each start.
CREATE TABLE IF NOT EXISTS "once_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"at" double precision,
	"result" jsonb,
	"redirect" text,
	"extra" jsonb,
	"created_at" timestamp with time zone
);--> statement-breakpoint
INSERT INTO "once_keys" ("key", "at", "result", "redirect", "extra", "created_at")
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
ON CONFLICT ("key") DO NOTHING;
