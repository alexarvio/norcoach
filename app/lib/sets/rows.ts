// The one door to the logged sets (set_logs; 22 Nov, Step 6 quest 10 of docs/database-plan.md, the Archive Campaign's
// quest 9 and last, "The Unmaking of the Ring"). Every read and write of them goes through here; nothing else in app/
// touches the store's list (Data.set_logs is a sealed type in db.ts, so tsc refuses any other reach for it, and
// scripts/check-sets-door.mjs, run by the build, refuses the name). Built on the check-ins' recipe (checkins/rows.ts, its
// own file untouched). The sessions (program_days) and the plan (workout_assignments) stay in memory: a view matches a set
// to its client through them, read from memory when it is asked, never by a join.
//
// The code that reads and writes the sets stays where it was (queries.ts, the boards, appLock.ts, liveSessionNow.ts): it
// is handed a SetRows (a reader's view) or a SetBox (a writer's), the list under the short name `logs`, and runs on it
// exactly as it ran on the store.
//
//   memory, SETS_VIEWS=wide   (the default) a view and a box are the store itself: `logs` is the store's own array, read
//                             and replaced in place, so every line behaves exactly as before. A reader asking a view for
//                             a row its fetch didn't take is a miss, said once and counted.
//   memory, SETS_VIEWS=narrow a view holds only the sets its fetch took (the same objects, in store order): what the
//                             cut-over's queries hand back. A miss throws. Writes always run on the store.
//   SETS_STORE=pg             (sets/mode.ts) the sets are in Postgres alone: a fetch reads its scope in one snapshot,
//                             ordered by id as the store holds them; a write is one transaction under the client's lock
//                             (writeSets): the reach loaded, the code run on it, the rows it changed written back. A miss
//                             throws.
//
// A reader handed no view doesn't compile (every reader takes one); a page, route, action or job fetches first.
//
// The cardio ticks (cardio_logs) came through the same door on 22 Nov (Alex: "move cardio as well"): a view and a box
// carry them beside the sets as `ticks`, under the same switches, in the same snapshot and the same transaction. A tick
// belongs to a cardio entry (cardio_entries, the coach's, in memory), which belongs to a day: a view holds the ticks of the
// days it holds (`needTicks`), every tick of a client it holds whole or by "logged" (`need`, `needLogged`), and a
// client's first tick for "any" (`needLogged(…, true)`). A write names the days whose ticks it reads and changes
// (writeSets' `ticks`).

import { getTableColumns, sql, type Column } from "drizzle-orm";
import { allocId, getData, persist, persistNow, type CardioTickRow, type Data, type SetLogRow } from "../db";
import { cardio_logs, set_logs } from "../pg/schema";
import { fromRecord, recordForWrite } from "../pg/store";
import { oddSet, readerStampMs, SQL_ODD_SET, STAMP_MARGIN_MS, isoOf, TOP_ROUNDS_DAYS } from "../pg/feedSlices";
import { FEED_KIND_ROWS, HOME_NEW_DAYS } from "../chat/pick";
import { SETS_PG, SETS_REMOVING, SETS_TABLES } from "./mode";
import { SETS_SHAPE, type SetReadPath, type SetWritePath } from "./paths";
import { lostConnection, poolWait, setChainsSettled, setsRead, setsWriteRaw, throwIfFaultBeforeCommit, type Q, type Row } from "./pg";
import { noteSetsMissed, noteSetsSeen, noteSetsWrite, onSetsFetch, setsShadowReads } from "./shadow";

export { SETS_TABLES };
export type { CardioTickRow, SetLogRow };

const MODE: "wide" | "narrow" = SETS_PG || process.env.SETS_VIEWS === "narrow" ? "narrow" : "wide";
/** Where a miss throws rather than being said: always with the sets in Postgres (there is no store to fall back on). */
const STRICT = SETS_PG || MODE === "narrow" || process.env.NODE_ENV === "test" || process.env.SETS_STRICT === "1";

/** A view asked for what it doesn't hold. */
export class SetViewMiss extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetViewMiss";
  }
}

// ---- The plan's rows and days, from memory --------------------------------------------------------------------------

type Day = Data["program_days"][number];
/** Each row's day and client, each day's rows, each client's days: built once per state of the two lists. */
type Row_ = Data["workout_assignments"][number];
type RowIndex = {
  state: unknown[];
  /** The two lists' ids and links hashed (rowPrint): what an in-place change (a row moved to another day) changes. */
  print: string;
  dayOfRow: Map<number, number>;
  clientOfDay: Map<number, number>;
  rowsOfDay: Map<number, number[]>;
  daysOfClient: Map<number, Day[]>;
  /** The objects the maps were read from (the first of an id), so a write can check its own rows are as indexed. */
  rowObj: Map<number, Row_>;
  dayObj: Map<number, Day>;
};
let rowCache: RowIndex | null = null;
/** Every row's (id, day) and every day's (id, client), hashed twice: one pass of arithmetic, no allocation. */
function rowPrint(data: Data): string {
  let a = 0x811c9dc5;
  let b = 0x1b873593;
  for (const wa of data.workout_assignments) {
    a = Math.imul(a ^ wa.id, 0x01000193) ^ Number(wa.program_day_id);
    b = Math.imul(b + Number(wa.program_day_id), 0x5bd1e995) ^ wa.id;
  }
  for (const pd of data.program_days) {
    a = Math.imul(a ^ pd.id, 0x01000193) ^ Number(pd.client_id);
    b = Math.imul(b + Number(pd.client_id), 0x5bd1e995) ^ pd.id;
  }
  return `${a | 0}:${b | 0}`;
}
/**
 * Each row's day and client from memory. Plain: rebuilt when either list is a new array, changed length or ends on
 * another object (cheap; the readers' checks). `verified` (every fetch and write with SETS_STORE=pg or narrow views): also
 * when any row's day or day's client changed in place, read by one hashing pass (rowPrint) rather than built afresh.
 */
function rowIndex(verified = false): RowIndex {
  const data = getData();
  const lists = [data.workout_assignments, data.program_days] as unknown[][];
  const state = lists.flatMap((l) => [l, l.length, l[l.length - 1]]);
  const same = !!rowCache && rowCache.state.every((v, i) => v === state[i]);
  if (same && !verified) return rowCache!;
  const print = rowPrint(data);
  if (same && rowCache!.print === print) return rowCache!;
  const clientOfDay = new Map<number, number>();
  const daysOfClient = new Map<number, Day[]>();
  const dayObj = new Map<number, Day>();
  for (const pd of data.program_days) {
    // The first of an id, as find reads it.
    if (!clientOfDay.has(pd.id)) {
      clientOfDay.set(pd.id, pd.client_id);
      dayObj.set(pd.id, pd);
    }
    const list = daysOfClient.get(pd.client_id) ?? [];
    list.push(pd);
    daysOfClient.set(pd.client_id, list);
  }
  const dayOfRow = new Map<number, number>();
  const rowsOfDay = new Map<number, number[]>();
  const rowObj = new Map<number, Row_>();
  for (const wa of data.workout_assignments) {
    if (!dayOfRow.has(wa.id)) {
      dayOfRow.set(wa.id, wa.program_day_id);
      rowObj.set(wa.id, wa);
    }
    const list = rowsOfDay.get(wa.program_day_id) ?? [];
    list.push(wa.id);
    rowsOfDay.set(wa.program_day_id, list);
  }
  rowCache = { state, print, dayOfRow, clientOfDay, rowsOfDay, daysOfClient, rowObj, dayObj };
  return rowCache;
}
/**
 * The index a write reads its own rows through (the hottest path: every set): the cached one when each of these rows is
 * still the object it was indexed from, on the same day of the same client, else one rebuilt. A row removed or added
 * changes its list (a new array, or its length), which the plain check sees.
 */
function rowIndexFor(rowIds: Iterable<number>): RowIndex {
  const ix = rowIndex();
  for (const r of rowIds) {
    const wa = ix.rowObj.get(r);
    const d = ix.dayOfRow.get(r);
    if (!wa || d == null || wa.id !== r || wa.program_day_id !== d) return rowIndex(true);
    const day = ix.dayObj.get(d);
    if (!day || day.id !== d || day.client_id !== ix.clientOfDay.get(d)) return rowIndex(true);
  }
  return ix;
}
const clientOfRow = (ix: RowIndex, rowId: number) => {
  const day = ix.dayOfRow.get(rowId);
  return day == null ? undefined : ix.clientOfDay.get(day);
};
/** Every row of these clients' days (the plan's and the sessions', as memory holds them now). */
function rowsOfClients(ix: RowIndex, clientIds: Iterable<number>): number[] {
  const out: number[] = [];
  for (const c of clientIds) for (const d of ix.daysOfClient.get(c) ?? []) out.push(...(ix.rowsOfDay.get(d.id) ?? []));
  return [...new Set(out)];
}
function rowsOfDays(ix: RowIndex, dayIds: Iterable<number>): number[] {
  const out: number[] = [];
  for (const d of dayIds) out.push(...(ix.rowsOfDay.get(d) ?? []));
  return [...new Set(out)];
}

// ---- What a fetch took ---------------------------------------------------------------------------------------------

/**
 * What a reader reads of a client: `all` (every set of every row of theirs), `{ rows }` (these rows' sets whole),
 * `{ days }` (every row of these days, whole), `loggedRows` (which of their rows hold a set: one set a row, never the
 * figures), `loggedAny` (whether they hold any set at all), or a coach-wide reader's training feed (`{ feedFrom: T }`:
 * every session whose moment may be at or after T, whole; `{ coachTop: n }`: the client's coach's newest n sessions as
 * news, whole), resolved into days at the fetch.
 */
export type SetSpan = "all" | { rows: readonly number[] } | { days: readonly number[] } | "loggedRows" | "loggedAny" | { feedFrom: number } | { coachTop: number };

type ClientScope = { all: boolean; logged: boolean; any: boolean; feed: number | null; top: number | null };
type Scope = {
  every: boolean;
  clients: Map<number, ClientScope>;
  /** Rows taken whole (asked, or resolved from days and feed asks). */
  rows: Set<number>;
  /** Rows of which one set (the lowest id) was taken, to say the row is logged. */
  loggedRows: Set<number>;
  /** Days whose cardio ticks were taken whole (asked, the days of rows asked, resolved from feed asks). A client taken
   *  whole or by "logged" has every tick of theirs besides. */
  tickDays: Set<number>;
  /** The index the scope was resolved against. */
  ix: RowIndex;
};
const emptyClient = (): ClientScope => ({ all: false, logged: false, any: false, feed: null, top: null });
function makeScope(asks: Iterable<readonly [number, readonly SetSpan[]]>, opts: { every?: boolean; fresh?: boolean; ix?: RowIndex } = {}): Scope {
  const ix = opts.ix ?? rowIndex(opts.fresh ?? (SETS_PG || MODE === "narrow"));
  const scope: Scope = { every: !!opts.every, clients: new Map(), rows: new Set(), loggedRows: new Set(), tickDays: new Set(), ix };
  for (const [id, spans] of asks) {
    const s = scope.clients.get(id) ?? emptyClient();
    for (const span of spans) {
      if (span === "all") s.all = true;
      else if (span === "loggedRows") s.logged = true;
      else if (span === "loggedAny") s.any = true;
      else if ("rows" in span)
        for (const r of span.rows) {
          scope.rows.add(r);
          const d = ix.dayOfRow.get(r);
          if (d != null) scope.tickDays.add(d);
        }
      else if ("days" in span) {
        for (const r of rowsOfDays(ix, span.days)) scope.rows.add(r);
        for (const d of span.days) scope.tickDays.add(d);
      }
      else if ("feedFrom" in span) s.feed = Math.min(s.feed ?? Infinity, span.feedFrom);
      else if ("coachTop" in span) s.top = Math.max(s.top ?? 0, span.coachTop);
    }
    scope.clients.set(id, s);
  }
  return scope;
}
const scopeOf = (clientIds: Iterable<number>, spans: readonly SetSpan[]) => makeScope([...new Set(clientIds)].map((id) => [id, spans] as const));

/** Whether the scope holds this row's sets whole. */
function holdsRow(scope: Scope, rowId: number): boolean {
  if (scope.every || scope.rows.has(rowId)) return true;
  const c = clientOfRow(scope.ix, rowId) ?? clientOfRow(rowIndex(), rowId);
  return c != null && !!scope.clients.get(c)?.all;
}
/** Whether the scope holds this day's cardio ticks whole. */
function holdsTickDay(scope: Scope, dayId: number): boolean {
  if (scope.every || scope.tickDays.has(dayId)) return true;
  const c = scope.ix.clientOfDay.get(dayId) ?? rowIndex().clientOfDay.get(dayId);
  const s = c == null ? undefined : scope.clients.get(c);
  return !!s && (s.all || s.logged);
}

// ---- The cardio entries, from memory --------------------------------------------------------------------------------

/** Each cardio entry's day (the coach's, in memory), the first of an id as find reads it. */
function entryDayMap(): Map<number, number> {
  const out = new Map<number, number>();
  for (const c of getData().cardio_entries ?? []) if (!out.has(c.id)) out.set(c.id, c.program_day_id);
  return out;
}
/** The cardio entries of these days, as memory holds them now. */
function entriesOfDays(dayIds: Iterable<number>): number[] {
  const days = new Set(dayIds);
  if (!days.size) return [];
  const out = new Set<number>();
  for (const c of getData().cardio_entries ?? []) if (days.has(c.program_day_id)) out.add(c.id);
  return [...out];
}
/** The days whose ticks a scope takes whole (its own, and every day of the clients it holds whole or by "logged"), and those clients. */
function tickScope(scope: Scope): { days: Set<number>; clients: number[]; anyClients: number[] } {
  const days = new Set(scope.tickDays);
  const clients: number[] = [];
  const anyClients: number[] = [];
  for (const [c, s] of scope.clients) {
    if (s.all || s.logged) {
      clients.push(c);
      for (const d of scope.ix.daysOfClient.get(c) ?? []) days.add(d.id);
    } else if (s.any) anyClients.push(c);
  }
  return { days, clients, anyClients };
}

// ---- The list: the store's, or a slice of it -----------------------------------------------------------------------

type Holder = { get(): SetLogRow[]; set(rows: SetLogRow[]): void; ticks(): CardioTickRow[]; setTicks(rows: CardioTickRow[]): void };
/** The store's own array, read fresh each time (a delete puts a new list in its place). Memory mode alone. */
const storeHolder: Holder = {
  get() {
    if (SETS_PG) throw new Error("[sets] !!! the store's set_logs was read with SETS_STORE=pg (they live in Postgres alone)");
    // chat-door: notes-door: food-door: checkins-door: one list by its own name (the sets), never a walk of the store.
    const held = getData() as unknown as Record<string, SetLogRow[] | undefined>;
    return (held.set_logs ??= []);
  },
  set(rows) {
    if (SETS_PG) throw new Error("[sets] !!! the store's set_logs was written with SETS_STORE=pg");
    // chat-door: notes-door: food-door: checkins-door: the same, the list replaced by name.
    (getData() as unknown as Record<string, SetLogRow[]>).set_logs = rows;
  },
  ticks() {
    if (SETS_PG) throw new Error("[sets] !!! the store's cardio_logs was read with SETS_STORE=pg (they live in Postgres alone)");
    // chat-door: notes-door: food-door: checkins-door: one list by its own name (the cardio ticks), never a walk. Read as
    // the readers read it (`data.cardio_logs ?? []`): never put into the store by a read.
    return (getData() as unknown as Record<string, CardioTickRow[] | undefined>).cardio_logs ?? [];
  },
  setTicks(rows) {
    if (SETS_PG) throw new Error("[sets] !!! the store's cardio_logs was written with SETS_STORE=pg");
    // chat-door: notes-door: food-door: checkins-door: the same, the list replaced by name.
    (getData() as unknown as Record<string, CardioTickRow[]>).cardio_logs = rows;
  },
};
function listHolder(list: { logs: SetLogRow[]; ticks?: CardioTickRow[] }): Holder {
  return {
    get: () => list.logs,
    set: (rows) => {
      list.logs = rows;
    },
    ticks: () => (list.ticks ??= []),
    setTicks: (rows) => {
      list.ticks = rows;
    },
  };
}

const MINT = Symbol("sets-door");
const said = new Set<string>();

/**
 * One fetch's sets and what was taken. A reader says what it reads first (need, needRows, needLogged), then reads `logs`
 * as it read the store; the list it was handed is the store's own or a superset slice of it, in the store's order, so its
 * own filters and sorts give what they always gave.
 */
export class SetRows {
  readonly path: SetReadPath | SetWritePath;
  protected readonly holder: Holder;
  protected readonly scope: Scope | null;
  constructor(token: symbol, path: SetReadPath | SetWritePath, holder: Holder, scope: Scope | null) {
    if (token !== MINT) throw new Error("Set rows are made by the door (app/lib/sets/rows.ts) alone.");
    this.path = path;
    this.holder = holder;
    this.scope = scope;
  }
  get logs(): SetLogRow[] {
    return this.holder.get();
  }
  /** The cardio ticks the fetch took (memory, wide: the store's own list), in the store's order. */
  get ticks(): CardioTickRow[] {
    return this.holder.ticks();
  }
  /** These days' cardio ticks, whole. */
  needTicks(reader: string, dayIds: Iterable<number>): void {
    const scope = this.scope;
    if (!scope || scope.every) return;
    let out = 0;
    let first: number | null = null;
    for (const d of dayIds) {
      if (holdsTickDay(scope, d)) continue;
      out++;
      first ??= d;
    }
    if (out) this.miss(`[sets] ${reader} on ${this.path}: the cardio ticks of ${out} session(s) were not fetched (session ${first})`);
  }
  /** Every set of every row of these clients (their whole history), and every cardio tick of theirs. */
  need(reader: string, clientIds: number | Iterable<number>): void {
    const scope = this.scope;
    if (!scope || scope.every) return;
    for (const id of typeof clientIds === "number" ? [clientIds] : clientIds) {
      if (scope.clients.get(id)?.all) continue;
      this.miss(`[sets] ${reader} on ${this.path}: client ${id}'s whole history was not fetched`);
    }
  }
  /** These rows' sets, whole. */
  needRows(reader: string, rowIds: Iterable<number>): void {
    const scope = this.scope;
    if (!scope || scope.every) return;
    let out = 0;
    let first: number | null = null;
    for (const r of rowIds) {
      if (holdsRow(scope, r)) continue;
      out++;
      first ??= r;
    }
    if (out) this.miss(`[sets] ${reader} on ${this.path}: the sets of ${out} row(s) were not fetched (row ${first})`);
  }
  /** These clients' sessions as news (activityFeeds): every session, or those whose news may be at or after T, or their
   *  coach's newest n. */
  needFeed(reader: string, clientIds: Iterable<number>, span: "all" | { feedFrom: number } | { coachTop: number }): void {
    const scope = this.scope;
    if (!scope || scope.every) return;
    for (const id of clientIds) {
      const s = scope.clients.get(id);
      if (s?.all) continue;
      if (span !== "all" && s && ("feedFrom" in span ? s.feed != null && s.feed <= span.feedFrom : s.top != null && s.top >= span.coachTop)) continue;
      this.miss(`[sets] ${reader} on ${this.path}: client ${id}'s sessions (${span === "all" ? "all" : JSON.stringify(span)}) were not fetched`);
    }
  }
  /** Whether the view holds these rows' sets whole (no miss counted): a write's rule asks before it runs. */
  holdsRows(rowIds: Iterable<number>): boolean {
    const scope = this.scope;
    if (!scope || scope.every) return true;
    for (const r of rowIds) if (!holdsRow(scope, r)) return false;
    return true;
  }
  /** Which of these clients' rows hold a set (one set a row is enough), and every tick of theirs; or with `any` only
   *  whether they hold a set (the first) and a tick (their first by its client). */
  needLogged(reader: string, clientIds: number | Iterable<number>, any = false): void {
    const scope = this.scope;
    if (!scope || scope.every) return;
    for (const id of typeof clientIds === "number" ? [clientIds] : clientIds) {
      const s = scope.clients.get(id);
      if (s && (s.all || s.logged || (any && s.any))) continue;
      this.miss(`[sets] ${reader} on ${this.path}: whether client ${id} logged ${any ? "a set" : "each row"} was not fetched`);
    }
  }
  protected miss(message: string) {
    noteSetsMissed(this.path, message);
    if (STRICT) throw new SetViewMiss(message);
    if (!said.has(message)) {
      said.add(message);
      console.warn(message);
    }
  }
}

/** A writer's rows: a view whose list can be replaced, ids allocated, and the save asked for. */
export class SetBox extends SetRows {
  private readonly onPersist: () => void;
  /** Ids an earlier try of the same write took and never inserted (writeSets' run once more), handed out first. */
  private readonly spare: number[];
  private readonly spareTicks: number[];
  constructor(token: symbol, path: SetWritePath, holder: Holder, scope: Scope | null, onPersist: () => void, spare: number[] = [], spareTicks: number[] = []) {
    super(token, path, holder, scope);
    this.onPersist = onPersist;
    this.spare = spare;
    this.spareTicks = spareTicks;
  }
  override get logs(): SetLogRow[] {
    return super.logs;
  }
  override set logs(rows: SetLogRow[]) {
    this.holder.set(rows);
  }
  override get ticks(): CardioTickRow[] {
    return super.ticks;
  }
  override set ticks(rows: CardioTickRow[]) {
    this.holder.setTicks(rows);
  }
  /** The ids this box handed out to ticks (inserted, never written over a tick holding one). */
  readonly allocatedTicks = new Set<number>();
  /** A new id for a cardio tick (its counter in memory mode; its sequence, pg/ids.ts, with SETS_STORE=pg). */
  allocTick(): number {
    const id = this.spareTicks.length ? this.spareTicks.shift()! : allocId("cardio_logs");
    this.allocatedTicks.add(id);
    return id;
  }
  /** The ids this box handed out (a write inserts them, never writes over a set holding one: writeSets). */
  readonly allocated = new Set<number>();
  /** A new id for a set (its sequence, pg/ids.ts, in both modes). */
  alloc(): number {
    const id = this.spare.length ? this.spare.shift()! : allocId("set_logs");
    this.allocated.add(id);
    return id;
  }
  /** The store's save (memory); nothing in Postgres mode, where writeSets writes what changed when the code is done. */
  persist(): void {
    this.onPersist();
  }
}

const storeBox = (p: SetWritePath) => new SetBox(MINT, p, storeHolder, null, persist);

/** The store's own list as a box (memory mode alone): the boot's tidies, the seed scripts. Throws with SETS_STORE=pg. */
export function storeSetBox(path: SetWritePath): SetBox {
  if (SETS_PG) throw new Error("[sets] storeSetBox with SETS_STORE=pg: write through writeSets instead");
  return storeBox(path);
}
/** A view of the store whole (memory mode alone), for a script comparing readers. */
export function storeSetRows(path: SetReadPath): SetRows {
  if (SETS_PG) throw new Error("[sets] storeSetRows with SETS_STORE=pg: fetch instead");
  return new SetRows(MINT, path, storeHolder, null);
}
/** A writer's committed sets read again as a view (afterCommit's rule, sets/rows.ts writeSets). */
function viewOf(path: SetWritePath, logs: SetLogRow[], ticks: CardioTickRow[], scope: Scope | null): SetRows {
  return new SetRows(MINT, path, listHolder({ logs, ticks }), scope);
}

// ---- The coach-wide asks resolved: sessions as news ------------------------------------------------------------------

/**
 * Where a set comes from while a feed ask is resolved: the store's (or what the last save committed), or SQL. Each gives
 * the sets of rows asked by id, and the rows of these clients with a set whose stamp may be at or after T (or odd).
 */
type SetSource = {
  ofRows(rows: readonly number[]): Promise<SetLogRow[]>;
  rowsSince(clients: readonly number[], t: number): Promise<Set<number>>;
  /** Each client's oldest readable set stamp (ms; a client with none left out): once a round's window starts at or
   *  before it, a later round would find no set of theirs more. */
  oldest(clients: readonly number[]): Promise<Map<number, number>>;
  /** The cardio ticks of these entries, whole, in id order (the store's, or SQL by `cardio_logs_entry_idx`). */
  ticksOf(entries: readonly number[]): Promise<CardioTickRow[]>;
};
const SQL_CHUNK = 5000;
function* chunks<T>(list: readonly T[], size = SQL_CHUNK): Generator<T[]> {
  for (let i = 0; i < list.length; i += size) yield list.slice(i, i + size);
}
const ints = (ids: Iterable<number>) => `{${[...ids].filter((n) => Number.isInteger(n)).join(",")}}`;
const decode = (r: Row) => fromRecord(set_logs, r) as unknown as SetLogRow;
const decodeTick = (r: Row) => fromRecord(cardio_logs, r) as unknown as CardioTickRow;
const byId = (a: { id: number }, b: { id: number }) => a.id - b.id;

function listSetSource(list: readonly SetLogRow[], ticks: readonly CardioTickRow[], ix: RowIndex): SetSource {
  // Each client's sets with their stamps read once, on the first ask (a resolve asks round after round).
  let byClient: Map<number, { s: SetLogRow; ms: number; odd: boolean }[]> | null = null;
  const grouped = () => {
    if (byClient) return byClient;
    byClient = new Map();
    for (const s of list) {
      const c = clientOfRow(ix, s.workout_assignment_id);
      if (c == null) continue;
      const l = byClient.get(c) ?? [];
      l.push({ s, ms: readerStampMs(String(s.logged_at ?? "")), odd: oddSet(s as unknown as Record<string, unknown>) });
      byClient.set(c, l);
    }
    return byClient;
  };
  return {
    async ofRows(rows) {
      const want = new Set(rows);
      return list.filter((s) => want.has(s.workout_assignment_id));
    },
    async rowsSince(clients, t) {
      const out = new Set<number>();
      for (const c of new Set(clients)) for (const x of grouped().get(c) ?? []) if (x.odd || (Number.isFinite(x.ms) && x.ms >= t - STAMP_MARGIN_MS)) out.add(x.s.workout_assignment_id);
      return out;
    },
    async oldest(clients) {
      const out = new Map<number, number>();
      for (const c of new Set(clients)) for (const x of grouped().get(c) ?? []) if (!x.odd && Number.isFinite(x.ms)) out.set(c, Math.min(out.get(c) ?? Infinity, x.ms));
      return out;
    },
    async ticksOf(entries) {
      const want = new Set(entries);
      return ticks.filter((t) => want.has(t.cardio_entry_id));
    },
  };
}
function sqlSetSource(q: Q): SetSource {
  return {
    async ofRows(rows) {
      const out: SetLogRow[] = [];
      for (const part of chunks([...rows])) for (const r of await q(sql`SELECT * FROM set_logs WHERE workout_assignment_id = ANY(${ints(part)}::int[]) ORDER BY id`)) out.push(decode(r));
      return out.sort(byId);
    },
    async rowsSince(clients, t) {
      const out = new Set<number>();
      for (const part of chunks([...clients])) {
        for (const r of await q(
          sql`SELECT DISTINCT workout_assignment_id AS w FROM set_logs WHERE client_id = ANY(${ints(part)}::int[]) AND (logged_at_tz >= ${isoOf(t - STAMP_MARGIN_MS)}::timestamptz OR ${sql.raw(SQL_ODD_SET())})`
        ))
          out.add(Number(r.w));
      }
      return out;
    },
    async oldest(clients) {
      const out = new Map<number, number>();
      for (const part of chunks([...new Set(clients)])) {
        // One min() a client, each read off the end of its (client_id, logged_at_tz) index: a GROUP BY over the clients
        // read every set they have (170 ms for a coach of 30 clients with 5000 sets each, 2.6 ms this way). The same rows:
        // a client with no stamp the zone can read has no line.
        for (const r of await q(
          sql`SELECT x.c, x.t FROM (SELECT c.id AS c, (SELECT (EXTRACT(EPOCH FROM min(s.logged_at_tz)) * 1000)::float8 FROM set_logs s WHERE s.client_id = c.id AND s.logged_at_tz IS NOT NULL) AS t FROM unnest(${ints(part)}::int[]) AS c(id)) x WHERE x.t IS NOT NULL`
        )) {
          const t = Number(r.t);
          if (Number.isFinite(t)) out.set(Number(r.c), t);
        }
      }
      return out;
    },
    async ticksOf(entries) {
      const out: CardioTickRow[] = [];
      for (const part of chunks([...new Set(entries)])) for (const r of await q(sql`SELECT * FROM cardio_logs WHERE cardio_entry_id = ANY(${ints(part)}::int[]) ORDER BY id`)) out.push(decodeTick(r));
      return out.sort(byId);
    },
  };
}

/**
 * The days a session-as-news reader may read for a client from T on (queries.ts activityFeeds' sessionNews): a session's
 * moment is always one of its own stamps (a set, a cardio tick, its end), so a day whose news is at or after T has a set
 * (by its stamp, or an odd one), a tick or an end at or after T, less the margin the stored instant may sit from the
 * readers' reading. The ends and starts are memory's; the ticks the source's (the store's, or SQL, since 22 Nov).
 */
/**
 * The cardio ticks a resolve reads (each day's latest tick, and the ticks themselves for the news counter), read once a
 * resolve from its source for the entries of the days of the clients it asks about, never once a round.
 */
type Ticks = { clients: Set<number>; tickDay: Map<number, number> | null; list: CardioTickRow[] };
const ticksFor = (clients: Iterable<number>): Ticks => ({ clients: new Set(clients), tickDay: null, list: [] });
async function tickDays(ix: RowIndex, memo: Ticks, src: SetSource): Promise<Map<number, number>> {
  if (memo.tickDay) return memo.tickDay;
  const data = getData();
  const days = new Set<number>();
  for (const c of memo.clients) for (const d of ix.daysOfClient.get(c) ?? []) days.add(d.id);
  const entryDay = new Map<number, number>();
  for (const c of data.cardio_entries ?? []) if (days.has(c.program_day_id)) entryDay.set(c.id, c.program_day_id);
  const list = entryDay.size ? await src.ticksOf([...entryDay.keys()]) : [];
  const ticks = new Map<number, number>();
  for (const l of list) if (entryDay.has(l.cardio_entry_id)) ticks.set(l.cardio_entry_id, Math.max(ticks.get(l.cardio_entry_id) ?? -Infinity, readerStampMs(String(l.done_at ?? ""))));
  const tickDay = new Map<number, number>();
  for (const [entry, day] of entryDay) {
    const ms = ticks.get(entry);
    if (ms != null && Number.isFinite(ms)) tickDay.set(day, Math.max(tickDay.get(day) ?? -Infinity, ms));
  }
  memo.list = list;
  return (memo.tickDay = tickDay);
}
/** Each client's oldest stamp memory holds for a session (an end, a tick): with the sets' oldest, where a window holds all. */
async function memoryOldest(ix: RowIndex, memo: Ticks, clients: Iterable<number>, src: SetSource): Promise<Map<number, number>> {
  const tickDay = await tickDays(ix, memo, src);
  const out = new Map<number, number>();
  for (const c of clients) {
    let m = Infinity;
    for (const d of ix.daysOfClient.get(c) ?? []) {
      const end = d.session_ended_at ? readerStampMs(d.session_ended_at) : NaN;
      if (Number.isFinite(end)) m = Math.min(m, end);
      const tick = tickDay.get(d.id);
      if (tick != null && Number.isFinite(tick)) m = Math.min(m, tick);
    }
    out.set(c, m);
  }
  return out;
}

async function feedDays(ix: RowIndex, clients: Map<number, number>, src: SetSource, memo: Ticks): Promise<Set<number>> {
  const out = new Set<number>();
  if (!clients.size) return out;
  const byT = new Map<number, number[]>();
  for (const [c, t] of clients) byT.set(t, [...(byT.get(t) ?? []), c]);
  for (const [t, list] of byT) for (const row of await src.rowsSince(list, t)) {
    const d = ix.dayOfRow.get(row);
    if (d != null) out.add(d);
  }
  // A client the memo was not built for: built again with them (a resolve names every client up front, so this is rare).
  if ([...clients.keys()].some((c) => !memo.clients.has(c))) {
    for (const c of clients.keys()) memo.clients.add(c);
    memo.tickDay = null;
  }
  const tickDay = await tickDays(ix, memo, src);
  for (const [c, t] of clients) {
    for (const d of ix.daysOfClient.get(c) ?? []) {
      const end = d.session_ended_at ? readerStampMs(d.session_ended_at) : NaN;
      const tick = tickDay.get(d.id);
      if ((Number.isFinite(end) && end >= t - STAMP_MARGIN_MS) || (tick != null && tick >= t - STAMP_MARGIN_MS)) out.add(d.id);
      // An end the reader can't read keeps the day (its news may be anything).
      if (d.session_ended_at && !Number.isFinite(end)) out.add(d.id);
    }
  }
  return out;
}

/**
 * Rounds of TOP_ROUNDS_DAYS over groups of clients (a coach's, or one client alone), each group settled on its own: in
 * the first window holding `need` sessions with news at or after its start (counted by `countNews`, activityFeeds' own
 * rule) or reaching back past every stamp its clients have (a later round would find nothing more: the window holds
 * every session of theirs), its days taken; a group settled by neither in the last round is read whole. Each round reads
 * only the days it hadn't (the windows only grow), and a group settled is asked no more, so a coach whose clients never
 * trained costs one round, never ten, and never holds up another coach.
 */
async function roundsByGroup(
  ix: RowIndex,
  groups: Map<number, { clients: number[]; need: number }>,
  src: SetSource,
  now: number,
  countNews: NewsCounter,
  memo: Ticks
): Promise<{ days: Set<number>; whole: number[] }> {
  const days = new Set<number>();
  const whole: number[] = [];
  if (!groups.size) return { days, whole };
  const groupOf = new Map<number, number>();
  for (const [g, { clients }] of groups) for (const c of clients) groupOf.set(c, g);
  const every = [...groupOf.keys()];
  // Where each client's stamps begin: the sets' (SQL or the list) and memory's ends and ticks.
  const setsOldest = await src.oldest(every);
  const memOldest = await memoryOldest(ix, memo, every, src);
  const oldestOf = new Map(every.map((c) => [c, Math.min(setsOldest.get(c) ?? Infinity, memOldest.get(c) ?? Infinity)] as const));
  let pending = new Set(groups.keys());
  const loaded = new Set<number>();
  const sets: SetLogRow[] = [];
  for (const span of TOP_ROUNDS_DAYS) {
    if (!pending.size) break;
    const t = now - span * 86_400_000;
    const asked = [...pending].flatMap((g) => groups.get(g)!.clients);
    const got = await feedDays(ix, new Map(asked.map((c) => [c, t] as const)), src, memo);
    const fresh = [...got].filter((d) => !loaded.has(d));
    for (const d of fresh) loaded.add(d);
    if (fresh.length) sets.push(...(await src.ofRows(rowsOfDays(ix, fresh))));
    sets.sort(byId);
    // The ticks the resolve read for these clients (memo.list): every tick of every entry on their days.
    await tickDays(ix, memo, src);
    const perClient = countNews(got, sets, memo.list, t);
    const perGroup = new Map<number, number>();
    for (const [c, n] of perClient) {
      const g = groupOf.get(c);
      if (g != null) perGroup.set(g, (perGroup.get(g) ?? 0) + n);
    }
    const settled = new Set<number>();
    for (const g of pending) {
      const { clients, need } = groups.get(g)!;
      const holdsAll = clients.every((c) => t - STAMP_MARGIN_MS <= oldestOf.get(c)!);
      if ((perGroup.get(g) ?? 0) >= need || holdsAll) settled.add(g);
    }
    for (const d of got) {
      const c = ix.clientOfDay.get(d);
      const g = c == null ? undefined : groupOf.get(c);
      if (g != null && settled.has(g)) days.add(d);
    }
    pending = new Set([...pending].filter((g) => !settled.has(g)));
  }
  for (const g of pending) whole.push(...groups.get(g)!.clients);
  return { days, whole };
}

/** activityFeeds' count of sessions as news at or after T, by client (queries.ts hands it over at load: no import cycle). */
/** The counter is handed the cardio ticks of the days' entries (the resolve's source) beside their sets. */
export type NewsCounter = (dayIds: Set<number>, sets: SetLogRow[], ticks: readonly CardioTickRow[], t: number) => Map<number, number>;
let newsCounter: NewsCounter | null = null;
export function setSessionNewsCounter(fn: NewsCounter) {
  newsCounter = fn;
}

/**
 * The window a client's sessions are read from, widened for the phone's workouts activityFeeds weighs against them (a
 * workout trained in Norcoach as well is that session's row alone, by the session's span): each workout of theirs that
 * ends in the window, and their newest, from its start (health_workouts stay in memory).
 */
function feedWithHealth(feed: Map<number, number>): Map<number, number> {
  const out = new Map(feed);
  const hw = ((getData() as unknown as { health_workouts?: { client_id: number; start: string; end: string }[] }).health_workouts ?? []).filter((w) => out.has(w.client_id));
  const newest = new Map<number, { start: number; end: number }>();
  for (const w of hw) {
    const start = Date.parse(w.start);
    const end = Date.parse(w.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const t = feed.get(w.client_id)!;
    if (end >= t - STAMP_MARGIN_MS) out.set(w.client_id, Math.min(out.get(w.client_id)!, start - STAMP_MARGIN_MS));
    const n = newest.get(w.client_id);
    if (!n || end > n.end) newest.set(w.client_id, { start, end });
  }
  for (const [c, w] of newest) out.set(c, Math.min(out.get(c)!, w.start - STAMP_MARGIN_MS));
  return out;
}

/** The feed and top asks resolved onto the scope's rows. */
async function resolveScope(scope: Scope, src: SetSource, now: number): Promise<void> {
  const feed = new Map<number, number>();
  const top = new Map<number, number>();
  for (const [c, s] of scope.clients) {
    if (s.all) continue;
    if (s.feed != null) feed.set(c, s.feed);
    if (s.top != null) top.set(c, s.top);
  }
  const memo = ticksFor([...feed.keys(), ...top.keys()]);
  const take = (days: Iterable<number>) => {
    for (const d of days) {
      for (const r of scope.ix.rowsOfDay.get(d) ?? []) scope.rows.add(r);
      scope.tickDays.add(d);
    }
  };
  take(await feedDays(scope.ix, feedWithHealth(feed), src, memo));
  // And each such client's newest session as news, whenever it is (getClientHome's "quiet" reads every kind's newest):
  // client by client, the first window that holds one (or every stamp of theirs), else the client whole.
  if (feed.size && newsCounter) {
    const groups = new Map<number, { clients: number[]; need: number }>();
    for (const c of feed.keys()) if ((scope.ix.daysOfClient.get(c) ?? []).length) groups.set(c, { clients: [c], need: 1 });
    const got = await roundsByGroup(scope.ix, groups, src, now, newsCounter, memo);
    take(got.days);
    for (const c of got.whole) scope.clients.get(c)!.all = true;
  }
  // Each coach's newest n sessions as news (the Feed, Coaches), coach by coach.
  if (top.size) {
    if (!newsCounter) for (const c of top.keys()) scope.clients.get(c)!.all = true;
    else {
      const coachOf = new Map(getData().clients.map((c) => [c.id, c.coach_id ?? 0] as const));
      const groups = new Map<number, { clients: number[]; need: number }>();
      for (const [c, n] of top) {
        const k = coachOf.get(c) ?? 0;
        const g = groups.get(k) ?? { clients: [], need: 0 };
        g.clients.push(c);
        g.need = Math.max(g.need, n);
        groups.set(k, g);
      }
      const got = await roundsByGroup(scope.ix, groups, src, now, newsCounter, memo);
      take(got.days);
      for (const c of got.whole) scope.clients.get(c)!.all = true;
    }
  }
}

// ---- Fetch first ---------------------------------------------------------------------------------------------------

/** The rows whose sets the scope takes whole, and the rows whose one set says they are logged (from memory, at the fetch). */
function scopeRows(scope: Scope): { whole: number[]; logged: number[]; anyClients: number[] } {
  const whole = new Set(scope.rows);
  const allClients: number[] = [];
  const loggedClients: number[] = [];
  const anyClients: number[] = [];
  for (const [c, s] of scope.clients) {
    if (s.all) allClients.push(c);
    else if (s.logged) loggedClients.push(c);
    else if (s.any) anyClients.push(c);
  }
  for (const r of rowsOfClients(scope.ix, allClients)) whole.add(r);
  const logged = rowsOfClients(scope.ix, loggedClients).filter((r) => !whole.has(r));
  return { whole: [...whole], logged, anyClients };
}

/** The scope's sets from rows in store order (the store's, or what the last save committed): the predicate every slice follows. */
function cutRows(scope: Scope, list: readonly SetLogRow[]): SetLogRow[] {
  if (scope.every) return [...list];
  const { whole, logged, anyClients } = scopeRows(scope);
  const w = new Set(whole);
  const l = new Set(logged);
  const anyRows = new Set(rowsOfClients(scope.ix, anyClients));
  const firstOf = new Map<number, SetLogRow>();
  const anyFirst = new Map<number, SetLogRow>();
  for (const s of list) {
    if (l.has(s.workout_assignment_id)) {
      const b = firstOf.get(s.workout_assignment_id);
      if (!b || s.id < b.id) firstOf.set(s.workout_assignment_id, s);
    }
    if (anyRows.has(s.workout_assignment_id)) {
      const c = clientOfRow(scope.ix, s.workout_assignment_id)!;
      const b = anyFirst.get(c);
      if (!b || s.id < b.id) anyFirst.set(c, s);
    }
  }
  const extra = new Set<SetLogRow>([...firstOf.values(), ...anyFirst.values()]);
  return list.filter((s) => w.has(s.workout_assignment_id) || extra.has(s));
}

/**
 * The scope's cardio ticks from a list in store order (the store's, or what the last save committed): the ticks of the
 * entries on its days, every tick whose client it holds whole or by "logged", and for "any" a client's first tick (the
 * lowest id carrying their client, as appLock reads it). The predicate loadTicks follows.
 */
function cutTicks(scope: Scope, list: readonly CardioTickRow[]): CardioTickRow[] {
  if (scope.every) return [...list];
  const { days, clients, anyClients } = tickScope(scope);
  const entries = new Set(entriesOfDays(days));
  const whole = new Set(clients);
  const any = new Set(anyClients);
  const first = new Map<number, CardioTickRow>();
  for (const t of list) {
    if (!any.has(t.client_id)) continue;
    const b = first.get(t.client_id);
    if (!b || t.id < b.id) first.set(t.client_id, t);
  }
  const extra = new Set(first.values());
  return list.filter((t) => entries.has(t.cardio_entry_id) || whole.has(t.client_id) || extra.has(t));
}

/** The scope's cardio ticks read from Postgres (one snapshot), by id: the same predicate as cutTicks. */
async function loadTicks(q: Q, scope: Scope): Promise<CardioTickRow[]> {
  if (scope.every) return loadPagedTicks(q);
  const { days, clients, anyClients } = tickScope(scope);
  const out = new Map<number, CardioTickRow>();
  const take = (rows: Row[]) => {
    for (const r of rows) {
      const t = decodeTick(r);
      if (!out.has(t.id)) out.set(t.id, t);
    }
  };
  for (const part of chunks(entriesOfDays(days))) take(await q(sql`SELECT * FROM cardio_logs WHERE cardio_entry_id = ANY(${ints(part)}::int[]) ORDER BY id`));
  for (const part of chunks(clients)) take(await q(sql`SELECT * FROM cardio_logs WHERE client_id = ANY(${ints(part)}::int[]) ORDER BY id`));
  // A client's first tick: one probe of (client_id, id) a client, past any a tombstone names (memory dropped those).
  const dead = ints(deadEntries());
  for (const part of chunks(anyClients))
    take(await q(sql`SELECT t.* FROM unnest(${ints(part)}::int[]) AS c(id) CROSS JOIN LATERAL (SELECT * FROM cardio_logs t WHERE t.client_id = c.id AND COALESCE(t.cardio_entry_id = ANY(${dead}::int[]), false) = false ORDER BY t.id LIMIT 1) t`));
  return [...out.values()].sort(byId);
}
async function loadPagedTicks(q: Q): Promise<CardioTickRow[]> {
  const out: CardioTickRow[] = [];
  for (let after = 0; ; ) {
    const page = await q(sql`SELECT * FROM cardio_logs WHERE id > ${after}::int ORDER BY id LIMIT ${PAGE}`);
    for (const r of page) out.push(decodeTick(r));
    if (page.length < PAGE) break;
    after = Number(page[page.length - 1].id);
  }
  return out;
}
/**
 * The ticks a fetch in pg mode hands on: those of entries a coach's removal took out of memory whose DELETE is still to
 * commit (a tombstone names them) left out, as memory left them out at once.
 */
function liveTicks(list: CardioTickRow[]): CardioTickRow[] {
  const dead = deadEntries();
  return dead.size ? list.filter((t) => !dead.has(t.cardio_entry_id)) : list;
}

/** The scope read from Postgres (one snapshot), by id: the cut-over's own statements, the same in pg mode and in the shadow. */
async function loadScope(q: Q, scope: Scope): Promise<SetLogRow[]> {
  if (scope.every) return loadPaged(q, null);
  const { whole, logged, anyClients } = scopeRows(scope);
  const out = new Map<number, SetLogRow>();
  const take = (rows: Row[]) => {
    for (const r of rows) {
      const s = decode(r);
      if (!out.has(s.id)) out.set(s.id, s);
    }
  };
  for (const part of chunks(whole)) take(await q(sql`SELECT * FROM set_logs WHERE workout_assignment_id = ANY(${ints(part)}::int[]) ORDER BY id`));
  // Each row's first set (by id): one probe of (workout_assignment_id, set_number, id)… per row, on the row's index.
  for (const part of chunks(logged))
    take(await q(sql`SELECT s.* FROM unnest(${ints(part)}::int[]) AS w(id) CROSS JOIN LATERAL (SELECT * FROM set_logs s WHERE s.workout_assignment_id = w.id ORDER BY s.id LIMIT 1) s`));
  for (const c of anyClients) {
    const rows = rowsOfClients(scope.ix, [c]);
    if (!rows.length) continue;
    // `id + 0`, not `id`: ordered by the key itself the planner walks the primary key from the table's first set and
    // filters, the whole table for a client with no set yet (the locked app's check, every 20 s: 0.9 s at 2M sets); so
    // it reads the client's rows on their own index and sorts those (2 ms). The same row either way.
    take(await q(sql`SELECT * FROM set_logs WHERE workout_assignment_id = ANY(${ints(rows)}::int[]) ORDER BY id + 0 LIMIT 1`));
  }
  return [...out.values()].sort(byId);
}

async function fetchScope(path: SetReadPath, scope: Scope): Promise<SetRows> {
  noteSetsSeen(path);
  const now = Date.now();
  if (SETS_PG) {
    const { logs, ticks } = await setsRead(async (q) => {
      await resolveScope(scope, sqlSetSource(q), now);
      return { logs: await loadScope(q, scope), ticks: await loadTicks(q, scope) };
    });
    // Sets of rows memory no longer holds (a coach's removal whose DELETE is still to commit, an orphan) are left out.
    const known = scope.ix.dayOfRow;
    return new SetRows(MINT, path, listHolder({ logs: applyGymPins(logs.filter((s) => known.has(s.workout_assignment_id))), ticks: liveTicks(ticks) }), scope);
  }
  shadowSample(path, scope, now);
  if (MODE === "narrow") {
    const store = storeHolder.get();
    const ticks = storeHolder.ticks();
    await resolveScope(scope, listSetSource(store, ticks, scope.ix), now);
    return new SetRows(MINT, path, listHolder({ logs: cutRows(scope, store), ticks: cutTicks(scope, ticks) }), scope);
  }
  return new SetRows(MINT, path, storeHolder, scope);
}
/**
 * The shadow (SETS_SHADOW=read, memory mode): the same scope's SQL, compared with what the last save committed, cut to
 * the same scope. Behind the answer, never awaited; each side resolves its own copy of the asks.
 */
function shadowSample(path: SetReadPath, scope: Scope, now: number) {
  if (!setsShadowReads || SETS_PG) return;
  const sqlScope = copyScope(scope);
  const committedScope = copyScope(scope);
  onSetsFetch(path, {
    sqlRows: async (q) => {
      await resolveScope(sqlScope, sqlSetSource(q), now);
      return { set_logs: (await loadScope(q, sqlScope)) as unknown as Row[], cardio_logs: (await loadTicks(q, sqlScope)) as unknown as Row[] };
    },
    cut: async (committed) => {
      const list = committed.set_logs as unknown as SetLogRow[];
      const ticks = committed.cardio_logs as unknown as CardioTickRow[];
      await resolveScope(committedScope, listSetSource(list, ticks, committedScope.ix), now);
      return { set_logs: cutRows(committedScope, list) as unknown as Row[], cardio_logs: cutTicks(committedScope, ticks) as unknown as Row[] };
    },
  });
}
function copyScope(scope: Scope): Scope {
  const clients = new Map<number, ClientScope>();
  for (const [c, s] of scope.clients) clients.set(c, { ...s });
  return { ...scope, clients, rows: new Set(scope.rows), loggedRows: new Set(scope.loggedRows), tickDays: new Set(scope.tickDays) };
}

/** Every client still unopened while the locked app's one-time sweep hasn't run (lib/appLock.ts reads whether they logged). */
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
/** The window the coach-wide readers' feed starts at (HOME_NEW_DAYS back), an hour more for the clock between fetch and read. */
const feedWindow = () => Date.now() - HOME_NEW_DAYS * 86_400_000 - 3_600_000;

/**
 * The week getClientHomeActions reads the sets of (its missed sessions: the live programme's last week), handed over by
 * queries.ts at load (homeSetWeek), so the fetch and the reader take the same days by construction.
 */
let homeWeekOf: ((clientId: number) => number | null) | null = null;
export function setHomeSetWeek(fn: (clientId: number) => number | null) {
  homeWeekOf = fn;
}
function homeDays(clientId: number, ix: RowIndex): number[] {
  const week = homeWeekOf?.(clientId);
  if (week == null) return [];
  return (ix.daysOfClient.get(clientId) ?? []).filter((d) => d.week_number === week).map((d) => d.id);
}

/** What a coach-wide page reads of each of these clients, by the page (sets/paths.ts SETS_SHAPE). */
function coachSpans(clientId: number, path: SetReadPath, ix: RowIndex): SetSpan[] {
  const shape = SETS_SHAPE[path] ?? "all";
  if (shape === "all") return ["all"];
  if (shape === "accounts") return [{ coachTop: 1 }];
  const spans: SetSpan[] = [{ days: homeDays(clientId, ix) }, { feedFrom: feedWindow() }];
  if (shape === "phases") spans.push("loggedRows");
  if (shape === "feed") spans.push({ coachTop: FEED_KIND_ROWS });
  return spans;
}

/** One client's whole history, and these extra asks of theirs (an action, a route, a job about one client). */
export function fetchClientSets(path: SetReadPath, clientId: number, spans: readonly SetSpan[] = ["all"]): Promise<SetRows> {
  return fetchScope(path, scopeOf([clientId], spans));
}

/** The client's own app: their whole history, and whether each client still unopened logged anything (appLockFor's sweep). */
export function fetchClientPageSets(path: SetReadPath, clientId: number): Promise<SetRows> {
  const swept = unsweptClients().filter((id) => id !== clientId);
  return fetchScope(path, makeScope([[clientId, ["all"]], ...swept.map((id) => [id, ["loggedAny"]] as const)]));
}

/**
 * A client's tab in the admin: one view for the rail, the dots and Home (the coach's clients, and the client's own coach's
 * should the owner open another coach's client: the rail's slice) and every tab's reading of the client (their whole
 * history), and whether each client still unopened logged anything (the locked app's sweep).
 */
export function fetchClientTabSets(path: SetReadPath, coachId: number, clientId: number): Promise<SetRows> {
  const own = getData().clients.find((c) => c.id === clientId)?.coach_id ?? 0;
  const coaches = own !== coachId ? [coachId, own] : [coachId];
  const ix = rowIndex(SETS_PG || MODE === "narrow");
  const swept = unsweptClients().filter((id) => id !== clientId);
  return fetchScope(
    path,
    makeScope([
      ...coachClients(coaches)
        .filter((id) => id !== clientId)
        .map((id) => [id, coachSpans(id, path, ix)] as const),
      [clientId, ["all"]] as const,
      ...swept.map((id) => [id, ["loggedAny"]] as const),
    ], { ix })
  );
}

/**
 * What a coach-wide page reads of every client of these coaches (sets/paths.ts SETS_SHAPE), the client in focus whole,
 * and whether each client still unopened logged anything.
 */
export function fetchCoachSets(path: SetReadPath, coachIds: readonly number[], focus?: number | null): Promise<SetRows> {
  const ix = rowIndex(SETS_PG || MODE === "narrow");
  const ids = coachClients(coachIds).filter((id) => id !== focus);
  const swept = unsweptClients().filter((id) => id !== focus);
  return fetchScope(
    path,
    makeScope([...ids.map((id) => [id, coachSpans(id, path, ix)] as const), ...(focus != null ? [[focus, ["all"]] as const] : []), ...swept.map((id) => [id, ["loggedAny"]] as const)], { ix })
  );
}

/** The coach's view of one client's coach (an action about one client): the rail's slice of the coach, the client whole. */
export function fetchCoachSetsOfClient(path: SetReadPath, clientId: number): Promise<SetRows> {
  return fetchCoachSets(path, [getData().clients.find((c) => c.id === clientId)?.coach_id ?? 0], clientId);
}

/** Every client of every coach (the owner's Coaches list: each coach's newest session; or the old admin: everything). */
export function fetchEverySet(path: SetReadPath): Promise<SetRows> {
  const ix = rowIndex(SETS_PG || MODE === "narrow");
  const ids = getData().clients.map((c) => c.id);
  return fetchScope(path, makeScope(ids.map((id) => [id, coachSpans(id, path, ix)] as const), { ix }));
}

/** These sessions' sets whole (the Live Activity, a rogue session's end, the stale sessions' job). */
export function fetchDaySets(path: SetReadPath, dayIds: readonly number[]): Promise<SetRows> {
  return fetchScope(path, makeScope([[0, [{ days: dayIds }]]]));
}

/** Every session begun and not ended, of any client (the minute job's endStaleSessions, the workout reminders). */
export function fetchLiveSessionSets(path: SetReadPath): Promise<SetRows> {
  const days = getData()
    .program_days.filter((d) => !!d.session_started_at && !d.session_ended_at)
    .map((d) => d.id);
  return fetchDaySets(path, days);
}

/**
 * A coach's change to a client's plan that decides by their sets (a week with logged sets never goes, a copy skips a
 * session already logged, a removed session's history kept): `fn` handed the client's whole history and run at once.
 * Memory mode: the fetch, then `fn`, as the actions did. SETS_STORE=pg: on the client's chain, the sets read under the
 * client's lock, then `fn` in the same place (synchronously; it must not await a write of this client's sets), so no set
 * commits between what it read and what it changes, and a set write queued after it finds the plan as `fn` left it.
 */
export async function withClientSetsLocked<T>(path: SetReadPath, clientId: number, fn: (sr: SetRows) => T): Promise<T> {
  if (!SETS_PG) return fn(await fetchClientSets(path, clientId));
  noteSetsSeen(path);
  let inner: { error: unknown } | null = null;
  try {
    return await setsWriteRaw(
      `st:${clientId}`,
      {
        op: path,
        run: async (_q, inTx) => {
          inner = null;
          const ix = rowIndex(true);
          const rows = rowsOfClients(ix, [clientId]);
          const scope = makeScope([[clientId, ["all"]]], { ix });
          const { logs, ticks } = await inTx(async (q) => {
            await q(lockOf(clientId));
            const out: SetLogRow[] = [];
            for (const part of chunks(rows)) for (const r of await q(sql`SELECT * FROM set_logs WHERE workout_assignment_id = ANY(${ints(part)}::int[]) ORDER BY id`)) out.push(decode(r));
            return { logs: out.sort(byId), ticks: await loadTicks(q, scope) };
          });
          const view = new SetRows(MINT, path, listHolder({ logs: applyGymPins(logs.filter((s) => ix.dayOfRow.has(s.workout_assignment_id))), ticks: liveTicks(ticks) }), scope);
          try {
            return fn(view);
          } catch (error) {
            inner = { error };
            throw error;
          }
        },
      },
      // A read alone: a lost connection before `fn` ran is safe to read again.
      async () => undefined
    );
  } catch (error) {
    const thrown = inner as { error: unknown } | null;
    if (thrown) throw thrown.error;
    throw error;
  }
}

/** Whether these clients logged: each row's one set (`rows`), or one set of theirs (`any`). */
export function fetchSetsLogged(path: SetReadPath, clientIds: readonly number[], what: "rows" | "any"): Promise<SetRows> {
  return fetchScope(path, scopeOf(clientIds, [what === "rows" ? "loggedRows" : "loggedAny"]));
}

/** These clients' sets whole (the weight rule's pass: the marked clients, or a chunk of every client). */
export function fetchSetsForClients(path: SetReadPath, clientIds: readonly number[]): Promise<SetRows> {
  return fetchScope(path, scopeOf(clientIds, ["all"]));
}

/**
 * Every set (the nightly backup's JSON, the snapshot, the old admin's whole). With SETS_STORE=pg the table is read 2000
 * rows at a time by id in one snapshot, its statements allowed 60 s.
 */
export async function fetchAllSets(path: SetReadPath): Promise<SetRows> {
  noteSetsSeen(path);
  if (!SETS_PG) return new SetRows(MINT, path, storeHolder, null);
  const { logs, ticks } = await setsRead(async (q) => {
    await q(sql`SET LOCAL statement_timeout = '60s'`);
    await q(sql`SET LOCAL idle_in_transaction_session_timeout = '60s'`);
    return { logs: await loadPaged(q, null), ticks: await loadPagedTicks(q) };
  });
  // A home-gym pin still to commit read in, as every other fetch does (the backup and the rule's full pass read the sets
  // as memory mode would hold them); the ticks of entries a tombstone names left out (memory dropped them at once).
  return new SetRows(MINT, path, listHolder({ logs: applyGymPins(logs), ticks: liveTicks(ticks) }), null);
}

/**
 * Every cardio tick carrying one of these clients (the export: a tick has a client_id, so the export's filter keeps a
 * coach's clients' ticks, as it always has). Memory: the store's own list, whole (the export filters it). SETS_STORE=pg:
 * those clients' ticks by `cardio_logs_client_idx`, in id order, the ticks a tombstone names left out.
 */
export async function fetchTicksOfClients(path: SetReadPath, clientIds: readonly number[]): Promise<CardioTickRow[]> {
  noteSetsSeen(path);
  if (!SETS_PG) return storeHolder.ticks();
  const ids = [...new Set(clientIds)];
  const ticks = await setsRead(async (q) => {
    const out: CardioTickRow[] = [];
    for (const part of chunks(ids)) for (const r of await q(sql`SELECT * FROM cardio_logs WHERE client_id = ANY(${ints(part)}::int[]) ORDER BY id`)) out.push(decodeTick(r));
    return out.sort(byId);
  });
  return liveTicks(ticks);
}
const PAGE = 2000;
async function loadPaged(q: Q, rows: readonly number[] | null): Promise<SetLogRow[]> {
  const out: SetLogRow[] = [];
  for (let after = 0; ; ) {
    const page = await q(
      rows ? sql`SELECT * FROM set_logs WHERE id > ${after}::int AND workout_assignment_id = ANY(${ints(rows)}::int[]) ORDER BY id LIMIT ${PAGE}` : sql`SELECT * FROM set_logs WHERE id > ${after}::int ORDER BY id LIMIT ${PAGE}`
    );
    for (const r of page) out.push(decode(r));
    if (page.length < PAGE) break;
    after = Number(page[page.length - 1].id);
  }
  return out;
}

/**
 * The minute's job in memory mode (dueJobs.ts): the store's own list at once, synchronously, so the job runs before the
 * page that set it off exactly as before; its scope (dueSetScope) counts what it reads. Throws with SETS_STORE=pg, where
 * the job fetches first and runs behind the page.
 */
export function setsForDueJobNow(path: SetReadPath, scope: { all: boolean; clients: readonly number[] }): SetRows {
  if (SETS_PG) throw new Error("[sets] setsForDueJobNow with SETS_STORE=pg: fetch instead");
  noteSetsSeen(path);
  if (scope.all) return new SetRows(MINT, path, storeHolder, null);
  const s = scopeOf(scope.clients, ["all"]);
  // The read week samples the job's own fetch (the clients it names), as pg mode's fetchSetsForClients reads them.
  shadowSample(path, s, Date.now());
  return new SetRows(MINT, path, storeHolder, s);
}

/** No sets at all, for a caller that knows its reader reads none: any need of it is a miss. */
export function noSetRows(path: SetReadPath): SetRows {
  const scope = makeScope([]);
  if (SETS_PG || MODE === "narrow") return new SetRows(MINT, path, listHolder({ logs: [], ticks: [] }), scope);
  return new SetRows(MINT, path, storeHolder, scope);
}

/** The client a set belongs to (an action's ownership check before it changes the set): its row's day's, from memory. */
export async function fetchSetOwner(setId: number): Promise<{ clientId: number; rowId: number } | null> {
  if (!SETS_PG) {
    const s = storeHolder.get().find((x) => x.id === setId);
    if (!s) return null;
    const c = clientOfRow(rowIndex(), s.workout_assignment_id);
    return c == null ? null : { clientId: c, rowId: s.workout_assignment_id };
  }
  noteSetsSeen("action.training");
  const r = await setsRead(async (q) => (await q(sql`SELECT workout_assignment_id AS w FROM set_logs WHERE id = ${setId}::int`))[0]);
  if (!r) return null;
  const rowId = Number(r.w);
  const c = clientOfRow(rowIndexFor([rowId]), rowId);
  return c == null ? null : { clientId: c, rowId };
}

// ---- Writes --------------------------------------------------------------------------------------------------------

const lockOf = (clientId: number) => sql`SELECT pg_advisory_xact_lock(20255, ${clientId}::int)`;

function changedRows<R extends { id: number }>(before: readonly R[], after: readonly R[], allocated: ReadonlySet<number> = new Set(), table: "set_logs" | "cardio_logs" = "set_logs") {
  const was = new Map(before.map((r) => [r.id, JSON.stringify(recordForWrite(table, r as unknown as Row))] as const));
  const upserts: Row[] = [];
  const upserted: R[] = [];
  const seen = new Set<number>();
  for (const r of after) {
    seen.add(r.id);
    const rec = recordForWrite(table, r as unknown as Row);
    if (!rec) throw new Error(`[sets] a ${table === "set_logs" ? "set" : "cardio tick"} the writer can't encode (id ${String(r.id)})`);
    if (was.get(r.id) !== JSON.stringify(rec)) {
      upserts.push(rec);
      upserted.push(r);
    }
  }
  const deletes = before.filter((r) => !seen.has(r.id)).map((r) => r.id);
  /** The ids the write handed out, or any not in what it loaded: inserted, never written over an existing set. */
  const fresh = new Set(upserted.filter((r) => allocated.has(r.id) || !was.has(r.id)).map((r) => r.id));
  return { upserts, upserted, deletes, fresh };
}

/** The table's columns as this build's schema has them (as the store's writer writes them; checkins/rows.ts's reasons). */
let COLUMNS: { field: string; name: string }[] | null = null;
const schemaColumns = () => (COLUMNS ??= Object.entries(getTableColumns(set_logs) as Record<string, Column>).map(([field, c]) => ({ field, name: c.name })));
const quoted = (n: string) => `"${n.replace(/"/g, '""')}"`;

/**
 * The sets written as the store's writer writes them, with their client (the derived column, its row's day's client as
 * memory holds it). Each rewrites a set only for its own client: an id another client's set holds fails the write whole.
 * A set the write hands out (`fresh`: an id not in what it loaded) is only ever inserted: an id already in the table (a
 * counter behind, a second instance) fails the write whole rather than writing over another set.
 */
async function writeRows(q: Q, clientId: number, upserts: Row[], deletes: number[], fresh: ReadonlySet<number>) {
  if (deletes.length) await q(sql`DELETE FROM set_logs WHERE id = ANY(${ints(deletes)}::int[]) AND (client_id = ${clientId}::int OR client_id IS NULL)`);
  if (!upserts.length) return;
  const cols = schemaColumns();
  const list = sql.raw(cols.map((c) => quoted(c.name)).join(", "));
  const set = sql.raw(cols.filter((c) => c.name !== "id").map((c) => `${quoted(c.name)} = EXCLUDED.${quoted(c.name)}`).join(", "));
  const encode = (slice: Row[]) =>
    JSON.stringify(
      slice.map((r) => {
        const out: Row = {};
        for (const c of cols) if (c.field in r) out[c.name] = r[c.field];
        out.client_id = clientId;
        return out;
      })
    );
  const added = upserts.filter((r) => fresh.has(Number(r.id)));
  const changed = upserts.filter((r) => !fresh.has(Number(r.id)));
  for (let i = 0; i < added.length; i += 500) {
    const slice = added.slice(i, i + 500);
    const done = await q(sql`INSERT INTO set_logs (${list}) SELECT ${list} FROM jsonb_populate_recordset(NULL::set_logs, ${encode(slice)}::jsonb) ON CONFLICT (id) DO NOTHING RETURNING id`);
    if (done.length !== slice.length) throw new Error(`set_logs: ${slice.length - done.length} new set(s) whose id the table already holds; nothing written`);
  }
  for (let i = 0; i < changed.length; i += 500) {
    const slice = changed.slice(i, i + 500);
    const done = await q(
      sql`INSERT INTO set_logs (${list}) SELECT ${list} FROM jsonb_populate_recordset(NULL::set_logs, ${encode(slice)}::jsonb) ON CONFLICT (id) DO UPDATE SET ${set} WHERE set_logs.client_id = ${clientId}::int OR set_logs.client_id IS NULL RETURNING id`
    );
    if (done.length !== slice.length) throw new Error(`set_logs: ${slice.length - done.length} set(s) whose id another client's set holds; nothing written`);
  }
}

/** The cardio tick columns as this build's schema has them. */
let TICK_COLUMNS: { field: string; name: string }[] | null = null;
const tickColumns = () => (TICK_COLUMNS ??= Object.entries(getTableColumns(cardio_logs) as Record<string, Column>).map(([field, c]) => ({ field, name: c.name })));

/**
 * The cardio ticks written as the store's writer writes them, each only for its own client (the tick's client_id, which
 * the write checks is this client's): a tick another client's row holds fails the write whole. A tick the write hands
 * out is only ever inserted, as a set's.
 */
async function writeTickRows(q: Q, clientId: number, upserts: Row[], deletes: number[], fresh: ReadonlySet<number>) {
  if (deletes.length) await q(sql`DELETE FROM cardio_logs WHERE id = ANY(${ints(deletes)}::int[]) AND (client_id = ${clientId}::int OR client_id IS NULL)`);
  if (!upserts.length) return;
  const cols = tickColumns();
  const list = sql.raw(cols.map((c) => quoted(c.name)).join(", "));
  const set = sql.raw(cols.filter((c) => c.name !== "id").map((c) => `${quoted(c.name)} = EXCLUDED.${quoted(c.name)}`).join(", "));
  const encode = (slice: Row[]) =>
    JSON.stringify(
      slice.map((r) => {
        const out: Row = {};
        for (const c of cols) if (c.field in r) out[c.name] = r[c.field];
        return out;
      })
    );
  const added = upserts.filter((r) => fresh.has(Number(r.id)));
  const changed = upserts.filter((r) => !fresh.has(Number(r.id)));
  for (let i = 0; i < added.length; i += 500) {
    const slice = added.slice(i, i + 500);
    const done = await q(sql`INSERT INTO cardio_logs (${list}) SELECT ${list} FROM jsonb_populate_recordset(NULL::cardio_logs, ${encode(slice)}::jsonb) ON CONFLICT (id) DO NOTHING RETURNING id`);
    if (done.length !== slice.length) throw new Error(`cardio_logs: ${slice.length - done.length} new tick(s) whose id the table already holds; nothing written`);
  }
  for (let i = 0; i < changed.length; i += 500) {
    const slice = changed.slice(i, i + 500);
    const done = await q(
      sql`INSERT INTO cardio_logs (${list}) SELECT ${list} FROM jsonb_populate_recordset(NULL::cardio_logs, ${encode(slice)}::jsonb) ON CONFLICT (id) DO UPDATE SET ${set} WHERE cardio_logs.client_id = ${clientId}::int OR cardio_logs.client_id IS NULL RETURNING id`
    );
    if (done.length !== slice.length) throw new Error(`cardio_logs: ${slice.length - done.length} tick(s) whose id another client's tick holds; nothing written`);
  }
}

/** What the last store save committed holds this row (a plan row, a client, a day): pg/store.ts PgStoreWriter.committedHas. */
function committedHas(name: string, id: number): boolean {
  const w = (globalThis as unknown as { _pgWriter?: { committedHas?(name: string, id: number | string): boolean } })._pgWriter;
  return !w?.committedHas || w.committedHas(name, id);
}
class NotYetSaved extends Error {
  constructor(what: string) {
    super(`[sets] ${what} is not saved yet`);
    this.name = "NotYetSaved";
  }
}

export type SetHooks<T> = {
  /** After the commit, still on the client's chain (pg), or right after the body (memory): memory's own changes that
   *  follow the sets (the weight rule, a session's fields), handed the sets the write left in its reach. */
  afterCommit?: (answer: T, sets: SetRows) => void;
  /** The sessions (days) whose cardio ticks the body reads and changes (`box.ticks`), evaluated with the reach; none by
   *  default. Only this client's days count, and only the entries memory holds on them. */
  ticks?: () => readonly number[];
};

/**
 * One write of a client's sets. Memory: `body` runs on the store (today's code exactly, saving as it always did), then
 * `afterCommit`, its answer back. Postgres: one transaction under the client's lock (after the client's writes before
 * it): the client still here, the reach evaluated now (rows still in memory and on this client's days), loaded, `body`
 * run on copies of it, the sets it changed written (each only for a row, a day and a client the store's last save holds:
 * else the store is saved first and the write runs once more), committed, then `afterCommit` on the chain.
 */
export async function writeSets<T>(path: SetWritePath, clientId: number, reach: () => readonly number[], body: (box: SetBox) => T, hooks: SetHooks<T> = {}): Promise<T> {
  noteSetsWrite(path);
  if (!SETS_PG) {
    const box = storeBox(path);
    const answer = body(box);
    hooks.afterCommit?.(answer, box);
    return answer;
  }
  let inner: { error: unknown } | null = null;
  try {
    return await setsWriteRaw(`st:${clientId}`, {
      op: path,
      run: async (_q, inTx) => {
        // A row, day or client the store's last save doesn't hold yet: the store saved, then the write once more, in
        // this same place on the client's chain (a write queued after it never commits before it). The ids the first try
        // took (rolled back, never inserted) go to the second, so the sets get the ids memory mode gives them.
        const spare: number[] = [];
        const spareTicks: number[] = [];
        let tried: SetBox | null = null;
        for (let saved = false; ; saved = true) {
          let left: SetLogRow[] = [];
          let leftTicks: CardioTickRow[] = [];
          let scope: Scope | null = null;
          let answer: T;
          try {
            answer = await inTx(async (q) => {
            inner = null;
            await q(lockOf(clientId));
            if (!getData().clients.some((c) => c.id === clientId)) {
              const error = new Error(`[sets] client ${clientId} is gone; nothing written`);
              inner = { error };
              throw error;
            }
            const asked = [...new Set(reach())];
            const ix = rowIndexFor(asked);
            // Only this client's rows still in memory: a row a coach took out meanwhile is left out of the write.
            const rows = asked.filter((r) => clientOfRow(ix, r) === clientId);
            const before = rows.length ? (await q(sql`SELECT * FROM set_logs WHERE workout_assignment_id = ANY(${ints(rows)}::int[]) ORDER BY id`)).map(decode) : [];
            // The cardio ticks the write names: the entries memory holds on this client's days of them.
            const tickDaysAsked = [...new Set(hooks.ticks?.() ?? [])].filter((d) => ix.clientOfDay.get(d) === clientId);
            const entries = entriesOfDays(tickDaysAsked);
            const entryDay = entries.length ? entryDayMap() : new Map<number, number>();
            const ticksBefore = entries.length ? (await q(sql`SELECT * FROM cardio_logs WHERE cardio_entry_id = ANY(${ints(entries)}::int[]) ORDER BY id`)).map(decodeTick) : [];
            // A home-gym pin still to commit is read into the copies (so the write carries it, as the UPDATE would).
            const lists = { logs: applyGymPins(before.map((s) => structuredClone(s))), ticks: ticksBefore.map((t) => structuredClone(t)) };
            scope = { every: false, clients: new Map(), rows: new Set(rows), loggedRows: new Set(), tickDays: new Set(tickDaysAsked), ix };
            const box = new SetBox(MINT, path, listHolder(lists), scope, () => {}, spare, spareTicks);
            tried = box;
            let out: T;
            try {
              out = body(box);
            } catch (error) {
              inner = { error };
              throw error;
            }
            // An id handed out here that a set already holds (a counter behind, a second instance): nothing written.
            for (const id of box.allocated) if (before.some((s) => s.id === id)) throw new Error(`set_logs: a new set's id ${id} is already a set's; nothing written`);
            const c = changedRows(before, lists.logs, box.allocated);
            if (c.upserts.length) {
              if (!committedHas("clients", clientId)) throw new NotYetSaved(`client ${clientId}`);
              for (const s of c.upserted) {
                if (!rows.includes(s.workout_assignment_id)) {
                  const error = new SetViewMiss(`[sets] a set of row ${s.workout_assignment_id} outside ${path}'s reach`);
                  inner = { error };
                  throw error;
                }
                if (!committedHas("workout_assignments", s.workout_assignment_id)) throw new NotYetSaved(`row ${s.workout_assignment_id}`);
                const day = ix.dayOfRow.get(s.workout_assignment_id);
                if (day != null && !committedHas("program_days", day)) throw new NotYetSaved(`day ${day}`);
              }
            }
            // The ticks the same: an id handed out here that a tick already holds, nothing written; each changed tick only
            // for an entry of the write's own, on a day, of a client, the store's last save holds.
            for (const id of box.allocatedTicks) if (ticksBefore.some((t) => t.id === id)) throw new Error(`cardio_logs: a new tick's id ${id} is already a tick's; nothing written`);
            const ct = changedRows(ticksBefore, lists.ticks, box.allocatedTicks, "cardio_logs");
            if (ct.upserts.length) {
              if (!committedHas("clients", clientId)) throw new NotYetSaved(`client ${clientId}`);
              const own = new Set(entries);
              for (const t of ct.upserted) {
                if (!own.has(t.cardio_entry_id) || t.client_id !== clientId) {
                  const error = new SetViewMiss(`[sets] a cardio tick of entry ${t.cardio_entry_id} outside ${path}'s reach`);
                  inner = { error };
                  throw error;
                }
                if (!committedHas("cardio_entries", t.cardio_entry_id)) throw new NotYetSaved(`cardio entry ${t.cardio_entry_id}`);
                const day = entryDay.get(t.cardio_entry_id);
                if (day != null && !committedHas("program_days", day)) throw new NotYetSaved(`day ${day}`);
              }
            }
            await writeRows(q, clientId, c.upserts, c.deletes, c.fresh);
            await writeTickRows(q, clientId, ct.upserts, ct.deletes, ct.fresh);
            throwIfFaultBeforeCommit(path);
            left = lists.logs;
            leftTicks = lists.ticks;
            return out;
          });
          } catch (error) {
            if (!inner && !saved && isNotYetSaved(error)) {
              try {
                await persistNow();
              } catch {
                // The store's own save failing: a transport failure for the phone (isSetsDoorFailure), tried again later.
                throw new NotYetSaved("the store (its save failed)");
              }
              if (tried) {
                spare.splice(0, spare.length, ...(tried as SetBox).allocated);
                spareTicks.splice(0, spareTicks.length, ...(tried as SetBox).allocatedTicks);
              }
              continue;
            }
            throw error;
          }
          hooks.afterCommit?.(answer, viewOf(path, left, leftTicks, scope));
          return answer;
        }
      },
    });
  } catch (error) {
    const thrown = inner as { error: unknown } | null;
    if (thrown) throw thrown.error;
    throw error;
  }
}
const isNotYetSaved = (error: unknown) => error instanceof NotYetSaved || (error instanceof Error && /is not saved yet/.test(error.message));

/**
 * Plan rows a coach removed, with every set logged on them (removeAssignment, clearProgramDay, removeSession, removeWeek,
 * removeProgramWeek, applyDayChanges' dropped rows), synchronous where the caller removes the rows. Memory: the store's
 * list filtered at once, today's line. Postgres, ordered so a crash loses nothing but the moment's work: a tombstone
 * naming the rows goes into memory beside the rows' removal (the caller saves both, keepSessions having read the sets
 * from the caller's fetched view first); then on the client's chain the store's save is waited for, the sets deleted
 * under the lock, the tombstone cleared (finishRemovalLater). Meanwhile no fetch can read them (every fetch keeps only
 * rows memory holds), and a set write for one of the rows is refused (writeSets' reach) or deleted by the DELETE queued
 * behind it. Row ids are never handed out again, so the DELETE can never take a later row's sets.
 */
export function dropSetsOfRows(path: SetWritePath, clientId: number, rows: Iterable<number>): void {
  noteSetsWrite(path);
  const ids = new Set(rows);
  if (!SETS_PG) {
    // Today's line, on the store's own list (`data.set_logs = data.set_logs.filter(…)`), at the same place in its caller.
    storeHolder.set(storeHolder.get().filter((sl) => !ids.has(sl.workout_assignment_id)));
    return;
  }
  if (!ids.size) return;
  // The tombstone in memory with the rows' removal: the caller's own save (and every save after it) carries both.
  const key = `${clientId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  setTombstone(key, { client: clientId, rows: [...ids], at: new Date().toISOString() });
  finishRemovalLater(key, clientId, [...ids], [], path, 0, 0);
}

/**
 * Cardio entries a coach removed (or replaced: a copy over a session), with every tick on them (removeSession,
 * removeWeek, copyProgramDay), synchronous where the caller removes the entries, as dropSetsOfRows. Memory: the store's
 * list filtered at once, today's line (`data.cardio_logs = (data.cardio_logs ?? []).filter(…)`). Postgres: a tombstone
 * naming the entries in memory beside their removal, every fetch leaving their ticks out at once (liveTicks), then the
 * DELETE on the client's chain after the store's save, the tombstone cleared. With SETS_STORE=pg cardio entry ids come from
 * their sequence (pg/ids.ts), never handed out again, so the DELETE can never take a later entry's tick.
 */
export function dropTicksOfEntries(path: SetWritePath, clientId: number, entries: Iterable<number>): void {
  noteSetsWrite(path);
  const ids = new Set(entries);
  if (!SETS_PG) {
    storeHolder.setTicks(storeHolder.ticks().filter((l) => !ids.has(l.cardio_entry_id)));
    return;
  }
  if (!ids.size) return;
  const key = `${clientId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  setTombstone(key, { client: clientId, rows: [], entries: [...ids], at: new Date().toISOString() });
  finishRemovalLater(key, clientId, [], [...ids], path, 0, 0);
}

/**
 * A removal's DELETE, on the client's chain: the store's save first (the rows gone with the tombstone), then the sets
 * (and the cardio ticks of the entries it names) deleted under the lock, then the tombstone cleared. A failed save or
 * DELETE is tried again a minute later, up to 30 times; any boot finishes a tombstone left (sets/boot.ts).
 */
function finishRemovalLater(key: string, clientId: number, rows: number[], entries: number[], path: SetWritePath, tries = 0, wait = 60_000) {
  if (tries >= 30) return;
  const timer = setTimeout(async () => {
    const again = () => finishRemovalLater(key, clientId, rows, entries, path, tries + 1);
    if (!(key in tombstones())) return;
    // The store's save (the rows gone, with the tombstone) before the DELETE is queued: off the client's chain, so their
    // set saves never wait for a whole-store save behind a coach's removal.
    try {
      await persistNow();
    } catch {
      again();
      return;
    }
    void setsWriteRaw(`st:${clientId}`, {
      op: path,
      run: async (_q, inTx) => {
        if (!(key in tombstones())) return;
        await inTx(async (q) => {
          await q(lockOf(clientId));
          if (rows.length) await q(sql`DELETE FROM set_logs WHERE workout_assignment_id = ANY(${ints(rows)}::int[])`);
          if (entries.length) await q(sql`DELETE FROM cardio_logs WHERE cardio_entry_id = ANY(${ints(entries)}::int[])`);
        });
        clearTombstone(key);
        persist();
      },
    }).catch(again);
  }, wait);
  (timer as { unref?: () => void }).unref?.();
}

/**
 * The home gym moved (queries.ts setHomeGym): every set of these rows with no gym on it was at the old home, and now
 * says so. Memory: today's line on the store. Postgres: a pin kept in memory with the rest of the change (`sets_gym_pins`,
 * saved with it; the sets it covers are those with an id up to the highest handed out now, so a set logged at the new
 * home after it is never moved), read into the sets by every fetch until its UPDATE commits on the client's chain after
 * the store's save; any boot finishes a pin left (sets/boot.ts).
 */
export function pinSetGyms(path: SetWritePath, clientId: number, rows: Iterable<number>, gymId: number): void {
  noteSetsWrite(path);
  const ids = new Set(rows);
  if (!SETS_PG) {
    for (const sl of storeHolder.get()) if (ids.has(sl.workout_assignment_id) && sl.gym_id == null) sl.gym_id = gymId;
    return;
  }
  if (!ids.size) return;
  const upTo = Number(getData()._seq?.set_logs ?? 0);
  const key = `${clientId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const d = getData() as unknown as Record<string, unknown>;
  // chat-door: notes-door: food-door: checkins-door: one kv key by its own name (the pins), never a walk of the store.
  d[SETS_GYM_PINS] = { ...gymPins(), [key]: { client: clientId, rows: [...ids], gym: gymId, upTo, at: new Date().toISOString() } };
  const finish = (tries: number) => {
    const timer = setTimeout(async () => {
      if (!(key in gymPins())) return;
      // The store's save (the pin with the change) first, off the client's chain, as a removal's.
      try {
        await persistNow();
      } catch {
        if (tries < 30) finish(tries + 1);
        return;
      }
      void setsWriteRaw(`st:${clientId}`, {
        op: path,
        run: async (_q, inTx) => {
          if (!(key in gymPins())) return;
          await inTx(async (q) => {
            await q(lockOf(clientId));
            await q(sql`UPDATE set_logs SET extra = jsonb_set(COALESCE(extra, '{}'::jsonb), '{gym_id}', to_jsonb(${gymId}::int)) WHERE workout_assignment_id = ANY(${ints([...ids])}::int[]) AND id <= ${upTo}::int AND (extra->'gym_id' IS NULL OR jsonb_typeof(extra->'gym_id') = 'null')`);
          });
          const next = { ...gymPins() };
          delete next[key];
          if (Object.keys(next).length) d[SETS_GYM_PINS] = next;
          else delete d[SETS_GYM_PINS];
          persist();
        },
      }).catch(() => (tries < 30 ? finish(tries + 1) : undefined));
    }, tries === 0 ? 0 : 60_000);
    (timer as { unref?: () => void }).unref?.();
  };
  finish(0);
}
export const SETS_GYM_PINS = "sets_gym_pins";
export type SetGymPins = Record<string, { client: number; rows: number[]; gym: number; upTo: number; at: string }>;
function gymPins(): SetGymPins {
  // chat-door: notes-door: food-door: checkins-door: one kv key by its own name (the pins), never a walk of the store.
  const t = (getData() as unknown as Record<string, unknown>)[SETS_GYM_PINS];
  return t && typeof t === "object" && !Array.isArray(t) ? (t as SetGymPins) : {};
}
/** The pins still to commit, read into fetched sets (pg mode): the sets read as memory mode's would. */
function applyGymPins(list: SetLogRow[]): SetLogRow[] {
  const pins = Object.values(gymPins());
  if (!pins.length) return list;
  for (const p of pins) {
    const rows = new Set(p.rows);
    for (const s of list) if (rows.has(s.workout_assignment_id) && s.gym_id == null && s.id <= p.upTo) s.gym_id = p.gym;
  }
  return list;
}

export type SetTombstones = Record<string, { client: number; rows: number[]; entries?: number[]; at: string }>;
/** The tombstones in memory (a store key kept in kv), read only: none is {}. */
function tombstones(): SetTombstones {
  // chat-door: notes-door: food-door: checkins-door: one kv key by its own name (the tombstones), never a walk of the store.
  const t = (getData() as unknown as Record<string, unknown>)[SETS_REMOVING];
  return t && typeof t === "object" && !Array.isArray(t) ? (t as SetTombstones) : {};
}
/** The cardio entries a tombstone names (their ticks still to delete, out of every fetch meanwhile). */
function deadEntries(): Set<number> {
  const out = new Set<number>();
  for (const t of Object.values(tombstones())) for (const e of t?.entries ?? []) out.add(e);
  return out;
}
function setTombstone(key: string, v: { client: number; rows: number[]; entries?: number[]; at: string }) {
  // chat-door: notes-door: food-door: checkins-door: the same key, written by name.
  (getData() as unknown as Record<string, unknown>)[SETS_REMOVING] = { ...tombstones(), [key]: v };
}
function clearTombstone(key: string) {
  const next = { ...tombstones() };
  delete next[key];
  // chat-door: notes-door: food-door: checkins-door: the same key, by name.
  const d = getData() as unknown as Record<string, unknown>;
  if (Object.keys(next).length) d[SETS_REMOVING] = next;
  else delete d[SETS_REMOVING];
}

/**
 * Every set of a client, deleted (the erase, before memory's own): one transaction, by the derived client column and by
 * the client's rows memory holds (a set an older build wrote with no client). Memory mode: nothing (removeClient's own
 * filter, through the box).
 */
export async function deleteClientSets(clientId: number, path: SetWritePath = "w.client.delete"): Promise<void> {
  noteSetsWrite(path);
  if (!SETS_PG) return;
  const ix = rowIndex(true);
  const rows = rowsOfClients(ix, [clientId]);
  const tomb = Object.entries(tombstones()).filter(([, t]) => t?.client === clientId);
  const all = [...new Set([...rows, ...tomb.flatMap(([, t]) => t.rows ?? [])])];
  // Their cardio ticks the same (they carry client_id; memory's erase takes them by it): by the client, and by the
  // entries on their days memory holds and those a tombstone of theirs names.
  const entries = [...new Set([...entriesOfDays((ix.daysOfClient.get(clientId) ?? []).map((d) => d.id)), ...tomb.flatMap(([, t]) => t.entries ?? [])])];
  await setsWriteRaw(`st:${clientId}`, {
    op: path,
    run: async (_q, inTx) =>
      inTx(async (q) => {
        await q(sql`SET LOCAL statement_timeout = '60s'`);
        await q(lockOf(clientId));
        await q(sql`DELETE FROM set_logs WHERE client_id = ${clientId}::int`);
        for (const part of chunks(all)) await q(sql`DELETE FROM set_logs WHERE workout_assignment_id = ANY(${ints(part)}::int[])`);
        await q(sql`DELETE FROM cardio_logs WHERE client_id = ${clientId}::int`);
        for (const part of chunks(entries)) await q(sql`DELETE FROM cardio_logs WHERE cardio_entry_id = ANY(${ints(part)}::int[])`);
      }),
  });
  for (const [k] of tomb) clearTombstone(k);
}

/** The erase's second sweep, once the client is gone from memory: anything a write queued before it committed after it. */
export async function sweepClientSets(clientId: number, rows: readonly number[], entries: readonly number[] = []): Promise<void> {
  if (!SETS_PG) return;
  noteSetsWrite("w.client.delete");
  await setsWriteRaw(`st:${clientId}`, {
    op: "w.client.delete",
    run: async (_q, inTx) =>
      inTx(async (q) => {
        await q(lockOf(clientId));
        await q(sql`DELETE FROM set_logs WHERE client_id = ${clientId}::int`);
        for (const part of chunks([...rows])) await q(sql`DELETE FROM set_logs WHERE workout_assignment_id = ANY(${ints(part)}::int[])`);
        await q(sql`DELETE FROM cardio_logs WHERE client_id = ${clientId}::int`);
        for (const part of chunks([...entries])) await q(sql`DELETE FROM cardio_logs WHERE cardio_entry_id = ANY(${ints(part)}::int[])`);
      }),
  });
}

/**
 * Every set, gone (the workspace reset), twice with the chains settled between. Memory: the store's list emptied. The
 * cardio ticks stay, as memory's reset has always left them (and the cardio entries) behind; with SETS_STORE=pg only the
 * ticks a tombstone names go with the tombstones, as memory dropped them already.
 */
export async function wipeAllSets(): Promise<void> {
  noteSetsWrite("w.wipe");
  if (!SETS_PG) {
    storeHolder.set([]);
    return;
  }
  for (let i = 0; i < 2; i++) {
    await setChainsSettled();
    const dead = ints(deadEntries());
    await setsWriteRaw(null, {
      op: "w.wipe",
      run: async (_q, inTx) =>
        inTx(async (q) => {
          await q(sql`DELETE FROM set_logs`);
          await q(sql`DELETE FROM cardio_logs WHERE cardio_entry_id = ANY(${dead}::int[])`);
        }),
    });
  }
  // chat-door: notes-door: food-door: checkins-door: one kv key by its own name (the tombstones), never a walk.
  const d = getData() as unknown as Record<string, unknown>;
  delete d[SETS_REMOVING];
  // chat-door: notes-door: food-door: checkins-door: the pins' key by its own name, gone with the sets.
  delete d[SETS_GYM_PINS];
}

// ---- Whole-store copies --------------------------------------------------------------------------------------------

/**
 * A whole-store copy with the sets in their place (the backup's JSON, the shutdown dump). In memory mode the store holds
 * them already: the same object back. With SETS_STORE=pg they are put where the store would hold them (after
 * workout_assignments), the sets of rows a tombstone names left out, and `_sets_in_postgres` says so when there are none,
 * so a build that doesn't know refuses it. The tombstones stay with this database. The cardio ticks the same, after
 * cardio_entries (the ticks of entries a tombstone names left out).
 */
export function withSetKeys<T extends Record<string, unknown>>(data: T, rows: SetRows | null): T {
  if (!SETS_PG) return data;
  const dead = new Set(Object.values(tombstones()).flatMap((t) => t?.rows ?? []));
  const list = rows ? (dead.size ? rows.logs.filter((s) => !dead.has(s.workout_assignment_id)) : [...rows.logs]) : null;
  const ticks = rows ? liveTicks([...rows.ticks]) : null;
  const out: Record<string, unknown> = {};
  let placed = false;
  let placedTicks = false;
  // chat-door: notes-door: food-door: checkins-door: a copy of the keys as they are handed in (the other doors' keys already in place).
  for (const [k, v] of Object.entries(data)) {
    if (k === "set_logs" || k === "cardio_logs" || k === SETS_REMOVING) continue;
    out[k] = v;
    if (k === "cardio_entries") {
      out.cardio_logs = ticks ?? [];
      placedTicks = true;
    }
    if (k === "workout_assignments") {
      out.set_logs = list ?? [];
      placed = true;
    }
  }
  if (!placedTicks) out.cardio_logs = ticks ?? [];
  if (!placed) out.set_logs = list ?? [];
  if (!list) out._sets_in_postgres = true;
  return out as T;
}

/**
 * The export's copy (SETS_STORE=pg): the coach's clients' cardio ticks put in their key's place, after cardio_entries,
 * as the store holds them in memory mode (the export's filter by client_id then keeps them, as it always has; the sets
 * carry no client_id, so it leaves every one out in both modes). Memory mode: the same object back.
 */
export function withTickKey<T extends Record<string, unknown>>(data: T, ticks: readonly CardioTickRow[]): T {
  if (!SETS_PG) return data;
  const out: Record<string, unknown> = {};
  let placed = false;
  // chat-door: notes-door: food-door: checkins-door: a copy of the keys as they are handed in (the other doors' keys already in place).
  for (const [k, v] of Object.entries(data)) {
    if (k === "cardio_logs") continue;
    out[k] = v;
    if (k === "cardio_entries") {
      out.cardio_logs = [...ticks];
      placed = true;
    }
  }
  if (!placed) out.cardio_logs = [...ticks];
  return out as T;
}

/** For /api/timing. */
export function setsStoreReport() {
  return { pg: SETS_PG, views: MODE, strict: STRICT, tombstones: SETS_PG ? Object.keys(tombstones()).length : 0 };
}

/**
 * A failure of the door's own transport (the database down or restarting, a pool full, a lost connection, a lock wait or
 * a conflict that clears, the store's save not through): saveWorkoutAction rethrows these in pg mode, so the phone keeps
 * the batch and tries again, never a rust "Not saved" on a set that was fine. Anything else the database refuses (a rule,
 * a statement too slow, an id another set holds) is the entry's own answer, so it never holds up the batch behind it.
 */
export function isSetsDoorFailure(error: unknown): boolean {
  if (!SETS_PG || !(error instanceof Error)) return false;
  if (error.name === "NotYetSaved" || /is not saved yet/.test(error.message)) return true;
  if (lostConnection(error) || poolWait(error)) return true;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && (code.startsWith("08") || code.startsWith("57P") || code === "55P03" || code === "40001" || code === "40P01" || code === "53300")) return true;
  return /SETS_STORE=pg but the logged sets' connection isn't started|timeout exceeded when trying to connect|Connection terminated|ECONNREFUSED|ECONNRESET/i.test(error.message);
}

export type { Q, Row };
