"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { getSessionUser, isOwner } from "../../../lib/auth";
import { isStaffEmail, setStaffSettings } from "../../../lib/staff";
import { acceptWaitingCoach, declineWaitingCoach } from "../../../lib/coachSignUp";
import { getData } from "../../../lib/db";

// Sign-ups on the owner's Coaches (27 Nov, Alex: "I don't want random people joining Norcoach right now"; "Yes, build
// it"), until the staff admin at admin.norcoachapp.com is online: the same switch (kv staff_settings.approveCoaches) and
// the same Accept and Decline as its Sign-ups (lib/coachSignUp.ts), for the owner of this admin alone. `{ error }`
// rather than a throw.

async function owner(): Promise<{ id: number } | null> {
  const me = await getSessionUser();
  return me && isOwner(me) ? { id: me.id } : null;
}

/** Where the "You're in" email sends them to sign in. */
async function signInUrl(): Promise<string> {
  const set = process.env.APP_URL?.trim().replace(/\/+$/, "");
  if (set) return `${set}/login`;
  const h = await headers();
  const host = (h.get("x-forwarded-host") ?? h.get("host") ?? "").split(",")[0].trim();
  const proto = h.get("x-forwarded-proto")?.split(",")[0].trim() ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host || "app.norcoachapp.com"}/login`;
}

/** Accept new coaches by hand: on, a coach who signs up waits for a yes; off, they are in at once (and anyone waiting is
 *  let in the next time they come). */
export async function setAcceptByHandAction(on: boolean): Promise<{ error?: string }> {
  if (!(await owner())) return { error: "Not allowed" };
  setStaffSettings({ approveCoaches: on === true });
  revalidatePath("/coaches");
  return {};
}

/** Lets a waiting coach in, with their "You're in" email. */
export async function acceptSignupAction(coachId: number): Promise<{ error?: string }> {
  if (!(await owner())) return { error: "Not allowed" };
  const id = Number(coachId);
  if (!Number.isInteger(id) || !(await acceptWaitingCoach(id, await signInUrl()))) return { error: "Not waiting any more" };
  revalidatePath("/coaches");
  return {};
}

/** Declines a waiting coach: their account goes, with its sign-in. Never the owner's own. */
export async function declineSignupAction(coachId: number): Promise<{ error?: string }> {
  const me = await owner();
  if (!me) return { error: "Not allowed" };
  const id = Number(coachId);
  if (!Number.isInteger(id) || id === me.id) return { error: "Your own account stays" };
  const row = getData().users.find((u) => u.id === id && u.role === "coach" && u.pending);
  if (!row) return { error: "Not waiting any more" };
  // Declining deletes the account's Clerk sign-in: never a staff member's (as the staff admin's Decline refuses).
  if (isStaffEmail(row.email)) return { error: "On Norcoach staff" };
  if (!declineWaitingCoach(id)) return { error: "Not waiting any more" };
  revalidatePath("/coaches");
  return {};
}
