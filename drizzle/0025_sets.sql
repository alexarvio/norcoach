-- Step 6, quest 10 (22 Nov, docs/database-plan.md, the logged sets' item; the Archive Campaign's quest 9 and last): what
-- the sets door's queries need once the sets leave memory (app/lib/sets/rows.ts): each set's client (set_logs.client_id,
-- its row's day's as memory holds them: one probe a client, not one a row), the indexes the fetches read, and the table a
-- SETS_STORE=pg boot keeps twins in (set_twins). Nothing the app reads changes: the column is filled by the writer
-- (pg/schema.ts DERIVED) and put right at boot (store.ts derivedStale, repairDerivedPg), never loaded back. The column is
-- filled before the indexes are built. No unique rule here: a memory boot runs this file, and the rule is a pg boot's
-- (sets/boot.ts), made under the lease after its twin pass. Every statement can run twice.
CREATE TABLE IF NOT EXISTS "set_twins" (
	"tbl" text NOT NULL,
	"id" integer NOT NULL,
	"row" jsonb NOT NULL,
	"reason" text NOT NULL,
	"moved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "set_twins_tbl_id_pk" PRIMARY KEY("tbl","id")
);
--> statement-breakpoint
ALTER TABLE "set_logs" ADD COLUMN IF NOT EXISTS "client_id" integer;--> statement-breakpoint
UPDATE "set_logs" s SET "client_id" = d."client_id" FROM "workout_assignments" w JOIN "program_days" d ON d."id" = w."program_day_id" WHERE w."id" = s."workout_assignment_id" AND s."client_id" IS DISTINCT FROM d."client_id";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "set_logs_assignment_idx" ON "set_logs" USING btree ("workout_assignment_id","set_number","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "set_logs_client_idx" ON "set_logs" USING btree ("client_id","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "set_logs_client_row_idx" ON "set_logs" USING btree ("client_id","workout_assignment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "set_logs_client_tz_idx" ON "set_logs" USING btree ("client_id","logged_at_tz","id") WHERE logged_at_tz IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "set_logs_odd_idx" ON "set_logs" USING btree ("client_id","id") WHERE ((extra ? 'logged_at') OR ((logged_at IS NOT NULL AND logged_at <> '') AND (logged_at_tz IS NULL OR NOT (logged_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$' OR logged_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?(Z|[+-][0-9]{2}:[0-9]{2})$'))));
