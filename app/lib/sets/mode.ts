// Where the logged sets live (set_logs; Step 6, quest 10 of docs/database-plan.md, the Archive Campaign's quest 9 and
// last, "The Unmaking of the Ring"). No imports, so the store (db.ts), the Postgres store (pg/) and the door
// (sets/rows.ts) can all read it without a cycle.
//
//   SETS_STORE unset or "memory"  (the default) the sets are in memory with the rest of the store, as before: every line
//                                 of the app behaves exactly as the live build does.
//   SETS_STORE=pg                 the sets live in Postgres alone: the door's fetches read them by bounded SQL, each write
//                                 is one transaction under the client's lock (sets/rows.ts writeSets, saveSets), and the
//                                 table is never loaded into memory nor written by the store's writer. Only with the
//                                 Postgres store (STORE=postgres and a DATABASE_URL), never while `next build` renders.
//
// Read once, at module load. This is the only file that reads SETS_STORE (scripts/check-sets-door.mjs refuses it anywhere
// else); pg/runtime.ts initStore refuses a value it doesn't know, and "pg" with the JSON store. Independent of CHAT_STORE,
// NOTES_STORE, FOOD_STORE and CHECKINS_STORE: all thirty-two combinations work. The sessions (program_days), the plan
// (workout_assignments), the cardio (cardio_entries, cardio_logs) and everything else stay in memory in both modes.

const BUILDING = process.env.NEXT_PHASE === "phase-production-build";

/** SETS_STORE as set: "", "memory" or "pg" are known (anything else stops the boot, pg/runtime.ts). */
export const SETS_STORE_ASKED = (process.env.SETS_STORE ?? "").trim();

/** The logged sets live in Postgres alone (SETS_STORE=pg with the Postgres store, not while building). */
export const SETS_PG = !BUILDING && process.env.STORE === "postgres" && !!process.env.DATABASE_URL && SETS_STORE_ASKED === "pg";

/** The store's name for them, for the generic loops over every collection to step round. */
export const SETS_TABLES = ["set_logs"] as const;
export type SetTable = (typeof SETS_TABLES)[number];

/** A kv key a SETS_STORE=pg boot writes, so the memory boot after it knows to wait for the lease and drop the rule. */
export const SETS_PG_MARK = "sets_pg";

/**
 * A store key (kept in kv) naming the plan rows a coach removed whose sets' DELETE has not yet committed:
 * `{ [key]: { client, rows, at } }`. Written in pg mode alone (sets/rows.ts removeSetsOfRows); any boot of this build
 * completes what it names (sets/boot.ts). Row ids are never handed out again (their sequence only goes up), so a
 * tombstone naming rows is safe to finish at any later time.
 */
export const SETS_REMOVING = "sets_removing";
