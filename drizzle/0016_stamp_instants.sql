-- Step 4C (18 Nov, docs/database-plan.md): a real instant beside each text stamp later queries will filter and sort on
-- (app/lib/pg/stamps.ts). norcoach_stamp reads a stamp as the app's stampMs does: "YYYY-MM-DD HH:MM:SS" (and an ISO
-- date-time with no zone) is Europe/Amsterdam wall time, the hour that comes twice in autumn the earlier of the two and
-- the hour skipped in spring with the offset before it; an ISO date-time with a zone is that instant; a date alone is
-- UTC midnight; anything else, or a stamp that can't be read, NULL (never an error, so the migration can't fail on a
-- row). The writer fills the columns from then on; the boot writes again any row whose column differs from the JS rule.
ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "created_at_tz" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "coach_activity" ADD COLUMN IF NOT EXISTS "created_at_tz" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "food_entries" ADD COLUMN IF NOT EXISTS "logged_at_tz" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "metric_entries" ADD COLUMN IF NOT EXISTS "logged_at_tz" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "set_logs" ADD COLUMN IF NOT EXISTS "logged_at_tz" timestamp with time zone;--> statement-breakpoint
CREATE OR REPLACE FUNCTION norcoach_stamp(stamp text) RETURNS timestamp with time zone
LANGUAGE plpgsql STABLE AS $fn$
DECLARE
  part text[];
  wall timestamp;
  instant timestamp with time zone;
BEGIN
  IF stamp IS NULL THEN
    RETURN NULL;
  ELSIF stamp ~ '^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?$' THEN
    -- Field by field, as Date.UTC(y, m - 1, d, h, mi, s) counts them: a 31 Nov rolls on to 1 Dec rather than failing.
    part := regexp_match(stamp, '^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?$');
    -- And a year 0 to 99 is 1900 to 1999, as Date.UTC and new Date(y, …) read it.
    wall := make_timestamp(part[1]::int + CASE WHEN part[1]::int < 100 THEN 1900 ELSE 0 END, 1, 1, 0, 0, 0)
      + make_interval(months => part[2]::int - 1, days => part[3]::int - 1, hours => part[4]::int, mins => part[5]::int,
                      secs => COALESCE(part[6], '0')::int + trunc(COALESCE(('0' || part[7])::numeric, 0), 3));
    instant := wall AT TIME ZONE 'Europe/Amsterdam';
    -- Postgres takes the later of an autumn hour's two readings, JavaScript the earlier.
    IF ((instant - interval '1 hour') AT TIME ZONE 'Europe/Amsterdam') = wall THEN
      instant := instant - interval '1 hour';
    END IF;
    instant := date_trunc('milliseconds', instant);
  ELSIF stamp ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$' THEN
    instant := date_trunc('milliseconds', stamp::timestamp with time zone);
  ELSIF stamp ~ '^\d{4}-\d{2}-\d{2}$' THEN
    instant := (stamp || 'T00:00:00Z')::timestamp with time zone;
  ELSE
    RETURN NULL;
  END IF;
  -- Years 0001 to 9999 in UTC, as stamps.ts keeps them (the writer's ISO text can't say a year before 1 or past 9999).
  IF instant < '0001-01-01T00:00:00Z'::timestamp with time zone OR instant >= '10000-01-01T00:00:00Z'::timestamp with time zone THEN
    RETURN NULL;
  END IF;
  RETURN instant;
EXCEPTION WHEN others THEN
  RETURN NULL;
END
$fn$;--> statement-breakpoint
UPDATE "chat_messages" SET "created_at_tz" = norcoach_stamp("created_at") WHERE "created_at_tz" IS DISTINCT FROM norcoach_stamp("created_at");--> statement-breakpoint
UPDATE "coach_activity" SET "created_at_tz" = norcoach_stamp("created_at") WHERE "created_at_tz" IS DISTINCT FROM norcoach_stamp("created_at");--> statement-breakpoint
UPDATE "food_entries" SET "logged_at_tz" = norcoach_stamp("logged_at") WHERE "logged_at_tz" IS DISTINCT FROM norcoach_stamp("logged_at");--> statement-breakpoint
UPDATE "metric_entries" SET "logged_at_tz" = norcoach_stamp("logged_at") WHERE "logged_at_tz" IS DISTINCT FROM norcoach_stamp("logged_at");--> statement-breakpoint
UPDATE "set_logs" SET "logged_at_tz" = norcoach_stamp("logged_at") WHERE "logged_at_tz" IS DISTINCT FROM norcoach_stamp("logged_at");
