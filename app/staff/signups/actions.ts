"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { getData } from "../../lib/db";
import { isStaffEmail, staffForAction } from "../../lib/staff";
import { acceptWaitingCoach, declineWaitingCoach } from "../../lib/coachSignUp";

// The staff admin's Sign-ups (26 Nov, Alex; the staff spec, screen 5): Accept and Decline on a coach waiting for a yes,
// the same as the coach admin's approveCoachAction and declineCoachAction (lib/coachSignUp.ts). Staff who may let new
// coaches in only; `{ error }` rather than a throw. The switch itself (Accept new coaches by hand) is an owner's,
// setApproveCoachesAction in lib/staffActions.ts.

/** Where the "You're in" email sends them to sign in: the app, never the staff admin's own host. */
async function signInUrl(): Promise<string> {
  const set = process.env.APP_URL?.trim().replace(/\/+$/, "");
  if (set) return `${set}/login`;
  const h = await headers();
  const host = (h.get("x-forwarded-host") ?? h.get("host") ?? "").split(",")[0].trim();
  const proto = h.get("x-forwarded-proto")?.split(",")[0].trim() ?? (/^admin\.localhost(:|$)/.test(host) ? "http" : "https");
  // admin.localhost:3000 → localhost:3000; admin.norcoachapp.com → app.norcoachapp.com.
  const app = /^admin\.localhost(:|$)/.test(host) ? host.replace(/^admin\./, "") : host.replace(/^admin\./, "app.");
  return `${proto}://${app || "app.norcoachapp.com"}/login`;
}

/** Lets a waiting coach in, with their "You're in" email. */
export async function acceptCoachSignupAction(coachId: number): Promise<{ error?: string }> {
  const who = await staffForAction("signups");
  if (!who.staff) return { error: who.error };
  const id = Number(coachId);
  if (!Number.isInteger(id) || !(await acceptWaitingCoach(id, await signInUrl()))) return { error: "Not waiting any more" };
  revalidatePath("/staff", "layout");
  return {};
}

/** Declines a waiting coach: their account goes, with its sign-in. */
export async function declineCoachSignupAction(coachId: number): Promise<{ error?: string }> {
  const who = await staffForAction("signups");
  if (!who.staff) return { error: who.error };
  const id = Number(coachId);
  // Declining deletes the account's Clerk sign-in, a staff login too when the email is on staff: never that.
  const email = getData().users.find((u) => u.id === id)?.email ?? null;
  if (email && email.trim().toLowerCase() === who.staff.email) return { error: "Your own account stays" };
  if (isStaffEmail(email)) return { error: "On Norcoach staff" };
  if (!Number.isInteger(id) || !declineWaitingCoach(id)) return { error: "Not waiting any more" };
  revalidatePath("/staff", "layout");
  return {};
}
