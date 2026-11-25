import "server-only";
import { randomInt } from "crypto";
import { allocId, getData, persist, type JoinRequest } from "./db";
import { isNorcode, NORCODE_ALPHABET, NORCODE_LENGTH, typedNorcode } from "./norcode";
import { getClientProfile, getCoachProfileView, getCoachSettings } from "./queries";

// A client asking to join a coach by the coach's code (18 Nov, Alex: docs/boards/client-signup-mockup.html). Each coach
// has a Norcode, NC- and eight letters and digits (lib/norcode.ts), made for them and shown in Settings, Profile (the
// first day's codes were the coach's first name, FINLAY: a link shared with one still works); a client who signs up types it, sees
// the coach's picture, name and business, and sends a request; the coach accepts or declines it from the Feed's Needs
// you. Until Accept the person has a Clerk account and nothing of ours, so the request is kept by that Clerk account
// (Data.join_requests, in `kv`), never as a users row: a client row with no client loops between /client and /login.

export const CODE_MIN = 3;
export const CODE_MAX = 20;
const DAY_MS = 1000 * 60 * 60 * 24;
const OPEN_MS = DAY_MS * 60; // A request nobody answered in 60 days lapses.
const KEEP_MS = DAY_MS * 90; // One answered, withdrawn or lapsed is kept 90 days, then goes.
const DECLINED_MS = DAY_MS * 30; // A coach who said no isn't asked again by the same account for 30 days.

// Codes tried by one account (looked up, sent, or a picture asked for), so they can't be guessed through quickly: 40 in
// ten minutes. In memory, as the app runs as one server process.
const tries = new Map<string, number[]>();
export function tooManyTries(userId: string): boolean {
  const now = Date.now();
  const recent = (tries.get(userId) ?? []).filter((t) => now - t < 10 * 60_000);
  recent.push(now);
  tries.set(userId, recent);
  return recent.length > 40;
}

/** A code as typed or carried by a link: letters and digits only, upper case, accents taken off. The NC in front of a
 *  Norcode is left to the lookup, which tries the code with and without it. */
export function normaliseCode(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, CODE_MAX);
}

const coaches = () => getData().users.filter((u) => u.role === "coach" && !u.pending);

/** The code a link carried, as the field shows it: a Norcode as it is; an older name code as the Norcode of the coach it
 *  was (looked up within the same limit as every other try), else what was given. */
export function codeFromLink(raw: string, userId: string): string {
  const given = normaliseCode(raw);
  const shaped = typedNorcode(given);
  if (!given || isNorcode(shaped)) return shaped;
  return (tooManyTries(userId) ? null : coachCardByCode(given)?.code) ?? shaped;
}

/** The coach with this code, if any: their Norcode, typed with or without its NC, or the name code they had before it. */
function coachIdByCode(code: string): number | null {
  const want = normaliseCode(code);
  if (want.length < CODE_MIN) return null;
  ensureJoinCodes();
  const tries = want.startsWith("NC") && want.length === NORCODE_LENGTH + 2 ? [want, want.slice(2)] : [want];
  for (const t of tries) {
    const hit = coaches().find((u) => u.coach_settings?.join_code === t || u.coach_settings?.join_code_old === t);
    if (hit) return hit.id;
  }
  return null;
}

const taken = (code: string, but: number) => coaches().some((u) => u.id !== but && (u.coach_settings?.join_code === code || u.coach_settings?.join_code_old === code));

/** Eight characters no other coach has, never starting with NC (so an NC typed in front of it is always the prefix). */
function newNorcode(coachId: number): string {
  for (;;) {
    let code = "";
    for (let i = 0; i < NORCODE_LENGTH; i++) code += NORCODE_ALPHABET[randomInt(NORCODE_ALPHABET.length)];
    if (!code.startsWith("NC") && !taken(code, coachId)) return code;
  }
}

/** Every coach has a Norcode: made here for any who has none yet (or still has the first day's name code, kept as the
 *  one a shared link may carry). Returns whether anything was made. */
function ensureJoinCodes(): void {
  let made = false;
  for (const u of coaches()) {
    const kept = u.coach_settings?.join_code;
    if (kept && u.coach_settings?.join_code_made && isNorcode(kept)) continue;
    u.coach_settings = { ...(u.coach_settings ?? {}), join_code: newNorcode(u.id), join_code_made: true, ...(kept && !u.coach_settings?.join_code_old ? { join_code_old: kept } : {}) };
    made = true;
  }
  if (made) persist();
}

/** The coach's Norcode (its eight characters), made the first time it is asked for and kept for good. */
export function ensureJoinCode(coachId: number): string {
  const user = getData().users.find((u) => u.id === coachId && u.role === "coach");
  if (!user) return "";
  const kept = user.coach_settings?.join_code;
  if (kept && user.coach_settings?.join_code_made && isNorcode(kept)) return kept;
  const code = newNorcode(coachId);
  user.coach_settings = { ...(user.coach_settings ?? {}), join_code: code, join_code_made: true, ...(kept && !user.coach_settings?.join_code_old ? { join_code_old: kept } : {}) };
  persist();
  return code;
}

/** What a client sees of a coach once their code is typed: the name, the business, and whether there is a picture
 *  (served by /auth/join/photo, which reads it by the code). */
export type CoachCard = { code: string; name: string; first: string; business: string; photo: string | null };

export function coachCard(coachId: number): CoachCard | null {
  const view = getCoachProfileView(coachId);
  const code = getData().users.find((u) => u.id === coachId)?.coach_settings?.join_code;
  if (!view || !code) return null;
  const name = view.displayName.trim();
  const v = view.avatarPath ? (view.avatarPath.split("v=")[1] ?? "") : "";
  return {
    code,
    name,
    first: name.split(/\s+/)[0] || name,
    business: getCoachSettings(coachId).business?.business_name?.trim() ?? "",
    photo: view.avatarPath ? `/auth/join/photo?code=${encodeURIComponent(code)}${v ? `&v=${encodeURIComponent(v)}` : ""}` : null,
  };
}

export function coachCardByCode(code: string): CoachCard | null {
  const id = coachIdByCode(code);
  return id == null ? null : coachCard(id);
}

/** The coach's picture path by their code, for the photo route. */
export function coachPhotoByCode(code: string): string | null {
  const id = coachIdByCode(code);
  return id == null ? null : (getCoachProfileView(id)?.avatarPath ?? null);
}

// The requests, pruned as they are read (at most hourly): nothing kept past its time, nor for a coach who is gone.
let pruned = 0;
const list = () => {
  const data = getData();
  data.join_requests ??= [];
  if (Date.now() - pruned > 60 * 60_000) {
    pruned = Date.now();
    const coachIds = new Set(data.users.filter((u) => u.role === "coach").map((u) => u.id));
    const keep = data.join_requests.filter((r) => coachIds.has(r.coach_id) && Date.now() - Date.parse(r.settled_at ?? r.created_at) < (r.status === "open" ? OPEN_MS + KEEP_MS : KEEP_MS));
    if (keep.length !== data.join_requests.length) {
      data.join_requests = keep;
      persist();
    }
  }
  return data.join_requests;
};

const lapsed = (r: JoinRequest) => r.status === "open" && Date.now() - Date.parse(r.created_at) > OPEN_MS;

/** This Clerk account's latest request, whatever became of it. */
export function latestRequestFor(clerkUserId: string): JoinRequest | null {
  const mine = list().filter((r) => r.clerk_user_id === clerkUserId);
  const last = mine[mine.length - 1] ?? null;
  return last && lapsed(last) ? null : last;
}

/** Requests this Clerk account sent today, to keep a coach's Needs you from being flooded. */
export function requestsToday(clerkUserId: string): number {
  const since = Date.now() - 1000 * 60 * 60 * 24;
  return list().filter((r) => r.clerk_user_id === clerkUserId && Date.parse(r.created_at) > since).length;
}

/** The coach said no to this account lately: they aren't asked again for a while. */
export function declinedBy(clerkUserId: string, coachId: number): boolean {
  return list().some((r) => r.clerk_user_id === clerkUserId && r.coach_id === coachId && r.status === "declined" && Date.now() - Date.parse(r.settled_at ?? r.created_at) < DECLINED_MS);
}

/** The coach already heard from this account today: a new request is listed, but no second buzz. */
export function pushedToday(clerkUserId: string, coachId: number): boolean {
  return list().some((r) => r.clerk_user_id === clerkUserId && r.coach_id === coachId && Date.now() - Date.parse(r.created_at) < DAY_MS);
}

/** Every request this account sent goes (its account deleted on the join screens). */
export function forgetRequestsOf(clerkUserId: string) {
  const data = getData();
  const before = (data.join_requests ?? []).length;
  data.join_requests = (data.join_requests ?? []).filter((r) => r.clerk_user_id !== clerkUserId);
  if (data.join_requests.length !== before) persist();
}

/** A new request; an open one from the same account is withdrawn first (one at a time). */
export function createJoinRequest(input: Omit<JoinRequest, "id" | "status" | "created_at">): JoinRequest {
  const now = new Date().toISOString();
  for (const r of list()) if (r.clerk_user_id === input.clerk_user_id && r.status === "open") Object.assign(r, { status: "withdrawn", settled_at: now });
  const row: JoinRequest = { ...input, id: allocId("join_requests"), status: "open", created_at: now };
  list().push(row);
  persist();
  return row;
}

export function withdrawJoinRequest(clerkUserId: string) {
  const now = new Date().toISOString();
  let changed = false;
  for (const r of list())
    if (r.clerk_user_id === clerkUserId && r.status === "open") {
      Object.assign(r, { status: "withdrawn", settled_at: now });
      changed = true;
    }
  if (changed) persist();
}

/** The coach's open requests, oldest first. */
export function openJoinRequestsFor(coachId: number): JoinRequest[] {
  return list().filter((r) => r.coach_id === coachId && r.status === "open" && !lapsed(r));
}

export function joinRequestById(id: number): JoinRequest | null {
  return list().find((r) => r.id === id) ?? null;
}

export function settleJoinRequest(id: number, status: "accepted" | "declined", clientId?: number) {
  const r = joinRequestById(id);
  if (!r) return;
  Object.assign(r, { status, settled_at: new Date().toISOString(), ...(clientId != null ? { client_id: clientId } : {}) });
  persist();
}

/** Whole years since the birthdate, for the coach's row. */
export function ageOf(birthdate: string, now = new Date()): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthdate);
  if (!m) return null;
  let age = now.getFullYear() - Number(m[1]);
  if (now.getMonth() + 1 < Number(m[2]) || (now.getMonth() + 1 === Number(m[2]) && now.getDate() < Number(m[3]))) age--;
  return age;
}

/** The coach's clients a join request can be put onto (25 Nov, Alex: Accept's Existing client): theirs, never in the
 *  app: no client login at all (made with a first name alone), or an invite nobody has taken up (made with no password,
 *  never claimed by any Clerk account). Never a login with a password or a claim, nor a client who has used the app:
 *  those are real people, however long since they signed in. With the email it carries (the login's, else the card's),
 *  so Accept can pick the one the request matches. A to Z. */
export function linkableClients(coachId: number): { id: number; name: string; avatarPath: string | null; email: string | null }[] {
  const data = getData();
  return data.clients
    // A phase the coach made live, or their Open {First}'s app, opens it before they join; only `before` (opened by the
    // lock's first sweep, or by their own logging) is someone who has been in.
    // Never the example client (25 Nov, Alex; lib/exampleClient.ts): no person can become him.
    .filter((c) => c.coach_id === coachId && !c.example && !c.last_active_at && c.app_opened_by !== "before")
    .flatMap((c) => {
      const login = data.users.find((u) => u.role === "client" && u.client_id === c.id);
      if (login && (login.clerk_user_id || login.password_hash)) return [];
      const email = (login?.email || getClientProfile(c.id).email || "").trim().toLowerCase() || null;
      return [{ id: c.id, name: c.name.trim(), avatarPath: c.avatar_path ?? null, email }];
    })
    .sort((x, y) => x.name.localeCompare(y.name));
}
