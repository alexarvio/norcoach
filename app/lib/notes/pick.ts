// What each notifications reader cuts from the rows (quest 7): pure functions over a list, used by the door in memory
// mode (the store's list), by the narrow views (the slice a fetch takes) and by the shadow (the rows the last save
// committed), so all three answer exactly as the code before the door did. Moved here verbatim from queries.ts.

import type { NoteActionTab, NoteKind, NoteRow } from "../db";

export type ClientNotification = {
  id: number;
  client_id: number;
  message: string;
  created_at: string;
  kind: NoteKind;
  read: boolean;
  action_tab: NoteActionTab | null;
  action_label: string | null;
  action_ref: number | null;
  /** What it is about, as its writer keyed it ("training:{day}:…", "video-ask:{row}:…"): read by notificationLink. */
  dedupe_key: string | null;
};

/** The most a client page reads at once (arrivalFrom's 500; the list's 300 and the bell's 50 are inside it). */
export const CLIENT_NOTES_MAX = 500;

// Rows written before `kind`/`read`/etc. existed (or restored from an older
// export) won't have them — default defensively rather than trusting the
// stored shape to match the current type. Old, kind-less rows default to
// read so they don't surface as a wall of new unread notifications.
export function normalizeNotification(a: {
  id: number;
  client_id: number;
  message: string;
  created_at: string;
  kind?: NoteKind;
  read?: boolean;
  action_tab?: NoteActionTab | null;
  action_label?: string | null;
  action_ref?: number | null;
  dedupe_key?: string | null;
}): ClientNotification {
  return {
    id: a.id,
    client_id: a.client_id,
    message: a.message,
    created_at: a.created_at,
    kind: a.kind ?? "general",
    read: a.read ?? true,
    action_tab: a.action_tab ?? null,
    action_label: a.action_label ?? null,
    action_ref: a.action_ref ?? null,
    dedupe_key: a.dedupe_key ?? null,
  };
}

/** The list's order: the newest stamp first (as text), then the higher id. getNotifications' comparator, verbatim. */
export const newestFirst = (a: NoteRow, b: NoteRow) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.id - a.id);

/** One client's newest `n` rows, raw, in the list's order (the sort is stable: equal rows keep the store's order). */
export const newestOf = (rows: readonly NoteRow[], clientId: number, n: number): NoteRow[] =>
  rows
    .filter((a) => a.client_id === clientId)
    .sort(newestFirst)
    .slice(0, n);

/**
 * A stamp the database orders otherwise than JavaScript does (COLLATE "C" bytes against UTF-16 units, or NULL, which JS
 * compares as neither before nor after): a client with one is read whole and sorted here (statements.ts).
 */
export const isStrayStamp = (createdAt: unknown) => typeof createdAt !== "string" || !/^[ -~]*$/.test(createdAt);

/** The first row of a client with this key (memory's find; the lowest id in Postgres, which loads by id). */
export const keyedRow = (rows: readonly NoteRow[], clientId: number, key: string) => rows.find((a) => a.client_id === clientId && a.dedupe_key === key);

/** A key in a family: `prefix…suffix` (the tabs' photos-remind:<sheet>:<today>). */
export const inFamily = (key: string | null | undefined, family: { prefix: string; suffix: string }) =>
  typeof key === "string" && key.startsWith(family.prefix) && key.endsWith(family.suffix) && key.length >= family.prefix.length + family.suffix.length;

/** What a chat message's note is looked up by (queries.ts noteFor's argument). */
export type ChatNoteAsk = { id: number; client_id: number; text: string | null; created_at: string | null; unknown?: true };

/**
 * The notification a coach message was logged with: by the message's id where the note carries it, with the same words
 * the memory match asks (a photo-only message's "sent you a photo" note never matched its empty words, and still
 * doesn't); its words unknown, by id alone; else logged in the same breath (5 s) with the same words. noteFor, verbatim.
 */
export function chatNoteOf(notes: readonly NoteRow[], msg: ChatNoteAsk): NoteRow | null {
  const byMessage = notes.find((a) => a.client_id === msg.client_id && a.kind === "coach_note" && a.message_id === msg.id && (msg.unknown || a.message === msg.text));
  if (byMessage) return byMessage;
  if (msg.unknown || msg.created_at == null) return null;
  const sent = new Date(msg.created_at).getTime();
  return notes.find((a) => a.client_id === msg.client_id && a.kind === "coach_note" && a.message_id == null && a.message === msg.text && Math.abs(new Date(a.created_at).getTime() - sent) < 5000) ?? null;
}

/** Clients with an unread reminder, in the order the store first holds one (the minute job's order, so its ids too). */
export function unreadReminderClients(rows: readonly NoteRow[]): number[] {
  const seen = new Set<number>();
  for (const a of rows) if (a.kind === "reminder" && !a.read) seen.add(a.client_id);
  return [...seen];
}

/** A client's unread reminders with a key, in the store's order (the tick-off's candidates). */
export const unreadRemindersOf = (rows: readonly NoteRow[], clientId: number) =>
  rows.filter((a) => a.client_id === clientId && a.kind === "reminder" && !a.read && !!a.dedupe_key).map((a) => ({ id: a.id, dedupe_key: a.dedupe_key as string }));

/** Canonical JSON (keys sorted), for comparisons. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
    .join(",")}}`;
}
