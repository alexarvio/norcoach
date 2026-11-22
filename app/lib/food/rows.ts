// The one door to the food diary (food_entries, calorie_logs, food_days, food_meals, saved_meals, saved_days,
// meal_photos; 19 Nov, Step 6 quest 8 part 1 of docs/database-plan.md). Every read and write of them goes through here;
// nothing else in app/ touches the store's lists (Data's seven keys are a sealed type in db.ts, so tsc refuses any
// other reach for them, and scripts/check-food-door.mjs, run by the build, refuses the names). Built on chat's and the
// notes' recipe, their own files untouched.
//
// The code that reads and writes the rows stays where it was (queries.ts, healthSync.ts, the boards): it is handed a
// FoodRows (a reader's view) or a FoodBox (a writer's), the seven lists as properties under short names (entries,
// calories, days, meals, savedMeals, savedDays, photos), and runs on them exactly as it ran on the store.
//
//   memory, FOOD_VIEWS=wide  (the default) a view and a box are the store itself: every list is the store's own array,
//                            read and replaced in place, so every line behaves exactly as before. A reader asking a view
//                            for a client or a span its fetch didn't take is a miss, said once and counted.
//   memory, FOOD_VIEWS=narrow a view holds only the rows its fetch took (the same objects, in store order): what the
//                            cut-over's queries hand back. A miss throws. Writes always run on the store.
//   FOOD_STORE=pg            (food/mode.ts) the rows are in Postgres alone: a fetch reads its scope in one snapshot,
//                            ordered by id as the store holds them; a write is one transaction under the client's lock
//                            (writeFood): the scope loaded, the code run on it, the rows it changed written back, the
//                            pictures nothing shows any more found in SQL, and the once key claimed in the same
//                            transaction. A miss throws.
//
// A reader handed no view doesn't compile (every reader takes one); a page, route, action or job fetches first.

import { getTableColumns, sql, type Column, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { allocId, getData, persist, DATA_DIR, type CalorieLog, type FoodDay, type FoodEntry, type FoodMealSlot, type MealPhoto, type SavedDay, type SavedMeal } from "../db";
import { calorie_logs, clients as clientsTable, food_days, food_entries, food_meals, meal_photos, once_keys, saved_days, saved_meals } from "../pg/schema";
import { fromRecord, recordForWrite } from "../pg/store";
import { FOOD_PG, FOOD_TABLES, type FoodTable } from "./mode";
import { FOOD_SHAPE, type FoodReadPath, type FoodWritePath } from "./paths";
import { listFoodSource, resolveFood, sqlFoodSource, type FoodAsk, type FoodSource } from "./slices";
import { noLookPhoto, noLookSaved, oddCalorie, oddEntry, SQL_NOLOOK_PHOTO, SQL_NOLOOK_SAVED, SQL_ODD_CALORIE, SQL_ODD_ENTRY } from "../pg/feedSlices";
import { FEED_KIND_ROWS, HOME_NEW_DAYS } from "../chat/pick";
import { foodChainBusy, foodChainsSettled, foodRead, foodWriteRaw, lostConnection, throwIfFaultBeforeCommit, type Q, type Row } from "./pg";
import { noteFoodMissed, noteFoodOrders, noteFoodSeen, noteFoodWrite, onFoodFetch } from "./shadow";
import { FOOD_ORDER_STAMPS, orderKey, putOnClient, readOrders, stampClient, stampsOf, type OrderRow } from "./orders";
import { OnceAnswered } from "./onceAnswered";
import nodePath from "path";
import { trashFile } from "../storage";

export { FOOD_TABLES };

/** The short names the code uses for the seven lists. */
export const FOOD_SHORT = { entries: "food_entries", calories: "calorie_logs", days: "food_days", meals: "food_meals", savedMeals: "saved_meals", savedDays: "saved_days", photos: "meal_photos" } as const;
export type FoodShort = keyof typeof FOOD_SHORT;
const SHORTS = Object.keys(FOOD_SHORT) as FoodShort[];
/** The tables keyed by day: a scope takes them by date. The others (meals, saved meals, saved days) are a client's whole. */
const DATED: ReadonlySet<FoodShort> = new Set<FoodShort>(["entries", "calories", "days", "photos"]);
const TABLE_OF = { food_entries, calorie_logs, food_days, food_meals, saved_meals, saved_days, meal_photos } as const;

type Lists = { entries: FoodEntry[]; calories: CalorieLog[]; days: FoodDay[]; meals: FoodMealSlot[]; savedMeals: SavedMeal[]; savedDays: SavedDay[]; photos: MealPhoto[] };

const MODE: "wide" | "narrow" = FOOD_PG || process.env.FOOD_VIEWS === "narrow" ? "narrow" : "wide";
/** Where a miss throws rather than being said: always with the rows in Postgres (there is no store to fall back on). */
const STRICT = FOOD_PG || MODE === "narrow" || process.env.NODE_ENV === "test" || process.env.FOOD_STRICT === "1";

/** A view asked for what it doesn't hold. */
export class FoodViewMiss extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FoodViewMiss";
  }
}

// ---- What a fetch took ---------------------------------------------------------------------------------------------

/**
 * The days a reader reads: every day, some days, or a run of them (ISO dates, inclusive); or what a coach-wide reader
 * reads of a client's feed, never rows by day (21 Nov, the bounded slices; food/slices.ts resolves each into days):
 *   { feedFrom: T }  every food event of the client at or after T (an instant), and their newest whenever it is;
 *   { coachTop: n }  the client's coach's newest n food events (asked of each of the coach's clients);
 *   { since: prev }  the rows the Feed's Since may count as saved after the coach's last visit;
 *   "logged"         whether the client logged any entry, or any calorie figure of their own.
 */
export type FoodSpan = "all" | { dates: readonly string[] } | { from: string; to: string } | { feedFrom: number } | { coachTop: number } | { since: number } | "logged";

type ClientScope = {
  all: boolean;
  dates: Set<string>;
  ranges: { from: string; to: string }[];
  meals: Set<string>;
  ids: Set<number>;
  /** The lists taken for this client (the scope's when null): a coach's other clients hold entries and calorie logs alone. */
  tables: Set<FoodShort> | null;
  /** What coach-wide readers asked (food/slices.ts FoodAsk), and what the fetch resolved it to. */
  ask: FoodAsk;
  coach: number | null;
  keys: Set<string>;
  odd: boolean;
  keyEntryIds: Set<number>;
  keyCalorieIds: Set<number>;
};
type Scope = {
  clients: Map<number, ClientScope>;
  tables: ReadonlySet<FoodShort>;
  /** meal_photos by file, any client (a picture's thumb: getFoodDiary, saveMeal). */
  paths: Set<string>;
  /** The day photos and saved meals that may want their look, any client (the start-up's back-fill). */
  nolook?: boolean;
  /** The fetch's clock: what its asks are resolved at, the same on both sides of the shadow. */
  now?: number;
};

const emptyClientScope = (): ClientScope => ({
  all: false,
  dates: new Set(),
  ranges: [],
  meals: new Set(),
  ids: new Set(),
  tables: null,
  ask: { feed: null, top: null, since: null, logged: false },
  coach: null,
  keys: new Set(),
  odd: false,
  keyEntryIds: new Set(),
  keyCalorieIds: new Set(),
});
function addSpan(s: ClientScope, span: FoodSpan) {
  if (span === "all") s.all = true;
  else if (span === "logged") s.ask.logged = true;
  else if ("dates" in span) for (const d of span.dates) s.dates.add(d);
  else if ("feedFrom" in span) s.ask.feed = Math.min(s.ask.feed ?? Infinity, span.feedFrom);
  else if ("coachTop" in span) s.ask.top = { coach: s.coach ?? 0, n: Math.max(s.ask.top?.n ?? 0, span.coachTop) };
  else if ("since" in span) s.ask.since = s.ask.since == null ? span.since : Math.min(s.ask.since, span.since);
  else s.ranges.push({ from: span.from, to: span.to });
}
function makeScope(clientIds: readonly number[], spans: readonly FoodSpan[], tables: readonly FoodShort[] = SHORTS, meals: readonly string[] = [], entryIds: readonly number[] = []): Scope {
  const clients = new Map<number, ClientScope>();
  for (const id of clientIds) {
    const s = clients.get(id) ?? emptyClientScope();
    for (const span of spans) addSpan(s, span);
    for (const m of meals) s.meals.add(m);
    for (const e of entryIds) s.ids.add(e);
    clients.set(id, s);
  }
  return { clients, tables: new Set(tables), paths: new Set() };
}
/** One part of a coach-wide scope: these clients, these spans, these lists (a client in several holds all of theirs). */
type ScopePart = { ids: readonly number[]; spans: readonly FoodSpan[]; tables: readonly FoodShort[] };
function partsScope(parts: readonly ScopePart[]): Scope {
  const clients = new Map<number, ClientScope>();
  const all = new Set<FoodShort>();
  const coachOf = new Map(getData().clients.map((c) => [c.id, c.coach_id ?? null] as const));
  for (const p of parts) {
    for (const t of p.tables) all.add(t);
    for (const id of p.ids) {
      const s = clients.get(id) ?? emptyClientScope();
      s.coach ??= coachOf.get(id) ?? null;
      for (const span of p.spans) addSpan(s, span);
      s.tables = new Set([...(s.tables ?? []), ...p.tables]);
      clients.set(id, s);
    }
  }
  return { clients, tables: all, paths: new Set() };
}
const tablesOf = (scope: Scope, s: ClientScope) => s.tables ?? scope.tables;
const inDay = (s: ClientScope, date: string) => s.all || s.dates.has(date) || s.keys.has(date) || s.ranges.some((r) => date >= r.from && date <= r.to);
/** Whether a stored row is inside the scope (the predicate every slice, store or SQL, follows). */
function rowIn(scope: Scope, short: FoodShort, row: { id?: number; client_id: number; date?: string; meal?: string; file_path?: string }): boolean {
  if (!scope.tables.has(short)) return false;
  if (short === "photos" && row.file_path != null && scope.paths.has(row.file_path)) return true;
  if (scope.nolook && ((short === "photos" && noLookPhoto(row as never)) || (short === "savedMeals" && noLookSaved(row as never)))) return true;
  const s = scope.clients.get(row.client_id);
  if (!s || !tablesOf(scope, s).has(short)) return false;
  if (!DATED.has(short)) return true;
  if (short === "entries" && row.meal != null && s.meals.has(row.meal)) return true;
  if (short === "entries" && row.id != null && (s.ids.has(row.id) || s.keyEntryIds.has(row.id))) return true;
  if (short === "calories" && row.id != null && s.keyCalorieIds.has(row.id)) return true;
  if (s.odd && ((short === "entries" && oddEntry(row as never)) || (short === "calories" && oddCalorie(row as never)))) return true;
  return typeof row.date === "string" && inDay(s, row.date);
}
function covers(scope: Scope, clientId: number, span: FoodSpan, tables: readonly FoodShort[]): string | null {
  for (const t of tables) if (!scope.tables.has(t)) return `the ${t} list was not fetched`;
  const s = scope.clients.get(clientId);
  if (!s) return `client ${clientId} was not fetched`;
  for (const t of tables) if (!tablesOf(scope, s).has(t)) return `the ${t} list of client ${clientId} was not fetched`;
  if (!tables.some((t) => DATED.has(t)) || s.all) return null;
  if (span === "all") return `client ${clientId}'s whole history was not fetched`;
  if (span === "logged") return s.ask.logged ? null : `whether client ${clientId} logged food was not fetched`;
  if ("feedFrom" in span) return s.ask.feed != null && s.ask.feed <= span.feedFrom ? null : `client ${clientId}'s food feed from ${span.feedFrom} was not fetched (held ${s.ask.feed ?? "none"})`;
  if ("coachTop" in span) return s.ask.top && s.ask.top.n >= span.coachTop ? null : `the coach's newest ${span.coachTop} food events were not fetched for client ${clientId}`;
  if ("since" in span) return s.ask.since != null && s.ask.since === span.since ? null : `client ${clientId}'s food since ${span.since} was not fetched (held ${s.ask.since ?? "none"})`;
  if ("dates" in span) {
    const out = span.dates.filter((d) => !inDay(s, d));
    return out.length ? `${out.length} day(s) of client ${clientId} were not fetched` : null;
  }
  return s.ranges.some((r) => r.from <= span.from && r.to >= span.to) ? null : `client ${clientId} from ${span.from} to ${span.to} was not fetched`;
}

// ---- The lists: the store's, or a slice of them --------------------------------------------------------------------

type Holder = { get(short: FoodShort): unknown[]; set(short: FoodShort, rows: unknown[]): void };
/** The store's own arrays, read fresh each time (a delete puts a new list in its place). Memory mode alone. */
// chat-door: notes-door: one food list by its own name, never a walk of the store: no chat or notification row is read.
const storeHolder: Holder = {
  get(short) {
    if (FOOD_PG) throw new Error(`[food] !!! the store's ${FOOD_SHORT[short]} was read with FOOD_STORE=pg (it lives in Postgres alone)`);
    // chat-door: notes-door: one food list by name (not a walk of the store).
    const held = getData() as unknown as Record<string, unknown[] | undefined>;
    return (held[FOOD_SHORT[short]] ??= []);
  },
  set(short, rows) {
    // chat-door: notes-door: the same, one food list replaced by name.
    if (FOOD_PG) throw new Error(`[food] !!! the store's ${FOOD_SHORT[short]} was written with FOOD_STORE=pg`);
    (getData() as unknown as Record<string, unknown[]>)[FOOD_SHORT[short]] = rows;
  },
};
function listHolder(lists: Lists): Holder {
  return {
    get: (short) => lists[short],
    set: (short, rows) => {
      (lists as Record<FoodShort, unknown[]>)[short] = rows;
    },
  };
}

/** What the food code reads and changes of a client row: its meal order (clients.meal_order, in memory with the client). */
export type MealOrderHolder = { meal_order?: string[] | null };

const MINT = Symbol("food-door");
const said = new Set<string>();

/**
 * One fetch's food: the seven lists under their short names, and what was taken. A reader says what it reads first
 * (need), then reads the lists as it read the store; a list it was handed is the store's own or a superset slice of it,
 * in the store's order, so its own filters and sorts give what they always gave.
 */
export class FoodRows {
  readonly path: FoodReadPath | FoodWritePath;
  protected readonly holder: Holder;
  protected readonly scope: Scope | null;
  /**
   * The clients' meal order. Memory mode (null): the client row's own, in the store. FOOD_STORE=pg: read from
   * food_meal_orders with the rows (a view: in the fetch's snapshot; a box: in its transaction, under the client's lock),
   * one holder for each client the fetch took with its meal list; a box's holder is its own copy until its commit.
   */
  protected readonly orders: Map<number, MealOrderHolder> | null;
  constructor(token: symbol, path: FoodReadPath | FoodWritePath, holder: Holder, scope: Scope | null, orders: Map<number, MealOrderHolder> | null = null) {
    if (token !== MINT) throw new Error("Food rows are made by the door (app/lib/food/rows.ts) alone.");
    this.path = path;
    this.holder = holder;
    this.scope = scope;
    this.orders = orders;
  }
  get entries(): FoodEntry[] {
    return this.holder.get("entries") as FoodEntry[];
  }
  get calories(): CalorieLog[] {
    return this.holder.get("calories") as CalorieLog[];
  }
  get days(): FoodDay[] {
    return this.holder.get("days") as FoodDay[];
  }
  get meals(): FoodMealSlot[] {
    return this.holder.get("meals") as FoodMealSlot[];
  }
  get savedMeals(): SavedMeal[] {
    return this.holder.get("savedMeals") as SavedMeal[];
  }
  get savedDays(): SavedDay[] {
    return this.holder.get("savedDays") as SavedDay[];
  }
  get photos(): MealPhoto[] {
    return this.holder.get("photos") as MealPhoto[];
  }
  /**
   * The client's meal order: memory mode, the client row itself (as before); FOOD_STORE=pg, what food_meal_orders held
   * (a box: its own copy, written in its transaction and put on the client in memory after its commit). A client no
   * longer in memory has none; one the fetch didn't take with its meal list is a miss, thrown.
   */
  client(clientId: number): MealOrderHolder | undefined {
    if (this.orders) {
      if (!getData().clients.some((x) => x.id === clientId)) return undefined;
      const o = this.orders.get(clientId);
      if (o) return o;
      const message = `[food] the meal order of client ${clientId} on ${this.path} was not fetched`;
      noteFoodMissed(this.path, message);
      throw new FoodViewMiss(message);
    }
    return getData().clients.find((c) => c.id === clientId);
  }
  /**
   * FOOD_STORE=pg: the order food_meal_orders held for this client when it was read with these rows (null: no row),
   * undefined when it wasn't read (memory mode, a scope without meals). Never throws (the JSONs' copy, withFoodKeys).
   */
  tableOrder(clientId: number): string[] | null | undefined {
    const o = this.orders?.get(clientId);
    return o ? (o.meal_order ?? null) : undefined;
  }
  /**
   * What a reader is about to read: these clients (every client of the view: "fetched"), these days, these lists.
   * Answered nothing; a miss throws where views are narrow, else is said once and counted.
   */
  need(reader: string, clientIds: number | readonly number[], span: FoodSpan = "all", tables: readonly FoodShort[] = SHORTS): void {
    if (!this.scope) return;
    for (const id of typeof clientIds === "number" ? [clientIds] : clientIds) {
      const why = covers(this.scope, id, span, tables);
      if (!why) continue;
      const message = `[food] ${reader} on ${this.path}: ${why}`;
      noteFoodMissed(this.path, message);
      if (STRICT) throw new FoodViewMiss(message);
      if (!said.has(message)) {
        said.add(message);
        console.warn(message);
      }
    }
  }
  /** What the start-up's look back-fill reads (storage.ts): every client's day photos and saved meals still without a look. */
  needNoLook(reader: string): void {
    if (!this.scope || this.scope.nolook) return;
    const message = `[food] ${reader} on ${this.path}: the pictures without a look were not fetched`;
    noteFoodMissed(this.path, message);
    if (STRICT) throw new FoodViewMiss(message);
    if (!said.has(message)) {
      said.add(message);
      console.warn(message);
    }
  }
}

/** A writer's rows: a view whose lists can be replaced, ids allocated, and the save and the pictures' clean-up asked for. */
export class FoodBox extends FoodRows {
  private readonly onPersist: () => void;
  private readonly onGc: (paths: (string | null | undefined)[]) => string[];
  constructor(token: symbol, path: FoodWritePath, holder: Holder, scope: Scope | null, orders: Map<number, MealOrderHolder> | null, onPersist: () => void, onGc: (paths: (string | null | undefined)[]) => string[]) {
    super(token, path, holder, scope, orders);
    this.onPersist = onPersist;
    this.onGc = onGc;
  }
  override get entries(): FoodEntry[] {
    return super.entries;
  }
  override set entries(rows: FoodEntry[]) {
    this.holder.set("entries", rows);
  }
  override get calories(): CalorieLog[] {
    return super.calories;
  }
  override set calories(rows: CalorieLog[]) {
    this.holder.set("calories", rows);
  }
  override get days(): FoodDay[] {
    return super.days;
  }
  override set days(rows: FoodDay[]) {
    this.holder.set("days", rows);
  }
  override get meals(): FoodMealSlot[] {
    return super.meals;
  }
  override set meals(rows: FoodMealSlot[]) {
    this.holder.set("meals", rows);
  }
  override get savedMeals(): SavedMeal[] {
    return super.savedMeals;
  }
  override set savedMeals(rows: SavedMeal[]) {
    this.holder.set("savedMeals", rows);
  }
  override get savedDays(): SavedDay[] {
    return super.savedDays;
  }
  override set savedDays(rows: SavedDay[]) {
    this.holder.set("savedDays", rows);
  }
  override get photos(): MealPhoto[] {
    return super.photos;
  }
  override set photos(rows: MealPhoto[]) {
    this.holder.set("photos", rows);
  }
  /** A new id for a row of this list (the store's counter, or its sequence in Postgres mode: db.ts allocId). */
  alloc(short: FoodShort): number {
    return allocId(FOOD_SHORT[short]);
  }
  /** The store's save (memory); nothing in Postgres mode, where writeFood writes what changed when the code is done. */
  persist(): void {
    this.onPersist();
  }
  /**
   * Of these picture files, the ones no saved meal, day's photo or saved day shows any more. Memory: taken off the disk
   * now and returned, as always. Postgres: the list handed back is filled by writeFood once the rows are written, from
   * SQL in the same transaction, and the files go to the trash after the commit.
   */
  gc(paths: (string | null | undefined)[]): string[] {
    return this.onGc(paths);
  }
}

/** Today's dropUnusedMealPictures, on the store: every client's rows, by file. */
function storeGc(paths: (string | null | undefined)[]): string[] {
  const savedMeals = storeHolder.get("savedMeals") as SavedMeal[];
  const photos = storeHolder.get("photos") as MealPhoto[];
  const savedDays = storeHolder.get("savedDays") as SavedDay[];
  const gone = [...new Set(paths.filter((p): p is string => !!p))].filter((p) => !savedMeals.some((s) => s.picture === p) && !photos.some((m) => m.file_path === p) && !savedDays.some((d) => d.picture === p || d.cards?.some((c) => c.picture === p)));
  for (const p of gone) trashFile(nodePath.join(DATA_DIR, p.startsWith("/") ? p.slice(1) : p));
  return gone;
}

const storeBox = (p: FoodWritePath) => new FoodBox(MINT, p, storeHolder, null, null, persist, storeGc);

// ---- Fetch first ---------------------------------------------------------------------------------------------------

const decodeOf = (t: FoodTable) => (r: Row) => fromRecord(TABLE_OF[t], r);
const byId = (a: { id: number }, b: { id: number }) => a.id - b.id;
const ints = (ids: readonly number[]) => `{${ids.filter((n) => Number.isInteger(n)).join(",")}}`;
const textJson = (list: Iterable<string>) => JSON.stringify([...list]);
const CHUNK = 5000;
function* chunks<T>(list: readonly T[], size = CHUNK): Generator<T[]> {
  for (let i = 0; i < list.length; i += size) yield list.slice(i, i + size);
}

/** The store's rows inside the scope, the same objects in the store's order (FOOD_VIEWS=narrow). */
function sliceStore(scope: Scope): Lists {
  const out = {} as Record<FoodShort, unknown[]>;
  for (const short of SHORTS) {
    out[short] = scope.tables.has(short) ? (storeHolder.get(short) as { client_id: number }[]).filter((r) => rowIn(scope, short, r as never)) : [];
  }
  return out as unknown as Lists;
}

/** The scope's SQL for one table: its clients, its days, its meal keys, its files (any client). */
function scopeSql(short: FoodShort, scope: Scope): SQL | null {
  if (!scope.tables.has(short)) return null;
  const t = sql.identifier(FOOD_SHORT[short]);
  const parts: SQL[] = [];
  const whole: number[] = [];
  for (const [id, s] of scope.clients) {
    if (!tablesOf(scope, s).has(short)) continue;
    if (!DATED.has(short) || s.all) {
      whole.push(id);
      continue;
    }
    const days: SQL[] = [];
    if (s.dates.size) days.push(sql`date IN (SELECT jsonb_array_elements_text(${textJson(s.dates)}::jsonb))`);
    for (const r of s.ranges) days.push(sql`(date >= ${r.from}::text AND date <= ${r.to}::text)`);
    if (short === "entries" && s.meals.size) days.push(sql`meal IN (SELECT jsonb_array_elements_text(${textJson(s.meals)}::jsonb))`);
    if (short === "entries" && s.ids.size) days.push(sql`id = ANY(${ints([...s.ids])}::int[])`);
    if (days.length) parts.push(sql`(client_id = ${id}::int AND (${sql.join(days, sql` OR `)}))`);
  }
  if (whole.length) parts.push(sql`client_id = ANY(${ints(whole)}::int[])`);
  if (short === "photos" && scope.paths.size) parts.push(sql`file_path IN (SELECT jsonb_array_elements_text(${textJson(scope.paths)}::jsonb))`);
  if (scope.nolook && short === "photos") parts.push(sql.raw(SQL_NOLOOK_PHOTO));
  if (scope.nolook && short === "savedMeals") parts.push(sql.raw(SQL_NOLOOK_SAVED));
  if (!parts.length) return null;
  return sql`SELECT * FROM ${t} WHERE ${sql.join(parts, sql` OR `)} ORDER BY id`;
}

/**
 * The days and rows a fetch resolved (food/slices.ts) as their own statements: each day whole by (client_id, date), a
 * row by (client_id, id), in chunks; never an OR a client in one statement, so a coach-wide scope is a few statements.
 */
async function keyedRows(q: Q, short: FoodShort, scope: Scope): Promise<Row[]> {
  if (short !== "entries" && short !== "calories") return [];
  if (!scope.tables.has(short)) return [];
  const t = sql.identifier(FOOD_SHORT[short]);
  const days: { c: number; d: string }[] = [];
  const ids: { c: number; i: number }[] = [];
  const odd: number[] = [];
  for (const [c, s] of scope.clients) {
    if (s.all || !tablesOf(scope, s).has(short)) continue;
    if (s.odd) odd.push(c);
    for (const d of s.keys) if (!s.dates.has(d)) days.push({ c, d });
    for (const i of short === "entries" ? s.keyEntryIds : s.keyCalorieIds) ids.push({ c, i });
  }
  const out: Row[] = [];
  for (const part of chunks(days)) out.push(...(await q(sql`SELECT t.* FROM jsonb_to_recordset(${JSON.stringify(part)}::jsonb) AS k(c int, d text) CROSS JOIN LATERAL (SELECT t.* FROM ${t} t WHERE t.client_id = k.c AND t.date = k.d) t`)));
  // The odd rows of the clients a feed's moments were asked of, on their partial indexes (food/slices.ts); no ORDER BY,
  // so the planner never trades the partial index for an ordered walk of the whole table (sorted by id below).
  for (const part of chunks(odd)) out.push(...(await q(sql`SELECT * FROM ${t} WHERE client_id = ANY(${ints(part)}::int[]) AND ${sql.raw(short === "entries" ? SQL_ODD_ENTRY() : SQL_ODD_CALORIE())}`)));
  for (const part of chunks(ids)) out.push(...(await q(sql`SELECT t.* FROM jsonb_to_recordset(${JSON.stringify(part)}::jsonb) AS k(c int, i int) CROSS JOIN LATERAL (SELECT t.* FROM ${t} t WHERE t.client_id = k.c AND t.id = k.i) t`)));
  return out;
}

/** The scope read from Postgres in one snapshot (or inside a write's transaction), each list by id. */
async function loadScope(q: Q, scope: Scope): Promise<Lists> {
  const out = {} as Record<FoodShort, unknown[]>;
  for (const short of SHORTS) {
    const query = scopeSql(short, scope);
    const rows = query ? await q(query) : [];
    const keyed = await keyedRows(q, short, scope);
    const seen = new Set<unknown>();
    const all = [...rows, ...keyed].filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
    out[short] = all.map(decodeOf(FOOD_SHORT[short])).sort(byId as never);
  }
  return out as unknown as Lists;
}

/** The files a client's pictures are: their thumbs are looked up by file in meal_photos, any client (getFoodDiary). */
function picturePathsOf(lists: Lists): string[] {
  const paths = new Set<string>();
  for (const s of lists.savedMeals) if (s.picture) paths.add(s.picture);
  for (const p of lists.photos) if (p.file_path) paths.add(p.file_path);
  return [...paths];
}

/**
 * The scope read, and with `withPictures` the day photos by file of every picture its saved meals and photos show (a
 * thumb looked up by file, any client): the cut-over's own statements, the same in pg mode and in the shadow. The files
 * taken are added to `scope.paths`, so the scope's predicate (rowIn) holds the rows the second statement took.
 */
async function loadScopeWithPictures(q: Q, scope: Scope, withPictures: boolean): Promise<Lists> {
  const got = await loadScope(q, scope);
  if (withPictures && scope.tables.has("photos")) {
    const more = picturePathsOf(got).filter((p) => !got.photos.some((m) => m.file_path === p));
    if (more.length) {
      const extra: Scope = { clients: new Map(), tables: new Set<FoodShort>(["photos"]), paths: new Set(more) };
      const seen = new Set(got.photos.map((p) => p.id));
      got.photos = [...got.photos, ...(await loadScope(q, extra)).photos.filter((p) => !seen.has(p.id))].sort(byId);
    }
    for (const p of picturePathsOf(got)) scope.paths.add(p);
  }
  return got;
}

// ---- The coach-wide asks resolved (food/slices.ts) ------------------------------------------------------------------

/** The clients whose asks are to resolve: not a client taken whole (the whole holds every answer). */
function asksOf(scope: Scope): Map<number, FoodAsk> {
  const out = new Map<number, FoodAsk>();
  for (const [c, s] of scope.clients) {
    if (s.all) continue;
    const a = s.ask;
    if (a.feed != null || a.top != null || a.since != null || a.logged) out.set(c, { ...a, top: a.top ? { coach: s.coach ?? 0, n: a.top.n } : null });
  }
  return out;
}
/** What the fetch resolved, onto the scope: the days whole, the odd rows, the rows by id. */
async function resolveScope(scope: Scope, src: FoodSource): Promise<void> {
  const asks = asksOf(scope);
  if (!asks.size) return;
  const got = await resolveFood(asks, src, scope.now ?? Date.now());
  for (const [c, r] of got) {
    const s = scope.clients.get(c);
    if (!s) continue;
    for (const d of r.keys) s.keys.add(d);
    s.odd ||= r.odd;
    for (const i of r.entryIds) s.keyEntryIds.add(i);
    for (const i of r.calorieIds) s.keyCalorieIds.add(i);
  }
}
/** The scope as asked, nothing resolved: the shadow resolves its own copy each side (SQL, and the rows committed). */
function unresolvedCopy(scope: Scope): Scope {
  const clients = new Map<number, ClientScope>();
  for (const [c, s] of scope.clients) clients.set(c, { ...s, keys: new Set(), odd: false, keyEntryIds: new Set(), keyCalorieIds: new Set() });
  return { clients, tables: scope.tables, paths: new Set(scope.paths), nolook: scope.nolook, now: scope.now };
}
/** What a resolved scope holds, as one line to compare (the shadow's keys check): client ids, days, ids, never a value. */
function resolvedLine(scope: Scope): string {
  const parts: string[] = [];
  for (const [c, s] of [...scope.clients].sort((a, b) => a[0] - b[0])) {
    if (!s.keys.size && !s.odd && !s.keyEntryIds.size && !s.keyCalorieIds.size) continue;
    parts.push(`${c}:${[...s.keys].sort().join(",")}|${s.odd ? 1 : 0}|${[...s.keyEntryIds].sort((a, b) => a - b).join(",")}|${[...s.keyCalorieIds].sort((a, b) => a - b).join(",")}`);
  }
  return parts.join(";");
}
const decodeLists = { entry: (r: Row) => decodeOf("food_entries")(r) as unknown as FoodEntry, calorie: (r: Row) => decodeOf("calorie_logs")(r) as unknown as CalorieLog };

async function fetchScope(path: FoodReadPath, scope: Scope, withPictures: boolean): Promise<FoodRows> {
  noteFoodSeen(path);
  scope.now ??= Date.now();
  if (FOOD_PG) {
    // The meal order with the meal lists, in the same snapshot (a card and its place always agree), never the mirror.
    const ids = [...scope.clients.keys()];
    const gen = orderGeneration();
    const got = await foodRead(async (q) => {
      await resolveScope(scope, sqlFoodSource(q, decodeLists));
      return { lists: await loadScopeWithPictures(q, scope, withPictures), orders: scope.tables.has("meals") && ids.length ? await readOrders(q, ids) : null };
    });
    const orders = new Map<number, MealOrderHolder>();
    if (got.orders) {
      for (const id of ids) {
        const r = got.orders.get(id);
        orders.set(id, r?.meal_order ? { meal_order: r.meal_order } : {});
      }
      checkMirror(path, got.orders, ids, gen);
    }
    return new FoodRows(MINT, path, listHolder(got.lists), scope, orders);
  }
  // The shadow (FOOD_SHADOW=read): the same scope's SQL, the pictures' second statement too, compared with what the
  // last save committed. Behind the answer, on its own copies of the scope (the view's own is never touched by it): the
  // SQL side resolves its asks in SQL, the committed side over the rows committed, and the two resolutions are compared.
  const sqlScope = unresolvedCopy(scope);
  const committedScope = unresolvedCopy(scope);
  const hasAsks = asksOf(scope).size > 0;
  onFoodFetch(path, {
    tables: SHORTS.filter((s) => scope.tables.has(s)).map((s) => FOOD_SHORT[s]),
    sqlRows: async (q) => {
      sqlScope.paths = new Set(scope.paths);
      if (hasAsks) await resolveScope(sqlScope, sqlFoodSource(q, decodeLists));
      const lists = await loadScopeWithPictures(q, sqlScope, withPictures);
      return Object.fromEntries(SHORTS.map((s) => [FOOD_SHORT[s], lists[s] as unknown as Row[]]));
    },
    prepare: hasAsks
      ? async (rowsOf) => {
          committedScope.paths = sqlScope.paths;
          await resolveScope(committedScope, listFoodSource(rowsOf("food_entries") as unknown as FoodEntry[], rowsOf("calorie_logs") as unknown as CalorieLog[]));
          return { sql: resolvedLine(sqlScope), committed: resolvedLine(committedScope) };
        }
      : undefined,
    committedIn: (t, row) => rowIn(hasAsks ? committedScope : sqlScope, SHORT_OF[t], row as never),
    decode: (t, record) => decodeOf(t)(record),
    clients: [...scope.clients.keys()],
    anyClient: (t) => (t === "meal_photos" && (sqlScope.paths.size > 0 || !!scope.nolook)) || (t === "saved_meals" && !!scope.nolook),
    // The meal order: in memory mode it is the client row's (food_meal_orders is empty until a pg boot seeds it from
    // exactly that), so the SQL side is the clients table's, compared with what the last save committed of it.
    orders: scope.tables.has("meals") && scope.clients.size ? shadowOrders([...scope.clients.keys()]) : undefined,
  });
  if (MODE === "narrow") {
    await resolveScope(scope, listFoodSource(storeHolder.get("entries") as FoodEntry[], storeHolder.get("calories") as CalorieLog[]));
    if (withPictures && scope.tables.has("photos")) for (const p of picturePathsOf(sliceStore(scope))) scope.paths.add(p);
    return new FoodRows(MINT, path, listHolder(sliceStore(scope)), scope);
  }
  return new FoodRows(MINT, path, storeHolder, scope);
}
const SHORT_OF = Object.fromEntries(SHORTS.map((s) => [FOOD_SHORT[s], s])) as Record<FoodTable, FoodShort>;

// ---- The meal order's mirror (FOOD_STORE=pg) -------------------------------------------------------------------------

const og = globalThis as unknown as { __norcoachFoodOrderGen?: number };
/** Moves on each time a write puts a meal order onto a client in memory (so a fetch over it is a race, not a drift). */
const orderGeneration = () => og.__norcoachFoodOrderGen ?? 0;
const orderMoved = () => void (og.__norcoachFoodOrderGen = orderGeneration() + 1);

/**
 * The mirror checked against the table on every pg fetch that read the order (in memory, no SQL): equal, else a drift,
 * counted by the shadow (counts and paths alone); a write of one of these clients in flight, or a mirror put meanwhile,
 * is a race, not a drift. A drift means a rollback would read a card's place the table no longer holds.
 */
function checkMirror(path: FoodReadPath, rows: ReadonlyMap<number, OrderRow>, ids: readonly number[], gen: number) {
  try {
    let compared = 0;
    let drifted = 0;
    let raced = 0;
    // The clients in one pass (a coach-wide fetch's scope is many clients: never a find per client).
    const want = new Set(ids);
    const byId = new Map<number, { meal_order?: string[] | null }>();
    for (const c of getData().clients) if (want.has(c.id)) byId.set(c.id, c);
    for (const id of ids) {
      const c = byId.get(id);
      if (!c) continue;
      compared++;
      if (orderKey(c.meal_order) === orderKey(rows.get(id)?.meal_order)) continue;
      if (orderGeneration() !== gen || foodChainBusy(`food:${id}`)) raced++;
      else drifted++;
    }
    noteFoodOrders(path, { compared, drifted, raced });
  } catch {
    /* never into a request */
  }
}

/**
 * The shadow's meal order (memory mode): the clients table's, and what the last save committed of it. What it proves is
 * the store's save of the orders a first pg boot builds food_meal_orders from, never pg mode's own read of the table
 * (empty in memory mode): that is checkMirror's, in pg mode (the review's note, 20 Nov). The order alone is read
 * (`extra->'meal_order'`), never the whole client row; none and null are the same order (orders.ts orderKey).
 */
function shadowOrders(ids: readonly number[]) {
  const pick = (id: unknown, order: unknown) => (Array.isArray(order) ? [{ client_id: Number(id), meal_order: order }] : []);
  return {
    sqlRows: async (q: Q) => (await q(sql`SELECT id, extra->'meal_order' AS meal_order FROM clients WHERE id = ANY(${ints(ids)}::int[]) ORDER BY id`)).flatMap((r) => pick(r.id, r.meal_order)),
    committedRows: (committed: ReadonlyMap<string, string>) => ids.flatMap((id) => {
      const json = committed.get(String(id));
      if (!json) return [];
      const c = fromRecord(clientsTable, JSON.parse(json) as Row) as { id: number; meal_order?: unknown };
      return pick(c.id, c.meal_order);
    }),
  };
}

/** One client's food over these days (every day by default): the diary, its links, the client's own screens. */
export function fetchClientFood(clientId: number, path: FoodReadPath, spans: FoodSpan | readonly FoodSpan[] = "all"): Promise<FoodRows> {
  return fetchScope(path, makeScope([clientId], Array.isArray(spans) ? (spans as FoodSpan[]) : [spans as FoodSpan]), true);
}

const FEED_LISTS: readonly FoodShort[] = ["entries", "calories"];
/**
 * The moment the coach-wide readers' window starts (getClientHome's unseen marks, Needs you, markClientEventsSeen:
 * HOME_NEW_DAYS back), an hour more for the clock between the fetch and the read, as the chat's views take it.
 */
const feedWindow = () => Date.now() - HOME_NEW_DAYS * 86_400_000 - 3_600_000;
/** The coach's previous visit to the Feed (its Since), as the chat's view reads it; null on a first visit. */
function feedPrev(coachId: number): number | null {
  const prev = getData().users.find((u) => u.id === coachId && u.role === "coach")?.feed_looked?.prev;
  return typeof prev === "number" && Number.isFinite(prev) ? prev : null;
}
const coachClientIds = (coachIds: Iterable<number>) => {
  const coaches = new Set(coachIds);
  return getData()
    .clients.filter((c) => c.coach_id != null && coaches.has(c.coach_id))
    .map((c) => c.id);
};

/**
 * What a coach-wide page reads of these coaches' clients' food, by the page (food/paths.ts FOOD_SHAPE): the rail's
 * window, the Feed's newest and Since, Coaches' newest per coach, or (the old admin) everything.
 */
function coachParts(coachIds: readonly number[], path: FoodReadPath): ScopePart[] {
  const ids = coachClientIds(coachIds);
  const shape = FOOD_SHAPE[path as keyof typeof FOOD_SHAPE] ?? "all";
  if (shape === "all") return [{ ids, spans: ["all"], tables: FEED_LISTS }];
  const spans: FoodSpan[] = [];
  if (shape === "accounts") spans.push({ coachTop: 1 });
  else spans.push({ feedFrom: feedWindow() });
  if (shape === "feed") {
    spans.push({ coachTop: FEED_KIND_ROWS });
    const prev = coachIds.length === 1 ? feedPrev(coachIds[0]) : null;
    if (prev != null) spans.push({ since: prev });
  }
  return [{ ids, spans, tables: FEED_LISTS }];
}

/** The client's own app: their whole food diary (the diary, Last 7 days, the calendar, the chat's meal links), and the
 *  clients the locked app's one-time sweep reads while it hasn't run (appLockFor): whether each logged anything. */
export function fetchClientPageFood(clientId: number, path: FoodReadPath): Promise<FoodRows> {
  const swept = unsweptClients().filter((id) => id !== clientId);
  return fetchScope(path, partsScope([{ ids: [clientId], spans: ["all"], tables: SHORTS }, { ids: swept, spans: ["logged"], tables: FEED_LISTS }]), true);
}

/** Several clients' food, whole (the old admin's screens, the coach's tabs over one client and their coach's others). */
export function fetchClientsFood(clientIds: readonly number[], path: FoodReadPath, tables: readonly FoodShort[] = SHORTS): Promise<FoodRows> {
  return fetchScope(path, makeScope([...new Set(clientIds)], ["all"], tables), tables.includes("photos"));
}

/**
 * What a coach's feed reads of food (entries and calorie logs) for every client of these coaches, and the client in
 * focus: the page's shape (food/paths.ts FOOD_SHAPE: the rail's window, the Feed's newest 200 and Since, Coaches' newest
 * per coach), or with a focus (an action about one client: its marks, its Needs you) that client's window alone.
 */
export function fetchCoachFood(coachIds: readonly number[], path: FoodReadPath, focus?: number): Promise<FoodRows> {
  if (focus != null && FOOD_SHAPE[path as keyof typeof FOOD_SHAPE] === "focus") return fetchScope(path, partsScope([{ ids: [focus], spans: [{ feedFrom: feedWindow() }], tables: FEED_LISTS }]), false);
  const parts = coachParts(coachIds, path);
  if (focus != null) parts.push({ ids: [focus], spans: ["all"], tables: FEED_LISTS });
  return fetchScope(path, partsScope(parts), false);
}

/**
 * A client's tab in the admin: one view for the rail, the dots and Home's feed (the coach's clients, and the client's
 * own coach's should the owner open another coach's client: their window, entries and calorie logs) and for every tab's
 * reading of the client (their whole food diary), and whether each client still unopened logged anything (the locked
 * app's sweep). As fetchClientTabChat asks for the chat.
 */
export function fetchClientTabFood(coachId: number, clientId: number, path: FoodReadPath): Promise<FoodRows> {
  const own = getData().clients.find((c) => c.id === clientId)?.coach_id ?? 0;
  const coaches = own !== coachId ? [coachId, own] : [coachId];
  const ids = coachClientIds(coaches);
  const swept = unsweptClients().filter((id) => id !== clientId);
  // A path with no shape reads everything, as coachParts takes it.
  const window: FoodSpan[] = (FOOD_SHAPE[path as keyof typeof FOOD_SHAPE] ?? "all") === "all" ? ["all"] : [{ feedFrom: feedWindow() }];
  return fetchScope(
    path,
    partsScope([
      { ids, spans: window, tables: FEED_LISTS },
      { ids: [clientId], spans: ["all"], tables: SHORTS },
      { ids: swept, spans: ["logged"], tables: FEED_LISTS },
    ]),
    true
  );
}

/** Every client still unopened while the locked app's one-time sweep hasn't run (lib/appLock.ts reads their food). */
function unsweptClients(): number[] {
  const data = getData() as unknown as { app_lock_swept?: string | null; clients: { id: number; app_opened_at?: string | null }[] };
  return data.app_lock_swept ? [] : data.clients.filter((c) => !c.app_opened_at).map((c) => c.id);
}

/** Every list of these coaches' clients and the client in focus, whole (the old admin: its rail, feed and client panels). */
export function fetchCoachClientsFood(coachIds: readonly number[], path: FoodReadPath, focus?: number | null): Promise<FoodRows> {
  const ids = coachClientIds(coachIds);
  if (focus != null) ids.push(focus);
  return fetchScope(path, makeScope([...new Set(ids)], ["all"]), true);
}

/** The coach's food view of the client's coach (an action about one client): that client's window alone (FOOD_SHAPE). */
export function fetchCoachFoodOfClient(clientId: number, path: FoodReadPath): Promise<FoodRows> {
  return fetchCoachFood([getData().clients.find((c) => c.id === clientId)?.coach_id ?? 0], path, clientId);
}

/** Whether these clients logged any food or a figure of their own (lib/appLock.ts): their first entry and own calorie log. */
export function fetchFoodLogged(clientIds: readonly number[], path: FoodReadPath): Promise<FoodRows> {
  return fetchScope(path, partsScope([{ ids: [...new Set(clientIds)], spans: ["logged"], tables: FEED_LISTS }]), false);
}

/** Every client's meal photos and saved meals that may still want a look (the start-up's back-fill, storage.ts, which
 *  filters further): on their partial indexes, never every row. */
export function fetchFoodPictures(path: FoodReadPath): Promise<FoodRows> {
  const scope: Scope = { clients: new Map(), tables: new Set<FoodShort>(["photos", "savedMeals"]), paths: new Set(), nolook: true };
  return fetchScope(path, scope, false);
}

/**
 * These clients' seven lists whole (the export), or every row of the seven tables (the nightly backup, the snapshot:
 * with "all" no client filter, so a row whose client is gone is kept as memory mode's snapshot keeps it). With
 * FOOD_STORE=pg each table is read 2000 rows at a time by id in one snapshot, its statements allowed 60 s, so neither
 * grows into the pool's 5 s statement or 10 s idle limits as the tables grow.
 */
export async function fetchFoodExport(clientIds: readonly number[] | "all", path: FoodReadPath): Promise<FoodRows> {
  if (!FOOD_PG) return fetchScope(path, makeScope(clientIds === "all" ? allClientIdsWithFood() : [...new Set(clientIds)], ["all"]), false);
  noteFoodSeen(path);
  const ids = clientIds === "all" ? null : [...new Set(clientIds)];
  // The meal orders in the same snapshot as the lists (the review's fix, 20 Nov), so the JSON's cards and their places
  // agree: the table's, never the mirror, which lags a commit by a tick.
  const got = await foodRead(async (q) => {
    await q(sql`SET LOCAL statement_timeout = '60s'`);
    await q(sql`SET LOCAL idle_in_transaction_session_timeout = '60s'`);
    return { lists: await loadPaged(q, ids), orders: await readOrders(q, ids) };
  });
  const orders = new Map<number, MealOrderHolder>();
  for (const id of ids ?? getData().clients.map((c) => c.id)) {
    const r = got.orders.get(id);
    orders.set(id, r?.meal_order ? { meal_order: r.meal_order } : {});
  }
  return new FoodRows(MINT, path, listHolder(got.lists), ids ? makeScope(ids, ["all"]) : null, orders);
}
const allClientIdsWithFood = () => getData().clients.map((c) => c.id);
const PAGE = 2000;
/** Each table by id, a page at a time: these clients' rows, or (null) every row. */
async function loadPaged(q: Q, clientIds: readonly number[] | null): Promise<Lists> {
  const out = {} as Record<FoodShort, unknown[]>;
  for (const short of SHORTS) {
    const t = sql.identifier(FOOD_SHORT[short]);
    const decode = decodeOf(FOOD_SHORT[short]);
    const list: unknown[] = [];
    for (let after = 0; ; ) {
      const page = await q(
        clientIds
          ? sql`SELECT * FROM ${t} WHERE id > ${after}::int AND client_id = ANY(${ints(clientIds)}::int[]) ORDER BY id LIMIT ${PAGE}`
          : sql`SELECT * FROM ${t} WHERE id > ${after}::int ORDER BY id LIMIT ${PAGE}`
      );
      for (const r of page) list.push(decode(r));
      if (page.length < PAGE) break;
      after = Number(page[page.length - 1].id);
    }
    out[short] = list;
  }
  return out as unknown as Lists;
}

/**
 * No food at all, for a caller that knows its reader reads none (a link it knows is no food link, a notification's
 * training link): any need of it is a miss, thrown where views are narrow, else said, counted and answered from the store.
 */
export function noFoodRows(path: FoodReadPath): FoodRows {
  const scope = makeScope([], []);
  if (FOOD_PG || MODE === "narrow") return new FoodRows(MINT, path, listHolder({ entries: [], calories: [], days: [], meals: [], savedMeals: [], savedDays: [], photos: [] }), scope);
  return new FoodRows(MINT, path, storeHolder, scope);
}

/** A view of the store whole, for code that runs where no request fetched (a script comparing readers, memory mode). */
export function storeFoodRows(path: FoodReadPath): FoodRows {
  if (FOOD_PG) throw new Error("[food] storeFoodRows with FOOD_STORE=pg: fetch instead");
  return new FoodRows(MINT, path, storeHolder, null);
}

// ---- Writes --------------------------------------------------------------------------------------------------------

/** What a write reads and may change: its client's small lists whole, and of the dated ones these days and meal keys. */
export type FoodReach = {
  span?: FoodSpan | readonly FoodSpan[];
  meals?: readonly string[];
  entryIds?: readonly number[];
  /** Only these lists (every list by default): a write that touches a few reads and locks no more of the client. */
  tables?: readonly FoodShort[];
  /** Day photos by file, whatever their day (a picture's look). */
  paths?: readonly string[];
};

/** A local date (the server's zone, as queries.ts localDateStr), `back` days ago. */
function localDay(back: number): string {
  const d = new Date();
  d.setDate(d.getDate() - back);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** What a coach's thread reads of food (loadMessages): its meal links' days, and with the link targets the last two weeks. */
export function fetchMessagesFood(clientId: number, thread: { rows(clientId: number): readonly { link?: unknown }[] }, path: FoodReadPath, targets = true): Promise<FoodRows> {
  const spans: FoodSpan[] = [foodLinkSpan(thread, clientId)];
  // A day either side of listMessageLinkTargets' window: a superset, whatever the clock says between here and there.
  if (targets) spans.push({ from: localDay(15), to: localDay(-1) });
  return fetchClientFood(clientId, path, spans);
}

/** The days a chat thread's food links name (a meal's link is labelled from its day's meals): the view it needs. */
export function foodLinkSpan(thread: { rows(clientId: number): readonly { link?: unknown }[] }, clientId: number): FoodSpan {
  const dates = new Set<string>();
  for (const m of thread.rows(clientId)) {
    const l = m.link as { kind?: unknown; date?: unknown; meal?: unknown } | null | undefined;
    if (l && l.kind === "food" && l.meal && typeof l.date === "string") dates.add(l.date);
  }
  return { dates: [...dates] };
}

export { OnceAnswered };

const foodLock = (clientId: number) => sql`SELECT pg_advisory_xact_lock(20253, ${clientId}::int)`;

/** The writer's encoding of a row of this table (store.ts recordForWrite), or null when the writer would leave it out. */
function encoded(t: FoodTable, row: unknown): Row | null {
  return recordForWrite(t, row as Row);
}

function changedRows(t: FoodTable, before: readonly { id: number }[], after: readonly { id: number }[]) {
  const was = new Map(before.map((r) => [r.id, JSON.stringify(encoded(t, r))] as const));
  const upserts: Row[] = [];
  const seen = new Set<number>();
  for (const r of after) {
    seen.add(r.id);
    const rec = encoded(t, r);
    if (!rec) throw new Error(`[food] a ${t} row the writer can't encode (id ${String(r.id)})`);
    if (was.get(r.id) !== JSON.stringify(rec)) upserts.push(rec);
  }
  const deletes = before.filter((r) => !seen.has(r.id)).map((r) => r.id);
  return { upserts, deletes };
}

/**
 * A table's columns as this build's schema has them (the store's writer writes exactly these: store.ts columnsOf), each
 * its row field and its column name. Never the database's own list: a column a later build added keeps what it holds
 * on an update and its default on an insert, as the store's writer leaves it, never set to NULL by a rolled-back build.
 */
const COLUMNS = new Map<string, { field: string; name: string }[]>();
function schemaColumns(name: string, table: PgTable): { field: string; name: string }[] {
  let cols = COLUMNS.get(name);
  if (!cols) {
    cols = Object.entries(getTableColumns(table) as Record<string, Column>).map(([field, c]) => ({ field, name: c.name }));
    COLUMNS.set(name, cols);
  }
  return cols;
}
/** A record (by field) as jsonb_populate_recordset reads it (by column name), only the schema's columns. */
function byColumnName(rec: Row, cols: readonly { field: string; name: string }[]): Row {
  const out: Row = {};
  for (const c of cols) if (c.field in rec) out[c.name] = rec[c.field];
  return out;
}
const quoted = (n: string) => `"${n.replace(/"/g, '""')}"`;

async function writeRows(q: Q, t: FoodTable, clientId: number, upserts: Row[], deletes: number[]) {
  const table = sql.identifier(t);
  if (deletes.length) await q(sql`DELETE FROM ${table} WHERE client_id = ${clientId}::int AND id = ANY(${ints(deletes)}::int[])`);
  if (!upserts.length) return;
  const cols = schemaColumns(t, TABLE_OF[t]);
  const list = sql.raw(cols.map((c) => quoted(c.name)).join(", "));
  const set = sql.raw(cols.filter((c) => c.name !== "id").map((c) => `${quoted(c.name)} = EXCLUDED.${quoted(c.name)}`).join(", "));
  for (let i = 0; i < upserts.length; i += 500) {
    const slice = upserts.slice(i, i + 500);
    const batch = JSON.stringify(slice.map((r) => byColumnName(r, cols)));
    // A row is only ever rewritten by its own client's: an id held by another client's row (a counter run back, two
    // writers overlapping in a rollback) fails the write whole instead of rewriting that client's row.
    const done = await q(
      sql`INSERT INTO ${table} (${list}) SELECT ${list} FROM jsonb_populate_recordset(NULL::${table}, ${batch}::jsonb) ON CONFLICT (id) DO UPDATE SET ${set} WHERE ${table}.client_id IS NOT DISTINCT FROM EXCLUDED.client_id RETURNING id`
    );
    if (done.length !== slice.length) throw new Error(`${t}: ${slice.length - done.length} row(s) whose id another client's row holds; nothing written`);
  }
}

/**
 * A once key as the store's writer writes it (once_keys, keyed by `key`): claimed (nothing written when it is there
 * already; true when this write took it), or kept with its answer.
 */
async function writeOnceKey(q: Q, row: { key: string; at: number; result?: unknown }, mode: "claim" | "keep"): Promise<boolean> {
  const rec = recordForWrite("once_keys", row as unknown as Row);
  if (!rec) throw new Error("[food] a once key the writer can't encode");
  const cols = schemaColumns("once_keys", once_keys);
  const list = sql.raw(cols.map((c) => quoted(c.name)).join(", "));
  const set = sql.raw(cols.filter((c) => c.name !== "key").map((c) => `${quoted(c.name)} = EXCLUDED.${quoted(c.name)}`).join(", "));
  const rows = await q(
    sql`INSERT INTO once_keys (${list}) SELECT ${list} FROM jsonb_populate_recordset(NULL::once_keys, ${JSON.stringify([byColumnName(rec, cols)])}::jsonb) ${mode === "claim" ? sql`ON CONFLICT (key) DO NOTHING` : sql`ON CONFLICT (key) DO UPDATE SET ${set}`} RETURNING key`
  );
  return rows.length > 0;
}

/** A client's meal order into food_meal_orders, in the write's transaction, when the code changed it (none: no row). */
async function writeOrder(q: Q, clientId: number, was: OrderRow | null, now: string[] | null) {
  if (orderKey(now) === orderKey(was?.meal_order)) return;
  if (now == null) {
    await q(sql`DELETE FROM food_meal_orders WHERE client_id = ${clientId}::int`);
    return;
  }
  await q(sql`INSERT INTO food_meal_orders (client_id, meal_order, updated_at) VALUES (${clientId}::int, ${JSON.stringify(now)}::jsonb, now())
    ON CONFLICT (client_id) DO UPDATE SET meal_order = EXCLUDED.meal_order, updated_at = EXCLUDED.updated_at`);
}

/** A refusal is answered, not kept (once.ts refused, the same three lines: food/ can't import once.ts, which imports it). */
function refusedAnswer(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const r = result as { ok?: unknown; error?: unknown };
  return r.ok === false || (typeof r.error === "string" && r.error.length > 0);
}

/**
 * Of these files, those no row of any client shows any more (dropUnusedMealPictures in SQL). Day photos and saved meals
 * by their indexes (meal_photos_path_idx, saved_meals_picture_idx); saved days, which have no index on their pictures,
 * by the files' own client when every file is in that client's folder (/uploads/meals/<client>/: where every meal
 * picture is made, the preflight's P6 counting any that isn't), else every client's as before.
 */
async function unusedPictures(q: Q, paths: readonly string[], clientId: number): Promise<string[]> {
  if (!paths.length) return [];
  const own = paths.every((p) => p.startsWith(`/uploads/meals/${clientId}/`));
  const whose = own ? sql`client_id = ${clientId}::int AND ` : sql``;
  const rows = await q(sql`SELECT p FROM jsonb_array_elements_text(${textJson(paths)}::jsonb) AS p
    WHERE NOT EXISTS (SELECT 1 FROM meal_photos WHERE file_path = p)
      AND NOT EXISTS (SELECT 1 FROM saved_meals WHERE extra->>'picture' = p)
      AND NOT EXISTS (SELECT 1 FROM saved_days WHERE ${whose}(extra->>'picture' = p OR extra->'cards' @> jsonb_build_array(jsonb_build_object('picture', p))))`);
  const gone = new Set(rows.map((r) => String(r.p)));
  return paths.filter((p) => gone.has(p));
}

/**
 * One write of a client's food. Memory: `body` runs on the store, today's code exactly (it saves and cleans up as it
 * always did), and its answer comes back. Postgres: one transaction under the client's lock: the once key claimed (a key
 * taken already throws OnceAnswered, which once() answers), the reach loaded, `body` run on it, the rows it changed
 * written, the files nothing shows found, the answer kept with the key; after the commit the meal order goes onto the
 * client in memory and the files to the trash.
 */
export async function writeFood<T>(path: FoodWritePath, clientId: number, reach: FoodReach, body: (box: FoodBox) => T, opts: { once?: string | null } = {}): Promise<T> {
  noteFoodWrite(path);
  if (!FOOD_PG) return body(storeBox(path));
  const spans = reach.span == null ? [] : Array.isArray(reach.span) ? (reach.span as FoodSpan[]) : [reach.span as FoodSpan];
  const scope = makeScope([clientId], spans, reach.tables ?? SHORTS, reach.meals ?? [], reach.entryIds ?? []);
  for (const p of reach.paths ?? []) scope.paths.add(p);
  const orders = new Map<number, MealOrderHolder>();
  const asked: string[] = [];
  const gone: string[][] = [];
  let answer: T | undefined;
  let found: string[] = [];
  // What the code itself threw (its own error, or OnceAnswered): handed on as it is, never as a database error.
  let inner: { error: unknown } | null = null;
  try {
  await foodWriteRaw(`food:${clientId}`, {
    op: path,
    run: async (_q, inTx) =>
      inTx(async (q) => {
        inner = null;
        asked.length = 0;
        gone.length = 0;
        orders.clear();
        await q(foodLock(clientId));
        // A client erased meanwhile (removeClient: a write queued on this chain behind its DELETE) writes nothing: no
        // row of a client no longer here is ever made.
        if (!getData().clients.some((c) => c.id === clientId)) {
          const error = new Error(`[food] client ${clientId} is gone; nothing written`);
          inner = { error };
          throw error;
        }
        const at = Date.now();
        if (opts.once && !(await writeOnceKey(q, { key: opts.once, at }, "claim"))) {
          const held = (await q(sql`SELECT * FROM once_keys WHERE key = ${opts.once}::text`))[0];
          const row = (held ? fromRecord(once_keys, held) : { key: opts.once, at }) as { key: string; at: number; result?: unknown; redirect?: string };
          const error = new OnceAnswered(row);
          inner = { error };
          throw error;
        }
        // The client's meal order as the table holds it, under the lock: the box's copy, never the mirror in memory.
        const orderRow = (await readOrders(q, [clientId])).get(clientId) ?? null;
        orders.set(clientId, orderRow?.meal_order ? { meal_order: [...orderRow.meal_order] } : {});
        const before = await loadScope(q, scope);
        const lists = Object.fromEntries(SHORTS.map((s) => [s, [...(before[s] as unknown[]).map((r) => structuredClone(r))]])) as unknown as Lists;
        const box = new FoodBox(MINT, path, listHolder(lists), scope, orders, () => {}, (paths) => {
          const out: string[] = [];
          for (const p of paths) if (p) asked.push(p);
          gone.push(out);
          return out;
        });
        try {
          answer = body(box);
        } catch (error) {
          inner = { error };
          throw error;
        }
        for (const s of SHORTS) {
          const t = FOOD_SHORT[s];
          const { upserts, deletes } = changedRows(t, before[s] as { id: number }[], lists[s] as { id: number }[]);
          await writeRows(q, t, clientId, upserts, deletes);
        }
        // The meal order in the same transaction as the food it orders, only when the code changed it.
        await writeOrder(q, clientId, orderRow, orders.get(clientId)?.meal_order ?? null);
        found = await unusedPictures(q, [...new Set(asked)], clientId);
        // A refusal is answered, not kept (once.ts): its claim given back in the same transaction, so sent again it runs again.
        if (opts.once && refusedAnswer(answer)) await q(sql`DELETE FROM once_keys WHERE key = ${opts.once}::text`);
        else if (opts.once) {
          let stored: unknown;
          try {
            stored = answer === undefined ? undefined : JSON.parse(JSON.stringify(answer));
          } catch {
            stored = undefined;
          }
          await writeOnceKey(q, { key: opts.once, at, ...(stored === undefined ? {} : { result: stored }) }, "keep");
        }
        // Tests alone (food/pg.ts faultBeforeCommit): every statement sent, the commit not yet.
        throwIfFaultBeforeCommit(path);
        return answer;
      }),
  });
  } catch (error) {
    // Rolled back whole. The code's own error as it threw it (memory mode's), else the database's (made safe, pg.ts).
    const thrown = inner as { error: unknown } | null;
    // Or not: a lost connection may have come after the commit, its meal order in the table and not on the mirror.
    if (!thrown && lostConnection(error)) resyncOrder(clientId);
    throw thrown ? thrown.error : error;
  }
  // The files nothing shows, into every list the code was handed back (its answer holds them).
  for (const list of gone) list.push(...found.filter((p) => !list.includes(p)));
  // The meal order committed with the food (food_meal_orders, the truth); its mirror onto the client in memory, and the
  // store saved, only where it differs (most writes change nothing; one finding the mirror behind puts it right), so a
  // rollback to memory mode, or a build before this one, still reads a card's place. A crash before that save loses
  // nothing: the next pg boot puts the table's order back on the client, the mirror's stamp (saved with it) saying it
  // was this build's (food/orders.ts).
  let reordered = false;
  for (const [id, o] of orders) {
    const c = getData().clients.find((x) => x.id === id);
    if (!c) continue;
    if (JSON.stringify(c.meal_order ?? null) !== JSON.stringify(o.meal_order ?? null)) {
      if (o.meal_order) c.meal_order = o.meal_order;
      else delete c.meal_order;
      reordered = true;
    }
    if (stampClient(getData(), c)) reordered = true;
  }
  if (reordered) {
    orderMoved();
    persist();
  }
  for (const p of found) trashFile(nodePath.join(DATA_DIR, p.startsWith("/") ? p.slice(1) : p));
  return answer as T;
}

/** Every row of a client's food, deleted (the erase, before memory's own): one transaction, or the store's lists in memory. */
export async function deleteClientFood(clientId: number, p: FoodWritePath = "w.client.delete"): Promise<void> {
  noteFoodWrite(p);
  if (!FOOD_PG) return;
  await foodWriteRaw(`food:${clientId}`, {
    op: p,
    run: async (_q, inTx) =>
      inTx(async (q) => {
        await q(sql`SET LOCAL statement_timeout = '60s'`);
        await q(foodLock(clientId));
        for (const t of FOOD_TABLES) await q(sql`DELETE FROM ${sql.identifier(t)} WHERE client_id = ${clientId}::int`);
        // Their meal order with them (the client row's mirror goes with the client in memory).
        await q(sql`DELETE FROM food_meal_orders WHERE client_id = ${clientId}::int`);
      }),
  });
  // And its stamp (the review's fix, 20 Nov): nothing of their order is left in kv either, saved by the erase's save.
  dropStamps([clientId]);
}

/** These clients' stamps out of kv in memory (every one: null); saved by the caller's save. */
function dropStamps(clientIds: readonly number[] | null) {
  // chat-door: notes-door: one kv key by its own name (the stamps), never a walk of the store.
  const d = getData() as unknown as Record<string, unknown>;
  if (!(FOOD_ORDER_STAMPS in d)) return;
  if (!clientIds) {
    d[FOOD_ORDER_STAMPS] = {};
    return;
  }
  const stamps = stampsOf(d);
  if (!clientIds.some((id) => String(id) in stamps)) return;
  const next = { ...stamps };
  for (const id of clientIds) delete next[String(id)];
  d[FOOD_ORDER_STAMPS] = next;
}

/**
 * After a write whose commit's answer was lost (it may have committed: the review's fix, 20 Nov): the client's mirror
 * read back from food_meal_orders, on the client's chain after it, so a clean stop then saves it and a rollback straight
 * to d100513 reads it. A client with no row keeps its mirror (orders.ts reconcileOrders' rule). The database still
 * away: nothing, this build's next boot puts it right. Never throws.
 */
function resyncOrder(clientId: number) {
  void foodWriteRaw(`food:${clientId}`, {
    op: "w.orderResync",
    run: async (q) => {
      const row = (await readOrders(q, [clientId])).get(clientId);
      const c = getData().clients.find((x) => x.id === clientId);
      if (!c || !row) return;
      let moved = putOnClient(c, row.meal_order);
      if (stampClient(getData(), c)) moved = true;
      if (!moved) return;
      orderMoved();
      persist();
    },
  }).catch(() => {});
}

/**
 * Every day's photo row, gone (the workspace reset): the store's list emptied, or the table. With FOOD_STORE=pg every
 * meal order too, in the same transaction: the reset takes every client, and their orders' mirrors with them.
 */
export async function wipeFoodPhotos(): Promise<void> {
  noteFoodWrite("w.wipePhotos");
  if (!FOOD_PG) {
    storeHolder.set("photos", []);
    return;
  }
  // Every write still on a client's chain settled first, so a photo saved while the reset ran never lands after its DELETE.
  await foodChainsSettled();
  await foodWriteRaw(null, {
    op: "w.wipePhotos",
    run: async (_q, inTx) =>
      inTx(async (q) => {
        await q(sql`DELETE FROM meal_photos`);
        await q(sql`DELETE FROM food_meal_orders`);
      }),
  });
  dropStamps(null);
}

/**
 * A picture's tiny preview, onto every day's photo, saved meal and saved day showing that file (setChatMediaLook's food
 * half). How many rows took it. Memory: the store's rows changed in place, saved by the caller.
 */
export async function setFoodLook(file: string, thumb: string | null): Promise<number> {
  noteFoodWrite("w.look");
  const apply = (lists: Pick<Lists, "photos" | "savedMeals" | "savedDays">) => {
    let n = 0;
    for (const p of lists.photos) {
      if (p.file_path !== file) continue;
      p.thumb = thumb;
      n++;
    }
    for (const s of lists.savedMeals) {
      if (s.picture !== file) continue;
      s.picture_thumb = thumb;
      n++;
    }
    for (const d of lists.savedDays) {
      if (d.picture === file) {
        d.picture_thumb = thumb;
        n++;
      }
      for (const c of d.cards ?? []) {
        if (c.picture !== file) continue;
        c.picture_thumb = thumb;
        n++;
      }
    }
    return n;
  };
  if (!FOOD_PG) {
    return apply({ photos: storeHolder.get("photos") as MealPhoto[], savedMeals: storeHolder.get("savedMeals") as SavedMeal[], savedDays: storeHolder.get("savedDays") as SavedDay[] });
  }
  // The file's own client, from its path (/uploads/meals/<client>/…); the rows showing it are that client's. Only the
  // three lists a picture is on, the day photos by the file itself (whatever their day): never the client's whole diary.
  const m = /^\/uploads\/meals\/(\d+)\//.exec(file);
  if (!m) return 0;
  const clientId = Number(m[1]);
  if (!getData().clients.some((c) => c.id === clientId)) return 0;
  return writeFood("w.look", clientId, { tables: ["photos", "savedMeals", "savedDays"], paths: [file] }, (box) => apply(box));
}

// ---- Whole-store copies --------------------------------------------------------------------------------------------

/** The seven lists of these rows, under the store's own names (the export, the backup's JSON, the snapshot). */
export function foodKeysOf(rows: FoodRows): Record<FoodTable, unknown[]> {
  return Object.fromEntries(SHORTS.map((s) => [FOOD_SHORT[s], [...(rows as unknown as Record<FoodShort, unknown[]>)[s]]])) as Record<FoodTable, unknown[]>;
}

/** Where each food key sits among the store's keys (db.ts emptyData's order): after this one. */
const FOOD_KEY_AFTER: Record<FoodTable, string> = {
  calorie_logs: "event_categories",
  food_entries: "calorie_logs",
  food_meals: "custom_foods",
  food_days: "food_meals",
  saved_meals: "food_days",
  saved_days: "off_foods",
  meal_photos: "photo_period_notes",
};

/**
 * A whole-store copy with the seven food keys in their places (the export, the backup's JSON, the shutdown dump). In
 * memory mode the store holds them already: the same object back, so nothing changes. With FOOD_STORE=pg they are put
 * where the store would hold them, from these rows, and `_food_in_postgres` says so, so a build that doesn't know refuses it.
 */
export function withFoodKeys<T extends Record<string, unknown>>(data: T, rows: FoodRows | null): T {
  if (!FOOD_PG) return data;
  const lists = rows ? foodKeysOf(rows) : null;
  const out: Record<string, unknown> = {};
  const pending = new Map<string, FoodTable[]>();
  for (const t of FOOD_TABLES) pending.set(FOOD_KEY_AFTER[t], [...(pending.get(FOOD_KEY_AFTER[t]) ?? []), t]);
  const placed = new Set<string>();
  const place = (key: string) => {
    for (const t of pending.get(key) ?? []) {
      if (placed.has(t)) continue;
      placed.add(t);
      out[t] = lists ? lists[t] : [];
      place(t);
    }
  };
  // chat-door: notes-door: a copy of the keys as they are handed in (the chat's and the notes' already put in place by
  // withChatKey and withNotesKey); only the food keys are added here.
  for (const [k, v] of Object.entries(data)) {
    if ((FOOD_TABLES as readonly string[]).includes(k)) continue;
    // The stamps of the mirrors stay with this database (food/orders.ts): a JSON imported into a fresh one never reads them.
    if (k === FOOD_ORDER_STAMPS) continue;
    // Each client's meal order as food_meal_orders held it in the lists' snapshot (a client with no row keeps its mirror).
    out[k] = k === "clients" && rows && Array.isArray(v) ? v.map((c) => withTableOrder(c, rows)) : v;
    place(k);
  }
  for (const t of FOOD_TABLES) if (!placed.has(t)) out[t] = lists ? lists[t] : [];
  if (!lists) out._food_in_postgres = true;
  return out as T;
}

/** A client row as the JSON carries it: its meal order the table's when the export read one for it, else as it is. */
function withTableOrder(c: unknown, rows: FoodRows): unknown {
  const id = (c as { id?: unknown } | null)?.id;
  if (typeof id !== "number") return c;
  const order = rows.tableOrder(id);
  if (!order || orderKey(order) === orderKey((c as MealOrderHolder).meal_order)) return c;
  return { ...(c as object), meal_order: order };
}

/** For /api/timing. */
export function foodStoreReport() {
  return { pg: FOOD_PG, views: MODE, strict: STRICT };
}

export type { Q, Row };
