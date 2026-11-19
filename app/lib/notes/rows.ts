// The one door to the client's notifications (coach_activity; 19 Nov, Step 6 quest 7 of docs/database-plan.md). Every
// read and write of them goes through here; nothing else in app/ touches the store's list (Data.coach_activity is a
// sealed type in db.ts, so tsc refuses any other reach for it, and scripts/check-notes-door.mjs, run by the build,
// refuses the name and the generic loops). Built on chat's recipe (app/lib/chat/rows.ts), chat's own files untouched.
//
// A page, route, action or job fetches its notes first (fetchClientNotes, fetchNoteKeys…) and hands the view down to
// code that stays synchronous. A reader handed no view doesn't compile; one asking a view for what it doesn't hold (a
// limit past what was fetched, a key outside its family, another client) is a miss: thrown where views are narrow
// (NOTES_VIEWS=narrow, tests, NOTES_STRICT=1, NOTES_STORE=pg), and elsewhere said once, counted and answered from the
// store as before.
//
//   NOTES_VIEWS=wide    (the default) a view reads the store when asked: exactly the rows the code read before.
//   NOTES_VIEWS=narrow  a view holds only the slice its fetch took (pick.ts): what the cut-over's queries hand back.
//   NOTES_STORE=pg      (notes/mode.ts) the rows are in Postgres alone: a fetch runs statements.ts in one snapshot and
//                       lays the writes still queued (outbox.ts) over the answer; a write is an op queued in the store's
//                       kv in the same synchronous turn, drained as its statement once the store's save committed it.
//
// Writes stay synchronous in both modes (writeNote), so logCoachActivity and its ~80 call sites, the jobs and the page
// renders that note something, keep their signatures. Memory mode runs applyOp on the store: today's code, moved.

import { allocId, getData, persist, type Data, type NoteRow } from "../db";
import { coach_activity } from "../pg/schema";
import { cleanText, fromRecord } from "../pg/store";
import { applyOp, boxOf, opClock, type Holder, type NoteOp, type Outcome } from "./apply";
import { NOTES_OUTBOX, NOTES_PG, NOTES_TABLE } from "./mode";
import type { NotesReadPath, NotesWritePath } from "./paths";
import { notesChainsSettled, notesPgReport, notesRead, notesWrite, type Q, type Row } from "./pg";
import {
  chatNoteOf,
  CLIENT_NOTES_MAX,
  inFamily,
  keyedRow,
  newestOf,
  normalizeNotification,
  unreadReminderClients,
  unreadRemindersOf,
  type ChatNoteAsk,
  type ClientNotification,
} from "./pick";
import { enqueue, outboxReport, pauseDrainer, pendingEntries, purgeOps, restoreOps, sendPush, type PendingOp, type PushPayload } from "./outbox";
import { noteErrored, noteMissed, noteSeen, onFetch, onWrite } from "./shadow";
import { noteParams, readSql, REMINDER_PART, writeSql } from "./statements";

export { NOTES_TABLE };
export type { PushPayload, ClientNotification };

const MODE: "wide" | "narrow" = NOTES_PG || process.env.NOTES_VIEWS === "narrow" ? "narrow" : "wide";
/** Where a miss throws rather than falling back: always with the rows in Postgres (there is no store to fall back on). */
const STRICT = NOTES_PG || MODE === "narrow" || process.env.NODE_ENV === "test" || process.env.NOTES_STRICT === "1";
const T = "coach_activity" as const;

/** Read fresh every time: a delete puts a new list in its place. Memory mode alone. */
const rowsOf = (d: Data): NoteRow[] => {
  if (NOTES_PG) throw new Error("[notes] !!! the store's notifications were read with NOTES_STORE=pg (they live in Postgres alone)");
  const held = d as unknown as { coach_activity?: NoteRow[] };
  return (held.coach_activity ??= []);
};
const storeRows = () => rowsOf(getData());
const storeHolder: Holder = {
  get: storeRows,
  set: (rows) => {
    (getData() as unknown as { coach_activity: NoteRow[] }).coach_activity = rows;
  },
};

const decode = (r: Row) => fromRecord(coach_activity, r) as unknown as NoteRow;
const byId = (a: NoteRow, b: NoteRow) => a.id - b.id;
const union = (...lists: readonly (readonly Row[])[]) => {
  const m = new Map<number, NoteRow>();
  for (const list of lists) for (const r of list) if (!m.has(Number(r.id))) m.set(Number(r.id), decode(r));
  return [...m.values()].sort(byId);
};

/** A view asked for what it doesn't hold. */
export class NotesViewMiss extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotesViewMiss";
  }
}
function miss(path: NotesReadPath, message: string): void {
  noteMissed(path, message);
  if (STRICT) throw new NotesViewMiss(message);
}

async function pgRead<T>(path: NotesReadPath, fn: (q: Q) => Promise<T>): Promise<T> {
  try {
    return await notesRead(fn);
  } catch (error) {
    noteErrored(path, error);
    throw error;
  }
}

const MINT = Symbol("notes-door");
const minted = (token: symbol) => {
  if (token !== MINT) throw new Error("A notes view is made by the door (app/lib/notes/rows.ts) alone.");
};

// ---- The writes still queued, laid over what Postgres answered (NOTES_STORE=pg) ------------------------------------

/** Clients whose stamps the database orders otherwise (pick.ts isStrayStamp): read whole. Set by the pg boot. */
const g = globalThis as unknown as { __norcoachNotesStrays?: Set<number> };
export function setNotesStrays(ids: Iterable<number>) {
  g.__norcoachNotesStrays = new Set(ids);
}
const isStrayClient = (clientId: number) => g.__norcoachNotesStrays?.has(clientId) ?? false;

/** The keys and ids queued ops point at, and how many rows they may take away (a drop, a delete). */
function reach(entries: readonly PendingOp[]) {
  const keys = new Set<string>();
  const ids = new Set<number>();
  let removals = 0;
  for (const { op: o } of entries) {
    if (o.op === "insert" && o.mode !== "plain" && o.row.dedupe_key) keys.add(o.row.dedupe_key);
    if (o.op === "drop") {
      keys.add(o.key);
      removals++;
    }
    if (o.op === "delete") removals++;
    if (o.op === "read" || o.op === "reword" || o.op === "delete") ids.add(o.id);
    if (o.op === "tickOff") for (const id of o.ids) ids.add(id);
  }
  return { keys: [...keys], ids: [...ids], removals };
}

/**
 * Rows (by id, the store's order) with the queued ops applied as memory would. An op whose token the same snapshot shows
 * claimed (coach_activity_ops) already ran, and the snapshot holds what it did: it is left out, so an op the drainer
 * wrote while the read ran is never laid again over a newer state (a note deleted after it, a row re-sent after a read
 * mark). The drainer claims in order, so the ops left are the newest, in order.
 */
function overlay(rows: NoteRow[], entries: readonly PendingOp[], claimed: ReadonlySet<string>): NoteRow[] {
  const box = boxOf(rows);
  for (const { op: o, token } of entries) {
    if (token && claimed.has(token)) continue;
    if (o.op === "insert" && box.rows.some((r) => r.id === o.row.id)) continue;
    applyOp(box, o, opClock(o));
  }
  return box.rows;
}

/** Of these entries' tokens, those claimed, in the read's own snapshot. */
async function claimedIn(q: Q, entries: readonly PendingOp[]): Promise<Set<string>> {
  const tokens = entries.map((e) => e.token).filter((t): t is string => !!t);
  const out = new Set<string>();
  for (let i = 0; i < tokens.length; i += 1000) for (const r of await q(readSql.claimedTokens(tokens.slice(i, i + 1000)))) out.add(String(r.token));
  return out;
}

/** pg: what a set of statements answers, the client's queued ops' rows with it, then the ops laid over. */
async function pgRows(path: NotesReadPath, clientId: number | null, main: (q: Q, extra: number) => Promise<Row[][]>): Promise<NoteRow[]> {
  const entries = pendingEntries(clientId);
  const r = reach(entries);
  let claimed = new Set<string>();
  const got = await pgRead(path, async (q) => {
    const lists = await main(q, r.removals);
    if (clientId != null && r.keys.length) lists.push(await q(readSql.keys(T, clientId, r.keys)));
    if (r.ids.length) lists.push(await q(readSql.ids(T, r.ids)));
    claimed = await claimedIn(q, entries);
    return lists;
  });
  return overlay(union(...got), entries, claimed);
}

/** pg mode: a key as the table holds it (cleanText, as every op's strings are cleaned at enqueue). Memory: as it is. */
const asStored = (key: string) => (NOTES_PG ? cleanText(key) : key);
const specStored = (spec: KeySpec): KeySpec =>
  NOTES_PG
    ? { ...(spec.keys ? { keys: spec.keys.map(cleanText) } : {}), ...(spec.family ? { family: { prefix: cleanText(spec.family.prefix), suffix: cleanText(spec.family.suffix) } } : {}) }
    : spec;

// ---- Views ----------------------------------------------------------------------------------------------------------

/** One client's newest notifications (up to 500): the bell, the list, Home's Latest from, the chat's unread, a push's arrival. */
export class ClientNotes {
  readonly clientId: number;
  readonly path: NotesReadPath;
  /** Narrow and pg: the newest 500 in the list's order. */
  #slice: readonly NoteRow[] | null;
  constructor(token: symbol, clientId: number, path: NotesReadPath, slice: readonly NoteRow[] | null) {
    minted(token);
    this.clientId = clientId;
    this.path = path;
    this.#slice = slice;
  }
  /** getNotifications: the client's newest `limit`, normalised. */
  newest(clientId: number, limit: number): ClientNotification[] {
    if (clientId !== this.clientId) miss(this.path, `notes of client ${clientId} asked of a view of client ${this.clientId}`);
    else if (limit > CLIENT_NOTES_MAX) miss(this.path, `${limit} notes asked of a view of ${CLIENT_NOTES_MAX}`);
    else if (this.#slice) return this.#slice.slice(0, limit).map(normalizeNotification);
    return newestOf(storeRows(), clientId, limit).map(normalizeNotification);
  }
}

export async function fetchClientNotes(clientId: number, path: NotesReadPath): Promise<ClientNotes> {
  noteSeen(path);
  let slice: NoteRow[] | null = null;
  if (NOTES_PG) {
    const stray = isStrayClient(clientId);
    const rows = await pgRows(path, clientId, async (q, extra) => [stray ? await q(readSql.whole(T, clientId)) : await q(readSql.newest(T, clientId, CLIENT_NOTES_MAX + extra))]);
    slice = newestOf(rows, clientId, CLIENT_NOTES_MAX);
  } else if (MODE === "narrow") slice = newestOf(storeRows(), clientId, CLIENT_NOTES_MAX);
  onFetch({ kind: "newest", clientId, n: CLIENT_NOTES_MAX }, path);
  return new ClientNotes(MINT, clientId, path, slice);
}

export type KeySpec = { keys?: readonly string[]; family?: { prefix: string; suffix: string } };

/** A client's notes by their dedupe key: exact keys, or a family (`prefix…suffix`). */
export class NoteKeys {
  readonly clientId: number;
  readonly path: NotesReadPath;
  readonly spec: KeySpec;
  #slice: readonly NoteRow[] | null;
  constructor(token: symbol, clientId: number, spec: KeySpec, path: NotesReadPath, slice: readonly NoteRow[] | null) {
    minted(token);
    this.clientId = clientId;
    this.spec = spec;
    this.path = path;
    this.#slice = slice;
  }
  #covers(key: string) {
    return (this.spec.keys?.includes(key) ?? false) || (this.spec.family ? inFamily(key, this.spec.family) : false);
  }
  /** The first row of the client with this key (memory's find; the lowest id in Postgres). */
  row(asked: string): Readonly<NoteRow> | undefined {
    const key = asStored(asked);
    if (!this.#covers(key)) miss(this.path, `the key ${key.split(":")[0]}:… asked of a view that didn't fetch it`);
    else if (this.#slice) return keyedRow(this.#slice, this.clientId, key);
    return keyedRow(storeRows(), this.clientId, key);
  }
  has(key: string): boolean {
    return !!this.row(key);
  }
}

const inSpec = (r: NoteRow, clientId: number, spec: KeySpec) =>
  r.client_id === clientId && typeof r.dedupe_key === "string" && ((spec.keys?.includes(r.dedupe_key) ?? false) || (spec.family ? inFamily(r.dedupe_key, spec.family) : false));

export async function fetchNoteKeys(clientId: number, asked: KeySpec, path: NotesReadPath): Promise<NoteKeys> {
  noteSeen(path);
  const spec = specStored(asked);
  let slice: NoteRow[] | null = null;
  if (NOTES_PG) {
    const rows = await pgRows(path, clientId, async (q) => {
      const lists: Row[][] = [];
      if (spec.keys?.length) lists.push(await q(readSql.keys(T, clientId, spec.keys)));
      if (spec.family) lists.push(await q(readSql.family(T, clientId, spec.family.prefix, spec.family.suffix)));
      return lists;
    });
    slice = rows.filter((r) => inSpec(r, clientId, spec));
  } else if (MODE === "narrow") slice = storeRows().filter((r) => inSpec(r, clientId, spec));
  onFetch({ kind: "keys", clientId, spec }, path);
  return new NoteKeys(MINT, clientId, spec, path, slice);
}

/** Whose a notification is (markNotificationReadAction's check), or null. */
export async function fetchNoteOwner(id: number, path: NotesReadPath): Promise<number | null> {
  noteSeen(path);
  onFetch({ kind: "owner", id }, path);
  if (!NOTES_PG) return storeRows().find((a) => a.id === id)?.client_id ?? null;
  const rows = await pgRows(path, null, async (q) => [await q(readSql.ids(T, [id]))]);
  return rows.find((a) => a.id === id)?.client_id ?? null;
}

/** The notification a coach message was logged with (queries.ts noteFor): its id, or null. */
export async function fetchChatNote(msg: ChatNoteAsk, path: NotesReadPath): Promise<{ id: number } | null> {
  noteSeen(path);
  onFetch({ kind: "chatNote", msg }, path);
  if (!NOTES_PG) {
    const note = chatNoteOf(storeRows(), msg);
    return note ? { id: note.id } : null;
  }
  const rows = await pgRows(path, msg.client_id, async (q) => [await q(readSql.chatNote(T, msg.client_id, msg.id, msg.unknown ? null : msg.text))]);
  const note = chatNoteOf(rows, msg);
  return note ? { id: note.id } : null;
}

/** Clients with an unread reminder, in the order the store first holds one (the minute job). */
export async function fetchUnreadReminderClients(path: NotesReadPath): Promise<number[]> {
  noteSeen(path);
  onFetch({ kind: "unreadClients" }, path);
  if (!NOTES_PG) return unreadReminderClients(storeRows());
  const ids = (await pgRead(path, async (q) => q(readSql.unreadClients(T)))).map((r) => Number(r.client_id));
  // A reminder queued and not yet in the table: its client too, after the others (its id is the newest).
  // (None since the job writes its own straight to the table; kept for a box from before.)
  for (const { op: o } of pendingEntries(null)) if (o.op === "insert" && o.row.kind === "reminder" && !ids.includes(o.row.client_id)) ids.push(o.row.client_id);
  return ids;
}

/** The minute job's state for these clients: which keys exist (any read state), and each client's unread reminders. */
export class ReminderState {
  readonly path: NotesReadPath;
  #clients: ReadonlySet<number>;
  #keys: ReadonlySet<string>;
  #slice: readonly NoteRow[] | null;
  constructor(token: symbol, clientIds: readonly number[], keys: readonly string[], path: NotesReadPath, slice: readonly NoteRow[] | null) {
    minted(token);
    this.#clients = new Set(clientIds);
    this.#keys = new Set(keys);
    this.path = path;
    this.#slice = slice;
  }
  #rows(clientId: number): readonly NoteRow[] {
    if (!this.#clients.has(clientId)) miss(this.path, `the reminders of client ${clientId} asked of a view that didn't fetch them`);
    else if (this.#slice) return this.#slice;
    return storeRows();
  }
  /** A row with this key, read or not (logCoachActivity's duplicate check). */
  exists(clientId: number, asked: string): boolean {
    const key = asStored(asked);
    if (!this.#keys.has(key)) miss(this.path, `the reminder key asked of a view that didn't fetch it`);
    return !!keyedRow(this.#rows(clientId), clientId, key);
  }
  /** The client's unread reminders with a key, in the store's order. */
  unread(clientId: number): { id: number; dedupe_key: string }[] {
    return unreadRemindersOf(this.#rows(clientId), clientId);
  }
}

/** Every client's due keys, as (client, key) pairs: each key is asked of its own client alone. */
export type ReminderPair = { clientId: number; key: string };
const pairOf = (clientId: number, key: string) => `${clientId}\u0000${key}`;

export async function fetchReminderState(clientIds: readonly number[], pairs: readonly ReminderPair[], path: NotesReadPath): Promise<ReminderState> {
  noteSeen(path);
  let slice: NoteRow[] | null = null;
  const ids = new Set(clientIds);
  const pairSet = new Set(pairs.map((p) => pairOf(p.clientId, asStored(p.key))));
  const wanted = (r: NoteRow) => ids.has(r.client_id) && ((typeof r.dedupe_key === "string" && pairSet.has(pairOf(r.client_id, r.dedupe_key))) || (r.kind === "reminder" && !r.read));
  if (NOTES_PG) {
    const rows = await pgRows(path, null, async (q) => {
      const lists: Row[][] = [];
      // Two statements, each on its index, in parts (REMINDER_PART), all in the read's one snapshot.
      for (let i = 0; i < pairs.length; i += REMINDER_PART) lists.push(await q(readSql.reminderKeys(T, pairs.slice(i, i + REMINDER_PART))));
      for (let i = 0; i < clientIds.length; i += REMINDER_PART) lists.push(await q(readSql.unreadReminders(T, clientIds.slice(i, i + REMINDER_PART))));
      return lists;
    });
    slice = rows.filter(wanted);
  } else if (MODE === "narrow") slice = storeRows().filter(wanted);
  onFetch({ kind: "reminderState", clientIds: [...clientIds], pairs: pairs.map((p) => ({ ...p })) }, path);
  return new ReminderState(MINT, clientIds, pairs.map((p) => asStored(p.key)), path, slice);
}

/** One at a time per client and key, in this process: a read of a key's note, then the writes fn makes, as one step (pg mode). */
const chains = new Map<string, Promise<unknown>>();
export function notesKeyed<R>(clientId: number, key: string, fn: (view: NoteKeys) => R, path: NotesReadPath): Promise<R> {
  if (!NOTES_PG) {
    try {
      // Memory mode: the read and the writes in one synchronous turn, as before.
      noteSeen(path);
      onFetch({ kind: "keys", clientId, spec: { keys: [key] } }, path);
      const slice = MODE === "narrow" ? storeRows().filter((r) => inSpec(r, clientId, { keys: [key] })) : null;
      return Promise.resolve(fn(new NoteKeys(MINT, clientId, { keys: [key] }, path, slice)));
    } catch (error) {
      return Promise.reject(error);
    }
  }
  const slot = `${clientId}\u0000${key}`;
  const before = chains.get(slot) ?? Promise.resolve();
  const mine = before.then(
    async () => fn(await fetchNoteKeys(clientId, { keys: [key] }, path)),
    async () => fn(await fetchNoteKeys(clientId, { keys: [key] }, path))
  );
  const settled = mine.then(
    () => undefined,
    () => undefined
  );
  chains.set(slot, settled);
  void settled.then(() => {
    if (chains.get(slot) === settled) chains.delete(slot);
  });
  return mine;
}

// ---- Writes ---------------------------------------------------------------------------------------------------------

/**
 * pg mode: an op's strings as the table holds them (cleanText: no NUL, no lone surrogate), so the drainer's replace and
 * merge find the row they mean (a key typed by someone, `event:${title}`) and the views' lookups match it. Memory mode
 * keeps the raw strings, as before: the writer cleans them as it saves.
 */
function cleanOp(op: NoteOp) {
  switch (op.op) {
    case "insert": {
      const r = op.row;
      if (typeof r.message === "string") r.message = cleanText(r.message);
      if (typeof r.dedupe_key === "string") r.dedupe_key = cleanText(r.dedupe_key);
      if (typeof r.action_label === "string") r.action_label = cleanText(r.action_label);
      if (typeof op.detail === "string") op.detail = cleanText(op.detail);
      return;
    }
    case "drop":
      op.key = cleanText(op.key);
      return;
    case "reword":
      op.text = cleanText(op.text);
      return;
    default:
      return;
  }
}

/** The path a write is counted under. */
export function writePathOf(op: NoteOp): NotesWritePath {
  switch (op.op) {
    case "insert":
      return op.row.kind === "reminder" ? "w.insert.reminder" : (`w.insert.${op.mode}` as NotesWritePath);
    case "drop":
      return "w.drop";
    case "read":
      return "w.read.one";
    case "readCoachNotes":
      return "w.read.coachNotes";
    case "readAll":
      return "w.read.all";
    case "tickOff":
      return "w.reminders.tickOff";
    case "reword":
      return "w.chatNote.reword";
    case "delete":
      return "w.chatNote.delete";
  }
}

/**
 * Every write of a notification. Synchronous in both modes. Memory: applied to the store at once, persist() when it
 * changed something (`persist: false` leaves that to the caller), and the buzz (`push`, worked out only for a row that
 * went in) sent. NOTES_STORE=pg: the op queued in the store's kv with its buzz worked out now, the store saved; the
 * drainer writes it once that save committed, and buzzes only for a row it really inserted. Its outcome in memory mode.
 */
export function writeNote(op: NoteOp, opts: { push?: () => PushPayload | null; persist?: boolean } = {}): Outcome | "queued" {
  const path = writePathOf(op);
  if (NOTES_PG) {
    cleanOp(op);
    if (op.op === "insert") {
      op.row.id = allocId("coach_activity");
      op.row.created_at = new Date().toISOString();
    }
    // The highest id handed out now (one taken for it): rows written after it are not this read's to mark.
    if (op.op === "readAll" && op.upTo == null) op.upTo = allocId("coach_activity");
    const push = op.op === "insert" && op.row.kind !== "reminder" ? (opts.push?.() ?? null) : null;
    enqueue(op, push);
    onWrite(path, op, "queued");
    if (opts.persist !== false) persist();
    return "queued";
  }
  const res = applyOp(storeHolder, op, { alloc: () => allocId("coach_activity"), now: () => new Date().toISOString() });
  onWrite(path, op, res.outcome, res.row);
  if (res.outcome !== "none" && res.outcome !== "kept" && opts.persist !== false) persist();
  if (res.outcome === "inserted" && res.row && opts.push) {
    const p = opts.push();
    if (p) sendPush(p, res.row.id);
  }
  return res.outcome;
}

/** A client erased: every notification of theirs (memory at once; in pg mode a DELETE, their queued ops first dropped). */
export async function deleteClientNotes(clientId: number, path: NotesWritePath = "w.client.delete"): Promise<number> {
  onWrite(path, null, "changed", undefined, clientId);
  if (!NOTES_PG) {
    const rows = storeRows();
    // removeClient's own filter, as every collection's.
    const left = rows.filter((row) => !(row && typeof row === "object" && (row as { client_id?: unknown }).client_id === clientId));
    storeHolder.set(left);
    return rows.length - left.length;
  }
  erased.add(clientId);
  // Their queued ops out first (the drainer never takes them after this), back in should the DELETE fail, so a failed
  // erase loses nothing; a second sweep after it for ops a job queued meanwhile.
  const taken = purgeOps(clientId);
  let gone: number;
  try {
    // A lost connection as it committed: read whether their rows are gone (then done; else sent again, safe to repeat),
    // so the ops put back below are only ever those of an erase that did not happen.
    gone = await notesWrite(
      `n:${clientId}`,
      {
        op: "clientDelete",
        run: async (_q, inTx) =>
          inTx(async (q) => {
            await q(writeSql.longStatement());
            return (await q(writeSql.clientDelete(T, clientId))).length;
          }),
      },
      async (q) => ((await q(readSql.whole(T, clientId))).length ? undefined : 0)
    );
  } catch (error) {
    restoreOps(taken);
    erased.delete(clientId);
    persist();
    throw error;
  }
  purgeOps(clientId);
  persist();
  return gone;
}

/** Clients erased by this process (pg mode): the reminder job's statements leave them out, ordered behind the erase. */
const erased = new Set<number>();
/** The reset under way, or done, since a reminder tick began (its rows were worked out for the store before it). */
let wipes = 0;
/** The reminder job's statements in flight (pg mode): the reset waits for them. */
const direct = new Set<Promise<unknown>>();

/** The workspace reset: every notification. */
export async function wipeAllNotes(path: NotesWritePath = "w.wipe"): Promise<number> {
  onWrite(path, null, "changed");
  if (!NOTES_PG) {
    const n = storeRows().length;
    storeHolder.set([]);
    return n;
  }
  wipes++;
  wiping++;
  // Nothing written past the DELETE: the drainer paused (the op in flight finished), the reminder job's statements and
  // every chained write (an erase) settled; the queued ops out, back in should the DELETE fail.
  const release = await pauseDrainer();
  try {
    await Promise.allSettled([...direct]);
    await notesChainsSettled();
    const taken = purgeOps(null);
    let gone: number;
    try {
      gone = await notesWrite(
        null,
        {
          op: "wipe",
          run: async (_q, inTx) =>
            inTx(async (q) => {
              await q(writeSql.longStatement());
              return (await q(writeSql.wipe(T))).length;
            }),
        },
        async (q) => ((await q(readSql.page(T, 0, 1))).length ? undefined : 0)
      );
    } catch (error) {
      restoreOps(taken);
      persist();
      throw error;
    }
    purgeOps(null);
    persist();
    return gone;
  } finally {
    wiping--;
    release();
  }
}
let wiping = 0;

/** One client's part of a reminder tick: the reminders to add (a key not there yet), then the unread ones to tick off. */
export type ReminderPlan = { clientId: number; add: { message: string; dedupeKey: string }[]; off: number[] };

/**
 * The minute job's writes for one tick, worked out by the job from its ReminderState (queries.ts applyDueClientReminders).
 * Memory mode: `log` for each reminder (logCoachActivity, as the job always wrote them) and the tick-off as before,
 * client by client, so the store ends exactly as it did. NOTES_STORE=pg: two kinds of statement, in parts, awaited,
 * never through the outbox (a reminder tells of no change to the store, and a rollover's thousands would swell the
 * box every save rewrites): the new rows with ON CONFLICT on (client, key), so a tick run twice adds nothing, then the
 * tick-offs. Never a buzz (reminders never buzz). A client erased meanwhile is left out (its rows deleted again should
 * one slip in); a reset under way skips the tick. Whether anything was ticked off (memory mode: the job persists).
 */
export async function writeReminderTick(plans: readonly ReminderPlan[], log: (clientId: number, message: string, dedupeKey: string) => void): Promise<boolean> {
  if (!NOTES_PG) {
    let cleared = false;
    for (const p of plans) {
      for (const a of p.add) log(p.clientId, a.message, a.dedupeKey);
      if (p.off.length && writeNote({ op: "tickOff", clientId: p.clientId, ids: p.off }, { persist: false }) !== "none") cleared = true;
    }
    return cleared;
  }
  const gen = wipes;
  const work = (async () => {
    // Behind every erase already asked (their DELETEs chained), then the clients they took left out.
    await notesChainsSettled();
    if (wiping || wipes !== gen) return false;
    const live = plans.filter((p) => !erased.has(p.clientId));
    const stamp = new Date().toISOString();
    const rows = live.flatMap((p) =>
      p.add.map((a) => {
        const row: NoteRow = { id: allocId("coach_activity"), client_id: p.clientId, message: cleanText(a.message), created_at: stamp, kind: "reminder", read: false, action_tab: null, action_label: null, action_ref: null, dedupe_key: cleanText(a.dedupeKey) };
        onWrite("w.insert.reminder", { op: "insert", mode: "keep", row }, "queued");
        return noteParams(row);
      })
    );
    const off = live.flatMap((p) => p.off.map((id) => ({ clientId: p.clientId, id })));
    if (off.length) onWrite("w.reminders.tickOff", null, "queued");
    for (let i = 0; i < rows.length; i += REMINDER_PART) {
      const part = rows.slice(i, i + REMINDER_PART);
      // Safe to send again after a lost connection (its keys hold a second copy out): `verify` says "send again".
      await notesWrite(null, { op: "insertMany", run: (q) => q(writeSql.insertMany(T, part)) }, async () => undefined);
    }
    let ticked = 0;
    for (let i = 0; i < off.length; i += REMINDER_PART) {
      const part = off.slice(i, i + REMINDER_PART);
      ticked += (await notesWrite(null, { op: "tickOffMany", run: (q) => q(writeSql.tickOffMany(T, part)) }, async () => undefined)).length;
    }
    // An erase that began while the statements ran: its rows deleted again, behind it.
    for (const c of new Set(live.map((p) => p.clientId))) if (erased.has(c)) await notesWrite(`n:${c}`, { op: "clientDelete", run: (q) => q(writeSql.clientDelete(T, c)) });
    return ticked > 0;
  })();
  direct.add(work);
  try {
    return await work;
  } finally {
    direct.delete(work);
  }
}

// ---- Whole-store copies -----------------------------------------------------------------------------------------------

/** The export: these clients' rows, as the store holds them (pg: the table's, the queued ops laid over), by id. */
export async function fetchNotesExport(clientIds: readonly number[], path: NotesReadPath = "export"): Promise<NoteRow[]> {
  noteSeen(path);
  onFetch({ kind: "export", clientIds: [...clientIds] }, path);
  const ids = new Set(clientIds);
  if (!NOTES_PG) return storeRows().filter((r) => ids.has(r.client_id));
  const rows = await pgRows(path, null, async (q) => [clientIds.length ? await q(readSql.export(T, clientIds)) : []]);
  return rows.filter((r) => ids.has(r.client_id));
}

/** Every row (the backup, pg mode): the table a page at a time in one snapshot, the queued ops laid over, by id. */
export async function fetchAllNotes(path: NotesReadPath = "backup"): Promise<NoteRow[]> {
  noteSeen(path);
  if (!NOTES_PG) return storeRows();
  const entries = pendingEntries(null);
  let claimed = new Set<string>();
  const all = await pgRead(path, async (q) => {
    const out: Row[] = [];
    for (let after = 0; ; ) {
      const page = await q(readSql.page(T, after, 2000));
      if (!page.length) break;
      out.push(...page);
      after = Number(page[page.length - 1].id);
    }
    claimed = await claimedIn(q, entries);
    return out;
  });
  return overlay(union(all), entries, claimed);
}

/**
 * The store with the notifications in their key's place (right after support_messages, where emptyData has them and so
 * the loaded store holds them: tested, the backup's JSON byte for byte), for a copy of the whole store (the backup, the
 * export). With them in memory the store as it is: the key is there already.
 */
export function withNotesKey(data: Record<string, unknown>, rows: readonly NoteRow[]): Record<string, unknown> {
  if (NOTES_TABLE in data) return data;
  const out: Record<string, unknown> = {};
  let placed = false;
  // notes-door: the store copied key by key, the notifications put in their place
  for (const [k, v] of Object.entries(data)) {
    out[k] = v;
    if (k === "support_messages") {
      out[NOTES_TABLE] = rows;
      placed = true;
    }
  }
  if (!placed) out[NOTES_TABLE] = rows;
  return out;
}

/** A whole-store copy without the outbox (its ops are in the rows a fetchAllNotes laid over): the backup's JSON. */
export function notesBackupCopy(store: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...store };
  delete copy[NOTES_OUTBOX];
  return copy;
}

/** Where the notifications live, for /api/timing: counts only. */
export function notesStoreReport() {
  if (!NOTES_PG) {
    const rows = storeRows();
    return { where: "memory" as const, rows: rows.length, maxId: rows.reduce((m, r) => Math.max(m, r.id), 0) };
  }
  return { where: "pg" as const, pool: notesPgReport(), outbox: outboxReport() };
}
