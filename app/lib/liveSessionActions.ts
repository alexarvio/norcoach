"use server";

import { canAccessClient } from "./auth";
import { getData } from "./db";
import { liveNowFor } from "./liveSessionNow";
import type { LiveNow } from "./liveActivity";

/** What is going now, read again as the app opens and comes back to the front (19 Nov, Alex: the lock-screen pill), so a
    session ended on another device, by the 12 h end or by the coach takes the pill down. Null when it can't be read. */
export async function liveSessionNowAction(clientId: number): Promise<LiveNow | null> {
  const id = Number(clientId);
  if (!Number.isInteger(id) || !(await canAccessClient(id))) return null;
  return liveNowFor(id);
}

/** The lock-screen pill tapped while the app is already open (21 Nov, Alex: "pressing on the pill… makes the whole app
    refresh"): its session's week and whether it still runs, so the app opens the workout in place, as the page's
    ?workout= arrival does, instead of loading again. Null for another client's or a day that is gone. */
export async function workoutArrivalAction(clientId: number, dayId: number): Promise<{ week: number; live: boolean } | null> {
  const id = Number(clientId);
  const day = Number(dayId);
  if (!Number.isInteger(id) || !Number.isInteger(day) || !(await canAccessClient(id))) return null;
  const found = getData().program_days.find((pd) => pd.id === day && pd.client_id === id);
  if (!found) return null;
  return { week: found.week_number, live: !!found.session_started_at && !found.session_ended_at };
}
