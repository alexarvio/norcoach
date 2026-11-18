// The one door to chat rows (18 Nov, Step 5 of docs/database-plan.md). Every read and write of the chat goes through
// here; nothing else in app/ touches the store's chat list (Data.chat_messages is a sealed type in db.ts, so tsc refuses
// any other reach for it, and scripts/check-chat-door.mjs, run by the build, refuses the name and the generic loops).
//
// Still in memory. A page, route, action or job fetches its chat first, at its top (fetchThread, fetchCoachChat…), and
// hands the view it gets down to the code that reads it, which stays synchronous. In memory a fetch resolves at once;
// after the cut-over the same fetch runs its SQL (statements.ts), shaped by what the caller needs: one client's thread,
// a coach's clients' messages, the chat list's lines, a file's check. A reader handed no view doesn't compile; one
// asking a view for something it doesn't hold (another client's thread) is a miss: it throws where the views are
// narrow (CHAT_VIEWS=narrow, tests, CHAT_STRICT=1), and elsewhere is said once and counted (/api/timing, Sentry live)
// and answered from the store as before, so a screen that slipped through still draws.
//
//   CHAT_VIEWS=wide    (the default) a view reads the store when asked: exactly the rows the code read before.
//   CHAT_VIEWS=narrow  a view holds only the slice its fetch took (pick.ts): what the cut-over's queries will hand back.
//                      For staging and the tests, to prove the slices are enough before they are all there is.
//
// A write changes memory at once, before its promise is handed back (callers await it, then do their other store's work:
// the notification, persist(), chatChanged), the order the cut-over needs. Each fetch and write tells the shadow
// (shadow.ts), which never blocks or throws.

import { allocId, getData, type ChatRow, type Data } from "../db";
import type { MessageLink } from "../messageLinks";
import { chatRev } from "../chatBus";
import type { ChatPath, ChatReadPath, ChatWritePath } from "./paths";
import { HOME_NEW_DAYS, pickCoachLast, pickCoachSent, pickDock, pickExists, pickExport, pickFood, pickLacksLook, pickThread, pickToPrepare, textOrder } from "./pick";
import { noteMissed, noteSeen, onFetch, onWrite } from "./shadow";

/** The store's name for the chat, for the generic loops over every collection (removeClient, the export) to step round. */
export const CHAT_TABLE = "chat_messages";

const MODE: "wide" | "narrow" = process.env.CHAT_VIEWS === "narrow" ? "narrow" : "wide";
/** Where a miss throws rather than falling back. */
const STRICT = MODE === "narrow" || process.env.NODE_ENV === "test" || process.env.CHAT_STRICT === "1";

/** Read fresh every time: a delete puts a new list in its place. */
const rowsOf = (d: Data) => d.chat_messages as unknown as ChatRow[];
const setRows = (d: Data, next: ChatRow[]) => {
  (d as unknown as { chat_messages: ChatRow[] }).chat_messages = next;
};
const storeRows = () => rowsOf(getData());

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

/** A coach's clients' chat (or several coaches'), for the feed, Needs you and the Feed's Since. */
export class ChatCoachView {
  readonly coachIds: ReadonlySet<number>;
  readonly clientIds: ReadonlySet<number>;
  readonly path: ChatReadPath;
  #sent: readonly ChatRow[] | null;
  #home: Map<number, ChatRow[]> | null;
  #groups = new Groups();
  constructor(token: symbol, coachIds: ReadonlySet<number>, clientIds: ReadonlySet<number>, path: ChatReadPath, narrow: { sent: ChatRow[]; last: ChatRow[] } | null) {
    minted(token);
    this.coachIds = coachIds;
    this.clientIds = clientIds;
    this.path = path;
    this.#sent = narrow?.sent ?? null;
    this.#home = null;
    if (narrow) {
      const home = new Map<number, ChatRow[]>([...clientIds].map((id) => [id, []]));
      for (const m of [...narrow.sent, ...narrow.last].sort((a, b) => a.id - b.id)) home.get(m.client_id)?.push(m);
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
  /**
   * The messages these clients sent. In wide views the whole store's list, as the feed always walked it (its own
   * filters keep only these clients' and the client's side); in narrow ones only those.
   */
  clientSent(clientIds: Iterable<number>): readonly ChatRow[] {
    for (const id of clientIds) {
      if (!this.clientIds.has(id)) {
        miss(this.path, `clientSent needs client ${id}, not one of the view's (${this.path})`);
        return storeRows();
      }
    }
    return this.#sent ?? storeRows();
  }
  /** One client's rows for Needs you, in the store's order: in narrow views what they sent and the coach's last word. */
  homeRows(clientId: number): readonly ChatRow[] {
    if (!this.clientIds.has(clientId)) {
      miss(this.path, `homeRows needs client ${clientId}, not one of the view's (${this.path})`);
      return pickThread(storeRows(), clientId);
    }
    if (this.#home) return this.#home.get(clientId) ?? [];
    return this.#groups.get(storeRows(), this.clientIds, clientId);
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
  // The revision first, then the rows (after the cut-over the query's snapshot comes after the revision it is paired with).
  const rev = chatRev(clientId);
  return new ChatThread(MINT, clientId, "full", path, MODE === "narrow" ? pickThread(storeRows(), clientId) : null, rev);
}

/** One client's food diary comments (the meal guard, the food diary's actions). */
export async function fetchFoodComments(clientId: number, path: ChatReadPath): Promise<ChatThread> {
  noteSeen(path);
  onFetch({ kind: "food", clientId }, path);
  const rev = chatRev(clientId);
  return new ChatThread(MINT, clientId, "food", path, MODE === "narrow" ? pickFood(storeRows(), clientId) : null, rev);
}

/** These coaches' clients' chat, as the feed and Needs you read it. */
export async function fetchCoachChat(coachIds: readonly number[], path: ChatReadPath): Promise<ChatCoachView> {
  noteSeen(path);
  const coaches = new Set(coachIds);
  const clientIds = clientsOfCoaches(coaches);
  // Two queries after the cut-over, so two for the shadow, each counted on its own.
  onFetch({ kind: "coachSent", clientIds: [...clientIds] }, path);
  onFetch({ kind: "coachLast", clientIds: [...clientIds] }, path);
  const narrow = MODE === "narrow" ? { sent: pickCoachSent(storeRows(), clientIds), last: pickCoachLast(storeRows(), clientIds) } : null;
  return new ChatCoachView(MINT, coaches, clientIds, path, narrow);
}

/** The chat of the client's coach's clients (an action about one client: their Needs you, their feed's read marks). */
export function fetchCoachChatOfClient(clientId: number, path: ChatReadPath): Promise<ChatCoachView> {
  return fetchCoachChat([getData().clients.find((c) => c.id === clientId)?.coach_id ?? 0], path);
}

/** A coach's chat list. */
export async function fetchChatDock(coachId: number, path: ChatReadPath): Promise<ChatDockView> {
  noteSeen(path);
  const clientIds = new Set(getData().clients.filter((c) => c.coach_id === coachId).map((c) => c.id));
  const since = Date.now() - HOME_NEW_DAYS * 86_400_000 - 3_600_000;
  onFetch({ kind: "dock", clientIds: [...clientIds], since }, path);
  return new ChatDockView(MINT, coachId, clientIds, since, path, MODE === "narrow" ? pickDock(storeRows(), clientIds, since) : null);
}

/** A client's tab in the admin: the coach's view (the rail, the dots) and the client's thread. The client's own coach is
 *  in it too, should the owner open another coach's client. */
export async function fetchClientTabChat(coachId: number, clientId: number, path: ChatReadPath): Promise<{ coach: ChatCoachView; thread: ChatThread }> {
  const own = getData().clients.find((c) => c.id === clientId)?.coach_id;
  const coach = await fetchCoachChat(own != null && own !== coachId ? [coachId, own] : [coachId], path);
  return { coach, thread: await fetchThread(clientId, path) };
}

/** An admin screen with the rail and the chat list. */
export async function fetchCoachPageChat(coachId: number, path: ChatReadPath): Promise<{ coach: ChatCoachView; dock: ChatDockView }> {
  return { coach: await fetchCoachChat([coachId], path), dock: await fetchChatDock(coachId, path) };
}

/** These clients' rows, for the export. */
export async function fetchChatExport(clientIds: readonly number[], path: ChatReadPath): Promise<ChatExportRows> {
  noteSeen(path);
  onFetch({ kind: "export", clientIds: [...clientIds] }, path);
  return new ChatExportRows(MINT, pickExport(storeRows(), new Set(clientIds)));
}

/** Whether some message shows this file: read the moment it is asked; any failure says shown (the file is kept). */
export function chatShowsFile(publicPath: string, path: ChatReadPath): Promise<boolean> {
  let hit = true;
  try {
    noteSeen(path);
    hit = pickExists(storeRows(), publicPath);
    onFetch({ kind: "exists", publicPath }, path);
  } catch {
    hit = true;
  }
  return Promise.resolve(hit);
}

/** Whether some message shows this file with no look yet; a failure says no (the look is skipped). */
export function chatFileLacksLook(publicPath: string, path: ChatReadPath): Promise<boolean> {
  let lacks = false;
  try {
    noteSeen(path);
    lacks = pickLacksLook(storeRows(), publicPath);
    onFetch({ kind: "lacksLook", publicPath }, path);
  } catch {
    lacks = false;
  }
  return Promise.resolve(lacks);
}

/** Every picture or video file some message shows with no look yet, once each. */
export async function chatMediaWithoutLook(path: ChatReadPath): Promise<{ path: string; type: "image" | "video" }[]> {
  noteSeen(path);
  onFetch({ kind: "toPrepare" }, path);
  return pickToPrepare(storeRows());
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
  /** The send's once key, for the shadow to run the cut-over's statement with it (memory still takes it in once.ts). */
  onceKey?: { key: string; at: number } | null;
  /** A meal's comment: the meal it is on, for the same. */
  mealGuard?: { date: string; meal: string } | null;
};

/** A new message, as sendChatMessage always made it. */
export function insertChatRow(input: ChatInsert, path: ChatWritePath): Promise<ChatRow> {
  noteSeen(path);
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
  onWrite({ op: "insert", row, replyTo: input.replyTo ?? null, once: input.onceKey ?? null, meal: input.mealGuard ?? null }, path);
  return Promise.resolve(row);
}

/** One side's reaction set, swapped or taken off (null). False when there is no such message. The emoji is the caller's to check. */
export function setReaction(clientId: number, messageId: number, who: "client" | "coach", emoji: string | null, path: ChatWritePath): Promise<boolean> {
  noteSeen(path);
  const m = storeRows().find((x) => x.id === messageId && x.client_id === clientId);
  if (!m) return Promise.resolve(false);
  const next = { ...(m.reactions ?? {}) };
  if (emoji) next[who] = emoji;
  else delete next[who];
  if (Object.keys(next).length) m.reactions = next;
  else delete m.reactions;
  onWrite({ op: "react", id: messageId, clientId, who, emoji: emoji || null }, path);
  return Promise.resolve(true);
}

/**
 * A message of `sender`'s reworded: its text, and edited_at unless null. `foodMeal`: only a comment on a meal. Null when
 * there is no such message or the words are the same; else what it said and when it was sent.
 */
export function editText(
  clientId: number,
  messageId: number,
  edit: { sender: "client" | "coach"; text: string; editedAt: string | null; foodMeal?: boolean },
  path: ChatWritePath
): Promise<{ was_text: string; was_at: string } | null> {
  noteSeen(path);
  const msg = storeRows().find((m) => m.id === messageId && m.client_id === clientId && m.sender === edit.sender);
  if (!msg || (edit.foodMeal && (msg.link?.kind !== "food" || !msg.link.meal)) || msg.text === edit.text) return Promise.resolve(null);
  const was = { was_text: msg.text, was_at: msg.created_at };
  msg.text = edit.text;
  if (edit.editedAt != null) msg.edited_at = edit.editedAt;
  onWrite({ op: "edit", id: messageId, clientId, sender: edit.sender, text: edit.text, editedAt: edit.editedAt, foodMeal: !!edit.foodMeal, was: { text: was.was_text, at: was.was_at } }, path);
  return Promise.resolve(was);
}

/** A message of `sender`'s taken back. Null when there is no such message; else what it said, when, and its file. */
export function deleteRow(
  clientId: number,
  messageId: number,
  which: { sender: "client" | "coach"; foodMeal?: boolean },
  path: ChatWritePath
): Promise<{ text: string; created_at: string; media_path: string | null } | null> {
  noteSeen(path);
  const d = getData();
  const msg = rowsOf(d).find((m) => m.id === messageId && m.client_id === clientId && m.sender === which.sender);
  if (!msg || (which.foodMeal && (msg.link?.kind !== "food" || !msg.link.meal))) return Promise.resolve(null);
  setRows(d, rowsOf(d).filter((m) => m !== msg));
  const gone = { text: msg.text, created_at: msg.created_at, media_path: msg.media_path };
  onWrite({ op: "delete", id: messageId, clientId, sender: which.sender, foodMeal: !!which.foodMeal, was: { text: gone.text, at: gone.created_at, media: gone.media_path } }, path);
  return Promise.resolve(gone);
}

/** A coach message pointed at one thing in the client's app, or its link taken off (null). False when there is none. */
export function setLink(clientId: number, messageId: number, link: MessageLink | null, path: ChatWritePath): Promise<boolean> {
  noteSeen(path);
  const msg = storeRows().find((m) => m.id === messageId && m.client_id === clientId && m.sender === "coach");
  if (!msg) return Promise.resolve(false);
  if (link) msg.link = link;
  else delete msg.link;
  onWrite({ op: "link", id: messageId, clientId, link: link ?? null }, path);
  return Promise.resolve(true);
}

/** A message (either side's) kept at the top, or let go. False when there is none. */
export function setPinned(clientId: number, messageId: number, pinned: boolean, path: ChatWritePath): Promise<boolean> {
  noteSeen(path);
  const msg = storeRows().find((m) => m.id === messageId && m.client_id === clientId);
  if (!msg) return Promise.resolve(false);
  if (pinned) msg.pinned = true;
  else delete msg.pinned;
  onWrite({ op: "pin", id: messageId, clientId, pinned }, path);
  return Promise.resolve(true);
}

/** A file's look onto every message that shows it: their client ids, one a message, in the store's order. */
export function setLook(mediaPath: string, look: { thumb: string | null; w: number | null; h: number | null }, path: ChatWritePath): Promise<number[]> {
  noteSeen(path);
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
  return Promise.resolve(clients);
}

/** A video's file swapped for its web copy on every message that shows it: their client ids, one a message. */
export function swapPath(from: string, to: string, path: ChatWritePath): Promise<number[]> {
  noteSeen(path);
  const clients: number[] = [];
  const ids: number[] = [];
  for (const m of storeRows()) {
    if (m.media_path !== from) continue;
    m.media_path = to;
    clients.push(m.client_id);
    ids.push(m.id);
  }
  if (ids.length) onWrite({ op: "swap", from, to, ids }, path);
  return Promise.resolve(clients);
}

/** A client's whole chat, with the client (removeClient). How many went. */
export function deleteClientChat(clientId: number, path: ChatWritePath): Promise<number> {
  noteSeen(path);
  const d = getData();
  const ids = rowsOf(d)
    .filter((m) => m && typeof m === "object" && m.client_id === clientId)
    .map((m) => m.id);
  setRows(
    d,
    rowsOf(d).filter((row) => !(row && typeof row === "object" && (row as { client_id?: unknown }).client_id === clientId))
  );
  if (ids.length) onWrite({ op: "clientDelete", clientId, ids }, path);
  return Promise.resolve(ids.length);
}

/** Every chat (the workspace reset). How many went. */
export function wipeAllChat(path: ChatWritePath): Promise<number> {
  noteSeen(path);
  const d = getData();
  const ids = rowsOf(d).map((m) => m.id);
  setRows(d, []);
  if (ids.length) onWrite({ op: "wipe", ids }, path);
  return Promise.resolve(ids.length);
}

/** The chat list of a store a seed script builds (scripts/ only: check-chat-door.mjs refuses it anywhere else). */
export function seedChatRows(d: Data): ChatRow[] {
  return rowsOf(d);
}
