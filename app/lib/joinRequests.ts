import "server-only";
import { allocId, getData, persist, type JoinRequest } from "./db";
import { getCoachProfileView, getCoachSettings } from "./queries";

// A client asking to join a coach by the coach's code (18 Nov, Alex: docs/boards/client-signup-mockup.html). Each coach
// has a code, their first name by default (FINLAY), changed in Settings, Profile; a client who signs up types it, sees
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

/** The code as typed, as kept: letters and digits only, upper case, accents taken off ("Fínlay 1" is FINLAY1). */
export function normaliseCode(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, CODE_MAX);
}

const coaches = () => getData().users.filter((u) => u.role === "coach" && !u.pending);

/** The coach with this code, if any. */
function coachIdByCode(code: string): number | null {
  const want = normaliseCode(code);
  if (want.length < CODE_MIN) return null;
  return coaches().find((u) => u.coach_settings?.join_code === want)?.id ?? null;
}

const taken = (code: string, but: number) => coaches().some((u) => u.id !== but && u.coach_settings?.join_code === code);

/** The coach's code, made the first time it is asked for: their first name, else COACH, a number after it while another
 *  coach has it (FINLAY2). Kept, so renaming the coach never changes a link they have shared. */
export function ensureJoinCode(coachId: number): string {
  const user = getData().users.find((u) => u.id === coachId && u.role === "coach");
  if (!user) return "";
  const kept = user.coach_settings?.join_code;
  if (kept) return kept;
  const first = normaliseCode((getCoachProfileView(coachId)?.displayName ?? "").split(/\s+/)[0] ?? "");
  const base = first.length >= CODE_MIN ? first.slice(0, CODE_MAX - 3) : "COACH";
  let code = base;
  for (let n = 2; taken(code, coachId); n++) code = `${base}${n}`;
  user.coach_settings = { ...(user.coach_settings ?? {}), join_code: code };
  persist();
  return code;
}

/** A new code for the coach (Settings, Profile, Your code): the reason in words when it can't be. */
export function setJoinCode(coachId: number, raw: string): { ok: true; code: string } | { ok: false; error: string } {
  const user = getData().users.find((u) => u.id === coachId && u.role === "coach");
  if (!user) return { ok: false, error: "Not saved. Try again." };
  const code = normaliseCode(raw);
  if (code.length < CODE_MIN) return { ok: false, error: `At least ${CODE_MIN} letters or numbers` };
  if (taken(code, coachId)) return { ok: false, error: "Another coach has this code" };
  user.coach_settings = { ...(user.coach_settings ?? {}), join_code: code };
  persist();
  return { ok: true, code };
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
