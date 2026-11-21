// The one door to the check-in figures (metric_entries) and the check-in notes (check_in_notes) written with them (20 Nov,
// Step 6 quest 9 of docs/database-plan.md). Every read and write of them goes through here; nothing else in app/ touches
// the store's two lists (Data's two keys are a sealed type in db.ts, so tsc refuses any other reach for them, and
// scripts/check-checkins-door.mjs, run by the build, refuses the names). Built on the food diary's recipe
// (app/lib/food/rows.ts), its own files untouched. The coach's metric definitions (metric_definitions) stay in memory:
// a view matches a figure to its client through them, read from memory when it is asked.
//
// The code that reads and writes the rows stays where it was (queries.ts, healthSync.ts, the boards, appLock.ts): it is
// handed a CheckInRows (a reader's view) or a CheckInBox (a writer's), the two lists as properties under short names
// (entries, notes), and runs on them exactly as it ran on the store.
//
//   memory, CHECKINS_VIEWS=wide   (the default) a view and a box are the store itself: every list is the store's own
//                                 array, read and replaced in place, so every line behaves exactly as before. A reader
//                                 asking a view for a client or a span its fetch didn't take is a miss, said once and
//                                 counted.
//   memory, CHECKINS_VIEWS=narrow a view holds only the rows its fetch took (the same objects, in store order): what the
//                                 cut-over's queries hand back. A miss throws. Writes always run on the store.
//   CHECKINS_STORE=pg             (checkins/mode.ts) the rows are in Postgres alone: a fetch reads its scope in one
//                                 snapshot, ordered by id as the store holds them; a write is one transaction under the
//                                 client's lock (writeCheckIns): the reach loaded, the code run on it, the rows it
//                                 changed written back. A miss throws.
//
// A reader handed no view doesn't compile (every reader takes one); a page, route, action or job fetches first.

import { getTableColumns, sql, type Column, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { allocId, getData, persist, persistNow, type CheckInEntry, type CheckInNote } from "../db";
import { check_in_notes, metric_entries } from "../pg/schema";
import { cleanText, fromRecord, recordForWrite } from "../pg/store";
import { CHECKINS_PG, CHECKINS_REMOVING, CHECKINS_TABLES, type CheckInTable } from "./mode";
import type { CheckInReadPath, CheckInWritePath } from "./paths";
import { checkInChainsSettled, checkinRead, checkinWriteRaw, throwIfFaultBeforeCommit, type Q, type Row } from "./pg";
import { noteCheckInsMissed, noteCheckInsSeen, noteCheckInsWrite, onCheckInsFetch } from "./shadow";

export { CHECKINS_TABLES };

/** The short names the code uses for the two lists. */
export const CHECKIN_SHORT = { entries: "metric_entries", notes: "check_in_notes" } as const;
export type CheckInShort = keyof typeof CHECKIN_SHORT;
const SHORTS = Object.keys(CHECKIN_SHORT) as CheckInShort[];
const TABLE_OF = { metric_entries, check_in_notes } as const;
const SHORT_OF: Record<CheckInTable, CheckInShort> = { metric_entries: "entries", check_in_notes: "notes" };

type Lists = { entries: CheckInEntry[]; notes: CheckInNote[] };

const MODE: "wide" | "narrow" = CHECKINS_PG || process.env.CHECKINS_VIEWS === "narrow" ? "narrow" : "wide";
/** Where a miss throws rather than being said: always with the rows in Postgres (there is no store to fall back on). */
const STRICT = CHECKINS_PG || MODE === "narrow" || process.env.NODE_ENV === "test" || process.env.CHECKINS_STRICT === "1";

/** A view asked for what it doesn't hold. */
export class CheckInViewMiss extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckInViewMiss";
  }
}

// ---- What a fetch took ---------------------------------------------------------------------------------------------

/**
 * The periods a reader reads: every period, some, or a run of them (compared as strings, as the readers compare them);
 * or one of two answers the minute job and the locked app ask, never rows: `latest`, each metric's newest period as
 * listMetricPeriods(ids, 1) reads it (its newest dated row, and every row whose period is no day), and `logged`, whether
 * a metric holds a figure the client typed (its first such row).
 */
export type CheckInSpan = "all" | { periods: readonly string[] } | { from: string; to: string } | "latest" | "logged" | { latestOf: readonly number[] };

/**
 * `latest` of every metric of the client (`latestAll`), or of these metrics alone (`latestDefs`, `{ latestOf }`: the
 * minute job, which asks only the metrics a check-in asks now, so it never probes every metric a client ever had).
 */
type ClientScope = { all: boolean; periods: Set<string>; ranges: { from: string; to: string }[]; latest: boolean; latestAll: boolean; latestDefs: Set<number>; logged: boolean };
type Scope = { clients: Map<number, ClientScope>; lists: ReadonlySet<CheckInShort>; defsAtFetch?: ReadonlyMap<number, readonly number[]> };

const emptyClientScope = (): ClientScope => ({ all: false, periods: new Set(), ranges: [], latest: false, latestAll: false, latestDefs: new Set(), logged: false });
function addSpan(s: ClientScope, span: CheckInSpan) {
  if (span === "all") s.all = true;
  else if (span === "latest") s.latest = s.latestAll = true;
  else if (span === "logged") s.logged = true;
  else if ("latestOf" in span) {
    s.latest = true;
    for (const id of span.latestOf) s.latestDefs.add(id);
  } else if ("periods" in span) for (const p of span.periods) s.periods.add(p);
  else s.ranges.push({ from: span.from, to: span.to });
}
/** The metrics of these ids whose `latest` the scope takes. */
const latestIdsOf = (s: ClientScope, ids: readonly number[]) => (s.latestAll ? ids : ids.filter((id) => s.latestDefs.has(id)));
function makeScope(spansByClient: Iterable<readonly [number, readonly CheckInSpan[]]>, lists: readonly CheckInShort[] = SHORTS): Scope {
  const clients = new Map<number, ClientScope>();
  for (const [id, spans] of spansByClient) {
    const s = clients.get(id) ?? emptyClientScope();
    for (const span of spans) addSpan(s, span);
    clients.set(id, s);
  }
  return { clients, lists: new Set(lists) };
}
const scopeOf = (clientIds: readonly number[], spans: readonly CheckInSpan[], lists?: readonly CheckInShort[]) =>
  makeScope(
    [...new Set(clientIds)].map((id) => [id, spans] as const),
    lists
  );
const inPeriod = (s: ClientScope, period: unknown) => s.all || (typeof period === "string" && (s.periods.has(period) || s.ranges.some((r) => period >= r.from && period <= r.to)));

/** Each metric definition's client, as memory holds them now (a figure belongs to its client through its metric). */
function clientOfDefs(): Map<number, number> {
  const out = new Map<number, number>();
  for (const d of getData().metric_definitions) out.set(d.id, d.client_id);
  return out;
}
/** Each client's metric ids, as memory holds them now (retired ones too: their history is the client's). */
function defsOfClients(clientIds: Iterable<number>): Map<number, number[]> {
  const want = new Set(clientIds);
  const out = new Map<number, number[]>();
  for (const id of want) out.set(id, []);
  for (const d of getData().metric_definitions) if (want.has(d.client_id)) out.get(d.client_id)!.push(d.id);
  return out;
}

/** A period that is a day (YYYY-MM-DD, ASCII digits): ordered alike as text by JS and by Postgres's "C" collation. */
const DAY = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const DAY_SQL = "^[0-9]{4}-[0-9]{2}-[0-9]{2}$";
const isDay = (p: unknown): p is string => typeof p === "string" && DAY.test(p);

/**
 * `latest`'s rows of these metrics, from rows in store order: each metric's newest dated row (the lowest id of a twin),
 * and every row whose period is no day (they are few, and JS sorts them where it will), in their order. Over these rows
 * listMetricPeriods(ids, 1) answers exactly what it answers over every row of the metrics.
 */
function pickLatest(rows: readonly CheckInEntry[], defIds: ReadonlySet<number>): Set<CheckInEntry> {
  const best = new Map<number, CheckInEntry>();
  const out = new Set<CheckInEntry>();
  for (const e of rows) {
    if (!defIds.has(e.metric_definition_id)) continue;
    if (!isDay(e.period)) {
      out.add(e);
      continue;
    }
    const b = best.get(e.metric_definition_id);
    if (!b || e.period > b.period || (e.period === b.period && e.id < b.id)) best.set(e.metric_definition_id, e);
  }
  for (const e of best.values()) out.add(e);
  return out;
}
/** A figure the client typed: what the locked app and its sweep look for (appLock.ts loggedAnything). */
const typedFigure = (e: CheckInEntry) => e.value != null && e.source !== "health";
/** `logged`'s rows of these metrics: each metric's first typed figure (by id). */
function pickLogged(rows: readonly CheckInEntry[], defIds: ReadonlySet<number>): Set<CheckInEntry> {
  const first = new Map<number, CheckInEntry>();
  for (const e of rows) {
    if (!defIds.has(e.metric_definition_id) || !typedFigure(e)) continue;
    const b = first.get(e.metric_definition_id);
    if (!b || e.id < b.id) first.set(e.metric_definition_id, e);
  }
  return new Set(first.values());
}

/** The rows of the scope from rows in store order (the store's, or what the last save committed): the predicate every slice follows. */
function cutRows(scope: Scope, lists: Lists, defClient: ReadonlyMap<number, number>): Lists {
  const latestDefs = new Set<number>();
  const loggedDefs = new Set<number>();
  for (const [defId, clientId] of defClient) {
    const s = scope.clients.get(clientId);
    if (!s || s.all) continue;
    if (s.latest && (s.latestAll || s.latestDefs.has(defId))) latestDefs.add(defId);
    if (s.logged) loggedDefs.add(defId);
  }
  let entries: CheckInEntry[] = [];
  if (scope.lists.has("entries")) {
    const extra = new Set<CheckInEntry>([...(latestDefs.size ? pickLatest(lists.entries, latestDefs) : []), ...(loggedDefs.size ? pickLogged(lists.entries, loggedDefs) : [])]);
    entries = lists.entries.filter((e) => {
      if (extra.has(e)) return true;
      const c = defClient.get(e.metric_definition_id);
      const s = c == null ? undefined : scope.clients.get(c);
      return !!s && inPeriod(s, e.period);
    });
  }
  const notes = scope.lists.has("notes")
    ? lists.notes.filter((n) => {
        const s = scope.clients.get(n.client_id);
        return !!s && inPeriod(s, n.period);
      })
    : [];
  return { entries, notes };
}

function covers(scope: Scope, clientId: number, span: CheckInSpan, lists: readonly CheckInShort[], defIds?: readonly number[]): string | null {
  for (const l of lists) if (!scope.lists.has(l)) return `the ${CHECKIN_SHORT[l]} list was not fetched`;
  const s = scope.clients.get(clientId);
  if (!s) return `client ${clientId} was not fetched`;
  if (s.all) return null;
  if (span === "all") return `client ${clientId}'s whole history was not fetched`;
  if (span === "latest" || (typeof span === "object" && "latestOf" in span)) {
    if (!s.latest) return `client ${clientId}'s newest periods were not fetched`;
    if (s.latestAll) return null;
    // Taken for some metrics alone: each asked metric the client had at the fetch must be one of them.
    const asked = span === "latest" ? (defIds ?? null) : span.latestOf;
    if (asked == null) return `client ${clientId}'s newest periods were fetched for some metrics alone`;
    const had = new Set(scope.defsAtFetch?.get(clientId) ?? []);
    const out = asked.filter((id) => had.has(id) && !s.latestDefs.has(id));
    return out.length ? `the newest periods of ${out.length} metric(s) of client ${clientId} were not fetched` : null;
  }
  if (span === "logged") return s.logged ? null : `whether client ${clientId} logged a figure was not fetched`;
  if ("periods" in span) {
    const out = span.periods.filter((p) => !inPeriod(s, p));
    return out.length ? `${out.length} period(s) of client ${clientId} were not fetched` : null;
  }
  return s.ranges.some((r) => r.from <= span.from && r.to >= span.to) ? null : `client ${clientId} from ${span.from} to ${span.to} was not fetched`;
}

// ---- The lists: the store's, or a slice of them --------------------------------------------------------------------

type Holder = { get(short: CheckInShort): unknown[]; set(short: CheckInShort, rows: unknown[]): void };
/** The store's own arrays, read fresh each time (a delete puts a new list in its place). Memory mode alone. */
// chat-door: notes-door: food-door: one check-in list by its own name, never a walk of the store.
const storeHolder: Holder = {
  get(short) {
    if (CHECKINS_PG) throw new Error(`[checkins] !!! the store's ${CHECKIN_SHORT[short]} was read with CHECKINS_STORE=pg (it lives in Postgres alone)`);
    // chat-door: notes-door: food-door: one check-in list by name (not a walk of the store).
    const held = getData() as unknown as Record<string, unknown[] | undefined>;
    return (held[CHECKIN_SHORT[short]] ??= []);
  },
  set(short, rows) {
    if (CHECKINS_PG) throw new Error(`[checkins] !!! the store's ${CHECKIN_SHORT[short]} was written with CHECKINS_STORE=pg`);
    // chat-door: notes-door: food-door: the same, one check-in list replaced by name.
    (getData() as unknown as Record<string, unknown[]>)[CHECKIN_SHORT[short]] = rows;
  },
};
function listHolder(lists: Lists): Holder {
  return {
    get: (short) => lists[short],
    set: (short, rows) => {
      (lists as Record<CheckInShort, unknown[]>)[short] = rows;
    },
  };
}
const storeLists = (): Lists => ({ entries: storeHolder.get("entries") as CheckInEntry[], notes: storeHolder.get("notes") as CheckInNote[] });

const MINT = Symbol("checkins-door");
const said = new Set<string>();

/**
 * One fetch's check-in figures and notes, under their short names, and what was taken. A reader says what it reads first
 * (need), then reads the lists as it read the store; a list it was handed is the store's own or a superset slice of it,
 * in the store's order, so its own filters and sorts give what they always gave.
 */
export class CheckInRows {
  readonly path: CheckInReadPath | CheckInWritePath;
  protected readonly holder: Holder;
  protected readonly scope: Scope | null;
  constructor(token: symbol, path: CheckInReadPath | CheckInWritePath, holder: Holder, scope: Scope | null) {
    if (token !== MINT) throw new Error("Check-in rows are made by the door (app/lib/checkins/rows.ts) alone.");
    this.path = path;
    this.holder = holder;
    this.scope = scope;
  }
  get entries(): CheckInEntry[] {
    return this.holder.get("entries") as CheckInEntry[];
  }
  get notes(): CheckInNote[] {
    return this.holder.get("notes") as CheckInNote[];
  }
  /**
   * What a reader is about to read: these clients, these periods (or `latest`, `logged`), these lists. Answers nothing;
   * a miss throws where views are narrow, else is said once and counted.
   */
  need(reader: string, clientIds: number | readonly number[], span: CheckInSpan = "all", lists: readonly CheckInShort[] = SHORTS, defIds?: readonly number[]): void {
    if (!this.scope) return;
    for (const id of typeof clientIds === "number" ? [clientIds] : clientIds) {
      const why = covers(this.scope, id, span, lists, defIds);
      if (!why) continue;
      this.miss(`[checkins] ${reader} on ${this.path}: ${why}`);
    }
  }
  protected miss(message: string) {
    noteCheckInsMissed(this.path, message);
    if (STRICT) throw new CheckInViewMiss(message);
    if (!said.has(message)) {
      said.add(message);
      console.warn(message);
    }
  }
}

/** What a write reads and may change: these metrics' figures over these periods, and these notes (kind and period). */
export type CheckInReach = {
  defIds: readonly number[];
  span: { periods: readonly string[] } | { from: string; to: string } | "all";
  notes?: readonly { kind: string; period: string }[];
};

/** A writer's rows: a view whose lists can be replaced, ids allocated, and the save asked for. */
export class CheckInBox extends CheckInRows {
  private readonly onPersist: () => void;
  private readonly reach: CheckInReach | null;
  constructor(token: symbol, path: CheckInWritePath, holder: Holder, scope: Scope | null, reach: CheckInReach | null, onPersist: () => void) {
    super(token, path, holder, scope);
    this.onPersist = onPersist;
    this.reach = reach;
  }
  override get entries(): CheckInEntry[] {
    return super.entries;
  }
  override set entries(rows: CheckInEntry[]) {
    this.holder.set("entries", rows);
  }
  override get notes(): CheckInNote[] {
    return super.notes;
  }
  override set notes(rows: CheckInNote[]) {
    this.holder.set("notes", rows);
  }
  /** A new id for a row of this list (the store's counter, or its sequence in Postgres mode: db.ts allocId). */
  alloc(short: CheckInShort): number {
    return allocId(CHECKIN_SHORT[short]);
  }
  /** The store's save (memory); nothing in Postgres mode, where writeCheckIns writes what changed when the code is done. */
  persist(): void {
    this.onPersist();
  }
  /**
   * A figure of this metric and period is inside what the write loaded (always, in memory mode): asked before a find, so
   * a row outside the loaded reach can never be added a second time (the unique rule would refuse the whole write).
   */
  inReach(defId: number, period: string): void {
    const r = this.reach;
    if (!r) return;
    const ok = r.defIds.includes(defId) && (r.span === "all" || ("periods" in r.span ? r.span.periods.includes(period) : period >= r.span.from && period <= r.span.to));
    if (!ok) this.miss(`[checkins] a figure of metric ${defId} for a period outside ${this.path}'s reach`);
  }
  /** A note of this kind and period is inside what the write loaded (always, in memory mode). */
  noteInReach(kind: string, period: string): void {
    const r = this.reach;
    if (!r) return;
    if (!(r.notes ?? []).some((n) => n.kind === kind && n.period === period)) this.miss(`[checkins] a ${kind} note outside ${this.path}'s reach`);
  }
}

const storeBox = (p: CheckInWritePath) => new CheckInBox(MINT, p, storeHolder, null, null, persist);

/**
 * The store's own lists as a box (memory mode alone): the boot's tidies in db.ts, the seed scripts, code that runs where
 * no request fetched. Throws with CHECKINS_STORE=pg.
 */
export function storeCheckInBox(path: CheckInWritePath): CheckInBox {
  if (CHECKINS_PG) throw new Error("[checkins] storeCheckInBox with CHECKINS_STORE=pg: write through writeCheckIns instead");
  return storeBox(path);
}
/** A view of the store whole (memory mode alone), for a script comparing readers. */
export function storeCheckInRows(path: CheckInReadPath): CheckInRows {
  if (CHECKINS_PG) throw new Error("[checkins] storeCheckInRows with CHECKINS_STORE=pg: fetch instead");
  return new CheckInRows(MINT, path, storeHolder, null);
}

// ---- Fetch first ---------------------------------------------------------------------------------------------------

const decodeOf = (t: CheckInTable) => (r: Row) => fromRecord(TABLE_OF[t], r);
const byId = (a: { id: number }, b: { id: number }) => a.id - b.id;
const ints = (ids: Iterable<number>) => `{${[...ids].filter((n) => Number.isInteger(n)).join(",")}}`;
const textJson = (list: Iterable<string>) => JSON.stringify([...list]);
const CHUNK = 5000;

function* chunks<T>(list: readonly T[], size = CHUNK): Generator<T[]> {
  for (let i = 0; i < list.length; i += size) yield list.slice(i, i + size);
}

/**
 * The scope read from Postgres (one snapshot, or inside a write's transaction), each list by id: the cut-over's own
 * statements, the same in pg mode and in the shadow. `defs` is each client's metrics as memory held them at the fetch.
 */
async function loadScope(q: Q, scope: Scope, defs: ReadonlyMap<number, readonly number[]>): Promise<Lists> {
  const entries = new Map<number, CheckInEntry>();
  const notes: CheckInNote[] = [];
  const decodeE = decodeOf("metric_entries");
  const decodeN = decodeOf("check_in_notes");
  const take = (rows: Row[]) => {
    for (const r of rows) {
      const e = decodeE(r) as unknown as CheckInEntry;
      if (!entries.has(e.id)) entries.set(e.id, e);
    }
  };
  const whole: number[] = [];
  const latest: number[] = [];
  const logged: number[] = [];
  const wholeClients: number[] = [];
  for (const [clientId, s] of scope.clients) {
    const ids = defs.get(clientId) ?? [];
    if (s.all) {
      whole.push(...ids);
      wholeClients.push(clientId);
      continue;
    }
    if (s.latest) latest.push(...latestIdsOf(s, ids));
    if (s.logged) logged.push(...ids);
    if (scope.lists.has("entries") && ids.length && (s.periods.size || s.ranges.length)) {
      const parts: SQL[] = [];
      // `COLLATE "C"` as the indexes hold the period (equality is the same in every collation): the index then bounds the period too.
      if (s.periods.size) parts.push(sql`period COLLATE "C" IN (SELECT jsonb_array_elements_text(${textJson(s.periods)}::jsonb))`);
      for (const r of s.ranges) parts.push(sql`(period COLLATE "C" >= ${r.from}::text AND period COLLATE "C" <= ${r.to}::text)`);
      take(await q(sql`SELECT * FROM metric_entries WHERE metric_definition_id = ANY(${ints(ids)}::int[]) AND (${sql.join(parts, sql` OR `)}) ORDER BY id`));
    }
    if (scope.lists.has("notes") && (s.periods.size || s.ranges.length)) {
      const parts: SQL[] = [];
      if (s.periods.size) parts.push(sql`period COLLATE "C" IN (SELECT jsonb_array_elements_text(${textJson(s.periods)}::jsonb))`);
      for (const r of s.ranges) parts.push(sql`(period COLLATE "C" >= ${r.from}::text AND period COLLATE "C" <= ${r.to}::text)`);
      for (const r of await q(sql`SELECT * FROM check_in_notes WHERE client_id = ${clientId}::int AND (${sql.join(parts, sql` OR `)}) ORDER BY id`)) notes.push(decodeN(r) as unknown as CheckInNote);
    }
  }
  if (scope.lists.has("entries")) {
    for (const part of chunks(whole)) take(await q(sql`SELECT * FROM metric_entries WHERE metric_definition_id = ANY(${ints(part)}::int[]) ORDER BY id`));
    for (const part of chunks(latest)) {
      // Each metric's newest dated figure, one backward probe of (metric_definition_id, period "C", id) per metric.
      take(
        await q(sql`SELECT e.* FROM unnest(${ints(part)}::int[]) AS d(id) CROSS JOIN LATERAL (
            SELECT * FROM metric_entries e WHERE e.metric_definition_id = d.id AND e.period ~ ${DAY_SQL}::text
            ORDER BY e.period COLLATE "C" DESC, e.id LIMIT 1) e`)
      );
      // And every figure whose period is no day (or none): listMetricPeriods sorts them in with the rest.
      take(await q(sql`SELECT * FROM metric_entries WHERE metric_definition_id = ANY(${ints(part)}::int[]) AND (period IS NULL OR period !~ ${DAY_SQL}::text) ORDER BY id`));
    }
    for (const part of chunks(logged)) {
      take(
        await q(sql`SELECT e.* FROM unnest(${ints(part)}::int[]) AS d(id) CROSS JOIN LATERAL (
            SELECT * FROM metric_entries e WHERE e.metric_definition_id = d.id AND e.value IS NOT NULL AND (e.extra->>'source') IS DISTINCT FROM 'health'
            ORDER BY e.id LIMIT 1) e`)
      );
    }
  }
  if (scope.lists.has("notes")) {
    for (const part of chunks(wholeClients)) for (const r of await q(sql`SELECT * FROM check_in_notes WHERE client_id = ANY(${ints(part)}::int[]) ORDER BY id`)) notes.push(decodeN(r) as unknown as CheckInNote);
  }
  const seen = new Set<number>();
  return { entries: [...entries.values()].sort(byId), notes: notes.filter((n) => (seen.has(n.id) ? false : (seen.add(n.id), true))).sort(byId) };
}

async function fetchScope(path: CheckInReadPath, scope: Scope): Promise<CheckInRows> {
  noteCheckInsSeen(path);
  const defs = defsOfClients(scope.clients.keys());
  scope.defsAtFetch = defs;
  if (CHECKINS_PG) {
    const got = await checkinRead((q) => loadScope(q, scope, defs));
    return new CheckInRows(MINT, path, listHolder(got), scope);
  }
  // The shadow (CHECKINS_SHADOW=read): the same scope's SQL, compared with what the last save committed, cut to the
  // same scope. Behind the answer, never awaited.
  onCheckInsFetch(path, {
    lists: SHORTS.filter((s) => scope.lists.has(s)).map((s) => CHECKIN_SHORT[s]),
    sqlRows: async (q) => {
      const lists = await loadScope(q, scope, defs);
      return { metric_entries: lists.entries as unknown as Row[], check_in_notes: lists.notes as unknown as Row[] };
    },
    defs,
    clients: [...scope.clients.keys()],
    cut: (committed) => {
      const defClient = new Map<number, number>();
      for (const [c, ids] of defs) for (const id of ids) defClient.set(id, c);
      const got = cutRows(scope, { entries: committed.entries as unknown as CheckInEntry[], notes: committed.notes as unknown as CheckInNote[] }, defClient);
      return { metric_entries: got.entries as unknown as Row[], check_in_notes: got.notes as unknown as Row[] };
    },
    latestDefs: [...scope.clients].filter(([, s]) => s.latest && !s.all).flatMap(([c, s]) => latestIdsOf(s, defs.get(c) ?? [])),
    loggedClients: [...scope.clients].filter(([, s]) => s.logged && !s.all).map(([c]) => c),
    decode: (t, record) => decodeOf(t)(record),
  });
  if (MODE === "narrow") return new CheckInRows(MINT, path, listHolder(cutRows(scope, storeLists(), clientOfDefs())), scope);
  return new CheckInRows(MINT, path, storeHolder, scope);
}

/** Every client still unopened while the locked app's one-time sweep hasn't run (lib/appLock.ts reads their figures). */
function unsweptClients(): number[] {
  const data = getData() as unknown as { app_lock_swept?: string | null; clients: { id: number; app_opened_at?: string | null }[] };
  return data.app_lock_swept ? [] : data.clients.filter((c) => !c.app_opened_at).map((c) => c.id);
}
const coachClients = (coachIds: Iterable<number>) => {
  const coaches = new Set(coachIds);
  return getData()
    .clients.filter((c) => c.coach_id != null && coaches.has(c.coach_id))
    .map((c) => c.id);
};

/** One client's figures and notes over these periods (every period by default): an action, a route, the coach's goal. */
export function fetchClientCheckIns(clientId: number, path: CheckInReadPath, spans: CheckInSpan | readonly CheckInSpan[] = "all"): Promise<CheckInRows> {
  return fetchScope(path, scopeOf([clientId], Array.isArray(spans) ? (spans as CheckInSpan[]) : [spans as CheckInSpan]));
}

/** The client's own app: their whole history, and whether each client still unopened logged anything (appLockFor's sweep). */
export function fetchClientPageCheckIns(clientId: number, path: CheckInReadPath): Promise<CheckInRows> {
  const swept = unsweptClients().filter((id) => id !== clientId);
  return fetchScope(path, makeScope([[clientId, ["all"]], ...swept.map((id) => [id, ["logged"]] as const)]));
}

/**
 * A client's tab in the admin: one view for the rail, the dots and Home's feed (the coach's clients, and the client's
 * own coach's should the owner open another coach's client) and for every tab's reading of the client (their whole
 * history), and whether each client still unopened logged anything (the locked app's sweep). As fetchClientTabFood.
 */
export function fetchClientTabCheckIns(coachId: number, clientId: number, path: CheckInReadPath): Promise<CheckInRows> {
  const own = getData().clients.find((c) => c.id === clientId)?.coach_id ?? 0;
  const whole = new Set([...coachClients(own !== coachId ? [coachId, own] : [coachId]), clientId]);
  const swept = unsweptClients().filter((id) => !whole.has(id));
  return fetchScope(path, makeScope([...[...whole].map((id) => [id, ["all"]] as const), ...swept.map((id) => [id, ["logged"]] as const)]));
}

/** Every client of these coaches whole (the rail, the Feed, every other admin page), and the client in focus. */
export function fetchCoachCheckIns(coachIds: readonly number[], path: CheckInReadPath, focus?: number | null): Promise<CheckInRows> {
  const ids = coachClients(coachIds);
  if (focus != null) ids.push(focus);
  const whole = new Set(ids);
  const swept = unsweptClients().filter((id) => !whole.has(id));
  return fetchScope(path, makeScope([...[...whole].map((id) => [id, ["all"]] as const), ...swept.map((id) => [id, ["logged"]] as const)]));
}

/** The old admin: every client of these coaches and the client in focus, whole. */
export const fetchCoachClientsCheckIns = fetchCoachCheckIns;

/** The coach's view of the client's coach (an action about one client). */
export function fetchCoachCheckInsOfClient(clientId: number, path: CheckInReadPath): Promise<CheckInRows> {
  return fetchCoachCheckIns([getData().clients.find((c) => c.id === clientId)?.coach_id ?? 0], path, clientId);
}

/** Every client whole: the owner's Coaches list (each coach's last activity). */
export function fetchEveryCheckIn(path: CheckInReadPath): Promise<CheckInRows> {
  return fetchScope(path, scopeOf(getData().clients.map((c) => c.id), ["all"]));
}

/**
 * The minute job's answer (getDueItems): each asked metric's newest period, for these clients; no notes. `asked` is
 * each client's metrics a check-in asks now (queries.ts dueCheckInDefIds), so the job never probes every metric a client
 * ever had; a reader asking another metric the client had is a miss.
 */
export function fetchDueCheckIns(clientIds: readonly number[], path: CheckInReadPath, asked: (clientId: number) => readonly number[]): Promise<CheckInRows> {
  return fetchScope(
    path,
    makeScope(
      [...new Set(clientIds)].map((id) => [id, [{ latestOf: asked(id) }]] as const),
      ["entries"]
    )
  );
}

/** Whether these clients logged a figure themselves (lib/appLock.ts): each metric's first typed figure; no notes. */
export function fetchCheckInsLogged(clientIds: readonly number[], path: CheckInReadPath): Promise<CheckInRows> {
  return fetchScope(path, scopeOf(clientIds, ["logged"], ["entries"]));
}

/**
 * These clients' figures and notes whole (the export), or every row of the two tables (the nightly backup, the snapshot:
 * with "all" no filter, so a figure whose metric is gone is kept as memory mode's snapshot keeps it). With
 * CHECKINS_STORE=pg each table is read 2000 rows at a time by id in one snapshot, its statements allowed 60 s; `lists`
 * the lists read (the export takes the notes alone: the figures have no client_id, so its filter drops every one).
 */
export async function fetchCheckInsExport(clientIds: readonly number[] | "all", path: CheckInReadPath, lists: readonly CheckInShort[] = SHORTS): Promise<CheckInRows> {
  const ids = clientIds === "all" ? null : [...new Set(clientIds)];
  const want = new Set(lists);
  if (!CHECKINS_PG) {
    noteCheckInsSeen(path);
    // The store's own lists (the export walks the store as it always did): nothing to slice, nothing to compare.
    return new CheckInRows(MINT, path, storeHolder, null);
  }
  noteCheckInsSeen(path);
  const defs = ids ? [...defsOfClients(ids).values()].flat() : null;
  const got = await checkinRead(async (q) => {
    await q(sql`SET LOCAL statement_timeout = '60s'`);
    await q(sql`SET LOCAL idle_in_transaction_session_timeout = '60s'`);
    return {
      entries: (want.has("entries") ? await loadPaged(q, "metric_entries", defs == null ? null : sql`metric_definition_id = ANY(${ints(defs)}::int[])`) : []) as unknown as CheckInEntry[],
      notes: (want.has("notes") ? await loadPaged(q, "check_in_notes", ids == null ? null : sql`client_id = ANY(${ints(ids)}::int[])`) : []) as unknown as CheckInNote[],
    };
  });
  return new CheckInRows(MINT, path, listHolder(got), null);
}
const PAGE = 2000;
async function loadPaged(q: Q, t: CheckInTable, where: SQL | null): Promise<Row[]> {
  const decode = decodeOf(t);
  const table = sql.identifier(t);
  const out: Row[] = [];
  for (let after = 0; ; ) {
    const page = await q(where ? sql`SELECT * FROM ${table} WHERE id > ${after}::int AND ${where} ORDER BY id LIMIT ${PAGE}` : sql`SELECT * FROM ${table} WHERE id > ${after}::int ORDER BY id LIMIT ${PAGE}`);
    for (const r of page) out.push(decode(r));
    if (page.length < PAGE) break;
    after = Number(page[page.length - 1].id);
  }
  return out;
}

/**
 * No figures at all, for a caller that knows its reader reads none: any need of it is a miss, thrown where views are
 * narrow, else said, counted and answered from the store.
 */
export function noCheckInRows(path: CheckInReadPath): CheckInRows {
  const scope = makeScope([]);
  if (CHECKINS_PG || MODE === "narrow") return new CheckInRows(MINT, path, listHolder({ entries: [], notes: [] }), scope);
  return new CheckInRows(MINT, path, storeHolder, scope);
}

// ---- Writes --------------------------------------------------------------------------------------------------------

/** A key as Postgres holds it (CHECKINS_STORE=pg alone: memory mode keeps it as typed, as before). */
export function checkInKey(s: string): string {
  return CHECKINS_PG ? cleanText(s) : s;
}

const lockOf = (clientId: number) => sql`SELECT pg_advisory_xact_lock(20254, ${clientId}::int)`;

function changedRows(t: CheckInTable, before: readonly { id: number }[], after: readonly { id: number }[]) {
  const was = new Map(before.map((r) => [r.id, JSON.stringify(recordForWrite(t, r as unknown as Row))] as const));
  const upserts: Row[] = [];
  const upserted: { id: number }[] = [];
  const seen = new Set<number>();
  for (const r of after) {
    seen.add(r.id);
    const rec = recordForWrite(t, r as unknown as Row);
    if (!rec) throw new Error(`[checkins] a ${t} row the writer can't encode (id ${String(r.id)})`);
    if (was.get(r.id) !== JSON.stringify(rec)) {
      upserts.push(rec);
      upserted.push(r);
    }
  }
  const deletes = before.filter((r) => !seen.has(r.id)).map((r) => r.id);
  return { upserts, upserted, deletes };
}

/** A table's columns as this build's schema has them (as the store's writer writes them; food/rows.ts's reasons). */
const COLUMNS = new Map<string, { field: string; name: string }[]>();
function schemaColumns(name: string, table: PgTable): { field: string; name: string }[] {
  let cols = COLUMNS.get(name);
  if (!cols) {
    cols = Object.entries(getTableColumns(table) as Record<string, Column>).map(([field, c]) => ({ field, name: c.name }));
    COLUMNS.set(name, cols);
  }
  return cols;
}
function byColumnName(rec: Row, cols: readonly { field: string; name: string }[]): Row {
  const out: Row = {};
  for (const c of cols) if (c.field in rec) out[c.name] = rec[c.field];
  return out;
}
const quoted = (n: string) => `"${n.replace(/"/g, '""')}"`;

/**
 * The rows written as the store's writer writes them. Each rewrites a row only for its own client (a figure through its
 * client's metrics, a note by its client): an id another client's row holds fails the write whole.
 */
async function writeRows(q: Q, t: CheckInTable, clientId: number, clientDefs: readonly number[], upserts: Row[], deletes: number[]) {
  const table = sql.identifier(t);
  const own = t === "metric_entries" ? sql`${table}.metric_definition_id = ANY(${ints(clientDefs)}::int[])` : sql`${table}.client_id = ${clientId}::int`;
  if (deletes.length) await q(sql`DELETE FROM ${table} WHERE id = ANY(${ints(deletes)}::int[]) AND ${own}`);
  if (!upserts.length) return;
  const cols = schemaColumns(t, TABLE_OF[t]);
  const list = sql.raw(cols.map((c) => quoted(c.name)).join(", "));
  const set = sql.raw(cols.filter((c) => c.name !== "id").map((c) => `${quoted(c.name)} = EXCLUDED.${quoted(c.name)}`).join(", "));
  for (let i = 0; i < upserts.length; i += 500) {
    const slice = upserts.slice(i, i + 500);
    const batch = JSON.stringify(slice.map((r) => byColumnName(r, cols)));
    const done = await q(sql`INSERT INTO ${table} (${list}) SELECT ${list} FROM jsonb_populate_recordset(NULL::${table}, ${batch}::jsonb) ON CONFLICT (id) DO UPDATE SET ${set} WHERE ${own} RETURNING id`);
    if (done.length !== slice.length) throw new Error(`${t}: ${slice.length - done.length} row(s) whose id another client's row holds; nothing written`);
  }
}

/** The reach read under the lock, inside the write's transaction. */
async function loadReach(q: Q, clientId: number, reach: CheckInReach): Promise<Lists> {
  const out: Lists = { entries: [], notes: [] };
  if (reach.defIds.length) {
    const ids = sql`${ints(reach.defIds)}::int[]`;
    const span =
      reach.span === "all"
        ? sql`TRUE`
        : "periods" in reach.span
          ? sql`period COLLATE "C" IN (SELECT jsonb_array_elements_text(${textJson(reach.span.periods)}::jsonb))`
          : sql`period COLLATE "C" >= ${reach.span.from}::text AND period COLLATE "C" <= ${reach.span.to}::text`;
    out.entries = (await q(sql`SELECT * FROM metric_entries WHERE metric_definition_id = ANY(${ids}) AND ${span} ORDER BY id`)).map(decodeOf("metric_entries")) as unknown as CheckInEntry[];
  }
  if (reach.notes?.length) {
    const kinds = textJson(reach.notes.map((n) => n.kind));
    const periods = textJson(reach.notes.map((n) => n.period));
    out.notes = (
      await q(sql`SELECT * FROM check_in_notes WHERE client_id = ${clientId}::int AND (kind, period) IN (
        SELECT * FROM unnest(ARRAY(SELECT jsonb_array_elements_text(${kinds}::jsonb)), ARRAY(SELECT jsonb_array_elements_text(${periods}::jsonb)))) ORDER BY id`)
    ).map(decodeOf("check_in_notes")) as unknown as CheckInNote[];
  }
  return out;
}

/** What the last store save committed holds this row (a metric definition, a client): pg/store.ts PgStoreWriter.committedHas. */
function committedHas(name: string, id: number): boolean {
  const w = (globalThis as unknown as { _pgWriter?: { committedHas?(name: string, id: number | string): boolean } })._pgWriter;
  return !w?.committedHas || w.committedHas(name, id);
}
class NotYetSaved extends Error {
  constructor(what: string) {
    super(`[checkins] ${what} is not saved yet`);
    this.name = "NotYetSaved";
  }
}

export type CheckInHooks = {
  /** Inside the transaction, after the rows are written and before its commit (pg mode alone): a Measure note waits for its values' save. */
  beforeCommit?: () => Promise<void>;
  /** After the commit, still on the client's chain (both modes): memory's own changes that follow the rows (a merge's definitions). */
  afterCommit?: (answer: unknown) => void;
};

/**
 * One write of a client's figures and notes. Memory: `body` runs on the store, today's code exactly (it saves as it always
 * did), its answer comes back. Postgres: one transaction under the client's lock (after the client's writes before it):
 * the client still here, the reach evaluated now (from memory as it is under the lock: a metric gone is left out), loaded,
 * `body` run on copies of it, the rows it changed written (each figure only for a metric and a client the store's last
 * save holds: else the store is saved first and the write runs once more), then committed, then `afterCommit`.
 */
export async function writeCheckIns<T>(path: CheckInWritePath, clientId: number, reach: () => CheckInReach, body: (box: CheckInBox) => T, hooks: CheckInHooks = {}): Promise<T> {
  noteCheckInsWrite(path);
  if (!CHECKINS_PG) {
    const answer = body(storeBox(path));
    hooks.afterCommit?.(answer);
    return answer;
  }
  let saved = false;
  for (let moved = 0; ; ) {
    let inner: { error: unknown; again?: boolean } | null = null;
    try {
      return await checkinWriteRaw(`ck:${clientId}`, {
        op: path,
        run: async (_q, inTx) => {
          const answer = await inTx(async (q) => {
            inner = null;
            await q(lockOf(clientId));
            // A client erased meanwhile (removeClient: a write queued behind its DELETE) writes nothing.
            if (!getData().clients.some((c) => c.id === clientId)) {
              const error = new Error(`[checkins] client ${clientId} is gone; nothing written`);
              inner = { error };
              throw error;
            }
            const clientDefs = getData()
              .metric_definitions.filter((d) => d.client_id === clientId)
              .map((d) => d.id);
            const own = new Set(clientDefs);
            const asked = reach();
            const askedJson = JSON.stringify(asked);
            // Only this client's metrics still in memory: one removed or merged meanwhile is left out of the write.
            const r: CheckInReach = { ...asked, defIds: asked.defIds.filter((id) => own.has(id)) };
            const before = await loadReach(q, clientId, r);
            const lists: Lists = { entries: before.entries.map((e) => structuredClone(e)), notes: before.notes.map((n) => structuredClone(n)) };
            const scope = makeScope([[clientId, r.span === "all" ? ["all"] : [r.span]]]);
            const box = new CheckInBox(MINT, path, listHolder(lists), scope, r, () => {});
            let out: T;
            try {
              out = body(box);
            } catch (error) {
              // A coach's change off this client's chain (a metric added, copied, its rhythm set) landed while the reach
              // loaded, so the body met a metric the reach didn't hold: the write runs once more on the reach as it is now.
              let again = false;
              if (error instanceof CheckInViewMiss) {
                try {
                  again = JSON.stringify(reach()) !== askedJson;
                } catch {
                  again = false;
                }
              }
              inner = { error, again };
              throw error;
            }
            const e = changedRows("metric_entries", before.entries, lists.entries);
            const n = changedRows("check_in_notes", before.notes, lists.notes);
            // A figure only for a metric (and a client) the store's last save holds: a metric added a moment ago whose save
            // hasn't committed yet (its id from `_seq`, which a crash would hand out again) waits for it.
            if (e.upserts.length || n.upserts.length) {
              if (!committedHas("clients", clientId)) throw new NotYetSaved(`client ${clientId}`);
              for (const row of e.upserted as unknown as CheckInEntry[]) if (!committedHas("metric_definitions", row.metric_definition_id)) throw new NotYetSaved(`metric ${row.metric_definition_id}`);
            }
            await writeRows(q, "metric_entries", clientId, clientDefs, e.upserts, e.deletes);
            await writeRows(q, "check_in_notes", clientId, clientDefs, n.upserts, n.deletes);
            if (hooks.beforeCommit) await hooks.beforeCommit();
            // Tests alone (checkins/pg.ts faultBeforeCommit): every statement sent, the commit not yet.
            throwIfFaultBeforeCommit(path);
            return out;
          });
          hooks.afterCommit?.(answer);
          return answer;
        },
      });
    } catch (error) {
      const thrown = inner as { error: unknown; again?: boolean } | null;
      if (thrown) {
        if (thrown.again && moved < 2) {
          moved++;
          continue;
        }
        throw thrown.error;
      }
      // The store's save first, then the write once more (a second miss throws).
      const notSaved = error instanceof NotYetSaved || (error instanceof Error && /is not saved yet/.test(error.message));
      if (notSaved && !saved) {
        saved = true;
        await persistNow();
        continue;
      }
      throw error;
    }
  }
}

/**
 * A metric removed with every figure logged for it (the coach's "delete logged too", the old admin's remove). Memory:
 * `inMemory` (today's removal: the days kept, the definition and its figures gone) on the store's own rows, and saved.
 * Postgres, on the client's chain, ordered so a crash loses nothing but the moment's work: the figures read; then in
 * memory `inMemory` on them (the days kept, the definition gone) and a tombstone naming the metric, saved and waited for
 * (a failed save stops here: the tombstone saved later, or the next boot, finishes it); then the figures deleted in their
 * own transaction; then the tombstone cleared. Any boot finding a tombstone deletes what it names (checkins/boot.ts).
 */
export async function removeMetricWithReadings(defId: number, inMemory: (box: CheckInBox) => void, path: CheckInWritePath = "w.def.remove"): Promise<void> {
  noteCheckInsWrite(path);
  if (!CHECKINS_PG) {
    inMemory(storeBox(path));
    return;
  }
  const def = getData().metric_definitions.find((m) => m.id === defId);
  if (!def) return;
  const clientId = def.client_id;
  await checkinWriteRaw(`ck:${clientId}`, {
    op: path,
    run: async (_q, inTx) => {
      const rows = await inTx(async (q) => {
        await q(lockOf(clientId));
        return (await q(sql`SELECT * FROM metric_entries WHERE metric_definition_id = ${defId}::int ORDER BY id`)).map(decodeOf("metric_entries")) as unknown as CheckInEntry[];
      });
      if (!getData().metric_definitions.some((m) => m.id === defId)) return;
      const lists: Lists = { entries: rows, notes: [] };
      // The tombstone first, so every save from here (inMemory's own too) carries it with the definition gone.
      setTombstone(defId, { client: clientId, at: new Date().toISOString() });
      inMemory(new CheckInBox(MINT, path, listHolder(lists), null, null, () => {}));
      try {
        await persistNow();
      } catch {
        // Left in memory: a later save writes the tombstone with the definition gone; once one has, the DELETE runs
        // (finishRemovalLater), and any boot before that deletes the figures. The backup's copy leaves them out meanwhile.
        finishRemovalLater(defId, clientId, path);
        return;
      }
      try {
        await inTx(async (q) => {
          await q(lockOf(clientId));
          await q(sql`DELETE FROM metric_entries WHERE metric_definition_id = ${defId}::int`);
        });
      } catch {
        // The removal is done and saved (the metric gone, the tombstone with it): a DELETE that failed is tried again a
        // minute later (finishRemovalLater), and any boot before that deletes the figures. Never thrown to the coach: the
        // metric is already off the screen, so the error would only invite a second try of something done.
        finishRemovalLater(defId, clientId, path);
        return;
      }
      clearTombstone(defId);
      persist();
    },
  });
}

/**
 * A removal whose save failed (CHECKINS_STORE=pg): tried again a minute later, up to 30 times, on the client's chain:
 * the store saved (the tombstone with the definition gone), then the figures deleted and the tombstone cleared. Stops
 * when the tombstone is gone (an erase, or a boot) or the metric is back in memory.
 */
function finishRemovalLater(defId: number, clientId: number, path: CheckInWritePath, tries = 0) {
  if (tries >= 30) return;
  const timer = setTimeout(() => {
    const again = () => finishRemovalLater(defId, clientId, path, tries + 1);
    const pending = () => String(defId) in tombstones() && !getData().metric_definitions.some((m) => m.id === defId);
    if (!pending()) return;
    void checkinWriteRaw(`ck:${clientId}`, {
      op: path,
      run: async (_q, inTx) => {
        if (!pending()) return;
        try {
          await persistNow();
        } catch {
          again();
          return;
        }
        if (!pending()) return;
        await inTx(async (q) => {
          await q(lockOf(clientId));
          await q(sql`DELETE FROM metric_entries WHERE metric_definition_id = ${defId}::int`);
        });
        clearTombstone(defId);
        persist();
      },
    }).catch(again);
  }, 60_000);
  (timer as { unref?: () => void }).unref?.();
}

type Tombstones = Record<string, { client: number; at: string }>;
/** The tombstones in memory (a store key kept in kv), read only: none is {} (the key is never made by a read). */
function tombstones(): Tombstones {
  // chat-door: notes-door: food-door: one kv key by its own name (the tombstones), never a walk of the store.
  const t = (getData() as unknown as Record<string, unknown>)[CHECKINS_REMOVING];
  return t && typeof t === "object" && !Array.isArray(t) ? (t as Tombstones) : {};
}
function setTombstone(defId: number, v: { client: number; at: string }) {
  // chat-door: notes-door: food-door: the same key, written by name.
  (getData() as unknown as Record<string, unknown>)[CHECKINS_REMOVING] = { ...tombstones(), [String(defId)]: v };
}
/** One tombstone cleared; the key itself gone with the last, so kv holds nothing once every removal finished. */
function clearTombstone(defId: number) {
  const next = { ...tombstones() };
  delete next[String(defId)];
  // chat-door: notes-door: food-door: the same key, by name.
  const d = getData() as unknown as Record<string, unknown>;
  if (Object.keys(next).length) d[CHECKINS_REMOVING] = next;
  else delete d[CHECKINS_REMOVING];
}

/**
 * Under the client's lock (CHECKINS_STORE=pg): whether this metric holds any figure at all (null and the phone's too);
 * when none, `then` runs inside the lock (memory's change: the definition gone, no figure to delete), and the store is
 * saved after. Memory mode: nothing (the page's render does it, as before).
 */
export async function whileNoFigures(clientId: number, defId: number, then: () => void, path: CheckInWritePath = "w.def.dropUnused"): Promise<boolean> {
  if (!CHECKINS_PG) return false;
  noteCheckInsWrite(path);
  const gone = await checkinWriteRaw(`ck:${clientId}`, {
    op: path,
    run: async (_q, inTx) =>
      inTx(async (q) => {
        await q(lockOf(clientId));
        const any = (await q(sql`SELECT EXISTS (SELECT 1 FROM metric_entries WHERE metric_definition_id = ${defId}::int) AS any`))[0]?.any === true;
        if (any || !getData().metric_definitions.some((m) => m.id === defId)) return false;
        then();
        return true;
      }),
  });
  if (gone) await persistNow();
  return gone;
}

/**
 * Every figure of a client's metrics and every note of theirs, deleted (the erase, before memory's own): one transaction,
 * the metrics a removal's tombstone names for them included. Memory mode: nothing (removeClient's own filters).
 */
export async function deleteClientCheckIns(clientId: number, defIds: readonly number[], path: CheckInWritePath = "w.client.delete"): Promise<void> {
  noteCheckInsWrite(path);
  if (!CHECKINS_PG) return;
  const tomb = Object.entries(tombstones())
    .filter(([, t]) => t?.client === clientId)
    .map(([id]) => Number(id));
  const ids = [...new Set([...defIds, ...tomb])];
  await checkinWriteRaw(`ck:${clientId}`, {
    op: path,
    run: async (_q, inTx) =>
      inTx(async (q) => {
        await q(sql`SET LOCAL statement_timeout = '60s'`);
        await q(lockOf(clientId));
        if (ids.length) await q(sql`DELETE FROM metric_entries WHERE metric_definition_id = ANY(${ints(ids)}::int[])`);
        await q(sql`DELETE FROM check_in_notes WHERE client_id = ${clientId}::int`);
      }),
  });
  for (const id of tomb) clearTombstone(id);
}

/** The erase's second sweep, once the client is gone from memory: anything a write queued before it committed after it. */
export async function sweepClientCheckIns(clientId: number, defIds: readonly number[]): Promise<void> {
  if (!CHECKINS_PG) return;
  await deleteClientCheckIns(clientId, defIds, "w.client.delete");
}

/** Every figure, gone (the workspace reset; its notes stay, as the reset leaves them today). */
export async function wipeAllCheckIns(): Promise<void> {
  noteCheckInsWrite("w.wipe");
  if (!CHECKINS_PG) {
    storeHolder.set("entries", []);
    return;
  }
  // Every write still on a client's chain settled first, so a figure saved while the reset ran never lands after its DELETE.
  await checkInChainsSettled();
  await checkinWriteRaw(null, {
    op: "w.wipe",
    run: async (_q, inTx) => inTx(async (q) => void (await q(sql`DELETE FROM metric_entries`))),
  });
  await checkInChainsSettled();
  await checkinWriteRaw(null, {
    op: "w.wipe",
    run: async (_q, inTx) => inTx(async (q) => void (await q(sql`DELETE FROM metric_entries`))),
  });
}

// ---- Whole-store copies --------------------------------------------------------------------------------------------

/** Where each check-in key sits among the store's keys (db.ts emptyData's order): after this one. */
// food-door: the notes sit after the saved days' key, which withFoodKeys has put in place already (a name, never a read);
// a copy without it (the food diary in Postgres, its keys not laid in) has them after off_foods, the key before it.
const KEY_AFTER: Record<CheckInTable, string> = { check_in_notes: "saved_days", metric_entries: "metric_definitions" };
const KEY_AFTER_ELSE: Partial<Record<CheckInTable, string>> = { check_in_notes: "off_foods" };

/**
 * A whole-store copy with the two keys in their places (the export, the backup's JSON, the shutdown dump). In memory mode
 * the store holds them already: the same object back, so nothing changes. With CHECKINS_STORE=pg they are put where the
 * store would hold them, from these rows, and `_checkins_in_postgres` says so when there are none, so a build that
 * doesn't know refuses it. The tombstones stay with this database (never in a copy).
 */
export function withCheckInKeys<T extends Record<string, unknown>>(data: T, rows: CheckInRows | null): T {
  if (!CHECKINS_PG) return data;
  // The figures of a metric a removal took out whose DELETE hasn't committed yet are left out of the copy, as the
  // tombstone is: restored, they would be orphans no boot ever deletes.
  const live = new Set((Array.isArray(data.metric_definitions) ? (data.metric_definitions as { id: number }[]) : getData().metric_definitions).map((m) => m.id));
  const dead = new Set(
    Object.keys(tombstones())
      .map(Number)
      .filter((id) => Number.isInteger(id) && !live.has(id))
  );
  const lists = rows ? { metric_entries: dead.size ? rows.entries.filter((e) => !dead.has(e.metric_definition_id)) : [...rows.entries], check_in_notes: [...rows.notes] } : null;
  const out: Record<string, unknown> = {};
  const placed = new Set<string>();
  const place = (key: string) => {
    for (const t of CHECKINS_TABLES) {
      if (placed.has(t) || (KEY_AFTER[t] !== key && !(KEY_AFTER_ELSE[t] === key && !(KEY_AFTER[t] in data)))) continue;
      placed.add(t);
      out[t] = lists ? lists[t] : [];
      place(t);
    }
  };
  // chat-door: notes-door: food-door: a copy of the keys as they are handed in (the other doors' keys already in place).
  for (const [k, v] of Object.entries(data)) {
    if ((CHECKINS_TABLES as readonly string[]).includes(k) || k === CHECKINS_REMOVING) continue;
    out[k] = v;
    place(k);
  }
  for (const t of CHECKINS_TABLES) if (!placed.has(t)) out[t] = lists ? lists[t] : [];
  if (!lists) out._checkins_in_postgres = true;
  return out as T;
}

/** For /api/timing. */
export function checkInsStoreReport() {
  const t = CHECKINS_PG ? Object.keys(tombstones()).length : 0;
  return { pg: CHECKINS_PG, views: MODE, strict: STRICT, tombstones: t };
}

/** Each short name's table (the shadow and the boot). */
export const checkInTableOf = (short: CheckInShort) => CHECKIN_SHORT[short];
export { SHORT_OF as CHECKIN_SHORT_OF };
export type { Q, Row };
