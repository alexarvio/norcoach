// Where the check-in figures live (metric_entries, with the check-in notes, check_in_notes; Step 6, quest 9 of
// docs/database-plan.md). No imports, so the store (db.ts), the Postgres store (pg/) and the door (checkins/rows.ts)
// can all read it without a cycle.
//
//   CHECKINS_STORE unset or "memory"  (the default) the rows are in memory with the rest of the store, as before: every
//                                     line of the app behaves exactly as the live build does.
//   CHECKINS_STORE=pg                 the rows live in Postgres alone: the door's fetches read them by bounded SQL, each
//                                     write is one transaction under the client's lock (checkins/rows.ts writeCheckIns),
//                                     and the two tables are never loaded into memory nor written by the store's writer.
//                                     Only with the Postgres store (STORE=postgres and a DATABASE_URL), never while
//                                     `next build` renders pages.
//
// Read once, at module load. This is the only file that reads CHECKINS_STORE (scripts/check-checkins-door.mjs refuses
// it anywhere else); pg/runtime.ts initStore refuses a value it doesn't know, and "pg" with the JSON store. Independent
// of CHAT_STORE, NOTES_STORE and FOOD_STORE: all sixteen combinations work. The coach's metric definitions
// (metric_definitions) stay in memory in both modes.

const BUILDING = process.env.NEXT_PHASE === "phase-production-build";

/** CHECKINS_STORE as set: "", "memory" or "pg" are known (anything else stops the boot, pg/runtime.ts). */
export const CHECKINS_STORE_ASKED = (process.env.CHECKINS_STORE ?? "").trim();

/** The check-in figures live in Postgres alone (CHECKINS_STORE=pg with the Postgres store, not while building). */
export const CHECKINS_PG = !BUILDING && process.env.STORE === "postgres" && !!process.env.DATABASE_URL && CHECKINS_STORE_ASKED === "pg";

/** The store's names for them, for the generic loops over every collection to step round. */
export const CHECKINS_TABLES = ["metric_entries", "check_in_notes"] as const;
export type CheckInTable = (typeof CHECKINS_TABLES)[number];

/** A kv key a CHECKINS_STORE=pg boot writes, so the memory boot after it knows to wait for the lease and drop the rules. */
export const CHECKINS_PG_MARK = "checkins_pg";

/**
 * A store key (kept in kv) naming each metric removed with its readings while the readings' DELETE has not yet
 * committed: `{ [definition id]: { client, at } }`. Written in pg mode alone (checkins/rows.ts removeMetricWithReadings);
 * any boot of this build completes what it names (checkins/boot.ts).
 */
export const CHECKINS_REMOVING = "checkins_removing";
