-- Step 6, quest 7 (19 Nov, docs/database-plan.md): what the notifications' queries need once coach_activity leaves
-- memory (app/lib/notes/statements.ts), its shadow table, the table the pg boot keeps twins in, and the tokens of the
-- outbox's ops already written (so an op run twice does nothing; app/lib/notes/outbox.ts). Nothing the app reads
-- changes: the store still loads coach_activity whole. No unique rule on coach_activity here: a NOTES_STORE=pg boot
-- makes it under the lease, a memory boot drops it (app/lib/notes/boot.ts), so a twin never blocks a memory-mode save.
-- Keys and words are indexed by md5 (a btree row past ~2.7 kB would fail the store's save). Every statement can run twice.
CREATE TABLE IF NOT EXISTS "coach_activity_shadow" (
	"id" integer PRIMARY KEY NOT NULL,
	"client_id" integer,
	"message" text,
	"created_at" text,
	"kind" text,
	"read" boolean,
	"action_tab" text,
	"action_label" text,
	"action_ref" integer,
	"dedupe_key" text,
	"extra" jsonb,
	"created_at_tz" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "coach_activity_twins" (
	"id" integer PRIMARY KEY NOT NULL,
	"client_id" integer,
	"message" text,
	"created_at" text,
	"kind" text,
	"read" boolean,
	"action_tab" text,
	"action_label" text,
	"action_ref" integer,
	"dedupe_key" text,
	"extra" jsonb,
	"created_at_tz" timestamp with time zone,
	"removed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "coach_activity_shadow_dedupe_uq" ON "coach_activity_shadow" USING btree ("client_id",md5(dedupe_key)) WHERE dedupe_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "coach_activity_shadow_client_idx" ON "coach_activity_shadow" USING btree ("client_id","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "coach_activity_client_text_idx" ON "coach_activity" USING btree ("client_id",(created_at COLLATE "C") DESC,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "coach_activity_client_key_idx" ON "coach_activity" USING btree ("client_id",md5(dedupe_key),"id") WHERE dedupe_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "coach_activity_unread_reminder_idx" ON "coach_activity" USING btree ("client_id","id") WHERE kind = 'reminder' AND read IS NOT TRUE;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "coach_activity_message_idx" ON "coach_activity" USING btree ("client_id",(extra ->> 'message_id')) WHERE kind = 'coach_note';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "coach_activity_note_words_idx" ON "coach_activity" USING btree ("client_id",md5(message)) WHERE kind = 'coach_note';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "coach_activity_ops" (
	"token" text PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" text
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "coach_activity_ops_at_idx" ON "coach_activity_ops" USING btree ("at");
