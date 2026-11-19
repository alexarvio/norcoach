// Before a boot with CHAT_STORE=pg serves anyone (Step 5's cut-over; pg/runtime.ts): the database holds what the door's
// SQL leans on, and every statement runs: each read in a read-only transaction; each write inside one transaction rolled
// back (on a client and a file that are never one: -1, /uploads/-preflight-); the two that walk the whole table (the
// wipe, toPrepare) planned with EXPLAIN alone, never run. Any failure stops the boot with nothing changed, the data safe;
// nothing is served meanwhile, so the night time-boxes it (docs/database-plan.md) and scripts/chat-preflight.ts runs the
// same checks read-only on production beforehand. One instance at a time is the lease's (pg/lease.ts), taken before this.

import { sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { getTableColumns } from "drizzle-orm";
import { chat_messages } from "../pg/schema";
import { insertParams } from "./params";
import { safeMessage } from "./pg";
import { readSql, verifySql, writeSql } from "./statements";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyDb = PgDatabase<any, any, any>;
type Row = Record<string, unknown>;
const rowsOf = (r: unknown): Row[] => ((r as { rows?: Row[] })?.rows ?? []) as Row[];

const FUNCTIONS = ["norcoach_js_trim", "norcoach_has_words", "norcoach_react", "norcoach_column_set", "norcoach_stamp"];
const INDEXES = ["chat_messages_client_id_idx", "chat_messages_client_sent_idx", "chat_messages_client_text_idx", "chat_messages_coach_last_idx", "chat_messages_media_path_idx"];

/** Rolls a transaction back on purpose (the smoke test's writes). */
class RolledBack extends Error {}

/** Throws, with what is wrong, unless the database is ready for CHAT_STORE=pg. */
export async function chatPreflight(db: AnyDb): Promise<void> {
  const problems: string[] = [];
  const one = async (q: ReturnType<typeof sql>) => rowsOf(await db.execute(q));
  const fns = new Set((await one(sql`SELECT proname FROM pg_proc WHERE proname = ANY(${`{${FUNCTIONS.join(",")}}`}::text[])`)).map((r) => String(r.proname)));
  for (const f of FUNCTIONS) if (!fns.has(f)) problems.push(`the function ${f} is missing (migrations 0016, 0018)`);
  const idx = await one(sql`SELECT c.relname, i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = ANY(${`{${INDEXES.join(",")}}`}::text[])`);
  for (const name of INDEXES) {
    const found = idx.find((r) => r.relname === name);
    if (!found) problems.push(`the index ${name} is missing (migration 0018)`);
    else if (found.indisvalid === false) problems.push(`the index ${name} is not valid`);
  }
  if (!(await one(sql`SELECT to_regclass('chat_messages_id_seq') IS NOT NULL AS ok`))[0]?.ok) problems.push("the sequence chat_messages_id_seq is missing (migration 0015)");
  const cols = new Set((await one(sql`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'chat_messages'`)).map((r) => String(r.column_name)));
  for (const c of Object.values(getTableColumns(chat_messages))) if (!cols.has(c.name)) problems.push(`chat_messages has no column ${c.name}`);
  const pk = await one(sql`SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
                            WHERE i.indrelid = 'once_keys'::regclass AND i.indisprimary`);
  if (pk.length !== 1 || pk[0].attname !== "key") problems.push("once_keys has no primary key on key");
  if (problems.length) throw new Error(`[chat] Refusing to start with CHAT_STORE=pg: ${problems.join("; ")}`);

  // Every statement runs (on a client that is never one: -1), the writes inside a transaction rolled back.
  const none = [-1];
  for (const q of [
    readSql.thread("chat_messages", -1),
    readSql.food("chat_messages", -1),
    readSql.coachSent("chat_messages", none),
    readSql.coachLast("chat_messages", none, none),
    readSql.dockLast("chat_messages", none),
    readSql.dockRecent("chat_messages", none, Date.now()),
    readSql.clientTop("chat_messages", none, 60, none),
    readSql.coachTop("chat_messages", none, 200, none),
    readSql.needs("chat_messages", JSON.stringify([{ cid: -1, after: null }]), none),
    readSql.recent("chat_messages", none, new Date().toISOString()),
    readSql.since("chat_messages", none, new Date().toISOString()),
    readSql.straysRows("chat_messages", none, none),
    readSql.exists("chat_messages", "/uploads/-preflight-"),
    readSql.lacksLook("chat_messages", "/uploads/-preflight-"),
    readSql.exportRows("chat_messages", none),
    readSql.page("chat_messages", 2147483646, 1),
    // The whole-table ones planned, not run (EXPLAIN alone parses and plans: a missing column or function fails here).
    sql`EXPLAIN ${readSql.toPrepare("chat_messages")}`,
    sql`EXPLAIN ${writeSql.wipe("chat_messages")}`,
    verifySql.byId("chat_messages", -1),
    verifySql.byPath("chat_messages", "/uploads/-preflight-"),
    verifySql.onceTaken("once_keys", "preflight:-1"),
  ]) {
    await db.transaction(async (tx) => {
      await (tx as unknown as AnyDb).execute(q);
    }, { accessMode: "read only" });
  }
  try {
    await db.transaction(async (tx) => {
      const t = tx as unknown as AnyDb;
      const p = insertParams({ id: -1, client_id: -1, sender: "coach", text: "preflight", media_path: null, media_type: null, created_at: new Date().toISOString() } as never, null, { key: "preflight:-1", at: Date.now(), result: true }, { date: "2000-01-01", meal: "x" });
      await t.execute(writeSql.mealLock(-1, "2000-01-01", "x"));
      if (rowsOf(await t.execute(writeSql.insert("chat_messages", "once_keys", p))).length !== 1) throw new Error("the insert wrote nothing");
      await t.execute(writeSql.react("chat_messages", -1, -1, "client", "👍"));
      await t.execute(writeSql.edit("chat_messages", -1, -1, "coach", "preflight 2", new Date().toISOString(), false));
      await t.execute(writeSql.link("chat_messages", -1, -1, null));
      await t.execute(writeSql.pin("chat_messages", -1, -1, true));
      await t.execute(writeSql.remove("chat_messages", -1, -1, "coach", false));
      await t.execute(writeSql.look("chat_messages", "/uploads/-preflight-", JSON.stringify({ media_thumb: null, media_w: 1, media_h: 1 })));
      await t.execute(writeSql.swap("chat_messages", "/uploads/-preflight-", "/uploads/-preflight-2"));
      await t.execute(writeSql.clientDelete("chat_messages", -1));
      throw new RolledBack();
    });
  } catch (error) {
    if (!(error instanceof RolledBack)) throw new Error(`[chat] Refusing to start with CHAT_STORE=pg: a write statement failed: ${safeMessage(error)}`);
  }
}
