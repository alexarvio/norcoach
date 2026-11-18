// The shadow week (18 Nov, Step 5 of docs/database-plan.md): beside the door's fetches and writes (rows.ts), the SQL
// that will replace them after the cut-over (statements.ts) runs against Postgres, and every difference is logged.
//
//   CHAT_SHADOW=off       (the default) no query runs; the door still counts each path it is asked through. At boot the
//                         shadow tables are emptied should they hold rows (a staging week's copy of chat left behind).
//   CHAT_SHADOW=baseline  as off, and the totals kept (below): the week before the shadow, for the writer's times.
//   CHAT_SHADOW=read      a sample of the fetches (each path's queries' first 3, then 1 in CHAT_SHADOW_SAMPLE, 20 by
//                         default; 2 a second at most; one never compared yet is never dropped) also runs its query on
//                         chat_messages, compared with what the last save committed (the writer's snapshot, never live
//                         memory, which may be ahead of the table).
//   CHAT_SHADOW=write     as read, and every chat mutation also runs its new single-statement SQL on chat_messages_shadow
//                         (seeded from chat_messages at boot), its answer compared with memory's, and the two tables
//                         compared every 10 minutes. Staging only: on the live server it runs as read.
//
// Never on a request's path: a fetch or a write only counts and queues (no await, no throw, try/catch round all of it);
// the queue drains behind the answer, one job at a time, on its own pool of two connections (one reads, one writes and
// compares) so the app's pool of five keeps its room for the writer. On pglite, the app's own database, one job at a time
// and only while no save is running. A comparison gives way to requests every thousand rows (setImmediate), so a big one
// never holds the server. It never writes to chat_messages or once_keys. 50 errors in 10 minutes pause it for 10.
//
// Counted per path and per query (`page.tab.home:thread`). The totals outlive a restart: every 10 minutes (baseline, read,
// write) they are kept in the store's kv as `chat_shadow_totals`, the week's so far plus this boot's, a day at a time for
// the differences, errors, the writer's transaction p90 and the event loop's delay; CHAT_SHADOW_WEEK (a label) starts
// them afresh when it changes. What it found is on /api/timing under `chat`, without ids or text (any coach can open that
// page); the ids are in the server log, once per kind of difference, 500 kinds at most.

import { monitorEventLoopDelay, type IntervalHistogram } from "perf_hooks";
import type { SQL } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { getData, persist, type ChatRow } from "../db";
import { storeHealth } from "../pg/health";
import { chat_messages, once_keys } from "../pg/schema";
import { cleanJson, cleanText, fromRecord, toRecord } from "../pg/store";
import { msInstant, stampInstant, stampInstantMs } from "../pg/stamps";
import { stampMs } from "../targetRule";
import { CHAT_READ_PATHS, CHAT_WRITE_PATHS, type ChatPath, type ChatReadPath, type ChatWritePath } from "./paths";
import {
  chatNeedOf,
  dockLineOf,
  groupOf,
  pickCoachLast,
  pickCoachSent,
  pickDock,
  pickExists,
  pickExport,
  pickFood,
  pickLacksLook,
  pickThread,
  pickToPrepare,
  rowFieldsDiff,
  rowsDiffFinish,
  stableJson,
  type RowsDiff,
} from "./pick";
import { readSql, shadowSql, writeSql, type ChatTable, type InsertParams } from "./statements";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyDb = PgDatabase<any, any, any>;
type Row = Record<string, unknown>;

/** What the store's writer tells the shadow (pg/store.ts PgStoreWriter). */
export type ShadowWriter = { readonly generation: number; readonly saving: boolean; committed(name: string): ReadonlyMap<string, string> | undefined };

// ---- What a fetch asked for, by value: one query each ------------------------------------------------------------

export type ReadSpec =
  | { kind: "thread"; clientId: number }
  | { kind: "food"; clientId: number }
  | { kind: "coachSent"; clientIds: number[] }
  | { kind: "coachLast"; clientIds: number[] }
  | { kind: "dock"; clientIds: number[]; since: number }
  | { kind: "exists"; publicPath: string }
  | { kind: "lacksLook"; publicPath: string }
  | { kind: "toPrepare" }
  | { kind: "export"; clientIds: number[] };

/** A mutation as memory made it, by value (the row after it, or what it changed). */
export type WriteSpec =
  | { op: "insert"; row: ChatRow; replyTo: number | null; once: { key: string; at: number } | null; meal: { date: string; meal: string } | null }
  | { op: "react"; id: number; clientId: number; who: "client" | "coach"; emoji: string | null }
  | { op: "edit"; id: number; clientId: number; sender: string; text: string; editedAt: string | null; foodMeal: boolean; was: { text: string; at: string } }
  | { op: "delete"; id: number; clientId: number; sender: string; foodMeal: boolean; was: { text: string; at: string; media: string | null } }
  | { op: "link"; id: number; clientId: number; link: unknown }
  | { op: "pin"; id: number; clientId: number; pinned: boolean }
  | { op: "look"; mediaPath: string; look: { media_thumb: string | null; media_w: number | null; media_h: number | null }; ids: number[] }
  | { op: "swap"; from: string; to: string; ids: number[] }
  | { op: "clientDelete"; clientId: number; ids: number[] }
  | { op: "wipe"; ids: number[] };

// ---- Counts ------------------------------------------------------------------------------------------------------

/** A path: how often the door was asked through it, and asked a view for what it doesn't hold. */
type PathCount = { seen: number; missed: number };
/** One query of a path (`path:kind`). */
type QueryCount = { sampled: number; matched: number; differed: number; explained: number; errored: number; raced: number; dropped: number; skipped: number };
type WriteCount = { seen: number; applied: number; matched: number; differed: number; errored: number };
type Equiv = { checked: number; matched: number; differed: number; errored: number };
type TableCount = { rounds: number; pending: number; confirmed: number; resynced: number; skipped: number };
type DayCount = { matched: number; differed: number; explained: number; errored: number; txP90: number[]; lagP99: number[] };
type ReadJob = { path: ChatReadPath; spec: ReadSpec; key: string };
type WriteJob = { path: ChatWritePath; query: SQL; lock: SQL | null; touched: number[]; check: (rows: Row[]) => boolean };

/** What is kept in kv between boots (`chat_shadow_totals`). */
type Totals = {
  v: 1;
  week: string;
  boot: string;
  boots: number;
  since: string;
  updatedAt: string;
  paths: Record<string, PathCount>;
  queries: Record<string, QueryCount>;
  equiv: { home: Equiv; dock: Equiv };
  writes: Record<string, WriteCount>;
  table: TableCount;
  days: Record<string, DayCount>;
};

type State = {
  mode: "off" | "read" | "write";
  views: "wide" | "narrow";
  sampleEvery: number;
  /** Shadow reads a second at most, and how many may wait (CHAT_SHADOW_RATE, CHAT_SHADOW_QUEUE: the tests raise them). */
  rate: number;
  queueCap: number;
  startedAt: string | null;
  paused: number;
  pausedUntil: number;
  errorsAt: number[];
  paths: Record<string, PathCount>;
  queries: Record<string, QueryCount>;
  ms: Record<string, number[]>;
  calls: Record<string, number>;
  /** Comparisons finished (matched, differed, explained, errored) and waiting, per query: one never finished is never dropped. */
  done: Record<string, number>;
  inflight: Record<string, number>;
  bucket: { tokens: number; at: number };
  equiv: { home: Equiv; dock: Equiv };
  days: Record<string, DayCount>;
  write: {
    enabled: boolean;
    seeded: boolean;
    overflow: number;
    ops: Record<string, WriteCount>;
    table: TableCount & { lastAt: string | null };
  };
  readQueue: ReadJob[];
  writeQueue: WriteJob[];
  readBusy: boolean;
  writeBusy: boolean;
  /** The table compare is running: the write line waits for it (they share a connection and the ids it resyncs). */
  comparing: boolean;
  /** pglite: one job at a time across both queues. */
  oneLine: Promise<unknown>;
  recent: { at: string; path: string; kind: string; fields: string[] }[];
  logged: Set<string>;
  /** Kinds of difference or error not logged because 500 already were. */
  suppressed: number;
  told: Set<string>;
  readDb: AnyDb | null;
  writeDb: AnyDb | null;
  pglite: boolean;
  seed: Promise<void> | null;
  cache: { gen: number; map: Map<string, { json: string; row: ChatRow }>; rows: ChatRow[] } | null;
  lastOp: Map<number, { path: ChatWritePath; at: number }>;
  pending: Map<number, number>;
  lag: IntervalHistogram | null;
  keep: { on: boolean; week: string; boot: string; base: Totals | null | undefined; lastAt: string | null };
};

const QUEUE_CAP = 32;
const WRITE_CAP = 5000;
const RATE = 2;
const ERROR_BURST = 50;
const ERROR_WINDOW = 10 * 60_000;
const PAUSE_MS = 10 * 60_000;
const TABLE_EVERY = 10 * 60_000;
const KEEP_EVERY = 10 * 60_000;
const LAST_OP_KEPT = 24 * 3_600_000;
/** Rows compared between two give-ways to the server's other work. */
const CHUNK = 1000;
/** A comparison with more rows than this is skipped (counted `skipped`), never run. */
const ROW_CAP = 200_000;
/** Kinds of difference or error logged at most (each once). */
const LOG_CAP = 500;
/** The queries whose answer rides on a stamp's instant, where a row stampMs reads one way and the column another is known. */
const STAMP_KINDS = new Set(["coachLast", "dock"]);

const g = globalThis as unknown as { __norcoachChat?: State; _pgWriter?: ShadowWriter };

const zeroQuery = (): QueryCount => ({ sampled: 0, matched: 0, differed: 0, explained: 0, errored: 0, raced: 0, dropped: 0, skipped: 0 });
const zeroWrite = (): WriteCount => ({ seen: 0, applied: 0, matched: 0, differed: 0, errored: 0 });
const zeroEquiv = (): Equiv => ({ checked: 0, matched: 0, differed: 0, errored: 0 });
const zeroTable = (): TableCount => ({ rounds: 0, pending: 0, confirmed: 0, resynced: 0, skipped: 0 });
const zeroDay = (): DayCount => ({ matched: 0, differed: 0, explained: 0, errored: 0, txP90: [], lagP99: [] });

function state(): State {
  return (g.__norcoachChat ??= {
    mode: "off",
    views: process.env.CHAT_VIEWS === "narrow" ? "narrow" : "wide",
    sampleEvery: 20,
    startedAt: null,
    paused: 0,
    pausedUntil: 0,
    errorsAt: [],
    paths: {},
    queries: {},
    ms: {},
    calls: {},
    done: {},
    inflight: {},
    rate: RATE,
    queueCap: QUEUE_CAP,
    bucket: { tokens: RATE, at: Date.now() },
    equiv: { home: zeroEquiv(), dock: zeroEquiv() },
    days: {},
    write: { enabled: false, seeded: false, overflow: 0, ops: {}, table: { ...zeroTable(), lastAt: null } },
    readQueue: [],
    writeQueue: [],
    readBusy: false,
    writeBusy: false,
    comparing: false,
    oneLine: Promise.resolve(),
    recent: [],
    logged: new Set(),
    suppressed: 0,
    told: new Set(),
    readDb: null,
    writeDb: null,
    pglite: false,
    seed: null,
    cache: null,
    lastOp: new Map(),
    pending: new Map(),
    lag: null,
    keep: { on: false, week: "1", boot: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, base: undefined, lastAt: null },
  });
}

const pathCount = (path: string): PathCount => (state().paths[path] ??= { seen: 0, missed: 0 });
const queryCount = (key: string): QueryCount => (state().queries[key] ??= zeroQuery());
const writeCount = (path: string): WriteCount => (state().write.ops[path] ??= zeroWrite());

/** The server's day (TZ=Europe/Amsterdam on Railway), for the totals' days. */
function dayKey(at = new Date()): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}
const today = (): DayCount => (state().days[dayKey()] ??= zeroDay());

/** Remembered once, so it is logged once: false when it was already, or when 500 kinds already are (then counted). */
function remember(signature: string): boolean {
  const s = state();
  if (s.logged.has(signature)) return false;
  if (s.logged.size >= LOG_CAP) {
    s.suppressed++;
    return false;
  }
  s.logged.add(signature);
  return true;
}

/** The door was asked through this path (counted whatever the mode). */
export function noteSeen(path: ChatPath) {
  try {
    if (path.startsWith("w.")) writeCount(path).seen++;
    else pathCount(path).seen++;
  } catch {}
}

/** A view was asked for something outside what it holds (rows.ts miss): counted, said once a path. */
export function noteMissed(path: ChatPath, message: string) {
  try {
    pathCount(path).missed++;
    if (!remember(`miss:${path}`)) return;
    console.error(`[chat] !!! a chat view was read outside what it holds (${path}): ${message}`);
    if (process.env.NODE_ENV === "production") toSentry((S) => S.captureMessage(`Chat view missed: ${path}`, { level: "error", tags: { alert: "chat-view-miss", path } }));
  } catch {}
}

function toSentry(send: (sentry: typeof import("@sentry/nextjs")) => void) {
  import("@sentry/nextjs").then(send).catch(() => {});
}

// ---- Starting ----------------------------------------------------------------------------------------------------

/** Where Postgres is and who writes to it: the boot's (pg/runtime.ts), before any request. Never throws. */
export async function startChatShadow(opts: { db: AnyDb; url: string; writer: ShadowWriter }): Promise<void> {
  try {
    const s = state();
    const asked = (process.env.CHAT_SHADOW ?? "off").toLowerCase();
    s.sampleEvery = Math.max(1, Math.round(Number(process.env.CHAT_SHADOW_SAMPLE) || 20));
    s.rate = Math.max(0.1, Number(process.env.CHAT_SHADOW_RATE) || RATE);
    s.queueCap = Math.max(1, Math.round(Number(process.env.CHAT_SHADOW_QUEUE) || QUEUE_CAP));
    s.bucket.tokens = s.rate;
    s.keep.week = (process.env.CHAT_SHADOW_WEEK ?? "").trim().slice(0, 40) || "1";
    g._pgWriter = opts.writer;
    // A staging week's copy of chat is never left in the shadow tables once the write shadow is off (an erased client's
    // messages with it): emptied in the background, nothing waits on it, and an error (no such table) is only said.
    if (asked !== "write") void emptyShadowTables(opts.db);
    if (asked === "baseline" || asked === "read" || asked === "write") startKeeping();
    if (asked !== "read" && asked !== "write") return;
    const staging = process.env.RAILWAY_ENVIRONMENT_NAME ? process.env.RAILWAY_ENVIRONMENT_NAME !== "production" : !process.env.RAILWAY_ENVIRONMENT && process.env.NODE_ENV !== "production";
    let mode: "read" | "write" = asked;
    if (mode === "write" && !staging) {
      console.log("[chat] CHAT_SHADOW=write is for staging alone; running as read");
      mode = "read";
    }
    s.pglite = opts.url.startsWith("pglite:");
    if (s.pglite) {
      s.readDb = s.writeDb = opts.db;
    } else {
      const { Pool } = await import("pg");
      const { drizzle } = await import("drizzle-orm/node-postgres");
      const pool = new Pool({ connectionString: opts.url, max: 2, connectionTimeoutMillis: 2000, application_name: "norcoach-chat-shadow", options: "-c statement_timeout=3000" });
      pool.on("error", (error) => console.error("[chat] shadow pool:", safeMessage(error)));
      s.readDb = s.writeDb = drizzle(pool) as unknown as AnyDb;
    }
    s.mode = mode;
    s.startedAt = new Date().toISOString();
    if (mode === "write") await startWriteShadow();
    console.log(`[chat] shadow ${s.mode}${s.write.enabled ? " (writes on chat_messages_shadow)" : ""}, 1 in ${s.sampleEvery}, views ${s.views}, week ${s.keep.week}`);
  } catch (error) {
    console.error("[chat] the shadow could not start; off:", safeMessage(error));
    state().mode = "off";
  }
}

async function emptyShadowTables(db: AnyDb) {
  try {
    const left = rowsOf(await db.execute(shadowSql.held))[0];
    if (!Number(left?.n)) return;
    for (const step of shadowSql.empty) await db.execute(step);
    console.log(`[chat] the shadow tables held ${Number(left.n)} rows with the write shadow off: emptied`);
  } catch (error) {
    console.error("[chat] the shadow tables could not be emptied:", safeMessage(error));
  }
}

async function startWriteShadow() {
  const s = state();
  const db = s.writeDb!;
  // The shadow tables are the real ones' shape, or nothing is written to them.
  const cols = rowsOf(await db.execute(shadowSql.columns));
  const shape = (t: string) => stableJson(cols.filter((c) => c.table_name === t).map((c) => [c.column_name, c.data_type]));
  if (shape("chat_messages") !== shape("chat_messages_shadow") || shape("once_keys") !== shape("once_keys_shadow") || !shape("chat_messages_shadow").includes("created_at_tz")) {
    console.error("[chat] the shadow tables differ from the real ones in shape: the write shadow is off");
    return;
  }
  s.write.enabled = true;
  s.seed = (async () => {
    await db.transaction(async (tx) => {
      for (const step of shadowSql.seed) await tx.execute(step);
    });
    s.write.seeded = true;
  })().catch((error) => {
    console.error("[chat] the shadow tables could not be seeded; the write shadow is off:", safeMessage(error));
    s.write.enabled = false;
  });
  await s.seed;
  const first = setTimeout(() => void compareTables(), 60_000);
  first.unref?.();
  const every = setInterval(() => void compareTables(), TABLE_EVERY);
  every.unref?.();
}

// ---- Reads -------------------------------------------------------------------------------------------------------

/** A fetch's query (rows.ts): maybe run too, behind the answer. Never throws, never waits. */
export function onFetch(spec: ReadSpec, path: ChatReadPath) {
  try {
    const s = state();
    if (s.mode === "off" || !s.readDb || Date.now() < s.pausedUntil) return;
    const key = `${path}:${spec.kind}`;
    const n = (s.calls[key] = (s.calls[key] ?? 0) + 1);
    // One never compared yet is taken every time (two waiting at most), so a rare path is never left out by the sampling.
    const fresh = !(s.done[key] > 0) && (s.inflight[key] ?? 0) < 2;
    if (!fresh && n > 3 && n % s.sampleEvery !== 0) return;
    // Two a second at most.
    const now = Date.now();
    s.bucket.tokens = Math.min(s.rate, s.bucket.tokens + ((now - s.bucket.at) / 1000) * s.rate);
    s.bucket.at = now;
    const c = queryCount(key);
    if (fresh ? s.readQueue.length >= s.queueCap * 2 : s.bucket.tokens < 1 || s.readQueue.length >= s.queueCap) {
      c.dropped++;
      return;
    }
    if (s.bucket.tokens >= 1) s.bucket.tokens -= 1;
    c.sampled++;
    s.inflight[key] = (s.inflight[key] ?? 0) + 1;
    s.readQueue.push({ path, spec, key });
    setImmediate(() => void drainReads());
  } catch {}
}

async function drainReads() {
  const s = state();
  if (s.readBusy) return;
  s.readBusy = true;
  try {
    for (let job = s.readQueue.shift(); job; job = s.readQueue.shift()) {
      const run = job;
      await onLine(() => runRead(run));
    }
  } finally {
    s.readBusy = false;
  }
}

/** On pglite every job goes one after another (one connection, the app's own); on Postgres reads and writes each have theirs. */
function onLine<T>(work: () => Promise<T>): Promise<T | undefined> {
  const s = state();
  if (!s.pglite) return work().catch(() => undefined);
  const next = s.oneLine.then(work, work);
  s.oneLine = next.catch(() => {});
  return next.catch(() => undefined);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const giveWay = () => new Promise<void>((resolve) => setImmediate(resolve));
const writer = () => g._pgWriter ?? null;

async function untilIdle(w: ShadowWriter): Promise<boolean> {
  for (let i = 0; i < 5 && w.saving; i++) await sleep(250);
  return !w.saving;
}

function rowsOf(result: unknown): Row[] {
  return ((result as { rows?: Row[] })?.rows ?? []) as Row[];
}
const decode = (r: Row) => fromRecord(chat_messages, r) as unknown as ChatRow;
const byId = (a: ChatRow, b: ChatRow) => a.id - b.id;

/** The rows the last save committed, decoded, in id order: each re-read only when its JSON changed. */
function committedRows(w: ShadowWriter): ChatRow[] {
  const s = state();
  if (s.cache && s.cache.gen === w.generation) return s.cache.rows;
  const held = w.committed("chat_messages");
  const map = new Map<string, { json: string; row: ChatRow }>();
  for (const [key, json] of held ?? []) {
    // "" is a row the boot marked to write again (store.ts forget): written before any request, never compared.
    if (!json) continue;
    const was = s.cache?.map.get(key);
    map.set(key, was && was.json === json ? was : { json, row: fromRecord(chat_messages, JSON.parse(json)) as unknown as ChatRow });
  }
  const rows = [...map.values()].map((v) => v.row).sort(byId);
  s.cache = { gen: w.generation, map, rows };
  return rows;
}

type Outcome = { kind: string; diff: unknown; ids: number[]; fields: string[]; rows?: RowsDiff } | null;

async function runRead(job: ReadJob) {
  const s = state();
  const c = queryCount(job.key);
  const w = writer();
  const finish = (outcome: "matched" | "differed" | "explained" | "errored") => {
    c[outcome]++;
    today()[outcome]++;
    s.done[job.key] = (s.done[job.key] ?? 0) + 1;
  };
  try {
    if (!w || !s.readDb) return;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!(await untilIdle(w))) {
        c.raced++;
        return;
      }
      const g0 = w.generation;
      const t0 = performance.now();
      const actual = await query(s.readDb, job.spec);
      const ms = performance.now() - t0;
      if (w.saving || w.generation !== g0) {
        if (attempt === 0) {
          await sleep(1000);
          continue;
        }
        c.raced++;
        return;
      }
      const list = (s.ms[job.key] ??= []);
      list.push(Math.round(ms * 10) / 10);
      if (list.length > 200) list.shift();
      const committed = committedRows(w);
      const outcome = await compareRead(job.spec, actual, committed);
      if (outcome === "skipped") {
        c.skipped++;
        return;
      }
      if (!outcome) finish("matched");
      else if (explained(outcome, committed, actual)) finish("explained");
      else {
        finish("differed");
        report(job.path, outcome);
      }
      return;
    }
  } catch (error) {
    finish("errored");
    failed(job.key, error);
  } finally {
    s.inflight[job.key] = Math.max(0, (s.inflight[job.key] ?? 1) - 1);
  }
}

type Actual = { rows?: ChatRow[]; hit?: boolean; list?: { path: string; type: string }[] };

async function query(db: AnyDb, spec: ReadSpec): Promise<Actual> {
  const t: ChatTable = "chat_messages";
  switch (spec.kind) {
    case "thread":
      return { rows: rowsOf(await db.execute(readSql.thread(t, spec.clientId))).map(decode) };
    case "food":
      return { rows: rowsOf(await db.execute(readSql.food(t, spec.clientId))).map(decode) };
    case "coachSent":
      return { rows: rowsOf(await db.execute(readSql.coachSent(t, spec.clientIds))).map(decode) };
    case "coachLast":
      return { rows: rowsOf(await db.execute(readSql.coachLast(t, spec.clientIds))).map(decode) };
    case "dock": {
      const last = rowsOf(await db.execute(readSql.dockLast(t, spec.clientIds))).map(decode);
      const recent = rowsOf(await db.execute(readSql.dockRecent(t, spec.clientIds, spec.since))).map(decode);
      const merged = new Map<number, ChatRow>();
      for (const m of [...recent, ...last]) merged.set(m.id, m);
      return { rows: [...merged.values()].sort(byId) };
    }
    case "exists":
      return { hit: !!rowsOf(await db.execute(readSql.exists(t, spec.publicPath)))[0]?.hit };
    case "lacksLook":
      return { hit: !!rowsOf(await db.execute(readSql.lacksLook(t, spec.publicPath)))[0]?.hit };
    case "toPrepare":
      return {
        list: rowsOf(await db.execute(readSql.toPrepare(t)))
          .sort((a, b) => Number(a.id) - Number(b.id))
          .map((r) => ({ path: String(r.media_path), type: String(r.media_type) })),
      };
    case "export":
      return { rows: rowsOf(await db.execute(readSql.exportRows(t, spec.clientIds))).map(decode) };
  }
}

/** rowsDiff a thousand rows at a time, giving way to the server between them. */
async function diffRows(want: readonly ChatRow[], got: readonly ChatRow[]): Promise<RowsDiff | null> {
  const fields: Record<number, string[]> = {};
  const found = new Map(got.map((m) => [m.id, m] as const));
  for (let i = 0; i < want.length; i++) {
    const other = found.get(want[i].id);
    const differ = other ? rowFieldsDiff(want[i], other) : null;
    if (differ) fields[want[i].id] = differ;
    if (i % CHUNK === CHUNK - 1) await giveWay();
  }
  return rowsDiffFinish(want, got, fields);
}

/** Its pick over the committed rows against what the query read; null when they agree, "skipped" when too big to. */
async function compareRead(spec: ReadSpec, actual: Actual, committed: ChatRow[]): Promise<Outcome | "skipped"> {
  const rowsOutcome = async (kind: string, want: ChatRow[], got: ChatRow[]): Promise<Outcome | "skipped"> => {
    if (want.length + got.length > ROW_CAP) return "skipped";
    const d = await diffRows(want, got);
    if (!d) return null;
    const ids = [...d.missing, ...d.extra, ...Object.keys(d.fields).map(Number)];
    const fields = [...new Set(Object.values(d.fields).flat())].sort().concat(d.missing.length ? ["missing"] : [], d.extra.length ? ["extra"] : [], d.order ? ["order"] : []);
    return { kind, diff: d, ids, fields, rows: d };
  };
  switch (spec.kind) {
    case "thread":
      return rowsOutcome("thread", pickThread(committed, spec.clientId), actual.rows!);
    case "food":
      return rowsOutcome("food", pickFood(committed, spec.clientId), actual.rows!);
    case "coachSent":
      return rowsOutcome("coachSent", pickCoachSent(committed, new Set(spec.clientIds)), actual.rows!);
    case "coachLast": {
      const ids = new Set(spec.clientIds);
      const last = pickCoachLast(committed, ids);
      await equivHome(committed, spec.clientIds, pickCoachSent(committed, ids), last);
      return rowsOutcome("coachLast", last, actual.rows!);
    }
    case "dock": {
      const want = pickDock(committed, new Set(spec.clientIds), spec.since);
      await equivDock(committed, spec.clientIds, want, spec.since);
      return rowsOutcome("dock", want, actual.rows!);
    }
    case "exists": {
      const want = pickExists(committed, spec.publicPath);
      return want === actual.hit ? null : { kind: "exists", diff: { want }, ids: [], fields: ["hit"] };
    }
    case "lacksLook": {
      const want = pickLacksLook(committed, spec.publicPath);
      return want === actual.hit ? null : { kind: "lacksLook", diff: { want }, ids: [], fields: ["hit"] };
    }
    case "toPrepare": {
      const want = pickToPrepare(committed);
      return stableJson(want) === stableJson(actual.list) ? null : { kind: "toPrepare", diff: { want: want.length, got: actual.list?.length }, ids: [], fields: ["list"] };
    }
    case "export":
      return rowsOutcome("export", pickExport(committed, new Set(spec.clientIds)), actual.rows!);
  }
}

/**
 * Known, not a difference: on a query whose answer rides on a stamp's instant (coachLast, dock), rows only on one side
 * (no field differs, nothing out of order), every one of them a row whose stamp stampMs can't read or reads otherwise
 * than the column (pg/stamps.ts). Any field difference, or any other query, is a difference.
 */
function explained(o: NonNullable<Outcome>, committed: ChatRow[], actual: Actual): boolean {
  const d = o.rows;
  if (!STAMP_KINDS.has(o.kind) || !d || d.order || Object.keys(d.fields).length) return false;
  const ids = [...d.missing, ...d.extra];
  if (!ids.length) return false;
  const all = new Map<number, ChatRow>();
  for (const m of [...committed, ...(actual.rows ?? [])]) if (!all.has(m.id)) all.set(m.id, m);
  return ids.every((id) => {
    const m = all.get(id);
    if (!m) return false;
    const ms = stampMs(String(m.created_at));
    return !Number.isFinite(ms) || stampInstantMs(m.created_at) == null || stampInstantMs(m.created_at) !== ms;
  });
}

/** The narrowed coach slice gives Needs you the same answer as the whole rows (pure JS, no SQL), client by client. */
async function equivHome(committed: ChatRow[], clientIds: number[], sent: ChatRow[], last: ChatRow[]) {
  const e = state().equiv.home;
  try {
    const clients = new Map(getData().clients.map((c) => [c.id, c] as const));
    const ids = new Set(clientIds);
    const whole = groupOf(committed, ids);
    const sentOf = groupOf(sent, ids);
    const lastOf = groupOf(last, ids);
    let i = 0;
    for (const id of clientIds) {
      if (++i % 50 === 0) await giveWay();
      e.checked++;
      const client = clients.get(id);
      const readAt = client?.coach_chat_read_at ? stampMs(client.coach_chat_read_at) : 0;
      const full = chatNeedOf(whole.get(id) ?? [], id, readAt);
      const slice = chatNeedOf([...(sentOf.get(id) ?? []), ...(lastOf.get(id) ?? [])].sort(byId), id, readAt);
      const same = full.lastCoach?.id === slice.lastCoach?.id && stableJson(full.unanswered.map((m) => m.id)) === stableJson(slice.unanswered.map((m) => m.id));
      if (same) e.matched++;
      else {
        e.differed++;
        today().differed++;
        report("equiv.home", { kind: "home", diff: { client: id }, ids: [id], fields: ["needs"] });
      }
    }
  } catch (error) {
    e.errored++;
    today().errored++;
    failed("equiv.home", error);
  }
}

/** The narrowed dock slice gives the chat list the same line as the whole rows (pure JS, no SQL), client by client. */
async function equivDock(committed: ChatRow[], clientIds: number[], slice: ChatRow[], since: number) {
  const e = state().equiv.dock;
  try {
    const clients = new Map(getData().clients.map((c) => [c.id, c] as const));
    const ids = new Set(clientIds);
    const whole = groupOf(committed, ids);
    const part = groupOf(slice, ids);
    // The readers' own window, an hour inside the slice's.
    const window = since + 3_600_000;
    let i = 0;
    for (const id of clientIds) {
      if (++i % 50 === 0) await giveWay();
      e.checked++;
      const seen = clients.get(id)?.coach_seen ?? {};
      const full = dockLineOf(whole.get(id) ?? [], seen, window);
      const sliced = dockLineOf(part.get(id) ?? [], seen, window);
      if (full.last?.id === sliced.last?.id && full.unreadCount === sliced.unreadCount) e.matched++;
      else {
        e.differed++;
        today().differed++;
        report("equiv.dock", { kind: "dock", diff: { client: id }, ids: [id], fields: ["line"] });
      }
    }
  } catch (error) {
    e.errored++;
    today().errored++;
    failed("equiv.dock", error);
  }
}

function report(path: string, o: NonNullable<Outcome>) {
  const s = state();
  s.recent.push({ at: new Date().toISOString(), path, kind: o.kind, fields: o.fields });
  if (s.recent.length > 50) s.recent.shift();
  if (!remember(`${path}:${o.kind}:${stableJson(o.diff)}`)) return;
  // Ids and field names, never a value or a message's words.
  console.error(`[chat] shadow difference on ${path} (${o.kind}): ${JSON.stringify(o.diff).slice(0, 2000)}`);
  if (!s.told.has(path)) {
    s.told.add(path);
    toSentry((S) => S.captureMessage(`Chat shadow difference: ${path}`, { level: "warning", tags: { alert: "chat-shadow-diff", path } }));
  }
}

/**
 * An error's words, safe for the log: Postgres's SQLSTATE and message, drizzle's parameters cut off, and every quoted
 * value in it ("invalid input syntax for type integer: "abc"") put out of sight. Never a message's words or a key.
 */
function safeMessage(error: unknown): string {
  const e = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  const code = (e as { code?: unknown } | null)?.code;
  const words = (e instanceof Error ? e.message : String(e)).split("\nparams:")[0];
  const hidden = words.replace(/"(?:[^"\\]|\\.)*"/g, '"…"').replace(/'(?:[^'\\]|\\.)*'/g, "'…'");
  return `${typeof code === "string" ? `${code} ` : ""}${hidden}`.slice(0, 300);
}

function failed(where: string, error: unknown) {
  const s = state();
  const now = Date.now();
  s.errorsAt = s.errorsAt.filter((t) => now - t < ERROR_WINDOW);
  s.errorsAt.push(now);
  const said = safeMessage(error);
  if (remember(`error:${where}:${said.slice(0, 120)}`)) console.error(`[chat] shadow error on ${where}: ${said}`);
  if (s.errorsAt.length >= ERROR_BURST && now >= s.pausedUntil) {
    s.pausedUntil = now + PAUSE_MS;
    s.paused++;
    s.errorsAt = [];
    console.error(`[chat] ${ERROR_BURST} shadow errors in 10 minutes: paused for 10`);
  }
}

// ---- Writes ------------------------------------------------------------------------------------------------------

/** A mutation memory made (rows.ts), queued by value for the shadow table. Never throws, never waits. */
export function onWrite(spec: WriteSpec, path: ChatWritePath) {
  try {
    const s = state();
    if (!s.write.enabled) return;
    if (s.writeQueue.length >= WRITE_CAP) {
      s.write.enabled = false;
      s.write.overflow++;
      s.writeQueue = [];
      console.error("[chat] the write shadow fell 5000 behind: off until the next boot, which seeds it again");
      return;
    }
    let job: WriteJob;
    try {
      job = writeJob(spec, path);
    } catch (error) {
      // Counted and said, never silent: a mutation the shadow could not even put into SQL.
      writeCount(path).errored++;
      today().errored++;
      failed(path, error);
      return;
    }
    const now = Date.now();
    for (const id of job.touched) s.lastOp.set(id, { path, at: now });
    s.writeQueue.push(job);
    setImmediate(() => void drainWrites());
  } catch {}
}

const json = (v: unknown) => (v == null ? null : cleanJson(v));
/** A text column's value as the writer maps it (store.ts toRecord): a string cleaned, anything else not in the column (null). */
const clean = (v: unknown) => (typeof v === "string" ? cleanText(v) : null);

/** The statement and what it must answer, made now from the values as they are now. */
function writeJob(spec: WriteSpec, path: ChatWritePath): WriteJob {
  const t: ChatTable = "chat_messages_shadow";
  const one = (rows: Row[]) => rows.length === 1;
  const sameIds = (want: number[]) => (rows: Row[]) => stableJson(rows.map((r) => Number(r.id)).sort((a, b) => a - b)) === stableJson([...want].sort((a, b) => a - b));
  switch (spec.op) {
    case "insert": {
      const record = JSON.parse(cleanJson(toRecord(chat_messages, spec.row as unknown as Row)) ?? "null") as Row;
      const extra = { ...((record.extra as Row | null) ?? {}) };
      delete extra.reply_to;
      const onceRecord = spec.once ? (JSON.parse(cleanJson(toRecord(once_keys, { key: spec.once.key, at: spec.once.at })) ?? "null") as Row) : null;
      const p: InsertParams = {
        id: Number(record.id),
        client_id: Number(record.client_id),
        sender: String(record.sender),
        text: record.text as string | null,
        media_path: record.media_path as string | null,
        media_type: record.media_type as string | null,
        created_at: record.created_at as string | null,
        extra: Object.keys(extra).length ? JSON.stringify(extra) : null,
        replyTo: spec.replyTo,
        createdAtTz: stampInstant(spec.row.created_at),
        once: onceRecord ? { key: String(onceRecord.key), at: Number(onceRecord.at), extra: onceRecord.extra == null ? null : JSON.stringify(onceRecord.extra), createdAt: msInstant(spec.once!.at) } : null,
        meal: spec.meal,
      };
      const answered = spec.row.reply_to != null;
      return {
        path,
        query: writeSql.insert(t, "once_keys_shadow", p),
        lock: spec.meal ? writeSql.mealLock(p.client_id, spec.meal.date, spec.meal.meal) : null,
        touched: [p.id],
        check: (rows) => rows.length === 1 && Number(rows[0].id) === p.id && !!rows[0].answered === answered,
      };
    }
    case "react":
      return { path, query: writeSql.react(t, spec.id, spec.clientId, spec.who, spec.emoji), lock: null, touched: [spec.id], check: one };
    case "edit": {
      const was = { text: clean(spec.was.text), at: clean(spec.was.at) };
      return {
        path,
        query: writeSql.edit(t, spec.id, spec.clientId, spec.sender, cleanText(spec.text), spec.editedAt, spec.foodMeal),
        lock: null,
        touched: [spec.id],
        check: (rows) => rows.length === 1 && rows[0].was_text === was.text && rows[0].was_at === was.at,
      };
    }
    case "delete": {
      const was = { text: clean(spec.was.text), at: clean(spec.was.at), media: clean(spec.was.media) };
      return {
        path,
        query: writeSql.remove(t, spec.id, spec.clientId, spec.sender, spec.foodMeal),
        lock: null,
        touched: [spec.id],
        check: (rows) => rows.length === 1 && rows[0].text === was.text && rows[0].created_at === was.at && (rows[0].media_path ?? null) === was.media,
      };
    }
    case "link":
      return { path, query: writeSql.link(t, spec.id, spec.clientId, json(spec.link)), lock: null, touched: [spec.id], check: one };
    case "pin":
      return { path, query: writeSql.pin(t, spec.id, spec.clientId, spec.pinned), lock: null, touched: [spec.id], check: one };
    case "look":
      return { path, query: writeSql.look(t, cleanText(spec.mediaPath), cleanJson(spec.look) ?? "{}"), lock: null, touched: spec.ids, check: sameIds(spec.ids) };
    case "swap":
      return { path, query: writeSql.swap(t, cleanText(spec.from), cleanText(spec.to)), lock: null, touched: spec.ids, check: sameIds(spec.ids) };
    case "clientDelete":
      return { path, query: writeSql.clientDelete(t, spec.clientId), lock: null, touched: spec.ids, check: sameIds(spec.ids) };
    case "wipe":
      return { path, query: writeSql.wipe(t), lock: null, touched: spec.ids, check: sameIds(spec.ids) };
  }
}

async function drainWrites() {
  const s = state();
  // The table compare has the line: it starts the writes again when it is done.
  if (s.writeBusy || s.comparing) return;
  s.writeBusy = true;
  try {
    if (s.seed) await s.seed;
    for (let job = s.writeQueue.shift(); job && s.write.enabled; job = s.writeQueue.shift()) {
      const run = job;
      await onLine(() => runWrite(run));
      if (s.comparing) break;
    }
  } finally {
    s.writeBusy = false;
  }
}

async function runWrite(job: WriteJob) {
  const s = state();
  const c = writeCount(job.path);
  const db = s.writeDb;
  if (!db) return;
  try {
    let result: unknown;
    if (job.lock) {
      const lock = job.lock;
      result = await db.transaction(async (tx) => {
        await tx.execute(lock);
        return tx.execute(job.query);
      });
    } else result = await db.execute(job.query);
    c.applied++;
    if (job.check(rowsOf(result))) {
      c.matched++;
      today().matched++;
    } else {
      c.differed++;
      today().differed++;
      report(job.path, { kind: "write", diff: { touched: job.touched.slice(0, 20), answered: rowsOf(result).length }, ids: job.touched, fields: ["returning"] });
    }
  } catch (error) {
    c.errored++;
    today().errored++;
    failed(job.path, error);
  }
}

/**
 * The real table and the shadow compared (every 10 minutes, 60 s after boot): only with no op waiting or running and no
 * save running, and thrown away when a save landed or an op came meanwhile; while it runs the write line waits (they
 * share a connection, and the rows it puts back must not cross an op on them). An id counts once the real table holds
 * what memory does for it, and it still differs a round later; then it is reported once, credited to the last op on it,
 * and its shadow row put back to the real one. A difference no op touched means something wrote chat rows round the door.
 */
export async function compareTables(): Promise<void> {
  const s = state();
  const w = writer();
  const db = s.writeDb;
  if (!s.write.enabled || !s.write.seeded || !w || !db) return;
  if (s.writeQueue.length || s.writeBusy || s.comparing || w.saving) {
    s.write.table.skipped++;
    return;
  }
  s.comparing = true;
  try {
    await onLine(async () => {
      try {
        const g0 = w.generation;
        const found = rowsOf(await db.execute(shadowSql.compare));
        if (w.generation !== g0 || w.saving || s.writeQueue.length || s.writeBusy) {
          s.write.table.skipped++;
          return;
        }
        const t = s.write.table;
        t.rounds++;
        t.lastAt = new Date().toISOString();
        const committed = w.committed("chat_messages");
        const memory = new Map((getData().chat_messages as unknown as ChatRow[]).map((m) => [m.id, m] as const));
        const still = new Map<number, number>();
        const now = Date.now();
        for (const [id, at] of s.lastOp) if (now - at.at > LAST_OP_KEPT) s.lastOp.delete(id);
        for (const r of found) {
          const id = Number(r.id);
          const mem = memory.get(id);
          const memJson = mem ? cleanJson(toRecord(chat_messages, mem as unknown as Row)) : undefined;
          // The real table not caught up with memory for it yet: next round.
          if (memJson !== committed?.get(String(id))) continue;
          const rounds = (s.pending.get(id) ?? 0) + 1;
          if (rounds < 2) {
            still.set(id, rounds);
            continue;
          }
          t.confirmed++;
          const op = s.lastOp.get(id);
          const fields = ["no_real", "no_shadow", "client_id", "sender", "text", "media_path", "media_type", "created_at", "created_at_tz"].filter((k) => r[k] === true);
          const keys = Array.isArray(r.extra_keys) ? (r.extra_keys as string[]).map((k) => `extra.${k}`) : [];
          const path = op?.path ?? "around-the-door";
          writeCount(path).differed++;
          today().differed++;
          report(path, { kind: "table", diff: { id, fields: [...fields, ...keys] }, ids: [id], fields: [...fields, ...keys] });
          await db.transaction(async (tx) => {
            for (const step of shadowSql.resync(id)) await tx.execute(step);
          });
          t.resynced++;
        }
        s.pending = still;
        t.pending = still.size;
      } catch (error) {
        today().errored++;
        failed("table", error);
      }
    });
  } finally {
    s.comparing = false;
    if (s.writeQueue.length) setImmediate(() => void drainWrites());
  }
}

// ---- The totals, kept between boots --------------------------------------------------------------------------------

function startKeeping() {
  const s = state();
  if (s.keep.on) return;
  s.keep.on = true;
  try {
    s.lag = monitorEventLoopDelay({ resolution: 20 });
    s.lag.enable();
  } catch {
    s.lag = null;
  }
  const every = setInterval(() => keepTotals(), KEEP_EVERY);
  every.unref?.();
}

const ms = (ns: number) => Math.round((ns / 1e6) * 10) / 10;

/** The event loop's delay since the last keep, ms (the shadow must never hold requests up). */
function lagNow() {
  const h = state().lag;
  if (!h || !h.count) return null;
  return { p50: ms(h.percentile(50)), p99: ms(h.percentile(99)), max: ms(h.max) };
}

/** The week's totals from earlier boots, read once (null: none, another week's, or this boot's own). */
function baseTotals(): Totals | null {
  const s = state();
  if (s.keep.base !== undefined) return s.keep.base;
  const stored = getData().chat_shadow_totals as Totals | undefined;
  s.keep.base = stored && stored.v === 1 && stored.week === s.keep.week && stored.boot !== s.keep.boot ? stored : null;
  return s.keep.base;
}

const addCounts = <T extends Record<string, number>>(a: T | undefined, b: T | undefined, zero: () => T): T => {
  const out = { ...zero() } as Record<string, number>;
  for (const src of [a, b]) for (const [k, v] of Object.entries(src ?? {})) if (typeof v === "number") out[k] = (out[k] ?? 0) + v;
  return out as T;
};
function addMaps<T extends Record<string, number>>(a: Record<string, T> | undefined, b: Record<string, T>, zero: () => T): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of new Set([...Object.keys(a ?? {}), ...Object.keys(b)])) out[k] = addCounts(a?.[k], b[k], zero);
  return out;
}

/** The week so far: the earlier boots' totals and this boot's counts. */
function totalsNow(): Totals {
  const s = state();
  let base: Totals | null = null;
  try {
    base = baseTotals();
  } catch {}
  const days: Record<string, DayCount> = {};
  for (const k of new Set([...Object.keys(base?.days ?? {}), ...Object.keys(s.days)])) {
    const a = base?.days?.[k];
    const b = s.days[k];
    const sum = addCounts(a as unknown as Record<string, number>, b as unknown as Record<string, number>, () => ({ matched: 0, differed: 0, explained: 0, errored: 0 }));
    days[k] = { ...(sum as unknown as DayCount), txP90: [...(a?.txP90 ?? []), ...(b?.txP90 ?? [])], lagP99: [...(a?.lagP99 ?? []), ...(b?.lagP99 ?? [])] };
  }
  // `pending` is a gauge of this boot's, never added up.
  const { lastAt: _lastAt, pending: _pending, ...table } = s.write.table;
  void _lastAt;
  void _pending;
  return {
    v: 1,
    week: s.keep.week,
    boot: s.keep.boot,
    boots: (base?.boots ?? 0) + 1,
    since: base?.since ?? s.startedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    paths: addMaps(base?.paths, s.paths, () => ({ seen: 0, missed: 0 })),
    queries: addMaps(base?.queries, s.queries, zeroQuery),
    equiv: { home: addCounts(base?.equiv?.home, s.equiv.home, zeroEquiv), dock: addCounts(base?.equiv?.dock, s.equiv.dock, zeroEquiv) },
    writes: addMaps(base?.writes, s.write.ops, zeroWrite),
    table: { ...addCounts(base?.table, { ...table, pending: 0 }, zeroTable), pending: s.write.table.pending },
    days,
  };
}

/** Every 10 minutes: this window's writer p90 and event loop delay noted for today, and the totals kept in kv. */
export function keepTotals() {
  try {
    const s = state();
    if (!s.keep.on) return;
    const day = today();
    const tx = storeHealth().saveCost.tx?.p90;
    if (typeof tx === "number") day.txP90.push(Math.round(tx * 10) / 10);
    const lag = lagNow();
    if (lag) day.lagP99.push(lag.p99);
    s.lag?.reset();
    const totals = totalsNow();
    getData().chat_shadow_totals = totals;
    s.keep.lastAt = totals.updatedAt;
    persist();
  } catch (error) {
    failed("totals", error);
  }
}

// ---- The report --------------------------------------------------------------------------------------------------

const quantile = (list: number[], q: number) => {
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};

/** What the week's exit asks, from the totals: names and counts only. */
function exitOf(t: Totals) {
  const sum = (field: keyof QueryCount) => Object.values(t.queries).reduce((n, c) => n + (c[field] ?? 0), 0);
  const days = Object.keys(t.days).sort();
  const last3 = days.slice(-3);
  const median = (list: number[]) => quantile(list, 0.5);
  return {
    readPathsNotSeen: CHAT_READ_PATHS.filter((p) => !(t.paths[p]?.seen > 0)),
    readPathsWithNoMatch: CHAT_READ_PATHS.filter((p) => !Object.entries(t.queries).some(([k, c]) => k.startsWith(`${p}:`) && c.matched > 0)),
    queriesNotMatched: Object.keys(t.queries).filter((k) => !(t.queries[k].matched > 0)).sort(),
    writePathsNotMatched: CHAT_WRITE_PATHS.filter((p) => !(t.writes[p]?.matched > 0)),
    matched: sum("matched"),
    differed: sum("differed") + t.equiv.home.differed + t.equiv.dock.differed,
    explained: sum("explained"),
    errored: sum("errored") + t.equiv.home.errored + t.equiv.dock.errored,
    missed: Object.values(t.paths).reduce((n, c) => n + (c.missed ?? 0), 0),
    days: days.map((d) => ({ day: d, matched: t.days[d].matched, differed: t.days[d].differed, explained: t.days[d].explained, errored: t.days[d].errored, txP90: median(t.days[d].txP90), lagP99: quantile(t.days[d].lagP99, 0.99) })),
    erroredLast3Days: last3.reduce((n, d) => n + t.days[d].errored, 0),
  };
}

/** For /api/timing: counts and timings, no ids, no text. Every path is listed, a path never asked with zeros. */
export function chatShadowReport() {
  const s = state();
  const read: Record<string, PathCount & { queries: Record<string, QueryCount & { ms: { p50: number | null; p90: number | null; max: number | null } }> }> = {};
  for (const path of new Set<string>([...CHAT_READ_PATHS, ...Object.keys(s.paths)])) read[path] = { ...(s.paths[path] ?? { seen: 0, missed: 0 }), queries: {} };
  for (const [key, c] of Object.entries(s.queries)) {
    const at = key.lastIndexOf(":");
    const path = key.slice(0, at);
    const list = s.ms[key] ?? [];
    (read[path] ??= { seen: 0, missed: 0, queries: {} }).queries[key.slice(at + 1)] = { ...c, ms: { p50: quantile(list, 0.5), p90: quantile(list, 0.9), max: list.length ? Math.max(...list) : null } };
  }
  const ops: Record<string, WriteCount> = {};
  for (const path of new Set<string>([...CHAT_WRITE_PATHS, ...Object.keys(s.write.ops)])) ops[path] = { ...(s.write.ops[path] ?? zeroWrite()) };
  let total: ReturnType<typeof exitOf> & { week: string; since: string; boots: number; updatedAt: string | null } | null = null;
  try {
    if (s.keep.on) {
      const t = totalsNow();
      total = { week: t.week, since: t.since, boots: t.boots, updatedAt: s.keep.lastAt, ...exitOf(t) };
    }
  } catch {}
  return {
    mode: s.mode,
    views: s.views,
    sampleEvery: s.sampleEvery,
    startedAt: s.startedAt,
    paused: s.paused,
    pausedUntil: s.pausedUntil > Date.now() ? new Date(s.pausedUntil).toISOString() : null,
    // This boot's counts.
    read,
    equiv: { home: { ...s.equiv.home }, dock: { ...s.equiv.dock } },
    write: { enabled: s.write.enabled, seeded: s.write.seeded, overflow: s.write.overflow, queue: s.writeQueue.length, ops, table: { ...s.write.table } },
    queue: { read: s.readQueue.length, write: s.writeQueue.length },
    lag: lagNow(),
    logged: { kinds: s.logged.size, suppressed: s.suppressed },
    recent: s.recent.map((r) => ({ ...r, fields: [...r.fields] })),
    // The week's, across boots (baseline, read, write): what the exit reads.
    total,
  };
}

/** Waits for both queues to empty (the tests). */
export async function shadowSettled(timeoutMs = 30_000): Promise<boolean> {
  const s = state();
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (!s.readQueue.length && !s.writeQueue.length && !s.readBusy && !s.writeBusy && !s.comparing) {
      await s.oneLine;
      if (!s.readQueue.length && !s.writeQueue.length && !s.readBusy && !s.writeBusy && !s.comparing) return true;
    }
    await sleep(50);
  }
  return false;
}
