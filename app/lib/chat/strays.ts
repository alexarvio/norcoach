// The chat rows whose stamp the readers (stampMs) and the SQL (created_at_tz) read differently, or not at all (Step 5's
// cut-over; pick.ts isStray). Every coach-wide read fetches them whole and leaves them out of its cuts and bounds, so a
// bounded read never hinges on one. There are few or none: a stamp written by neither of the app's two ways.
//
// With CHAT_STORE=pg: found by the boot's scan of the table (pg/runtime.ts), and added to by the door's insert when a
// new row's own stamp is one (rows.ts). In memory (narrow views and the shadow): worked out from the rows, cached.

import type { ChatRow } from "../db";
import { straysOf } from "./pick";

const g = globalThis as unknown as { __norcoachChatStrays?: Set<number> };

/** The table's strays (CHAT_STORE=pg). */
export function pgStrays(): Set<number> {
  return (g.__norcoachChatStrays ??= new Set());
}

/** The boot's scan found these (CHAT_STORE=pg). */
export function setPgStrays(ids: Iterable<number>) {
  g.__norcoachChatStrays = new Set(ids);
}

let cached: { of: readonly ChatRow[]; length: number; strays: Set<number> } | null = null;
/** The strays of the store's own list (narrow views in memory), again only when the list was replaced or grew. */
export function storeStrays(rows: readonly ChatRow[]): Set<number> {
  if (!cached || cached.of !== rows || cached.length !== rows.length) cached = { of: rows, length: rows.length, strays: straysOf(rows) };
  return cached.strays;
}
