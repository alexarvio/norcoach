// Where the food diary lives (food_entries, calorie_logs, food_days, food_meals, saved_meals, saved_days, meal_photos;
// Step 6, quest 8 part 1 of docs/database-plan.md). No imports, so the store (db.ts), the Postgres store (pg/) and the
// door (food/rows.ts) can all read it without a cycle.
//
//   FOOD_STORE unset or "memory"  (the default) the rows are in memory with the rest of the store, as before: every line
//                                 of the app behaves exactly as the live build does.
//   FOOD_STORE=pg                 the rows live in Postgres alone: the door's fetches read them by bounded SQL, each write
//                                 is one transaction under the client's lock (food/rows.ts writeFood), and the seven tables
//                                 are never loaded into memory nor written by the store's writer. Only with the Postgres
//                                 store (STORE=postgres and a DATABASE_URL), never while `next build` renders pages.
//
// Read once, at module load. This is the only file that reads FOOD_STORE (scripts/check-food-door.mjs refuses it
// anywhere else); pg/runtime.ts initStore refuses a value it doesn't know, and "pg" with the JSON store. Independent of
// CHAT_STORE and NOTES_STORE: all eight combinations work.

const BUILDING = process.env.NEXT_PHASE === "phase-production-build";

/** FOOD_STORE as set: "", "memory" or "pg" are known (anything else stops the boot, pg/runtime.ts). */
export const FOOD_STORE_ASKED = (process.env.FOOD_STORE ?? "").trim();

/** The food diary lives in Postgres alone (FOOD_STORE=pg with the Postgres store, not while building). */
export const FOOD_PG = !BUILDING && process.env.STORE === "postgres" && !!process.env.DATABASE_URL && FOOD_STORE_ASKED === "pg";

/** The store's names for them, for the generic loops over every collection to step round. */
export const FOOD_TABLES = ["food_entries", "calorie_logs", "food_days", "food_meals", "saved_meals", "saved_days", "meal_photos"] as const;
export type FoodTable = (typeof FOOD_TABLES)[number];

/** A kv key a FOOD_STORE=pg boot writes, so the memory boot after it knows to wait for the lease and to keep the food once keys. */
export const FOOD_PG_MARK = "food_pg";

/** The once()-wrapped food actions, whose keys a pg-mode write claims in its own transaction (food/rows.ts writeFood). */
export const FOOD_ONCE_ACTIONS = [
  "addFoodEntryAction",
  "addFoodMealAction",
  "saveMealAction",
  "updateSavedMealFromSlotAction",
  "createSavedMealCardAction",
  "createSavedDayAction",
  "changeSavedDayCardAction",
  "changeSavedMealFoodAction",
  "addSavedMealAction",
  "addSavedMealCardAction",
  "copyFoodDayAction",
  "saveDayAction",
  "addSavedDayAction",
] as const;
/** Their keys as once() keeps them (`name:clientId:key`), for the boot's clean-up of once_keys (pg/onceKeys.ts). */
export const FOOD_ONCE_PREFIX = new RegExp(`^(${FOOD_ONCE_ACTIONS.join("|")}):[0-9]+:`);
export const FOOD_ONCE_PREFIX_SQL = `^(${FOOD_ONCE_ACTIONS.join("|")}):[0-9]+:`;
