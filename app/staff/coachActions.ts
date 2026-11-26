"use server";

import { revalidatePath } from "next/cache";
import { getData } from "../lib/db";
import { isOwner } from "../lib/auth";
import { isStaffEmail, staffForAction } from "../lib/staff";
import { coachHasRealClients, removeCoachAccount, setCoachPays } from "../lib/coachAdminCore";

// The staff admin's coach page (26 Nov, Alex; the staff spec, screen 2): Make them pay / Make it free and Remove, the
// same as the owner's on the coach admin's Coaches (lib/coachAdminCore.ts), each checking who is asking itself and
// answering `{ error }` rather than throwing. Never on the owner's own coach account.

type Done = { error?: string };

const coachRow = (id: number) => getData().users.find((u) => u.id === id && u.role === "coach") ?? null;

function refresh() {
  revalidatePath("/staff", "layout");
  revalidatePath("/admin/redesign/coaches");
}

/** Change a coach's billing: they pay Norcoach from now on, or use it free (ending a live subscription on Stripe). */
export async function staffSetCoachPaysAction(coachId: number, pays: boolean): Promise<Done> {
  const who = await staffForAction("billing_change");
  if (!who.staff) return { error: who.error };
  const coach = coachRow(Number(coachId));
  if (!coach) return { error: "No such coach" };
  if (isOwner(coach)) return { error: "The owner is always free" };
  const done = await setCoachPays(coach.id, !!pays);
  if (!done.ok) return { error: done.error ?? "Not saved. Try again." };
  refresh();
  return {};
}

/** Remove a coach with no clients of their own: their account, library and Support thread, their example client too. */
export async function staffRemoveCoachAction(coachId: number): Promise<Done> {
  const who = await staffForAction("remove_coach");
  if (!who.staff) return { error: who.error };
  const coach = coachRow(Number(coachId));
  if (!coach) return { error: "No such coach" };
  if (isOwner(coach)) return { error: "The owner's account stays" };
  // Removing a coach deletes their Clerk sign-in, which is a staff login too when the email is on staff: never that.
  if (coach.email.trim().toLowerCase() === who.staff.email) return { error: "Your own account stays" };
  if (isStaffEmail(coach.email)) return { error: "On Norcoach staff" };
  if (coachHasRealClients(coach.id)) return { error: "They have clients" };
  if (!(await removeCoachAccount(coach.id))) return { error: "Not removed. Try again." };
  refresh();
  return {};
}
