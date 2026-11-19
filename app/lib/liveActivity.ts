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
  } | null;
  /** The client's gyms by id, for a gym switched while the session runs. */
  gyms: Record<string, string>;
};

/** The session as the lock screen shows it. */
export type LiveShown = { dayId: number; startedAt: number; name: string; gym: string | null; sets: number; url: string };

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
  call("start", { dayId: s.dayId, startedAt: s.startedAt, name: s.name, gym: s.gym, sets: s.sets, url: s.url });
}

/** Its name, gym or sets changed. Left out, the gym shown stays; null, no gym. */
export function liveUpdate(u: { dayId: number; name?: string; gym?: string | null; sets?: number }) {
  call("update", u);
}

/** Takes it down at once; no day, every one. */
export function liveEnd(dayId?: number) {
  call("end", dayId == null ? {} : { dayId });
}

/** Ends every one but the session going (null: all of them). */
export function liveSync(keep: { dayId: number; startedAt: number } | null) {
  call("sync", { keep });
}
