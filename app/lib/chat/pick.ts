// What each chat fetch picks out of the rows, as plain functions over a list of rows (18 Nov, Step 5 of
// docs/database-plan.md). No store and no database here: the door's narrow views (rows.ts), the shadow's expected side
// (shadow.ts, over the rows the last save committed) and the tests all run these same functions, and statements.ts
// holds the SQL each one stands for. The rows are taken in id order, which is the store's order (the boot loads them
// ORDER BY id and every new row takes a higher id).
//
// The two reducers at the end (chatNeedOf, dockLineOf) are lifted out of getClientHome and chatListRows unchanged, so
// the readers and the shadow's equivalence checks run the very same code on the whole rows and on a slice.

import type { ChatRow } from "../db";
import { stampMs } from "../targetRule";

/** How long a client's message counts as new for the coach (as queries.ts's Home and chat counts read it). */
export const HOME_NEW_DAYS = 14;

/**
 * Every character String.prototype.trim takes off: ECMAScript's WhiteSpace and LineTerminator, no more (no U+0085, no
 * U+180E). The migration's norcoach_js_trim strips exactly these, so a SQL "has words" agrees with a JS one. Written as
 * escapes, never the characters themselves, so no editor or formatter can quietly change the set.
 */
export const JS_SPACE =
  "\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF";

/** A message with words or a file: today's `m.text.trim() || m.media_path` (it throws on a row with no text, as now). */
export const hasWords = (m: ChatRow) => !!(m.text.trim() || m.media_path);

/** hasWords as the SQL reads it (norcoach_has_words): a row with no text is a row with none. For the picks. */
const words = (m: ChatRow) => !!(String(m.text ?? "").trim() || m.media_path);

/** The thread's order as listChatMessages always sorted it: the stamp's text, then the id. */
export const textOrder = (a: ChatRow, b: ChatRow) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id - b.id);

const byId = (a: ChatRow, b: ChatRow) => a.id - b.id;

/** The row without its preview picture (a data URI): what the coach-wide reads fetch, none of their readers use it. */
export function lean(row: ChatRow): ChatRow {
  const copy = { ...row };
  delete copy.media_thumb;
  return copy;
}

/** One client's whole thread. */
export const pickThread = (rows: readonly ChatRow[], clientId: number) => rows.filter((m) => m.client_id === clientId);

/** One client's food comments: the coach's messages linked to a day of the food diary (mealCommentsOn reads these). */
export const pickFood = (rows: readonly ChatRow[], clientId: number) =>
  rows.filter((m) => m.client_id === clientId && m.sender === "coach" && m.link?.kind === "food");

/** Everything these clients sent, lean (the coach's feed, the Feed's Since). */
export const pickCoachSent = (rows: readonly ChatRow[], ids: ReadonlySet<number>) =>
  rows.filter((m) => m.sender === "client" && ids.has(m.client_id)).map(lean);

/** These clients' rows by client, each in the rows' order; a client with none has no entry. */
export function groupOf(rows: readonly ChatRow[], ids: ReadonlySet<number>): Map<number, ChatRow[]> {
  const out = new Map<number, ChatRow[]>();
  for (const m of rows) {
    if (!ids.has(m.client_id)) continue;
    let list = out.get(m.client_id);
    if (!list) out.set(m.client_id, (list = []));
    list.push(m);
  }
  return out;
}

/**
 * Each client's latest coach message with words or a file, lean, as getClientHome finds it: the newest by stampMs, the
 * store's order kept between equal stamps (a stable sort). In id order.
 */
export function pickCoachLast(rows: readonly ChatRow[], ids: ReadonlySet<number>): ChatRow[] {
  const out: ChatRow[] = [];
  for (const full of groupOf(rows, ids).values()) {
    const last = full
      .filter(words)
      .sort((a, b) => stampMs(b.created_at) - stampMs(a.created_at))
      .find((m) => m.sender === "coach");
    if (last) out.push(lean(last));
  }
  return out.sort(byId);
}

/**
 * The chat list's rows for each client, lean: their last message with words or a file in the thread's order, and the
 * messages they sent with words or a file from `since` on (the unread count's window, with room to spare). In id order.
 */
export function pickDock(rows: readonly ChatRow[], ids: ReadonlySet<number>, since: number): ChatRow[] {
  const out: ChatRow[] = [];
  for (const full of groupOf(rows, ids).values()) {
    const keep = new Map<number, ChatRow>();
    let last: ChatRow | null = null;
    for (const m of full) {
      if (!words(m)) continue;
      if (!last || textOrder(m, last) > 0) last = m;
      if (m.sender === "client" && stampMs(m.created_at) >= since) keep.set(m.id, m);
    }
    if (last) keep.set(last.id, last);
    for (const m of keep.values()) out.push(lean(m));
  }
  return out.sort(byId);
}

/** Whether some message shows this file. */
export const pickExists = (rows: readonly ChatRow[], publicPath: string) => rows.some((m) => m.media_path === publicPath);

/** Whether some message shows this file with no look (preview and size) yet. */
export const pickLacksLook = (rows: readonly ChatRow[], publicPath: string) => rows.some((m) => m.media_path === publicPath && !m.media_thumb);

/** Each picture or video file some message shows with no look yet, once, as prepareAllChatMedia walks them: the first such message's type. */
export function pickToPrepare(rows: readonly ChatRow[]): { path: string; type: "image" | "video" }[] {
  const seen = new Set<string>();
  const out: { path: string; type: "image" | "video" }[] = [];
  for (const m of rows) {
    if (!m.media_path || (m.media_type !== "image" && m.media_type !== "video")) continue;
    if (m.media_thumb || seen.has(m.media_path)) continue;
    seen.add(m.media_path);
    out.push({ path: m.media_path, type: m.media_type });
  }
  return out;
}

/** These clients' rows, for the export. */
export const pickExport = (rows: readonly ChatRow[], ids: ReadonlySet<number>) => rows.filter((m) => ids.has(m.client_id));

// ---- The readers' own reducers, lifted out unchanged ----------------------------------------------------------------

/**
 * A client's chat as Needs you reads it (getClientHome, 12 Oct; 25 Oct): their messages with words or a file, newest
 * first; the coach's last one; and theirs after it, with no reaction from the coach, since the coach last had the chat
 * open. `unanswered` newest first.
 */
export function chatNeedOf(rows: readonly ChatRow[], clientId: number, readAt: number): { lastCoach: ChatRow | undefined; unanswered: ChatRow[] } {
  const chat = rows.filter((m) => m.client_id === clientId && (m.text.trim() || m.media_path)).sort((a, b) => stampMs(b.created_at) - stampMs(a.created_at));
  const lastCoach = chat.find((m) => m.sender === "coach");
  const unanswered = chat.filter((m) => m.sender === "client" && !m.reactions?.coach && (!lastCoach || stampMs(m.created_at) > stampMs(lastCoach.created_at)) && stampMs(m.created_at) > readAt);
  return { lastCoach, unanswered };
}

/**
 * One client's line in the chat list (chatListRows, loadChatDock): how many of their messages are new to the coach, and
 * the thread's last message with words or a file, in the thread's order. `list` is that client's rows.
 */
export function dockLineOf(list: readonly ChatRow[], seen: Record<string, number>, since: number): { last: ChatRow | null; unreadCount: number } {
  const unreadCount = list.filter((m) => m.sender === "client" && (m.text.trim() || m.media_path) && stampMs(m.created_at) >= since && !(`chat-${m.id}` in seen)).length;
  const messages = [...list].sort(textOrder);
  const last = messages.filter((x) => x.text.trim() || x.media_path).at(-1) ?? null;
  return { last, unreadCount };
}

// ---- Comparing ----------------------------------------------------------------------------------------------------

/** JSON with every object's keys sorted, however deep; undefined left out, null kept (jsonb reorders keys). */
export function stableJson(value: unknown): string {
  return JSON.stringify(sorted(value)) ?? "undefined";
}
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : sorted(v)));
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = sorted(v);
    }
    return out;
  }
  return value;
}

/** chat_messages' own columns (pg/schema.ts); every other field of a row lives in its `extra`. */
const COLUMNS = new Set(["id", "client_id", "sender", "text", "media_path", "media_type", "created_at"]);

/**
 * What differs between two lists of rows, by id: ids only on one side, and for each id on both the fields that differ
 * (a field kept in `extra` named `extra.<field>`). Never a value.
 */
export function rowsDiff(expected: readonly ChatRow[], actual: readonly ChatRow[]): RowsDiff | null {
  const fields: Record<number, string[]> = {};
  const got = new Map(actual.map((m) => [m.id, m]));
  for (const w of expected) {
    const g = got.get(w.id);
    const differ = g ? rowFieldsDiff(w, g) : null;
    if (differ) fields[w.id] = differ;
  }
  return rowsDiffFinish(expected, actual, fields);
}

export type RowsDiff = { missing: number[]; extra: number[]; order: boolean; fields: Record<number, string[]> };

/** One row's fields that differ (a field kept in `extra` named `extra.<field>`), sorted; null when none. Never a value. */
export function rowFieldsDiff(w: ChatRow, g: ChatRow): string[] | null {
  const names = new Set([...Object.keys(w), ...Object.keys(g)]);
  const differ = [...names]
    .filter((k) => stableJson((w as Record<string, unknown>)[k]) !== stableJson((g as Record<string, unknown>)[k]))
    .map((k) => (COLUMNS.has(k) ? k : `extra.${k}`))
    .sort();
  return differ.length ? differ : null;
}

/** rowsDiff's ending, from the field differences already found (the shadow finds them a slice at a time). */
export function rowsDiffFinish(expected: readonly ChatRow[], actual: readonly ChatRow[], fields: Record<number, string[]>): RowsDiff | null {
  const want = new Set(expected.map((m) => m.id));
  const got = new Set(actual.map((m) => m.id));
  const missing = [...want].filter((id) => !got.has(id));
  const extra = [...got].filter((id) => !want.has(id));
  const order = !missing.length && !extra.length && expected.some((m, i) => actual[i]?.id !== m.id);
  if (!missing.length && !extra.length && !order && !Object.keys(fields).length) return null;
  return { missing, extra, order, fields };
}
