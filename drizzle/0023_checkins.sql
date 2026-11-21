-- Step 6, quest 9 (20 Nov, docs/database-plan.md): what the check-in figures' queries need once metric_entries and
-- check_in_notes leave memory (app/lib/checkins/rows.ts): a metric's figures by period ("C" order, so a day sorts as the
-- JS reading it does), its first typed figure, its few figures whose period is no day, a client's notes by kind and
-- period; the id sequences of the notes and of the metric definitions (taken only with CHECKINS_STORE=pg, pg/ids.ts); the
-- table the pg boot keeps rows aside in. Nothing the app reads changes: the store still loads both tables whole in memory
-- mode. No unique rule here: a CHECKINS_STORE=pg boot makes them under the lease once their twins are moved out, and a
-- memory boot drops them (app/lib/checkins/boot.ts), so a twin never blocks a memory-mode save. Every statement can run twice.
CREATE SEQUENCE IF NOT EXISTS "public"."check_in_notes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "public"."metric_definitions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "checkin_twins" (
	"tbl" text NOT NULL,
	"id" integer NOT NULL,
	"row" jsonb NOT NULL,
	"reason" text NOT NULL,
	"moved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checkin_twins_tbl_id_pk" PRIMARY KEY("tbl","id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "check_in_notes_client_idx" ON "check_in_notes" USING btree ("client_id","kind",(period COLLATE "C"),"id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "metric_entries_def_period_idx" ON "metric_entries" USING btree ("metric_definition_id",(period COLLATE "C"),"id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "metric_entries_logged_idx" ON "metric_entries" USING btree ("metric_definition_id","id") WHERE value IS NOT NULL AND (extra ->> 'source') IS DISTINCT FROM 'health';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "metric_entries_odd_period_idx" ON "metric_entries" USING btree ("metric_definition_id","id") WHERE period IS NULL OR period !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';