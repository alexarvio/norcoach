// "Upper is still going" (19 Nov, Alex: "I forget to complete the workout and it runs and I notice whenever I open the
// app again maybe hours later"): a push 60 min after the last thing done in a session begun and not ended, and a
// second at 3 h, two at most. Checked every 5 min from instrumentation.ts, the live server only, as the call
// reminders are (meetingReminders.ts). Each is remembered on the day against its start and its last activity, so a
// session that gets new sets, or is reopened, can be reminded again. The push expires in 30 min: one held while the
// phone was off never lands once the phone's outbox has caught up. The words never say a clock time (the server
// doesn't know the phone's zone) and never name the coach: it is the app speaking. A tap opens the workout.

import { getData, persistNow } from "./db";
import { endStaleSessions, liveSessionDays, liveSessionFor, sessionLastActivityMs } from "./queries";
import { fetchLiveSessionSets } from "./sets/rows";
import { stampMs } from "./targetRule";

const MIN = 60_000;
// Each 20 min wide, so a late timer can't skip one; a missed one is never sent late.
const WINDOWS = [
  { n: 1, after: 60 * MIN, width: 20 * MIN },
  { n: 2, after: 180 * MIN, width: 20 * MIN },
];

export function workoutRemindersOn(): boolean {
  // The live server only, as the call reminders: WORKOUT_REMINDERS=on forces it, =off stops it. Staging runs as
  // production on a copy of live's phones, so it is quiet unless forced (19 Nov: Railway names every environment).
  if (process.env.WORKOUT_REMINDERS === "on") return true;
  if (process.env.WORKOUT_REMINDERS === "off" || process.env.NODE_ENV !== "production") return false;
  return (process.env.RAILWAY_ENVIRONMENT_NAME ?? "production") === "production";
}

/** "45 min", "1 h", "1 h 30 min", "3 h": to the 5 minutes below. */
export function agoWords(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / MIN / 5) * 5);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export async function runWorkoutReminders(now: number = Date.now()): Promise<number> {
  // The 12 h end ran only on a request (dueJobs.ts); here it runs on the clock too, before anything is reminded.
  try {
    // Every live session's sets fetched first (quest 10, sets/rows.ts).
    await endStaleSessions(await fetchLiveSessionSets("job.staleSessions"));
  } catch (e) {
    console.error("[reminders] ending stale sessions failed:", e instanceof Error ? e.message : e);
  }
  const data = getData();
  const { sendPush } = await import("./push");
  let sent = 0;
  // Marked and saved before anything is sent, so a restart or a second server mid-deploy never sends one twice.
  const due: { userId: number; title: string; body: string; dayId: number; n: number }[] = [];
  const liveSets = await fetchLiveSessionSets("job.workoutReminders");
  for (const day of liveSessionDays()) {
    if (!day.session_started_at) continue;
    const { lastMs, lastSetMs, sets } = sessionLastActivityMs(liveSets, day);
    if (!Number.isFinite(lastMs)) continue;
    const idle = now - lastMs;
    const key = `${day.session_started_at}|${lastMs}`;
    const had = day.finish_reminders?.key === key ? day.finish_reminders.n : 0;
    const w = WINDOWS.find((x) => idle >= x.after && idle < x.after + x.width && had < x.n);
    if (!w) continue;
    day.finish_reminders = { key, n: w.n };
    const user = data.users.find((u) => u.role === "client" && u.client_id === day.client_id);
    if (!user) continue;
    const live = liveSessionFor(day.client_id);
    const name = live && live.id === day.id ? live.label : day.label || "Your session";
    const started = stampMs(day.session_started_at);
    const body = sets > 0 && Number.isFinite(lastSetMs) ? `Last set ${agoWords(now - lastSetMs)} ago. Finish it?` : `Started ${agoWords(now - started)} ago. Finish it?`;
    due.push({ userId: user.id, title: `${name} is still going`, body, dayId: day.id, n: w.n });
  }
  if (!due.length) return 0;
  await persistNow();
  for (const d of due) {
    try {
      sent += await sendPush(d.userId, {
        title: d.title,
        body: d.body,
        url: `/client?workout=${d.dayId}`,
        // The second replaces the first on the lock screen.
        tag: `workout-${d.dayId}`,
        // Always on (19 Nov, Alex: "I trust you"): no switch, no quiet hours.
        group: "always",
        ttlSeconds: 30 * 60,
      });
    } catch (e) {
      console.error(`[reminders] workout ${d.dayId} (${d.n}) failed:`, e instanceof Error ? e.message : e);
    }
  }
  return sent;
}
