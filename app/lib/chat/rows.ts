// The one door to chat rows (18 Nov, Step 5 of docs/database-plan.md). Every read and write of the chat goes through
// here; nothing else in app/ touches the store's chat list (Data.chat_messages is a sealed type in db.ts, so tsc refuses
// any other reach for it, and scripts/check-chat-door.mjs, run by the build, refuses the name and the generic loops).
//
// A page, route, action or job fetches its chat first, at its top (fetchThread, fetchCoachChat…), and hands the view it
// gets down to the code that reads it, which stays synchronous. A reader handed no view doesn't compile; one asking a
// view for something it doesn't hold (another client's thread, a slice its path didn't fetch) is a miss: it throws where
// the views are narrow (CHAT_VIEWS=narrow, tests, CHAT_STRICT=1, CHAT_STORE=pg), and elsewhere is said once and counted
// (/api/timing, Sentry live) and answered from the store as before, so a screen that slipped through still draws.
//
//   CHAT_VIEWS=wide    (the default) a view reads the store when asked: exactly the rows the code read before.
//   CHAT_VIEWS=narrow  a view holds only the slice its fetch took (pick.ts): what the cut-over's queries hand back.
//                      For staging and the tests, to prove the slices are enough before they are all there is.
//   CHAT_STORE=pg      (the cut-over, chat/mode.ts) the chat is in Postgres alone: every fetch runs its SQL
//                      (statements.ts) on chat_messages in one snapshot (chat/pg.ts), views always hold their slice and
//                      a miss always throws (there is no store to fall back on); every write is one SQL statement, or one
//                      transaction where marked, committed before its promise resolves; nothing of the chat is in memory.
//
// A coach view (fetchCoachChat) holds what its path's readers cut from (paths.ts COACH_SHAPE): each client's newest
// events, the coach's newest, Needs you's, the Feed's Since, a client's last 14 days, or, for the old admin, everything.
//
// A write changes memory at once (memory mode), or commits (CHAT_STORE=pg), before its promise is handed back; callers
// await it, then do their other store's work (the notification, persist(), chatChanged). Each fetch and write tells the
// shadow (shadow.ts), which never blocks or throws.

import { allocId, getData, type ChatRow, type Data } from "../db";
import type { MessageLink } from "../messageLinks";
import { chatRev } from "../chatBus";
import { stampMs } from "../targetRule";
import { chat_messages } from "../pg/schema";
import { cleanJson, cleanText, fromRecord } from "../pg/store";
import { COACH_SHAPE, type ChatPath, type ChatReadPath, type ChatWritePath, type CoachViewPath } from "./paths";
import { CHAT_PG } from "./mode";
import { insertParams } from "./params";
import { chatRead, chatWrite, type Q, type Row } from "./pg";
import {
  HOME_NEW_DAYS,
  isStray,
  pickClientTop,
  pickCoachLast,
  pickCoachSent,
  pickCoachTop,
  pickDock,
  pickExists,
  pickExport,
  pickFood,
  pickLacksLook,
  pickNeeds,
  pickRecent,
  pickSince,
  pickStrays,
  pickThread,
  pickToPrepare,
  textOrder,
  type NeedsClient,
} from "./pick";
import { noteErrored, noteMissed, noteSeen, onFetch, onWrite, type ReadSpec } from "./shadow";
import { readSql, verifySql, writeSql } from "./statements";
import { pgStrays, storeStrays } from "./strays";

/** The store's name for the chat, for the generic loops over every collection (removeClient, the export) to step round. */
export const CHAT_TABLE = "chat_messages";

const MODE: "wide" | "narrow" = CHAT_PG || process.env.CHAT_VIEWS === "narrow" ? "narrow" : "wide";
/** Where a miss throws rather than falling back: always with the chat in Postgres (there is no store to fall back on). */
const STRICT = CHAT_PG || MODE === "narrow" || process.env.NODE_ENV === "test" || process.env.CHAT_STRICT === "1";

/** Read fresh every time: a delete puts a new list in its place. Memory mode alone. */
const rowsOf = (d: Data): ChatRow[] => {
  if (CHAT_PG) throw new Error("[chat] !!! the store's chat list was read with CHAT_STORE=pg (it lives in Postgres alone)");
  const held = d as unknown as { chat_messages?: ChatRow[] };
  return (held.chat_messages ??= []);
};
const setRows = (d: Data, next: ChatRow[]) => {
  (d as unknown as { chat_messages: ChatRow[] }).chat_messages = next;
};
const storeRows = () => rowsOf(getData());

/** A row as Postgres hands it back, as the store would hold it. */
const decode = (r: Row) => fromRecord(chat_messages, r) as unknown as ChatRow;
const byId = (a: ChatRow, b: ChatRow) => a.id - b.id;
/** Rows by id, once each, in id order. */
const union = (...lists: readonly (readonly ChatRow[])[]) => {
  const m = new Map<number, ChatRow>();
  for (const list of lists) for (const r of list) if (!m.has(r.id)) m.set(r.id, r);
  return [...m.values()].sort(byId);
};

/** A view asked for what it doesn't hold. */
export class ChatViewMiss extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatViewMiss";
  }
}
function miss(path: ChatPath, message: string): void {
  noteMissed(path, message);
  if (STRICT) throw new ChatViewMiss(message);
}

/** A read in Postgres (CHAT_STORE=pg): counted against its path when it fails, and thrown to the caller. */
async function pgRead<T>(path: ChatReadPath, fn: (q: Q) => Promise<T>): Promise<T> {
  try {
    return await chatRead(fn);
  } catch (error) {
    noteErrored(path, error);
    throw error;
  }
}

/** Views are made here alone. */
const MINT = Symbol("chat-door");
const minted = (token: symbol) => {
  if (token !== MINT) throw new Error("A chat view is made by the door (app/lib/chat/rows.ts) alone.");
};

/** Rows grouped by client in the store's order, made again only when the list was replaced or grew. */
class Groups {
  #of: readonly ChatRow[] | null = null;
  #length = -1;
  #map = new Map<number, ChatRow[]>();
  get(rows: readonly ChatRow[], clientIds: ReadonlySet<number>, clientId: number): readonly ChatRow[] {
    if (rows !== this.#of || rows.length !== this.#length) {
      this.#map = new Map([...clientIds].map((id) => [id, [] as ChatRow[]]));
      for (const m of rows) this.#map.get(m.client_id)?.push(m);
      this.#of = rows;
      this.#length = rows.length;
    }
    return this.#map.get(clientId) ?? [];
  }
}

/** One client's chat: the whole thread ("full"), or only the coach's comments on food diary days ("food"). */
export class ChatThread {
  readonly clientId: number;
  readonly kind: "full" | "food";
  readonly path: ChatReadPath;
  #slice: readonly ChatRow[] | null;
  /** The chat's revision when the slice was taken (narrow): read before the rows, never after them. */
  #rev: string | null;
  /** Wide views: the client's rows picked once, again only when the store's list was replaced or grew (as Groups). */
  #wide: { of: readonly ChatRow[]; length: number; rows: readonly ChatRow[] } | null = null;
  constructor(token: symbol, clientId: number, kind: "full" | "food", path: ChatReadPath, slice: readonly ChatRow[] | null, rev: string | null) {
    minted(token);
    this.clientId = clientId;
    this.kind = kind;
    this.path = path;
    this.#slice = slice;
    this.#rev = rev;
  }
  /**
   * The revision to hand the screen with these rows (chatBus.ts). A view holding a slice gives the revision read before
   * the slice was taken, so a message landing in between makes the screen ask again rather than keep the older rows
   * under the newer revision; a wide view reads the store when asked, so the revision is the current one, as before.
   */
  get rev(): string {
    return this.#slice && this.#rev != null ? this.#rev : chatRev(this.clientId);
  }
  #holds(accessor: string, clientId: number, full: boolean): boolean {
    if (clientId === this.clientId && (!full || this.kind === "full")) return true;
    miss(this.path, `${accessor} needs client ${clientId}${full ? "'s whole thread" : ""}; the view (${this.path}) holds client ${this.clientId}, ${this.kind}`);
    return false;
  }
  /** Its own client's rows: the slice, or (wide) the store's, picked once while the list stays the same. */
  #own(): readonly ChatRow[] {
    if (this.#slice) return this.#slice;
    const all = storeRows();
    if (!this.#wide || this.#wide.of !== all || this.#wide.length !== all.length) this.#wide = { of: all, length: all.length, rows: pickThread(all, this.clientId) };
    return this.#wide.rows;
  }
  /** The thread in the store's (id) order. */
  rows(clientId: number): readonly ChatRow[] {
    if (!this.#holds("rows", clientId, true)) return pickThread(storeRows(), clientId);
    return this.#own();
  }
  /** As listChatMessages always gave it: by the stamp's text, then the id. A new list. */
  inTextOrder(clientId: number): ChatRow[] {
    return [...this.rows(clientId)].sort(textOrder);
  }
  /** Its rows by id (a reply's quote). */
  byId(clientId: number): ReadonlyMap<number, ChatRow> {
    return new Map(this.rows(clientId).map((m) => [m.id, m] as const));
  }
  /** The coach's messages linked to a food diary day, in the thread's order (mealCommentsOn filters them further). */
  foodComments(clientId: number): ChatRow[] {
    const source = this.#holds("foodComments", clientId, false) ? this.#own() : pickThread(storeRows(), clientId);
    return pickFood(source, clientId).sort(textOrder);
  }
}

/** What a narrow coach view holds (paths.ts COACH_SHAPE), for its readers to ask (ChatCoachView.need). */
type Held = {
  /** Each client's newest n (pick.ts pickClientTop). */
  clientTop: Map<number, number>;
  /** The coach's newest n across these clients (pickCoachTop). */
  coachTop: number | null;
  /** Needs you's slice, with the coach's last word (pickNeeds, pickCoachLast). */
  needs: Set<number>;
  /** The last 14 days, whole (pickRecent). */
  recent: Set<number>;
  /** The Feed's Since, after this `prev` (pickSince). */
  since: number | null;
  /** Everything (the old admin). */
  full: boolean;
};
const emptyHeld = (): Held => ({ clientTop: new Map(), coachTop: null, needs: new Set(), recent: new Set(), since: null, full: false });

/** A slice a reader asks a coach view for. */
export type CoachNeed = "clientTop" | "coachTop" | "recent" | "full";

/** A coach's clients' chat (or several coaches'), for the feed, Needs you and the Feed's Since. */
export class ChatCoachView {
  readonly coachIds: ReadonlySet<number>;
  readonly clientIds: ReadonlySet<number>;
  readonly path: ChatReadPath;
  /** Narrow: the union of the slices its path fetched, in id order, lean. */
  #rows: readonly ChatRow[] | null;
  #held: Held | null;
  #home: Map<number, ChatRow[]> | null;
  #groups = new Groups();
  constructor(token: symbol, coachIds: ReadonlySet<number>, clientIds: ReadonlySet<number>, path: ChatReadPath, narrow: { rows: ChatRow[]; held: Held } | null) {
    minted(token);
    this.coachIds = coachIds;
    this.clientIds = clientIds;
    this.path = path;
    this.#rows = narrow?.rows ?? null;
    this.#held = narrow?.held ?? null;
    this.#home = null;
    if (narrow) {
      const home = new Map<number, ChatRow[]>([...clientIds].map((id) => [id, []]));
      for (const m of narrow.rows) home.get(m.client_id)?.push(m);
      this.#home = home;
    }
  }
  /** These coaches are in the view. */
  covers(accessor: string, coachIds: Iterable<number>): boolean {
    for (const id of coachIds) {
      if (!this.coachIds.has(id)) {
        miss(this.path, `${accessor} needs coach ${id}; the view (${this.path}) holds coaches ${[...this.coachIds].join(", ")}`);
        return false;
      }
    }
    return true;
  }
  #inView(accessor: string, clientIds: Iterable<number>): boolean {
    for (const id of clientIds) {
      if (!this.clientIds.has(id)) {
        miss(this.path, `${accessor} needs client ${id}, not one of the view's (${this.path})`);
        return false;
      }
    }
    return true;
  }
  /**
   * The messages these clients sent. In wide views the whole store's list, as the feed always walked it (its own
   * filters keep only these clients' and the client's side); in narrow ones the slices the path fetched (its readers
   * cut them as they cut the whole list, and say which slice they cut from with `need`).
   */
  clientSent(clientIds: Iterable<number>): readonly ChatRow[] {
    if (!this.#inView("clientSent", clientIds)) return storeRows();
    return this.#rows ?? storeRows();
  }
  /**
   * The slice a reader cuts from is held: each client's newest `n` (one client, or all when none is named), the coach's
   * newest `n`, a client's last 14 days, or everything. Always so in wide views; a miss otherwise.
   */
  need(kind: CoachNeed, n = 0, clientId?: number): void {
    const h = this.#held;
    if (!h || h.full) return;
    let ok: boolean;
    switch (kind) {
      case "clientTop":
        ok = clientId == null ? [...this.clientIds].every((id) => (h.clientTop.get(id) ?? 0) >= n) : (h.clientTop.get(clientId) ?? 0) >= n;
        break;
      case "coachTop":
        ok = (h.coachTop ?? 0) >= n;
        break;
      case "recent":
        ok = clientId != null && h.recent.has(clientId);
        break;
      case "full":
        ok = false;
        break;
    }
    if (!ok) miss(this.path, `a reader needs ${kind}${n ? ` ${n}` : ""}${clientId != null ? ` of client ${clientId}` : ""}; the view (${this.path}) holds less`);
  }
  /** One client's rows for Needs you, in the store's order: in narrow views their Needs-you slice and the coach's last word. */
  homeRows(clientId: number): readonly ChatRow[] {
    if (!this.clientIds.has(clientId)) {
      miss(this.path, `homeRows needs client ${clientId}, not one of the view's (${this.path})`);
      return pickThread(storeRows(), clientId);
    }
    if (this.#home) {
      if (!this.#held?.full && !this.#held?.needs.has(clientId)) miss(this.path, `homeRows needs client ${clientId}'s Needs-you slice; the view (${this.path}) has none`);
      return this.#home.get(clientId) ?? [];
    }
    return this.#groups.get(storeRows(), this.clientIds, clientId);
  }
  /** What these clients sent after `prev` (the Feed's Since: it filters further). Wide views: the whole store's list. */
  sinceRows(clientIds: Iterable<number>, prev: number): readonly ChatRow[] {
    if (!this.#inView("sinceRows", clientIds)) return storeRows();
    if (!this.#rows) return storeRows();
    if (!this.#held?.full && this.#held?.since !== prev) miss(this.path, `sinceRows needs what came after ${prev}; the view (${this.path}) holds ${this.#held?.since ?? "none"}`);
    return this.#rows;
  }
}

/** A coach's chat list: each client's last message and their new ones. */
export class ChatDockView {
  readonly coachId: number;
  readonly clientIds: ReadonlySet<number>;
  /** The fetch's window for new messages, an hour wider than the readers' own. */
  readonly since: number;
  readonly path: ChatReadPath;
  #slice: Map<number, ChatRow[]> | null;
  #groups = new Groups();
  constructor(token: symbol, coachId: number, clientIds: ReadonlySet<number>, since: number, path: ChatReadPath, slice: ChatRow[] | null) {
    minted(token);
    this.coachId = coachId;
    this.clientIds = clientIds;
    this.since = since;
    this.path = path;
    this.#slice = null;
    if (slice) {
      const map = new Map<number, ChatRow[]>([...clientIds].map((id) => [id, []]));
      for (const m of slice) map.get(m.client_id)?.push(m);
      this.#slice = map;
    }
  }
  /** One client's rows in the store's order (narrow: the slice). */
  rowsOf(clientId: number): readonly ChatRow[] {
    if (!this.clientIds.has(clientId)) {
      miss(this.path, `the dock needs client ${clientId}, not one of the view's (${this.path})`);
      return pickThread(storeRows(), clientId);
    }
    if (this.#slice) return this.#slice.get(clientId) ?? [];
    return this.#groups.get(storeRows(), this.clientIds, clientId);
  }
}

/** A coach's clients' chat rows for Settings' export. */
export class ChatExportRows {
  readonly rows: readonly ChatRow[];
  constructor(token: symbol, rows: readonly ChatRow[]) {
    minted(token);
    this.rows = rows;
  }
}

// ---- Fetches -----------------------------------------------------------------------------------------------------

const clientsOfCoaches = (coachIds: ReadonlySet<number>) =>
  new Set(getData().clients.filter((c) => c.coach_id != null && coachIds.has(c.coach_id)).map((c) => c.id));

/** One client's whole thread. */
export async function fetchThread(clientId: number, path: ChatReadPath): Promise<ChatThread> {
  noteSeen(path);
  onFetch({ kind: "thread", clientId }, path);
  // The revision first, then the rows (the query's snapshot comes after the revision it is paired with).
  const rev = chatRev(clientId);
  if (CHAT_PG) return new ChatThread(MINT, clientId, "full", path, (await pgRead(path, (q) => q(readSql.thread(CHAT_TABLE, clientId)))).map(decode), rev);
  return new ChatThread(MINT, clientId, "full", path, MODE === "narrow" ? pickThread(storeRows(), clientId) : null, rev);
}

/** One client's food diary comments (the meal guard, the food diary's actions). */
export async function fetchFoodComments(clientId: number, path: ChatReadPath): Promise<ChatThread> {
  noteSeen(path);
  onFetch({ kind: "food", clientId }, path);
  const rev = chatRev(clientId);
  if (CHAT_PG) return new ChatThread(MINT, clientId, "food", path, (await pgRead(path, (q) => q(readSql.food(CHAT_TABLE, clientId)))).map(decode), rev);
  return new ChatThread(MINT, clientId, "food", path, MODE === "narrow" ? pickFood(storeRows(), clientId) : null, rev);
}

/**
 * When the coach last had a client's chat open, as Needs you reads it (stampMs of coach_chat_read_at), less a
 * millisecond: the bound its slice reads after. Null when never, or unreadable (then the slice reads from the start).
 */
function needsAfter(clientId: number): number | null {
  const at = getData().clients.find((c) => c.id === clientId)?.coach_chat_read_at;
  if (!at) return null;
  const ms = stampMs(at);
  return Number.isFinite(ms) ? ms - 1 : null;
}

/**
 * These coaches' clients' chat, as their path's readers cut it (paths.ts COACH_SHAPE). `focus`: the one client the call
 * is about (a client's tab, an action on one client), for the slices that read that client alone.
 */
export async function fetchCoachChat(coachIds: readonly number[], path: CoachViewPath, focus?: number): Promise<ChatCoachView> {
  noteSeen(path);
  const coaches = new Set(coachIds);
  const clientIds = clientsOfCoaches(coaches);
  // The client the call is about, when none of these coaches' (a client with no coach, coach_id null): in the view too,
  // so its own slices are taken (pg and narrow views would miss, and throw, without them; a wide view reads the store
  // as before, its readers filtering by client as always, only no longer counting a miss).
  if (focus != null && !clientIds.has(focus) && getData().clients.some((c) => c.id === focus)) clientIds.add(focus);
  const all = [...clientIds];
  const focused = focus != null && clientIds.has(focus) ? [focus] : [];
  const held = emptyHeld();
  // The slices as specs: the shadow's (one query each, compared behind the answer) and the narrow and pg views' own.
  const specs: ReadSpec[] = [];
  for (const slice of COACH_SHAPE[path]) {
    switch (slice.kind) {
      case "clientTop": {
        const ids = slice.who === "all" ? all : focused;
        for (const id of ids) held.clientTop.set(id, Math.max(held.clientTop.get(id) ?? 0, slice.n));
        specs.push({ kind: "clientTop", clientIds: ids, n: slice.n });
        break;
      }
      case "coachTop":
        held.coachTop = Math.max(held.coachTop ?? 0, slice.n);
        specs.push({ kind: "coachTop", clientIds: all, n: slice.n });
        break;
      case "needs": {
        const ids = slice.who === "all" ? all : focused;
        for (const id of ids) held.needs.add(id);
        specs.push({ kind: "needs", clients: ids.map((cid): NeedsClient => ({ cid, after: needsAfter(cid) })) });
        break;
      }
      case "coachLast":
        specs.push({ kind: "coachLast", clientIds: slice.who === "all" ? all : focused });
        break;
      case "recent":
        for (const id of focused) held.recent.add(id);
        specs.push({ kind: "recent", clientIds: focused, since: Date.now() - HOME_NEW_DAYS * 86_400_000 - 3_600_000 });
        break;
      case "since": {
        // The Feed's Since counts from the coach's last visit (feedBoardData.ts sinceOf): noted before this fetch.
        const prev = getData().users.find((u) => u.id === coachIds[0] && u.role === "coach")?.feed_looked?.prev;
        if (typeof prev === "number" && Number.isFinite(prev)) {
          held.since = prev;
          specs.push({ kind: "since", clientIds: all, after: prev - 1 });
        }
        break;
      }
      case "full":
        held.full = true;
        specs.push({ kind: "coachSent", clientIds: all }, { kind: "coachLast", clientIds: all });
        break;
    }
  }
  for (const spec of specs) onFetch(spec, path);
  if (CHAT_PG) {
    const strays = [...pgStrays()].sort((a, b) => a - b);
    const rows = await pgRead(path, async (q) => {
      const lists: ChatRow[][] = [];
      for (const spec of specs) lists.push((await q(coachSql(spec, strays))).map(decode));
      if (strays.length && all.length) lists.push((await q(readSql.straysRows(CHAT_TABLE, all, strays))).map(decode));
      return union(...lists);
    });
    return new ChatCoachView(MINT, coaches, clientIds, path, { rows, held });
  }
  if (MODE !== "narrow") return new ChatCoachView(MINT, coaches, clientIds, path, null);
  const store = storeRows();
  const strays = storeStrays(store);
  const lists = specs.map((spec) => coachPick(store, spec, strays));
  lists.push(pickStrays(store, clientIds, strays));
  return new ChatCoachView(MINT, coaches, clientIds, path, { rows: union(...lists), held });
}

/** A coach view's slice as its SQL (CHAT_STORE=pg). */
function coachSql(spec: ReadSpec, strays: number[]) {
  switch (spec.kind) {
    case "clientTop":
      return readSql.clientTop(CHAT_TABLE, spec.clientIds, spec.n, strays);
    case "coachTop":
      return readSql.coachTop(CHAT_TABLE, spec.clientIds, spec.n, strays);
    case "needs":
      return readSql.needs(CHAT_TABLE, needsJson(spec.clients), strays);
    case "coachLast":
      return readSql.coachLast(CHAT_TABLE, spec.clientIds, strays);
    case "recent":
      return readSql.recent(CHAT_TABLE, spec.clientIds, new Date(spec.since).toISOString());
    case "since":
      return readSql.since(CHAT_TABLE, spec.clientIds, new Date(spec.after).toISOString());
    case "coachSent":
      return readSql.coachSent(CHAT_TABLE, spec.clientIds);
    default:
      throw new Error(`no coach slice ${spec.kind}`);
  }
}

/** A coach view's slice as its pick over the store (narrow views in memory). */
function coachPick(rows: readonly ChatRow[], spec: ReadSpec, strays: ReadonlySet<number>): ChatRow[] {
  switch (spec.kind) {
    case "clientTop":
      return pickClientTop(rows, new Set(spec.clientIds), spec.n, strays);
    case "coachTop":
      return pickCoachTop(rows, new Set(spec.clientIds), spec.n, strays);
    case "needs":
      return pickNeeds(rows, spec.clients, strays);
    case "coachLast":
      return pickCoachLast(rows, new Set(spec.clientIds), strays);
    case "recent":
      return pickRecent(rows, new Set(spec.clientIds), spec.since);
    case "since":
      return pickSince(rows, new Set(spec.clientIds), spec.after);
    case "coachSent":
      return pickCoachSent(rows, new Set(spec.clientIds));
    default:
      throw new Error(`no coach slice ${spec.kind}`);
  }
}

/** Needs you's clients as the statement takes them: JSON, `after` an ISO instant. */
const needsJson = (clients: readonly NeedsClient[]) =>
  JSON.stringify(clients.map((c) => ({ cid: c.cid, after: c.after == null || !Number.isFinite(c.after) ? null : new Date(c.after).toISOString() })));

/** The chat of the client's coach's clients (an action about one client: their Needs you, their feed's read marks). */
export function fetchCoachChatOfClient(clientId: number, path: CoachViewPath): Promise<ChatCoachView> {
  return fetchCoachChat([getData().clients.find((c) => c.id === clientId)?.coach_id ?? 0], path, clientId);
}

/** A coach's chat list. */
export async function fetchChatDock(coachId: number, path: ChatReadPath): Promise<ChatDockView> {
  noteSeen(path);
  const clientIds = new Set(getData().clients.filter((c) => c.coach_id === coachId).map((c) => c.id));
  const since = Date.now() - HOME_NEW_DAYS * 86_400_000 - 3_600_000;
  onFetch({ kind: "dock", clientIds: [...clientIds], since }, path);
  if (CHAT_PG) {
    const ids = [...clientIds];
    const strays = [...pgStrays()].sort((a, b) => a - b);
    const rows = await pgRead(path, async (q) =>
      union(
        (await q(readSql.dockRecent(CHAT_TABLE, ids, since))).map(decode),
        (await q(readSql.dockLast(CHAT_TABLE, ids))).map(decode),
        // The strays whole: their stamp reads one way in the readers and another in the SQL.
        strays.length && ids.length ? (await q(readSql.straysRows(CHAT_TABLE, ids, strays))).map(decode) : []
      )
    );
    return new ChatDockView(MINT, coachId, clientIds, since, path, rows);
  }
  if (MODE !== "narrow") return new ChatDockView(MINT, coachId, clientIds, since, path, null);
  const store = storeRows();
  return new ChatDockView(MINT, coachId, clientIds, since, path, union(pickDock(store, clientIds, since), pickStrays(store, clientIds, storeStrays(store))));
}

/** A client's tab in the admin: the coach's view (the rail, the dots) and the client's thread. The client's own coach is
 *  in it too, should the owner open another coach's client. */
export async function fetchClientTabChat(coachId: number, clientId: number, path: CoachViewPath): Promise<{ coach: ChatCoachView; thread: ChatThread }> {
  // A client with no coach reads as coach 0's (getClientHome's `coach_id ?? 0`, as fetchCoachChatOfClient asks), so the
  // view covers that too: it holds no one else for it, and the readers find no rows of any coach 0.
  const own = getData().clients.find((c) => c.id === clientId)?.coach_id ?? 0;
  const coach = await fetchCoachChat(own !== coachId ? [coachId, own] : [coachId], path, clientId);
  return { coach, thread: await fetchThread(clientId, path) };
}

/** An admin screen with the rail and the chat list. */
export async function fetchCoachPageChat(coachId: number, path: CoachViewPath): Promise<{ coach: ChatCoachView; dock: ChatDockView }> {
  return { coach: await fetchCoachChat([coachId], path), dock: await fetchChatDock(coachId, path) };
}

/** These clients' rows, for the export. */
export async function fetchChatExport(clientIds: readonly number[], path: ChatReadPath): Promise<ChatExportRows> {
  noteSeen(path);
  onFetch({ kind: "export", clientIds: [...clientIds] }, path);
  if (CHAT_PG) return new ChatExportRows(MINT, (await pgRead(path, (q) => q(readSql.exportRows(CHAT_TABLE, clientIds)))).map(decode));
  return new ChatExportRows(MINT, pickExport(storeRows(), new Set(clientIds)));
}

/**
 * Every chat row, in id order (the nightly JSON backup with CHAT_STORE=pg: one snapshot, 2000 rows a statement). In
 * memory mode the store's own list.
 */
export async function fetchAllChat(path: ChatReadPath): Promise<readonly ChatRow[]> {
  noteSeen(path);
  if (!CHAT_PG) return storeRows();
  return pgRead(path, async (q) => {
    const out: ChatRow[] = [];
    for (let after = 0; ; ) {
      const page = (await q(readSql.page(CHAT_TABLE, after, 2000))).map(decode);
      if (!page.length) return out;
      out.push(...page);
      after = page[page.length - 1].id;
    }
  });
}

/**
 * The store with the chat in its key's place (right after assignment_custom_values, where emptyData has it), for a copy
 * of the whole store (the backup, the export). With the chat in memory the store as it is: the key is there already.
 */
export function withChatKey(data: Record<string, unknown>, rows: readonly ChatRow[]): Record<string, unknown> {
  if (CHAT_TABLE in data) return data;
  const out: Record<string, unknown> = {};
  let placed = false;
  // chat-door: the store copied key by key, the chat's rows put in their place
  for (const [k, v] of Object.entries(data)) {
    out[k] = v;
    if (k === "assignment_custom_values") {
      out[CHAT_TABLE] = rows;
      placed = true;
    }
  }
  if (!placed) out[CHAT_TABLE] = rows;
  return out;
}

/** A send's once key already taken (chatSend's early look with CHAT_STORE=pg). False on any error: the insert is the guard. */
export async function chatOnceTaken(key: string): Promise<boolean> {
  if (!CHAT_PG) return false;
  try {
    return (await chatRead((q) => q(verifySql.onceTaken("once_keys", key)))).length > 0;
  } catch {
    return false;
  }
}

/** Whether some message shows this file: read the moment it is asked; any failure says shown (the file is kept). */
export async function chatShowsFile(publicPath: string, path: ChatReadPath): Promise<boolean> {
  let hit = true;
  try {
    noteSeen(path);
    if (CHAT_PG) hit = !!(await chatRead((q) => q(readSql.exists(CHAT_TABLE, publicPath))))[0]?.hit;
    else hit = pickExists(storeRows(), publicPath);
    onFetch({ kind: "exists", publicPath }, path);
  } catch {
    hit = true;
  }
  return hit;
}

/** Whether some message shows this file with no look yet; a failure says no (the look is skipped). */
export async function chatFileLacksLook(publicPath: string, path: ChatReadPath): Promise<boolean> {
  let lacks = false;
  try {
    noteSeen(path);
    if (CHAT_PG) lacks = !!(await chatRead((q) => q(readSql.lacksLook(CHAT_TABLE, publicPath))))[0]?.hit;
    else lacks = pickLacksLook(storeRows(), publicPath);
    onFetch({ kind: "lacksLook", publicPath }, path);
  } catch {
    lacks = false;
  }
  return lacks;
}

/** Every picture or video file some message shows with no look yet, once each. A failure (CHAT_STORE=pg) says none. */
export async function chatMediaWithoutLook(path: ChatReadPath): Promise<{ path: string; type: "image" | "video" }[]> {
  noteSeen(path);
  onFetch({ kind: "toPrepare" }, path);
  if (!CHAT_PG) return pickToPrepare(storeRows());
  try {
    return (await chatRead((q) => q(readSql.toPrepare(CHAT_TABLE))))
      .sort((a, b) => Number(a.id) - Number(b.id))
      .map((r) => ({ path: String(r.media_path), type: r.media_type === "video" ? ("video" as const) : ("image" as const) }));
  } catch {
    return [];
  }
}

// ---- Writes ------------------------------------------------------------------------------------------------------

export type ChatInsert = {
  clientId: number;
  sender: "client" | "coach";
  text: string;
  media?: { path: string; type: "image" | "video" | "audio" | "file"; name?: string | null } | null;
  link?: MessageLink | null;
  /** The message it answers; kept only when that message is in this chat. */
  replyTo?: number | null;
  /** When it was sent, when not now (the demo client's backdated messages). */
  createdAt?: string;
  /**
   * The send's once key. Memory mode: for the shadow to run the cut-over's statement with it (memory takes it in once.ts).
   * CHAT_STORE=pg: written by the insert's own statement, none written, no message (null back); `result` is what once()
   * answers a second arrival with (the media review's replies: true).
   */
  onceKey?: { key: string; at: number; result?: unknown } | null;
  /** A meal's comment: the meal it is on. CHAT_STORE=pg: its advisory lock and the insert in one transaction, null back when it has one. */
  mealGuard?: { date: string; meal: string } | null;
};

/** A Postgres error's SQLSTATE (drizzle wraps it as the cause). */
const pgCode = (error: unknown) => {
  const e = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  return String((e as { code?: unknown } | null)?.code ?? "");
};

/**
 * A new message, as sendChatMessage always made it. Memory mode: always the row. CHAT_STORE=pg: the row once committed,
 * or null when its once key was taken already or the meal has its comment (nothing written).
 */
export async function insertChatRow(input: ChatInsert, path: ChatWritePath): Promise<ChatRow | null> {
  noteSeen(path);
  if (CHAT_PG) return insertInPg(input);
  const rows = storeRows();
  const answers = input.replyTo != null && rows.some((m) => m.id === input.replyTo && m.client_id === input.clientId) ? input.replyTo : null;
  const media = input.media ?? undefined;
  const row: ChatRow = {
    id: allocId("chat_messages"),
    client_id: input.clientId,
    sender: input.sender,
    text: input.text,
    media_path: media?.path ?? null,
    media_type: media?.type ?? null,
    ...(media?.name ? { media_name: media.name } : {}),
    created_at: input.createdAt ?? new Date().toISOString(),
    ...(input.link ? { link: input.link } : {}),
    ...(answers != null ? { reply_to: answers } : {}),
  };
  rows.push(row);
  onWrite({ op: "insert", row, replyTo: input.replyTo ?? null, once: input.onceKey ? { key: input.onceKey.key, at: input.onceKey.at } : null, meal: input.mealGuard ?? null }, path);
  return row;
}

async function insertInPg(input: ChatInsert): Promise<ChatRow | null> {
  const media = input.media ?? undefined;
  const createdAt = input.createdAt ?? new Date().toISOString();
  const make = (): ChatRow => ({
    id: allocId("chat_messages"),
    client_id: input.clientId,
    sender: input.sender,
    text: input.text,
    media_path: media?.path ?? null,
    media_type: media?.type ?? null,
    ...(media?.name ? { media_name: media.name } : {}),
    created_at: createdAt,
    ...(input.link ? { link: input.link } : {}),
  });
  for (let attempt = 0; ; attempt++) {
    const row = make();
    const p = insertParams(row, input.replyTo ?? null, input.onceKey ?? null, input.mealGuard ?? null);
    const meal = input.mealGuard;
    try {
      const got = await chatWrite<Row[]>(
        null,
        {
          op: "insert",
          run: (q, inTx) =>
            meal
              ? inTx(async (t) => {
                  await t(writeSql.mealLock(p.client_id, meal.date, meal.meal));
                  return t(writeSql.insert(CHAT_TABLE, "once_keys", p));
                })
              : q(writeSql.insert(CHAT_TABLE, "once_keys", p)),
        },
        // A lost connection: our row there (its id, side, words and stamp) means it committed; none means it did not.
        async (q) => {
          const found = (await q(verifySql.byId(CHAT_TABLE, p.id)))[0];
          if (!found) return undefined;
          if (Number(found.client_id) === p.client_id && found.sender === p.sender && found.text === p.text && found.created_at === p.created_at) return [{ id: found.id, answered: found.answered }];
          throw new Error(`[chat] message ${p.id} is someone else's after a lost connection`);
        }
      );
      if (!got.length) {
        // Nothing written by this statement: a repeat, or the meal's second comment. Unless it was this send's own first
        // try, committed as its connection was lost a moment before the verify could see it, and the retry then found its
        // own key or comment: our id there, as we wrote it, means it went in (posted, so its note and chatChanged follow).
        const ours = await ownRow(p);
        if (!ours) return null;
        return settled(row, ours, input);
      }
      return settled(row, got[0], input);
    } catch (error) {
      // The id already in the table. Our own first try, committed after its connection went (the retry waited on its
      // key, then collided): it went in. Else a counter behind the table after a crash (the id is chat_messages' one
      // unique key, the once key's conflict is DO NOTHING): a new id, once. A second collision throws.
      if (attempt === 0 && pgCode(error) === "23505") {
        const ours = await ownRow(p);
        if (ours) return settled(row, ours, input);
        console.error("[chat] a new message's id was in the table already: a new id");
        continue;
      }
      throw error;
    }
  }
}

/** The row as committed: its reply kept when the statement kept it, a stray noted. */
function settled(row: ChatRow, got: Row, input: ChatInsert): ChatRow {
  if (got.answered) row.reply_to = input.replyTo ?? null;
  if (isStray(row)) pgStrays().add(row.id);
  return row;
}

/** This insert's own row in the table (its id, client, side, words and stamp), or null. A failed look says null. */
async function ownRow(p: ReturnType<typeof insertParams>): Promise<Row | null> {
  try {
    const found = (await chatRead((q) => q(verifySql.byId(CHAT_TABLE, p.id))))[0];
    return found && Number(found.client_id) === p.client_id && found.sender === p.sender && found.text === p.text && found.created_at === p.created_at ? found : null;
  } catch {
    return null;
  }
}

/** A lost connection on a write that is the same however often it runs: try it again (verify says "not done"). */
const again = async () => undefined;

/** One side's reaction set, swapped or taken off (null). False when there is no such message. The emoji is the caller's to check. */
export async function setReaction(clientId: number, messageId: number, who: "client" | "coach", emoji: string | null, path: ChatWritePath): Promise<boolean> {
  noteSeen(path);
  if (CHAT_PG) {
    const rows = await chatWrite(`m:${messageId}`, { op: "react", run: (q) => q(writeSql.react(CHAT_TABLE, messageId, clientId, who, emoji || null)) }, again);
    return rows.length === 1;
  }
  const m = storeRows().find((x) => x.id === messageId && x.client_id === clientId);
  if (!m) return false;
  const next = { ...(m.reactions ?? {}) };
  if (emoji) next[who] = emoji;
  else delete next[who];
  if (Object.keys(next).length) m.reactions = next;
  else delete m.reactions;
  onWrite({ op: "react", id: messageId, clientId, who, emoji: emoji || null }, path);
  return true;
}

/**
 * A message of `sender`'s reworded: its text, and edited_at unless null. `foodMeal`: only a comment on a meal. Null when
 * there is no such message or the words are the same; else what it said and when it was sent.
 */
export async function editText(
  clientId: number,
  messageId: number,
  edit: { sender: "client" | "coach"; text: string; editedAt: string | null; foodMeal?: boolean },
  path: ChatWritePath
): Promise<{ was_text: string | null; was_at: string | null; unknown?: true } | null> {
  noteSeen(path);
  if (CHAT_PG) {
    const text = cleanText(edit.text);
    const rows = await chatWrite<Row[]>(
      `m:${messageId}`,
      { op: "edit", run: (q) => q(writeSql.edit(CHAT_TABLE, messageId, clientId, edit.sender, text, edit.editedAt, !!edit.foodMeal)) },
      async (q) => {
        const found = (await q(verifySql.byId(CHAT_TABLE, messageId)))[0];
        if (found && found.text !== text) return undefined;
        // Gone: nothing to tell. Reworded already: it went through, what it said before lost with the connection, so the
        // caller is told so (null words): its note is found by the message's id alone, and the screens are told.
        if (!found) return [];
        console.error(`[chat] an edit of message ${messageId} committed as its connection was lost: its note is found by id`);
        return [{ was_text: null, was_at: null, unknown: true }];
      }
    );
    const r = rows[0];
    if (!r) return null;
    return { was_text: r.was_text == null ? null : String(r.was_text), was_at: r.was_at == null ? null : String(r.was_at), ...(r.unknown ? { unknown: true as const } : {}) };
  }
  const msg = storeRows().find((m) => m.id === messageId && m.client_id === clientId && m.sender === edit.sender);
  if (!msg || (edit.foodMeal && (msg.link?.kind !== "food" || !msg.link.meal)) || msg.text === edit.text) return null;
  const was = { was_text: msg.text, was_at: msg.created_at };
  msg.text = edit.text;
  if (edit.editedAt != null) msg.edited_at = edit.editedAt;
  onWrite({ op: "edit", id: messageId, clientId, sender: edit.sender, text: edit.text, editedAt: edit.editedAt, foodMeal: !!edit.foodMeal, was: { text: was.was_text, at: was.was_at } }, path);
  return was;
}

/** A message of `sender`'s taken back. Null when there is no such message; else what it said, when, and its file. */
export async function deleteRow(
  clientId: number,
  messageId: number,
  which: { sender: "client" | "coach"; foodMeal?: boolean },
  path: ChatWritePath
): Promise<{ text: string | null; created_at: string | null; media_path: string | null; unknown?: true } | null> {
  noteSeen(path);
  if (CHAT_PG) {
    const rows = await chatWrite<Row[]>(
      `m:${messageId}`,
      { op: "delete", run: (q) => q(writeSql.remove(CHAT_TABLE, messageId, clientId, which.sender, !!which.foodMeal)) },
      async (q) => {
        if ((await q(verifySql.byId(CHAT_TABLE, messageId))).length) return undefined;
        // Gone, by this delete (or one just before it): told as gone with what it said unknown, so its note is found by the
        // message's id alone and the screens are told; its file is kept (what it showed is lost with the connection).
        console.error(`[chat] a delete of message ${messageId} committed as its connection was lost: its note is found by id, its file, if any, kept`);
        return [{ unknown: true }];
      }
    );
    const r = rows[0];
    if (!r) return null;
    if (r.unknown) return { text: null, created_at: null, media_path: null, unknown: true };
    return { text: String(r.text ?? ""), created_at: String(r.created_at ?? ""), media_path: r.media_path == null ? null : String(r.media_path) };
  }
  const d = getData();
  const msg = rowsOf(d).find((m) => m.id === messageId && m.client_id === clientId && m.sender === which.sender);
  if (!msg || (which.foodMeal && (msg.link?.kind !== "food" || !msg.link.meal))) return null;
  setRows(d, rowsOf(d).filter((m) => m !== msg));
  const gone = { text: msg.text, created_at: msg.created_at, media_path: msg.media_path };
  onWrite({ op: "delete", id: messageId, clientId, sender: which.sender, foodMeal: !!which.foodMeal, was: { text: gone.text, at: gone.created_at, media: gone.media_path } }, path);
  return gone;
}

/** A coach message pointed at one thing in the client's app, or its link taken off (null). False when there is none. */
export async function setLink(clientId: number, messageId: number, link: MessageLink | null, path: ChatWritePath): Promise<boolean> {
  noteSeen(path);
  if (CHAT_PG) {
    const rows = await chatWrite(`m:${messageId}`, { op: "link", run: (q) => q(writeSql.link(CHAT_TABLE, messageId, clientId, link ? cleanJson(link) : null)) }, again);
    return rows.length === 1;
  }
  const msg = storeRows().find((m) => m.id === messageId && m.client_id === clientId && m.sender === "coach");
  if (!msg) return false;
  if (link) msg.link = link;
  else delete msg.link;
  onWrite({ op: "link", id: messageId, clientId, link: link ?? null }, path);
  return true;
}

/** A message (either side's) kept at the top, or let go. False when there is none. */
export async function setPinned(clientId: number, messageId: number, pinned: boolean, path: ChatWritePath): Promise<boolean> {
  noteSeen(path);
  if (CHAT_PG) {
    const rows = await chatWrite(`m:${messageId}`, { op: "pin", run: (q) => q(writeSql.pin(CHAT_TABLE, messageId, clientId, pinned)) }, again);
    return rows.length === 1;
  }
  const msg = storeRows().find((m) => m.id === messageId && m.client_id === clientId);
  if (!msg) return false;
  if (pinned) msg.pinned = true;
  else delete msg.pinned;
  onWrite({ op: "pin", id: messageId, clientId, pinned }, path);
  return true;
}

/** Client ids of these rows, in id order (one a message). */
const clientsOf = (rows: Row[]) => rows.map((r) => ({ id: Number(r.id), client: Number(r.client_id) })).sort((a, b) => a.id - b.id).map((r) => r.client);

/** A file's look onto every message that shows it: their client ids, one a message, in the store's order. */
export async function setLook(mediaPath: string, look: { thumb: string | null; w: number | null; h: number | null }, path: ChatWritePath): Promise<number[]> {
  noteSeen(path);
  if (CHAT_PG) {
    const json = cleanJson({ media_thumb: look.thumb, media_w: look.w, media_h: look.h }) ?? "{}";
    return clientsOf(await chatWrite(`f:${mediaPath}`, { op: "look", run: (q) => q(writeSql.look(CHAT_TABLE, cleanText(mediaPath), json)) }, again));
  }
  const clients: number[] = [];
  const ids: number[] = [];
  for (const m of storeRows()) {
    if (m.media_path !== mediaPath) continue;
    m.media_thumb = look.thumb;
    m.media_w = look.w;
    m.media_h = look.h;
    clients.push(m.client_id);
    ids.push(m.id);
  }
  if (ids.length) onWrite({ op: "look", mediaPath, look: { media_thumb: look.thumb, media_w: look.w, media_h: look.h }, ids }, path);
  return clients;
}

/** A video's file swapped for its web copy on every message that shows it: their client ids, one a message. */
export async function swapPath(from: string, to: string, path: ChatWritePath): Promise<number[]> {
  noteSeen(path);
  if (CHAT_PG) {
    const rows = await chatWrite<Row[]>(
      `f:${from}`,
      { op: "swap", run: (q) => q(writeSql.swap(CHAT_TABLE, cleanText(from), cleanText(to))) },
      // A lost connection: messages showing the web copy mean it went through.
      async (q) => {
        const now = await q(verifySql.byPath(CHAT_TABLE, cleanText(to)));
        return now.length ? now : undefined;
      }
    );
    return clientsOf(rows);
  }
  const clients: number[] = [];
  const ids: number[] = [];
  for (const m of storeRows()) {
    if (m.media_path !== from) continue;
    m.media_path = to;
    clients.push(m.client_id);
    ids.push(m.id);
  }
  if (ids.length) onWrite({ op: "swap", from, to, ids }, path);
  return clients;
}

/** A client's whole chat, with the client (removeClient). How many went. */
export async function deleteClientChat(clientId: number, path: ChatWritePath): Promise<number> {
  noteSeen(path);
  if (CHAT_PG) return (await chatWrite(`c:${clientId}`, { op: "clientDelete", run: (q) => q(writeSql.clientDelete(CHAT_TABLE, clientId)) }, again)).length;
  const d = getData();
  const ids = rowsOf(d)
    .filter((m) => m && typeof m === "object" && m.client_id === clientId)
    .map((m) => m.id);
  setRows(
    d,
    rowsOf(d).filter((row) => !(row && typeof row === "object" && (row as { client_id?: unknown }).client_id === clientId))
  );
  if (ids.length) onWrite({ op: "clientDelete", clientId, ids }, path);
  return ids.length;
}

/** Every chat (the workspace reset). How many went. */
export async function wipeAllChat(path: ChatWritePath): Promise<number> {
  noteSeen(path);
  if (CHAT_PG) return (await chatWrite("wipe", { op: "wipe", run: (q) => q(writeSql.wipe(CHAT_TABLE)) }, again)).length;
  const d = getData();
  const ids = rowsOf(d).map((m) => m.id);
  setRows(d, []);
  if (ids.length) onWrite({ op: "wipe", ids }, path);
  return ids.length;
}

/** The chat list of a store a seed script builds (scripts/ only: check-chat-door.mjs refuses it anywhere else). */
export function seedChatRows(d: Data): ChatRow[] {
  return rowsOf(d);
}
