import path from "path";
import { eq, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { installIdSource, installStore, prepareStore, readJsonFile, STORE_MODE, type Data } from "../db";
import { errorReason, health, toSentry } from "./health";
import { IdPools } from "./ids";
import { onceKeysFromKvCopy } from "./onceKeys";
import { COLLECTIONS, kv } from "./schema";
import { derivedStale, loadStore, PgStoreWriter } from "./store";

// Starts the Postgres store (STORE=postgres). Called once from
// instrumentation.ts, which Next awaits before the server takes requests:
//   1. connect, and create or update the tables (migrations in ./drizzle);
//   2. load the data, or, when the database has never held any, import
//      ironline.json, so switching a running install over carries its data;
//   3. hand the data to db.ts, with every later save going to Postgres.
//
// DATABASE_URL is a postgres:// URL on Railway. "pglite:<folder>" runs a
// real Postgres in-process from that folder instead, for local testing with
// no server and no credentials.
//
// The safety net (17 Nov):
//   - boot guards: no id counters ("_seq") but rows in the tables means a broken database, never an empty one, so
//     the server refuses to start rather than import an old file over it or start blank; on the live server an
//     empty database starts only when told to (ALLOW_JSON_IMPORT=1, ALLOW_BLANK_START=1); every counter is raised to
//     at least its table's highest id, so a new row never takes an id already used;
//   - a save that fails is tried again on a backoff (2 s, 5 s, 15 s, 30 s, then every minute) until one goes
//     through, with one alert to Sentry (tag store-stuck) after three failures in a row;
//   - flushStore() for the shutdown (app/lib/shutdown.ts), which saves at once on SIGTERM.
//
// Step 4 (18 Nov, the groundwork for direct tables): before the store loads, the once_keys table is taken from its kv
// copy (pg/onceKeys.ts); once loaded, rows whose instant columns don't hold what the writer would write are marked to
// be written again (store.ts derivedStale); and before any id is handed out the id sequences are raised past every
// id taken and a block drawn (pg/ids.ts), with allocId drawing from them from then on.

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyDb = PgDatabase<any, any, any>;
type Row = Record<string, unknown>;

const MIGRATIONS = path.join(process.cwd(), "drizzle");
const log = (message: string) => console.log(`[store] ${message}`);

/** The waits between retries of a failed save; the last repeats until one goes through. */
const RETRY_MS = [2_000, 5_000, 15_000, 30_000, 60_000];
/** Failures in a row before the one alert. */
const STUCK_AFTER = 3;

async function connect(url: string): Promise<AnyDb> {
  if (url.startsWith("pglite:")) {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    const db = drizzle(new PGlite(url.slice("pglite:".length)));
    await migrate(db, { migrationsFolder: MIGRATIONS });
    return db as unknown as AnyDb;
  }
  const { Pool } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  const db = drizzle(new Pool({ connectionString: url, max: 5 }));
  await migrate(db, { migrationsFolder: MIGRATIONS });
  return db as unknown as AnyDb;
}

/** The live server (Railway, or any production build): where an empty database must never be taken lightly. */
const isProduction = () => !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_ENVIRONMENT_NAME) || process.env.NODE_ENV === "production";

/** The tables that hold at least one row (the collections, and kv). */
async function tablesWithRows(db: AnyDb): Promise<string[]> {
  const filled: string[] = [];
  for (const c of COLLECTIONS) {
    if ((await db.select({ one: sql`1` }).from(c.table).limit(1)).length) filled.push(c.name);
  }
  if ((await db.select({ one: sql`1` }).from(kv).limit(1)).length) filled.push("kv");
  return filled;
}

/**
 * Every id counter at least as high as the highest id its rows hold (17 Nov): a counter behind its table would hand
 * out an id already taken, and the new row would overwrite the old one on the next save. The collections, and the
 * lists kept in kv whose rows carry a numeric id (weight_goals, support_messages…). How many were raised.
 */
function raiseCounters(data: Data): number {
  const seq = (data._seq ??= {});
  let raised = 0;
  for (const [name, value] of Object.entries(data)) {
    if (name === "_seq" || !Array.isArray(value)) continue;
    let max = 0;
    for (const row of value as unknown[]) {
      const id = row && typeof row === "object" ? (row as Row).id : undefined;
      if (typeof id === "number" && Number.isInteger(id) && id > max) max = id;
    }
    if (max > (seq[name] ?? 0)) {
      log(`raised the id counter of ${name} from ${seq[name] ?? "none"} to ${max}, its highest id`);
      seq[name] = max;
      raised++;
    }
  }
  return raised;
}

/** Without the counters, what the boot starts from; throws when it must not start at all. */
async function emptyStart(db: AnyDb): Promise<Partial<Data>> {
  const filled = await tablesWithRows(db);
  if (filled.length) {
    throw new Error(
      `[store] Refusing to start: Postgres has no "_seq" in kv (the id counters, always saved), yet ${filled.join(", ")} hold rows. ` +
        `The database is damaged or half restored; starting would hand out ids already taken, and importing ironline.json would write an old copy over it. ` +
        `Restore it (scripts/restore-pg-backup.mjs) or put "_seq" back in kv, then start again.`
    );
  }
  if (!isProduction()) {
    // Local: as it always was.
    const file = readJsonFile();
    log(file ? "Postgres is empty: importing ironline.json" : "Postgres is empty and there is no ironline.json: starting blank");
    return file ?? {};
  }
  const file = process.env.ALLOW_JSON_IMPORT === "1" ? readJsonFile() : null;
  if (file) {
    log("Postgres is empty: importing ironline.json (ALLOW_JSON_IMPORT=1)");
    return file;
  }
  if (process.env.ALLOW_BLANK_START === "1") {
    log("Postgres is empty: starting blank (ALLOW_BLANK_START=1)");
    return {};
  }
  throw new Error(
    `[store] Refusing to start: Postgres is empty on the live server. An old ironline.json is never imported by itself. ` +
      `To restore, use scripts/restore-pg-backup.mjs. To import ironline.json on purpose set ALLOW_JSON_IMPORT=1` +
      `${process.env.ALLOW_JSON_IMPORT === "1" ? " (it is set, but there is no readable ironline.json)" : ""}; to start a new install with nothing, ALLOW_BLANK_START=1. Unset it again once started.`
  );
}

async function start() {
  const db = await connect(process.env.DATABASE_URL!);
  (globalThis as unknown as { _pgDb?: AnyDb })._pgDb = db;
  const writer = new PgStoreWriter(db);

  // The id counters are always saved, so their absence means an empty database (or a damaged one: emptyStart).
  const hasData = (await db.select().from(kv).where(eq(kv.key, "_seq"))).length > 0;
  let raw: Partial<Data>;
  // Lists still kept in kv under a collection's name while its table is empty: moved into the table by the first save.
  const moved: string[] = [];
  // Rows whose instant columns are to be written again (step 4C).
  let restamped = 0;
  if (hasData) {
    // The saves taken once, as the last build to save left them (step 4B: a build before it writes only the kv copy).
    const onceKeys = await onceKeysFromKvCopy(db);
    if (onceKeys != null) log(`once_keys: ${onceKeys} taken from kv's copy`);
    raw = (await loadStore(db, moved)) as Partial<Data>;
    // What the database holds right now, before the load-time tidies touch it.
    writer.prime(raw as Row, moved);
    const stale = await derivedStale(db, raw as Row);
    for (const [name, keys] of stale) {
      log(`${name}: ${keys.size} row${keys.size === 1 ? "" : "s"} with an instant column to write again`);
      restamped += keys.size;
    }
    writer.forget(stale);
    log("loaded from Postgres");
  } else {
    raw = await emptyStart(db);
  }

  const prepared = prepareStore(raw);
  const { data } = prepared;
  // Always run, even when a tidy already changed something: a counter left behind its table hands out ids twice.
  const raised = raiseCounters(data);
  // Ids from Postgres for the tables that will move (step 4A), before anything can take one; the counters as raised.
  const ids = new IdPools(db, () => (data._seq ??= {}));
  await ids.start();
  (globalThis as unknown as { _pgIds?: IdPools })._pgIds = ids;
  const changed = prepared.changed || raised > 0 || moved.length > 0 || restamped > 0;
  // The import, or a tidy's changes, are written before any request arrives,
  // so a failure stops the boot instead of surfacing later.
  if (!hasData || changed) await writer.save(() => data as unknown as Row);
  health().lastOkAt = new Date().toISOString();
  if (writer.lastCommitAt) health().lastCommitAt = new Date(writer.lastCommitAt).toISOString();

  // Every save goes through here: persist(), the retries, and the shutdown's.
  const counted = new WeakSet<Promise<void>>();
  let step = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const saved = () => {
    const h = health();
    if (h.failures > 0) log(`saving to Postgres works again, after ${h.failures} failed ${h.failures === 1 ? "try" : "tries"}`);
    h.failures = 0;
    h.stuckAlerted = false;
    h.retryAt = null;
    h.lastOkAt = new Date().toISOString();
    if (writer.lastCommitAt) h.lastCommitAt = new Date(writer.lastCommitAt).toISOString();
    step = 0;
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const failed = (error: unknown) => {
    const h = health();
    h.failures++;
    h.lastFailureAt = new Date().toISOString();
    // The reason alone, never the query's params (store data: /api/timing is open to every coach).
    h.lastError = errorReason(error);
    // The in-memory store is still right, and the next save writes everything that differs, this change included.
    if (h.failures === 1) {
      console.error("[store] saving to Postgres failed; trying again shortly:", error);
      toSentry((Sentry) => Sentry.captureException(error));
    } else {
      console.error(`[store] saving to Postgres failed again (${h.failures} in a row): ${h.lastError}`);
    }
    if (h.failures >= STUCK_AFTER && !h.stuckAlerted) {
      h.stuckAlerted = true;
      console.error(`[store] !!! ${h.failures} saves to Postgres failed in a row; the changes since ${h.lastOkAt ?? "the start"} live only in memory`);
      toSentry((Sentry) =>
        Sentry.captureMessage(`Store stuck: ${h.failures} saves to Postgres failed in a row (${h.lastError})`, {
          level: "fatal",
          tags: { alert: "store-stuck" },
          extra: { lastOkAt: h.lastOkAt, lastCommitAt: h.lastCommitAt },
        })
      );
    }
    // The shutdown makes its own last saves; no retry is left behind it.
    if (h.shuttingDown) return;
    if (timer) clearTimeout(timer);
    const wait = RETRY_MS[Math.min(step, RETRY_MS.length - 1)];
    step++;
    h.retryAt = new Date(Date.now() + wait).toISOString();
    timer = setTimeout(() => {
      timer = null;
      void save("retry");
    }, wait);
    timer.unref?.();
  };

  // The store as db.ts last handed it over (the same object, unless installStore runs again).
  let current: Data = data;
  const save = (why: "persist" | "retry" | "shutdown"): Promise<void> => {
    // A save the app asks for starts the backoff over: if it fails too, the next retry is 2 s away again.
    if (why === "persist") step = 0;
    const promise = writer.save(() => current as unknown as Row);
    // One answer per save: a save asked while one runs hands back that one's promise, counted once.
    if (!counted.has(promise)) {
      counted.add(promise);
      promise.then(saved, failed);
    }
    return promise;
  };

  (globalThis as unknown as { _pgFlush?: () => Promise<void> })._pgFlush = () => save("shutdown");

  installIdSource((table, counter) => ids.take(table, counter));
  installStore(data, (latest) => {
    current = latest;
    return save("persist");
  });
  log(`ready: ${data.users.length} users, ${data.clients.length} clients`);
}

/** Loads the Postgres store once; does nothing in JSON mode. */
export function initStore(): Promise<void> {
  if (STORE_MODE !== "postgres") return Promise.resolve();
  const g = globalThis as unknown as { _pgInit?: Promise<void> };
  g._pgInit ??= start();
  return g._pgInit;
}

/**
 * Saves the store now and settles once the database holds it (rejects when that save fails). For the shutdown; null
 * in JSON mode, where every persist() already wrote the file before it returned.
 */
export function flushStore(): Promise<void> | null {
  const flush = (globalThis as unknown as { _pgFlush?: () => Promise<void> })._pgFlush;
  return flush ? flush() : null;
}
