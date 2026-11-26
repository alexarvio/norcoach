// A coach who signs up is in at once (17 Nov, Alex: "I don't see why I have to accept them… create an account, get an
// email confirmation, and start using the account immediately"). The owner's approval step is gone: the account is made
// as approveCoach always left it, with their own copy of the presets, the welcome steps on their first screen and, while
// coaches pay Norcoach (billing.ts), the subscribe screen before them, and the name and business they gave on their
// profile. One that signed up while approval was still asked (`pending`) is let in the same way the next time they come.
//
// Approval comes back as a switch (26 Nov, Alex: the staff admin's Sign-ups; kv `staff_settings.approveCoaches`, on
// unless switched off): while it is on, a new coach account stays `pending` after About you and waits on /auth/waiting
// until someone on staff accepts it (acceptWaitingCoach, as approveCoachAction did) or declines it (declineWaitingCoach).
// Never the owner (OWNER_EMAIL) or the App Store review account; coaches already in are never made to wait. Switched
// off, it is as above: anyone still waiting is let in the next time they come.

import { approveCoach, deleteCoachAccount, ownerEmail } from "./auth";
import { getData } from "./db";
import { applySignUpDetails } from "./queries";
import { isReviewEmail } from "./reviewAccount";
import { sendCoachApprovedEmail } from "./mail";
import { staffSettings } from "./staff";

/** Lets a signed-up coach in. False when there was nobody waiting under that id. */
export function letCoachIn(coachId: number): boolean {
  const pending = getData().users.find((u) => u.id === coachId && u.role === "coach")?.pending;
  if (!pending || !approveCoach(coachId)) return false;
  applySignUpDetails(coachId, pending.name, pending.business);
  return true;
}

/** Whether a new coach account under this email waits for a yes: the switch on, and never the owner or the review account. */
export function coachNeedsApproval(email: string | null | undefined): boolean {
  const e = String(email ?? "").trim().toLowerCase();
  if (!e || e === ownerEmail() || isReviewEmail(e)) return false;
  return staffSettings().approveCoaches;
}

/** A coach still waiting for a yes (`pending`), while approval is asked for their email. */
export function isWaitingCoach(coachId: number): boolean {
  const u = getData().users.find((x) => x.id === coachId && x.role === "coach");
  return !!u?.pending && coachNeedsApproval(u.email);
}

/** Where a signed-up coach goes from here: let in at once ("in"), or left waiting for a yes ("waiting"); "none" when
 *  nobody is waiting under that id. Every sign-up path asks this instead of letCoachIn. */
export function letCoachInOrWait(coachId: number): "in" | "waiting" | "none" {
  const u = getData().users.find((x) => x.id === coachId && x.role === "coach");
  if (!u?.pending) return "none";
  if (coachNeedsApproval(u.email)) return "waiting";
  return letCoachIn(coachId) ? "in" : "none";
}

/** Someone lets a waiting coach in (the staff admin's Accept; the coach admin's approveCoachAction): their presets, the
 *  name and business they gave, and the "you're in" email with where to sign in. False when nobody waits under that id. */
export async function acceptWaitingCoach(coachId: number, signInUrl: string): Promise<boolean> {
  const user = getData().users.find((u) => u.id === coachId && u.role === "coach");
  const pending = user?.pending;
  if (!user || !pending || !approveCoach(coachId)) return false;
  applySignUpDetails(coachId, pending.name, pending.business);
  // They were told they would hear: "You're in", when email is set up (never refused: they are in either way).
  await sendCoachApprovedEmail({ to: user.email, name: pending.name, signInUrl }).catch(() => false);
  return true;
}

/** Someone declines a waiting coach: the account goes, with its Clerk sign-in (deleteCoachAccount). False when nobody
 *  waits under that id. */
export function declineWaitingCoach(coachId: number): boolean {
  const row = getData().users.find((u) => u.id === coachId && u.role === "coach" && u.pending);
  return !!row && deleteCoachAccount(coachId);
}
