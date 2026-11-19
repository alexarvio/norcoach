// Where chat rows live (Step 5's cut-over, sub-step 4 of docs/database-plan.md). No imports, so the store (db.ts), the
// Postgres store (pg/) and the door (chat/rows.ts) can all read it without a cycle.
//
//   CHAT_STORE unset or "memory"  (the default) chat rows are in memory with the rest of the store, as before: every
//                                 line of the app behaves exactly as the live build does.
//   CHAT_STORE=pg                 chat rows live in Postgres alone: the door's fetches run statements.ts on chat_messages,
//                                 its writes run single SQL statements, and the table is never loaded into memory nor
//                                 written by the store's writer. Only with the Postgres store (STORE=postgres and a
//                                 DATABASE_URL), never while `next build` renders pages (they read the JSON store).
//
// Read once, at module load: the mode never changes while a server runs. This is the only file that reads CHAT_STORE
// (scripts/check-chat-door.mjs refuses it anywhere else); pg/runtime.ts initStore refuses a value it doesn't know, and
// "pg" with the JSON store.

const BUILDING = process.env.NEXT_PHASE === "phase-production-build";

/** CHAT_STORE as set: "", "memory" or "pg" are known (anything else stops the boot, pg/runtime.ts). */
export const CHAT_STORE_ASKED = (process.env.CHAT_STORE ?? "").trim();

/** Chat rows live in Postgres alone (CHAT_STORE=pg with the Postgres store, not while building). */
export const CHAT_PG = !BUILDING && process.env.STORE === "postgres" && !!process.env.DATABASE_URL && CHAT_STORE_ASKED === "pg";

/**
 * The once keys a chat insert writes in its own statement (chatSend's nonce, the media review's replies, a workout's
 * note): pg/onceKeys.ts keeps a day of them at boot instead of replacing them with kv's copy, which may not have them.
 */
// The review replies' chat messages carry keys of their own since the 19 Nov review (chatReplyMedia, chatFormReview); the
// review actions' own once() keys are still kept a day from the table (the insert wrote them before; harmless).
export const CHAT_ONCE_PREFIX = /^(chat\d+|chatReplyMedia\d+|chatFormReview\d+|replyToMediaAction:\d+|sendFormReviewAction:\d+|sessionNote\d+):/;
/** The same, as a Postgres regular expression. */
export const CHAT_ONCE_PREFIX_SQL = "^(chat[0-9]+|chatReplyMedia[0-9]+|chatFormReview[0-9]+|replyToMediaAction:[0-9]+|sendFormReviewAction:[0-9]+|sessionNote[0-9]+):";
