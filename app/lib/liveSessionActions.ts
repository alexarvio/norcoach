"use server";

import { canAccessClient } from "./auth";
import { liveNowFor } from "./liveSessionNow";
import type { LiveNow } from "./liveActivity";

/** What is going now, read again as the app opens and comes back to the front (19 Nov, Alex: the lock-screen pill), so a
    session ended on another device, by the 12 h end or by the coach takes the pill down. Null when it can't be read. */
export async function liveSessionNowAction(clientId: number): Promise<LiveNow | null> {
  const id = Number(clientId);
  if (!Number.isInteger(id) || !(await canAccessClient(id))) return null;
  return liveNowFor(id);
}
