import { CHAT_PG } from "../chat/mode";
import { NOTES_PG } from "../notes/mode";
import { FOOD_PG, FOOD_TABLES } from "../food/mode";
import { COLLECTIONS } from "./schema";

// The collections the store loads into memory and its writer saves (Step 5's cut-over). With CHAT_STORE=pg chat rows
// live in Postgres alone: chat_messages is left out of the load, the snapshot, the diff and the boot's checks, so the
// writer can never see an empty chat list and delete the table's rows. In memory mode this is COLLECTIONS itself, the
// same array. Every loop over the store's collections uses this list (scripts/check-chat-door.mjs refuses a loop over
// COLLECTIONS anywhere but pg/runtime.ts tablesWithRows, which looks at every table on purpose).

// The notifications the same with NOTES_STORE=pg (quest 7, notes/mode.ts); either switch alone, or both.
// The food diary's seven tables the same with FOOD_STORE=pg (quest 8 part 1, food/mode.ts); any of the three switches.
const OUT = new Set<string>([...(CHAT_PG ? ["chat_messages"] : []), ...(NOTES_PG ? ["coach_activity"] : []), ...(FOOD_PG ? FOOD_TABLES : [])]);
export const WRITER_COLLECTIONS: typeof COLLECTIONS = OUT.size ? (COLLECTIONS.filter((c) => !OUT.has(c.name)) as unknown as typeof COLLECTIONS) : COLLECTIONS;
