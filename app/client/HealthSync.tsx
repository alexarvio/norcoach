"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { syncHealthAction } from "../lib/actions";
import type { HealthSyncInput, HealthSyncResult, HealthWorkoutIn } from "../lib/healthSync";
import { callNative, nativeApp as cap, nativePlatform as platformOf } from "../lib/native";
import SettingsFold from "./SettingsFold";

// Apple Health (iPhone) or Health Connect (Android), read by the native app (mobile/, the @capgo/capacitor-health
// plugin) and sent to syncHealthAction: steps, weight, sleep, resting heart rate and HRV fill the coach's own metrics
// when the coach tracks them, and the workouts go to the coach's Activity (16 Nov, Alex: "aight do so!"; steps alone
// before); the calories a food app wrote there are the day's calories in the food diary (17 Nov). In a browser none of
// this exists: Settings shows the rows as "Soon", as before.

const noSubscribe = () => () => {};

// Whether this phone syncs, kept on the phone: iPhone never tells an app
// whether it may read (HealthKit hides a "no"), so the switch is ours.
const KEY = "ironline-health-steps";
const readOn = () => {
  try {
    return window.localStorage.getItem(KEY) === "on";
  } catch {
    return false;
  }
};
const writeOn = (on: boolean) => {
  try {
    if (on) window.localStorage.setItem(KEY, "on");
    else window.localStorage.removeItem(KEY);
  } catch {
    /* blocked storage: syncs for this visit only */
  }
  onListeners.forEach((l) => l());
};
// Settings' switch and the check-in pop-up's line read the same switch, so turning it on in one shows in the other.
const onListeners = new Set<() => void>();
const subscribeOn = (l: () => void) => {
  onListeners.add(l);
  return () => onListeners.delete(l);
};

/** Whether this phone's health store is connected (Settings · Connected apps), live; true outside the app and while
 *  drawing on the server, so nothing says "not connected" where it can't be. */
export function useHealthConnected(): boolean {
  return useSyncExternalStore(subscribeOn, () => !cap() || readOn(), () => true);
}

/** Connect this phone's health store, as Settings' switch does: the phone's own sheet asks, then the first sync. A
 *  short fact when it didn't go ("Not allowed"), else null. */
export async function connectHealth(): Promise<{ note: string | null; result: HealthSyncResult | null }> {
  const platform = platformOf();
  try {
    const avail = await callNative<{ available?: boolean }>("Health", "isAvailable");
    if (!avail.available) return { note: platform === "android" ? "Health Connect not installed" : "Not on this phone", result: null };
    const auth = await askToRead();
    // Android says what was allowed; iPhone never does.
    if (platform === "android" && !auth.readAuthorized?.length) return { note: "Not allowed", result: null };
    writeOn(true);
    return { note: null, result: await syncHealth().catch(() => null) };
  } catch {
    return { note: "Couldn't connect. Try again", result: null };
  }
}

// What the phone is asked to read. A phone that turned the switch on before 16 Nov was asked for steps alone: it is
// asked once more for the rest on its next sync (iPhone shows its sheet only for the types it hasn't asked yet). The
// calories eaten came 17 Nov (Alex: MyFitnessPal "or see that we can also link calories tracked there"; a food app writes
// them to Apple Health and Health Connect), so every phone is asked once more for them ("3").
const READ = ["steps", "weight", "sleep", "restingHeartRate", "heartRateVariability", "dietaryEnergyConsumed", "workouts"];
const ASKED_KEY = "ironline-health-asked";
const ASKED = "3";
// On Android a permission the installed app doesn't declare is never granted, and the site reaches phones before a new
// app build does: the ask is kept with the build it was made in, so the next build (declaring the new types) asks again.
// iPhone's sheet asks every type the build knows, so its mark is the version alone.
const askedMark = async () => {
  if (platformOf() !== "android") return ASKED;
  try {
    const info = await callNative<{ build?: string; version?: string }>("App", "getInfo");
    return `${ASKED}:${info.build ?? info.version ?? ""}`;
  } catch {
    return `${ASKED}:`;
  }
};
const readAsked = () => {
  try {
    return window.localStorage.getItem(ASKED_KEY);
  } catch {
    return BLOCKED;
  }
};
// Storage blocked: never asked again by itself (it would ask on every sync); the switch still asks.
const BLOCKED = "blocked";
const writeAsked = (mark: string) => {
  try {
    window.localStorage.setItem(ASKED_KEY, mark);
  } catch {
    /* blocked storage */
  }
};
const askToRead = async () => {
  const auth = await callNative<{ readAuthorized?: string[] }>("Health", "requestAuthorization", { read: READ, write: [] });
  writeAsked(await askedMark());
  return auth;
};

const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

type Sample = { value: number; unit?: string; startDate: string; endDate: string; sleepState?: string; stages?: { startDate: string; endDate: string; stage: string }[] };
type Workout = { workoutType: string; duration: number; totalEnergyBurned?: number; totalDistance?: number; startDate: string; endDate: string; sourceName?: string; platformId?: string };

const HOUR = 3_600_000;
const ASLEEP = new Set(["asleep", "rem", "deep", "light"]);
const STAGED = new Set(["rem", "deep", "light"]);

/** Hours asleep a night, one decimal, the night named by the morning it ends on (a segment ending before 18:00 is that
 *  day's, after it the next morning's). Asleep, REM, deep and light count; in bed and awake don't. A night with stages
 *  (a watch) reads them alone, and overlapping segments (two apps, two devices) count once. */
function sleepNights(samples: Sample[], fromDay: string): { date: string; hours: number }[] {
  const nights = new Map<string, { from: number; to: number; stage: string }[]>();
  const push = (start: string, end: string, stage: string) => {
    const from = Date.parse(start);
    const to = Date.parse(end);
    if (!ASLEEP.has(stage) || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) return;
    const night = localDay(new Date(to + 6 * HOUR));
    const list = nights.get(night) ?? [];
    list.push({ from, to, stage });
    nights.set(night, list);
  };
  for (const s of samples) {
    if (s.stages?.length) for (const st of s.stages) push(st.startDate, st.endDate, st.stage);
    else if (s.sleepState) push(s.startDate, s.endDate, s.sleepState);
    // A Health Connect session with no stages: asleep, start to end.
    else push(s.startDate, s.endDate, "asleep");
  }
  const out: { date: string; hours: number }[] = [];
  for (const [date, segs] of nights) {
    if (date < fromDay) continue;
    const staged = segs.filter((s) => STAGED.has(s.stage));
    const use = (staged.length ? staged : segs).sort((a, b) => a.from - b.from);
    let total = 0;
    let at = -Infinity;
    for (const s of use) {
      const from = Math.max(s.from, at);
      if (s.to > from) total += s.to - from;
      at = Math.max(at, s.to);
    }
    const hours = Math.round((total / HOUR) * 10) / 10;
    if (hours > 0) out.push({ date, hours });
  }
  return out;
}

/** A day's average of a kind's samples (resting heart rate, HRV), by the phone's day. */
function dayAverages(samples: Sample[], fromDay: string): { date: string; value: number }[] {
  const days = new Map<string, number[]>();
  for (const s of samples) {
    const t = Date.parse(s.startDate);
    if (!Number.isFinite(t) || !Number.isFinite(s.value)) continue;
    const day = localDay(new Date(t));
    if (day < fromDay) continue;
    days.set(day, [...(days.get(day) ?? []), s.value]);
  }
  return [...days].map(([date, v]) => ({ date, value: v.reduce((a, b) => a + b, 0) / v.length }));
}

/** One kind's samples, or none when it can't be read (not allowed, not on this phone): the others still go. */
const samplesOf = async (dataType: string, from: Date, limit: number): Promise<Sample[]> => {
  try {
    const res = await callNative<{ samples?: Sample[] }>("Health", "readSamples", { dataType, startDate: from.toISOString(), endDate: new Date().toISOString(), limit, ascending: true });
    return Array.isArray(res.samples) ? res.samples : [];
  } catch {
    return [];
  }
};

// The last eight days (today and the seven a check-in can still change), in the phone's time; weight from the start of
// the oldest week or month a check-in can still change, so a weekly or monthly weigh-in finds its latest.
async function syncHealth(): Promise<HealthSyncResult | null> {
  if (!cap()) return null;
  const asked = readAsked();
  if (asked !== BLOCKED && asked !== (await askedMark())) await askToRead().catch(() => {});
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - 7);
  const fromDay = localDay(start);
  const monday = new Date(start);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const monthFirst = new Date(start.getFullYear(), start.getMonth(), 1);
  const weightFrom = monday < monthFirst ? monday : monthFirst;
  const input: HealthSyncInput = { store: platformOf() === "android" ? "google" : "apple" };

  try {
    const res = await callNative<{ samples?: { startDate: string; value: number }[] }>("Health", "queryAggregated", {
      dataType: "steps",
      startDate: start.toISOString(),
      endDate: now.toISOString(),
      bucket: "day",
      aggregation: "sum",
    });
    input.steps = (res.samples ?? []).map((s) => ({ date: localDay(new Date(s.startDate)), steps: s.value }));
  } catch {
    /* steps not allowed: the rest still go */
  }

  // The calories eaten each day, as a food app (MyFitnessPal and the like) wrote them: the store's own day sum. Not
  // allowed (or an Android build that doesn't declare it): none sent, none taken away.
  try {
    const res = await callNative<{ samples?: { startDate: string; value: number }[] }>("Health", "queryAggregated", {
      dataType: "dietaryEnergyConsumed",
      startDate: start.toISOString(),
      endDate: now.toISOString(),
      bucket: "day",
      aggregation: "sum",
    });
    input.calories = (res.samples ?? []).map((s) => ({ date: localDay(new Date(s.startDate)), kcal: s.value }));
    input.caloriesFrom = fromDay;
  } catch {
    /* calories not allowed: the rest still go */
  }

  // Weight: each day's latest weigh-in, in kg, with when it was.
  const weighIns = new Map<string, { date: string; kg: number; at: string }>();
  for (const s of await samplesOf("weight", weightFrom, 500)) {
    const t = Date.parse(s.endDate || s.startDate);
    if (!Number.isFinite(t) || !Number.isFinite(s.value) || (s.unit && s.unit !== "kilogram")) continue;
    const date = localDay(new Date(t));
    const was = weighIns.get(date);
    if (!was || Date.parse(was.at) < t) weighIns.set(date, { date, kg: s.value, at: new Date(t).toISOString() });
  }
  input.weight = [...weighIns.values()];

  input.sleep = sleepNights(await samplesOf("sleep", new Date(start.getTime() - 18 * HOUR), 3000), fromDay);
  input.restingHeartRate = dayAverages(await samplesOf("restingHeartRate", start, 500), fromDay).map((d) => ({ date: d.date, bpm: d.value }));
  input.hrv = dayAverages(await samplesOf("heartRateVariability", start, 3000), fromDay).map((d) => ({ date: d.date, ms: d.value }));

  try {
    const res = await callNative<{ workouts?: Workout[] }>("Health", "queryWorkouts", { startDate: start.toISOString(), endDate: now.toISOString(), limit: 100, ascending: true });
    input.workouts = (res.workouts ?? []).map(
      (w): HealthWorkoutIn => ({
        id: w.platformId,
        type: w.workoutType,
        start: w.startDate,
        end: w.endDate,
        seconds: w.duration,
        kcal: w.totalEnergyBurned ?? null,
        meters: w.totalDistance ?? null,
        source: w.sourceName ?? null,
      })
    );
    input.workoutsFrom = start.toISOString();
  } catch {
    /* workouts not allowed: none sent, none taken away */
  }

  return syncHealthAction(input);
}

// Mounted once in the client app: syncs on opening and on coming back to the
// app, at most every ten minutes.
export function HealthAutoSync() {
  const router = useRouter();
  const last = useRef(0);
  useEffect(() => {
    if (!cap()) return;
    const run = () => {
      if (document.visibilityState !== "visible" || !readOn() || Date.now() - last.current < 10 * 60_000) return;
      last.current = Date.now();
      syncHealth()
        .then((r) => {
          if (r?.saved) router.refresh();
        })
        .catch(() => {});
    };
    run();
    document.addEventListener("visibilitychange", run);
    return () => document.removeEventListener("visibilitychange", run);
  }, [router]);
  return null;
}

// Settings > Connected apps. In the app: one switch for this phone's health
// store. In a browser: both, marked Soon.
export function ConnectedApps({ coachName }: { coachName: string }) {
  const platform = useSyncExternalStore(noSubscribe, platformOf, () => null);
  const router = useRouter();
  const on = useSyncExternalStore(subscribeOn, readOn, () => false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const synced = useCallback(
    (r: HealthSyncResult | null) => {
      // Nothing to say while anything goes (16 Nov): only when the coach tracks none of it and there are no workouts.
      if (r && r.tracked.length === 0 && r.workouts === 0 && !r.calories) setNote(`${coachName} isn't tracking steps, weight, sleep or heart rate yet`);
      else setNote(null);
      if (r?.saved) router.refresh();
    },
    [router, coachName]
  );

  // The names alone, Soon on their right; no line under the rows or the section (3 Nov, Alex: the words audit).
  if (!platform) {
    return (
      <SettingsFold title="Connected apps">
        <div className="home-dark-rows">
          {["Apple Health", "Health Connect"].map((name) => (
            <div key={name} className="settings-app-row">
              <div className="home-dark-row-body">
                <div className="home-dark-row-title">{name}</div>
              </div>
              <span className="st-soon">Soon</span>
            </div>
          ))}
        </div>
      </SettingsFold>
    );
  }

  const name = platform === "ios" ? "Apple Health" : "Health Connect";
  const toggle = async () => {
    if (busy) return;
    if (on) {
      writeOn(false);
      setNote(null);
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const { note: failed, result } = await connectHealth();
      if (failed) setNote(failed);
      else synced(result);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsFold title="Connected apps">
      <div className="home-dark-rows">
        <button type="button" className="settings-toggle-row" onClick={toggle} disabled={busy}>
          <div className="home-dark-row-body">
            <div className="home-dark-row-title">{name}</div>
            <div className="home-dark-row-detail">Steps, weight, sleep, heart rate, workouts, calories</div>
          </div>
          <span className={`settings-switch${on ? " on" : ""}`} aria-hidden="true">
            <span className="settings-switch-knob" />
          </span>
        </button>
      </div>
      {/* A note only when something went wrong (3 Nov, Alex: the words audit). */}
      {note && <div className="home-dark-empty st-note">{note}</div>}
    </SettingsFold>
  );
}
