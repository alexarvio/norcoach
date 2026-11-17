"use client";

import type { DraftMessages } from "../admin/redesign/messages/MessagesDraft";
import type { DockChat } from "../admin/redesign/loaders";
import { fetchChatThread } from "../components/chatFetch";

// Every thread the coach's phone has seen, kept (17 Nov, Alex: "when I open the chat, I can instantly see the
// components of it inside"): in memory for the visit, whole, and on the phone (localStorage) for the next opening of
// the app, its newest 60 messages, per coach and client. A chat opens on its kept copy at once and is brought up to
// date under it; the list fetches its first chats ahead (prefetchThreads), so most open already filled.
// A copy cut to 60 keeps no revision, so its first read is a whole one and nothing older is lost from the screen.

const KEEP_MESSAGES = 60;
const KEEP_CHATS = 30;

const memory = new Map<string, DraftMessages>();
let owner = "0";

/** Whose phone this is (the signed-in coach), so two coaches on one phone never see each other's chats. */
export function setThreadOwner(coachId: number) {
  const next = String(coachId);
  if (next === owner) return;
  owner = next;
  memory.clear();
  if (typeof window === "undefined") return;
  // Another coach than the one who kept copies on this phone: theirs go, so nothing of one coach's clients stays.
  try {
    const before = window.localStorage.getItem(OWNER_KEY);
    if (before !== null && before !== next) forgetAllThreads();
    window.localStorage.setItem(OWNER_KEY, next);
  } catch {}
}

const OWNER_KEY = "norcoach.threads-owner";

/** Every kept copy off this device (signed out, or another coach signed in): memory and the phone's storage alike. */
export function forgetAllThreads() {
  memory.clear();
  if (typeof window === "undefined") return;
  try {
    const store = window.localStorage;
    const gone: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k && (k.startsWith("norcoach.thread.") || k.startsWith("norcoach.threads.") || k === OWNER_KEY)) gone.push(k);
    }
    for (const k of gone) store.removeItem(k);
  } catch {}
}

/** One chat's kept copy off this device: the server refused it (signed out, or no longer this coach's client). */
export function forgetThread(clientId: number) {
  memory.delete(keyOf(clientId));
  try {
    window.localStorage.removeItem(storeKey(clientId));
  } catch {}
}

const keyOf = (clientId: number) => `${owner}.${clientId}`;
const storeKey = (clientId: number) => `norcoach.thread.${keyOf(clientId)}`;
const indexKey = () => `norcoach.threads.${owner}`;
const NO_TARGETS: DraftMessages["targets"] = { training: [], foodDays: [], nutrition: false, checkins: [], photos: false };

/** The app has hydrated: a chat opened from now on may draw the phone's copy in its first render. Before, it must not
 *  (the server drew it with none), and takes it in a layout effect instead. */
let readable = false;
export const markThreadsReadable = () => {
  readable = true;
};
export const threadsReadable = () => readable && typeof window !== "undefined";

/** The copy kept in memory this visit (whole, with its revision), else null. Safe while drawing on the server. */
export function threadInMemory(clientId: number): DraftMessages | null {
  if (typeof window === "undefined") return null;
  return memory.get(keyOf(clientId)) ?? null;
}

/** The kept copy: this visit's, else the one on the phone. Null when there is none (or no storage). */
export function keptThread(clientId: number): DraftMessages | null {
  const inMemory = threadInMemory(clientId);
  if (inMemory) return inMemory;
  try {
    const raw = window.localStorage.getItem(storeKey(clientId));
    if (!raw) return null;
    const t = JSON.parse(raw) as DraftMessages;
    return t && Array.isArray(t.messages) ? t : null;
  } catch {
    return null;
  }
}

/** A fresh read of the thread: kept whole in memory and, cut to its newest messages, on the phone. */
export function keepThread(clientId: number, t: DraftMessages) {
  memory.set(keyOf(clientId), t);
  try {
    const cut = t.messages.length > KEEP_MESSAGES;
    // The phone's copy: no link targets (the phone never links), and no revision when cut (see above).
    const stored: DraftMessages = { ...t, targets: NO_TARGETS, messages: t.messages.slice(0, KEEP_MESSAGES), rev: cut ? undefined : t.rev };
    window.localStorage.setItem(storeKey(clientId), JSON.stringify(stored));
    // The most recent chats only: the oldest kept copy goes past 30.
    let index: number[] = [];
    try {
      index = JSON.parse(window.localStorage.getItem(indexKey()) ?? "[]");
    } catch {}
    if (!Array.isArray(index)) index = [];
    index = [clientId, ...index.filter((id) => id !== clientId)];
    for (const gone of index.slice(KEEP_CHATS)) window.localStorage.removeItem(storeKey(gone));
    window.localStorage.setItem(indexKey(), JSON.stringify(index.slice(0, KEEP_CHATS)));
  } catch {
    // Full or blocked storage: the copy in memory still opens it at once this visit.
  }
}

/** What the list said of a chat when its copy was last brought up to date: its last message's time and unread count. */
const fetchedAt = new Map<string, string>();
const inFlight = new Set<string>();
const signOf = (c: DockChat) => `${c.last?.at ?? 0}.${c.unreadCount ?? (c.unread ? 1 : 0)}`;

/**
 * The first chats of the list fetched ahead while it shows (17 Nov), so opening one draws it at once: only those with
 * no copy this visit or something new since (by the list's own last message and count), each asked with the revision
 * held, so an unchanged one costs a 204. Never marks anything read and never quiets a push.
 */
export function prefetchThreads(chats: DockChat[], first = 5) {
  for (const c of chats.slice(0, first)) {
    const k = keyOf(c.id);
    const sign = signOf(c);
    if (inFlight.has(k) || (memory.has(k) && fetchedAt.get(k) === sign)) continue;
    inFlight.add(k);
    // The phone's own copy counts when it is whole (it kept its revision): unchanged, it is this visit's too.
    const kept = keptThread(c.id);
    void fetchChatThread<DraftMessages>(c.id, "coach", { rev: kept?.rev, from: "prefetch" })
      .then((r) => {
        if (r === "failed") return;
        if (r === "denied") return forgetThread(c.id);
        if (r === "same") {
          if (kept && !memory.has(k)) memory.set(k, kept);
        } else keepThread(c.id, r.data);
        fetchedAt.set(k, sign);
      })
      .finally(() => inFlight.delete(k));
  }
}
