"use server";

import { revalidatePath } from "next/cache";
import { appLockFor, appLocked, fetchAppLockCheckIns, fetchAppLockFood, fetchAppLockSets, openClientApp, type AppLock } from "./appLock";
import { coachForClient, getSessionUser } from "./auth";

// The locked app's two actions (19 Nov, Alex: B of docs/boards/locked-app-mockup.html; app/lib/appLock.ts).

/** The client's own re-check, on coming back to the front and every ~20 s while locked: `{ open: true }` once open, the
 *  lock while locked, null when there is no client session to read (an expired session, a coach's preview), which the
 *  app takes as nothing new, never as open. */
export async function appLockNowAction(): Promise<{ open: true } | { open: false; lock: AppLock } | null> {
  const user = await getSessionUser();
  if (!user || user.role !== "client" || user.client_id == null) return null;
  const lock = appLockFor(user.client_id, await fetchAppLockFood([user.client_id], "action.appLock"), await fetchAppLockCheckIns([user.client_id], "action.appLock"), await fetchAppLockSets([user.client_id], "action.appLock"));
  return lock ? { open: false, lock } : { open: true };
}

/** The coach's Open {First}'s app, from the client's Home ⋯: opens it at once, the client pushed. */
export async function openClientAppAction(clientId: number): Promise<boolean> {
  const id = Number(clientId);
  if (!Number.isInteger(id) || !(await coachForClient(id))) return false;
  // Already open (a phase went live meanwhile) answers true too: there is nothing left to open.
  const opened = (await openClientApp(id, "coach")) || !appLocked(id, await fetchAppLockFood([id], "action.appLock"), await fetchAppLockCheckIns([id], "action.appLock"), await fetchAppLockSets([id], "action.openApp"));
  revalidatePath("/admin");
  revalidatePath("/client");
  return opened;
}
