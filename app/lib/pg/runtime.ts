import path from "path";
import { eq, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { installIdSource, installStore, prepareStore, readJsonFile, STORE_MODE, type Data } from "../db";
import { errorReason, health, reportSkipped, toSentry } from "./health";
import { IdPools } from "./ids";
import { onceKeysFromKvCopy } from "./onceKeys";
import { healthWorkoutsFromKvCopy, healthWorkoutsKept } from "./healthWorkouts";
import { COLLECTIONS, kv } from "./schema";
import { derivedStale, insertRowsOnce, loadStore, PgStoreWriter } from "./store";
import { startChatShadow } from "../chat/shadow";
import { CHAT_ONCE_PREFIX_SQL, CHAT_PG, CHAT_STORE_ASKED } from "../chat/mode";
import { startChatPg } from "../chat/pg";
import { chatPreflight } from "../chat/preflight";
import { takeLease } from "./lease";
import { setPgStrays } from "../chat/strays";
import { stampInstantMs } from "./stamps";
import { stampMs } from "../targetRule";

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
//
// Step 6 (19 Nov): the phone's workouts the same way as once_keys: before the store loads, the health_workouts table is
// made its kv copy, and memory takes the copy itself, in its order (pg/healthWorkouts.ts).

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyDb = PgDatabase<any, any, any>;
type Row = Record<string, unknown>;

const MIGRATIONS = path.join(process.cwd(), "drizzle");
const log = (message: string) => console.log(`[store] ${message}`);

/** This boot's own label on the store's and the lease's connections (Postgres), for the owner reading pg_stat_activity. */
const BOOT_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const STORE_APP_NAME = `norcoach-store-${BOOT_ID}`;

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
  // Named (a label only, for the owner reading pg_stat_activity; one instance at a time is pg/lease.ts's).
  const db = drizzle(new Pool({ connectionString: url, max: 5, application_name: STORE_APP_NAME }));
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
  // One instance on the database at a time (pg/lease.ts): with CHAT_STORE=pg the boot waits for the lease and refuses
  // without it; in memory mode it is taken in the background, never waited on, so a pg boot over this one waits.
  await takeLease(process.env.DATABASE_URL!, { mustHold: CHAT_PG, name: `norcoach-lease-${BOOT_ID}` });
  // With the chat in Postgres alone (CHAT_STORE=pg, Step 5's cut-over): what its SQL leans on is there and runs, or the
  // boot stops here with nothing changed.
  if (CHAT_PG) await chatPreflight(db);

  // The id counters are always saved, so their absence means an empty database (or a damaged one: emptyStart).
  const hasData = (await db.select().from(kv).where(eq(kv.key, "_seq"))).length > 0;
  let raw: Partial<Data>;
  // Lists still kept in kv under a collection's name while its table is empty: moved into the table by the first save.
  const moved: string[] = [];
  // Rows whose instant columns are to be written again (step 4C).
  let restamped = 0;
  // The phone's workouts' kv copy to write again on the boot's save (cleaned, broken, or missing beside rows).
  let healthDirty = false;
  if (hasData) {
    // The saves taken once, as the last build to save left them (step 4B: a build before it writes only the kv copy).
    const onceKeys = await onceKeysFromKvCopy(db);
    if (onceKeys != null) log(`once_keys: ${onceKeys} taken from kv's copy`);
    // The phone's workouts, the same way (Step 6: a build before it writes only the kv copy).
    const hw = await healthWorkoutsFromKvCopy(db);
    if (hw?.broken) {
      console.error(`[store] !!! kv's health_workouts is not a list: the table loads as it is, and the next save writes the copy again`);
      reportSkipped("kv", "health_workouts, not a list: the table loaded as it is");
    } else if (hw) {
      log(
        `health_workouts: ${hw.kept.length} rows (kv ${hw.kvRows}, ${hw.twins} twins, ${hw.unusable} unusable, ${hw.cleaned} keys cleaned), taken from kv's copy, ids ${hw.orderById ? "in order" : "out of order"}`
      );
      // Counts alone, never a value (health data).
      if (hw.twins || hw.unusable || hw.cleaned) reportSkipped("health_workouts", `kv's copy: ${hw.twins} twins and ${hw.unusable} unusable rows left out, ${hw.cleaned} keys cleaned`);
    }
    raw = (await loadStore(db, moved)) as Partial<Data>;
    const loaded = raw as Row;
    if (hw && !hw.broken) loaded.health_workouts = hw.kept;
    // Never synced (no copy, an empty table): no list at all, as the build before loads it.
    else if (!hw && Array.isArray(loaded.health_workouts) && loaded.health_workouts.length === 0) delete loaded.health_workouts;
    // What the database holds right now, before the load-time tidies touch it.
    writer.prime(loaded, moved);
    const stale = await derivedStale(db, raw as Row);
    for (const [name, keys] of stale) {
      log(`${name}: ${keys.size} row${keys.size === 1 ? "" : "s"} with an instant column to write again`);
      restamped += keys.size;
    }
    writer.forget(stale);
    // kv's copy not what memory holds (rows left out or cleaned, not a list, or gone while the table has rows): the
    // boot's save writes it again, so a rollback reads every workout.
    if (hw ? hw.broken || hw.twins || hw.unusable || hw.cleaned : Array.isArray(loaded.health_workouts)) {
      writer.forgetKv("health_workouts");
      healthDirty = true;
    }
    log("loaded from Postgres");
  } else {
    raw = await emptyStart(db);
    // A whole-store JSON's workouts as the table can hold them, so two keys that clean to one can't fail its first save.
    const file = raw as Row;
    if (Array.isArray(file.health_workouts)) file.health_workouts = healthWorkoutsKept(file.health_workouts).kept;
    // A whole-store JSON (local, or ALLOW_JSON_IMPORT=1) carries its chat; with CHAT_STORE=pg it goes into the table,
    // never into memory or kv (a file the shutdown wrote with the chat left out is refused: its chat is in Postgres).
    if (CHAT_PG) await importChat(db, raw);
  }
  // The chat's own boot checks (CHAT_STORE=pg): its stamps' instants put right, its strays, its highest id.
  const chat = CHAT_PG ? await chatBoot(db) : null;

  const prepared = prepareStore(raw);
  const { data } = prepared;
  // Always run, even when a tidy already changed something: a counter left behind its table hands out ids twice.
  const raised = raiseCounters(data);
  // The chat's counter at least its table's highest id (raiseCounters no longer sees chat rows, CHAT_STORE=pg).
  let chatRaised = false;
  if (chat && chat.maxId > (data._seq.chat_messages ?? 0)) {
    chatRaised = true;
    log(`raised the id counter of chat_messages from ${data._seq.chat_messages ?? "none"} to ${chat.maxId}, its highest id`);
    data._seq.chat_messages = chat.maxId;
  }
  // Ids from Postgres for the tables that will move (step 4A), before anything can take one; the counters as raised.
  const ids = new IdPools(db, () => (data._seq ??= {}));
  await ids.start();
  (globalThis as unknown as { _pgIds?: IdPools })._pgIds = ids;
  const changed = prepared.changed || raised > 0 || chatRaised || moved.length > 0 || restamped > 0 || healthDirty;
  // The import, or a tidy's changes, are written before any request arrives,
  // so a failure stops the boot instead of surfacing later.
  if (!hasData || changed) await writer.save(() => data as unknown as Row);
  health().lastOkAt = new Date().toISOString();
  // The chat shadow (Step 5, app/lib/chat/shadow.ts; CHAT_SHADOW, off by default): told where Postgres is and who writes
  // to it, and in write mode its tables seeded, before any request. It catches everything itself; the boot never fails over it.
  (globalThis as unknown as { _pgWriter?: PgStoreWriter })._pgWriter = writer;
  await startChatShadow({ db, url: process.env.DATABASE_URL!, writer }).catch(() => {});
  // Chat's own connection (CHAT_STORE=pg), before any request, and the orphans said (an erase whose chat stayed).
  if (CHAT_PG) {
    await startChatPg({ db, url: process.env.DATABASE_URL! });
    await reportChatOrphans(db, data);
  }
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
  // CHAT_STORE (chat/mode.ts) known, and "pg" only with the Postgres store (never while next build renders pages).
  if (!["", "memory", "pg"].includes(CHAT_STORE_ASKED)) return Promise.reject(new Error(`[store] Refusing to start: CHAT_STORE=${CHAT_STORE_ASKED} is not memory or pg`));
  if (CHAT_STORE_ASKED === "pg" && STORE_MODE !== "postgres" && process.env.NEXT_PHASE !== "phase-production-build") {
    return Promise.reject(new Error("[store] Refusing to start: CHAT_STORE=pg needs the Postgres store (STORE=postgres and DATABASE_URL)"));
  }
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

// ---- The chat in Postgres alone (CHAT_STORE=pg, Step 5's cut-over) ------------------------------------------------

/** More strays than this means the server reads its stamps in the wrong zone (TZ): refuse rather than serve odd answers. */
const STRAYS_MAX = Math.max(0, Number(process.env.CHAT_STRAYS_MAX) || 50);

const resultRows = (r: unknown) => ((r as { rows?: Row[] }).rows ?? []) as Row[];

/**
 * The JSON import's chat, into the table as the writer writes rows (a row already there kept), then out of what loads
 * into memory. A file the shutdown wrote (`_chat_in_postgres`) holds no chat: refused unless ALLOW_JSON_WITHOUT_CHAT=1,
 * the chat then restored on its own (pg_dump). Should the first save then fail, the next boot refuses (chat rows and no
 * `_seq`): empty the chat table and start again.
 */
async function importChat(db: AnyDb, raw: Partial<Data>) {
  const r = raw as Record<string, unknown>;
  if (r._chat_in_postgres) {
    if (process.env.ALLOW_JSON_WITHOUT_CHAT !== "1") {
      throw new Error(
        "[store] Refusing to start: the JSON to import was written with CHAT_STORE=pg and holds no chat (it is in Postgres). Restore the database instead (scripts/restore-pg-backup.mjs), or set ALLOW_JSON_WITHOUT_CHAT=1 to start without it."
      );
    }
    delete r._chat_in_postgres;
  }
  const list = r.chat_messages;
  delete r.chat_messages;
  if (!Array.isArray(list) || !list.length) return;
  const n = await insertRowsOnce(db, "chat_messages", list);
  log(`chat_messages: ${n} rows of the JSON imported into the table (CHAT_STORE=pg)`);
}

/**
 * The chat table at boot: each row's instant (created_at_tz) put right where it isn't what the writer would write (a
 * build that didn't fill it, a rollback past step 4: derivedStale no longer sees chat), its strays found (pick.ts
 * isStray), its highest id. 5000 rows a read, 500 a write.
 */
async function chatBoot(db: AnyDb): Promise<{ maxId: number }> {
  const strays: number[] = [];
  let rows = 0;
  let maxId = 0;
  let restamped = 0;
  for (let after = 0; ; ) {
    const page = resultRows(
      await db.execute(sql`SELECT id, created_at, (EXTRACT(EPOCH FROM created_at_tz) * 1000)::float8 AS ms FROM chat_messages WHERE id > ${after}::int ORDER BY id LIMIT 5000`)
    );
    if (!page.length) break;
    const fix: { id: number; tz: string | null }[] = [];
    for (const r of page) {
      const id = Number(r.id);
      const want = stampInstantMs(r.created_at);
      const have = r.ms == null ? null : Math.round(Number(r.ms));
      if (want !== have) fix.push({ id, tz: want == null ? null : new Date(want).toISOString() });
      const read = stampMs(String(r.created_at ?? ""));
      if (!(Number.isFinite(read) && want === read)) strays.push(id);
      maxId = Math.max(maxId, id);
    }
    for (let i = 0; i < fix.length; i += 500) {
      const part = fix.slice(i, i + 500);
      const ids = `{${part.map((p) => p.id).join(",")}}`;
      const tzs = `{${part.map((p) => (p.tz == null ? "NULL" : `"${p.tz}"`)).join(",")}}`;
      await db.execute(sql`UPDATE chat_messages m SET created_at_tz = v.tz FROM unnest(${ids}::int[], ${tzs}::timestamptz[]) AS v(id, tz) WHERE m.id = v.id`);
    }
    restamped += fix.length;
    rows += page.length;
    after = Number(page[page.length - 1].id);
  }
  const once = resultRows(await db.execute(sql`SELECT count(*)::int AS n FROM once_keys WHERE key ~ ${CHAT_ONCE_PREFIX_SQL}::text`))[0]?.n ?? 0;
  console.log(`[chat] pg: ${rows} rows, max id ${maxId}, restamped ${restamped}, strays ${strays.length}, chat once keys kept ${once}`);
  if (strays.length > STRAYS_MAX) {
    throw new Error(
      `[chat] Refusing to start with CHAT_STORE=pg: ${strays.length} chat rows read their stamp otherwise than the column (more than ${STRAYS_MAX}); is TZ=Europe/Amsterdam set? (CHAT_STRAYS_MAX raises the limit)`
    );
  }
  setPgStrays(strays);
  return { maxId };
}

/** Chat rows whose client is gone (an erase whose chat stayed, before the cut-over's order): said, never deleted. */
async function reportChatOrphans(db: AnyDb, data: Data) {
  try {
    const ids = `{${data.clients.map((c) => c.id).join(",")}}`;
    const row = resultRows(await db.execute(sql`SELECT count(*)::int AS n, count(DISTINCT client_id)::int AS clients FROM chat_messages WHERE NOT (client_id = ANY(${ids}::int[]))`))[0];
    if (Number(row?.n ?? 0) > 0) {
      console.error(`[chat] !!! ${row?.n} chat rows of ${row?.clients} clients no longer in the store (kept; look at them)`);
      toSentry((S) => S.captureMessage(`Chat rows of removed clients: ${row?.n}`, { level: "warning", tags: { alert: "chat-orphans" } }));
    }
  } catch (error) {
    console.error("[chat] the orphan check failed:", error instanceof Error ? error.message : error);
  }
}
