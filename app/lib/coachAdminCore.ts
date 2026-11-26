import "server-only";
import { getData } from "./db";
import { deleteCoachAccount } from "./auth";
import { eraseClient } from "./erase";
import { getBilling, requireBilling } from "./billing";
import { cancelSubscription } from "./stripe";

// What the owner does to a coach account, once (26 Nov, Alex; the staff spec): the coach admin's owner Coaches screen
// (setCoachPaysAction, removeCoachAction) and the staff admin's coach page (app/staff/coachActions.ts) both call these,
// each checking who may first. Nothing here checks who is asking.

/** This coach pays Norcoach from now on, or uses it free. Free ends a live subscription on Stripe too, so nothing is
 *  charged for a plan that says Free. */
export async function setCoachPays(coachId: number, pays: boolean): Promise<{ ok: boolean; error?: string }> {
  const id = Number(coachId);
  const b = getBilling(id);
  if (!pays && b.subscription && (b.status === "trialing" || b.status === "active" || b.status === "past_due")) {
    try {
      await cancelSubscription(b.subscription);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Stripe did not answer. Try again." };
    }
  }
  requireBilling(id, !!pays);
  return { ok: true };
}

/** Whether a coach has a client of their own (their example client is none; lib/exampleClient.ts). */
export function coachHasRealClients(coachId: number): boolean {
  return getData().clients.some((c) => c.coach_id === coachId && !c.example);
}

/** Removes a coach account with no clients: their example client goes with them, never a reason to keep the account
 *  (25 Nov). False when they have a client (or there is no such coach), and nothing is removed then. */
export async function removeCoachAccount(coachId: number): Promise<boolean> {
  if (!coachHasRealClients(coachId)) {
    for (const c of getData().clients.filter((c) => c.coach_id === coachId && c.example)) await eraseClient(c.id, { selfDeleted: false });
  }
  return deleteCoachAccount(coachId);
}
