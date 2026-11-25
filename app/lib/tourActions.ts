"use server";

import { revalidatePath } from "next/cache";
import { coachForClient, requireCoachAccount } from "./auth";
import { getData, persist } from "./db";
import { eraseClient } from "./erase";

// The coach's onboarding (25 Nov, Alex: docs/boards/coach-onboarding-mockup.html): the welcome to the tour, seen once, and
// the example client deleted from their Home's ⋯ (OnboardingTour.tsx, home/HomeDraft.tsx).

/** The welcome seen, started or not (Not now, Start tour, ✕ or Esc): it never opens by itself again. Open in read-only
 *  too, as a read mark is (requireCoachAccount): a coach whose payment failed is never sent to Billing for closing it. */
export async function markTourSeenAction(): Promise<void> {
  const coach = await requireCoachAccount();
  const user = getData().users.find((u) => u.id === coach.id && u.role === "coach");
  if (!user || user.coach_settings?.tour_seen_at) return;
  user.coach_settings = { ...(user.coach_settings ?? {}), tour_seen_at: new Date().toISOString() };
  persist();
}

/** Delete the example client (no name to type): only one that is this coach's and an example. Erased as any client is
 *  (eraseClient: rows, uploads, subscriptions), which writes no departure for an example, so Business never counts him as
 *  a client who left. Null when done, else what stopped it. */
export async function deleteExampleClientAction(clientId: number): Promise<string | null> {
  const coach = await coachForClient(clientId);
  if (!coach) return "That client is not yours.";
  const client = getData().clients.find((c) => c.id === clientId);
  if (!client) return "That client no longer exists.";
  if (!client.example) return "That client is not the example.";
  await eraseClient(clientId, { selfDeleted: false });
  revalidatePath("/admin");
  revalidatePath("/client");
  return null;
}
