// The example client a new coach finds already there (25 Nov, Alex: docs/boards/coach-onboarding-mockup.html): Sam
// Carter, every tab filled in (lib/demoClient.ts builds him), so every screen has something to show from the first
// visit. Made once a coach, the first time they save Your business, in the background; the coaches from before never
// get one, since they never pass that step again. Deleting him never brings him back (example_made_at stays).
//
// He is no person: never counted on Business, never offered when a join request is placed, never owing anything (the
// Feed's Needs you, the Phases screen's, the To do, the dots and the rail's numbers), never a clash on the Calendar, and
// never reminded, pushed, emailed or billed. Each of those reads Client.example, never his name.
//
// Only db here, so any reader can ask isExampleClient without pulling the builder (and queries.ts) in with it.

import { getData, persist } from "./db";

export const EXAMPLE_NAME = "Sam Carter";

/** Whether this client is a coach's example client (Client.example), not a real person. */
export function isExampleClient(clientId: number | null | undefined): boolean {
  if (clientId == null) return false;
  return !!getData().clients.find((c) => c.id === clientId)?.example;
}

/** The ids of every example client, for a reader walking many rows at once. */
export function exampleClientIds(): Set<number> {
  return new Set(getData().clients.filter((c) => c.example).map((c) => c.id));
}

/** The coach's example client, if they have one now. */
export function exampleClientOf(coachId: number): number | null {
  return getData().clients.find((c) => c.coach_id === coachId && c.example)?.id ?? null;
}

/**
 * Builds the coach's example client once: marked first (example_made_at, saved), then built, so two saves of Your
 * business at once, or a build that fails half way, never make a second. Never throws: a failure is logged and the
 * coach simply has no example.
 */
export async function makeExampleClientOnce(coachId: number): Promise<void> {
  const user = getData().users.find((u) => u.id === coachId && u.role === "coach");
  if (!user || user.coach_settings?.example_made_at) return;
  user.coach_settings = { ...(user.coach_settings ?? {}), example_made_at: new Date().toISOString() };
  persist();
  await build(coachId);
}

/** A build started and never finished (the app restarted half way: every deploy does): built again, from nothing (the
 *  builder removes the half-built one by its flag). Asked by the admin's layout after it has answered; the build is given
 *  five minutes to finish before it counts as cut short. */
export async function resumeExampleClient(coachId: number): Promise<void> {
  const s = getData().users.find((u) => u.id === coachId && u.role === "coach")?.coach_settings;
  if (!s?.example_made_at || s.example_ready_at) return;
  if (Date.now() - Date.parse(s.example_made_at) < 5 * 60_000) return;
  await build(coachId);
}

const building = new Set<number>();

async function build(coachId: number): Promise<void> {
  if (building.has(coachId)) return;
  building.add(coachId);
  try {
    // The builder (and queries.ts behind it) loaded only here, so this file stays a light read for everyone else.
    const { buildDemoClient } = await import("./demoClient");
    await buildDemoClient(coachId, EXAMPLE_NAME, { example: true });
    const user = getData().users.find((u) => u.id === coachId && u.role === "coach");
    if (user) {
      user.coach_settings = { ...(user.coach_settings ?? {}), example_ready_at: new Date().toISOString() };
      persist();
    }
  } catch (error) {
    console.error(`[example client] coach ${coachId}:`, error instanceof Error ? error.message : error);
  } finally {
    building.delete(coachId);
  }
}
