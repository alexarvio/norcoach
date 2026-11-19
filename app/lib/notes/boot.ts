// The notifications at boot (quest 7; called by pg/runtime.ts).
//
// A NOTES_STORE=pg boot, under the lease (pg/lease.ts), before the preflight:
//   - in one transaction, the table locked against writes: twins on (client, key) moved to coach_activity_twins (the
//     lowest id kept, as memory's find kept it), then the unique rule on (client_id, md5(dedupe_key)) made, which the
//     drainer's ON CONFLICT leans on. Made here and only here: a memory boot drops it, so a twin can never block a
//     memory-mode save (the writer upserts every changed row in one transaction);
//   - created_at_tz put right where it isn't what the writer would write (a build that didn't fill it);
//   - the clients with a stamp the database orders otherwise (read whole: pick.ts isStrayStamp);
//   - a coach message's note linked to its message where today's rule links them exactly (the same words, within 5 s,
//     each the other's only match, the message not linked yet): its id put in the note's extra.message_id;
//   - the highest id (for `_seq`), orphans said (rows of clients no longer in the store; never deleted).
// A memory boot of this build: the unique rule dropped (a no-op when absent), and an outbox a pg instance left in kv
// applied to the store's list with each op's own id and stamp (no buzz), the key then gone. The lease is waited for
// first when kv holds an outbox, so a stopping pg instance's last ops are in it.

import { sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { Data, NoteRow } from "../db";
import { toSentry } from "../pg/health";
import { insertRowsOnce } from "../pg/store";
import { stampInstantMs } from "../pg/stamps";
import { NOTES_OUTBOX } from "./mode";
import { boxEntries, boxTokens, replayInto, type OutboxEntry } from "./outbox";
import { NOTES_UNIQUE } from "./preflight";
import { pruneSql } from "./prune";
import { readSql, writeSql } from "./statements";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyDb = PgDatabase<any, any, any>;
type Row = Record<string, unknown>;
const rowsOf = (r: unknown): Row[] => ((r as { rows?: Row[] })?.rows ?? []) as Row[];
const log = (m: string) => console.log(`[notes] ${m}`);

/** Whether kv holds an outbox (a pg instance ran): a memory boot then waits for the lease. An error stops the boot: an
 *  answer of "no" it couldn't give would let this boot drop the unique rule under a pg instance still running. */
export async function kvHoldsOutbox(db: AnyDb): Promise<boolean> {
  return rowsOf(await db.execute(sql`SELECT 1 FROM kv WHERE key = ${NOTES_OUTBOX}`)).length > 0;
}

/**
 * What the last pg boot checked: the rows up to `checkedTo` are stamped and linked, `strays` their clients read whole.
 * A boot after it looks only at the rows past it, so a deploy in pg mode doesn't scan the table. Kept as one row of
 * coach_activity_ops (its token NOTES_BOOT_MARK, never a UUID; the prune leaves it), never in kv, so the store and
 * every build that loads it never see it.
 */
export const NOTES_BOOT_MARK = "__notes_pg_boot";
type BootMark = { v: 1; checkedTo: number; strays: number[] };
async function readMark(db: AnyDb): Promise<BootMark | null> {
  const raw = rowsOf(await db.execute(sql`SELECT outcome FROM coach_activity_ops WHERE token = ${NOTES_BOOT_MARK}`))[0]?.outcome;
  try {
    const v = typeof raw === "string" ? (JSON.parse(raw) as BootMark) : null;
    return v && v.v === 1 && Number.isInteger(v.checkedTo) && Array.isArray(v.strays) ? v : null;
  } catch {
    return null;
  }
}

/** The ops' tokens past 30 days let go (in the background, after the boot: nothing waits on it). */
export async function pruneOpTokens(db: AnyDb): Promise<void> {
  try {
    const pruned = rowsOf(await db.execute(writeSql.pruneOps())).length;
    if (pruned) log(`${pruned} op tokens past 30 days let go`);
  } catch (error) {
    console.error("[notes] the op tokens could not be pruned:", error instanceof Error ? error.message : error);
  }
}

/** Twins on (client, key) out to coach_activity_twins, the lowest id kept, then the unique rule; in one transaction, the
 *  table locked against writes. `from`: only keys a row past that id holds (a twin needs a row written since the last
 *  pg boot, when the rule last held); 0 for every key. A row is deleted only once its copy is in coach_activity_twins. */
async function twinPass(db: AnyDb, from: number): Promise<number> {
  let twins = 0;
  await db.transaction(async (tx) => {
    const t = tx as unknown as AnyDb;
    await t.execute(sql`LOCK TABLE coach_activity IN SHARE ROW EXCLUSIVE MODE`);
    const moved = rowsOf(
      await t.execute(sql`WITH fresh AS (
          SELECT DISTINCT client_id, md5(dedupe_key) AS h FROM coach_activity WHERE dedupe_key IS NOT NULL AND id > ${from}::int),
        t AS (
          SELECT c.id, row_number() OVER (PARTITION BY c.client_id, md5(c.dedupe_key), c.dedupe_key ORDER BY c.id) AS rn FROM coach_activity c
           WHERE c.dedupe_key IS NOT NULL AND (${from}::int = 0 OR (c.client_id, md5(c.dedupe_key)) IN (SELECT client_id, h FROM fresh))),
        kept AS (
          INSERT INTO coach_activity_twins (id, client_id, message, created_at, kind, read, action_tab, action_label, action_ref, dedupe_key, extra, created_at_tz)
          SELECT c.id, c.client_id, c.message, c.created_at, c.kind, c.read, c.action_tab, c.action_label, c.action_ref, c.dedupe_key, c.extra, c.created_at_tz
            FROM coach_activity c JOIN t ON t.id = c.id WHERE t.rn > 1
          ON CONFLICT (id) DO UPDATE SET client_id = EXCLUDED.client_id, message = EXCLUDED.message, created_at = EXCLUDED.created_at, kind = EXCLUDED.kind,
            read = EXCLUDED.read, action_tab = EXCLUDED.action_tab, action_label = EXCLUDED.action_label, action_ref = EXCLUDED.action_ref,
            dedupe_key = EXCLUDED.dedupe_key, extra = EXCLUDED.extra, created_at_tz = EXCLUDED.created_at_tz, removed_at = now()
          RETURNING id)
        DELETE FROM coach_activity c USING kept WHERE c.id = kept.id RETURNING c.id`)
    );
    twins = moved.length;
    await t.execute(sql.raw(`CREATE UNIQUE INDEX IF NOT EXISTS "${NOTES_UNIQUE}" ON coach_activity (client_id, md5(dedupe_key)) WHERE dedupe_key IS NOT NULL`));
  });
  return twins;
}

/** A pg boot's own work on the table (above). */
export async function notesBootPg(db: AnyDb): Promise<{ maxId: number; strays: number[]; twins: number; linked: number; restamped: number }> {
  // The ops' tokens (outbox.ts runOp): made here too, as 0020 makes it, for a database that ran an earlier 0020 without
  // it (a local copy). Pruned after the boot (pruneOpTokens).
  await db.execute(sql`CREATE TABLE IF NOT EXISTS coach_activity_ops (token text PRIMARY KEY NOT NULL, at timestamp with time zone DEFAULT now() NOT NULL, outcome text)`);
  await db.execute(sql`ALTER TABLE coach_activity_ops ADD COLUMN IF NOT EXISTS outcome text`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS coach_activity_ops_at_idx ON coach_activity_ops (at)`);
  // The read reminders, oldest first (19 Nov, the nightly clean-up, notes/prune.ts): so a night reads only the ones it
  // may delete, not the table. Here and not in a migration, as the unique rule: memory mode never reads by it. Only the
  // first pg boot builds it (IF NOT EXISTS); it is left by a memory boot (it blocks no save).
  await db.execute(pruneSql.index());
  const mark = await readMark(db);
  const from = mark?.checkedTo ?? 0;
  // The unique rule there and valid (a pg boot after a pg boot): no twin can be, nothing to move. Else (a memory boot
  // dropped it) the keys written since the mark; should an older twin still stop the rule (a restore), every key.
  const rule = rowsOf(await db.execute(sql`SELECT i.indisvalid AS ok FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = ${NOTES_UNIQUE}`))[0];
  let twins = 0;
  if (rule?.ok !== true) {
    if (rule) await db.execute(sql.raw(`DROP INDEX IF EXISTS "${NOTES_UNIQUE}"`));
    try {
      twins = await twinPass(db, from);
    } catch (error) {
      if (from === 0 || String((error as { cause?: { code?: unknown } })?.cause?.code ?? (error as { code?: unknown })?.code ?? "") !== "23505") throw error;
      log("an older twin held the unique rule back: every key looked at");
      twins = await twinPass(db, 0);
    }
  }
  if (twins) {
    console.error(`[notes] !!! ${twins} twin rows on (client, key) moved to coach_activity_twins (the lowest id of each kept)`);
    toSentry((S) => S.captureMessage(`Notes twins moved: ${twins}`, { level: "warning", tags: { alert: "notes-twins" } }));
  }

  let maxId = from;
  let restamped = 0;
  for (let after = from; ; ) {
    const page = rowsOf(await db.execute(sql`SELECT id, created_at, (EXTRACT(EPOCH FROM created_at_tz) * 1000)::float8 AS ms FROM coach_activity WHERE id > ${after}::int ORDER BY id LIMIT 5000`));
    if (!page.length) break;
    const fix: { id: number; tz: string | null }[] = [];
    for (const r of page) {
      const want = stampInstantMs(r.created_at);
      const have = r.ms == null ? null : Math.round(Number(r.ms));
      if (want !== have) fix.push({ id: Number(r.id), tz: want == null ? null : new Date(want).toISOString() });
      maxId = Math.max(maxId, Number(r.id));
    }
    for (let i = 0; i < fix.length; i += 500) {
      const part = fix.slice(i, i + 500);
      await db.execute(
        sql`UPDATE coach_activity c SET created_at_tz = (v ->> 'tz')::timestamptz FROM jsonb_array_elements(${JSON.stringify(part)}::jsonb) v WHERE c.id = (v ->> 'id')::int`
      );
    }
    restamped += fix.length;
    after = Number(page[page.length - 1].id);
  }
  // The rows' highest id however they ended (the mark's may be gone): the pkey's own answer.
  maxId = Math.max(maxId, Number(rowsOf(await db.execute(sql`SELECT COALESCE(max(id), 0)::int AS m FROM coach_activity`))[0]?.m ?? 0));
  const fresh = rowsOf(await db.execute(sql`SELECT DISTINCT client_id FROM coach_activity WHERE id > ${from}::int AND (created_at IS NULL OR created_at !~ '^[ -~]*$')`)).map((r) => Number(r.client_id));
  const strays = [...new Set([...(mark?.strays ?? []), ...fresh])].sort((a, b) => a - b);
  const linked = await backfillMessageIds(db, { fromId: from });
  // The mark for the next pg boot, once all of the above is in.
  const next: BootMark = { v: 1, checkedTo: maxId, strays };
  await db.execute(
    sql`INSERT INTO coach_activity_ops (token, outcome) VALUES (${NOTES_BOOT_MARK}, ${JSON.stringify(next)}::text) ON CONFLICT (token) DO UPDATE SET outcome = EXCLUDED.outcome, at = now()`
  );
  log(`pg: from id ${from}, max id ${maxId}, restamped ${restamped}, stray clients ${strays.length}, twins ${twins}, linked ${linked.linked} (ambiguous ${linked.ambiguous}, no match ${linked.none})`);
  return { maxId, strays, twins, linked: linked.linked, restamped };
}

/**
 * Links a coach note to its message only where today's words-and-5-s rule picks exactly that pair. Ids and counts
 * logged. `fromId`: only the notes past it (the boot mark's; every note when 0), and only the messages and notes near
 * them in time (the rule's 5 s and some), so a deploy doesn't pull the chat's words back into memory.
 */
export async function backfillMessageIds(db: AnyDb, opts: { dryRun?: boolean; fromId?: number } = {}): Promise<{ linked: number; ambiguous: number; none: number }> {
  const fromId = opts.fromId ?? 0;
  const UNLINKED = sql`kind = 'coach_note' AND (extra IS NULL OR NOT jsonb_exists(extra, 'message_id'))`;
  const notes = rowsOf(await db.execute(sql`SELECT id, client_id, message, created_at, extra FROM coach_activity WHERE ${UNLINKED} AND id > ${fromId}::int ORDER BY id`));
  if (!notes.length) return { linked: 0, ambiguous: 0, none: 0 };
  const at = (s: unknown) => (typeof s === "string" ? new Date(s).getTime() : NaN);
  const clients = [...new Set(notes.map((n) => Number(n.client_id)))];
  const CLIENTS = sql`(SELECT (v)::int FROM jsonb_array_elements_text(${JSON.stringify(clients)}::jsonb) v)`;
  // The window: from 15 s before the earliest note (a match is within 5 s, and its rivals within 5 s of it). Every row
  // when a note has no readable stamp, or on the first boot (fromId 0).
  const times = notes.map((n) => at(n.created_at)).filter((t) => Number.isFinite(t));
  const since = fromId > 0 && times.length === notes.length ? new Date(Math.min(...times) - 15_000).toISOString() : null;
  // The other unlinked notes of these clients in the window (a message matching two notes links neither), and the
  // messages already linked to one.
  // (A row with no instant is always in: the window never hides a rival.)
  const near = since == null ? [] : rowsOf(await db.execute(sql`SELECT id, client_id, message, created_at FROM coach_activity WHERE ${UNLINKED} AND client_id IN ${CLIENTS} AND (created_at_tz >= ${since}::timestamptz OR created_at_tz IS NULL) ORDER BY id`));
  const rivals = [...new Map([...notes, ...near].map((n) => [Number(n.id), n])).values()];
  const taken = new Set(
    rowsOf(await db.execute(sql`SELECT (extra ->> 'message_id') AS m FROM coach_activity WHERE kind = 'coach_note' AND client_id IN ${CLIENTS} AND jsonb_exists(extra, 'message_id')`)).map((r) => String(r.m))
  );
  // Read only, at a NOTES_STORE=pg boot, before any request: the table is current in both chat modes (memory mode's
  // writer mirrors it), and nothing here writes it.
  const WINDOW = since == null ? sql`` : sql`AND (created_at_tz >= ${since}::timestamptz OR created_at_tz IS NULL)`;
  // chat-door: the read just said (the coach's messages of these clients, in the window).
  const msgs = rowsOf(await db.execute(sql`SELECT id, client_id, text, created_at FROM chat_messages WHERE sender = 'coach' AND client_id IN ${CLIENTS} ${WINDOW} ORDER BY id`));
  const matches = (n: Row, m: Row) => n.client_id === m.client_id && n.message === m.text && Math.abs(at(n.created_at) - at(m.created_at)) < 5000;
  const byClient = new Map<number, Row[]>();
  for (const m of msgs) {
    const list = byClient.get(Number(m.client_id)) ?? [];
    list.push(m);
    byClient.set(Number(m.client_id), list);
  }
  const notesOf = new Map<number, Row[]>();
  for (const n of rivals) {
    const list = notesOf.get(Number(n.client_id)) ?? [];
    list.push(n);
    notesOf.set(Number(n.client_id), list);
  }
  let linked = 0;
  let ambiguous = 0;
  let none = 0;
  const links: { id: number; m: number }[] = [];
  for (const n of notes) {
    const cands = (byClient.get(Number(n.client_id)) ?? []).filter((m) => matches(n, m));
    if (!cands.length) {
      none++;
      continue;
    }
    const m = cands[0];
    const back = (notesOf.get(Number(n.client_id)) ?? []).filter((x) => matches(x, m));
    if (cands.length !== 1 || back.length !== 1 || taken.has(String(m.id))) {
      ambiguous++;
      continue;
    }
    links.push({ id: Number(n.id), m: Number(m.id) });
    taken.add(String(m.id));
    linked++;
  }
  if (!opts.dryRun)
    for (let i = 0; i < links.length; i += 500) {
      await db.execute(
        sql`UPDATE coach_activity c SET extra = COALESCE(c.extra, '{}'::jsonb) || jsonb_build_object('message_id', (v ->> 'm')::int)
              FROM jsonb_array_elements(${JSON.stringify(links.slice(i, i + 500))}::jsonb) v
              WHERE c.id = (v ->> 'id')::int AND NOT jsonb_exists(COALESCE(c.extra, '{}'::jsonb), 'message_id')`
      );
    }
  return { linked, ambiguous, none };
}

/** A memory boot of this build (above). Whether it changed the store (the boot then saves). */
export async function notesBootMemory(db: AnyDb, data: Partial<Data>, opts: { imported?: boolean } = {}): Promise<boolean> {
  try {
    await db.execute(sql.raw(`DROP INDEX IF EXISTS "${NOTES_UNIQUE}"`));
  } catch (error) {
    console.error("[notes] the unique rule could not be dropped:", error instanceof Error ? error.message : error);
  }
  const d = data as unknown as { [key: string]: unknown };
  if (Array.isArray(d.notes_outbox_dead) && d.notes_outbox_dead.length) {
    console.error(`[notes] !!! kv holds ${d.notes_outbox_dead.length} ops the table refused (notes_outbox_dead): not applied; look at them (docs/database-plan.md, the notes runbook)`);
    toSentry((S) => S.captureMessage(`Notes dead ops in kv: ${(d.notes_outbox_dead as unknown[]).length}`, { level: "warning", tags: { alert: "notes-outbox-dead" } }));
  }
  if (!(NOTES_OUTBOX in d)) return false;
  const box = d[NOTES_OUTBOX];
  // Which of its ops ran already (their token claimed by the drain's own transaction): the table holds what they did.
  // A box from an import (a dump into an empty database) has none to ask about.
  const claimed = new Set<string>();
  const tokens = boxTokens(box);
  if (!opts.imported && tokens.length) {
    const there = rowsOf(await db.execute(sql`SELECT to_regclass('coach_activity_ops') IS NOT NULL AS ok`))[0]?.ok === true;
    if (there)
      for (let i = 0; i < tokens.length; i += 1000)
        for (const r of rowsOf(await db.execute(readSql.claimedTokens(tokens.slice(i, i + 1000))))) claimed.add(String(r.token));
  }
  // An op not run that is old: the box outlived its instance (a build that doesn't know it ran in between, saving it as
  // it found it), and its ops may undo what came after them (a replace's words back, unread). Asked, not guessed.
  const now = Date.now();
  const old = boxEntries(box).filter((e) => !(e.token && claimed.has(e.token)) && typeof e.at === "number" && now - e.at > OLD_OUTBOX_MS);
  if (!opts.imported && old.length) {
    const asked = (process.env.NOTES_OLD_OUTBOX ?? "").trim();
    if (asked === "drop") {
      const gone = new Set(old.map((e) => e.seq));
      (box as { ops: OutboxEntry[] }).ops = boxEntries(box).filter((e) => !gone.has(e.seq));
      console.error(`[notes] !!! ${old.length} queued ops older than ${OLD_OUTBOX_MS / 60_000} minutes dropped (NOTES_OLD_OUTBOX=drop)`);
    } else if (asked !== "apply") {
      const oldest = Math.max(...old.map((e) => now - (e.at as number)));
      throw new Error(
        `[notes] Refusing to start: kv's notes_outbox holds ${old.length} ops a NOTES_STORE=pg instance queued and never wrote, the oldest ${Math.round(oldest / 60_000)} minutes old (a build ran in between without knowing them). Set NOTES_OLD_OUTBOX=apply to lay them over the table as they are, or NOTES_OLD_OUTBOX=drop to leave them out (docs/database-plan.md, the notes runbook), then unset it.`
      );
    }
  }
  const rows = Array.isArray(d.coach_activity) ? (d.coach_activity as NoteRow[]) : [];
  const res = replayInto(rows, box, claimed);
  d.coach_activity = res.rows;
  delete d[NOTES_OUTBOX];
  log(`memory: ${res.applied} queued ops left by a pg instance applied to the store (no buzz), ${res.claimed} that ran already left out, the outbox gone`);
  if (res.taken) console.error(`[notes] !!! ${res.taken} queued inserts left out: their ids are another row's (a build reused them)`);
  return true;
}
/** A queued op older than this, not run, stops a memory boot (NOTES_OLD_OUTBOX says what to do). */
const OLD_OUTBOX_MS = 60 * 60_000;

/**
 * A whole-store JSON into an empty database with the notifications in memory: one a NOTES_STORE=pg shutdown wrote holds
 * none (they were in Postgres), so it is refused unless ALLOW_JSON_WITHOUT_NOTES=1; its outbox, the ops that file
 * still held, applied to it as a memory boot applies one.
 */
export async function importNotesMemory(db: AnyDb, raw: Partial<Data>): Promise<boolean> {
  const r = raw as Record<string, unknown>;
  if (r._notes_in_postgres) {
    if (process.env.ALLOW_JSON_WITHOUT_NOTES !== "1") {
      throw new Error(
        "[store] Refusing to start: the JSON to import was written with NOTES_STORE=pg and holds no notifications (they are in Postgres). Restore the database instead (scripts/restore-pg-backup.mjs), or set ALLOW_JSON_WITHOUT_NOTES=1 to start without them."
      );
    }
    delete r._notes_in_postgres;
  }
  return notesBootMemory(db, raw, { imported: true });
}

/** The JSON import's notifications (NOTES_STORE=pg), into the table as the writer writes rows, then out of what loads. */
export async function importNotes(db: AnyDb, raw: Partial<Data>) {
  const r = raw as Record<string, unknown>;
  if (r._notes_in_postgres) {
    if (process.env.ALLOW_JSON_WITHOUT_NOTES !== "1") {
      throw new Error(
        "[store] Refusing to start: the JSON to import was written with NOTES_STORE=pg and holds no notifications (they are in Postgres). Restore the database instead (scripts/restore-pg-backup.mjs), or set ALLOW_JSON_WITHOUT_NOTES=1 to start without them."
      );
    }
    delete r._notes_in_postgres;
  }
  const list = r.coach_activity;
  delete r.coach_activity;
  if (!Array.isArray(list) || !list.length) return;
  const n = await insertRowsOnce(db, "coach_activity", list);
  log(`coach_activity: ${n} rows of the JSON imported into the table (NOTES_STORE=pg)`);
}

/** Rows of clients no longer in the store: said, never deleted. */
export async function reportNotesOrphans(db: AnyDb, data: Data) {
  try {
    const ids = JSON.stringify(data.clients.map((c) => c.id));
    const row = rowsOf(
      await db.execute(sql`SELECT count(*)::int AS n, count(DISTINCT client_id)::int AS clients FROM coach_activity WHERE client_id NOT IN (SELECT (v)::int FROM jsonb_array_elements_text(${ids}::jsonb) v)`)
    )[0];
    if (Number(row?.n ?? 0) > 0) {
      console.error(`[notes] !!! ${row?.n} notification rows of ${row?.clients} clients no longer in the store (kept; look at them)`);
      toSentry((S) => S.captureMessage(`Notification rows of removed clients: ${row?.n}`, { level: "warning", tags: { alert: "notes-orphans" } }));
    }
  } catch (error) {
    console.error("[notes] the orphan check failed:", error instanceof Error ? error.message : error);
  }
}
