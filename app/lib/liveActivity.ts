import { callNative } from "./native";

// The workout on the lock screen (19 Nov, Alex: "a pill on the lock screen of my iphone whenever there is an ongoing
// workout"): the app's NorcoachLive plugin (mobile/ios/App/App/NorcoachLivePlugin.swift) shows it as a Live Activity.
// The page says what is going (useLiveActivitySync) and the plugin draws it. An app from before the plugin has none,
// and Capacitor never answers a call to a missing method, so each method is looked for first (the plugin's own list,
// as savePassword.ts does). Every call is fire and forget: the workout never waits on it, and a failure says nothing.

const PLUGIN = "NorcoachLive";

/** What the server says is going (liveNowFor, read with the page and by liveSessionNowAction). */
export type LiveNow = {
  session: {
    id: number;
    /** As the resume pill names it (liveSessionFor). */
    label: string;
    /** Its start, epoch ms. */
    startedMs: number;
    /** The gym the pill shows (null: none, a rogue session with none picked). */
    gymId: number | null;
    /** Its logged sets, `assignment:set`, so the waiting ones on the phone add to them once each. */
    sets: string[];
    /** A rogue session: no plan, so no total and no targets (19 Nov, Alex: C). */
    rogue: boolean;
    /** Its exercises in session order, for the set next (19 Nov, Alex: C of docs/boards/live-activity-mockup.html). */
    exercises: LiveExercise[];
  } | null;
  /** The client's gyms by id, for a gym switched while the session runs. */
  gyms: Record<string, string>;
  /** The coach's business name, only while the coach has a brand colour (19 Nov, Alex: C); else null. */
  coach: string | null;
  /** The coach's brand colour as used (`brandColour`, dark enough for white words); null with none. */
  brand: string | null;
};

/** An exercise of the session going, as the server has it (liveNowFor). */
export type LiveExercise = {
  /** The assignment. */
  id: number;
  /** The planned exercise's name; `swap` what the client does instead (null: none). */
  name: string;
  swap: string | null;
  /** The sets the row asks this session (setsDue) and the coach's own count, as the workout's `sets` and `coachSets`. */
  sets: number;
  coachSets: number;
  /** The coach's reps (`10-12`), "" with none; never on a rogue session. */
  reps: string;
  /** The coach's weight at the session's gym, and at each of the client's gyms (targetAtGym); null with none. */
  kg: number | null;
  kgAt: Record<string, number | null>;
  /** Kg or lbs, as this session's sets were logged; null when no set says (kg). */
  unit: "kg" | "lb" | null;
  /** Its working sets logged: the set's number and when, epoch ms. */
  logs: { n: number; at: number }[];
};

/** The set next on the pill (19 Nov, Alex: C): all optional, left out when not known. */
export type LiveNext = { total?: number | null; exercise?: string | null; setNo?: number | null; setOf?: number | null; target?: string | null };

/** The session as the lock screen shows it. */
export type LiveShown = LiveNext & { dayId: number; startedAt: number; name: string; gym: string | null; sets: number; url: string; finishUrl: string; coach: string | null; brand: string | null };

function has(method: string): boolean {
  try {
    const cap = (window as { Capacitor?: { PluginHeaders?: { name: string; methods?: { name: string }[] }[] } }).Capacitor;
    return !!cap?.PluginHeaders?.some((h) => h.name === PLUGIN && h.methods?.some((m) => m.name === method));
  } catch {
    return false;
  }
}

function call(method: string, options: object) {
  if (typeof window === "undefined" || !has(method)) return;
  try {
    void callNative(PLUGIN, method, options).catch(() => {});
  } catch {
    // Nothing to say.
  }
}

/** Whether this build of the app has the lock-screen pill at all. */
export const liveActivityAvailable = () => typeof window !== "undefined" && has("start");

/** Shows it, or updates the one showing (same day and start); any other one ends. */
export function liveStart(s: LiveShown) {
  call("start", {
    dayId: s.dayId,
    startedAt: s.startedAt,
    url: s.url,
    finishUrl: s.finishUrl,
    coach: s.coach,
    brand: s.brand,
    name: s.name,
    gym: s.gym,
    sets: s.sets,
    ...nextOf(s),
  });
}

/** Its name, gym, sets or set next changed. Left out, the gym shown stays; null, no gym. The set next goes whole each
    time: what is left out of it is none (19 Nov, Alex: C). */
export function liveUpdate(u: LiveNext & { dayId: number; name?: string; gym?: string | null; sets?: number }) {
  call("update", {
    dayId: u.dayId,
    ...(u.name !== undefined ? { name: u.name } : {}),
    ...(u.gym !== undefined ? { gym: u.gym } : {}),
    ...(u.sets !== undefined ? { sets: u.sets } : {}),
    ...nextOf(u),
  });
}

// The set next as the plugin reads it (19 Nov, Alex: C): a key left out is none, so null and unknown are left out alike.
function nextOf(n: LiveNext) {
  const out: Record<string, string | number> = {};
  if (n.total != null) out.total = n.total;
  if (n.exercise != null) out.exercise = n.exercise;
  if (n.setNo != null) out.setNo = n.setNo;
  if (n.setOf != null) out.setOf = n.setOf;
  if (n.target != null) out.target = n.target;
  return out;
}

/** Takes it down at once; no day, every one. */
export function liveEnd(dayId?: number) {
  call("end", dayId == null ? {} : { dayId });
}

/** Ends every one but the session going (null: all of them). */
export function liveSync(keep: { dayId: number; startedAt: number } | null) {
  call("sync", { keep });
}
