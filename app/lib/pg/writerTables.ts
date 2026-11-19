import { CHAT_PG } from "../chat/mode";
import { COLLECTIONS } from "./schema";

// The collections the store loads into memory and its writer saves (Step 5's cut-over). With CHAT_STORE=pg chat rows
// live in Postgres alone: chat_messages is left out of the load, the snapshot, the diff and the boot's checks, so the
// writer can never see an empty chat list and delete the table's rows. In memory mode this is COLLECTIONS itself, the
// same array. Every loop over the store's collections uses this list (scripts/check-chat-door.mjs refuses a loop over
// COLLECTIONS anywhere but pg/runtime.ts tablesWithRows, which looks at every table on purpose).

export const WRITER_COLLECTIONS: typeof COLLECTIONS = CHAT_PG ? (COLLECTIONS.filter((c) => c.name !== "chat_messages") as unknown as typeof COLLECTIONS) : COLLECTIONS;
