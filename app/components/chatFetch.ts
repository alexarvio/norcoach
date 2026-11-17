"use client";

import { freshSignIn } from "../lib/uploadFirst";

// The browser's side of the chats' own routes (17 Nov, Alex: the coach's phone chat took seconds to open and a message
// sat on Sending). Every chat (the client's, the coach's phone, the laptop's panel) reads its thread, sends, says
// Typing… and (the phone) marks its chat read with plain fetches to app/api/chat/*, never a server action: Next runs a
// page's server actions one after another, so each of these waited behind the others, and an action that revalidated
// drew the whole page again in its answer. These run side by side, and a send goes the moment it is made.

const TIMEOUT_MS = 20_000;

// `timeout` 0 is none: a send carrying a photo, video or voice message waits on its copy to the bucket (up to 128 MB a
// video), which can take longer than 20 s; cut off there, it would say Not sent while the server still posts it.
async function ask(url: string, init?: RequestInit, timeout = TIMEOUT_MS): Promise<Response> {
  await freshSignIn();
  const stop = new AbortController();
  const timer = timeout > 0 ? setTimeout(() => stop.abort(), timeout) : null;
  try {
    return await fetch(url, { credentials: "same-origin", cache: "no-store", ...init, signal: stop.signal });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * One chat's thread. `side` "coach" is the coach's (DraftMessages, the phone's and the laptop's), "app" the client
 * app's ({ rev, messages }). Null when nothing changed since `rev`, or it can't be had (no access, no signal): the
 * screen keeps what it shows, as the thread actions' null did.
 */
export async function readChatThread<T>(clientId: number, side: "coach" | "app", opts: ThreadAsk = {}): Promise<T | null> {
  const r = await fetchChatThread<T>(clientId, side, opts);
  return typeof r === "string" ? null : r.data;
}

type ThreadAsk = { rev?: string | null; from?: "phone" | "laptop" | "prefetch"; reading?: boolean };

/** readChatThread, saying which: a new copy, the same as `rev` (204), refused ("denied": signed out, or no longer this
 *  coach's client, so a copy kept of it must go), or none to be had now ("failed": no signal, a server error). */
export async function fetchChatThread<T>(clientId: number, side: "coach" | "app", opts: ThreadAsk = {}): Promise<{ data: T } | "same" | "denied" | "failed"> {
  const q = new URLSearchParams({ c: String(clientId), for: side });
  if (opts.rev) q.set("rev", opts.rev);
  if (opts.from) q.set("from", opts.from);
  if (opts.reading) q.set("reading", "1");
  try {
    const res = await ask(`/api/chat/thread?${q}`);
    if (res.status === 204) return "same";
    if (res.status === 401 || res.status === 403) return "denied";
    if (res.status !== 200) return "failed";
    const data = (await res.json()) as T | null;
    return data ? { data } : "failed";
  } catch {
    return "failed";
  }
}

/** Sends a chat message (the send action's form: clientId, text, upload, poster, link, replyTo, nonce). Throws when the
 *  server does not have it, so each caller's catch says Not sent, as a failed action call did. */
export async function postChatMessage(fd: FormData): Promise<void> {
  const res = await ask("/api/chat/send", { method: "POST", body: fd }, fd.get("upload") ? 0 : TIMEOUT_MS);
  let ok = false;
  try {
    ok = res.ok && !!((await res.json()) as { ok?: boolean } | null)?.ok;
  } catch {
    ok = false;
  }
  if (!ok) throw new Error(`Not sent (${res.status})`);
}

/** Typing… for this chat; nothing waits on it and nothing is said when it fails. */
export function signalChatTyping(clientId: number): Promise<unknown> {
  return ask(`/api/chat/typing?c=${clientId}`, { method: "POST", keepalive: true }).catch(() => null);
}

/** The coach's phone has read this chat; resolves either way. */
export function markChatSeen(clientId: number): Promise<boolean> {
  return ask(`/api/chat/seen?c=${clientId}`, { method: "POST", keepalive: true }).then(
    (r) => r.ok,
    () => false
  );
}
