// One instance on the database at a time (Step 5's cut-over, 19 Nov review): a session advisory lock held for the
// process's whole life on a connection of its own, which never idles (a heartbeat every 30 s, TCP keepalive both ways).
//
//   CHAT_STORE=pg   the boot waits for the lease (up to CHAT_LEASE_WAIT_MS, 90 s by default: the old instance's
//                   shutdown saves, then exits and its connection, and with it the lock, goes) and refuses to start
//                   without it. With the chat in Postgres alone, a second instance holding the chat in memory (or a
//                   second pg one) would write over, bring back or double what this one writes.
//   memory mode     never waits and never refuses (it behaves as the live build does): it takes the lease when free,
//                   in the background, and keeps asking every 10 s while another holds it, saying so once (log and
//                   Sentry). Holding it is what makes a pg instance booting over it wait, then refuse.
//
// Only this build takes it: a build from before (587f751, the live one on 18 Nov) holds nothing, so the night's flip
// comes after this build has run in memory mode (the read week does that). pglite (local) takes none: one process.
//
// Who holds it, for the owner (a host gone dead with its connection still open until TCP gives up):
//   SELECT a.pid, a.application_name, a.client_addr, a.backend_start FROM pg_locks l JOIN pg_stat_activity a USING (pid)
//    WHERE l.locktype = 'advisory' AND l.classid = 20251 AND l.objid = 1 AND l.objsubid = 2;
//   SELECT pg_terminate_backend(<pid>);   -- only once that host is known to be gone

import { toSentry } from "./health";

/** The lease's key, the two-int form (a space of its own: the meal lock uses the one-bigint form). */
export const LEASE_KEY = [20251, 1] as const;

const WAIT_MS = Math.max(0, Number(process.env.CHAT_LEASE_WAIT_MS) || 90_000);
const HEARTBEAT_MS = 30_000;
const RETRY_MS = 10_000;
/** How long a deploy's overlap may hold the lease before memory mode says so (log and Sentry). */
const OVERLAP_MS = 60_000;

type Client = import("pg").Client;
type State = { client: Client | null; held: boolean; told: boolean; stopping: boolean; lostAt: string | null };
// `__norcoachLeaseWhy`: the switches that made it must-hold (quest 7), for the lost lease's words.
const g = globalThis as unknown as { __norcoachLease?: State; __norcoachLeaseWhy?: string };
const state = (): State => (g.__norcoachLease ??= { client: null, held: false, told: false, stopping: false, lostAt: null });

const say = (m: string) => console.log(`[lease] ${m}`);

/** A connection of its own, tried for the lease once. True when held. */
async function tryOnce(url: string, name: string, mustHold: boolean): Promise<boolean> {
  const s = state();
  if (!s.client) {
    const { Client } = await import("pg");
    const client = new Client({ connectionString: url, application_name: name, keepAlive: true, keepAliveInitialDelayMillis: 10_000 });
    client.on("error", (error) => lost(url, name, mustHold, error));
    client.on("end", () => lost(url, name, mustHold, null));
    await client.connect();
    // The server notices a dead host too, and never closes this connection for idling; each set alone, so a server
    // without one of them still gives the lease (keepalive is then the client's alone).
    for (const set of ["SET tcp_keepalives_idle = 30", "SET tcp_keepalives_interval = 10", "SET tcp_keepalives_count = 3", "SET idle_session_timeout = 0", "SET idle_in_transaction_session_timeout = 0", "SET statement_timeout = 0"]) {
      await client.query(set).catch(() => {});
    }
    s.client = client;
  }
  const got = await s.client.query("SELECT pg_try_advisory_lock($1::int, $2::int) AS ok", [LEASE_KEY[0], LEASE_KEY[1]]);
  s.held = got.rows[0]?.ok === true;
  return s.held;
}

function lost(url: string, name: string, mustHold: boolean, error: unknown) {
  const s = state();
  if (s.stopping) return;
  const was = s.held;
  s.client = null;
  s.held = false;
  if (!was) return;
  s.lostAt = new Date().toISOString();
  console.error(`[lease] !!! the lease's connection went${error instanceof Error ? ` (${error.message})` : ""}; taking it again`);
  if (mustHold) toSentry((S) => S.captureMessage(`Lease lost: the instance's lock on the database went (${g.__norcoachLeaseWhy ?? "CHAT_STORE=pg"})`, { level: "fatal", tags: { alert: "store-lease-lost" } }));
  void keepAsking(url, name, mustHold);
}

/** Asks every 10 s until held (memory mode, or after a lost connection). */
async function keepAsking(url: string, name: string, mustHold: boolean) {
  const s = state();
  const since = Date.now();
  while (!s.held && !s.stopping) {
    try {
      if (await tryOnce(url, name, mustHold)) {
        say(`held (${name})`);
        return;
      }
      // A deploy overlaps the old and the new instance for a few seconds (measured 4 s on staging, 19 Nov), so a held
      // lease is only news once it outlasts that: a minute, or at once where the lease must be held.
      if (!s.told && (mustHold || Date.now() - since > OVERLAP_MS)) {
        s.told = true;
        console.error(`[lease] !!! another instance holds the database's lease (two instances at once?); asking again every ${RETRY_MS / 1000} s`);
        toSentry((S) => S.captureMessage("Lease held by another instance (two instances on one database?)", { level: mustHold ? "fatal" : "warning", tags: { alert: "store-lease-held" } }));
      }
    } catch (error) {
      s.client?.end().catch(() => {});
      s.client = null;
      console.error("[lease] could not ask for the lease:", error instanceof Error ? error.message : error);
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS).unref?.());
  }
}

/**
 * The lease, at boot (Postgres only). `mustHold` (CHAT_STORE=pg): waits for it, then throws when another instance still
 * holds it. Otherwise asks in the background and returns at once.
 */
// `why`: the switch that makes it must-hold, for the refusal's words (quest 7: NOTES_STORE=pg too; chat's wording kept).
export async function takeLease(url: string, opts: { mustHold: boolean; name: string; why?: string }): Promise<void> {
  if (url.startsWith("pglite:")) return;
  const s = state();
  if (opts.why) g.__norcoachLeaseWhy = opts.why;
  const beat = setInterval(() => {
    if (s.held && s.client) s.client.query("SELECT 1").catch(() => {});
  }, HEARTBEAT_MS);
  beat.unref?.();
  if (!opts.mustHold) {
    void keepAsking(url, opts.name, false);
    return;
  }
  const end = Date.now() + WAIT_MS;
  for (;;) {
    if (await tryOnce(url, opts.name, true)) {
      say(`held (${opts.name})`);
      return;
    }
    if (Date.now() >= end) break;
    if (!s.told) {
      s.told = true;
      say(`another instance holds the lease: waiting up to ${Math.round(WAIT_MS / 1000)} s for it to stop`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  await s.client?.end().catch(() => {});
  s.client = null;
  throw new Error(
    `[store] Refusing to start with ${opts.why ?? "CHAT_STORE=pg"}: another instance still holds the database's lease after ${Math.round(WAIT_MS / 1000)} s (two instances at once). Stop it, then start again (app/lib/pg/lease.ts says how to see who holds it).`
  );
}

/** Whether this instance holds the lease (for /api/timing). */
export function leaseReport() {
  const s = state();
  return { held: s.held, lostAt: s.lostAt };
}

/** At the very end of the shutdown: let the lease go, so the next instance takes it at once. */
export async function releaseLease(): Promise<void> {
  const s = state();
  s.stopping = true;
  const c = s.client;
  s.client = null;
  s.held = false;
  if (c) await c.end().catch(() => {});
}
