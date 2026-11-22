-- Step 6, quest 10 (22 Nov, docs/database-plan.md, the logged sets' item; Alex: "move cardio as well"): what the sets
-- door's queries need once the cardio ticks (cardio_logs) leave memory with the sets (app/lib/sets/rows.ts): a tick by its
-- entry and by its client, and the id sequences of the ticks and of the cardio entries they point at (taken only with
-- SETS_STORE=pg, pg/ids.ts). Nothing the app reads changes: the store still loads the ticks whole in memory mode. No
-- unique rule here: a SETS_STORE=pg boot makes it under the lease once its twins are moved out (into set_twins), and a
-- memory boot drops it (app/lib/sets/boot.ts), so a twin never blocks a memory-mode save. Every statement can run twice.
CREATE SEQUENCE IF NOT EXISTS "public"."cardio_entries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "public"."cardio_logs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cardio_logs_entry_idx" ON "cardio_logs" USING btree ("cardio_entry_id","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cardio_logs_client_idx" ON "cardio_logs" USING btree ("client_id","id");
