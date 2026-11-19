// The notifications own connection to Postgres, with NOTES_STORE=pg (quest 7): the door's reads (rows.ts) and the
// outbox drainer's writes (outbox.ts) run here, never through the store's writer. A copy of chat/pg.ts (chat's own file
// left untouched), its pool its own: 4 connections by default (NOTES_PG_POOL), application_name norcoach-notes, the same
// timeouts, the same clean errors (nothing typed reaches the log or Sentry), reads in one REPEATABLE READ READ ONLY
// snapshot retried only on a lost connection or a full pool, writes ordered per key, a lost connection mid-write never
// retried blindly (verify reads whether it committed). Started by the boot before any request; nothing here runs in
// memory mode.

import { sql as sqlTag, type SQL } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyDb = PgDatabase<any, any, any>;
export type Row = Record<string, unknown>;
/** Runs one statement and hands back its rows. */
export type Q = (query: SQL) => Promise<Row[]>;

type State = {
  db: AnyDb | null;
  pglite: boolean;
  chains: Map<string, Promise<unknown>>;
  counts: { reads: number; writes: number; readErrors: number; writeErrors: number; unknown: number; retried: number; poolWaits: number };
  /** Tests: throw a lost connection after this write commits (once), by op. */
  faultAfterCommit: string | null;
};

const g = globalThis as unknown as { __norcoachNotesPg?: State };
const state = (): State =>
  (g.__norcoachNotesPg ??= {
    db: null,
    pglite: false,
    chains: new Map(),
    counts: { reads: 0, writes: 0, readErrors: 0, writeErrors: 0, unknown: 0, retried: 0, poolWaits: 0 },
    faultAfterCommit: null,
  });

const rowsOf = (result: unknown): Row[] => ((result as { rows?: Row[] })?.rows ?? []) as Row[];

/** Connects the notifications' own pool (Postgres) or takes the store's database (pglite). The boot's, once. */
export async function startNotesPg(opts: { db: AnyDb; url: string }): Promise<void> {
  const s = state();
  if (s.db) return;
  if (opts.url.startsWith("pglite:")) {
    s.db = opts.db;
    s.pglite = true;
    return;
  }
  const { Pool } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const pool = new Pool({
    connectionString: opts.url,
    max: NOTES_POOL_MAX,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 300_000,
    keepAlive: true,
    application_name: "norcoach-notes",
    options: "-c statement_timeout=5000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=10000",
  });
  pool.on("error", (error) => console.error("[notes] pg pool:", safeMessage(error)));
  const db = drizzle(pool) as unknown as AnyDb;
  // The pool's own settings took (a pooler or proxy may drop startup options): checked on one of its connections, or the
  // boot stops here, before any request.
  const got = rowsOf(await db.execute(sqlTag`SELECT current_setting('statement_timeout') AS st, current_setting('lock_timeout') AS lt`))[0];
  if (got?.st !== "5s" || got?.lt !== "2s") {
    await pool.end().catch(() => {});
    throw new Error(`[notes] Refusing to start with NOTES_STORE=pg: the notifications' connections run with statement_timeout ${String(got?.st)} and lock_timeout ${String(got?.lt)}, not 5s and 2s (the pool's startup options were not applied)`);
  }
  s.db = db;
}

/** The pool size on Postgres (NOTES_PG_POOL, 4 by default). */
const NOTES_POOL_MAX = Math.max(2, Math.min(40, Number(process.env.NOTES_PG_POOL) || 4));

/**
 * An error's words, safe for the log and Sentry: Postgres's SQLSTATE and message, drizzle's parameters cut off, and
 * every quoted value in it ("invalid input syntax for type integer: "abc"") put out of sight. Never a message's words or a key.
 */
export function safeMessage(error: unknown): string {
  // Made safe already (NotesPgError): as it is.
  if (error instanceof Error && error.name === "NotesPgError") return error.message.replace(/^\[notes\] /, "").slice(0, 300);
  const e =error instanceof Error && error.cause instanceof Error ? error.cause : error;
  const code = (e as { code?: unknown } | null)?.code;
  const words = (e instanceof Error ? e.message : String(e)).split("\nparams:")[0];
  const hidden = words.replace(/"(?:[^"\\]|\\.)*"/g, '"…"').replace(/'(?:[^'\\]|\\.)*'/g, "'…'");
  return `${typeof code === "string" ? `${code} ` : ""}${hidden}`.slice(0, 300);
}

/** A notes error as it may leave here: safe words, its SQLSTATE as `code` (pgCode, lostConnection), no params, no cause. */
export class NotesPgError extends Error {
  readonly code: string | undefined;
  constructor(error: unknown) {
    super(`[notes] ${safeMessage(error)}`);
    this.name = "NotesPgError";
    const e = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    const code = (e as { code?: unknown } | null)?.code ?? (error as { code?: unknown } | null)?.code;
    this.code = typeof code === "string" ? code : undefined;
  }
}
const clean = (error: unknown) => (error instanceof NotesPgError ? error : new NotesPgError(error));

/** Every connection busy for the whole wait: nothing was sent, so trying once more is safe. */
export function poolWait(error: unknown): boolean {
  const e = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  const words = e instanceof Error ? e.message : String(e);
  return /timeout exceeded when trying to connect/i.test(words) || /timeout exceeded when trying to connect/i.test(error instanceof Error ? error.message : "");
}

function db(): AnyDb {
  const d = state().db;
  if (!d) throw new Error("[notes] NOTES_STORE=pg but the notifications' connection isn't started (pg/runtime.ts starts it before any request)");
  return d;
}

/** The connection went away: whatever was in flight may or may not have committed. */
export function lostConnection(error: unknown): boolean {
  const e = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  const code = String((e as { code?: unknown } | null)?.code ?? "");
  const words = e instanceof Error ? e.message : String(e);
  return (
    ["ECONNRESET", "EPIPE", "ETIMEDOUT", "ECONNREFUSED", "57P01", "57P02", "57P03"].includes(code) ||
    code.startsWith("08") ||
    /Connection terminated|connection.*(closed|ended)|Client has encountered a connection error/i.test(words)
  );
}

/** A read: every statement `fn` runs in one snapshot. Tried once more on a lost connection or a full pool alone. */
export async function notesRead<T>(fn: (q: Q) => Promise<T>): Promise<T> {
  const s = state();
  for (let attempt = 0; ; attempt++) {
    try {
      s.counts.reads++;
      return await db().transaction(async (tx) => fn(async (query) => rowsOf(await (tx as unknown as AnyDb).execute(query))), {
        isolationLevel: "repeatable read",
        accessMode: "read only",
      });
    } catch (error) {
      const waited = poolWait(error);
      if (waited) s.counts.poolWaits++;
      if (attempt === 0 && (waited || lostConnection(error))) {
        s.counts.retried++;
        continue;
      }
      s.counts.readErrors++;
      throw clean(error);
    }
  }
}

/** The work of one write: a statement, or several in one transaction (`tx`). */
export type WriteWork<T> = { op: string; run: (q: Q, inTx: <U>(fn: (q: Q) => Promise<U>) => Promise<U>) => Promise<T> };

/**
 * A write, after the writes before it on the same key (null: no order needed). On a lost connection `verify` says whether
 * it committed: its answer then (non-undefined), or undefined for "it did not", which tries the write once more.
 */
export function notesWrite<T>(key: string | null, work: WriteWork<T>, verify?: (q: Q) => Promise<T | undefined>): Promise<T> {
  const s = state();
  const go = async (): Promise<T> => {
    s.counts.writes++;
    const d = db();
    const q: Q = async (query) => rowsOf(await d.execute(query));
    const inTx = <U>(fn: (q: Q) => Promise<U>) => d.transaction(async (tx) => fn(async (query) => rowsOf(await (tx as unknown as AnyDb).execute(query))));
    let waits = 0;
    for (let attempt = 0; ; attempt++) {
      try {
        const out = await work.run(q, inTx);
        if (s.faultAfterCommit === work.op) {
          s.faultAfterCommit = null;
          throw Object.assign(new Error("Connection terminated unexpectedly (test fault after commit)"), { code: "57P01" });
        }
        return out;
      } catch (error) {
        // Every connection busy for the whole wait: the statement was never sent, so once more is safe (not an attempt).
        if (poolWait(error)) {
          s.counts.poolWaits++;
          if (waits++ === 0) {
            attempt--;
            continue;
          }
          s.counts.writeErrors++;
          throw clean(error);
        }
        if (!lostConnection(error) || attempt > 0) {
          s.counts.writeErrors++;
          throw clean(error);
        }
        s.counts.unknown++;
        if (!verify) {
          s.counts.writeErrors++;
          throw clean(error);
        }
        // The outcome is unknown: read it, never write again blindly.
        let seen: T | undefined;
        try {
          seen = await verify(q);
        } catch (again) {
          s.counts.writeErrors++;
          throw clean(again);
        }
        if (seen !== undefined) return seen;
        s.counts.retried++;
      }
    }
  };
  if (key == null) return go();
  const before = s.chains.get(key) ?? Promise.resolve();
  const mine = before.then(go, go);
  const settled = mine.then(
    () => undefined,
    () => undefined
  );
  s.chains.set(key, settled);
  void settled.then(() => {
    if (s.chains.get(key) === settled) s.chains.delete(key);
  });
  return mine;
}

/** Every write chained so far settled (the reset waits for them before its DELETE). */
export async function notesChainsSettled(): Promise<void> {
  await Promise.allSettled([...state().chains.values()]);
}

/** For /api/timing and the tests. */
export function notesPgReport() {
  const s = state();
  return { started: !!s.db, pglite: s.pglite, poolMax: s.pglite ? 1 : NOTES_POOL_MAX, chains: s.chains.size, ...s.counts };
}

/** Tests: the next write of this op throws a lost connection after it committed. */
export function faultAfterCommit(op: string | null) {
  state().faultAfterCommit = op;
}
