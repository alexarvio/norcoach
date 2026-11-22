import fs from "fs";
import os from "os";
import path from "path";
import { endChatStreams } from "./chatBus";
import { DATA_DIR, getData, STORE_MODE } from "./db";
import { errorReason, health, toSentry } from "./pg/health";
import { flushStore } from "./pg/runtime";
import { releaseLease } from "./pg/lease";
import { CHAT_PG } from "./chat/mode";
import { NOTES_PG } from "./notes/mode";
import { FOOD_PG } from "./food/mode";
import { CHECKINS_PG } from "./checkins/mode";
import { SETS_PG } from "./sets/mode";

// Shutting down without losing a save (17 Nov, the safety net). Railway stops a deploy with SIGTERM; Next's own
// handler (next/dist/server/lib/start-server.js) closes the HTTP server, waits for the requests still open, then
// calls process.exit. Nothing waited for the Postgres save on its way, and the chat's open streams kept the server
// from closing at all. Now, on SIGTERM or SIGINT:
//   1. the store is saved at once, and every chat stream is ended so the server can close;
//   2. process.exit is held while that save, and one last save after the requests have finished, go to Postgres, for
//      10 s at most from the signal;
//   3. if the last save fails or takes longer, the whole store is written to <DATA_DIR>/unsaved-<time>.json (the
//      volume; the temp folder only when that write fails), loudly in the log and to Sentry, so nothing is lost with
//      the process;
//   4. whatever happens, the process is gone 12 s after the signal (14 s when the Sentry alert is still leaving).
// Railway's draining time must leave room for it (RAILWAY_DEPLOYMENT_DRAINING_SECONDS, 15 or more).
//
// Locally under `next dev` none of this gets its chance: the parent next-dev process kills the server's child with
// SIGKILL 100 ms after passing it the signal (NEXT_EXIT_TIMEOUT_MS), and on Windows ending the child is immediate
// anyway. A save in flight there can be cut off mid-write; the local PGlite store is never relied on to flush on
// Ctrl+C. It is `next start` (scripts/start-server.mjs, Railway) this is for.

const SAVE_MS = 10_000;
const HARD_CAP_MS = 12_000;
/** How long the Sentry alert gets to leave after a failed last save; the hard cap waits for it. */
const FLUSH_MS = 1_500;

type State = { started: boolean; done: boolean; dumped: boolean; flushing: boolean };
const g = globalThis as unknown as { __norcoachShutdown?: State };

const say = (message: string) => console.log(`[shutdown] ${message}`);

/** The store as JSON beside the volume's data: the one copy left when the last save failed. Its path, or null. */
function dumpStore(why: string): string | null {
  const state = g.__norcoachShutdown!;
  if (state.dumped) return null;
  state.dumped = true;
  const name = `unsaved-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  let body: string;
  try {
    // With CHAT_STORE=pg the chat is in Postgres alone, every write of it committed before its answer: nothing of it can
    // be unsaved, and the file says so (pg/runtime.ts refuses to import one as a whole store).
    // With NOTES_STORE=pg the notifications are in Postgres too (quest 7): the file says so, and keeps the outbox (its ops not
    // yet in the table), which a pg boot drains and a memory boot of this build applies.
    // With FOOD_STORE=pg the food diary the same (quest 8 part 1): each write committed before its answer, the file says so.
    // With CHECKINS_STORE=pg the check-in figures the same (quest 9).
    const flags = { ...(CHAT_PG ? { _chat_in_postgres: true } : {}), ...(NOTES_PG ? { _notes_in_postgres: true } : {}), ...(FOOD_PG ? { _food_in_postgres: true } : {}), ...(CHECKINS_PG ? { _checkins_in_postgres: true } : {}), ...(SETS_PG ? { _sets_in_postgres: true } : {}) };
    body = CHAT_PG || NOTES_PG || FOOD_PG || CHECKINS_PG || SETS_PG ? JSON.stringify({ ...getData(), ...flags }) : JSON.stringify(getData());
  } catch (e) {
    console.error(`[shutdown] !!! the last save to Postgres failed (${why}), and the store can't even be written as JSON:`, e);
    return null;
  }
  // The volume first (DATA_DIR, where the store's own file lives): the temp folder dies with the container.
  for (const folder of [DATA_DIR, os.tmpdir()]) {
    const file = path.join(folder, name);
    try {
      fs.writeFileSync(file, body);
      console.error(`[shutdown] !!! the last save to Postgres failed (${why}). The whole store is in ${file}; the changes since ${health().lastOkAt ?? "the start"} are only there.`);
      return file;
    } catch (e) {
      console.error(`[shutdown] !!! the last save to Postgres failed (${why}), and writing the store to ${file} failed too:`, e);
    }
  }
  return null;
}

/** Settles with null once `work` resolves, with the reason once it fails or `deadline` (ms since 1970) passes. */
function until(work: Promise<unknown>, deadline: number): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("no answer from Postgres in time"), Math.max(0, deadline - Date.now()));
    work.then(
      () => {
        clearTimeout(timer);
        resolve(null);
      },
      (e) => {
        clearTimeout(timer);
        // The reason alone: drizzle's message carries the query's params (store data) to the log and Sentry.
        resolve(errorReason(e));
      }
    );
  });
}

/** Registers the shutdown once a server (instrumentation.ts, Node only, after the store is loaded). */
export function registerShutdown() {
  if (g.__norcoachShutdown) return;
  const state: State = (g.__norcoachShutdown = { started: false, done: false, dumped: false, flushing: false });
  const realExit = process.exit.bind(process) as (code?: number | string | null) => never;

  const begin = (signal: NodeJS.Signals) => {
    if (state.started) return;
    state.started = true;
    const startedAt = Date.now();
    health().shuttingDown = true;
    const ended = endChatStreams();
    say(`${signal}: saving the store${ended ? `, ending ${ended} chat ${ended === 1 ? "stream" : "streams"}` : ""}`);

    // 1. At once, while Next finishes the requests still open.
    const first = flushStore() ?? Promise.resolve();
    first.catch(() => {}); // Its failure is told by the retry's record (pg/runtime.ts); the last save decides.

    // 2. The last save, once Next asks to exit, or at the deadline if it never does.
    let finishing: Promise<void> | null = null;
    const finish = (code: number) => {
      if (finishing) return finishing;
      finishing = (async () => {
        // 10 s from the signal; a last save asked late (Next slow to close) still gets a moment, inside the hard cap.
        const deadline = Math.min(Math.max(startedAt + SAVE_MS, Date.now() + 1500), startedAt + HARD_CAP_MS - 300);
        // NOTES_STORE=pg: the notifications' outbox drained first, as far as 8 s and the deadline allow (quest 7); what is
        // left stays in kv with the last save, for the next boot.
        if (NOTES_PG) {
          const { drainOutbox } = await import("./notes/outbox");
          await until(first.catch(() => {}).then(() => drainOutbox(Math.max(0, Math.min(8_000, deadline - Date.now() - 1500)))), deadline - 1000);
        }
        // FOOD_STORE=pg: the food writes still on their chains settled first (a background one, a picture's look), so none
        // commits after the lease is let go and the next instance has loaded; the last save below then takes their meal order.
        if (FOOD_PG) {
          const { foodChainsSettled } = await import("./food/pg");
          await until(foodChainsSettled(), deadline - 1000);
        }
        // CHECKINS_STORE=pg: the check-in writes still on their chains settled the same (quest 9), before the lease goes.
        if (CHECKINS_PG) {
          const { checkInChainsSettled } = await import("./checkins/pg");
          await until(checkInChainsSettled(), deadline - 1000);
        }
        // SETS_STORE=pg: the set writes still on their chains settled the same (quest 10), before the lease goes.
        if (SETS_PG) {
          const { setChainsSettled } = await import("./sets/pg");
          await until(setChainsSettled(), deadline - 1000);
        }
        const problem = STORE_MODE === "postgres" ? await until(first.catch(() => {}).then(() => flushStore() ?? undefined), deadline) : null;
        if (problem) {
          const file = dumpStore(problem);
          toSentry((Sentry) =>
            Sentry.captureMessage(`Store not saved at shutdown: ${problem}${file ? `; written to ${file}` : ""}`, { level: "fatal", tags: { alert: "store-unsaved-at-shutdown" } })
          );
          // The message has to leave before the process does; the hard cap waits for it (FLUSH_MS more at most).
          state.flushing = true;
          await import("@sentry/nextjs").then((Sentry) => Sentry.flush(FLUSH_MS)).catch(() => {});
        } else if (STORE_MODE === "postgres") {
          say(`saved; exiting after ${Date.now() - startedAt} ms`);
          // The database's lease let go once the store is saved (pg/lease.ts), so the next instance takes it at once.
          await Promise.race([releaseLease(), new Promise((resolve) => setTimeout(resolve, 500))]);
        }
        state.done = true;
        realExit(code);
      })();
      return finishing;
    };

    // Next calls process.exit (130 / 143) once its server has closed: held until the last save is through.
    process.exit = ((code?: number | string | null) => {
      const n = typeof code === "number" ? code : Number(code ?? process.exitCode ?? 0) || 0;
      void finish(n);
      return undefined as never;
    }) as typeof process.exit;

    // Next never got there (a request that won't end): the last save at the deadline all the same, then out.
    setTimeout(() => void finish(signal === "SIGINT" ? 130 : 143), SAVE_MS).unref?.();
    // 4. Whatever happens.
    setTimeout(() => {
      if (state.done) return;
      if (state.flushing) {
        // The store is on disk already; only the alert is still leaving. Its own flush ends within FLUSH_MS.
        setTimeout(() => {
          if (state.done) return;
          console.error(`[shutdown] exiting at the ${(HARD_CAP_MS + FLUSH_MS + 500) / 1000} s limit`);
          realExit(signal === "SIGINT" ? 130 : 143);
        }, FLUSH_MS + 500);
        return;
      }
      if (STORE_MODE === "postgres") dumpStore(`still not through ${HARD_CAP_MS / 1000} s after ${signal}`);
      console.error(`[shutdown] exiting at the ${HARD_CAP_MS / 1000} s limit`);
      realExit(signal === "SIGINT" ? 130 : 143);
    }, HARD_CAP_MS);
  };

  process.on("SIGTERM", () => begin("SIGTERM"));
  process.on("SIGINT", () => begin("SIGINT"));
}
