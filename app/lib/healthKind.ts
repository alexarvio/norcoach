// Which of the coach's metrics the phone's health store can fill (Apple Health, Health Connect), by name and unit: one
// rule for the sync (healthSync.ts) and the check-in pop-up, which says when the phone isn't connected yet (17 Nov,
// Alex). Pure, so the check-in's read can ask it too.

// Steps as db.ts names them (isStepsMetric), written here so this file has no server import: the coach's metric search
// asks it in the browser (24 Nov, Alex: an icon on a metric the phone can fill).
const isStepsMetric = (name: string) => /\bsteps?\b/i.test(name);
import type { MetricDefinition } from "./queries";

/** A body weight's name (Weight, Body weight), never a goal or a lift's. */
export const WEIGHT_NAME = /^(body\s?)?weight\b/i;

export type HealthKind = "steps" | "weight" | "sleep" | "restingHeartRate" | "hrv";

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
