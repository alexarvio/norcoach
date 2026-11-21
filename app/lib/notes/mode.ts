// Where the client's notifications live (coach_activity; Step 6, quest 7 of docs/database-plan.md). No imports, so the
// store (db.ts), the Postgres store (pg/) and the door (notes/rows.ts) can all read it without a cycle.
//
//   NOTES_STORE unset or "memory"  (the default) the rows are in memory with the rest of the store, as before: every
//                                  line of the app behaves exactly as the live build does.
//   NOTES_STORE=pg                 the rows live in Postgres alone: the door's fetches run notes/statements.ts on
//                                  coach_activity, its writes go through the outbox (notes/outbox.ts) as single
//                                  statements, and the table is never loaded into memory nor written by the store's
//                                  writer. Only with the Postgres store (STORE=postgres and a DATABASE_URL), never while
//                                  `next build` renders pages.
//
// Read once, at module load. This is the only file that reads NOTES_STORE (scripts/check-notes-door.mjs refuses it
// anywhere else); pg/runtime.ts initStore refuses a value it doesn't know, and "pg" with the JSON store. Independent of
// CHAT_STORE: all four combinations work.

const BUILDING = process.env.NEXT_PHASE === "phase-production-build";

/** NOTES_STORE as set: "", "memory" or "pg" are known (anything else stops the boot, pg/runtime.ts). */
export const NOTES_STORE_ASKED = (process.env.NOTES_STORE ?? "").trim();

/** The notifications live in Postgres alone (NOTES_STORE=pg with the Postgres store, not while building). */
export const NOTES_PG = !BUILDING && process.env.STORE === "postgres" && !!process.env.DATABASE_URL && NOTES_STORE_ASKED === "pg";

/** The store's name for them, for the generic loops over every collection to step round. */
export const NOTES_TABLE = "coach_activity";
/** The kv key holding the writes not yet in the table (NOTES_STORE=pg; notes/outbox.ts). */
export const NOTES_OUTBOX = "notes_outbox";
