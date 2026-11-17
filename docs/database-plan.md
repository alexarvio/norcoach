# Moving Norcoach onto its database properly (plan, 17 Nov 2026)

Status: proposed, not started. Written from a read-only investigation of the code, then checked by an adversarial review; the review's fixes are folded in below.

## How it works today

- At start-up the server loads every table from Postgres into its memory (`app/lib/pg/runtime.ts`, `store.ts`), and every screen reads that copy (`getData()`, ~690 call sites, all synchronous).
- Each save compares the whole copy with the last one written and sends the changed rows to Postgres in one transaction, in the background (`persist()` is fire-and-forget; only the workout outbox waits).
- Ids are counted in memory (`_seq`), not by Postgres.
- Only `push_subscriptions` and `password_resets` are read from Postgres directly.

What that means as coaches sign up:
- **Memory**: the heap is capped at 768 MB; the estimate is room for roughly 25–35 client-years of full use.
- **Speed**: every save stringifies every row to find what changed, on the server's one thread; it grows with the data. A few jobs re-read every client on every page view (client reminders run inside the root layout).
- **One server only**: two servers would hand out the same ids and overwrite each other's rows. The attached `/data` volume is what stops Railway overlapping deploys today.
- **Safety gaps**: a failed save is not retried until something else saves; a deploy can cut off a save in flight (the chat stream keeps the server from closing cleanly); an empty database at boot imports a months-old `ironline.json`; one bad value (a NUL character, an int over int32) can block every later save.

## The plan

Each step ships on its own, is tried on staging first, has a restore point (git tag, Railway Postgres snapshot) and a way back. Coaches and clients should see nothing but a short restart at night for some steps. Session counts are rough.

### Step 1 · Safety net (2–3 sessions, no data moves)
- Retry a failed save on a backoff timer until it goes through; alert after repeated failures; last good save shown on `/api/timing`.
- On shutdown: save at once, end the chat streams so the server can close, save again before Railway's draining ends; if the last save fails, write the unsaved store to `/data/unsaved-<time>.json` and alert. Draining time set to 15 s+.
- Boot guards: refuse to start when `_seq` is missing but tables hold rows; refuse the old JSON import in production unless `ALLOW_JSON_IMPORT=1`; raise every `_seq` to at least the table's highest id.
- Poison guard: int32 range check, NUL characters stripped, a row without an id skipped and reported, never blocking the rest.
- Refuse kv keys named like a table (a stray key could replace a table on the next boot).
- Backups: a nightly `pg_dump` to the backup bucket (the JSON backup leaves out the direct tables and will miss moved tables); one restore rehearsed on staging.

### Step 2 · Speed fixes (2–3 sessions, no data moves)
- Client reminders out of the page render into a timer.
- The weight-progression pass works on "dirty" assignments marked on every set write, edit and delete, plus one full pass a night (today it is quadratic in sets).
- Feed, chat list and needs counts in one pass per coach instead of per client.
- Saves track which tables changed, so the compare only looks at those.
- Not in the coach export: push keys and reset tokens stay out (security).

### Step 3 · Staging that is safe, and the database's location (1–2 sessions + a night window)
- Staging environment restored from a production dump with its own uploads and backup buckets, test-mode Stripe and Clerk, no push or mail keys, recurring invoices and meeting reminders off, `TZ=Europe/Amsterdam`, `SKIP_SEED=1`, access limited (it holds client health data and photos).
- Check where the database runs. If it is outside Europe, move it next to the app in a maintenance window: stop the app, dump (including the `drizzle` migrations schema), restore, compare row counts and per-table checksums, switch, start. The old database stays as a frozen backup, not a rollback; a rollback is a fresh dump back.

### Step 4 · Groundwork for direct tables (2–3 sessions)
- Ids from Postgres sequences for the tables that will move (and their parents), set to the highest id at every boot.
- `once_keys` (retry protection) into a real table, written in the same transaction as the row it protects.
- Real timestamp columns (chat and set times are stored in two formats today), backfilled with the app's own reading rule.
- Every column promotion backfills existing rows in SQL, verified by counting what is left in `extra`.
- Photos and videos: while tables move, deletions go to a 30-day trash folder, and a failed check means keep.

### Step 5 · Chat moves to the database (6–9 sessions, the template)
1. One module owns chat rows (still in memory); every read and write goes through it.
2. Pages fetch chat rows first, then compute as now (no screen turns async inside).
3. Shadow week: the new queries run beside the old ones and every difference is logged; the new write paths are exercised on staging. Exit after 7 clean days with every code path seen.
4. Night cut-over: chat reads and writes go to Postgres; the table leaves memory. Mutations as single SQL statements, so two people reacting at once never lose one.
Rollback: the previous build reads the table back in at boot, rows written since included.

### Step 6 · The rest, one at a time, the same recipe
- Apple Health workouts (today one big kv value rewritten on every sync) — early.
- Notifications (`coach_activity`) — about 1.5× the first guess; reminders write from many places.
- Food diary, with saved meals, saved days and meal photos moved together.
- Check-in figures.
- Logged sets, with workouts and session days, last and hardest (twin sets cleaned in the same migration that adds the unique rule, so boot never fails).

### Until the end
One server, volume attached. Two servers only after the remaining in-memory tables are small and the chat stream, presence and timed jobs run through Postgres (LISTEN/NOTIFY, a lock per job).

## Effort

Steps 1–3: about 6–8 sessions; they protect the data and buy speed before coaches arrive. Steps 4–6: about 30–45 more, done as the data grows, not all at once.

## What the owner does

- Approve step 1.
- On Railway: create the staging environment (I set it up with you), turn on Postgres backups, set the draining time, keep one replica with the volume.
- Approve night windows: one for step 3 if the database moves, a short restart for each table move.
