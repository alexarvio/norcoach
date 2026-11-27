"use server";

import { revalidatePath } from "next/cache";
import { coachForClient, requireCoach } from "./auth";
import { coachIdOfClient } from "./tenancy";
import { once, onceKeyOf } from "./once";
import { addCoachPlan, deleteCoachPlan, setClientPlan, setClientPlanPrice, setCoachPlanArchived, updateCoachPlan, type PlanFields } from "./coachPlans";

// The coach's plans (coachPlans.ts): made, changed, archived and deleted in Settings, Plans (28 Oct, Alex), and from a
// client's Details (23 Oct): make one from the dropdown's foot and put the client on it, or pick one, or none. The
// plans are the client's coach's own, whoever is looking.

const planOut = (p: { id: string; name: string; price?: number | null; every?: PlanFields["every"] }) => ({ id: p.id, name: p.name, price: p.price ?? null, every: p.every ?? null });

/** A new plan, and the client put on it. Gives back the plan, or null when refused. */
export async function addClientPlanAction(clientId: number, v: PlanFields, onceKey?: string) {
  if (!(await coachForClient(Number(clientId)))) return null;
  const coachId = coachIdOfClient(Number(clientId));
  if (coachId == null) return null;
  // Taken once (6 Nov, one-time key): sent again after a dropped signal, it answers the plan the first made.
  return once(`addClientPlanAction:${Number(clientId)}`, onceKeyOf(onceKey), () => {
    const plan = addCoachPlan(coachId, v);
    if (!plan) return null;
    setClientPlan(coachId, Number(clientId), plan.id);
    revalidatePath("/admin");
    return planOut(plan);
  });
}

/** Put the client on one of their coach's plans, or on none (null); a series billing a plan moves with them. */
export async function setClientPlanAction(clientId: number, planId: string | null): Promise<boolean> {
  if (!(await coachForClient(Number(clientId)))) return false;
  const coachId = coachIdOfClient(Number(clientId));
  if (coachId == null) return false;
  const ok = setClientPlan(coachId, Number(clientId), planId == null ? null : String(planId));
  revalidatePath("/admin");
  return ok;
}

/** Settings, Plans: a new plan. */
export async function addPlanAction(v: PlanFields, onceKey?: string) {
  const coach = await requireCoach();
  // Taken once (6 Nov, one-time key): sent again after a dropped signal, it answers the plan the first made.
  return once(`addPlanAction:${coach.id}`, onceKeyOf(onceKey), () => {
    const plan = addCoachPlan(coach.id, v);
    revalidatePath("/admin/redesign", "layout");
    return plan ? planOut(plan) : null;
  });
}

/** Settings, Plans: a plan's name, price and rhythm. A new price (26 Nov, Alex: docs/boards/plans-redesign-mockup.html,
    A): with `alsoMove` the clients billed on the old price move to it from their next invoice; without, they keep the
    old one as their own price. A client on their own price never moves. */
export async function updatePlanAction(id: string, v: PlanFields, alsoMove?: boolean) {
  const coach = await requireCoach();
  const plan = updateCoachPlan(coach.id, String(id), v, { alsoMove: alsoMove === true });
  revalidatePath("/admin/redesign", "layout");
  return plan ? planOut(plan) : null;
}

export async function setPlanArchivedAction(id: string, archived: boolean) {
  const coach = await requireCoach();
  const ok = setCoachPlanArchived(coach.id, String(id), !!archived);
  revalidatePath("/admin/redesign", "layout");
  return ok;
}

/** Only a plan no client is on. */
export async function deletePlanAction(id: string) {
  const coach = await requireCoach();
  const ok = deleteCoachPlan(coach.id, String(id));
  revalidatePath("/admin/redesign", "layout");
  return ok;
}

/**
 * A client's own price on their plan (26 Nov, Alex: the Invoices tab's Billing card, the price typed in place; Settings
 * › Plans, on their row): their plan series bills it from its next invoice; null, or the plan's own price, puts the
 * plan's back ("Back to €89"). Answers the day it applies from and the own price now (null: the plan's), or null when
 * refused (no such client of this coach's, no plan, a price that isn't one).
 */
export async function setClientPlanPriceAction(clientId: number, price: number | null) {
  if (!(await coachForClient(Number(clientId)))) return null;
  const coachId = coachIdOfClient(Number(clientId));
  if (coachId == null) return null;
  const n = price == null || String(price).trim() === "" ? null : Number(price);
  if (n != null && !Number.isFinite(n)) return null;
  const done = setClientPlanPrice(coachId, Number(clientId), n);
  revalidatePath("/admin");
  revalidatePath("/admin/redesign", "layout");
  return done;
}
