// The notifications' shadow week (quest 7), on chat's pattern (app/lib/chat/shadow.ts; its file untouched): beside the
// door's fetches and writes, the SQL that will replace them (statements.ts) runs against Postgres and every difference
// is counted and logged with ids and field names, never words.
//
//   NOTES_SHADOW=off       (the default) no query runs; the door still counts each path it is asked through. At boot the
//                          shadow table is emptied should it hold rows.
//   NOTES_SHADOW=baseline  as off, and the totals kept (below): the week before, for the writer's times.
//   NOTES_SHADOW=read      a sample of the fetches (each query's first 3, then 1 in NOTES_SHADOW_SAMPLE, 20 by default;
//                          NOTES_SHADOW_RATE a second, 2 by default; NOTES_SHADOW_QUEUE waiting at most, 32; one never
//                          compared yet is never dropped) also runs its query, compared with what the last save committed
//                          (the writer's snapshot, never live memory). A newest read also checks the page's cuts (the
//                          bell, the chat's unread, the list's 300) from the 500 against the client's whole rows (equiv.page).
//   NOTES_SHADOW=write     as read, and every write also runs its statement on coach_activity_shadow (seeded at boot,
//                          its twins on (client, key) left out), its answer compared with memory's, and the two tables
//                          compared every 10 minutes (then resynced). Staging only: on the live server it runs as read.
//   NOTES_STORE=pg         read and write run as baseline (nothing in memory to compare with).
//
// Never on a request's path: a fetch or a write only counts and queues (no await, no throw, try/catch round all of it);
// the queue drains behind the answer one job at a time, on a pool of 2 (Postgres, 3 s statement timeout) or, on pglite,
// the store's own database while no save runs. 50 errors in 10 minutes pause it for 10. Counted per path and per query
// (`page.client:newest`); every 10 minutes (baseline, read, write) the totals are kept in kv as `notes_shadow_totals`,
// NOTES_SHADOW_WEEK (a label) starting them afresh. On /api/timing under `notes`, counts and names only.

import { getData, persist, type NoteRow } from "../db";
import { coach_activity } from "../pg/schema";
import { fromRecord } from "../pg/store";
import { storeHealth } from "../pg/health";
import { isListed } from "../notificationTypes";
import type { NoteOp, Outcome } from "./apply";
import { NOTES_PG } from "./mode";
import { NOTES_READ_PATHS, NOTES_WRITE_PATHS, type NotesPath, type NotesReadPath, type NotesWritePath } from "./paths";
import { chatNoteOf, inFamily, isStrayStamp, keyedRow, newestFirst, newestOf, stableJson, unreadReminderClients, type ChatNoteAsk } from "./pick";
import { readSql, REMINDER_PART, writeSql, type NotesTable } from "./statements";
import { runOp, type Drained } from "./outbox";
import { pruneOn, type PruneSpec } from "./prune";
import type { notesWrite } from "./pg";
import { sql, type SQL } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyDb = PgDatabase<any, any, any>;
type Row = Record<string, unknown>;
type KeySpec = { keys?: readonly string[]; family?: { prefix: string; suffix: string } };

export type NotesReadSpec =
  | { kind: "newest"; clientId: number; n: number }
  | { kind: "keys"; clientId: number; spec: KeySpec }
  | { kind: "owner"; id: number }
  | { kind: "chatNote"; msg: ChatNoteAsk }
  | { kind: "unreadClients" }
  | { kind: "reminderState"; clientIds: number[]; pairs: { clientId: number; key: string }[] }
  | { kind: "export"; clientIds: number[] };

export type ShadowWriter = { readonly generation: number; readonly saving: boolean; committed(name: string): ReadonlyMap<string, string> | undefined };

const ASKED = (process.env.NOTES_SHADOW ?? "").trim() || "off";
const PRODUCTION = !!(process.env.RAILWAY_ENVIRONMENT_NAME === "production" || (process.env.RAILWAY_ENVIRONMENT && !process.env.RAILWAY_ENVIRONMENT_NAME?.includes("staging")));
const KNOWN = ["off", "baseline", "read", "write"];
const MODE: "off" | "baseline" | "read" | "write" = !KNOWN.includes(ASKED)
  ? "off"
  : NOTES_PG
    ? ASKED === "off"
      ? "off"
      : "baseline"
    : ASKED === "write" && PRODUCTION
      ? "read"
      : (ASKED as "off" | "baseline" | "read" | "write");
const SAMPLE = Math.max(1, Number(process.env.NOTES_SHADOW_SAMPLE) || 20);
const RATE = Math.max(1, Number(process.env.NOTES_SHADOW_RATE) || 2);
const QUEUE = Math.max(4, Number(process.env.NOTES_SHADOW_QUEUE) || 32);
const WEEK = (process.env.NOTES_SHADOW_WEEK ?? "").trim() || "unnamed";
const PAUSE_AFTER = 50;
const PAUSE_MS = 10 * 60_000;
const ROUND_MS = 10 * 60_000;

type QCount = { sampled: number; matched: number; differed: number; raced: number; errored: number; dropped: number; msTotal: number; msMax: number };
type WCount = { seen: number; sampled: number; matched: number; differed: number; errored: number };
type Job = { run: () => Promise<void>; first: boolean };
type State = {
  db: AnyDb | null;
  pglite: boolean;
  writer: ShadowWriter | null;
  seen: Record<string, number>;
  missed: Record<string, number>;
  errors: Record<string, number>;
  queries: Record<string, QCount>;
  writes: Record<string, WCount>;
  families: Record<string, number>;
  logged: Set<string>;
  queue: Job[];
  busy: boolean;
  tokens: number;
  tokensAt: number;
  errorTimes: number[];
  pausedUntil: number;
  tables: { rounds: number; clean: number; differed: number; lastAt: string | null };
  startedAt: string;
};
const g = globalThis as unknown as { __norcoachNotesShadow?: State };
const state = (): State =>
  (g.__norcoachNotesShadow ??= {
    db: null,
    pglite: false,
    writer: null,
    seen: {},
    missed: {},
    errors: {},
    queries: {},
    writes: {},
    families: {},
    logged: new Set(),
    queue: [],
    busy: false,
    tokens: RATE,
    tokensAt: Date.now(),
    errorTimes: [],
    pausedUntil: 0,
    tables: { rounds: 0, clean: 0, differed: 0, lastAt: null },
    startedAt: new Date().toISOString(),
  });

const quietly = (fn: () => void) => {
  try {
    fn();
  } catch {
    /* the shadow never throws into a request */
  }
};
const say = (kind: string, message: string) => {
  const s = state();
  if (s.logged.has(kind) || s.logged.size > 500) return;
  s.logged.add(kind);
  console.log(`[notes-shadow] ${message}`);
};
/** Postgres's code and message, every quoted value hidden (no words reach the log). */
const safe = (error: unknown) => {
  const e = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  const code = (e as { code?: unknown } | null)?.code;
  const words = (e instanceof Error ? e.message : String(e)).split("\nparams:")[0].replace(/"(?:[^"\\]|\\.)*"/g, '"…"').replace(/'(?:[^'\\]|\\.)*'/g, "'…'");
  return `${typeof code === "string" ? `${code} ` : ""}${words}`.slice(0, 200);
};

// ---- Counting (always on) -------------------------------------------------------------------------------------------

export function noteSeen(path: NotesPath) {
  quietly(() => {
    const s = state();
    s.seen[path] = (s.seen[path] ?? 0) + 1;
  });
}
export function noteMissed(path: NotesReadPath, message: string) {
  quietly(() => {
    const s = state();
    s.missed[path] = (s.missed[path] ?? 0) + 1;
    say(`miss:${path}`, `a view miss on ${path}: ${message}`);
    if (process.env.RAILWAY_ENVIRONMENT) void import("../pg/health").then((h) => h.toSentry((S) => S.captureMessage(`Notes view miss: ${path}`, { level: "warning", tags: { alert: "notes-view-miss" } }))).catch(() => {});
  });
}
export function noteErrored(path: NotesReadPath, error: unknown) {
  quietly(() => {
    const s = state();
    s.errors[path] = (s.errors[path] ?? 0) + 1;
    say(`err:${path}`, `a read failed on ${path}: ${safe(error)}`);
    if (NOTES_PG) void import("../pg/health").then((h) => h.toSentry((S) => S.captureMessage(`Notes read failed: ${path}`, { level: "error", tags: { alert: "notes-pg-read" } }))).catch(() => {});
  });
}

const qc = (key: string): QCount => (state().queries[key] ??= { sampled: 0, matched: 0, differed: 0, raced: 0, errored: 0, dropped: 0, msTotal: 0, msMax: 0 });
const wc = (path: string): WCount => (state().writes[path] ??= { seen: 0, sampled: 0, matched: 0, differed: 0, errored: 0 });
/** A write's family: its key's first word, or its kind and tab (keyless). Counted, informational. */
const familyOf = (op: NoteOp | null) => {
  if (!op) return "client";
  if (op.op !== "insert") return op.op;
  return op.row.dedupe_key ? op.row.dedupe_key.split(":")[0] : `${op.row.kind}:${op.row.action_tab ?? "-"}`;
};

// ---- The queue ------------------------------------------------------------------------------------------------------

function take(first: boolean): boolean {
  const s = state();
  if (Date.now() < s.pausedUntil) return false;
  const now = Date.now();
  s.tokens = Math.min(RATE, s.tokens + ((now - s.tokensAt) / 1000) * RATE);
  s.tokensAt = now;
  if (first) return s.queue.filter((j) => j.first).length < 2;
  if (s.tokens < 1 || s.queue.length >= QUEUE) return false;
  s.tokens--;
  return true;
}
function push(job: Job) {
  const s = state();
  s.queue.push(job);
  if (!s.busy) void pump();
}
async function pump() {
  const s = state();
  s.busy = true;
  try {
    while (s.queue.length) {
      const job = s.queue.shift()!;
      if (s.pglite) while (s.writer?.saving) await new Promise((r) => setTimeout(r, 20));
      try {
        await job.run();
      } catch {
        /* counted by the job */
      }
      await new Promise((r) => setImmediate(r));
    }
  } finally {
    s.busy = false;
  }
}
function errored() {
  const s = state();
  const now = Date.now();
  s.errorTimes = s.errorTimes.filter((t) => now - t < PAUSE_MS);
  s.errorTimes.push(now);
  if (s.errorTimes.length >= PAUSE_AFTER) {
    s.pausedUntil = now + PAUSE_MS;
    s.errorTimes = [];
    console.error(`[notes-shadow] ${PAUSE_AFTER} errors in 10 minutes: paused for 10`);
  }
}
const rowsOf = (r: unknown): Row[] => ((r as { rows?: Row[] })?.rows ?? []) as Row[];
async function q(query: SQL): Promise<Row[]> {
  const d = state().db;
  if (!d) throw new Error("no shadow connection");
  return rowsOf(await d.execute(query));
}

/**
 * What the last save committed, decoded, in the store's order: decoded once per save (the writer's generation), not
 * once per sample, so a sample's cost on the main thread doesn't grow with every compare it makes. Read only: nothing
 * that takes it changes a row.
 */
let decoded: { gen: number; map: ReadonlyMap<string, string>; rows: NoteRow[] } | null = null;
function committedRows(): NoteRow[] {
  const w = state().writer;
  const m = w?.committed("coach_activity");
  if (!w || !m) return [];
  if (decoded && decoded.gen === w.generation && decoded.map === m) return decoded.rows;
  const out: NoteRow[] = [];
  for (const json of m.values()) if (json) out.push(fromRecord(coach_activity, JSON.parse(json) as Row) as unknown as NoteRow);
  decoded = { gen: w.generation, map: m, rows: out };
  return out;
}
const decode = (r: Row) => fromRecord(coach_activity, r) as unknown as NoteRow;

// ---- Reads ----------------------------------------------------------------------------------------------------------

const T: NotesTable = "coach_activity";
const inSpec = (r: NoteRow, clientId: number, spec: KeySpec) =>
  r.client_id === clientId && typeof r.dedupe_key === "string" && ((spec.keys?.includes(r.dedupe_key) ?? false) || (spec.family ? inFamily(r.dedupe_key, spec.family) : false));

/** The SQL's answer and memory's (the committed rows) for one fetch, as comparable values. */
async function both(spec: NotesReadSpec): Promise<{ got: unknown; want: () => unknown; extra?: (all: NoteRow[]) => [unknown, unknown] }> {
  switch (spec.kind) {
    case "newest": {
      const all0 = committedRows();
      const stray = all0.some((r) => r.client_id === spec.clientId && isStrayStamp(r.created_at));
      const raw = stray ? await q(readSql.whole(T, spec.clientId)) : await q(readSql.newest(T, spec.clientId, spec.n));
      const got = (stray ? raw.map(decode).sort(newestFirst) : raw.map(decode)).slice(0, spec.n);
      return {
        got,
        want: () => newestOf(committedRows(), spec.clientId, spec.n),
        // equiv.page: the page's cuts from the slice against the client's whole rows.
        extra: (all) => {
          const whole = newestOf(all, spec.clientId, Infinity);
          const cuts = (list: NoteRow[]) => ({
            bell: list.slice(0, 50).some((n) => isListed({ ...n, kind: n.kind ?? "general" } as never) && !(n.read ?? true)),
            unread: list.slice(0, 50).filter((n) => n.kind === "coach_note" && !(n.read ?? true)).length,
            list: list.slice(0, 300).map((n) => n.id),
            arrival: list.slice(0, 500).map((n) => n.id),
          });
          return [cuts(got), cuts(whole)];
        },
      };
    }
    case "keys": {
      const lists: Row[][] = [];
      if (spec.spec.keys?.length) lists.push(await q(readSql.keys(T, spec.clientId, spec.spec.keys)));
      if (spec.spec.family) lists.push(await q(readSql.family(T, spec.clientId, spec.spec.family.prefix, spec.spec.family.suffix)));
      const m = new Map<number, NoteRow>();
      for (const l of lists) for (const r of l) m.set(Number(r.id), decode(r));
      const got = [...m.values()].sort((a, b) => a.id - b.id).filter((r) => inSpec(r, spec.clientId, spec.spec));
      const keys = [...new Set(got.map((r) => r.dedupe_key!))].sort();
      return {
        got: keys.map((k) => keyedRow(got, spec.clientId, k)),
        want: () => {
          const rows = committedRows().filter((r) => inSpec(r, spec.clientId, spec.spec));
          return [...new Set(rows.map((r) => r.dedupe_key!))].sort().map((k) => keyedRow(rows, spec.clientId, k));
        },
      };
    }
    case "owner": {
      const got = (await q(readSql.owner(T, spec.id)))[0];
      return { got: got ? Number(got.client_id) : null, want: () => committedRows().find((a) => a.id === spec.id)?.client_id ?? null };
    }
    case "chatNote": {
      const rows = (await q(readSql.chatNote(T, spec.msg.client_id, spec.msg.id, spec.msg.unknown ? null : spec.msg.text))).map(decode).sort((a, b) => a.id - b.id);
      return { got: chatNoteOf(rows, spec.msg)?.id ?? null, want: () => chatNoteOf(committedRows(), spec.msg)?.id ?? null };
    }
    case "unreadClients": {
      const got = (await q(readSql.unreadClients(T))).map((r) => Number(r.client_id));
      return { got, want: () => unreadReminderClients(committedRows()) };
    }
    case "reminderState": {
      const ids = new Set(spec.clientIds);
      const pairs = new Set(spec.pairs.map((p) => `${p.clientId}\u0000${p.key}`));
      const wanted = (r: NoteRow) => ids.has(r.client_id) && ((typeof r.dedupe_key === "string" && pairs.has(`${r.client_id}\u0000${r.dedupe_key}`)) || (r.kind === "reminder" && !r.read));
      const m = new Map<number, NoteRow>();
      // The door's two statements, in its parts.
      for (let i = 0; i < spec.pairs.length; i += REMINDER_PART) for (const r of await q(readSql.reminderKeys(T, spec.pairs.slice(i, i + REMINDER_PART)))) m.set(Number(r.id), decode(r));
      for (let i = 0; i < spec.clientIds.length; i += REMINDER_PART) for (const r of await q(readSql.unreadReminders(T, spec.clientIds.slice(i, i + REMINDER_PART)))) m.set(Number(r.id), decode(r));
      const got = [...m.values()].sort((a, b) => a.id - b.id).filter(wanted);
      return { got, want: () => committedRows().filter(wanted) };
    }
    case "export": {
      const ids = new Set(spec.clientIds);
      const got = spec.clientIds.length ? (await q(readSql.export(T, spec.clientIds))).map(decode) : [];
      return { got, want: () => committedRows().filter((r) => ids.has(r.client_id)) };
    }
  }
}

const tried = new Set<string>();
export function onFetch(spec: NotesReadSpec, path: NotesReadPath) {
  quietly(() => {
    if (MODE !== "read" && MODE !== "write") return;
    const s = state();
    if (!s.db || !s.writer) return;
    const key = `${path}:${spec.kind}`;
    const c = qc(key);
    const first = !tried.has(key);
    const sample = first || c.sampled < 3 || Math.random() < 1 / SAMPLE;
    if (!sample) return;
    if (!take(first)) {
      c.dropped++;
      return;
    }
    tried.add(key);
    push({ first, run: () => readJob(spec, key) });
  });
}

async function readJob(spec: NotesReadSpec, key: string, again = false): Promise<void> {
  const s = state();
  const c = qc(key);
  const gen = s.writer!.generation;
  const t0 = performance.now();
  let answer: Awaited<ReturnType<typeof both>>;
  try {
    answer = await both(spec);
  } catch (error) {
    c.errored++;
    errored();
    say(`qerr:${key}`, `${key} failed: ${safe(error)}`);
    return;
  }
  const ms = performance.now() - t0;
  if (s.writer!.generation !== gen || s.writer!.saving) {
    if (!again) return readJob(spec, key, true);
    c.raced++;
    return;
  }
  c.sampled++;
  c.msTotal += ms;
  c.msMax = Math.max(c.msMax, ms);
  const want = answer.want();
  if (stableJson(answer.got) === stableJson(want)) c.matched++;
  else {
    c.differed++;
    say(`diff:${key}`, `${key} differs (${describe(answer.got, want)})`);
  }
  if (answer.extra) {
    const e = qc("equiv.page:page");
    const [a, b] = answer.extra(committedRows());
    e.sampled++;
    if (stableJson(a) === stableJson(b)) e.matched++;
    else {
      e.differed++;
      say("diff:equiv.page", "equiv.page differs: the 500's cuts and the whole rows' cuts disagree");
    }
  }
}
/** Ids and field names only. */
function describe(got: unknown, want: unknown): string {
  const ids = (v: unknown) => (Array.isArray(v) ? v.map((r) => (r && typeof r === "object" ? (r as Row).id : r)) : [v]);
  const a = ids(got);
  const b = ids(want);
  const missing = b.filter((x) => !a.includes(x)).slice(0, 10);
  const extra = a.filter((x) => !b.includes(x)).slice(0, 10);
  const fields = new Set<string>();
  if (Array.isArray(got) && Array.isArray(want)) {
    const gm = new Map(got.filter((r) => r && typeof r === "object").map((r) => [(r as Row).id, r as Row]));
    for (const w of want) {
      if (!w || typeof w !== "object") continue;
      const o = gm.get((w as Row).id);
      if (!o) continue;
      for (const f of new Set([...Object.keys(o), ...Object.keys(w as Row)])) if (stableJson(o[f]) !== stableJson((w as Row)[f])) fields.add(f);
    }
  }
  return `missing ids ${missing.join(",") || "none"}, extra ids ${extra.join(",") || "none"}, fields ${[...fields].join(",") || "none"}`;
}

// ---- Writes ---------------------------------------------------------------------------------------------------------

/** `forClient`: whose rows a write with no op takes (a client erased); none for the reset. */
export function onWrite(path: NotesWritePath, op: NoteOp | null, outcome: Outcome | "queued", row?: NoteRow, forClient: number | null = null) {
  quietly(() => {
    const c = wc(path);
    c.seen++;
    const s = state();
    const fam = familyOf(op);
    s.families[fam] = (s.families[fam] ?? 0) + 1;
    if (MODE !== "write" || !s.db || outcome === "queued") return;
    // The op as memory resolved it: an insert with the id and stamp it took, a replace or a merge as it left the row.
    const resolved: NoteOp | null = op && op.op === "insert" && row ? { ...op, row: { ...row } } : op ? structuredClone(op) : null;
    const clientId = op ? (op.op === "insert" ? op.row.client_id : op.clientId) : forClient;
    push({ first: false, run: () => writeJob(path, resolved, outcome, row ? { ...row } : undefined, clientId) });
  });
}

const SH: NotesTable = "coach_activity_shadow";
/** notesWrite's shape on the shadow's own connection: no order, no retry (a failure is counted, never retried). */
const shadowWrite = (async (_key: string | null, work: { op: string; run: (q: (query: SQL) => Promise<Row[]>, inTx: <U>(fn: (q: (query: SQL) => Promise<Row[]>) => Promise<U>) => Promise<U>) => Promise<unknown> }) =>
  work.run(q, async (fn) => {
    const d = state().db;
    if (!d) throw new Error("no shadow connection");
    return d.transaction(async (tx) => fn(async (query) => rowsOf(await (tx as unknown as AnyDb).execute(query))));
  })) as unknown as typeof notesWrite;

/**
 * A write on the shadow's table, as the drainer will run it with NOTES_STORE=pg: the op through outbox.ts runOp (its
 * keyed insert, the lock, applyOp on the locked row, the update; each other op's statement), its outcome compared with
 * memory's. An insert carries memory's id and stamp; a replace or a merge an id no row holds and memory's new stamp, so
 * the key alone decides, as it will. A keep is only looked at (the key there), so a shadow out of step gets no stray row.
 */
async function writeJob(path: NotesWritePath, op: NoteOp | null, outcome: Outcome | "queued", row: NoteRow | undefined, clientId: number | null) {
  const c = wc(path);
  try {
    let ok: boolean;
    if (!op) {
      if (path === "w.wipe") await q(writeSql.wipe(SH));
      else if (clientId != null) await q(writeSql.clientDelete(SH, clientId));
      ok = true;
    } else if (op.op === "insert" && outcome === "kept") {
      ok = (await q(readSql.keys(SH, op.row.client_id, [op.row.dedupe_key ?? ""]))).length > 0;
    } else if (op.op === "insert") {
      if (!row) throw new Error("an insert with no row");
      const r: NoteRow = { ...row };
      if (outcome !== "inserted") r.id = -1;
      const got: Drained = await runOp({ ...op, row: r }, SH, shadowWrite, null);
      ok = got === outcome;
      // A replace or a merge the shadow took as an insert (it lacked the key): its stray row out again at once.
      if (!ok && r.id === -1 && got === "inserted") await q(writeSql.delete(SH, r.client_id, -1));
    } else {
      const got: Drained = await runOp(op, SH, shadowWrite, null);
      // Mark-all-read answers "changed" in memory whatever it found; the statement only for rows not read yet.
      ok = op.op === "readAll" ? got === "changed" || got === "none" : got === outcome;
    }
    c.sampled++;
    if (ok) c.matched++;
    else {
      c.differed++;
      say(`wdiff:${path}`, `${path} on the shadow table answered otherwise than memory (${op?.op ?? "client"}${row ? `, id ${row.id}` : ""})`);
    }
  } catch (error) {
    c.errored++;
    errored();
    say(`werr:${path}`, `${path} on the shadow table failed: ${safe(error)}`);
  }
}

/** A clean-up compared and not yet in a save (19 Nov): the table round waits for it (compareTables), so the save
 *  coming after it is never counted as the shadow differing. */
const pruneHold = { jobs: 0, ids: new Set<number>() };

/**
 * The nightly clean-up (19 Nov, notes/prune.ts), counted as `w.reminders.prune`. Memory mode with the write shadow: the
 * statements NOTES_STORE=pg would run (pruneOn) on the shadow table with the same rule, keep list and cap, the ids they
 * delete compared with those memory took off. An id memory took and the shadow table never held (a twin seedShadow
 * left out, the lowest id kept) is no difference. `ids` null: pg mode, counted only.
 */
export function onPrune(spec: PruneSpec, ids: readonly number[] | null) {
  quietly(() => {
    const path: NotesWritePath = "w.reminders.prune";
    const c = wc(path);
    c.seen++;
    const s = state();
    s.families.prune = (s.families.prune ?? 0) + 1;
    if (MODE !== "write" || !s.db || ids == null) return;
    const want = [...ids].sort((a, b) => a - b);
    pruneHold.jobs++;
    for (const id of want) pruneHold.ids.add(id);
    push({
      first: false,
      run: async () => {
        try {
          const got = await pruneOn(SH, spec, async (fn) => {
            const d = state().db;
            if (!d) throw new Error("no shadow connection");
            return d.transaction(async (tx) => {
              const tq = async (query: SQL) => rowsOf(await (tx as unknown as AnyDb).execute(query));
              await tq(writeSql.longStatement());
              return fn(tq);
            });
          });
          const gs = new Set(got);
          let missing = want.filter((x) => !gs.has(x));
          if (missing.length) {
            const held = new Set((await q(sql`SELECT id FROM coach_activity_shadow WHERE id IN (SELECT (v)::int FROM jsonb_array_elements_text(${JSON.stringify(missing)}::jsonb) v)`)).map((r) => Number(r.id)));
            missing = missing.filter((x) => held.has(x));
          }
          const ws = new Set(want);
          const extra = got.filter((x) => !ws.has(x));
          c.sampled++;
          if (!missing.length && !extra.length) c.matched++;
          else {
            c.differed++;
            say(`wdiff:${path}`, `${path} on the shadow table took ${got.length} rows, memory ${want.length} (missing ids ${missing.slice(0, 10).join(",") || "none"}, extra ids ${extra.slice(0, 10).join(",") || "none"})`);
          }
        } catch (error) {
          c.errored++;
          errored();
          say(`werr:${path}`, `${path} on the shadow table failed: ${safe(error)}`);
        } finally {
          pruneHold.jobs--;
        }
      },
    });
  });
}

/** The shadow table against what the last save committed, by id; differences said (ids only), then resynced. */
export async function compareTables(): Promise<void> {
  const s = state();
  if (MODE !== "write" || !s.db || !s.writer) return;
  if (s.writer.saving) return;
  // A clean-up compared and not yet in a save: the round waits (not counted), so the shadow ahead of it never differs.
  if (pruneHold.jobs > 0) return;
  if (pruneHold.ids.size) {
    if (committedRows().some((r) => pruneHold.ids.has(r.id))) return;
    pruneHold.ids.clear();
  }
  const gen = s.writer.generation;
  const want = new Map(committedRows().map((r) => [r.id, stableJson(r)]));
  const got = new Map((await q(sql`SELECT * FROM coach_activity_shadow ORDER BY id`)).map((r) => [Number(r.id), stableJson(decode(r))]));
  if (s.writer.generation !== gen) return;
  const diff: number[] = [];
  for (const [id, j] of want) if (got.get(id) !== j) diff.push(id);
  for (const id of got.keys()) if (!want.has(id)) diff.push(id);
  s.tables.rounds++;
  s.tables.lastAt = new Date().toISOString();
  if (!diff.length) {
    s.tables.clean++;
    return;
  }
  s.tables.differed += diff.length;
  console.log(`[notes-shadow] the shadow table differs from coach_activity on ${diff.length} ids (${diff.slice(0, 20).join(",")}): resynced`);
  await seedShadow();
}

/** The shadow table made the real one, its twins on (client, key) left out (its unique rule; the lowest id kept). */
async function seedShadow() {
  await q(sql`DELETE FROM coach_activity_shadow`);
  await q(sql`INSERT INTO coach_activity_shadow SELECT * FROM coach_activity c WHERE c.dedupe_key IS NULL
              OR c.id = (SELECT min(id) FROM coach_activity d WHERE d.client_id = c.client_id AND md5(d.dedupe_key) = md5(c.dedupe_key) AND d.dedupe_key = c.dedupe_key)`);
}

// ---- Boot, totals, report -------------------------------------------------------------------------------------------

export async function startNotesShadow(opts: { db: AnyDb; url: string; writer: ShadowWriter }): Promise<void> {
  const s = state();
  s.writer = opts.writer;
  if (!KNOWN.includes(ASKED)) console.error(`[notes-shadow] NOTES_SHADOW=${ASKED} is not off, baseline, read or write: off`);
  if (MODE === "read" || MODE === "write") {
    if (opts.url.startsWith("pglite:")) {
      s.db = opts.db;
      s.pglite = true;
    } else {
      const { Pool } = await import("pg");
      const { drizzle } = await import("drizzle-orm/node-postgres");
      const pool = new Pool({ connectionString: opts.url, max: 2, application_name: "norcoach-notes-shadow", options: "-c statement_timeout=3000" });
      pool.on("error", () => {});
      s.db = drizzle(pool) as unknown as AnyDb;
    }
  } else s.db = opts.db;
  try {
    if (MODE === "write") {
      await seedShadow();
      setInterval(() => void compareTables().catch((e) => say("cmp", `the table compare failed: ${safe(e)}`)), ROUND_MS).unref?.();
    } else if (!NOTES_PG && (await q(sql`SELECT 1 FROM coach_activity_shadow LIMIT 1`)).length) {
      await q(sql`DELETE FROM coach_activity_shadow`);
      console.log("[notes-shadow] the shadow table held rows with the write shadow off: emptied");
    }
  } catch (error) {
    console.error(`[notes-shadow] the shadow table could not be set up: ${safe(error)}`);
  }
  if (MODE === "read" || MODE === "write") console.log(`[notes-shadow] ${MODE}: 1 in ${SAMPLE}, ${RATE}/s, queue ${QUEUE}`);
  if (MODE !== "off") setInterval(() => quietly(keepTotals), ROUND_MS).unref?.();
  if (MODE === "read" || MODE === "write") return;
  s.db = null;
}

type Totals = { week: string; since: string; days: Record<string, { matched: number; differed: number; errored: number; txP90: number | null }>; queries: Record<string, QCount>; writes: Record<string, WCount>; seen: Record<string, number>; missed: Record<string, number> };
let kept: { at: string; base: Totals } | null = null;
function baseTotals(): Totals {
  if (kept) return kept.base;
  const stored = getData().notes_shadow_totals as Totals | undefined;
  const base: Totals = stored && stored.week === WEEK ? stored : { week: WEEK, since: new Date().toISOString(), days: {}, queries: {}, writes: {}, seen: {}, missed: {} };
  kept = { at: new Date().toISOString(), base: structuredClone(base) };
  return kept.base;
}
const add = <V extends Record<string, number>>(a: Record<string, V>, b: Record<string, V>) => {
  const out: Record<string, V> = structuredClone(a);
  for (const [k, v] of Object.entries(b)) {
    const o = (out[k] ??= Object.fromEntries(Object.keys(v).map((f) => [f, 0])) as V);
    for (const [f, n] of Object.entries(v)) (o as Record<string, number>)[f] = f === "msMax" ? Math.max((o as Record<string, number>)[f] ?? 0, n) : ((o as Record<string, number>)[f] ?? 0) + n;
  }
  return out;
};
const addN = (a: Record<string, number>, b: Record<string, number>) => {
  const out = { ...a };
  for (const [k, n] of Object.entries(b)) out[k] = (out[k] ?? 0) + n;
  return out;
};
function totalsNow(): Totals {
  const s = state();
  const base = baseTotals();
  const sum = Object.values(s.queries).reduce((t, c) => ({ matched: t.matched + c.matched, differed: t.differed + c.differed, errored: t.errored + c.errored }), { matched: 0, differed: 0, errored: 0 });
  const day = new Date().toISOString().slice(0, 10);
  const days = structuredClone(base.days);
  const was = days[day] ?? { matched: 0, differed: 0, errored: 0, txP90: null };
  let txP90: number | null = null;
  try {
    txP90 = storeHealth().saveCost.tx?.p90 ?? null;
  } catch {
    txP90 = null;
  }
  days[day] = { matched: was.matched + sum.matched, differed: was.differed + sum.differed, errored: was.errored + sum.errored, txP90 };
  return { week: WEEK, since: base.since, days, queries: add(base.queries, s.queries), writes: add(base.writes, s.writes), seen: addN(base.seen, s.seen), missed: addN(base.missed, s.missed) };
}
/** Every 10 minutes: the week's totals so far into kv (counts and names only). */
export function keepTotals() {
  if (MODE === "off") return;
  getData().notes_shadow_totals = totalsNow();
  persist();
}

/** For /api/timing: counts and names, never ids or words. */
export function notesShadowReport(extra: Record<string, unknown> = {}) {
  const s = state();
  const total = MODE === "off" ? null : totalsNow();
  const reads = total ?? { queries: s.queries, writes: s.writes, seen: s.seen, missed: s.missed };
  const readPathsNotSeen = NOTES_READ_PATHS.filter((p) => !(reads.seen[p] ?? 0) && p !== "equiv.page");
  const matchedPaths = new Set(Object.entries(reads.queries).filter(([, c]) => c.matched > 0).map(([k]) => k.split(":")[0]));
  const readPathsWithNoMatch = NOTES_READ_PATHS.filter((p) => !matchedPaths.has(p));
  const queriesNotMatched = Object.entries(reads.queries).filter(([, c]) => c.matched === 0 || c.differed > 0).map(([k]) => k);
  const writePathsNotMatched = NOTES_WRITE_PATHS.filter((p) => !((reads.writes[p]?.matched ?? 0) > 0) || (reads.writes[p]?.differed ?? 0) > 0);
  const days = total ? Object.keys(total.days).sort() : [];
  const erroredLast3Days = total ? days.slice(-3).reduce((n, d) => n + total.days[d].errored, 0) : 0;
  return {
    mode: MODE,
    asked: ASKED,
    week: WEEK,
    paths: Object.fromEntries([...NOTES_READ_PATHS, ...NOTES_WRITE_PATHS].map((p) => [p, { seen: s.seen[p] ?? 0, missed: s.missed[p] ?? 0, errored: s.errors[p] ?? 0 }])),
    queries: s.queries,
    writes: s.writes,
    families: s.families,
    tables: s.tables,
    queue: s.queue.length,
    pausedUntil: s.pausedUntil ? new Date(s.pausedUntil).toISOString() : null,
    total: total ? { readPathsNotSeen, readPathsWithNoMatch, queriesNotMatched, writePathsNotMatched, days: total.days, erroredLast3Days } : null,
    ...extra,
  };
}

/** Tests: the queue drained. */
export async function notesShadowSettled(timeoutMs = 30_000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const s = state();
    if (!s.queue.length && !s.busy) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}
