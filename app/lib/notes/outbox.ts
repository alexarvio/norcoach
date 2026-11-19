// The notifications' writes on their way to Postgres (NOTES_STORE=pg, quest 7). logCoachActivity stays synchronous
// (about 80 call sites, some inside synchronous jobs and page renders), so in pg mode a write is an op appended here, in
// the store's kv (`notes_outbox`), in the same synchronous turn as the change it describes: the same store save carries
// both. The drainer then runs each op as its statement, oldest first, and only once the store's save has committed it
// (the writer's committed kv), so a note, and its buzz, never reach Postgres or a phone before the change they tell of.
//
//   committed, then drained   the op's statement commits, the op leaves the box, the next save writes the box without it
//   a crash before the save   lost, as memory mode loses an unsaved change today
//   a crash after the drain   the op runs again at the next boot: its token (coach_activity_ops, claimed by the same
//                             transaction as its statements) says it ran, so it does nothing and buzzes for nothing,
//                             whatever later ops did to its row (a note reworded or deleted after it went in)
//   the database refusing     tried again at 2, 5, 15, 30, then every 60 s (the beat and a commit never cut the wait
//                             short); a lost connection, a full pool, a lock wait, a serialisation or deadlock
//                             failure is tried for as long as it takes; any other error five times (a statement
//                             timeout thirty) moves the op to `notes_outbox_dead` (Sentry notes-outbox-dead), so one
//                             bad op never holds every client's notes behind it
//   a stuck box               Sentry notes-outbox-stuck once the oldest op has waited 5 minutes (its own enqueue time)
//                             or 1000 wait; said again after it recovers
//
// The views read Postgres and lay the ops still here over what it answers (rows.ts), so a screen shows a write at once.
// Nothing here runs in memory mode. One process at a time is the lease's (pg/lease.ts).

import { randomUUID } from "crypto";
import { allocId, getData, persist, type NoteRow } from "../db";
import { fromRecord } from "../pg/store";
import { coach_activity } from "../pg/schema";
import { toSentry } from "../pg/health";
import { applyOp, boxOf, opClock, opClient, type NoteOp } from "./apply";
import { NOTES_OUTBOX } from "./mode";
import { lostConnection, notesWrite, poolWait, safeMessage, type Q } from "./pg";
import { noteParams, readSql, writeSql } from "./statements";

/** A buzz worked out as the note was written (the client, the words), its address filled in once the row's id is known. */
export type PushPayload = { userId: number; title: string; body: string; url: string | null; tag?: string };

/** `token`: the op's own, written to coach_activity_ops by the transaction that runs it, so running it again does nothing.
 *  `at`: when it was queued (ms), for the stuck alarm and the memory boot's age check (boot.ts). */
export type OutboxEntry = { seq: number; op: NoteOp; token?: string; at?: number; push?: PushPayload | null; tries?: number };
type Box = { v: 1; next: number; ops: OutboxEntry[] };

/** An empty box, as a pg boot writes it before its first save (pg/runtime.ts), so kv holds the key from the start. */
export const freshBox = (): Box => ({ v: 1, next: 1, ops: [] });

const T = "coach_activity" as const;
const RETRY_MS = [2_000, 5_000, 15_000, 30_000, 60_000];
const DEAD_AFTER = 5;
/** A statement timeout (57014) may be the database busy, not the op: more tries before it is buried. */
const DEAD_AFTER_SLOW = 30;
const STUCK_PENDING = 1000;
const STUCK_MS = 5 * 60_000;

type State = {
  committed: (() => string | undefined) | null;
  running: boolean;
  /** Held by the reset (rows.ts wipeAllNotes): the drainer takes no op while it is above 0. */
  paused: number;
  timer: ReturnType<typeof setTimeout> | null;
  step: number;
  stuckSince: number | null;
  stuckTold: boolean;
  /** Tokens this process ran and lost the answer of: their insert, found done on the retry, still buzzes once. */
  unsure: Set<string>;
  parsedFrom: string | undefined;
  parsed: Set<number>;
  counts: { enqueued: number; drained: number; retries: number; dead: number; pushes: number; lastError: string | null };
};
const g = globalThis as unknown as { __norcoachNotesOutbox?: State };
const state = (): State =>
  (g.__norcoachNotesOutbox ??= {
    committed: null,
    running: false,
    paused: 0,
    timer: null,
    step: 0,
    stuckSince: null,
    stuckTold: false,
    unsure: new Set(),
    parsedFrom: undefined,
    parsed: new Set(),
    counts: { enqueued: 0, drained: 0, retries: 0, dead: 0, pushes: 0, lastError: null },
  });

/** The box in the store (made when absent: pg mode keeps the key, even empty, so a memory boot knows to wait). */
export function outbox(): Box {
  const d = getData() as unknown as { [key: string]: unknown };
  const b = d[NOTES_OUTBOX] as Box | undefined;
  if (b && typeof b === "object" && Array.isArray(b.ops)) return b;
  const fresh = freshBox();
  d[NOTES_OUTBOX] = fresh;
  return fresh;
}

/** An op into the box; the caller persists (the door does, in the same turn). */
export function enqueue(op: NoteOp, push: PushPayload | null) {
  const b = outbox();
  b.ops.push({ seq: b.next++, op, token: randomUUID(), at: Date.now(), ...(push ? { push } : {}) });
  state().counts.enqueued++;
}

/** An op still to go and its token (for the views' overlay: an op whose token the snapshot shows claimed is in it). */
export type PendingOp = { op: NoteOp; token?: string };

/** The ops still to go, copied, oldest first (for the views' overlay), only one client's when asked. */
export function pendingEntries(clientId?: number | null): PendingOp[] {
  const list = outbox().ops;
  return list.filter((e) => clientId == null || opClient(e.op) === clientId).map((e) => ({ op: structuredClone(e.op), ...(e.token ? { token: e.token } : {}) }));
}

/** A client erased (or the workspace reset): their ops leave the box, so nothing of theirs is written after the DELETE.
 *  The entries taken, for putting back should the DELETE fail (restoreOps). */
export function purgeOps(clientId: number | null): OutboxEntry[] {
  const b = outbox();
  const gone = clientId == null ? b.ops : b.ops.filter((e) => opClient(e.op) === clientId);
  b.ops = clientId == null ? [] : b.ops.filter((e) => opClient(e.op) !== clientId);
  return gone;
}

/** Entries a failed erase or reset took out, back in the box in their order (nothing of them ran: the drainer never
 *  sees an entry once it is out of the box, and the erase is ordered behind the client's writes). */
export function restoreOps(entries: readonly OutboxEntry[]) {
  if (!entries.length) return;
  const b = outbox();
  const have = new Set(b.ops.map((e) => e.seq));
  b.ops = [...b.ops, ...entries.filter((e) => !have.has(e.seq))].sort((x, y) => x.seq - y.seq);
}

/** The reset's: no op taken while it runs, and the one in flight finished. Hands back the release. */
export async function pauseDrainer(): Promise<() => void> {
  const s = state();
  s.paused++;
  while (s.running) await new Promise((r) => setTimeout(r, 10));
  let released = false;
  return () => {
    if (released) return;
    released = true;
    s.paused--;
    kickDrainer();
  };
}

/** The seqs the last store save committed (parsed once per commit). */
function committedSeqs(): Set<number> {
  const s = state();
  const json = s.committed?.();
  if (json !== s.parsedFrom) {
    s.parsedFrom = json;
    s.parsed = new Set();
    try {
      const b = json ? (JSON.parse(json) as Box) : null;
      for (const e of b?.ops ?? []) s.parsed.add(e.seq);
    } catch {
      /* an unreadable copy: nothing counts as committed */
    }
  }
  return s.parsed;
}

const decode = (r: Record<string, unknown>) => fromRecord(coach_activity, r) as unknown as NoteRow;
const sqlCode = (error: unknown) => String((error as { code?: unknown } | null)?.code ?? "");
/** Errors that say nothing about the op (the database away, busy, or another transaction in the way): never buried. */
const transient = (error: unknown) => lostConnection(error) || poolWait(error) || /^(40001|40P01|55P03|53\d\d\d|57P0\d)$/.test(sqlCode(error));
/** How many tries an op gets before it is buried, by its error (transient: no end). */
const triesFor = (error: unknown) => (transient(error) ? Infinity : sqlCode(error) === "57014" ? DEAD_AFTER_SLOW : DEAD_AFTER);

/** What one op did in Postgres: "inserted" alone buzzes. */
/** `inserted-before`: an op that ran already (its token claimed), as an insert that went in: it buzzes only when this
 *  process tried it and lost the answer (a connection lost as it committed), never after a restart (the buzz may be out). */
export type Drained = "inserted" | "inserted-before" | "already" | "kept" | "replaced" | "merged" | "changed" | "none";

/**
 * Runs one op as its statement(s) on `table` (coach_activity, or the shadow's table): safe to run twice. With its outbox
 * `token` (every op queued since quest 7's second pass), the token is claimed in coach_activity_ops by the same
 * transaction as the op's statements, so an op that already committed (a crash after the drain, a connection lost as it
 * committed) answers "already" and changes nothing, whatever later ops did to its row; without one (the shadow, a box
 * from before tokens) its row by id stands in, as a first try's mark.
 */
export async function runOp(op: NoteOp, table: "coach_activity" | "coach_activity_shadow" = T, write: typeof notesWrite = notesWrite, token?: string | null): Promise<Drained> {
  const t = table;
  const once = token && t === T ? token : null;
  // The op's statements on `q` (a transaction where they must hold together). `claimed`: its token was just claimed,
  // so it never ran: a row already at its id is another's.
  const body = async (q: Q, claimed: boolean): Promise<Drained> => {
    switch (op.op) {
      case "insert": {
        const row = op.row;
        const own = await ownRowOn(q, t, row);
        if (own === "ours" && !claimed) return "already";
        if (own !== "gone") {
          // Another row's id (a counter behind the table): a new id, once; on the shadow's table a difference to count.
          if (t !== T) return "none";
          row.id = allocId("coach_activity");
        }
        if (op.mode === "plain" || !row.dedupe_key) return (await q(writeSql.insertPlain(t, noteParams(row)))).length ? "inserted" : "none";
        if ((await q(writeSql.insertKeyed(t, noteParams(row)))).length) return "inserted";
        if (op.mode === "keep") return "kept";
        const locked = (await q(writeSql.lockKeyed(t, row.client_id, row.dedupe_key)))[0];
        if (!locked) return "none";
        const box = boxOf([decode(locked)]);
        const res = applyOp(box, op, opClock(op));
        if (res.outcome !== "replaced" && res.outcome !== "merged") return "kept";
        await q(writeSql.update(t, noteParams(res.row!)));
        return res.outcome;
      }
      case "drop":
        return (await q(writeSql.drop(t, op.clientId, op.key))).length ? "changed" : "none";
      case "read":
        return (await q(writeSql.read(t, op.clientId, op.id))).length ? "changed" : "none";
      case "readCoachNotes":
        return (await q(writeSql.readCoachNotes(t, op.clientId))).length ? "changed" : "none";
      case "readAll":
        return (await q(writeSql.readAll(t, op.clientId, op.upTo))).length ? "changed" : "none";
      case "tickOff":
        return (await q(writeSql.tickOff(t, op.clientId, op.ids))).length ? "changed" : "none";
      case "reword":
        return (await q(writeSql.reword(t, op.clientId, op.id, op.text))).length ? "changed" : "none";
      case "delete":
        return (await q(writeSql.delete(t, op.clientId, op.id))).length ? "changed" : "none";
      default: {
        const never: never = op;
        throw new Error(`[notes] unknown op ${(never as { op: string }).op}`);
      }
    }
  };
  const key = `n:${opClient(op)}`;
  if (once)
    return write(key, {
      op: op.op,
      run: (_q, inTx) =>
        inTx(async (q): Promise<Drained> => {
          if (!(await q(writeSql.claimOp(once))).length) return (await q(writeSql.opOutcome(once)))[0]?.outcome === "inserted" ? "inserted-before" : "already";
          const outcome = await body(q, true);
          await q(writeSql.setOpOutcome(once, outcome));
          return outcome;
        }),
    });
  // No token: a plain insert or a one-statement op on its own; a keyed insert's check, lock and update in one transaction.
  const together = op.op === "insert" && op.mode !== "plain" && !!op.row.dedupe_key;
  return write(key, { op: op.op, run: (q, inTx) => (together ? inTx((tq) => body(tq, false)) : body(q, false)) });
}
/** An insert whose id is already in the table: ours (a first try that committed), or another row's (a counter behind). */
async function ownRowOn(q: Q, t: "coach_activity" | "coach_activity_shadow", row: NoteRow): Promise<"ours" | "taken" | "gone"> {
  const got = (await q(readSql.ids(t, [row.id])))[0];
  if (!got) return "gone";
  const r = decode(got);
  return r.client_id === row.client_id && r.created_at === row.created_at && r.message === row.message ? "ours" : "taken";
}

/** Sends a buzz worked out at enqueue, to the row's own address when it has none. */
export function sendPush(p: PushPayload, noteId: number) {
  state().counts.pushes++;
  const lockScreen = { title: p.title, body: p.body, url: p.url ?? `/client?n=${noteId}`, tag: p.tag };
  void import("../push").then((push) => push.sendPushInBackground(p.userId, lockScreen)).catch(() => {});
}

function schedule(ms: number) {
  const s = state();
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    s.timer = null;
    kickDrainer();
  }, ms);
  s.timer.unref?.();
}

/** Drains what the last save committed, oldest first, one at a time. A retry's wait (`timer`) is never cut short. */
export function kickDrainer() {
  const s = state();
  if (s.running || !s.committed || s.paused > 0 || s.timer) return;
  s.running = true;
  void (async () => {
    try {
      for (;;) {
        if (s.paused > 0) break;
        const b = outbox();
        const first = b.ops[0];
        if (!first) {
          s.stuckSince = null;
          break;
        }
        watchStuck();
        if (!committedSeqs().has(first.seq)) break;
        let outcome: Drained;
        try {
          outcome = await runOp(first.op, T, notesWrite, first.token);
        } catch (error) {
          s.counts.lastError = safeMessage(error);
          if (first.token) s.unsure.add(first.token);
          // `tries` is saved with the box, so a restart doesn't give a bad op its tries again.
          if ((first.tries = (first.tries ?? 0) + 1) >= triesFor(error)) {
            bury(first, error);
            continue;
          }
          persist();
          s.counts.retries++;
          schedule(RETRY_MS[Math.min(s.step++, RETRY_MS.length - 1)]);
          break;
        }
        s.step = 0;
        // Gone from the box (purged by an erase meanwhile): nothing more to do; else out, and the box saved without it.
        const at = outbox().ops.findIndex((e) => e.seq === first.seq);
        if (at >= 0) outbox().ops.splice(at, 1);
        persist();
        s.counts.drained++;
        const unsure = !!first.token && s.unsure.delete(first.token);
        const buzz = outcome === "inserted" || (outcome === "inserted-before" && unsure);
        if (buzz && first.op.op === "insert" && first.push && first.op.row.kind !== "reminder") sendPush(first.push, first.op.row.id);
      }
    } finally {
      s.running = false;
    }
  })();
}

function bury(entry: OutboxEntry, error: unknown) {
  const d = getData() as unknown as { [key: string]: unknown };
  const dead = (Array.isArray(d.notes_outbox_dead) ? d.notes_outbox_dead : (d.notes_outbox_dead = [])) as unknown[];
  dead.push({ ...entry, at: new Date().toISOString(), code: sqlCode(error) });
  const at = outbox().ops.findIndex((e) => e.seq === entry.seq);
  if (at >= 0) outbox().ops.splice(at, 1);
  persist();
  state().counts.dead++;
  if (entry.token) state().unsure.delete(entry.token);
  console.error(`[notes] !!! an op the table refused ${entry.tries ?? 0} times (${entry.op.op}, seq ${entry.seq}, ${sqlCode(error)}) moved to notes_outbox_dead`);
  toSentry((S) => S.captureMessage("Notes outbox: an op moved to notes_outbox_dead", { level: "error", tags: { alert: "notes-outbox-dead" } }));
}

/** How long the oldest op has waited (its enqueue time; a box from before `at`, since the box was last seen empty). */
function oldestWait(b: Box, now: number): number {
  const s = state();
  if (!b.ops.length) return 0;
  const at = b.ops[0].at;
  return typeof at === "number" ? now - at : s.stuckSince == null ? 0 : now - s.stuckSince;
}

/** The stuck alarm, from the drain loop and the beat (so a box waiting out a retry is watched too). */
function watchStuck() {
  const s = state();
  const b = outbox();
  const now = Date.now();
  if (!b.ops.length) {
    s.stuckSince = null;
    s.stuckTold = false;
    return;
  }
  s.stuckSince ??= now;
  const wait = oldestWait(b, now);
  if (b.ops.length <= STUCK_PENDING && wait <= STUCK_MS) {
    // Recovered: a later stall is said again.
    s.stuckTold = false;
    return;
  }
  if (s.stuckTold) return;
  s.stuckTold = true;
  console.error(`[notes] !!! the outbox holds ${b.ops.length} ops, the oldest waiting ${Math.round(wait / 1000)} s`);
  toSentry((S) => S.captureMessage(`Notes outbox stuck: ${b.ops.length} pending`, { level: "error", tags: { alert: "notes-outbox-stuck" } }));
}

/** The boot's (pg mode): the drainer reads what the writer committed, and wakes on every commit and every 5 s. */
export function startDrainer(writer: { committedKv(key: string): string | undefined; onCommit(cb: () => void): void }) {
  const s = state();
  s.committed = () => writer.committedKv(NOTES_OUTBOX);
  writer.onCommit(() => kickDrainer());
  const beat = setInterval(() => {
    watchStuck();
    kickDrainer();
  }, 5_000);
  beat.unref?.();
  kickDrainer();
}

/** The shutdown's: drain what can go within `ms`, before the lease is let go. Whether the box is empty. It stops at the
 *  first failure (a retry's wait pending): what is left goes with the last save, for the next boot, and the database
 *  is not asked again and again in the shutdown's last seconds. */
export async function drainOutbox(ms: number): Promise<boolean> {
  const s = state();
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!outbox().ops.length) return true;
    if (s.timer) return false;
    kickDrainer();
    await new Promise((r) => setTimeout(r, 100));
  }
  return !outbox().ops.length;
}

/** For /api/timing: counts, never words. `deadInKv`: the ops buried so far, kept in kv (`dead` is this process's). */
export function outboxReport() {
  const s = state();
  const d = getData() as unknown as { [key: string]: unknown };
  const ops = d[NOTES_OUTBOX] as Box | undefined;
  const deadInKv = Array.isArray(d.notes_outbox_dead) ? d.notes_outbox_dead.length : 0;
  return { pending: ops?.ops?.length ?? 0, oldestMs: ops && Array.isArray(ops.ops) ? oldestWait(ops, Date.now()) : 0, deadInKv, paused: s.paused > 0, waitingRetry: !!s.timer, ...s.counts };
}

/** The tokens in a box (the memory boot asks coach_activity_ops which of them ran). */
export function boxTokens(box: unknown): string[] {
  const b = box as Box | null;
  return (b && Array.isArray(b.ops) ? b.ops : []).map((e) => e.token).filter((t): t is string => typeof t === "string");
}

/** The entries of a box, for the memory boot's age check (boot.ts). */
export function boxEntries(box: unknown): readonly OutboxEntry[] {
  const b = box as Box | null;
  return b && Array.isArray(b.ops) ? b.ops : [];
}

/**
 * The ops left in a box (a memory boot after pg mode): applied to the store's list with their own ids and stamps, no
 * buzz. An op whose token coach_activity_ops holds (`claimed`) ran already, and the table the store loaded holds what
 * it did: it is skipped, so a mark-all-read or a replace that ran is never laid again over rows written after it. An
 * insert whose id the list holds already is skipped (`taken` when that row is another's: a build that reused its id).
 */
export function replayInto(rows: NoteRow[], box: unknown, claimed: ReadonlySet<string> = new Set()): { rows: NoteRow[]; applied: number; claimed: number; taken: number } {
  const holder = boxOf(rows);
  let applied = 0;
  let skipped = 0;
  let taken = 0;
  for (const e of boxEntries(box)) {
    if (e.token && claimed.has(e.token)) {
      skipped++;
      continue;
    }
    if (e.op.op === "insert") {
      const row = e.op.row;
      const there = holder.rows.find((r) => r.id === row.id);
      if (there) {
        if (there.client_id !== row.client_id || there.created_at !== row.created_at || there.message !== row.message) taken++;
        continue;
      }
    }
    applyOp(holder, e.op, opClock(e.op));
    applied++;
  }
  return { rows: holder.rows, applied, claimed: skipped, taken };
}
