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
};

const g = globalThis as unknown as { __norcoachStoreHealth?: StoreHealth; __norcoachStoreReported?: Set<string> };

export function health(): StoreHealth {
  return (g.__norcoachStoreHealth ??= {
    failures: 0,
    lastCommitAt: null,
    lastOkAt: null,
    lastFailureAt: null,
    lastError: null,
    retryAt: null,
    stuckAlerted: false,
    skipped: {},
    shuttingDown: false,
  });
}

/** A copy for /api/timing. */
export function storeHealth(): StoreHealth & { skippedTotal: number } {
  const h = health();
  return { ...h, skipped: { ...h.skipped }, skippedTotal: Object.values(h.skipped).reduce((a, b) => a + b, 0) };
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
