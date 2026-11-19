import { getData, persist, persistNow } from "./db";
import { getCoachAvatarPath, getCoachDisplayName, getCoachSettings, localDateStr } from "./queries";
import { isReviewEmail } from "./reviewAccount";

// The locked app (19 Nov, Alex: B of docs/boards/locked-app-mockup.html, "first phase"): a client the coach has just let
// in (their Norcode, their link, or the coach's own invite) sees Home locked under the coach's sheet until their app
// opens. It opens the first time a phase of theirs is live (any track, not a draft, its first day come), or when the coach
// opens it early from the client's Home ⋯; once open it stays open for good (Client.app_opened_at), so taking phases off
// later never locks it again. Everyone from before counts as opened: a client with any phase out, or anything logged.
// The App Review account is never locked.

export type AppLock = { coachFirst: string; coachName: string; business: string; avatarPath: string | null };

/** The pushes and the timer (as the workout reminders): the live server only; APP_LOCK_PUSH=on forces it, =off stops it.
 *  Staging runs as production on a copy of live's phones, so it stays quiet unless forced. */
export function appLockPushOn(): boolean {
  if (process.env.APP_LOCK_PUSH === "on") return true;
  if (process.env.APP_LOCK_PUSH === "off" || process.env.NODE_ENV !== "production") return false;
  return (process.env.RAILWAY_ENVIRONMENT_NAME ?? "production") === "production";
}

type ClientRow = ReturnType<typeof getData>["clients"][number];

/** A phase of theirs is out and has begun: not a draft, its first day today or before (a past one too). A training
 *  phase is its programme: begun only once that has gone out (deployed, or its scheduled moment come), never by its
 *  week alone, which a programme scheduled later in the week already reads as; and a programme out whose Plan phase
 *  was deleted counts too (19 Nov, review). */
function hadPhaseLive(clientId: number, today = localDateStr()): boolean {
  const data = getData();
  const now = new Date().toISOString();
  const programOut = (p: (typeof data.training_programs)[number] | undefined) =>
    !!p && (p.status === "deployed" || (!!p.scheduled_at && p.scheduled_at <= now));
  if (data.training_programs.some((p) => p.client_id === clientId && programOut(p))) return true;
  return data.client_phases.some((p) => {
    if (p.client_id !== clientId || p.draft || p.start_week > today) return false;
    if (p.program_id == null) return true;
    return programOut(data.training_programs.find((x) => x.id === p.program_id));
  });
}

/** Anything the client logged themselves: a set, a session begun, a cardio, a check-in, food, a photo. The phone's own
 *  figures (Apple Health, Health Connect) don't count: Settings works while locked, and connecting must not open it. */
function loggedAnything(clientId: number): boolean {
  const data = getData();
  if ((data.food_entries ?? []).some((e) => e.client_id === clientId)) return true;
  if ((data.calorie_logs ?? []).some((l) => l.client_id === clientId && l.source !== "health")) return true;
  if ((data.cardio_logs ?? []).some((l) => l.client_id === clientId)) return true;
  if ((data.measurement_values ?? []).some((v) => v.client_id === clientId && !!v.logged_at)) return true;
  const slotIds = new Set((data.photo_slots ?? []).filter((s) => s.client_id === clientId).map((s) => s.id));
  if (slotIds.size && (data.photo_uploads ?? []).some((u) => slotIds.has(u.slot_id))) return true;
  const days = data.program_days.filter((d) => d.client_id === clientId);
  if (days.some((d) => !!d.session_started_at)) return true;
  const metricIds = new Set(data.metric_definitions.filter((m) => m.client_id === clientId).map((m) => m.id));
  if (metricIds.size && data.metric_entries.some((e) => metricIds.has(e.metric_definition_id) && e.source !== "health" && e.value != null)) return true;
  if (!days.length) return false;
  const dayIds = new Set(days.map((d) => d.id));
  const rowIds = new Set(data.workout_assignments.filter((a) => dayIds.has(a.program_day_id)).map((a) => a.id));
  return rowIds.size > 0 && data.set_logs.some((s) => rowIds.has(s.workout_assignment_id));
}

function isReviewClient(clientId: number): boolean {
  return getData().users.some((u) => u.role === "client" && u.client_id === clientId && isReviewEmail(u.email ?? ""));
}

/** Once, the first time any of this runs: every client from before is opened, silently, so no existing client is ever
 *  locked: one with a sign-in already (they have seen the app open), been in it, a phase out, or anything logged. Only
 *  people let in after it ever see the lock. Marked on the store (app_lock_swept), never run again. */
function sweepOnce() {
  const data = getData();
  if (data.app_lock_swept) return;
  const now = new Date().toISOString();
  const today = localDateStr();
  const signedUp = new Set(data.users.filter((u) => u.role === "client" && u.client_id != null).map((u) => u.client_id));
  for (const c of data.clients) {
    if (c.app_opened_at) continue;
    if (signedUp.has(c.id) || !!c.last_active_at || hadPhaseLive(c.id, today) || loggedAnything(c.id) || isReviewClient(c.id)) {
      c.app_opened_at = now;
      c.app_opened_by = "before";
    }
  }
  data.app_lock_swept = now;
  persist();
}

function lockOf(client: ClientRow): AppLock {
  const coachName = getCoachDisplayName(client.id);
  return {
    coachFirst: coachName.split(/\s+/)[0] || "Coach",
    coachName,
    business: client.coach_id != null ? (getCoachSettings(client.coach_id).business?.business_name?.trim() ?? "") : "",
    avatarPath: getCoachAvatarPath(client.id),
  };
}

/** Still locked, nothing marked: the coach's Home reads this for its ⋯ (a live phase reads as open, the timer pushing). */
export function appLocked(clientId: number): boolean {
  sweepOnce();
  const client = getData().clients.find((c) => c.id === clientId);
  if (!client || client.app_opened_at || client.coach_id == null) return false;
  return !hadPhaseLive(clientId) && !isReviewClient(clientId) && !loggedAnything(clientId);
}

/** The client's own app: the lock to draw, or null when open. Found open by a live phase (or, from before, by something
 *  logged), it is marked open here for good, with no push: the client is looking at it. */
export function appLockFor(clientId: number): AppLock | null {
  sweepOnce();
  const client = getData().clients.find((c) => c.id === clientId);
  if (!client || client.app_opened_at || client.coach_id == null) return null;
  if (isReviewClient(clientId)) return null;
  const phase = hadPhaseLive(clientId);
  if (phase || loggedAnything(clientId)) {
    client.app_opened_at = new Date().toISOString();
    client.app_opened_by = phase ? "phase" : "before";
    persist();
    return null;
  }
  return lockOf(client);
}

/** Opens the client's app now, if it isn't open yet, and tells the client: `Your app is ready`, `From {First}`. The mark
 *  is saved before the push goes, so it goes once. Answers whether it opened it. */
export async function openClientApp(clientId: number, by: "coach" | "phase"): Promise<boolean> {
  sweepOnce();
  const data = getData();
  const client = data.clients.find((c) => c.id === clientId);
  if (!client || client.app_opened_at) return false;
  client.app_opened_at = new Date().toISOString();
  client.app_opened_by = by;
  await persistNow();
  if (!appLockPushOn()) return true;
  const { coachFirst } = lockOf(client);
  const { sendPush } = await import("./push");
  for (const u of data.users.filter((x) => x.role === "client" && x.client_id === clientId)) {
    try {
      await sendPush(u.id, { title: "Your app is ready", body: `From ${coachFirst}`, url: "/client", tag: "app-ready" });
    } catch (e) {
      console.error(`[app-lock] push to client ${clientId} failed:`, e instanceof Error ? e.message : e);
    }
  }
  return true;
}

/** After a phase is made live or scheduled from the Plan or Training: opens a client still locked whose phase has begun. */
export async function openAppIfPhaseLive(clientId: number | null | undefined): Promise<boolean> {
  if (clientId == null) return false;
  try {
    sweepOnce();
    const client = getData().clients.find((c) => c.id === clientId);
    if (!client || client.app_opened_at || client.coach_id == null || !hadPhaseLive(clientId)) return false;
    return await openClientApp(clientId, "phase");
  } catch (e) {
    console.error(`[app-lock] opening ${clientId} failed:`, e instanceof Error ? e.message : e);
    return false;
  }
}

/** The timer's tick (instrumentation.ts): every client still locked whose first phase has begun (one scheduled for
 *  today) opens, and is pushed once. Answers how many opened. */
export async function checkAppLocks(): Promise<number> {
  sweepOnce();
  const today = localDateStr();
  const due = getData()
    .clients.filter((c) => !c.app_opened_at && c.coach_id != null && hadPhaseLive(c.id, today) && !isReviewClient(c.id))
    .map((c) => c.id);
  let opened = 0;
  for (const id of due) if (await openClientApp(id, "phase")) opened++;
  return opened;
}
