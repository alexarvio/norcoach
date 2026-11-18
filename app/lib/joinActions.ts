"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { clerkClient } from "@clerk/nextjs/server";
import { clerkIdentity, clerkOn } from "./clerk";
import { createPasswordlessUser, findUserByEmail, getSessionUser, isOwner, requireCoach } from "./auth";
import { getData, persistNow } from "./db";
import { createClient, getCoachProfileView, patchClientProfile, removeClient } from "./queries";
import { once } from "./once";
import { pushCoachJoin } from "./coachPush";
import { coachCard, coachCardByCode, createJoinRequest, declinedBy, forgetRequestsOf, joinRequestById, latestRequestFor, pushedToday, requestsToday, setJoinCode, settleJoinRequest, tooManyTries, withdrawJoinRequest, type CoachCard } from "./joinRequests";

// The client's side of joining a coach by their code (18 Nov, Alex; lib/joinRequests.ts) and the coach's Accept and
// Decline. The client's actions are for someone signed in to Clerk with no account here yet, and answer nothing else.

async function joiner(): Promise<{ userId: string; email: string } | null> {
  if (!clerkOn() || (await getSessionUser())) return null;
  const who = await clerkIdentity();
  const email = who?.emails[0];
  return who && email ? { userId: who.userId, email } : null;
}

/** The coach behind a code, as the client sees them: picture, name, business. Nothing when it is no coach's. */
export async function lookupCoachCodeAction(code: string): Promise<{ ok: true; coach: CoachCard } | { ok: false }> {
  const me = await joiner();
  if (!me || tooManyTries(me.userId)) return { ok: false };
  const coach = coachCardByCode(String(code ?? ""));
  return coach ? { ok: true, coach } : { ok: false };
}

/** A real day, as YYYY-MM-DD, someone alive could have been born on. */
function birthdateOf(raw: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  const year = new Date().getFullYear();
  return y >= year - 110 && y <= year - 5 ? raw.trim() : null;
}

export type JoinInput = { firstName: string; lastName: string; birthdate: string; code: string };

/** Sends the request to the coach whose code it is; the coach hears of it on their phone. */
export async function sendJoinRequestAction(input: JoinInput, onceKey?: string | null): Promise<{ ok: true; coach: CoachCard } | { ok: false; error: string }> {
  const me = await joiner();
  if (!me) return { ok: false, error: "Sign in again to carry on." };
  const first = String(input.firstName ?? "").trim().slice(0, 40);
  const last = String(input.lastName ?? "").trim().slice(0, 40);
  const birthdate = birthdateOf(String(input.birthdate ?? ""));
  if (!first || !last) return { ok: false, error: "Add your first and last name." };
  if (!birthdate) return { ok: false, error: "Check your date of birth." };
  return once(`sendJoinRequest:${me.userId}`, onceKey, async () => {
    // The same answer for every code once an account is over its limits, so they can't be used to tell codes apart.
    if (tooManyTries(me.userId)) return { ok: false as const, error: "Too many tries. Try again later." };
    if (requestsToday(me.userId) >= 10) return { ok: false as const, error: "Too many requests today. Try again tomorrow." };
    const card = coachCardByCode(String(input.code ?? ""));
    if (!card) return { ok: false as const, error: "Not a valid code" };
    const coachId = getData().users.find((u) => u.role === "coach" && u.coach_settings?.join_code === card.code)?.id;
    if (coachId == null) return { ok: false as const, error: "Not a valid code" };
    // A coach who said no isn't asked again by the same account for a while (nor buzzed again).
    if (declinedBy(me.userId, coachId)) return { ok: false as const, error: "Not accepted" };
    const buzz = !pushedToday(me.userId, coachId);
    const request = createJoinRequest({ coach_id: coachId, clerk_user_id: me.userId, email: me.email, first_name: first, last_name: last, birthdate });
    await persistNow().catch(() => {});
    if (buzz) pushCoachJoin(coachId, request.id, `${first} ${last}`);
    // Where they were going is done with: a coach sign-up's leftover intent never takes them off their wait.
    (await cookies()).delete("ironline_intent");
    revalidatePath("/admin/redesign/feed");
    return { ok: true as const, coach: card };
  });
}

/** Use another code: the open request goes, back to the code. */
export async function withdrawJoinRequestAction(): Promise<void> {
  const me = await joiner();
  if (!me) return;
  withdrawJoinRequest(me.userId);
  revalidatePath("/admin/redesign/feed");
}

/** Delete account, on the join screens (App Store: an account made in the app can be deleted in it): every request this
 *  account sent, then the Clerk account itself. Nothing else of ours exists for them yet. */
export async function deleteJoinAccountAction(): Promise<{ ok: boolean }> {
  const me = await joiner();
  if (!me) return { ok: false };
  try {
    await (await clerkClient()).users.deleteUser(me.userId);
  } catch (error) {
    console.error("[join] delete account failed:", error instanceof Error ? error.message : error);
    return { ok: false };
  }
  forgetRequestsOf(me.userId);
  await persistNow().catch(() => {});
  revalidatePath("/admin/redesign/feed");
  return { ok: true };
}

export type JoinStatus = { status: "in" } | { status: "none" } | { status: "open" | "declined"; coach: CoachCard | null };

/** Where the request stands, asked by the waiting screen: in (the coach said yes, the account is made), open, declined. */
export async function joinStatusAction(): Promise<JoinStatus> {
  if (!clerkOn()) return { status: "none" };
  if (await getSessionUser()) return { status: "in" };
  const me = await joiner();
  const r = me ? latestRequestFor(me.userId) : null;
  if (!r || r.status === "withdrawn") return { status: "none" };
  if (r.status === "accepted") return { status: "in" };
  return { status: r.status, coach: coachCard(r.coach_id) };
}

// ---- The coach's side

/** Accept: the person becomes the coach's client, their name, birthdate and email filled in, signed in with the account
 *  they made (its Clerk id set now, so every route knows them at once). */
export async function acceptJoinRequestAction(id: number, onceKey?: string | null): Promise<{ ok: true; clientId: number } | { ok: false; error: string; gone?: boolean }> {
  const coach = await requireCoach();
  return once(`acceptJoinRequest:${coach.id}`, onceKey, async () => {
    const r = joinRequestById(Number(id));
    // No longer there to answer (withdrawn, answered elsewhere): the Feed lets the row go.
    if (!r || r.coach_id !== coach.id) return { ok: false as const, error: "No longer asking", gone: true };
    if (r.status === "accepted" && r.client_id != null) return { ok: true as const, clientId: r.client_id };
    if (r.status !== "open") return { ok: false as const, error: "No longer asking", gone: true };
    if (findUserByEmail(r.email)) return { ok: false as const, error: "That email already has an account." };
    const client = createClient(`${r.first_name} ${r.last_name}`, coach.id);
    try {
      const made = createPasswordlessUser(r.email, "client", client.id);
      const row = getData().users.find((u) => u.id === made.id);
      if (row) {
        row.clerk_user_id = r.clerk_user_id;
        // The instance it was made under, as clerkUserRow stamps it (lib/clerk.ts).
        (row as typeof row & { clerk_instance?: string }).clerk_instance = (process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? "").slice(-12);
      }
    } catch {
      await removeClient(client.id);
      return { ok: false as const, error: "That email already has an account." };
    }
    patchClientProfile(client.id, { birthdate: r.birthdate, email: r.email });
    settleJoinRequest(r.id, "accepted", client.id);
    await persistNow().catch(() => {});
    revalidatePath("/admin");
    return { ok: true as const, clientId: client.id };
  });
}

/** Decline: the person is told on their screen and can send their code to another coach. Nothing else is kept. */
export async function declineJoinRequestAction(id: number): Promise<{ ok: boolean; gone?: boolean; error?: string }> {
  const coach = await requireCoach();
  const r = joinRequestById(Number(id));
  if (!r || r.coach_id !== coach.id || r.status !== "open") return { ok: false, gone: true, error: "No longer asking" };
  settleJoinRequest(r.id, "declined");
  revalidatePath("/admin");
  return { ok: true };
}

/** Settings, Profile, Your code: a new code. The owner may change another coach's, named by coachId. */
export async function setJoinCodeAction(code: string, coachId?: number): Promise<{ ok: true; code: string } | { ok: false; error: string }> {
  const coach = await requireCoach();
  const target = isOwner(coach) && Number.isInteger(coachId) && coachId! > 0 && coachId !== coach.id && getCoachProfileView(coachId!) ? coachId! : coach.id;
  const result = setJoinCode(target, String(code ?? ""));
  if (result.ok) revalidatePath("/admin/redesign/settings");
  return result;
}
