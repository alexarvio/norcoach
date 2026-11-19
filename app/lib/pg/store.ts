import { and, eq, getTableColumns, getTableName, inArray, sql } from "drizzle-orm";
import type { PgColumn as Column, PgDatabase, PgTable } from "drizzle-orm/pg-core";
import { reportSkipped, health, noteSaveCost, noteSaveTx } from "./health";
import { COLLECTIONS, DERIVED, kv, ROLLBACK_KV_COPIES, TABLE_NAMES_NOT_IN_KV } from "./schema";
import { msInstant, msInstantMs, stampInstant, stampInstantMs } from "./stamps";
import { WRITER_COLLECTIONS } from "./writerTables";
import { CHAT_PG } from "../chat/mode";
import { NOTES_PG } from "../notes/mode";
import { FOOD_PG, FOOD_TABLES } from "../food/mode";

// Loads the whole store from Postgres and saves changes back (phase 1).
//
// The app still works on one in-memory copy of the data (db.ts getData()),
// exactly as with ironline.json. What changes is where that copy lives
// between restarts: a save writes only the rows that changed since the last
// save, in one transaction, instead of rewriting a file. A crash mid-save
// leaves the previous complete state, never half a write.
//
// The mapping keeps every row identical after a round trip; see schema.ts.
//
// One bad value must never block every later save (17 Nov, the poison guard): a number past an integer column's
// range goes to `extra` as any value that doesn't fit; a NUL character (which Postgres text and jsonb refuse) is taken
// out of every string written, and a lone surrogate (which jsonb refuses) becomes U+FFFD; a row whose key is missing
// or unusable, or a value that can't be written as JSON, is left out and reported, the rest saved, and what the
// database held for it stays there (never deleted for being left out).
//
// Step 4 (18 Nov): a column in DERIVED (schema.ts) is not a field of the row: a real instant filled from a text stamp
// (pg/stamps.ts). It is left out of the mapping both ways and of the snapshot (it follows from a field the snapshot
// already compares), filled on every upsert, and checked at boot (derivedStale), so rows written by a build that
// didn't fill it (a rollback) are put right on the next save. A collection in ROLLBACK_KV_COPIES is also written whole
// to kv under its name, for a rollback to the builds that read it there.

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyDb = PgDatabase<any, any, any>;
type Row = Record<string, unknown>;
type Collection = (typeof COLLECTIONS)[number];

const EXTRA = "extra";
const ABSENT = "__absent";
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

/** Every column of the table, the derived ones too (what an upsert writes). */
function columnsOf(table: PgTable) {
  return getTableColumns(table) as Record<string, Column>;
}

type Derived = (typeof DERIVED)[number];
const DERIVED_OF = new Map<PgTable, Derived[]>();
for (const d of DERIVED) DERIVED_OF.set(d.table, [...(DERIVED_OF.get(d.table) ?? []), d]);

/** The value a derived column holds for this row (ISO text), or null. */
const derivedValue = (d: Derived, row: Row) => (d.kind === "ms" ? msInstant(row[d.from]) : stampInstant(row[d.from]));

const FIELDS = new WeakMap<PgTable, Record<string, Column>>();
/** The columns that are fields of the row: every column but the derived ones. */
function fieldsOf(table: PgTable): Record<string, Column> {
  let fields = FIELDS.get(table);
  if (!fields) {
    const derived = new Set((DERIVED_OF.get(table) ?? []).map((d) => d.column as string));
    fields = Object.fromEntries(Object.entries(columnsOf(table)).filter(([field]) => !derived.has(field)));
    FIELDS.set(table, fields);
  }
  return fields;
}

const ROLLBACK_COPIES = new Set<string>(ROLLBACK_KV_COPIES);

// Whether a JSON value can sit in this column as-is. Anything that can't (a
// string where a number column is, a number past an integer column's range)
// goes to `extra` untouched instead.
function fits(column: Column, value: unknown): boolean {
  if (value == null) return true;
  switch (column.dataType) {
    case "number":
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        (column.columnType !== "PgInteger" || (Number.isInteger(value) && value >= INT32_MIN && value <= INT32_MAX))
      );
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    default:
      // json. Not a string on its own (18 Nov, step 4 review): drizzle's jsonb reads a string back through JSON.parse,
      // so "12" or "true" would come back a number or a boolean; inside `extra` (an object) it comes back as it went.
      return typeof value !== "string";
  }
}

/** A store row as a table record. */
export function toRecord(table: PgTable, row: Row): Row {
  const columns = fieldsOf(table);
  const record: Row = {};
  const extra: Row = {};
  const absent: string[] = [];
  for (const [field, column] of Object.entries(columns)) {
    if (field === EXTRA) continue;
    if (!(field in row)) {
      record[field] = null;
      absent.push(field);
    } else if (fits(column, row[field])) {
      record[field] = row[field] ?? null;
    } else {
      record[field] = null;
      absent.push(field);
      extra[field] = row[field];
    }
  }
  for (const [field, value] of Object.entries(row)) {
    if (!(field in columns) || field === EXTRA) extra[field] = value;
  }
  if (absent.length) extra[ABSENT] = absent;
  record[EXTRA] = Object.keys(extra).length ? extra : null;
  return record;
}

/** A table record back as the store row it came from. */
export function fromRecord(table: PgTable, record: Row): Row {
  const extra = (record[EXTRA] as Row | null) ?? {};
  const absent = new Set((extra[ABSENT] as string[] | undefined) ?? []);
  const row: Row = {};
  for (const field of Object.keys(fieldsOf(table))) {
    if (field === EXTRA || absent.has(field)) continue;
    row[field] = record[field];
  }
  for (const [field, value] of Object.entries(extra)) {
    if (field !== ABSENT) row[field] = value;
  }
  return row;
}

// A row's key in the snapshot: its key fields joined by a NUL, which no id or period holds.
const KEY_JOIN = "\u0000";
const keyOf = (c: Collection, row: Row) => c.key.map((k) => String(row[k])).join(KEY_JOIN);

/**
 * A string Postgres takes: no NUL (text and jsonb refuse it), and no lone half of a surrogate pair (jsonb refuses its
 * \ud83d escape; text cut in the middle of an emoji by a .slice leaves one), which becomes U+FFFD. A whole pair stays.
 */
export const cleanText = (s: string) =>
  s.replace(/\u0000/g, "").replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, (m) => (m.length === 2 ? m : "�"));

/** The value with every string and key made one Postgres takes (cleanText), however deep (17 Nov). */
function cleaned(value: unknown): unknown {
  if (typeof value === "string") return cleanText(value);
  if (Array.isArray(value)) return value.map(cleaned);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Row = {};
    for (const [k, v] of Object.entries(value)) out[cleanText(k)] = cleaned(v);
    return out;
  }
  return value;
}

/** In JSON.stringify's output: a NUL (\u0000) or a lone surrogate (\ud800–\udfff; a whole pair is written as is). */
const NEEDS_CLEANING = /\\u(?:0000|d[89a-f])/;

/**
 * JSON for Postgres: as JSON.stringify, but with no NUL or lone surrogate left in it. JSON writes both as escapes, so
 * only a value whose JSON holds one is walked (a literal backslash and u0000 typed in a note walks it for nothing and
 * comes out the same). Null when the value can't be written as JSON at all.
 */
export function cleanJson(value: unknown): string | null {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    return null;
  }
  if (json === undefined) return null;
  return NEEDS_CLEANING.test(json) ? JSON.stringify(cleaned(value)) : json;
}

/** Collections and tables: a kv key with one of these names is never written or loaded (17 Nov, the kv guard). */
const NOT_KV = new Set<string>([...COLLECTIONS.map((c) => c.name), ...TABLE_NAMES_NOT_IN_KV]);
export const isTableName = (key: string) => NOT_KV.has(key);

const COLLECTION_NAMES = new Set<string>(WRITER_COLLECTIONS.map((c) => c.name));

/**
 * Every collection and top-level value, as the store object db.ts works on. A list still kept in kv under a
 * collection's name (one moving out of kv into its own table) is loaded from kv while its table is empty, and its name
 * pushed onto `moved`, so the writer can be primed to write it into the table and drop the kv row on the first save.
 */
export async function loadStore(db: AnyDb, moved: string[] = []): Promise<Row> {
  const out: Row = {};
  for (const c of WRITER_COLLECTIONS) {
    const columns = columnsOf(c.table);
    const order: readonly string[] = "order" in c ? c.order : c.key;
    const records = (await db
      .select()
      .from(c.table)
      .orderBy(...order.map((k) => columns[k]))) as Row[];
    out[c.name] = records.map((r) => fromRecord(c.table, r));
  }
  for (const r of (await db.select().from(kv)) as { key: string; value: unknown }[]) {
    // A collection's copy for a rollback (once_keys, health_workouts): the table is what loads (pg/onceKeys.ts and
    // pg/healthWorkouts.ts took it from this copy at boot).
    if (ROLLBACK_COPIES.has(r.key)) continue;
    if (COLLECTION_NAMES.has(r.key) && Array.isArray(r.value) && (out[r.key] as unknown[]).length === 0) {
      console.log(`[store] ${r.key} is still in kv (${r.value.length} rows) and its table is empty: loaded from kv, moved into the table by the first save`);
      out[r.key] = r.value;
      moved.push(r.key);
      continue;
    }
    if (isTableName(r.key)) {
      // Loaded, it would replace the table of that name. Left in the database as it is, for a look.
      console.error(`[store] !!! kv holds a key named like a table, "${r.key}": ignored, the table loads as it is. Look at it, then delete it from kv.`);
      reportSkipped("kv", `a key named like the table ${r.key}, ignored on load`);
      continue;
    }
    out[r.key] = r.value;
  }
  return out;
}

/**
 * The rows whose derived columns don't hold what the writer would write (step 4C): left NULL or stale by a build that
 * didn't fill them (a rollback, then this build again), or where the migration's SQL read a stamp differently from
 * stampMs. By collection, their row keys, for PgStoreWriter.forget, so the first save writes them again. Compared to
 * the millisecond, from `data` as loaded (before the boot's tidies).
 */
export async function derivedStale(db: AnyDb, data: Row): Promise<Map<string, Set<string>>> {
  const stale = new Map<string, Set<string>>();
  for (const c of WRITER_COLLECTIONS) {
    const derived = DERIVED_OF.get(c.table);
    if (!derived || c.key.length !== 1) continue;
    const keyColumn = columnsOf(c.table)[c.key[0]].name;
    const columns = derived.map((d) => columnsOf(c.table)[d.column].name);
    const read = await db.execute(
      sql.raw(`SELECT "${keyColumn}" AS k, ${columns.map((col, i) => `(EXTRACT(EPOCH FROM "${col}") * 1000)::float8 AS d${i}`).join(", ")} FROM "${getTableName(c.table)}"`)
    );
    const held = new Map<string, (number | null)[]>();
    for (const r of ((read as { rows?: Row[] }).rows ?? []) as Row[]) {
      held.set(String(r.k), derived.map((_, i) => (r[`d${i}`] == null ? null : Math.round(Number(r[`d${i}`])))));
    }
    const keys = new Set<string>();
    for (const row of (Array.isArray(data[c.name]) ? data[c.name] : []) as Row[]) {
      if (!row || typeof row !== "object") continue;
      const key = String(row[c.key[0]]);
      const have = held.get(key);
      if (!have) continue; // not in the table: written by the next save anyway
      derived.forEach((d, i) => {
        const want = d.kind === "ms" ? msInstantMs(row[d.from]) : stampInstantMs(row[d.from]);
        if (want !== have[i]) keys.add(key);
      });
    }
    if (keys.size) stale.set(c.name, keys);
  }
  return stale;
}

/**
 * What the database holds after a save. `held`: what this snapshot had to leave out (a row or kv value that can't be
 * written), which keeps its last saved state rather than being deleted (writeDiff): by row key, every row of a
 * collection when a row's key can't even be read, and kv keys.
 */
type Snapshot = {
  rows: Map<string, Map<string, string>>;
  kv: Map<string, string>;
  held: { rows: Map<string, Set<string>>; all: Set<string>; kv: Set<string> };
};

function snapshotOf(data: Row): Snapshot {
  const rows = new Map<string, Map<string, string>>();
  const held: Snapshot["held"] = { rows: new Map(), all: new Set(), kv: new Set() };
  const hold = (table: string, key: string) => {
    let keys = held.rows.get(table);
    if (!keys) held.rows.set(table, (keys = new Set()));
    keys.add(key);
  };
  const skipped: Record<string, number> = {};
  const skip = (table: string, why: string, sample?: unknown) => {
    skipped[table] = (skipped[table] ?? 0) + 1;
    reportSkipped(table, why, sample);
  };
  for (const c of WRITER_COLLECTIONS) {
    const byKey = new Map<string, string>();
    const list = data[c.name];
    for (const row of Array.isArray(list) ? (list as unknown[]) : []) {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        skip(c.name, "a row that is not an object", row);
        held.all.add(c.name);
        continue;
      }
      const record = toRecord(c.table, row as Row);
      // A key that is missing, or doesn't fit its column (a string id, an id past int32), would go as NULL and fail
      // the whole transaction. Left out instead; the rest of the save goes, and the row as last saved (under the key
      // its raw fields read as, a "12" as 12) stays in the database.
      const badKey = c.key.find((k) => record[k] == null);
      if (badKey) {
        skip(c.name, `a row with no usable ${badKey}`, { [badKey]: (row as Row)[badKey] });
        hold(c.name, keyOf(c, row as Row));
        continue;
      }
      const json = cleanJson(record);
      if (json == null) {
        skip(c.name, "a row that can't be written as JSON", { [c.key[0]]: record[c.key[0]] });
        hold(c.name, keyOf(c, record));
        continue;
      }
      byKey.set(keyOf(c, record), json);
    }
    rows.set(c.name, byKey);
  }
  const kvMap = new Map<string, string>();
  for (const [key, value] of Object.entries(data)) {
    if (COLLECTION_NAMES.has(key) || value === undefined) continue;
    if (isTableName(key)) {
      skip("kv", `a key named like the table ${key}`);
      continue;
    }
    const json = cleanJson(value);
    if (json == null) {
      skip("kv", `${key}, which can't be written as JSON`);
      held.kv.add(cleanText(key));
      continue;
    }
    kvMap.set(cleanText(key), json);
  }
  // A collection's whole copy for a rollback (step 4B), beside its table, in the same save.
  for (const name of ROLLBACK_COPIES) {
    const list = data[name];
    if (!Array.isArray(list)) continue;
    const json = cleanJson(list);
    if (json == null) held.kv.add(name);
    else kvMap.set(name, json);
  }
  health().skipped = skipped;
  return { rows, kv: kvMap, held };
}

const CHUNK = 500;

/**
 * With CHAT_STORE=pg (Step 5's cut-over) chat_messages is not among the writer's collections, so neither snapshot can
 * hold it; should one ever (a list put back by mistake), the save stops here, before any transaction, rather than
 * writing old rows over the table or deleting what the snapshot lacks.
 */
function chatTripwire(next: Snapshot, last: Snapshot) {
  if (CHAT_PG && (next.rows.has("chat_messages") || last.rows.has("chat_messages"))) {
    throw new Error("[store] !!! chat_messages reached the store's writer with CHAT_STORE=pg: the save is refused");
  }
  // The notifications the same with NOTES_STORE=pg (quest 7).
  // The food diary's seven tables the same with FOOD_STORE=pg (quest 8 part 1).
  if (FOOD_PG) {
    for (const t of FOOD_TABLES) {
      if (next.rows.has(t) || last.rows.has(t)) throw new Error(`[store] !!! ${t} reached the store's writer with FOOD_STORE=pg: the save is refused`);
    }
  }
  if (NOTES_PG && (next.rows.has("coach_activity") || last.rows.has("coach_activity"))) {
    throw new Error("[store] !!! coach_activity reached the store's writer with NOTES_STORE=pg: the save is refused");
  }
}

/**
 * Rows of one collection written into its table as the writer would write them (toRecord, cleanJson, its derived
 * columns), a row already there left as it is: for the boot's JSON import of chat rows with CHAT_STORE=pg (runtime.ts),
 * whose table the writer no longer fills, and the boot's move of the phone's workouts (pg/healthWorkouts.ts). In one
 * transaction (a savepoint inside the caller's), 500 rows a statement. How many were offered.
 */
/**
 * One row of a collection as the writer writes it (toRecord, cleanJson, its derived columns), or null when the writer
 * would leave it out (no usable key, a value that can't be JSON): for a door that writes its rows itself (the food
 * diary with FOOD_STORE=pg, app/lib/food/rows.ts), so the door and the writer can never encode a row two ways.
 */
export function recordForWrite(name: string, row: Row): Row | null {
  const c = COLLECTIONS.find((x) => x.name === name);
  if (!c) throw new Error(`recordForWrite: no collection named ${name}`);
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const record = toRecord(c.table, row);
  if (c.key.some((k) => record[k] == null)) return null;
  const json = cleanJson(record);
  if (json == null) return null;
  const parsed = JSON.parse(json) as Row;
  for (const d of DERIVED_OF.get(c.table) ?? []) parsed[d.column] = derivedValue(d, parsed);
  return parsed;
}

export async function insertRowsOnce(db: AnyDb, name: string, list: unknown[]): Promise<number> {
  const c = COLLECTIONS.find((x) => x.name === name);
  if (!c) throw new Error(`insertRowsOnce: no collection named ${name}`);
  const records: Row[] = [];
  for (const row of list) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const record = toRecord(c.table, row as Row);
    if (c.key.some((k) => record[k] == null)) continue;
    const json = cleanJson(record);
    if (json == null) continue;
    const parsed = JSON.parse(json) as Row;
    for (const d of DERIVED_OF.get(c.table) ?? []) parsed[d.column] = derivedValue(d, parsed);
    records.push(parsed);
  }
  if (!records.length) return 0;
  const columns = columnsOf(c.table);
  await db.transaction(async (tx) => {
    for (let i = 0; i < records.length; i += CHUNK) {
      await (tx as unknown as AnyDb)
        .insert(c.table)
        .values(records.slice(i, i + CHUNK) as any)
        .onConflictDoNothing({ target: c.key.map((k) => columns[k]) as any });
    }
  });
  return records.length;
}

/**
 * Saves a store to Postgres. Only what differs from the last save it knows
 * about is written; the first save after construction writes everything
 * unless prime() was called with what the database already holds.
 */
export class PgStoreWriter {
  private last: Snapshot = { rows: new Map(), kv: new Map(), held: { rows: new Map(), all: new Set(), kv: new Set() } };
  private running: Promise<void> | null = null;
  private again = false;
  /** When a save last committed a transaction (ms since 1970), for /api/timing. */
  lastCommitAt: number | null = null;
  /** How many saves have committed: the chat shadow (app/lib/chat/shadow.ts) throws away a compare a save landed in. */
  private committedSaves = 0;

  constructor(private db: AnyDb) {}

  /** Moves on each time what the database holds moves on (a committed save, a prime). */
  get generation(): number {
    return this.committedSaves;
  }
  /** A save is running (its snapshot, compare or transaction). */
  get saving(): boolean {
    return this.running !== null;
  }
  /** What the database holds for a collection, as the last save committed it: row key → the record's JSON. Read only. */
  committed(name: string): ReadonlyMap<string, string> | undefined {
    return this.last.rows.get(name);
  }
  /** A kv value as the last save committed it (its JSON), for the notes' outbox drainer (quest 7). Read only. */
  committedKv(key: string): string | undefined {
    return this.last.kv.get(key);
  }
  private commitHooks: (() => void)[] = [];
  /** Called after every save that committed and every prime (the notes' drainer wakes on it). Never throws into the save. */
  onCommit(cb: () => void) {
    this.commitHooks.push(cb);
  }
  private committedNow() {
    for (const cb of this.commitHooks) {
      try {
        cb();
      } catch {
        /* a hook never fails a save */
      }
    }
  }

  /**
   * The database already holds exactly this data (just loaded or imported), but for `moved` (loadStore): lists loaded
   * from kv whose tables are empty, so the first save writes their rows into the table and deletes their kv row.
   */
  prime(data: Row, moved: readonly string[] = []) {
    this.committedSaves++;
    this.last = snapshotOf(data);
    chatTripwire(this.last, this.last);
    for (const name of moved) {
      this.last.rows.set(name, new Map());
      this.last.kv.set(name, "");
    }
  }

  /**
   * These rows are written again by the next save, as if the database held something else for them (derivedStale);
   * one gone from the store by then is deleted, as any.
   */
  forget(stale: Map<string, Set<string>>) {
    this.committedSaves++;
    for (const [name, keys] of stale) {
      const rows = this.last.rows.get(name);
      if (rows) for (const key of keys) if (rows.has(key)) rows.set(key, "");
    }
  }

  /** The next save writes this kv value again, as if the database held something else (a copy the boot cleaned or found broken). */
  forgetKv(name: string) {
    this.committedSaves++;
    this.last.kv.set(name, "");
  }

  /** Writes the changes, one save at a time; a save requested mid-save runs after it. */
  save(getData: () => Row): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        // The snapshot (every row stringified) waits for a macrotask, so the render or action that called persist()
        // answers first instead of paying for it inline (4 Nov, Alex: "just a tiny bit slow" going from screen to
        // screen). Safe with the queue: `running` is set before this yields, so a save asked meanwhile only sets
        // `again`; the snapshot below reads the live store after their changes, and one asked after it runs the loop again.
        await new Promise<void>((resolve) => setImmediate(resolve));
        do {
          this.again = false;
          // Timed (17 Nov, mission 2): what each save costs before its transaction, on /api/timing (noteSaveCost).
          const started = performance.now();
          const next = snapshotOf(getData());
          await this.writeDiff(next, started, performance.now());
        } while (this.again);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private async writeDiff(next: Snapshot, started = performance.now(), snapped = started) {
    // Before any transaction: with chat in Postgres alone the writer never holds a chat row (Step 5's cut-over).
    chatTripwire(next, this.last);
    const work: ((tx: AnyDb) => Promise<unknown>)[] = [];
    // Rows and kv values compared, and those that differed or went: measured only (noteSaveCost).
    let compared = 0;
    let changed = 0;

    for (const c of WRITER_COLLECTIONS) {
      const before = this.last.rows.get(c.name) ?? new Map<string, string>();
      let after = next.rows.get(c.name);
      if (!after) next.rows.set(c.name, (after = new Map<string, string>()));
      // A row this save had to leave out keeps what the database holds for it: never a delete (17 Nov).
      const held = next.held.rows.get(c.name);
      const holdAll = next.held.all.has(c.name);
      if (held || holdAll) {
        for (const [key, json] of before) if (!after.has(key) && (holdAll || held!.has(key))) after.set(key, json);
      }
      const columns = columnsOf(c.table);
      const upserts: Row[] = [];
      for (const [key, json] of after) if (before.get(key) !== json) upserts.push(JSON.parse(json));
      // Its instants from its stamps (step 4C), on every row written: only those, the rest follows from the snapshot.
      const derived = DERIVED_OF.get(c.table);
      if (derived) for (const record of upserts) for (const d of derived) record[d.column] = derivedValue(d, record);
      const deletes = [...before.keys()].filter((key) => !after.has(key));
      compared += after.size;
      changed += upserts.length + deletes.length;

      const setClause = Object.fromEntries(
        Object.keys(columns)
          .filter((f) => !(c.key as readonly string[]).includes(f))
          .map((f) => [f, sql.raw(`excluded."${columns[f].name}"`)])
      );
      for (let i = 0; i < upserts.length; i += CHUNK) {
        const batch = upserts.slice(i, i + CHUNK);
        work.push((tx) =>
          tx
            .insert(c.table)
            .values(batch as any)
            .onConflictDoUpdate({ target: c.key.map((k) => columns[k]) as any, set: setClause as any })
        );
      }
      if (deletes.length) {
        if (c.key.length === 1) {
          const ids = deletes.map((k) => (columns[c.key[0]].dataType === "number" ? Number(k) : k));
          for (let i = 0; i < ids.length; i += CHUNK) {
            const batch = ids.slice(i, i + CHUNK);
            work.push((tx) => tx.delete(c.table).where(inArray(columns[c.key[0]], batch)));
          }
        } else {
          for (const k of deletes) {
            const parts = k.split(KEY_JOIN);
            work.push((tx) =>
              tx.delete(c.table).where(and(...c.key.map((field, i) => eq(columns[field], columns[field].dataType === "number" ? Number(parts[i]) : parts[i]))))
            );
          }
        }
      }
    }

    // A kv value this save couldn't write keeps the one saved before it.
    for (const key of next.held.kv) {
      const was = this.last.kv.get(key);
      if (was !== undefined && !next.kv.has(key)) next.kv.set(key, was);
    }
    for (const [key, json] of next.kv) {
      compared++;
      if (this.last.kv.get(key) === json) continue;
      changed++;
      const value = JSON.parse(json);
      work.push((tx) => tx.insert(kv).values({ key, value }).onConflictDoUpdate({ target: kv.key, set: { value } }));
    }
    for (const key of this.last.kv.keys()) {
      if (!next.kv.has(key)) {
        changed++;
        work.push((tx) => tx.delete(kv).where(eq(kv.key, key)));
      }
    }

    const done = performance.now();
    noteSaveCost({
      at: new Date().toISOString(),
      ms: Math.round((done - started) * 10) / 10,
      snapshotMs: Math.round((snapped - started) * 10) / 10,
      diffMs: Math.round((done - snapped) * 10) / 10,
      rows: compared,
      changed,
    });

    if (work.length === 0) return;
    const txStarted = performance.now();
    await this.db.transaction(async (tx) => {
      for (const step of work) await step(tx as unknown as AnyDb);
    });
    // The transaction's own time (18 Nov, Step 5: the shadow week watches that the shadow never slows the writer).
    noteSaveTx(Math.round((performance.now() - txStarted) * 10) / 10);
    this.last = next;
    this.committedSaves++;
    this.lastCommitAt = Date.now();
    this.committedNow();
  }
}
