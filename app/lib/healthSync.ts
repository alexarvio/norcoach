// What the phone's Apple Health / Health Connect fills (16 Nov, Alex: "aight do so!"): the coach's own metrics, when the
// coach tracks them on the client's live lifestyle phase (listMetricDefinitions; a metric is never made here), and the
// workouts, kept for the coach's Activity. The phone reads (app/client/HealthSync.tsx) and sends a day's figures; here
// they are matched to the metrics, checked and saved, flagged as the phone's ("health"), for the periods a check-in can
// still change. Steps fill as they did (syncHealthStepsAction, 24 Oct).

import { getData, isStepsMetric, MAX_DAY_STEPS, persist, allocId, type HealthWorkout } from "./db";
import { checkInEditable, getMetricEntries, listMetricDefinitions, listMonthlyMetricsAsked, localDateStr, monthStart, setMetricEntry, weekStart, WEIGHT_NAME, weightInUnit, type MetricCadence, type MetricDefinition } from "./queries";

export type HealthKind = "steps" | "weight" | "sleep" | "restingHeartRate" | "hrv";

/** What the phone sends: each kind a figure a day (weight every weigh-in a day with its moment), and the workouts of
 *  the window it read (null when it couldn't read them, so none are taken away). Days are the phone's own. */
export type HealthSyncInput = {
  store?: "apple" | "google";
  steps?: { date: string; steps: number }[];
  weight?: { date: string; kg: number; at: string }[];
  sleep?: { date: string; hours: number }[];
  restingHeartRate?: { date: string; bpm: number }[];
  hrv?: { date: string; ms: number }[];
  workouts?: HealthWorkoutIn[] | null;
  /** The start of the window the workouts were read for (ISO). */
  workoutsFrom?: string;
};
export type HealthWorkoutIn = { id?: string; type: string; start: string; end: string; seconds: number; kcal?: number | null; meters?: number | null; source?: string | null };
/** Which kinds the coach tracks, how many figures were saved, and how many workouts the phone had in its window. */
export type HealthSyncResult = { tracked: HealthKind[]; saved: number; workouts: number; workoutsChanged?: boolean };

/** A figure past these is a slip of a sensor or an app, never a reading. */
const RANGE: Record<Exclude<HealthKind, "steps">, [number, number]> = { weight: [25, 350], sleep: [0, 16], restingHeartRate: [25, 150], hrv: [5, 300] };

const HOURS_UNIT = /^(h|hr|hrs|hour|hours|uur|uren)\.?$/i;
const MINUTES_UNIT = /^(m|min|mins|minute|minutes)\.?$/i;
const SCALE_UNIT = /^\/\s*\d+$|out of|score|%/i;

/** Which of the phone's kinds a metric of the coach's is, by its name and unit, or none. Sleep only as hours (or minutes)
 *  slept, never a 1–10 quality; weight only the body's (Weight, Body weight), never a goal or a lift. */
export function healthKindOf(def: Pick<MetricDefinition, "name" | "unit" | "frequency">): { kind: HealthKind; minutes?: boolean } | null {
  const name = def.name.trim();
  const unit = (def.unit ?? "").trim();
  if (WEIGHT_NAME.test(name)) {
    if (/goal|target|lift|lifted/i.test(name)) return null;
    if (unit && !/^(kg|kgs|kilo|kilos|kilograms?|lbs?\.?|pounds?)$/i.test(unit)) return null;
    return { kind: "weight" };
  }
  if (def.frequency !== "daily") return null;
  if (isStepsMetric(name)) return /goal|target/i.test(name) ? null : { kind: "steps" };
  if (/resting\s*(hr|heart\s*rate|pulse)|\brhr\b/i.test(name)) return !unit || /^bpm$/i.test(unit) ? { kind: "restingHeartRate" } : null;
  if (/\bhrv\b|heart\s*rate\s*variab/i.test(name)) return !unit || /^ms$/i.test(unit) ? { kind: "hrv" } : null;
  if (/\bsleep|\bslept\b/i.test(name)) {
    if (/quality|score|rating|rate|feel|well|deep|rem\b|restful/i.test(name) || SCALE_UNIT.test(unit)) return null;
    if (HOURS_UNIT.test(unit)) return { kind: "sleep" };
    if (MINUTES_UNIT.test(unit)) return { kind: "sleep", minutes: true };
    if (!unit && /hours?|\bhrs?\b|duration|slept|how long/i.test(name)) return { kind: "sleep" };
  }
  return null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const num = (v: unknown) => (typeof v === "number" ? v : Number(v));
const list = <T>(v: T[] | null | undefined, max: number): T[] => (Array.isArray(v) ? v.slice(0, max) : []);

/** The periods of a rhythm a check-in can still change: today's and every one a day of the last seven falls in. */
function editablePeriods(frequency: MetricCadence, today: string): Set<string> {
  const out = new Set<string>();
  const d = new Date(`${today}T00:00:00`);
  for (let i = 0; i <= 7; i++) {
    const day = localDateStr(d);
    if (checkInEditable(day, today)) out.add(frequency === "weekly" ? weekStart(day) : frequency === "monthly" ? monthStart(day) : day);
    d.setDate(d.getDate() - 1);
  }
  return out;
}
const periodOf = (frequency: MetricCadence, day: string) => (frequency === "weekly" ? weekStart(day) : frequency === "monthly" ? monthStart(day) : day);

export function syncHealthForClient(clientId: number, input: HealthSyncInput): HealthSyncResult {
  const today = localDateStr();
  const now = new Date().toISOString();
  // The metrics the client is asked: monthly ones only while monthly check-ins are on for them (listMonthlyMetricsAsked).
  const defs = [...listMetricDefinitions(clientId, "daily"), ...listMetricDefinitions(clientId, "weekly"), ...listMonthlyMetricsAsked(clientId)];
  const matched = defs.flatMap((def) => {
    const k = healthKindOf(def);
    return k ? [{ def, ...k }] : [];
  });
  const tracked = [...new Set(matched.map((m) => m.kind))];
  let saved = 0;

  // A day's figure for each daily kind. Steps replace a typed count, as they did; the rest never touch a day the client
  // typed in themselves (16 Nov: their own figure stays), only one the phone filled before.
  const daily = (def: MetricDefinition, days: { date: string; value: number }[], keepTyped: boolean) => {
    const current = new Map(getMetricEntries([def.id]).map((e) => [e.period, e] as const));
    for (const day of days) {
      if (!checkInEditable(day.date, today)) continue;
      const was = current.get(day.date);
      // A day the client typed in, or emptied (a wrong reading taken out), is theirs: the phone never fills it again.
      if (keepTyped && was && was.source !== "health") continue;
      if (was?.value === day.value && was.source === "health") continue;
      // Flagged as the phone's, and an older day keeps its time (13 Nov, Alex: Activity showed 8 daily check-ins at 14:55).
      if (setMetricEntry(def.id, day.date, day.value, now, "health")) saved++;
    }
  };
  const inRange = (kind: Exclude<HealthKind, "steps">, v: number) => Number.isFinite(v) && v >= RANGE[kind][0] && v <= RANGE[kind][1];

  for (const m of matched) {
    if (m.kind === "steps") {
      const days = list(input.steps, 14)
        .map((d) => ({ date: String(d?.date), value: Math.round(num(d?.steps)) }))
        .filter((d) => DAY.test(d.date) && Number.isFinite(d.value) && d.value > 0 && d.value <= MAX_DAY_STEPS);
      daily(m.def, days, false);
    } else if (m.kind === "sleep") {
      const days = list(input.sleep, 14)
        .map((d) => ({ date: String(d?.date), hours: num(d?.hours) }))
        .filter((d) => DAY.test(d.date) && inRange("sleep", d.hours) && d.hours > 0)
        .map((d) => ({ date: d.date, value: m.minutes ? Math.round(d.hours * 60) : Math.round(d.hours * 10) / 10 }));
      daily(m.def, days, true);
    } else if (m.kind === "restingHeartRate") {
      const days = list(input.restingHeartRate, 14)
        .map((d) => ({ date: String(d?.date), value: Math.round(num(d?.bpm)) }))
        .filter((d) => DAY.test(d.date) && inRange("restingHeartRate", d.value));
      daily(m.def, days, true);
    } else if (m.kind === "hrv") {
      const days = list(input.hrv, 14)
        .map((d) => ({ date: String(d?.date), value: Math.round(num(d?.ms)) }))
        .filter((d) => DAY.test(d.date) && inRange("hrv", d.value));
      daily(m.def, days, true);
    } else if (m.kind === "weight") {
      // Every rhythm the coach asks weight on: each period the check-in can still change takes its latest weigh-in, in
      // the metric's own unit (kg, or lbs as the coach set it; the store keeps the figure as typed, bodyWeightReadings
      // reads it in kg), at the moment it was weighed, so a weekly one files under the day weighed.
      const freq = m.def.frequency;
      const open = editablePeriods(freq, today);
      const latest = new Map<string, { kg: number; at: string; ms: number }>();
      for (const r of list(input.weight, 120)) {
        const kg = num(r?.kg);
        const at = String(r?.at ?? "");
        const ms = Date.parse(at);
        const date = String(r?.date);
        if (!DAY.test(date) || !inRange("weight", kg) || !Number.isFinite(ms) || ms > Date.now() + 5 * 60_000) continue;
        const period = periodOf(freq, date);
        if (!open.has(period)) continue;
        const was = latest.get(period);
        if (!was || ms > was.ms) latest.set(period, { kg, at: new Date(ms).toISOString(), ms });
      }
      const current = new Map(getMetricEntries([m.def.id]).map((e) => [e.period, e] as const));
      for (const [period, r] of latest) {
        const was = current.get(period);
        if (was && was.source !== "health") continue;
        const value = Math.round(weightInUnit(r.kg, "kg", m.def.unit || "kg") * 10) / 10;
        if (was?.value === value && was.source === "health" && was.logged_at === r.at) continue;
        if (setMetricEntry(m.def.id, period, value, r.at, "health", true)) saved++;
      }
    }
  }

  const w = syncWorkouts(clientId, input);
  return { tracked, saved, workouts: w.count, workoutsChanged: w.changed };
}

/** The phone's workouts of its window, one a store id: new ones in, changed ones updated, and ones the phone no longer
 *  has in that window taken out. How many the phone had. */
function syncWorkouts(clientId: number, input: HealthSyncInput): { count: number; changed: boolean } {
  if (!Array.isArray(input.workouts)) return { count: 0, changed: false };
  const store: HealthWorkout["store"] = input.store === "google" ? "google" : "apple";
  const data = getData();
  data.health_workouts ??= [];
  const rows = data.health_workouts;
  const nowMs = Date.now();
  const seen = new Set<string>();
  let changed = false;
  for (const w of input.workouts.slice(0, 200)) {
    const startMs = Date.parse(String(w?.start ?? ""));
    const endMs = Date.parse(String(w?.end ?? ""));
    const type = String(w?.type ?? "other").replace(/[^A-Za-z]/g, "").slice(0, 48) || "other";
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs || startMs > nowMs + 5 * 60_000) continue;
    let seconds = Math.round(num(w?.seconds));
    if (!Number.isFinite(seconds) || seconds <= 0) seconds = Math.round((endMs - startMs) / 1000);
    if (seconds < 60 || seconds > 24 * 3600) continue;
    const start = new Date(startMs).toISOString();
    const end = new Date(endMs).toISOString();
    const id = String(w?.id ?? "").slice(0, 120) || `${type}|${start}`;
    seen.add(id);
    const kcalIn = num(w?.kcal);
    const metersIn = num(w?.meters);
    const kcal = Number.isFinite(kcalIn) && kcalIn > 0 && kcalIn < 20000 ? Math.round(kcalIn) : null;
    const meters = Number.isFinite(metersIn) && metersIn > 0 && metersIn < 1_000_000 ? Math.round(metersIn) : null;
    const source = typeof w?.source === "string" && w.source.trim() ? w.source.trim().slice(0, 60) : null;
    const was = rows.find((r) => r.client_id === clientId && r.store === store && r.platform_id === id);
    if (was) {
      if (was.type === type && was.start === start && was.end === end && was.seconds === seconds && was.kcal === kcal && was.meters === meters && was.source === source) continue;
      Object.assign(was, { type, start, end, seconds, kcal, meters, source, synced_at: new Date().toISOString() });
    } else {
      rows.push({ id: allocId("health_workouts"), client_id: clientId, store, platform_id: id, type, start, end, seconds, kcal, meters, source, synced_at: new Date().toISOString() });
    }
    changed = true;
  }
  // Gone from the phone (deleted in Health) within the window it read: gone here.
  const fromMs = Date.parse(String(input.workoutsFrom ?? ""));
  if (Number.isFinite(fromMs)) {
    const keep = rows.filter((r) => !(r.client_id === clientId && r.store === store && Date.parse(r.start) >= fromMs && !seen.has(r.platform_id)));
    if (keep.length !== rows.length) {
      data.health_workouts = keep;
      changed = true;
    }
  }
  // A client's newest 400 kept: plenty for Activity's 200 a kind.
  const mine = data.health_workouts.filter((r) => r.client_id === clientId);
  if (mine.length > 400) {
    const drop = new Set(mine.sort((a, b) => (a.start < b.start ? 1 : -1)).slice(400));
    data.health_workouts = data.health_workouts.filter((r) => !drop.has(r));
    changed = true;
  }
  if (changed) persist();
  return { count: seen.size, changed };
}

