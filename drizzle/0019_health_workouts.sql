-- Step 6, first item (19 Nov, docs/database-plan.md): the phone's workouts in a table of their own, keyed as the sync
-- matches them (client, store, the store's own id). Still in memory and written row by row by the store; kv's
-- "health_workouts" stays as the copy a rollback reads, and every boot makes the table that copy (app/lib/pg/healthWorkouts.ts),
-- so this copies no data. Builds before this ignore the table and the sequence. Every statement can run twice.
CREATE SEQUENCE IF NOT EXISTS "public"."health_workouts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "health_workouts" (
	"id" integer,
	"client_id" integer NOT NULL,
	"store" text NOT NULL,
	"platform_id" text NOT NULL,
	"type" text,
	"start" text,
	"end" text,
	"seconds" double precision,
	"kcal" double precision,
	"meters" double precision,
	"source" text,
	"synced_at" text,
	"extra" jsonb,
	CONSTRAINT "health_workouts_client_id_store_platform_id_pk" PRIMARY KEY("client_id","store","platform_id")
);
