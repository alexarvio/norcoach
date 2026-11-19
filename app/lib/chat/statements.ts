// The SQL each chat fetch and each chat write will run once chat leaves memory (18 Nov, Step 5 of
// docs/database-plan.md). Today the shadow runs them (shadow.ts): the reads beside the door's fetches, compared with
// what the last save committed; the writes (CHAT_SHADOW=write, staging) on chat_messages_shadow. At the cut-over the
// same text runs on chat_messages. The table is a parameter for that reason, and nothing here is ever pointed at
// chat_messages for a write until then (shadow.ts only passes the shadow tables to the writes).
//
// Every value is a bound parameter, cast where Postgres can't infer its type, made from the store row as the writer
// maps it (store.ts toRecord, then cleanJson), so a statement writes exactly what the writer would. A write is one
// statement, or one transaction where marked, so two people reacting at once never lose one: an UPDATE that reads the
// row in its own SET waits on the row's lock and re-reads the newest version (EvalPlanQual) before it writes.
//
// The pick each read stands for is in pick.ts, under the same name.

import { sql, type SQL } from "drizzle-orm";

export type ChatTable = "chat_messages" | "chat_messages_shadow";
export type OnceTable = "once_keys" | "once_keys_shadow";

const T = (name: ChatTable) => sql.identifier(name);
const O = (name: OnceTable) => sql.identifier(name);
/** An int[] literal: only whole numbers go in, so nothing else can. */
const ints = (ids: readonly number[]) => `{${ids.filter((n) => Number.isInteger(n)).join(",")}}`;
/** The columns of a coach-wide read: the row without its preview picture (pick.ts lean). */
const LEAN = sql.raw(`id, client_id, sender, text, media_path, media_type, created_at, (extra - 'media_thumb') AS extra`);
/** LEAN under the alias m. */
const LEAN_M = sql.raw(`m.id, m.client_id, m.sender, m.text, m.media_path, m.media_type, m.created_at, (m.extra - 'media_thumb') AS extra`);
/** A row a coach-wide cut counts (pick.ts countable): sent with words and an instant. */
const FEEDABLE = sql.raw(`m.sender = 'client' AND norcoach_has_words(m.text, m.media_path) AND m.created_at_tz IS NOT NULL`);
/** Not a stray, not linked to a session (an echo is always session-linked). */
const PLAIN = (strays: readonly number[]) =>
  sql`m.id <> ALL(${ints(strays)}::int[]) AND (m.extra#>>'{link,kind}') IS DISTINCT FROM 'session'`;
/** A meal comment's row: a food link with a meal (removeMealComment, editMealComment). */
const FOOD_MEAL = sql.raw(`(extra#>>'{link,kind}' = 'food' AND COALESCE(extra#>>'{link,meal}', '') <> '')`);

// ---- Reads --------------------------------------------------------------------------------------------------------

export const readSql = {
  /** pickThread */
  thread: (t: ChatTable, clientId: number) => sql`SELECT * FROM ${T(t)} WHERE client_id = ${clientId}::int ORDER BY id`,
  /** pickFood */
  food: (t: ChatTable, clientId: number) =>
    sql`SELECT * FROM ${T(t)} WHERE client_id = ${clientId}::int AND sender = 'coach' AND extra#>>'{link,kind}' = 'food' ORDER BY id`,
  /** pickCoachSent */
  coachSent: (t: ChatTable, clientIds: readonly number[]) =>
    sql`SELECT ${LEAN} FROM ${T(t)} WHERE client_id = ANY(${ints(clientIds)}::int[]) AND sender = 'client' ORDER BY id`,
  /**
   * pickCoachLast: the newest by instant, the lowest id between equal ones (a stable sort kept the store's order). One
   * client at a time (LATERAL … LIMIT 1), each read backwards on chat_messages_coach_last_idx until a row with words.
   */
  coachLast: (t: ChatTable, clientIds: readonly number[], strays: readonly number[] = []) =>
    sql`SELECT l.* FROM (SELECT DISTINCT unnest(${ints(clientIds)}::int[]) AS cid) c CROSS JOIN LATERAL (
          SELECT ${LEAN} FROM ${T(t)}
          WHERE client_id = c.cid AND sender = 'coach' AND norcoach_has_words(text, media_path)${strays.length ? sql` AND id <> ALL(${ints(strays)}::int[])` : sql``}
          ORDER BY created_at_tz DESC NULLS LAST, id ASC LIMIT 1) l ORDER BY l.id`,
  /**
   * pickClientTop: each client's rows sent with words from the instant of their n-th newest countable one on (with
   * words, an instant, not a stray, not linked to a session); all of them when they have fewer. On client_sent_idx,
   * read backwards per client.
   */
  clientTop: (t: ChatTable, clientIds: readonly number[], n: number, strays: readonly number[]) =>
    sql`SELECT r.* FROM (SELECT DISTINCT unnest(${ints(clientIds)}::int[]) AS cid) c
        LEFT JOIN LATERAL (
          SELECT m.created_at_tz AS cut FROM ${T(t)} m
          WHERE m.client_id = c.cid AND ${FEEDABLE} AND ${PLAIN(strays)}
          ORDER BY m.created_at_tz DESC OFFSET (${n}::int - 1) LIMIT 1) k ON true
        CROSS JOIN LATERAL (
          SELECT ${LEAN_M} FROM ${T(t)} m
          WHERE m.client_id = c.cid AND m.sender = 'client' AND norcoach_has_words(m.text, m.media_path)
            AND m.created_at_tz >= COALESCE(k.cut, '-infinity'::timestamptz)) r
        ORDER BY r.id`,
  /** pickCoachTop: the same cut across all these clients at once (each client's newest n, then the n-th of them all). */
  coachTop: (t: ChatTable, clientIds: readonly number[], n: number, strays: readonly number[]) =>
    sql`WITH c AS (SELECT DISTINCT unnest(${ints(clientIds)}::int[]) AS cid),
        per AS (SELECT l.tz FROM c CROSS JOIN LATERAL (
          SELECT m.created_at_tz AS tz FROM ${T(t)} m
          WHERE m.client_id = c.cid AND ${FEEDABLE} AND ${PLAIN(strays)}
          ORDER BY m.created_at_tz DESC LIMIT ${n}::int) l),
        cut AS (SELECT tz FROM per ORDER BY tz DESC OFFSET (${n}::int - 1) LIMIT 1)
        SELECT ${LEAN_M} FROM ${T(t)} m
        WHERE m.client_id IN (SELECT cid FROM c) AND m.sender = 'client' AND norcoach_has_words(m.text, m.media_path)
          AND m.created_at_tz >= COALESCE((SELECT tz FROM cut), '-infinity'::timestamptz)
        ORDER BY m.id`,
  /**
   * pickNeeds: each client's rows sent with words after both the coach's last message with words (by instant, strays
   * left out) and `after` (ISO, or null). `clients` is JSON: [{"cid": 12, "after": "2026-11-18T09:00:00.000Z"}].
   * A client with a stray with words: all their rows with words (the second branch, gated on that one lookup by id, so
   * it costs nothing for everyone else; see pickNeeds on why).
   */
  needs: (t: ChatTable, clients: string, strays: readonly number[]) =>
    sql`SELECT r.* FROM jsonb_to_recordset(${clients}::jsonb) AS c(cid int, after timestamptz)
        LEFT JOIN LATERAL (
          SELECT m.created_at_tz AS t FROM ${T(t)} m
          WHERE m.client_id = c.cid AND m.sender = 'coach' AND norcoach_has_words(m.text, m.media_path)
            AND m.created_at_tz IS NOT NULL AND m.id <> ALL(${ints(strays)}::int[])
          -- NULLS LAST as chat_messages_coach_last_idx holds them (none here), so the index gives the order.
          ORDER BY m.created_at_tz DESC NULLS LAST LIMIT 1) lc ON true
        CROSS JOIN LATERAL (
          SELECT ${LEAN_M} FROM ${T(t)} m
          WHERE m.client_id = c.cid AND m.sender = 'client' AND norcoach_has_words(m.text, m.media_path)
            AND m.created_at_tz > GREATEST(COALESCE(lc.t, '-infinity'::timestamptz), COALESCE(c.after, '-infinity'::timestamptz))
          UNION
          SELECT ${LEAN_M} FROM ${T(t)} m
          WHERE m.client_id = c.cid AND norcoach_has_words(m.text, m.media_path)
            AND EXISTS (SELECT 1 FROM ${T(t)} s WHERE s.id = ANY(${ints(strays)}::int[]) AND s.client_id = c.cid AND norcoach_has_words(s.text, s.media_path))) r
        ORDER BY r.id`,
  /** pickRecent: what they sent with words from `since` (ISO) on. No limit: markClientEventsSeen keeps its marks to it. */
  recent: (t: ChatTable, clientIds: readonly number[], since: string) =>
    sql`SELECT ${LEAN} FROM ${T(t)} WHERE client_id = ANY(${ints(clientIds)}::int[]) AND sender = 'client' AND norcoach_has_words(text, media_path)
          AND created_at_tz >= ${since}::timestamptz ORDER BY id`,
  /** pickSince: what they sent after `after` (ISO); the Feed's Since filters it as it filtered every row. */
  since: (t: ChatTable, clientIds: readonly number[], after: string) =>
    sql`SELECT ${LEAN} FROM ${T(t)} WHERE client_id = ANY(${ints(clientIds)}::int[]) AND sender = 'client' AND created_at_tz > ${after}::timestamptz ORDER BY id`,
  /** pickStrays: these clients' strays, either side's. */
  straysRows: (t: ChatTable, clientIds: readonly number[], strays: readonly number[]) =>
    sql`SELECT ${LEAN} FROM ${T(t)} WHERE id = ANY(${ints(strays)}::int[]) AND client_id = ANY(${ints(clientIds)}::int[]) ORDER BY id`,
  /** Every row from `afterId` on, `limit` at a time (the nightly JSON backup with CHAT_STORE=pg). */
  page: (t: ChatTable, afterId: number, limit: number) => sql`SELECT * FROM ${T(t)} WHERE id > ${afterId}::int ORDER BY id LIMIT ${limit}::int`,
  /**
   * pickDock, its last message: the thread's order is the stamp's text (byte order, as JS's < on ASCII), then the id. One
   * client at a time, on chat_messages_client_text_idx.
   */
  dockLast: (t: ChatTable, clientIds: readonly number[]) =>
    sql`SELECT l.* FROM (SELECT DISTINCT unnest(${ints(clientIds)}::int[]) AS cid) c CROSS JOIN LATERAL (
          SELECT ${LEAN} FROM ${T(t)}
          WHERE client_id = c.cid AND norcoach_has_words(text, media_path)
          ORDER BY created_at COLLATE "C" DESC, id DESC LIMIT 1) l ORDER BY l.id`,
  /** pickDock, what they sent from `since` (ms) on. */
  dockRecent: (t: ChatTable, clientIds: readonly number[], since: number) =>
    sql`SELECT ${LEAN} FROM ${T(t)} WHERE client_id = ANY(${ints(clientIds)}::int[]) AND sender = 'client' AND norcoach_has_words(text, media_path)
          AND created_at_tz >= to_timestamp(${since}::float8 / 1000) ORDER BY id`,
  /** pickExists */
  exists: (t: ChatTable, publicPath: string) => sql`SELECT EXISTS (SELECT 1 FROM ${T(t)} WHERE media_path = ${publicPath}::text) AS hit`,
  /** pickLacksLook */
  lacksLook: (t: ChatTable, publicPath: string) =>
    sql`SELECT EXISTS (SELECT 1 FROM ${T(t)} WHERE media_path = ${publicPath}::text AND COALESCE(extra->>'media_thumb', '') = '') AS hit`,
  /** pickToPrepare (sorted by id after) */
  toPrepare: (t: ChatTable) =>
    sql`SELECT DISTINCT ON (media_path) id, media_path, media_type FROM ${T(t)}
          WHERE media_type IN ('image', 'video') AND COALESCE(media_path, '') <> '' AND COALESCE(extra->>'media_thumb', '') = ''
          ORDER BY media_path, id`,
  /** pickExport */
  exportRows: (t: ChatTable, clientIds: readonly number[]) => sql`SELECT * FROM ${T(t)} WHERE client_id = ANY(${ints(clientIds)}::int[]) ORDER BY id`,
};

// ---- Writes -------------------------------------------------------------------------------------------------------

/** A new message, as the writer maps it (`extra` without reply_to: the statement decides the reply itself). */
export type InsertParams = {
  id: number;
  client_id: number;
  sender: string;
  text: string | null;
  media_path: string | null;
  media_type: string | null;
  created_at: string | null;
  /** JSON, or null. */
  extra: string | null;
  /** The message it answers, as asked; kept only when that message is in this chat. */
  replyTo: number | null;
  /** created_at's instant (pg/stamps.ts stampInstant). */
  createdAtTz: string | null;
  /** The send's once key (chatSend's nonce), written in the same statement: none written, no message. */
  /** `result`: what once() answers a second arrival with, as JSON (a media review's reply: true); null for a send (the shadow's too). */
  once: { key: string; at: number; extra: string | null; createdAt: string | null; result?: string | null } | null;
  /** A meal's comment: none if the meal has one already (two tabs). Run under insertNeedsLock's lock. */
  meal: { date: string; meal: string } | null;
};

export const writeSql = {
  insert: (t: ChatTable, o: OnceTable, p: InsertParams) => sql`
    WITH k AS (
      INSERT INTO ${O(o)} (key, at, result, redirect, extra, created_at)
      SELECT ${p.once?.key ?? null}::text, ${p.once?.at ?? null}::float8, ${p.once?.result ?? null}::jsonb, NULL, ${p.once?.extra ?? null}::jsonb, ${p.once?.createdAt ?? null}::timestamptz
      WHERE ${p.once?.key ?? null}::text IS NOT NULL
      ON CONFLICT (key) DO NOTHING
      RETURNING 1)
    INSERT INTO ${T(t)} (id, client_id, sender, text, media_path, media_type, created_at, extra, created_at_tz)
    SELECT ${p.id}::int, ${p.client_id}::int, ${p.sender}::text, ${p.text}::text, ${p.media_path}::text, ${p.media_type}::text, ${p.created_at}::text,
      NULLIF(COALESCE(${p.extra}::jsonb, '{}'::jsonb)
             || COALESCE((SELECT jsonb_build_object('reply_to', r.id) FROM ${T(t)} r WHERE r.id = ${p.replyTo}::int AND r.client_id = ${p.client_id}::int), '{}'::jsonb),
             '{}'::jsonb),
      ${p.createdAtTz}::timestamptz
    WHERE (${p.once?.key ?? null}::text IS NULL OR EXISTS (SELECT 1 FROM k))
      AND (${p.meal?.date ?? null}::text IS NULL OR NOT EXISTS (
        SELECT 1 FROM ${T(t)} c WHERE c.client_id = ${p.client_id}::int AND c.sender = 'coach' AND COALESCE(c.text, '') <> ''
          AND c.extra#>>'{link,kind}' = 'food' AND c.extra#>>'{link,date}' = ${p.meal?.date ?? null}::text
          AND COALESCE(c.extra#>>'{link,meal}', '') = ${p.meal?.meal ?? null}::text))
    RETURNING id, (extra -> 'reply_to') IS NOT NULL AS answered`,
  /** Taken first in the insert's transaction when it is a meal's comment: two tabs' comments go one after the other, the
   *  second seeing the first (NOT EXISTS alone doesn't: both statements' snapshots come before the other's commit). */
  mealLock: (clientId: number, date: string, meal: string) => sql`SELECT pg_advisory_xact_lock(hashtext(${`chat-meal:${clientId}:${date}:${meal}`}::text))`,
  /** One side's reaction set or taken off (null). */
  react: (t: ChatTable, id: number, clientId: number, who: string, emoji: string | null) =>
    sql`UPDATE ${T(t)} SET extra = norcoach_react(extra, ${who}::text, ${emoji}::text) WHERE id = ${id}::int AND client_id = ${clientId}::int RETURNING id`,
  /** Reworded: its text, and edited_at unless null (a meal comment's rewording sets none). What it said, and when. */
  edit: (t: ChatTable, id: number, clientId: number, sender: string, text: string, editedAt: string | null, foodMeal: boolean) => sql`
    UPDATE ${T(t)} m SET text = ${text}::text,
      extra = CASE WHEN ${editedAt}::text IS NULL THEN norcoach_column_set(m.extra, 'text')
                   ELSE COALESCE(norcoach_column_set(m.extra, 'text'), '{}'::jsonb) || jsonb_build_object('edited_at', ${editedAt}::text) END
    FROM (SELECT id, text AS was_text, created_at AS was_at FROM ${T(t)}
          WHERE id = ${id}::int AND client_id = ${clientId}::int AND sender = ${sender}::text AND (NOT ${foodMeal}::bool OR ${FOOD_MEAL})
          FOR UPDATE) o
    WHERE m.id = o.id AND o.was_text IS DISTINCT FROM ${text}::text
    RETURNING o.was_text, o.was_at`,
  /** Taken back: what it said, when, and its file. */
  remove: (t: ChatTable, id: number, clientId: number, sender: string, foodMeal: boolean) =>
    sql`DELETE FROM ${T(t)} WHERE id = ${id}::int AND client_id = ${clientId}::int AND sender = ${sender}::text AND (NOT ${foodMeal}::bool OR ${FOOD_MEAL})
        RETURNING text, created_at, media_path`,
  /** A coach message pointed at one thing, or its link taken off (null). */
  link: (t: ChatTable, id: number, clientId: number, link: string | null) => sql`
    UPDATE ${T(t)} SET extra = CASE WHEN ${link}::jsonb IS NULL THEN NULLIF(COALESCE(extra, '{}'::jsonb) - 'link', '{}'::jsonb)
                                    ELSE COALESCE(extra, '{}'::jsonb) || jsonb_build_object('link', ${link}::jsonb) END
    WHERE id = ${id}::int AND client_id = ${clientId}::int AND sender = 'coach' RETURNING id`,
  /** Kept at the top, or let go. */
  pin: (t: ChatTable, id: number, clientId: number, pinned: boolean) => sql`
    UPDATE ${T(t)} SET extra = CASE WHEN ${pinned}::bool THEN COALESCE(extra, '{}'::jsonb) || '{"pinned":true}'::jsonb
                                    ELSE NULLIF(COALESCE(extra, '{}'::jsonb) - 'pinned', '{}'::jsonb) END
    WHERE id = ${id}::int AND client_id = ${clientId}::int RETURNING id`,
  /** A file's look (preview and size) onto every message that shows it. `look` JSON: media_thumb, media_w, media_h. */
  look: (t: ChatTable, mediaPath: string, look: string) =>
    sql`UPDATE ${T(t)} SET extra = COALESCE(extra, '{}'::jsonb) || ${look}::jsonb WHERE media_path = ${mediaPath}::text RETURNING id, client_id`,
  /** A video's file swapped for its web copy on every message that shows it. */
  swap: (t: ChatTable, from: string, to: string) => sql`UPDATE ${T(t)} SET media_path = ${to}::text WHERE media_path = ${from}::text RETURNING id, client_id`,
  /** A client's whole chat, with the client. */
  clientDelete: (t: ChatTable, clientId: number) => sql`DELETE FROM ${T(t)} WHERE client_id = ${clientId}::int RETURNING id`,
  /** Every chat (the workspace reset). A DELETE, never TRUNCATE: no lock that stops the reads. */
  wipe: (t: ChatTable) => sql`DELETE FROM ${T(t)} RETURNING id`,
};

// ---- After a lost connection, with CHAT_STORE=pg (rows.ts): did the write commit? -----------------------------------

export const verifySql = {
  /** A message by id: its sender, words and stamp, and whether it answers one. */
  byId: (t: ChatTable, id: number) =>
    sql`SELECT id, client_id, sender, text, created_at, (extra -> 'reply_to') IS NOT NULL AS answered FROM ${T(t)} WHERE id = ${id}::int`,
  /** The messages that show a file. */
  byPath: (t: ChatTable, mediaPath: string) => sql`SELECT id, client_id FROM ${T(t)} WHERE media_path = ${mediaPath}::text ORDER BY id`,
  /** A once key already taken (chatSend's early look; the insert's own statement is the guard). */
  onceTaken: (o: OnceTable, key: string) => sql`SELECT 1 AS one FROM ${O(o)} WHERE key = ${key}::text`,
};

// ---- The shadow's own upkeep (never run on chat_messages) ------------------------------------------------------------

export const shadowSql = {
  /** The shadow tables filled from the real ones at boot, in one transaction. */
  seed: [
    sql`DELETE FROM chat_messages_shadow`,
    sql`INSERT INTO chat_messages_shadow SELECT * FROM chat_messages`,
    sql`DELETE FROM once_keys_shadow`,
    sql`INSERT INTO once_keys_shadow SELECT * FROM once_keys`,
  ] as SQL[],
  /** How many rows the shadow tables hold (emptied at boot while the write shadow is off). */
  held: sql`SELECT (SELECT count(*) FROM chat_messages_shadow) + (SELECT count(*) FROM once_keys_shadow) AS n`,
  /** The shadow tables emptied: a DELETE each, never TRUNCATE (no lock that would wait on a backup's read). */
  empty: [sql`DELETE FROM chat_messages_shadow`, sql`DELETE FROM once_keys_shadow`] as SQL[],
  /** One row of the shadow put back to the real one. */
  resync: (id: number) => [sql`DELETE FROM chat_messages_shadow WHERE id = ${id}::int`, sql`INSERT INTO chat_messages_shadow SELECT * FROM chat_messages WHERE id = ${id}::int`],
  /** The two tables compared: up to 50 ids that differ, and which columns. */
  compare: sql`
    SELECT COALESCE(r.id, s.id) AS id, r.id IS NULL AS no_real, s.id IS NULL AS no_shadow,
      r.client_id IS DISTINCT FROM s.client_id AS client_id, r.sender IS DISTINCT FROM s.sender AS sender, r.text IS DISTINCT FROM s.text AS text,
      r.media_path IS DISTINCT FROM s.media_path AS media_path, r.media_type IS DISTINCT FROM s.media_type AS media_type,
      r.created_at IS DISTINCT FROM s.created_at AS created_at, r.extra IS DISTINCT FROM s.extra AS extra,
      r.created_at_tz IS DISTINCT FROM s.created_at_tz AS created_at_tz,
      (SELECT array_agg(k ORDER BY k) FROM (
         SELECT k FROM jsonb_object_keys(COALESCE(r.extra, '{}'::jsonb)) k
         UNION SELECT k FROM jsonb_object_keys(COALESCE(s.extra, '{}'::jsonb)) k) keys
       WHERE (r.extra -> k) IS DISTINCT FROM (s.extra -> k)) AS extra_keys
    FROM chat_messages r FULL JOIN chat_messages_shadow s ON s.id = r.id
    WHERE ROW(r.client_id, r.sender, r.text, r.media_path, r.media_type, r.created_at, r.extra, r.created_at_tz)
          IS DISTINCT FROM ROW(s.client_id, s.sender, s.text, s.media_path, s.media_type, s.created_at, s.extra, s.created_at_tz)
    ORDER BY 1
    LIMIT 50`,
  /** Each pair's columns, to check the shadow is the same shape before writing to it. */
  columns: sql`SELECT table_name, column_name, data_type, ordinal_position FROM information_schema.columns
               WHERE table_schema = current_schema() AND table_name IN ('chat_messages', 'chat_messages_shadow', 'once_keys', 'once_keys_shadow')
               ORDER BY table_name, ordinal_position`,
};
