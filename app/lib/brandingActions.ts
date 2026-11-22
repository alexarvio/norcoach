"use server";

import { revalidatePath } from "next/cache";
import { requireCoach } from "./auth";
import { setCoachCardsDefault } from "./coachCards";

/** Card pictures, Default or their own (22 Nov, Alex: "a toggle for card pics if we want default or not"; Settings,
 *  Branding): saved at once, nothing deleted either way. */
export async function setCardsDefaultAction(on: boolean): Promise<{ ok: true }> {
  const coach = await requireCoach();
  setCoachCardsDefault(coach.id, !!on);
  revalidatePath("/", "layout");
  return { ok: true };
}
