import { getData, persist, persistNow } from "./db";
import { getCoachAvatarPath, getCoachDisplayName, getCoachSettings, localDateStr } from "./queries";
import { isReviewEmail } from "./reviewAccount";
import { fetchFoodLogged, type FoodRows } from "./food/rows";
import type { FoodReadPath } from "./food/paths";
import { fetchCheckInsLogged, type CheckInRows } from "./checkins/rows";
import type { CheckInReadPath } from "./checkins/paths";
import { fetchSetsLogged, type SetRows } from "./sets/rows";
import type { SetReadPath } from "./sets/paths";

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
function loggedAnything(clientId: number, logged: FoodRows, ck: CheckInRows, sr: SetRows): boolean {
  const data = getData();
  // The food diary through its door (quest 8 part 1): the view a page or the timer fetched (fetchFoodLogged).
  logged.need("appLock.loggedAnything", clientId, "logged", ["entries", "calories"]);
  if (logged.entries.some((e) => e.client_id === clientId)) return true;
  if (logged.calories.some((l) => l.client_id === clientId && l.source !== "health")) return true;
  if ((data.cardio_logs ?? []).some((l) => l.client_id === clientId)) return true;
  if ((data.measurement_values ?? []).some((v) => v.client_id === clientId && !!v.logged_at)) return true;
  const slotIds = new Set((data.photo_slots ?? []).filter((s) => s.client_id === clientId).map((s) => s.id));
  if (slotIds.size && (data.photo_uploads ?? []).some((u) => slotIds.has(u.slot_id))) return true;
  const days = data.program_days.filter((d) => d.client_id === clientId);
  if (days.some((d) => !!d.session_started_at)) return true;
  const metricIds = new Set(data.metric_definitions.filter((m) => m.client_id === clientId).map((m) => m.id));
  // The check-in figures through their door (quest 9): whether a metric holds one the client typed (fetchCheckInsLogged).
  if (metricIds.size) ck.need("appLock.loggedAnything", clientId, "logged", ["entries"]);
  if (metricIds.size && ck.entries.some((e) => metricIds.has(e.metric_definition_id) && e.source !== "health" && e.value != null)) return true;
  if (!days.length) return false;
  const dayIds = new Set(days.map((d) => d.id));
  const rowIds = new Set(data.workout_assignments.filter((a) => dayIds.has(a.program_day_id)).map((a) => a.id));
  // The sets through their door (quest 10): whether the client holds one at all (fetchSetsLogged, `any`).
  if (rowIds.size) sr.needLogged("appLock.loggedAnything", clientId, true);
  return rowIds.size > 0 && sr.logs.some((s) => rowIds.has(s.workout_assignment_id));
}

function isReviewClient(clientId: number): boolean {
  return getData().users.some((u) => u.role === "client" && u.client_id === clientId && isReviewEmail(u.email ?? ""));
}

/** Once, the first time any of this runs: every client from before is opened, silently, so no existing client is ever
 *  locked: one with a sign-in already (they have seen the app open), been in it, a phase out, or anything logged. Only
 *  people let in after it ever see the lock. Marked on the store (app_lock_swept), never run again. */
function sweepOnce(logged: FoodRows, ck: CheckInRows, sr: SetRows) {
  const data = getData();
  if (data.app_lock_swept) return;
  const now = new Date().toISOString();
  const today = localDateStr();
  const signedUp = new Set(data.users.filter((u) => u.role === "client" && u.client_id != null).map((u) => u.client_id));
  for (const c of data.clients) {
    if (c.app_opened_at) continue;
    if (signedUp.has(c.id) || !!c.last_active_at || hadPhaseLive(c.id, today) || loggedAnything(c.id, logged, ck, sr) || isReviewClient(c.id)) {
      c.app_opened_at = now;
      c.app_opened_by = "before";
    }
  }
  data.app_lock_swept = now;
  persist();
}

/** The sweep for code that hasn't fetched every client's food (the timer, an opening): the clients still unopened fetched first. */
async function sweepOnceFetched(path: "job.appLocks" | "action.appLock"): Promise<void> {
  if (getData().app_lock_swept) return;
  const unopened = getData().clients.filter((c) => !c.app_opened_at).map((c) => c.id);
  const food = await fetchFoodLogged(unopened, path);
  const ck = await fetchCheckInsLogged(unopened, path);
  sweepOnce(food, ck, await fetchSetsLogged(path, unopened, "any"));
}

/** What appLocked reads of the check-in figures (the coach's actions; every client still unopened while the sweep hasn't run). */
export function fetchAppLockSets(clientIds: readonly number[], path: SetReadPath): Promise<SetRows> {
  const unopened = getData().app_lock_swept ? [] : getData().clients.filter((c) => !c.app_opened_at).map((c) => c.id);
  return fetchSetsLogged(path, [...clientIds, ...unopened], "any");
}

export function fetchAppLockCheckIns(clientIds: readonly number[], path: CheckInReadPath): Promise<CheckInRows> {
  const unopened = getData().app_lock_swept ? [] : getData().clients.filter((c) => !c.app_opened_at).map((c) => c.id);
  return fetchCheckInsLogged([...clientIds, ...unopened], path);
}

/** What appLocked and appLockFor read of the food diary: the clients' entries and calorie logs (the page fetches it first;
 *  every client still unopened while the one-time sweep hasn't run). */
export function fetchAppLockFood(clientIds: readonly number[], path: FoodReadPath): Promise<FoodRows> {
  const unopened = getData().app_lock_swept ? [] : getData().clients.filter((c) => !c.app_opened_at).map((c) => c.id);
  return fetchFoodLogged([...clientIds, ...unopened], path);
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
export function appLocked(clientId: number, logged: FoodRows, ck: CheckInRows, sr: SetRows): boolean {
  sweepOnce(logged, ck, sr);
  const client = getData().clients.find((c) => c.id === clientId);
  if (!client || client.app_opened_at || client.coach_id == null) return false;
  return !hadPhaseLive(clientId) && !isReviewClient(clientId) && !loggedAnything(clientId, logged, ck, sr);
}

/** The client's own app: the lock to draw, or null when open. Found open by a live phase (or, from before, by something
 *  logged), it is marked open here for good, with no push: the client is looking at it. */
export function appLockFor(clientId: number, logged: FoodRows, ck: CheckInRows, sr: SetRows): AppLock | null {
  sweepOnce(logged, ck, sr);
  const client = getData().clients.find((c) => c.id === clientId);
  if (!client || client.app_opened_at || client.coach_id == null) return null;
  if (isReviewClient(clientId)) return null;
  const phase = hadPhaseLive(clientId);
  if (phase || loggedAnything(clientId, logged, ck, sr)) {
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
  await sweepOnceFetched("action.appLock");
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
      await sendPush(u.id, { title: "Your app is ready", body: `From ${coachFirst}`, url: "/client", tag: "app-ready", group: "always" });
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
    await sweepOnceFetched("action.appLock");
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
  await sweepOnceFetched("job.appLocks");
  const today = localDateStr();
  const due = getData()
    .clients.filter((c) => !c.app_opened_at && c.coach_id != null && hadPhaseLive(c.id, today) && !isReviewClient(c.id))
    .map((c) => c.id);
  let opened = 0;
  for (const id of due) if (await openClientApp(id, "phase")) opened++;
  return opened;
}
