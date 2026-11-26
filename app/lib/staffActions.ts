"use server";

import { revalidatePath } from "next/cache";
import { addStaffMember, removeStaffMember, setStaffPerm, setStaffRole, setStaffSettings, staffForAction } from "./staff";
import { isStaffPerm, type StaffPerm, type StaffRole } from "./staffTypes";

// The Staff screen's actions (26 Nov, Alex; app/staff/staff): owners only, each checked here, each saved at once.
// They answer `{ error }` for the screen to show, never throw.

type Result = { error?: string };
const done = (r: Result): Result => {
  if (!r.error) revalidatePath("/staff", "layout");
  return r;
};

export async function addStaffAction(email: string, role: StaffRole): Promise<Result> {
  const who = await staffForAction("owner");
  if (!who.staff) return { error: who.error };
  return done(addStaffMember(who.staff, { email: String(email ?? ""), role: role === "owner" ? "owner" : "staff" }));
}

export async function removeStaffAction(email: string): Promise<Result> {
  const who = await staffForAction("owner");
  if (!who.staff) return { error: who.error };
  return done(removeStaffMember(who.staff, String(email ?? "")));
}

export async function setStaffRoleAction(email: string, role: StaffRole): Promise<Result> {
  const who = await staffForAction("owner");
  if (!who.staff) return { error: who.error };
  if (role !== "owner" && role !== "staff") return { error: "Not allowed" };
  return done(setStaffRole(who.staff, String(email ?? ""), role));
}

export async function setStaffPermAction(email: string, perm: StaffPerm, on: boolean): Promise<Result> {
  const who = await staffForAction("owner");
  if (!who.staff) return { error: who.error };
  if (!isStaffPerm(perm)) return { error: "Not allowed" };
  return done(setStaffPerm(who.staff, String(email ?? ""), perm, on === true));
}

/** Accept new coaches by hand (Sign-ups' switch): owners only. */
export async function setApproveCoachesAction(on: boolean): Promise<Result> {
  const who = await staffForAction("owner");
  if (!who.staff) return { error: who.error };
  setStaffSettings({ approveCoaches: on === true });
  return done({});
}
