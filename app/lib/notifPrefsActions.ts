"use server";

import { revalidatePath } from "next/cache";
import { getSessionUser } from "./auth";
import { saveNotifPrefs, type NotifPrefs, type QuietHours } from "./notifPrefs";
import type { NotifGroup } from "./notifGroups";

/**
 * Settings · Notifications (19 Nov, Alex): saves the group switches and quiet hours for the signed-in client alone,
 * never a coach looking at their app (the phone preview). Returns the prefs as saved, or null when nothing could be.
 */
export async function saveNotificationPrefsAction(patch: { push_groups?: Partial<Record<NotifGroup, boolean>>; quiet?: QuietHours | null }): Promise<NotifPrefs | null> {
  const user = await getSessionUser();
  if (!user || user.role !== "client" || user.client_id == null || user.must_change_password) return null;
  const saved = saveNotifPrefs(user.client_id, patch ?? {});
  revalidatePath("/client");
  return saved;
}
