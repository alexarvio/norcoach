// The SQL each notifications fetch and write runs once coach_activity leaves memory (quest 7). The shadow runs the reads
// beside the door's fetches today (shadow.ts) and the writes on coach_activity_shadow (NOTES_SHADOW=write, staging); with
// NOTES_STORE=pg the door and the drainer run them on coach_activity. The table is a parameter for that reason.
//
// Every value a bound parameter, cast; a row's values made as the writer maps it (store.ts toRecord, cleanJson; params
// below), so a statement writes exactly what a save would. A column set by an UPDATE leaves `extra.__absent` as the
// writer would (norcoach_column_set, migration 0018). Keys and words are matched by md5 first (the md5 indexes, 0020),
// then exactly. Lists go in as JSON (jsonb_array_elements), so nothing but their values can.

import { sql, type SQL } from "drizzle-orm";
import type { NoteRow } from "../db";
import { coach_activity } from "../pg/schema";
import { cleanJson, cleanText, toRecord } from "../pg/store";
import { stampInstant } from "../pg/stamps";

export type NotesTable = "coach_activity" | "coach_activity_shadow";
/** Rows or pairs a statement of the minute job carries at most (reminderKeys, insertMany, tickOffMany). */
export const REMINDER_PART = 1000;
const T = (name: NotesTable) => sql.identifier(name);
const ints = (ids: readonly number[]) => JSON.stringify(ids.filter((n) => Number.isInteger(n)));
const texts = (list: readonly string[]) => JSON.stringify(list.map(cleanText));
const INTS = (ids: readonly number[]) => sql`(SELECT (v)::int FROM jsonb_array_elements_text(${ints(ids)}::jsonb) v)`;
const TEXTS = (list: readonly string[]) => sql`(SELECT v FROM jsonb_array_elements_text(${texts(list)}::jsonb) v)`;
const MD5S = (list: readonly string[]) => sql`(SELECT md5(v) FROM jsonb_array_elements_text(${texts(list)}::jsonb) v)`;
/** One key, exactly, on the md5 index. */
const KEY = (key: string) => sql`dedupe_key IS NOT NULL AND md5(dedupe_key) = md5(${cleanText(key)}::text) AND dedupe_key = ${cleanText(key)}::text`;

/** A row's statement parameters, as the writer would write it. */
export type NoteParams = {
  id: number;
  client_id: number;
  message: string | null;
  created_at: string | null;
  kind: string | null;
  read: boolean | null;
  action_tab: string | null;
  action_label: string | null;
  action_ref: number | null;
  dedupe_key: string | null;
  extra: string | null;
  created_at_tz: string | null;
};

export function noteParams(row: NoteRow): NoteParams {
  const r = JSON.parse(cleanJson(toRecord(coach_activity, row as unknown as Record<string, unknown>)) ?? "null") as Record<string, unknown>;
  return {
    id: Number(r.id),
    client_id: Number(r.client_id),
    message: (r.message as string | null) ?? null,
    created_at: (r.created_at as string | null) ?? null,
    kind: (r.kind as string | null) ?? null,
    read: (r.read as boolean | null) ?? null,
    action_tab: (r.action_tab as string | null) ?? null,
    action_label: (r.action_label as string | null) ?? null,
    action_ref: (r.action_ref as number | null) ?? null,
    dedupe_key: (r.dedupe_key as string | null) ?? null,
    extra: r.extra == null ? null : JSON.stringify(r.extra),
    created_at_tz: stampInstant(row.created_at),
  };
}

const COLS = sql.raw(`id, client_id, message, created_at, kind, read, action_tab, action_label, action_ref, dedupe_key, extra, created_at_tz`);
const VALUES = (p: NoteParams) =>
  sql`(${p.id}::int, ${p.client_id}::int, ${p.message}::text, ${p.created_at}::text, ${p.kind}::text, ${p.read}::boolean, ${p.action_tab}::text, ${p.action_label}::text, ${p.action_ref}::int, ${p.dedupe_key}::text, ${p.extra}::jsonb, ${p.created_at_tz}::timestamptz)`;

// ---- Reads --------------------------------------------------------------------------------------------------------

export const readSql = {
  /** newestOf: a client's newest n in the list's order (coach_activity_client_text_idx). */
  newest: (t: NotesTable, clientId: number, n: number) =>
    sql`SELECT * FROM ${T(t)} WHERE client_id = ${clientId}::int ORDER BY created_at COLLATE "C" DESC, id DESC LIMIT ${n}::int`,
  /** A client whole, by id (a client with a stray stamp, sorted in JS; the export of one). */
  whole: (t: NotesTable, clientId: number) => sql`SELECT * FROM ${T(t)} WHERE client_id = ${clientId}::int ORDER BY id`,
  /** keyedRow for each key: every row with one of them, by id (the first is memory's find). */
  keys: (t: NotesTable, clientId: number, keys: readonly string[]) =>
    sql`SELECT * FROM ${T(t)} WHERE client_id = ${clientId}::int AND dedupe_key IS NOT NULL AND md5(dedupe_key) IN ${MD5S(keys)} AND dedupe_key IN ${TEXTS(keys)} ORDER BY id`,
  /** inFamily: a client's rows with a key `prefix…suffix`, by id. */
  family: (t: NotesTable, clientId: number, prefix: string, suffix: string) =>
    sql`SELECT * FROM ${T(t)} WHERE client_id = ${clientId}::int AND dedupe_key IS NOT NULL AND starts_with(dedupe_key, ${cleanText(prefix)}::text)
          AND right(dedupe_key, length(${cleanText(suffix)}::text)) = ${cleanText(suffix)}::text AND length(dedupe_key) >= length(${cleanText(prefix)}::text) + length(${cleanText(suffix)}::text) ORDER BY id`,
  /** Rows by id (the views' overlay: what a queued write points at). */
  ids: (t: NotesTable, ids: readonly number[]) => sql`SELECT * FROM ${T(t)} WHERE id IN ${INTS(ids)} ORDER BY id`,
  /** Whose a notification is. */
  owner: (t: NotesTable, id: number) => sql`SELECT client_id FROM ${T(t)} WHERE id = ${id}::int`,
  /** chatNoteOf's candidates: a client's coach notes carrying this message's id, or with these words (by id). */
  chatNote: (t: NotesTable, clientId: number, messageId: number, words: string | null) =>
    words == null
      ? sql`SELECT * FROM ${T(t)} WHERE client_id = ${clientId}::int AND kind = 'coach_note' AND (extra ->> 'message_id') = ${String(messageId)}::text ORDER BY id`
      : sql`SELECT * FROM ${T(t)} WHERE client_id = ${clientId}::int AND kind = 'coach_note'
              AND ((extra ->> 'message_id') = ${String(messageId)}::text OR (md5(message) = md5(${cleanText(words)}::text) AND message = ${cleanText(words)}::text)) ORDER BY id`,
  /** unreadReminderClients: in the order the table first holds one. */
  unreadClients: (t: NotesTable) =>
    sql`SELECT client_id FROM ${T(t)} WHERE kind = 'reminder' AND read IS NOT TRUE GROUP BY client_id ORDER BY min(id)`,
  /**
   * The minute job's keys: the rows with each (client, key) pair, any kind, any read, a pair at a time on
   * coach_activity_client_key_idx (a join on the pairs, never an OR of two lists, which the planner can only scan the
   * table for). The job sends them in parts (REMINDER_PART) so no statement nears the 5 s timeout.
   */
  reminderKeys: (t: NotesTable, pairs: readonly { clientId: number; key: string }[]) =>
    sql`SELECT c.* FROM ${T(t)} c JOIN (SELECT (v ->> 'c')::int AS cid, (v ->> 'k') AS k FROM jsonb_array_elements(${JSON.stringify(pairs.filter((p) => Number.isInteger(p.clientId)).map((p) => ({ c: p.clientId, k: cleanText(p.key) })))}::jsonb) v) w
          ON c.client_id = w.cid AND c.dedupe_key IS NOT NULL AND md5(c.dedupe_key) = md5(w.k) AND c.dedupe_key = w.k ORDER BY c.id`,
  /** The minute job's unread reminders of these clients (coach_activity_unread_reminder_idx, a partial index of them alone). */
  unreadReminders: (t: NotesTable, clientIds: readonly number[]) =>
    sql`SELECT * FROM ${T(t)} WHERE kind = 'reminder' AND read IS NOT TRUE AND client_id IN ${INTS(clientIds)} ORDER BY id`,
  /** Which of these outbox tokens already ran (claimed in coach_activity_ops): their ops are in the table's answer. */
  claimedTokens: (tokens: readonly string[]) => sql`SELECT token FROM coach_activity_ops WHERE token IN ${TEXTS(tokens)}`,
  /** The export: these clients' rows, by id. */
  export: (t: NotesTable, clientIds: readonly number[]) => sql`SELECT * FROM ${T(t)} WHERE client_id IN ${INTS(clientIds)} ORDER BY id`,
  /** The backup's whole table, a page at a time. */
  page: (t: NotesTable, after: number, n: number) => sql`SELECT * FROM ${T(t)} WHERE id > ${after}::int ORDER BY id LIMIT ${n}::int`,
  /** Clients with a stamp the database orders otherwise (pick.ts isStrayStamp). */
  strays: (t: NotesTable) => sql`SELECT DISTINCT client_id FROM ${T(t)} WHERE created_at IS NULL OR created_at !~ '^[ -~]*$'`,
};

// ---- Writes -------------------------------------------------------------------------------------------------------

export const writeSql = {
  /** A note with no key: by its id alone (a replay finds its own row). */
  insertPlain: (t: NotesTable, p: NoteParams) => sql`INSERT INTO ${T(t)} (${COLS}) VALUES ${VALUES(p)} ON CONFLICT (id) DO NOTHING RETURNING id`,
  /** A keyed note: nothing when a row has its key (the unique rule a pg boot makes; the shadow table's own). */
  insertKeyed: (t: NotesTable, p: NoteParams) =>
    sql`INSERT INTO ${T(t)} (${COLS}) VALUES ${VALUES(p)} ON CONFLICT (client_id, md5(dedupe_key)) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING id`,
  /** The row with a key, locked for a replace or a merge (inside their transaction). */
  lockKeyed: (t: NotesTable, clientId: number, key: string) => sql`SELECT * FROM ${T(t)} WHERE client_id = ${clientId}::int AND ${KEY(key)} ORDER BY id LIMIT 1 FOR UPDATE`,
  /** A replace's or a merge's row, as applyOp left the locked row (its extra too, so `__absent` reads as the writer's). */
  update: (t: NotesTable, p: NoteParams) =>
    sql`UPDATE ${T(t)} SET message = ${p.message}::text, created_at = ${p.created_at}::text, created_at_tz = ${p.created_at_tz}::timestamptz, read = ${p.read}::boolean,
          action_ref = ${p.action_ref}::int, extra = ${p.extra}::jsonb WHERE id = ${p.id}::int RETURNING id`,
  drop: (t: NotesTable, clientId: number, key: string) =>
    sql`DELETE FROM ${T(t)} WHERE id = (SELECT id FROM ${T(t)} WHERE client_id = ${clientId}::int AND ${KEY(key)} ORDER BY id LIMIT 1) RETURNING id`,
  read: (t: NotesTable, clientId: number, id: number) =>
    sql`UPDATE ${T(t)} SET read = true, extra = norcoach_column_set(extra, 'read') WHERE id = ${id}::int AND client_id = ${clientId}::int RETURNING id`,
  readCoachNotes: (t: NotesTable, clientId: number) =>
    sql`UPDATE ${T(t)} SET read = true, extra = norcoach_column_set(extra, 'read') WHERE client_id = ${clientId}::int AND kind = 'coach_note' AND read IS NOT TRUE RETURNING id`,
  /** Every row of the client read; only those not already so (a row whose read was absent counts as not). */
  readAll: (t: NotesTable, clientId: number, upTo?: number | null) =>
    sql`UPDATE ${T(t)} SET read = true, extra = norcoach_column_set(extra, 'read') WHERE client_id = ${clientId}::int
          AND (${upTo ?? null}::int IS NULL OR id <= ${upTo ?? null}::int)
          AND (read IS NOT TRUE OR jsonb_exists(COALESCE(extra -> '__absent', '[]'::jsonb), 'read')) RETURNING id`,
  /**
   * The minute job's new reminders in one statement (NOTES_STORE=pg; never through the outbox: they tell of no change to
   * the store, and a rollover's thousands would swell it): a row with a key already there is left, as logCoachActivity's
   * keep. Sent in parts of REMINDER_PART rows.
   */
  insertMany: (t: NotesTable, rows: readonly NoteParams[]) =>
    sql`INSERT INTO ${T(t)} (${COLS})
          SELECT id, client_id, message, created_at, kind, read, action_tab, action_label, action_ref, dedupe_key, extra, created_at_tz
            FROM jsonb_to_recordset(${JSON.stringify(rows.map((p) => ({ ...p, extra: p.extra == null ? null : JSON.parse(p.extra) })))}::jsonb)
              AS x(id int, client_id int, message text, created_at text, kind text, read boolean, action_tab text, action_label text, action_ref int, dedupe_key text, extra jsonb, created_at_tz timestamptz)
          ON CONFLICT (client_id, md5(dedupe_key)) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING id`,
  /** The minute job's tick-offs for many clients at once: tickOff's rule, each (client, id) pair. */
  tickOffMany: (t: NotesTable, pairs: readonly { clientId: number; id: number }[]) =>
    sql`UPDATE ${T(t)} c SET read = true, extra = norcoach_column_set(c.extra, 'read')
          FROM jsonb_to_recordset(${JSON.stringify(pairs.filter((p) => Number.isInteger(p.clientId) && Number.isInteger(p.id)).map((p) => ({ client_id: p.clientId, id: p.id })))}::jsonb) AS x(client_id int, id int)
          WHERE c.id = x.id AND c.client_id = x.client_id AND c.kind = 'reminder' AND c.read IS NOT TRUE AND COALESCE(c.dedupe_key, '') <> '' RETURNING c.id`,
  /** The erase's and the reset's own time (a client with many rows, the whole table): inside their transaction. */
  longStatement: () => sql`SET LOCAL statement_timeout = '60s'`,
  tickOff: (t: NotesTable, clientId: number, ids: readonly number[]) =>
    sql`UPDATE ${T(t)} SET read = true, extra = norcoach_column_set(extra, 'read') WHERE client_id = ${clientId}::int AND id IN ${INTS(ids)}
          AND kind = 'reminder' AND read IS NOT TRUE AND COALESCE(dedupe_key, '') <> '' RETURNING id`,
  reword: (t: NotesTable, clientId: number, id: number, text: string) =>
    sql`UPDATE ${T(t)} SET message = ${cleanText(text)}::text, extra = norcoach_column_set(extra, 'message') WHERE id = ${id}::int AND client_id = ${clientId}::int RETURNING id`,
  delete: (t: NotesTable, clientId: number, id: number) => sql`DELETE FROM ${T(t)} WHERE id = ${id}::int AND client_id = ${clientId}::int RETURNING id`,
  clientDelete: (t: NotesTable, clientId: number) => sql`DELETE FROM ${T(t)} WHERE client_id = ${clientId}::int RETURNING id`,
  wipe: (t: NotesTable) => sql`DELETE FROM ${T(t)} RETURNING id`,
  /** An outbox op's token claimed, in the op's own transaction: nothing back means it ran already (outbox.ts runOp). */
  claimOp: (token: string) => sql`INSERT INTO coach_activity_ops (token) VALUES (${token}::text) ON CONFLICT (token) DO NOTHING RETURNING token`,
  /** What the op did, written in its transaction once its statements ran. */
  setOpOutcome: (token: string, outcome: string) => sql`UPDATE coach_activity_ops SET outcome = ${outcome}::text WHERE token = ${token}::text`,
  /** What an op that already ran did (a retry asks). */
  opOutcome: (token: string) => sql`SELECT outcome FROM coach_activity_ops WHERE token = ${token}::text`,
  /** Tokens older than 30 days (the pg boot): an op that old is long drained, or dead. */
  pruneOps: () => sql`DELETE FROM coach_activity_ops WHERE at < now() - interval '30 days' AND token <> '__notes_pg_boot' RETURNING token`,
};

export type { SQL };
