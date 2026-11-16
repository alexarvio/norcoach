// A phone workout as the coach's logs say it (16 Nov, Alex; lib/healthSync.ts keeps them): its type in words, its facts.

import type { HealthWorkout } from "./db";

/** A workout's type in words: "running" Running, "traditionalStrengthTraining" Strength training. */
export function healthWorkoutWords(type: string): string {
  const named: Record<string, string> = {
    other: "Workout",
    traditionalStrengthTraining: "Strength training",
    functionalStrengthTraining: "Functional strength training",
    highIntensityIntervalTraining: "HIIT",
    mixedCardio: "Cardio",
    runningTreadmill: "Treadmill run",
    bikingStationary: "Indoor cycling",
    swimmingPool: "Pool swim",
    swimmingOpenWater: "Open water swim",
    mindAndBody: "Mind and body",
    stairClimbingMachine: "Stair machine",
    rowingMachine: "Rowing machine",
    crossTraining: "Cross training",
    frisbeedisc: "Frisbee",
  };
  if (named[type]) return named[type];
  const words = type.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Workout";
}

/** Its facts for a row: "32 min", then "5.1 km", else "410 kcal". */
export function healthWorkoutFacts(w: Pick<HealthWorkout, "seconds" | "meters" | "kcal">): string[] {
  const min = Math.max(1, Math.round(w.seconds / 60));
  const time = min >= 60 ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} min` : `${min} min`;
  const out = [time];
  if (w.meters != null && w.meters >= 100) out.push(`${(w.meters / 1000).toFixed(1)} km`);
  else if (w.kcal != null && w.kcal > 0) out.push(`${w.kcal} kcal`);
  return out;
}

export const healthStoreName = (store: HealthWorkout["store"]) => (store === "google" ? "Health Connect" : "Apple Health");
