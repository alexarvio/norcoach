// The check-in figures' shadow week (quest 9), on the food diary's pattern (app/lib/food/shadow.ts; its file untouched):
// beside the door's fetches, the SQL that will replace them (rows.ts loadScope, the same the cut-over runs) runs against
// Postgres and every difference is counted and logged with ids and field names, never a figure, a period or a note.
//
//   CHECKINS_SHADOW=off       (the default) no query runs; the door still counts each path it is asked through.
//   CHECKINS_SHADOW=baseline  as off, and the totals kept (below): the week before, for the writer's times.
//   CHECKINS_SHADOW=read      a sample of the fetches (each path's first 3, then 1 in CHECKINS_SHADOW_SAMPLE, 20 by
//                             default; CHECKINS_SHADOW_RATE a second, 2 by default; CHECKINS_SHADOW_QUEUE waiting at most,
//                             32; a path never compared yet is never dropped) also runs its scope's SQL, compared list by
//                             list with what the last save committed (the writer's snapshot, never live memory), cut to the
//                             same scope: decoded once per save and grouped by metric and by client, a scope over
//                             CHECKINS_SHADOW_CAP rows (20000) skipped and counted; a sample's ms its SQL, decode and
//                             compare together. `equiv.latest` and `equiv.logged`: the minute job's and the locked app's
//                             answers (each metric's newest period, whether it holds a typed figure) over the SQL's rows
//                             against the same answers over every committed row of the metric.
//   CHECKINS_SHADOW=write     as read (the write shadow is not built yet: docs/database-plan.md).
//   CHECKINS_STORE=pg         runs as baseline (nothing in memory to compare with).
//
// Never on a request's path: a fetch only counts and queues (no await, no throw, try/catch round all of it); the queue
// drains behind the answer one job at a time, a breath between, on a pool of 2 (Postgres, 3 s statement timeout) or, on
// pglite, the store's own database. 50 errors in 10 minutes pause it for 10. Every 10 minutes (baseline, read) the totals
// are kept in kv as `checkins_shadow_totals`, CHECKINS_SHADOW_WEEK (a label) starting them afresh. /api/timing `checkins`.

import type { SQL } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { getData, persist } from "../db";
import { CHECKINS_PG, type CheckInTable } from "./mode";
import { CHECKINS_PATHS_BY_HAND, CHECKINS_PATHS_OUTSIDE_WEEK, CHECKINS_READ_PATHS, CHECKINS_WRITE_PATHS, type CheckInPath, type CheckInReadPath, type CheckInWritePath } from "./paths";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyDb = PgDatabase<any, any, any>;
type Row = Record<string, unknown>;
export type ShadowWriter = { readonly generation: number; readonly saving: boolean; committed(name: string): ReadonlyMap<string, string> | undefined };

const ASKED = (process.env.CHECKINS_SHADOW ?? "").trim() || "off";
const KNOWN = ["off", "baseline", "read", "write"];
const MODE: "off" | "baseline" | "read" = !KNOWN.includes(ASKED) ? "off" : CHECKINS_PG ? (ASKED === "off" ? "off" : "baseline") : ASKED === "write" ? "read" : (ASKED as "off" | "baseline" | "read");
const SAMPLE = Math.max(1, Number(process.env.CHECKINS_SHADOW_SAMPLE) || 20);
const RATE = Math.max(1, Number(process.env.CHECKINS_SHADOW_RATE) || 2);
const QUEUE = Math.max(1, Number(process.env.CHECKINS_SHADOW_QUEUE) || 32);
const WEEK = (process.env.CHECKINS_SHADOW_WEEK ?? "").trim() || "1";
const ROUND_MS = 10 * 60_000;
const CAP = Math.max(1000, Number(process.env.CHECKINS_SHADOW_CAP) || 20_000);

type QCount = { sampled: number; matched: number; differed: number; raced: number; errored: number; dropped: number; skipped: number; msTotal: number; msMax: number };
type Job = { first: boolean; run: () => Promise<void> };
type State = {
  db: AnyDb | null;
  writer: ShadowWriter | null;
  seen: Record<string, number>;
  missed: Record<string, number>;
  writes: Record<string, number>;
  queries: Record<string, QCount>;
  equiv: { latest: { compared: number; differed: number }; logged: { compared: number; differed: number } };
  queue: Job[];
  busy: boolean;
  tokens: number;
  tokensAt: number;
  errors: number[];
  pausedUntil: number;
  said: Set<string>;
};
const g = globalThis as unknown as { __norcoachCheckInsShadow?: State };
const state = (): State =>
  (g.__norcoachCheckInsShadow ??= {
    db: null,
    writer: null,
    seen: {},
    missed: {},
    writes: {},
    queries: {},
    equiv: { latest: { compared: 0, differed: 0 }, logged: { compared: 0, differed: 0 } },
    queue: [],
    busy: false,
    tokens: RATE,
    tokensAt: Date.now(),
    errors: [],
    pausedUntil: 0,
    said: new Set(),
  });
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
  console.warn(`[checkins-shadow] ${message}`);
}
const safe = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\nparams:")[0].replace(/"(?:[^"\\]|\\.)*"/g, '"…"').replace(/'(?:[^'\\]|\\.)*'/g, "'…'").slice(0, 200);

export function noteCheckInsSeen(path: CheckInPath) {
  quietly(() => {
    const s = state();
    s.seen[path] = (s.seen[path] ?? 0) + 1;
  });
}
export function noteCheckInsMissed(path: CheckInPath, message: string) {
  quietly(() => {
    const s = state();
    s.missed[path] = (s.missed[path] ?? 0) + 1;
    say(`miss:${message}`, message);
  });
}
export function noteCheckInsWrite(path: CheckInWritePath) {
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

/** A fetch to compare: its SQL (the cut-over's own statements), and the same scope's cut of committed rows. */
export type CheckInShadowFetch = {
  lists: readonly CheckInTable[];
  sqlRows: (q: (query: SQL) => Promise<Row[]>) => Promise<Record<CheckInTable, Row[]>>;
  /** Each client's metrics as memory held them at the fetch. */
  defs: ReadonlyMap<number, readonly number[]>;
  clients: readonly number[];
  /** The scope cut from committed rows (candidates: the scope's metrics' figures and clients' notes, by id). */
  cut: (committed: { entries: Row[]; notes: Row[] }) => Record<CheckInTable, Row[]>;
  /**
   * A coach-wide fetch's asks (21 Nov, the bounded slices: checkins/slices.ts): resolved over the same committed rows,
   * before `cut`; what each side resolved, as a line of ids and periods (never a value), compared: a difference is the
   * resolution's own, counted with the rest as differed.
   */
  prepare?: (committed: { entries: Row[]; notes: Row[] }) => Promise<{ sql: string; committed: string }>;
  /** The metrics read as `latest` and the clients read as `logged` alone: their answers checked over every committed row of the metrics too. */
  latestDefs: readonly number[];
  loggedClients: readonly number[];
  decode: (table: CheckInTable, record: Row) => Row;
};

type Decoded = { gen: number; maps: [ReadonlyMap<string, string> | undefined, ReadonlyMap<string, string> | undefined]; byDef: Map<number, Row[]>; byClient: Map<number, Row[]> };
let decoded: Decoded | null = null;
/** Each committed row decoded, by table and key, with the JSON it was decoded from: a save that left a row as it was reuses it. */
const rowCache: Record<CheckInTable, Map<string, { json: string; row: Row }>> = { metric_entries: new Map(), check_in_notes: new Map() };
function decodedRows(t: CheckInTable, committed: ReadonlyMap<string, string> | undefined, decode: CheckInShadowFetch["decode"]): Row[] {
  const was = rowCache[t];
  const next = new Map<string, { json: string; row: Row }>();
  const out: Row[] = [];
  for (const [key, json] of committed ?? []) {
    if (!json) continue;
    const hit = was.get(key);
    const row = hit && hit.json === json ? hit.row : decode(t, JSON.parse(json) as Row);
    next.set(key, hit && hit.row === row ? hit : { json, row });
    out.push(row);
  }
  rowCache[t] = next;
  return out;
}
/**
 * What the last save committed of the two lists, grouped by metric and by client: rebuilt after each save, but only a
 * row whose JSON changed is parsed and decoded again (every save makes new maps, so most samples come after one).
 */
function committedOf(decode: CheckInShadowFetch["decode"]): Decoded | null {
  const w = state().writer;
  if (!w) return null;
  const e = w.committed("metric_entries");
  const n = w.committed("check_in_notes");
  if (decoded && decoded.gen === w.generation && decoded.maps[0] === e && decoded.maps[1] === n) return decoded;
  const byDef = new Map<number, Row[]>();
  const byClient = new Map<number, Row[]>();
  for (const row of decodedRows("metric_entries", e, decode)) {
    const k = Number(row.metric_definition_id);
    const list = byDef.get(k);
    if (list) list.push(row);
    else byDef.set(k, [row]);
  }
  for (const row of decodedRows("check_in_notes", n, decode)) {
    const k = Number(row.client_id);
    const list = byClient.get(k);
    if (list) list.push(row);
    else byClient.set(k, [row]);
  }
  decoded = { gen: w.generation, maps: [e, n], byDef, byClient };
  return decoded;
}

const byIdRow = (a: Row, b: Row) => Number(a.id) - Number(b.id);
/** listMetricPeriods(ids, 1)'s answer over these rows (queries.ts: distinct periods sorted, the last). */
function newestPeriod(rows: readonly Row[]): unknown {
  const periods = [...new Set(rows.map((r) => r.period))] as string[];
  return periods.sort((a, b) => (a < b ? -1 : 1)).slice(-1)[0];
}
const typed = (r: Row) => r.value != null && r.source !== "health";

export function onCheckInsFetch(path: CheckInReadPath, f: CheckInShadowFetch) {
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

async function readJob(f: CheckInShadowFetch, key: string, again = false): Promise<void> {
  const s = state();
  const c = qc(key);
  const gen = s.writer!.generation;
  const t0 = performance.now();
  let got: Record<CheckInTable, Row[]>;
  try {
    const run = async (query: SQL) => ((await s.db!.execute(query)) as { rows?: Row[] }).rows ?? [];
    got = await f.sqlRows(run);
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
  const committed = committedOf(f.decode);
  if (!committed) return;
  const entries = [...f.defs.values()].flat().flatMap((id) => committed.byDef.get(id) ?? []);
  const notes = f.clients.flatMap((id) => committed.byClient.get(id) ?? []);
  if (entries.length > CAP || notes.length > CAP) {
    c.skipped++;
    return;
  }
  const differs: string[] = [];
  if (f.prepare) {
    const keys = await f.prepare({ entries: [...entries].sort(byIdRow), notes: [...notes].sort(byIdRow) });
    if (keys.sql !== keys.committed) differs.push(`resolved: SQL and the rows committed differ (${keys.sql.split(";").length} and ${keys.committed.split(";").length} clients)`);
  }
  const want = f.cut({ entries: entries.sort(byIdRow), notes: notes.sort(byIdRow) });
  for (const t of f.lists) {
    const w = [...(want[t] ?? [])].sort(byIdRow);
    const have = got[t] ?? [];
    if (stableJson(have) === stableJson(w)) continue;
    const ids = new Set(w.map((r) => r.id));
    const hids = new Set(have.map((r) => r.id));
    // A row in both that differs: its id and the names of the fields that differ (never their values).
    const byId = new Map(have.map((r) => [r.id, r] as const));
    const changed: string[] = [];
    for (const r of w) {
      const h = byId.get(r.id);
      if (!h || stableJson(h) === stableJson(r)) continue;
      const fields = [...new Set([...Object.keys(r), ...Object.keys(h)])].filter((k) => stableJson(r[k]) !== stableJson(h[k]));
      changed.push(`${String(r.id)}(${fields.join(",")})`);
    }
    differs.push(`${t}: missing ${w.filter((r) => !hids.has(r.id)).length}, extra ${have.filter((r) => !ids.has(r.id)).length}, changed ${changed.length}${changed.length ? ` [${changed.slice(0, 5).join(" ")}]` : ""}`);
  }
  // The answers the minute job and the locked app read off these rows, metric by metric, against every committed row.
  const sqlByDef = new Map<number, Row[]>();
  for (const r of got.metric_entries ?? []) {
    const k = Number(r.metric_definition_id);
    const list = sqlByDef.get(k);
    if (list) list.push(r);
    else sqlByDef.set(k, [r]);
  }
  for (const id of f.latestDefs) {
    s.equiv.latest.compared++;
    if (newestPeriod(committed.byDef.get(id) ?? []) !== newestPeriod(sqlByDef.get(id) ?? [])) {
      s.equiv.latest.differed++;
      differs.push(`equiv.latest: metric ${id}`);
    }
  }
  for (const cid of f.loggedClients) {
    for (const id of f.defs.get(cid) ?? []) {
      s.equiv.logged.compared++;
      if ((committed.byDef.get(id) ?? []).some(typed) !== (sqlByDef.get(id) ?? []).some(typed)) {
        s.equiv.logged.differed++;
        differs.push(`equiv.logged: metric ${id}`);
      }
    }
  }
  const ms = performance.now() - t0;
  c.sampled++;
  c.msTotal += ms;
  c.msMax = Math.max(c.msMax, ms);
  if (!differs.length) c.matched++;
  else {
    c.differed++;
    say(`diff:${key}`, `${key} differs (${differs.slice(0, 8).join("; ")})`);
  }
}

// ---- Boot, totals, report -------------------------------------------------------------------------------------------

export async function startCheckInsShadow(opts: { db: AnyDb; url: string; writer: ShadowWriter }): Promise<void> {
  const s = state();
  s.writer = opts.writer;
  if (!KNOWN.includes(ASKED)) console.error(`[checkins-shadow] CHECKINS_SHADOW=${ASKED} is not off, baseline, read or write: off`);
  if (ASKED === "write" && !CHECKINS_PG) console.log("[checkins-shadow] write: the write shadow is not built yet, runs as read");
  if (MODE === "read") {
    if (opts.url.startsWith("pglite:")) s.db = opts.db;
    else {
      const { Pool } = await import("pg");
      const { drizzle } = await import("drizzle-orm/node-postgres");
      const pool = new Pool({ connectionString: opts.url, max: 2, application_name: "norcoach-checkins-shadow", options: "-c statement_timeout=3000" });
      pool.on("error", () => {});
      s.db = drizzle(pool) as unknown as AnyDb;
    }
    console.log(`[checkins-shadow] read: 1 in ${SAMPLE}, ${RATE}/s, queue ${QUEUE}`);
  }
  if (MODE !== "off") setInterval(() => quietly(keepTotals), ROUND_MS).unref?.();
}

type Totals = { week: string; since: string; queries: Record<string, QCount>; seen: Record<string, number>; missed: Record<string, number>; writes: Record<string, number>; equiv: State["equiv"] };
let base: Totals | null = null;
function baseTotals(): Totals {
  if (base) return base;
  const stored = (getData() as unknown as { checkins_shadow_totals?: Totals }).checkins_shadow_totals;
  base =
    stored && stored.week === WEEK
      ? { ...structuredClone(stored), equiv: stored.equiv ?? { latest: { compared: 0, differed: 0 }, logged: { compared: 0, differed: 0 } } }
      : { week: WEEK, since: new Date().toISOString(), queries: {}, seen: {}, missed: {}, writes: {}, equiv: { latest: { compared: 0, differed: 0 }, logged: { compared: 0, differed: 0 } } };
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
  const eq = (k: "latest" | "logged") => ({ compared: b.equiv[k].compared + s.equiv[k].compared, differed: b.equiv[k].differed + s.equiv[k].differed });
  return { week: WEEK, since: b.since, queries, seen: addN(b.seen, s.seen), missed: addN(b.missed, s.missed), writes: addN(b.writes, s.writes), equiv: { latest: eq("latest"), logged: eq("logged") } };
}
/** Every 10 minutes: the week's totals so far into kv (counts and names only). */
export function keepTotals() {
  if (MODE === "off") return;
  (getData() as unknown as { checkins_shadow_totals?: Totals }).checkins_shadow_totals = totalsNow();
  persist();
}

/** For /api/timing: counts and names, never ids or figures. */
/** Whether a fetch may be sampled (read mode): the coach-wide asks then take their facts at the fetch (checkins/rows.ts). */
export const checkInsShadowReads = MODE === "read";

export function checkInsShadowReport(extra: Record<string, unknown> = {}) {
  const s = state();
  const total = MODE === "off" ? null : totalsNow();
  const reads = total ?? { queries: s.queries, seen: s.seen, missed: s.missed, writes: s.writes, equiv: s.equiv };
  const matchedPaths = new Set(Object.entries(reads.queries).filter(([, c]) => c.matched > 0).map(([k]) => k.split(":")[0]));
  return {
    mode: MODE,
    asked: ASKED,
    week: WEEK,
    paths: Object.fromEntries([...CHECKINS_READ_PATHS, ...CHECKINS_WRITE_PATHS].map((p) => [p, { seen: s.seen[p] ?? 0, missed: s.missed[p] ?? 0, writes: s.writes[p] ?? 0 }])),
    queries: s.queries,
    equiv: s.equiv,
    queue: s.queue.length,
    pausedUntil: s.pausedUntil ? new Date(s.pausedUntil).toISOString() : null,
    total: total
      ? {
          readPathsNotSeen: CHECKINS_READ_PATHS.filter((p) => !(reads.seen[p] ?? 0) && !CHECKINS_PATHS_OUTSIDE_WEEK.includes(p)),
          readPathsWithNoMatch: CHECKINS_READ_PATHS.filter((p) => !matchedPaths.has(p) && !CHECKINS_PATHS_OUTSIDE_WEEK.includes(p)),
          byHandWithNoMatch: CHECKINS_PATHS_BY_HAND.filter((p) => !matchedPaths.has(p)),
          queriesNotMatched: Object.entries(reads.queries).filter(([, c]) => c.matched === 0 || c.differed > 0).map(([k]) => k),
          missed: Object.values(reads.missed).reduce((n, v) => n + v, 0),
          equiv: reads.equiv,
        }
      : null,
    ...extra,
  };
}

/** Tests: the queue drained. */
export async function checkInsShadowSettled(timeoutMs = 30_000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const s = state();
    if (!s.queue.length && !s.busy) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}
