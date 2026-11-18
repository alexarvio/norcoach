// How the Postgres saves are doing (17 Nov, the safety net): failures in a row, the last save that went through, the
// retry waiting, and rows the writer had to leave out. Shown on /api/timing. Kept on globalThis: instrumentation.ts
// (which owns the writer) and the route handlers are separate bundles, and both must read one record.

export type StoreHealth = {
  /** Saves that failed in a row; 0 once one goes through. */
  failures: number;
  /** When a save last wrote something (a transaction committed), ISO. */
  lastCommitAt: string | null;
  /** When a save last went through, written or with nothing to write, ISO: the database held the store then. */
  lastOkAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  /** When the next retry runs, ISO; null when none is waiting. */
  retryAt: string | null;
  /** Whether the store-stuck alert went out for this run of failures. */
  stuckAlerted: boolean;
  /** Rows (and kv keys, under "kv") the latest save had to leave out, by table. */
  skipped: Record<string, number>;
  /** The server is shutting down (SIGTERM / SIGINT). */
  shuttingDown: boolean;
  /** What a save's snapshot and compare cost, the latest and the dearest since start (17 Nov, mission 2): measured
   *  only, so we know when the per-save cost starts to matter. */
  saveCost: { last: SaveCost | null; max: SaveCost | null; saves: number; tx?: SaveTx };
};

/** The transactions' own times, ms (18 Nov, Step 5: the chat shadow must never slow the writer): the last 200, their
 *  median and 90th percentile. */
export type SaveTx = { last: number | null; p50: number | null; p90: number | null; n: number; ring: number[] };

/** One save's work before its transaction: every row stringified (snapshotMs), then compared with the last save's
 *  (diffMs), ms; `rows` the rows and kv values compared, `changed` those that differed or went. */
export type SaveCost = { at: string; ms: number; snapshotMs: number; diffMs: number; rows: number; changed: number };

const g = globalThis as unknown as { __norcoachStoreHealth?: StoreHealth; __norcoachStoreReported?: Set<string> };

export function health(): StoreHealth {
  const h = (g.__norcoachStoreHealth ??= {
    failures: 0,
    lastCommitAt: null,
    lastOkAt: null,
    lastFailureAt: null,
    lastError: null,
    retryAt: null,
    stuckAlerted: false,
    skipped: {},
    shuttingDown: false,
    saveCost: { last: null, max: null, saves: 0 },
  });
  // A record made before saveCost existed (a dev server kept across a reload) gets it.
  h.saveCost ??= { last: null, max: null, saves: 0 };
  return h;
}

/** A save's snapshot and compare, measured (store.ts). */
export function noteSaveCost(cost: SaveCost) {
  const c = health().saveCost;
  c.last = cost;
  c.saves++;
  if (!c.max || cost.ms > c.max.ms) c.max = cost;
}

/** A save's transaction, timed (store.ts). */
export function noteSaveTx(ms: number) {
  const c = health().saveCost;
  const tx = (c.tx ??= { last: null, p50: null, p90: null, n: 0, ring: [] });
  tx.last = ms;
  tx.n++;
  tx.ring.push(ms);
  if (tx.ring.length > 200) tx.ring.shift();
  const sorted = [...tx.ring].sort((a, b) => a - b);
  tx.p50 = sorted[Math.floor(0.5 * (sorted.length - 1))];
  tx.p90 = sorted[Math.floor(0.9 * (sorted.length - 1))];
}

/** A copy for /api/timing. */
export function storeHealth(): StoreHealth & { skippedTotal: number } {
  const h = health();
  const tx = h.saveCost.tx ? { last: h.saveCost.tx.last, p50: h.saveCost.tx.p50, p90: h.saveCost.tx.p90, n: h.saveCost.tx.n, ring: [] } : undefined;
  return { ...h, skipped: { ...h.skipped }, saveCost: { ...h.saveCost, tx }, skippedTotal: Object.values(h.skipped).reduce((a, b) => a + b, 0) };
}

/**
 * Why a save failed, safe to show and send: drizzle's DrizzleQueryError says `Failed query: <sql>\nparams: <values>`,
 * the values being store data, so its cause (Postgres's own reason) is taken when there is one, and anything from a
 * `params:` line on is cut. 500 characters at most.
 */
export function errorReason(error: unknown): string {
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
  const words = cause instanceof Error ? cause.message : error instanceof Error ? error.message : String(error);
  const at = words.indexOf("\nparams:");
  return (at >= 0 ? words.slice(0, at) : words).slice(0, 500);
}

/** Sends to Sentry without making this file load it (the scripts run without it). */
export function toSentry(send: (sentry: typeof import("@sentry/nextjs")) => void) {
  import("@sentry/nextjs").then(send).catch(() => {});
}

/**
 * Something the writer had to leave out (a row with no id, a kv key named like a table): said in the log and to
 * Sentry once per kind of problem and table a process, so a bad row never floods either. Every save counts its own
 * (`skipped` above).
 */
export function reportSkipped(table: string, why: string, sample?: unknown) {
  const seen = (g.__norcoachStoreReported ??= new Set());
  const key = `${table}:${why}`;
  if (seen.has(key)) return;
  seen.add(key);
  let shown = "";
  try {
    shown = sample === undefined ? "" : ` ${JSON.stringify(sample).slice(0, 300)}`;
  } catch {}
  console.error(`[store] left out of the save: ${table}, ${why}.${shown}`);
  toSentry((Sentry) => Sentry.captureMessage(`Store row left out of the save: ${table}, ${why}`, { level: "error", tags: { alert: "store-skipped-row", table } }));
}
