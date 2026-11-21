// The food diary's shadow week (quest 8 part 1), on the notes' pattern (app/lib/notes/shadow.ts; its file untouched):
// beside the door's fetches, the SQL that will replace them (rows.ts scopeSql, the same the cut-over runs) runs against
// Postgres and every difference is counted and logged with ids and field names, never words or food names.
//
//   FOOD_SHADOW=off       (the default) no query runs; the door still counts each path it is asked through.
//   FOOD_SHADOW=baseline  as off, and the totals kept (below): the week before, for the writer's times.
//   FOOD_SHADOW=read      a sample of the fetches (each path's first 3, then 1 in FOOD_SHADOW_SAMPLE, 20 by default;
//                         FOOD_SHADOW_RATE a second, 2 by default; FOOD_SHADOW_QUEUE waiting at most, 32; a path never
//                         compared yet is never dropped) also runs its scope's SQL, compared table by table with what
//                         the last save committed (the writer's snapshot, never live memory), cut to the same scope:
//                         decoded once per save and grouped by client, a scope over FOOD_SHADOW_CAP rows (20000) of a
//                         table skipped and counted; a sample's ms its SQL, decode and compare together.
//   FOOD_SHADOW=write     as read (the write shadow on *_shadow tables is not built yet: docs/database-plan.md).
//   FOOD_STORE=pg         runs as baseline (nothing in memory to compare with).
//
// Never on a request's path: a fetch only counts and queues (no await, no throw, try/catch round all of it); the queue
// drains behind the answer one job at a time, on a pool of 2 (Postgres, 3 s statement timeout) or, on pglite, the
// store's own database. 50 errors in 10 minutes pause it for 10. Every 10 minutes (baseline, read) the totals are kept
// in kv as `food_shadow_totals`, FOOD_SHADOW_WEEK (a label) starting them afresh. On /api/timing under `food`.

import type { SQL } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { getData, persist } from "../db";
import { FOOD_PG, type FoodTable } from "./mode";
import { FOOD_PATHS_BY_HAND, FOOD_PATHS_OUTSIDE_WEEK, FOOD_READ_PATHS, FOOD_WRITE_PATHS, type FoodPath, type FoodReadPath, type FoodWritePath } from "./paths";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyDb = PgDatabase<any, any, any>;
type Row = Record<string, unknown>;
export type ShadowWriter = { readonly generation: number; readonly saving: boolean; committed(name: string): ReadonlyMap<string, string> | undefined };

const ASKED = (process.env.FOOD_SHADOW ?? "").trim() || "off";
const KNOWN = ["off", "baseline", "read", "write"];
const MODE: "off" | "baseline" | "read" = !KNOWN.includes(ASKED) ? "off" : FOOD_PG ? (ASKED === "off" ? "off" : "baseline") : ASKED === "write" ? "read" : (ASKED as "off" | "baseline" | "read");
const SAMPLE = Math.max(1, Number(process.env.FOOD_SHADOW_SAMPLE) || 20);
const RATE = Math.max(1, Number(process.env.FOOD_SHADOW_RATE) || 2);
const QUEUE = Math.max(1, Number(process.env.FOOD_SHADOW_QUEUE) || 32);
const WEEK = (process.env.FOOD_SHADOW_WEEK ?? "").trim() || "1";
const ROUND_MS = 10 * 60_000;
/** A sample whose scope holds more committed rows than this in one table is skipped and counted, never compared. */
const CAP = Math.max(1000, Number(process.env.FOOD_SHADOW_CAP) || 20_000);

type QCount = { sampled: number; matched: number; differed: number; raced: number; errored: number; dropped: number; skipped: number; msTotal: number; msMax: number };
type Job = { first: boolean; run: () => Promise<void> };
type State = {
  db: AnyDb | null;
  writer: ShadowWriter | null;
  seen: Record<string, number>;
  missed: Record<string, number>;
  writes: Record<string, number>;
  queries: Record<string, QCount>;
  queue: Job[];
  busy: boolean;
  tokens: number;
  tokensAt: number;
  errors: number[];
  pausedUntil: number;
  said: Set<string>;
  /** FOOD_STORE=pg: the meal orders' mirror checked on each fetch that read them (noteFoodOrders). */
  orders?: { reads: number; compared: number; drifted: number; raced: number };
};
const g = globalThis as unknown as { __norcoachFoodShadow?: State };
const state = (): State =>
  (g.__norcoachFoodShadow ??= { db: null, writer: null, seen: {}, missed: {}, writes: {}, queries: {}, queue: [], busy: false, tokens: RATE, tokensAt: Date.now(), errors: [], pausedUntil: 0, said: new Set() });
const qc = (key: string) => (state().queries[key] ??= { sampled: 0, matched: 0, differed: 0, raced: 0, errored: 0, dropped: 0, skipped: 0, msTotal: 0, msMax: 0 });
const tried = new Set<string>();

function quietly(fn: () => void) {
  try {
    fn();
  } catch {
    /* never into a request */
  }
}
function say(key: string, message: string) {
  const s = state();
  if (s.said.has(key)) return;
  s.said.add(key);
  console.warn(`[food-shadow] ${message}`);
}
const safe = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\nparams:")[0].replace(/"(?:[^"\\]|\\.)*"/g, '"…"').replace(/'(?:[^'\\]|\\.)*'/g, "'…'").slice(0, 200);

export function noteFoodSeen(path: FoodPath) {
  quietly(() => {
    const s = state();
    s.seen[path] = (s.seen[path] ?? 0) + 1;
  });
}
export function noteFoodMissed(path: FoodPath, message: string) {
  quietly(() => {
    const s = state();
    s.missed[path] = (s.missed[path] ?? 0) + 1;
    say(`miss:${message}`, message);
  });
}
/**
 * FOOD_STORE=pg: a fetch's meal orders (read from food_meal_orders in its snapshot) against their mirror on the client
 * rows in memory (rows.ts checkMirror), whatever FOOD_SHADOW says: no SQL, counts alone. A drift is said once a path.
 */
export function noteFoodOrders(path: FoodReadPath, n: { compared: number; drifted: number; raced: number }) {
  quietly(() => {
    const s = state();
    const o = (s.orders ??= { reads: 0, compared: 0, drifted: 0, raced: 0 });
    o.reads++;
    o.compared += n.compared;
    o.drifted += n.drifted;
    o.raced += n.raced;
    if (n.drifted) say(`drift:${path}`, `${path}: ${n.drifted} meal order(s) in memory differ from food_meal_orders (the mirror a rollback reads)`);
  });
}
export function noteFoodWrite(path: FoodWritePath) {
  quietly(() => {
    const s = state();
    s.writes[path] = (s.writes[path] ?? 0) + 1;
  });
}

function errored() {
  const s = state();
  const now = Date.now();
  s.errors = [...s.errors.filter((t) => now - t < 10 * 60_000), now];
  if (s.errors.length >= 50) {
    s.pausedUntil = now + 10 * 60_000;
    s.errors = [];
    say(`pause:${now}`, "50 errors in 10 minutes: paused for 10");
  }
}
function take(first: boolean): boolean {
  const s = state();
  const now = Date.now();
  if (now < s.pausedUntil) return false;
  s.tokens = Math.min(RATE, s.tokens + ((now - s.tokensAt) / 1000) * RATE);
  s.tokensAt = now;
  if (s.queue.length >= QUEUE && !first) return false;
  if (s.tokens < 1 && !first) return false;
  s.tokens = Math.max(0, s.tokens - 1);
  return true;
}
function push(job: Job) {
  const s = state();
  s.queue.push(job);
  if (!s.busy) void drain();
}
async function drain() {
  const s = state();
  s.busy = true;
  try {
    while (s.queue.length) {
      const job = s.queue.shift()!;
      try {
        await job.run();
      } catch {
        errored();
      }
      // A breath between samples, so a burst never holds the event loop from one to the next.
      await new Promise((r) => setImmediate(r));
    }
  } finally {
    s.busy = false;
  }
}

/** Canonical JSON: keys sorted, so two encodings of one row compare equal. */
export function stableJson(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  return `{${Object.keys(v as Row)
    .filter((k) => (v as Row)[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson((v as Row)[k])}`)
    .join(",")}}`;
}

/**
 * A fetch to compare: `sqlRows` reads the scope from Postgres (the cut-over's own statements), `committedRows` cuts what
 * the last save committed to the same scope. Both by table, each list by id.
 */
export type FoodShadowFetch = {
  tables: readonly FoodTable[];
  sqlRows: (q: (query: SQL) => Promise<Row[]>) => Promise<Record<string, Row[]>>;
  committedIn: (table: FoodTable, row: Row) => boolean;
  decode: (table: FoodTable, record: Row) => Row;
  /** The scope's clients: only their committed rows are looked at, unless `anyClient` (photos by file, any client). */
  clients: readonly number[];
  anyClient: (table: FoodTable) => boolean;
  /**
   * The scope's meal orders (a fetch with the meal lists): `sqlRows` the clients table's (what a pg boot seeds
   * food_meal_orders from), `committedRows` what the last save committed of the clients, both `{ client_id, meal_order }`.
   */
  orders?: { sqlRows: (q: (query: SQL) => Promise<Row[]>) => Promise<Row[]>; committedRows: (committed: ReadonlyMap<string, string>) => Row[] };
};

/**
 * What the last save committed of a table, decoded once per save (the writer's generation and its map), grouped by
 * client: a sample's work on the main thread grows with its scope, never with the whole table (notes/shadow.ts's way).
 */
const decodedOf = new Map<string, { gen: number; map: ReadonlyMap<string, string>; all: Row[]; byClient: Map<number, Row[]> }>();
function committedOf(t: FoodTable, decode: (table: FoodTable, record: Row) => Row) {
  const w = state().writer;
  const m = w?.committed(t);
  if (!w || !m) return null;
  const was = decodedOf.get(t);
  if (was && was.gen === w.generation && was.map === m) return was;
  const all: Row[] = [];
  const byClient = new Map<number, Row[]>();
  for (const json of m.values()) {
    if (!json) continue;
    const row = decode(t, JSON.parse(json) as Row);
    all.push(row);
    const c = Number(row.client_id);
    const list = byClient.get(c);
    if (list) list.push(row);
    else byClient.set(c, [row]);
  }
  const got = { gen: w.generation, map: m, all, byClient };
  decodedOf.set(t, got);
  return got;
}

export function onFoodFetch(path: FoodReadPath, f: FoodShadowFetch) {
  quietly(() => {
    if (MODE !== "read") return;
    const s = state();
    if (!s.db || !s.writer) return;
    const key = `${path}:scope`;
    const c = qc(key);
    const first = !tried.has(key);
    if (!(first || c.sampled < 3 || Math.random() < 1 / SAMPLE)) return;
    if (!take(first)) {
      c.dropped++;
      return;
    }
    tried.add(key);
    push({ first, run: () => readJob(f, key) });
  });
}

async function readJob(f: FoodShadowFetch, key: string, again = false): Promise<void> {
  const s = state();
  const c = qc(key);
  const gen = s.writer!.generation;
  const t0 = performance.now();
  let got: Record<string, Row[]>;
  let orders: Row[] | null = null;
  try {
    const run = async (query: SQL) => ((await s.db!.execute(query)) as { rows?: Row[] }).rows ?? [];
    got = await f.sqlRows(run);
    if (f.orders) orders = await f.orders.sqlRows(run);
  } catch (error) {
    c.errored++;
    errored();
    say(`qerr:${key}`, `${key} failed: ${safe(error)}`);
    return;
  }
  if (s.writer!.generation !== gen || s.writer!.saving) {
    if (!again) return readJob(f, key, true);
    c.raced++;
    return;
  }
  const differs: string[] = [];
  for (const t of f.tables) {
    const committed = committedOf(t, f.decode);
    const want: Row[] = [];
    const candidates = !committed ? [] : f.anyClient(t) ? committed.all : f.clients.flatMap((id) => committed.byClient.get(id) ?? []);
    if (candidates.length > CAP) {
      c.skipped++;
      return;
    }
    for (const row of candidates) if (f.committedIn(t, row)) want.push(row);
    want.sort((a, b) => Number(a.id) - Number(b.id));
    const have = got[t] ?? [];
    if (stableJson(have) !== stableJson(want)) {
      const ids = new Set(want.map((r) => r.id));
      const hids = new Set(have.map((r) => r.id));
      // A row in both that differs: its id and the names of the fields that differ (never their values).
      const byId = new Map(have.map((r) => [r.id, r] as const));
      const changed: string[] = [];
      for (const w of want) {
        const h = byId.get(w.id);
        if (!h || stableJson(h) === stableJson(w)) continue;
        const fields = [...new Set([...Object.keys(w), ...Object.keys(h)])].filter((k) => stableJson(w[k]) !== stableJson(h[k]));
        changed.push(`${String(w.id)}(${fields.join(",")})`);
      }
      differs.push(`${t}: missing ${want.filter((r) => !hids.has(r.id)).length}, extra ${have.filter((r) => !ids.has(r.id)).length}, changed ${changed.length}${changed.length ? ` [${changed.slice(0, 5).join(" ")}]` : ""}`);
    }
  }
  // The meal orders: the client ids that differ, never an order.
  if (f.orders && orders) {
    const committed = s.writer!.committed("clients");
    const want = committed ? f.orders.committedRows(committed) : [];
    const key = (list: Row[]) => new Map(list.map((r) => [Number(r.client_id), stableJson(r.meal_order)] as const));
    const w = key(want);
    const h = key(orders);
    const off = [...new Set([...w.keys(), ...h.keys()])].filter((id) => w.get(id) !== h.get(id)).sort((a, b) => a - b);
    if (off.length) differs.push(`meal orders: ${off.length} client(s) differ [${off.slice(0, 5).join(" ")}]`);
  }
  // The SQL, the decode and the compare: the whole of a sample's cost, main thread included.
  const ms = performance.now() - t0;
  c.sampled++;
  c.msTotal += ms;
  c.msMax = Math.max(c.msMax, ms);
  if (!differs.length) c.matched++;
  else {
    c.differed++;
    say(`diff:${key}`, `${key} differs (${differs.join("; ")})`);
  }
}

// ---- Boot, totals, report -------------------------------------------------------------------------------------------

export async function startFoodShadow(opts: { db: AnyDb; url: string; writer: ShadowWriter }): Promise<void> {
  const s = state();
  s.writer = opts.writer;
  if (!KNOWN.includes(ASKED)) console.error(`[food-shadow] FOOD_SHADOW=${ASKED} is not off, baseline, read or write: off`);
  if (ASKED === "write" && !FOOD_PG) console.log("[food-shadow] write: the write shadow is not built yet, runs as read");
  if (MODE === "read") {
    if (opts.url.startsWith("pglite:")) s.db = opts.db;
    else {
      const { Pool } = await import("pg");
      const { drizzle } = await import("drizzle-orm/node-postgres");
      const pool = new Pool({ connectionString: opts.url, max: 2, application_name: "norcoach-food-shadow", options: "-c statement_timeout=3000" });
      pool.on("error", () => {});
      s.db = drizzle(pool) as unknown as AnyDb;
    }
    console.log(`[food-shadow] read: 1 in ${SAMPLE}, ${RATE}/s, queue ${QUEUE}`);
  }
  if (MODE !== "off") setInterval(() => quietly(keepTotals), ROUND_MS).unref?.();
}

type Totals = { week: string; since: string; queries: Record<string, QCount>; seen: Record<string, number>; missed: Record<string, number>; writes: Record<string, number> };
let base: Totals | null = null;
function baseTotals(): Totals {
  if (base) return base;
  const stored = (getData() as unknown as { food_shadow_totals?: Totals }).food_shadow_totals;
  base = stored && stored.week === WEEK ? structuredClone(stored) : { week: WEEK, since: new Date().toISOString(), queries: {}, seen: {}, missed: {}, writes: {} };
  return base;
}
const addN = (a: Record<string, number>, b: Record<string, number>) => {
  const out = { ...a };
  for (const [k, n] of Object.entries(b)) out[k] = (out[k] ?? 0) + n;
  return out;
};
function totalsNow(): Totals {
  const s = state();
  const b = baseTotals();
  const queries: Record<string, QCount> = structuredClone(b.queries);
  for (const [k, v] of Object.entries(s.queries)) {
    const o = (queries[k] ??= { sampled: 0, matched: 0, differed: 0, raced: 0, errored: 0, dropped: 0, skipped: 0, msTotal: 0, msMax: 0 });
    for (const [f, n] of Object.entries(v)) (o as unknown as Record<string, number>)[f] = f === "msMax" ? Math.max((o as unknown as Record<string, number>)[f], n) : (o as unknown as Record<string, number>)[f] + n;
  }
  return { week: WEEK, since: b.since, queries, seen: addN(b.seen, s.seen), missed: addN(b.missed, s.missed), writes: addN(b.writes, s.writes) };
}
/** Every 10 minutes: the week's totals so far into kv (counts and names only). */
export function keepTotals() {
  if (MODE === "off") return;
  (getData() as unknown as { food_shadow_totals?: Totals }).food_shadow_totals = totalsNow();
  persist();
}

/** For /api/timing: counts and names, never ids or words. */
export function foodShadowReport(extra: Record<string, unknown> = {}) {
  const s = state();
  const total = MODE === "off" ? null : totalsNow();
  const reads = total ?? { queries: s.queries, seen: s.seen, missed: s.missed, writes: s.writes };
  const matchedPaths = new Set(Object.entries(reads.queries).filter(([, c]) => c.matched > 0).map(([k]) => k.split(":")[0]));
  return {
    mode: MODE,
    asked: ASKED,
    week: WEEK,
    paths: Object.fromEntries([...FOOD_READ_PATHS, ...FOOD_WRITE_PATHS].map((p) => [p, { seen: s.seen[p] ?? 0, missed: s.missed[p] ?? 0, writes: s.writes[p] ?? 0 }])),
    queries: s.queries,
    orders: s.orders ?? null,
    queue: s.queue.length,
    pausedUntil: s.pausedUntil ? new Date(s.pausedUntil).toISOString() : null,
    total: total
      ? {
          readPathsNotSeen: FOOD_READ_PATHS.filter((p) => !(reads.seen[p] ?? 0) && !FOOD_PATHS_OUTSIDE_WEEK.includes(p)),
          readPathsWithNoMatch: FOOD_READ_PATHS.filter((p) => !matchedPaths.has(p) && !FOOD_PATHS_OUTSIDE_WEEK.includes(p)),
          // Of those, the rare ones the week drives by hand on staging.
          byHandWithNoMatch: FOOD_PATHS_BY_HAND.filter((p) => !matchedPaths.has(p)),
          queriesNotMatched: Object.entries(reads.queries).filter(([, c]) => c.matched === 0 || c.differed > 0).map(([k]) => k),
          missed: Object.values(reads.missed).reduce((n, v) => n + v, 0),
        }
      : null,
    ...extra,
  };
}

/** Tests: the queue drained. */
export async function foodShadowSettled(timeoutMs = 30_000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const s = state();
    if (!s.queue.length && !s.busy) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}