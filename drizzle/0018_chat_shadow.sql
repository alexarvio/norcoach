-- Step 5, sub-steps 1-3 (18 Nov, docs/database-plan.md): what the chat's queries will need once chat leaves memory,
-- and the shadow tables the new write statements run on meanwhile (app/lib/chat/statements.ts, shadow.ts). Nothing
-- the app reads changes: the store still loads chat_messages whole; these indexes and functions are only used by the
-- shadow's own queries until the cut-over. Every statement can run twice.
--
-- norcoach_js_trim / norcoach_has_words: JavaScript's trim() as SQL (ECMAScript WhiteSpace and LineTerminator exactly,
-- no U+0085, no U+180E; app/lib/chat/pick.ts JS_SPACE), so "a message with words or a file" reads the same both ways.
CREATE OR REPLACE FUNCTION norcoach_js_trim(t text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$ SELECT btrim(t, E'\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF') $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION norcoach_has_words(t text, media text) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$ SELECT COALESCE(media, '') <> '' OR norcoach_js_trim(COALESCE(t, '')) <> '' $$;--> statement-breakpoint
-- One side's reaction set or taken off (emoji NULL), as setChatReaction does it (app/lib/chat/rows.ts setReaction): no
-- reactions left drops the key, an empty extra is NULL. Used in one UPDATE, so two people reacting at once keep both.
CREATE OR REPLACE FUNCTION norcoach_react(e jsonb, who text, emoji text) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT NULLIF(CASE WHEN nx = '{}'::jsonb THEN b - 'reactions' ELSE jsonb_set(b, '{reactions}', nx) END, '{}'::jsonb)
  FROM (SELECT b, (CASE WHEN jsonb_typeof(b -> 'reactions') = 'object' THEN b -> 'reactions' ELSE '{}'::jsonb END - who)
                 || CASE WHEN emoji IS NULL THEN '{}'::jsonb ELSE jsonb_build_object(who, emoji) END AS nx
        FROM (SELECT COALESCE(e, '{}'::jsonb) AS b) s) r $$;--> statement-breakpoint
-- A column the row now holds (store.ts toRecord): its field out of extra and out of __absent, __absent dropped when it
-- is left empty, an empty extra NULL.
CREATE OR REPLACE FUNCTION norcoach_column_set(e jsonb, field text) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT NULLIF(CASE WHEN jsonb_typeof(b -> '__absent') = 'array' THEN
           CASE WHEN jsonb_array_length((b -> '__absent') - field) = 0 THEN (b - field) - '__absent'
                ELSE jsonb_set(b - field, '{__absent}', (b -> '__absent') - field) END
         ELSE b - field END, '{}'::jsonb)
  FROM (SELECT COALESCE(e, '{}'::jsonb) AS b) s $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_messages_shadow" (
	"id" integer PRIMARY KEY NOT NULL,
	"client_id" integer,
	"sender" text,
	"text" text,
	"media_path" text,
	"media_type" text,
	"created_at" text,
	"extra" jsonb,
	"created_at_tz" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "once_keys_shadow" (
	"key" text PRIMARY KEY NOT NULL,
	"at" double precision,
	"result" jsonb,
	"redirect" text,
	"extra" jsonb,
	"created_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_messages_shadow_client_id_idx" ON "chat_messages_shadow" USING btree ("client_id","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_messages_shadow_media_path_idx" ON "chat_messages_shadow" USING btree ("media_path");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_messages_client_id_idx" ON "chat_messages" USING btree ("client_id","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_messages_client_sent_idx" ON "chat_messages" USING btree ("client_id","created_at_tz") WHERE sender = 'client';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_messages_client_text_idx" ON "chat_messages" USING btree ("client_id",(created_at COLLATE "C") DESC,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_messages_coach_last_idx" ON "chat_messages" USING btree ("client_id","created_at_tz" DESC NULLS LAST,"id") WHERE sender = 'coach';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_messages_media_path_idx" ON "chat_messages" USING btree ("media_path") WHERE "chat_messages"."media_path" IS NOT NULL;
