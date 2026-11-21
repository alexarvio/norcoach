import "server-only";
import { getData, persist } from "./db";
import { getClientPreferences } from "./queries";
import { NOTIF_GROUP_IDS, isNotifGroup, type NotifGroup } from "./notifGroups";

// The client's Settings · Notifications (19 Nov, Alex): a push switch a group and quiet hours, kept on their
// client_preferences row (push_groups, quiet). A switch turns off the push alone: the bell keeps every notification.
// A group missing is on. Messages from {Coach} is the old coach_notes switch too, kept in step both ways.

export type QuietHours = { on: boolean; from: string; to: string; tz: string };
export type NotifPrefs = { push_groups: Record<NotifGroup, boolean>; quiet: QuietHours | null };

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

function validZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Every group's switch (missing = on) and the quiet hours, as Settings shows them. */
export function readNotifPrefs(clientId: number): NotifPrefs {
  const p = getClientPreferences(clientId);
  const push_groups = Object.fromEntries(NOTIF_GROUP_IDS.map((g) => [g, groupOn(p, g)])) as Record<NotifGroup, boolean>;
  return { push_groups, quiet: p.quiet ?? null };
}

function groupOn(p: ReturnType<typeof getClientPreferences>, group: NotifGroup): boolean {
  const set = p.push_groups?.[group];
  if (set === false) return false;
  // Messages from {Coach} was a switch of its own before (coach_notes): off there, off here until switched again.
  if (set === undefined && group === "messages" && p.coach_notes === false) return false;
  return true;
}

/** Whether this client's pushes of this group go to the phone. */
export function pushGroupOn(clientId: number, group: NotifGroup): boolean {
  return groupOn(getClientPreferences(clientId), group);
}

/** The minutes past midnight a clock "HH:MM" reads. */
const minutesOf = (clock: string) => {
  const m = CLOCK.exec(clock);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};

/** Whether `now` is inside these quiet hours, in their own zone. From and To the same: no quiet hours at all. */
export function inQuiet(quiet: QuietHours | null | undefined, now: number = Date.now()): boolean {
  if (!quiet?.on) return false;
  const from = minutesOf(quiet.from);
  const to = minutesOf(quiet.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return false;
  let local: number;
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: quiet.tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(now));
    local = Number(parts.find((x) => x.type === "hour")?.value) * 60 + Number(parts.find((x) => x.type === "minute")?.value);
  } catch {
    return false;
  }
  if (!Number.isFinite(local)) return false;
  // 22:00 – 07:00 runs over midnight.
  return from < to ? local >= from && local < to : local >= from || local < to;
}

/** Whether this client is in their quiet hours now. */
export function clientInQuiet(clientId: number, now: number = Date.now()): boolean {
  return inQuiet(getClientPreferences(clientId).quiet, now);
}

/**
 * Saves what Settings changed: any group switches given (others kept) and the quiet hours whole, when given and
 * valid (two clocks "HH:MM" and the phone's IANA zone). Returns the prefs as now saved.
 */
export function saveNotifPrefs(clientId: number, patch: { push_groups?: Partial<Record<NotifGroup, boolean>>; quiet?: QuietHours | null }): NotifPrefs {
  const data = getData();
  let row = data.client_preferences.find((p) => p.client_id === clientId);
  if (!row) {
    row = { ...getClientPreferences(clientId) };
    data.client_preferences.push(row);
  }
  let changed = false;
  if (patch.push_groups && typeof patch.push_groups === "object") {
    const next = { ...(row.push_groups ?? {}) };
    for (const [g, v] of Object.entries(patch.push_groups)) {
      if (!isNotifGroup(g) || typeof v !== "boolean") continue;
      next[g] = v;
      // The old switch kept in step, so the coach message's own check (queries.ts sendChatMessage) agrees.
      if (g === "messages") row.coach_notes = v;
      changed = true;
    }
    row.push_groups = next;
  }
  if (patch.quiet === null) {
    if (row.quiet) {
      delete row.quiet;
      changed = true;
    }
  } else if (patch.quiet && typeof patch.quiet === "object") {
    const q = patch.quiet;
    const tz = typeof q.tz === "string" ? q.tz.trim() : "";
    if (typeof q.on === "boolean" && CLOCK.test(String(q.from)) && CLOCK.test(String(q.to)) && tz && validZone(tz)) {
      row.quiet = { on: q.on, from: q.from, to: q.to, tz };
      changed = true;
    }
  }
  if (changed) persist();
  return readNotifPrefs(clientId);
}
