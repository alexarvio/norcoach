import { getData, persist, type OnceKey } from "./db";

// The store's list of saves taken once (lib/once.ts), with nothing of Next in it, so the store's own code (queries.ts,
// which the seed scripts import) can note a key too (Step 5's cut-over: a chat insert writes its key in its own
// statement, and the store's list then carries it, for the kv copy and the day's pruning).

const DAY_MS = 86_400_000;
const MAX_KEPT = 5000;

export function onceRows(): OnceKey[] {
  const d = getData();
  if (!d.once_keys) d.once_keys = [];
  return d.once_keys;
}

export function findOnceKey(full: string): OnceKey | undefined {
  return onceRows().find((r) => r.key === full);
}

/** A key kept, the day's older ones and the oldest past MAX_KEPT let go, and saved. */
export function keepOnceKey(row: OnceKey) {
  const now = Date.now();
  const d = getData();
  const kept = onceRows().filter((r) => now - r.at < DAY_MS && r.key !== row.key);
  kept.push(row);
  d.once_keys = kept.length > MAX_KEPT ? kept.slice(kept.length - MAX_KEPT) : kept;
  persist();
}

/**
 * A key an insert already committed to the once_keys table (CHAT_STORE=pg), into the store's list as the table holds it
 * (the same key, time and answer), so the next save's upsert changes nothing in it, kv's copy carries it for a rollback,
 * and it is pruned after a day. Not again when the list has it.
 */
export function noteTakenKey(full: string, at: number, result?: unknown) {
  if (findOnceKey(full)) return;
  keepOnceKey({ key: full, at, ...(result === undefined ? {} : { result }) });
}
