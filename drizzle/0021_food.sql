-- Step 6, quest 8 part 1 (19 Nov, docs/database-plan.md): what the food diary's queries need once its seven tables leave
-- memory (app/lib/food/rows.ts): a client's days, a meal's rows, a picture's rows by file; the saved days' id sequence;
-- the write tokens; the table the pg boot keeps twins in. Nothing the app reads changes: the store still loads the seven
-- tables whole in memory mode. No unique rule on calorie_logs (client_id, date) here: a FOOD_STORE=pg boot makes it under
-- the lease once its twins are moved out, and a memory boot drops it (app/lib/food/boot.ts), so a twin never blocks a
-- memory-mode save. Every statement can run twice.
CREATE SEQUENCE IF NOT EXISTS "public"."saved_days_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "food_ops" (
	"token" text PRIMARY KEY NOT NULL,
	"op" text NOT NULL,
	"client_id" integer,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"after" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "food_twins" (
	"tbl" text NOT NULL,
	"id" integer NOT NULL,
	"row" jsonb NOT NULL,
	"removed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "food_twins_tbl_id_pk" PRIMARY KEY("tbl","id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "food_ops_at_idx" ON "food_ops" USING btree ("at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calorie_logs_client_date_idx" ON "calorie_logs" USING btree ("client_id","date","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "food_days_client_date_idx" ON "food_days" USING btree ("client_id","date","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "food_entries_client_date_idx" ON "food_entries" USING btree ("client_id","date","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "food_entries_client_meal_idx" ON "food_entries" USING btree ("client_id","meal","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "food_meals_client_idx" ON "food_meals" USING btree ("client_id","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "meal_photos_client_date_idx" ON "meal_photos" USING btree ("client_id","date","meal","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "meal_photos_path_idx" ON "meal_photos" USING btree ("file_path");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "saved_days_client_idx" ON "saved_days" USING btree ("client_id","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "saved_meals_client_idx" ON "saved_meals" USING btree ("client_id","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "saved_meals_picture_idx" ON "saved_meals" USING btree ((extra ->> 'picture')) WHERE (extra ->> 'picture') IS NOT NULL;
