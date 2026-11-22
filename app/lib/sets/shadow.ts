// The logged sets' shadow week (quest 10), on the check-ins' pattern (app/lib/checkins/shadow.ts; its file untouched):
// beside the door's fetches, the SQL that will replace them (rows.ts loadScope, the same the cut-over runs) runs against
// Postgres and every difference is counted and logged with ids and field names, never a weight, a rep or a stamp. Since
// 22 Nov each sample compares the cardio ticks too (rows.ts loadTicks against cutTicks), table by table.
//
//   SETS_SHADOW=off       (the default) no query runs; the door still counts each path it is asked through.
//   SETS_SHADOW=baseline  as off, and the totals kept (below): the week before, for the writer's times.
//   SETS_SHADOW=read      a sample of the fetches (each path's first 3, then 1 in SETS_SHADOW_SAMPLE, 20 by default;
//                         SETS_SHADOW_RATE a second, 2; SETS_SHADOW_QUEUE waiting at most, 32; a path never compared yet
//                         is never dropped) also runs its scope's SQL, compared with what the last save committed (the
//                         writer's snapshot, never live memory), cut to the same scope, decoded only when a row's JSON
//                         changed since the last decode; a scope over SETS_SHADOW_CAP rows (20000) skipped and counted.
//   SETS_SHADOW=write     as read (the write shadow is not built: docs/database-plan.md).
//   SETS_STORE=pg         runs as baseline (nothing in memory to compare with).
//
// Never on a request's path: a fetch only counts and queues (no await, no throw, try/catch round all of it); the queue
// drains behind the answer one job at a time, a breath between, on a pool of 2 (Postgres, 3 s statement timeout) or, on
// pglite, the store's own database. 50 errors in 10 minutes pause it for 10. Every 10 minutes (baseline, read) the totals
// are kept in kv as `sets_shadow_totals`, SETS_SHADOW_WEEK (a label) starting them afresh. /api/timing `sets`.

import { sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { getData, persist } from "../db";
import { fromRecord } from "../pg/store";
import { cardio_logs, set_logs } from "../pg/schema";
import { SETS_PG } from "./mode";
import { SETS_PATHS_BY_HAND, SETS_PATHS_OUTSIDE_WEEK, SETS_READ_PATHS, SETS_WRITE_PATHS, type SetPath, type SetReadPath, type SetWritePath } from "./paths";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyDb = PgDatabase<any, any, any>;
type Row = Record<string, unknown>;
type Q = (query: ReturnType<typeof sql>) => Promise<Row[]>;
export type SetsShadowWriter = { readonly generation: number; readonly saving: boolean; committed(name: string): ReadonlyMap<string, string> | undefined };

const ASKED = (process.env.SETS_SHADOW ?? "").trim() || "off";
const KNOWN = ["off", "baseline", "read", "write"];
const MODE: "off" | "baseline" | "read" = !KNOWN.includes(ASKED) ? "off" : SETS_PG ? (ASKED === "off" ? "off" : "baseline") : ASKED === "write" ? "read" : (ASKED as "off" | "baseline" | "read");
const SAMPLE = Math.max(1, Number(process.env.SETS_SHADOW_SAMPLE) || 20);
const RATE = Math.max(1, Number(process.env.SETS_SHADOW_RATE) || 2);
const QUEUE = Math.max(1, Number(process.env.SETS_SHADOW_QUEUE) || 32);
const WEEK = (process.env.SETS_SHADOW_WEEK ?? "").trim() || "1";
const ROUND_MS = 10 * 60_000;
const CAP = Math.max(1000, Number(process.env.SETS_SHADOW_CAP) || 20_000);

type QCount = { sampled: number; matched: number; differed: number; raced: number; errored: number; dropped: number; skipped: number; msTotal: number; msMax: number };
type Job = { first: boolean; run: () => Promise<void> };
type State = {
  db: AnyDb | null;
  writer: SetsShadowWriter | null;
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
  /** The committed rows decoded: by id, the JSON it was decoded from (a row is decoded again only when it changed). */
  decoded: Map<string, { json: string; row: Row }>;
};
const g = globalThis as unknown as { __norcoachSetsShadow?: State };
const state = (): State =>
  (g.__norcoachSetsShadow ??= {
    db: null,
    writer: null,
    seen: {},
    missed: {},
    writes: {},
    queries: {},
    queue: [],
    busy: false,
    tokens: RATE,
    tokensAt: Date.now(),
    errors: [],
    pausedUntil: 0,
    said: new Set(),
    decoded: new Map(),
  });
const qc = (key: string) => (state().queries[key] ??= { sampled: 0, matched: 0, differed: 0, raced: 0, errored: 0, dropped: 0, skipped: 0, msTotal: 0, msMax: 0 });
const tried = new Map<string, number>();

function quietly(fn: () => void) {
  try {
    fn();
  } catch {
    /* never into a request */
  }
}
function say(key: string, message: string) {
  const s = state();
  if (s.said.has(key) || s.said.size > 500) return;
  s.said.add(key);
  console.warn(`[sets-shadow] ${message}`);
}
const safe = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\nparams:")[0].replace(/"(?:[^"\\]|\\.)*"/g, '"…"').replace(/'(?:[^'\\]|\\.)*'/g, "'…'").slice(0, 200);

export function noteSetsSeen(path: SetPath) {
  quietly(() => {
    const s = state();
    s.seen[path] = (s.seen[path] ?? 0) + 1;
  });
}
export function noteSetsMissed(path: SetPath, message: string) {
  quietly(() => {
    const s = state();
    s.missed[path] = (s.missed[path] ?? 0) + 1;
    say(`miss:${message}`, message);
  });
}
export function noteSetsWrite(path: SetWritePath) {
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
      await new Promise((r) => setImmediate(r));
    }
  } finally {
    s.busy = false;
  }
}

/** Canonical JSON: keys sorted, so two encodings of one row compare equal. */
function stableJson(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  return `{${Object.keys(v as Row)
    .filter((k) => (v as Row)[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson((v as Row)[k])}`)
    .join(",")}}`;
}

/** The two lists the shadow compares (the sets, and the cardio ticks since 22 Nov). */
const TABLES = ["set_logs", "cardio_logs"] as const;
type ShadowTable = (typeof TABLES)[number];
const SCHEMA_OF = { set_logs, cardio_logs } as const;
export type SetsShadowLists = Record<ShadowTable, Row[]>;

/** What the last save committed, decoded as a fetch decodes (fromRecord), in id order; rows decoded again only when changed. */
const committedAt = new Map<ShadowTable, { generation: number; map: ReadonlyMap<string, string>; rows: Row[] }>();
function committedRows(): SetsShadowLists | null {
  const s = state();
  const out = {} as SetsShadowLists;
  for (const t of TABLES) {
    const map = s.writer?.committed(t);
    if (!map) return null;
    // The same save's rows already decoded and sorted: handed out again (a sample never changes them; cut copies its scope).
    const generation = s.writer?.generation ?? 0;
    const at = committedAt.get(t);
    if (at && at.generation === generation && at.map === map) {
      out[t] = at.rows;
      continue;
    }
    const rows = decodeCommitted(t, map);
    committedAt.set(t, { generation, map, rows });
    out[t] = rows;
  }
  return out;
}
function decodeCommitted(t: ShadowTable, map: ReadonlyMap<string, string>): Row[] {
  const s = state();
  const out: Row[] = [];
  const keep = new Set<string>();
  for (const [id, json] of map) {
    const key = `${t}:${id}`;
    keep.add(key);
    let got = s.decoded.get(key);
    if (!got || got.json !== json) {
      got = { json, row: fromRecord(SCHEMA_OF[t], JSON.parse(json)) as Row };
      s.decoded.set(key, got);
    }
    out.push(got.row);
  }
  for (const k of [...s.decoded.keys()]) if (k.startsWith(`${t}:`) && !keep.has(k)) s.decoded.delete(k);
  return out.sort((a, b) => Number(a.id) - Number(b.id));
}

export type SetsShadowFetch = {
  /** The scope's own SQL (the cut-over's statements), its rows decoded, the sets and the ticks. */
  sqlRows: (q: Q) => Promise<SetsShadowLists>;
  /** The same scope cut from the committed rows (store order), by the same predicates. */
  cut: (committed: SetsShadowLists) => Promise<SetsShadowLists>;
};

/** A fetch done (memory mode, read): sampled into the queue, never awaited, never thrown. */
export function onSetsFetch(path: SetReadPath, f: SetsShadowFetch) {
  quietly(() => {
    if (MODE !== "read" || !state().db) return;
    const n = (tried.get(path) ?? 0) + 1;
    tried.set(path, n);
    const first = n <= 3 || !(qc(path).matched + qc(path).differed);
    if (!first && n % SAMPLE !== 0) return;
    if (!take(first)) {
      qc(path).dropped++;
      return;
    }
    push({ first, run: () => readJob(path, f) });
  });
}

/** One table's difference, by id and field name alone. */
function diffOf(want: Row[], got: Row[]) {
  const a = new Map(want.map((r) => [Number(r.id), r] as const));
  const b = new Map(got.map((r) => [Number(r.id), r] as const));
  const missing = [...a.keys()].filter((id) => !b.has(id));
  const extra = [...b.keys()].filter((id) => !a.has(id));
  const changed: string[] = [];
  for (const [id, r] of a) {
    const o = b.get(id);
    if (!o) continue;
    const fields = [...new Set([...Object.keys(r), ...Object.keys(o)])].filter((k) => stableJson(r[k]) !== stableJson(o[k]));
    if (fields.length) changed.push(`${id}(${fields.sort().join(",")})`);
  }
  return { missing, extra, changed };
}

async function readJob(path: SetReadPath, f: SetsShadowFetch, again = false): Promise<void> {
  const s = state();
  const c = qc(path);
  const t0 = performance.now();
  const gen = s.writer?.generation ?? 0;
  if (s.writer?.saving) {
    if (!again) return readJob(path, f, true);
    c.raced++;
    return;
  }
  let sqlRows: SetsShadowLists;
  try {
    sqlRows = await s.db!.transaction(async (tx) => f.sqlRows(async (query) => (((await (tx as unknown as AnyDb).execute(query)) as { rows?: Row[] }).rows ?? []) as Row[]), { isolationLevel: "repeatable read", accessMode: "read only" });
  } catch (error) {
    c.errored++;
    errored();
    say(`err:${path}:${safe(error)}`, `${path}: ${safe(error)}`);
    return;
  }
  if ((s.writer?.generation ?? 0) !== gen || s.writer?.saving) {
    if (!again) return readJob(path, f, true);
    c.raced++;
    return;
  }
  const committed = committedRows();
  if (!committed) return;
  const want = await f.cut(committed);
  c.sampled++;
  if (TABLES.reduce((n, t) => n + want[t].length + sqlRows[t].length, 0) > CAP) {
    c.skipped++;
    return;
  }
  const diffs = TABLES.map((t) => [t, diffOf(want[t], sqlRows[t])] as const);
  const ms = performance.now() - t0;
  c.msTotal += ms;
  c.msMax = Math.max(c.msMax, ms);
  if (diffs.every(([, d]) => !d.missing.length && !d.extra.length && !d.changed.length)) {
    c.matched++;
    return;
  }
  c.differed++;
  // Ids and field names alone, never a weight, a rep or a stamp.
  for (const [t, { missing, extra, changed }] of diffs) {
    if (!missing.length && !extra.length && !changed.length) continue;
    say(`diff:${path}:${t}:${missing.length}:${extra.length}:${changed.length}`, `${path} ${t}: missing ${missing.length} [${missing.slice(0, 10).join(",")}], extra ${extra.length} [${extra.slice(0, 10).join(",")}], changed ${changed.length} [${changed.slice(0, 10).join(",")}]`);
  }
}

// ---- Boot, totals, report -------------------------------------------------------------------------------------------

export async function startSetsShadow(opts: { db: AnyDb; url: string; writer: SetsShadowWriter }): Promise<void> {
  const s = state();
  s.writer = opts.writer;
  if (!KNOWN.includes(ASKED)) console.error(`[sets-shadow] SETS_SHADOW=${ASKED} is not off, baseline, read or write: off`);
  if (ASKED === "write" && !SETS_PG) console.log("[sets-shadow] write: the write shadow is not built, runs as read");
  if (MODE === "read") {
    if (opts.url.startsWith("pglite:")) s.db = opts.db;
    else {
      const { Pool } = await import("pg");
      const { drizzle } = await import("drizzle-orm/node-postgres");
      const pool = new Pool({ connectionString: opts.url, max: 2, application_name: "norcoach-sets-shadow", options: "-c statement_timeout=3000" });
      pool.on("error", () => {});
      s.db = drizzle(pool) as unknown as AnyDb;
    }
    console.log(`[sets-shadow] read: 1 in ${SAMPLE}, ${RATE}/s, queue ${QUEUE}`);
  }
  if (MODE !== "off") setInterval(() => quietly(keepTotals), ROUND_MS).unref?.();
}

type Totals = { week: string; since: string; queries: Record<string, QCount>; seen: Record<string, number>; missed: Record<string, number>; writes: Record<string, number> };
let base: Totals | null = null;
function baseTotals(): Totals {
  if (base) return base;
  const stored = (getData() as unknown as { sets_shadow_totals?: Totals }).sets_shadow_totals;
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
  (getData() as unknown as { sets_shadow_totals?: Totals }).sets_shadow_totals = totalsNow();
  persist();
}

/** Whether a fetch may be sampled (read mode). */
export const setsShadowReads = MODE === "read";

/** For /api/timing: counts and names, never ids or figures. */
export function setsShadowReport(extra: Record<string, unknown> = {}) {
  const s = state();
  const total = MODE === "off" ? null : totalsNow();
  const reads = total ?? { queries: s.queries, seen: s.seen, missed: s.missed, writes: s.writes };
  const matched = new Set(Object.entries(reads.queries).filter(([, c]) => c.matched > 0).map(([k]) => k));
  return {
    mode: MODE,
    asked: ASKED,
    week: WEEK,
    paths: Object.fromEntries([...SETS_READ_PATHS, ...SETS_WRITE_PATHS].map((p) => [p, { seen: s.seen[p] ?? 0, missed: s.missed[p] ?? 0, writes: s.writes[p] ?? 0 }])),
    queries: s.queries,
    queue: s.queue.length,
    pausedUntil: s.pausedUntil ? new Date(s.pausedUntil).toISOString() : null,
    total: total
      ? {
          readPathsNotSeen: SETS_READ_PATHS.filter((p) => !(reads.seen[p] ?? 0) && !SETS_PATHS_OUTSIDE_WEEK.includes(p)),
          readPathsWithNoMatch: SETS_READ_PATHS.filter((p) => !matched.has(p) && !SETS_PATHS_OUTSIDE_WEEK.includes(p)),
          byHandWithNoMatch: SETS_PATHS_BY_HAND.filter((p) => !matched.has(p)),
          queriesNotMatched: Object.entries(reads.queries).filter(([, c]) => c.matched === 0 || c.differed > 0).map(([k]) => k),
          missed: Object.values(reads.missed).reduce((n, v) => n + v, 0),
        }
      : null,
    ...extra,
  };
}

/** Tests: the queue drained. */
export async function setsShadowSettled(timeoutMs = 30_000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const s = state();
    if (!s.queue.length && !s.busy) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}
