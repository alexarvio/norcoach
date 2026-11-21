// Before a boot with NOTES_STORE=pg serves anyone (quest 7; pg/runtime.ts), after the pg boot made the unique rule
// (boot.ts): the database holds what the notes' SQL leans on, and every statement runs: each read in a read-only
// transaction; each write inside one transaction rolled back (on client -1, never one); the wipe planned with EXPLAIN
// alone. Any failure stops the boot with nothing changed. scripts/notes-preflight.ts runs the same checks on production
// beforehand (read only: there the unique rule is not made, and its absence is said, not refused).

import { getTableColumns, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { NoteRow } from "../db";
import { coach_activity } from "../pg/schema";
import { safeMessage } from "./pg";
import { noteParams, readSql, writeSql } from "./statements";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyDb = PgDatabase<any, any, any>;
type Row = Record<string, unknown>;
const rowsOf = (r: unknown): Row[] => ((r as { rows?: Row[] })?.rows ?? []) as Row[];

export const NOTES_INDEXES = [
  "coach_activity_client_text_idx",
  "coach_activity_client_key_idx",
  "coach_activity_unread_reminder_idx",
  "coach_activity_message_idx",
  "coach_activity_note_words_idx",
] as const;
export const NOTES_UNIQUE = "coach_activity_dedupe_uq";
class RolledBack extends Error {}

/** What is missing, in words (empty: ready). `unique`: the unique rule must be there too (a pg boot, after making it). */
export async function notesProblems(db: AnyDb, opts: { unique: boolean }): Promise<string[]> {
  const problems: string[] = [];
  const one = async (q: ReturnType<typeof sql>) => rowsOf(await db.execute(q));
  const names = [...NOTES_INDEXES, NOTES_UNIQUE, "coach_activity_shadow_dedupe_uq"];
  const idx = await one(sql`SELECT c.relname, i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname IN (SELECT jsonb_array_elements_text(${JSON.stringify(names)}::jsonb))`);
  for (const name of [...NOTES_INDEXES, "coach_activity_shadow_dedupe_uq", ...(opts.unique ? [NOTES_UNIQUE] : [])]) {
    const found = idx.find((r) => r.relname === name);
    if (!found) problems.push(`the index ${name} is missing (${name === NOTES_UNIQUE ? "made by a NOTES_STORE=pg boot" : "migration 0020"})`);
    else if (found.indisvalid === false) problems.push(`the index ${name} is not valid`);
  }
  if (!(await one(sql`SELECT to_regclass('coach_activity_id_seq') IS NOT NULL AS ok`))[0]?.ok) problems.push("the sequence coach_activity_id_seq is missing (migration 0015)");
  for (const fn of ["norcoach_column_set"]) if (!(await one(sql`SELECT 1 FROM pg_proc WHERE proname = ${fn}`)).length) problems.push(`the function ${fn} is missing (migration 0018)`);
  // The ops' tokens: made by 0020, and by a pg boot before this check runs again (`unique`).
  if (opts.unique && !(await one(sql`SELECT to_regclass('coach_activity_ops') IS NOT NULL AS ok`))[0]?.ok) problems.push("the table coach_activity_ops is missing (migration 0020)");
  for (const table of ["coach_activity", "coach_activity_shadow", "coach_activity_twins"]) {
    const cols = new Set((await one(sql`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ${table}`)).map((r) => String(r.column_name)));
    for (const c of Object.values(getTableColumns(coach_activity))) if (!cols.has(c.name)) problems.push(`${table} has no column ${c.name}`);
  }
  return problems;
}

/** Throws, with what is wrong, unless the database is ready for NOTES_STORE=pg. */
export async function notesPreflight(db: AnyDb): Promise<void> {
  const problems = await notesProblems(db, { unique: true });
  if (problems.length) throw new Error(`[notes] Refusing to start with NOTES_STORE=pg: ${problems.join("; ")}`);
  const T = "coach_activity" as const;
  for (const q of [
    readSql.newest(T, -1, 500),
    readSql.whole(T, -1),
    readSql.keys(T, -1, ["preflight:-1"]),
    readSql.family(T, -1, "photos-remind:", ":2000-01-01"),
    readSql.ids(T, [-1]),
    readSql.owner(T, -1),
    readSql.chatNote(T, -1, -1, "preflight"),
    readSql.chatNote(T, -1, -1, null),
    readSql.unreadClients(T),
    readSql.reminderKeys(T, [{ clientId: -1, key: "reminder:x:-1:2000-01-01" }]),
    readSql.unreadReminders(T, [-1]),
    readSql.claimedTokens(["preflight"]),
    readSql.export(T, [-1]),
    readSql.page(T, 2147483646, 1),
    readSql.strays(T),
    sql`EXPLAIN ${writeSql.wipe(T)}`,
    sql`EXPLAIN ${writeSql.pruneOps()}`,
  ]) {
    await db.transaction(async (tx) => {
      await (tx as unknown as AnyDb).execute(q);
    }, { accessMode: "read only" });
  }
  try {
    await db.transaction(async (tx) => {
      const t = tx as unknown as AnyDb;
      const row: NoteRow = { id: -1, client_id: -1, message: "preflight", created_at: new Date().toISOString(), kind: "general", read: false, action_tab: null, action_label: null, action_ref: null, dedupe_key: "preflight:-1" };
      if (rowsOf(await t.execute(writeSql.insertKeyed(T, noteParams(row)))).length !== 1) throw new Error("the keyed insert wrote nothing");
      if (rowsOf(await t.execute(writeSql.insertKeyed(T, noteParams({ ...row, id: -2 })))).length !== 0) throw new Error("the key's rule did not hold a second row");
      if (rowsOf(await t.execute(writeSql.lockKeyed(T, -1, "preflight:-1"))).length !== 1) throw new Error("the keyed row could not be locked");
      await t.execute(writeSql.update(T, noteParams({ ...row, message: "preflight 2" })));
      await t.execute(writeSql.insertPlain(T, noteParams({ ...row, id: -3, dedupe_key: null })));
      await t.execute(writeSql.read(T, -1, -1));
      await t.execute(writeSql.readCoachNotes(T, -1));
      await t.execute(writeSql.readAll(T, -1));
      await t.execute(writeSql.readAll(T, -1, 0));
      await t.execute(writeSql.tickOff(T, -1, [-1]));
      if (rowsOf(await t.execute(writeSql.insertMany(T, [noteParams({ ...row, id: -4, dedupe_key: "preflight:-4", kind: "reminder" })]))).length !== 1) throw new Error("the reminders' insert wrote nothing");
      if (rowsOf(await t.execute(writeSql.insertMany(T, [noteParams({ ...row, id: -5, dedupe_key: "preflight:-4", kind: "reminder" })]))).length !== 0) throw new Error("the reminders' insert wrote a key twice");
      if (rowsOf(await t.execute(writeSql.tickOffMany(T, [{ clientId: -1, id: -4 }]))).length !== 1) throw new Error("the reminders' tick-off marked nothing");
      await t.execute(writeSql.longStatement());
      await t.execute(writeSql.reword(T, -1, -1, "preflight 3"));
      await t.execute(writeSql.drop(T, -1, "preflight:-1"));
      await t.execute(writeSql.delete(T, -1, -3));
      await t.execute(writeSql.clientDelete(T, -1));
      if (rowsOf(await t.execute(writeSql.claimOp("preflight"))).length !== 1) throw new Error("an op's token could not be claimed");
      if (rowsOf(await t.execute(writeSql.claimOp("preflight"))).length !== 0) throw new Error("an op's token was claimed twice");
      throw new RolledBack();
    });
  } catch (error) {
    if (!(error instanceof RolledBack)) throw new Error(`[notes] Refusing to start with NOTES_STORE=pg: a write statement failed: ${safeMessage(error)}`);
  }
}
