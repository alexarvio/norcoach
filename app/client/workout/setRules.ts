// The set rules of the workout, pure, for the workout sheet (15 Nov, Alex: docs/boards/workout-sheet-a-mockup.html).
// Copied, not moved, from ExercisePage.tsx (the pager), each with the lines it came from, so the pager can go later and
// these stay. A change to one of these rules is made in both places until then.

import { kgToDisplay, planToDisplay, type Unit } from "../../lib/units";
import { isPbNow } from "../../lib/repTarget";
import type { LastSet, SessionExercise } from "../workoutShared";

export type Vals = { weightKg: number | null; reps: number | null; rpe: number | null };
export const EMPTY: Vals = { weightKg: null, reps: null, rpe: null };

/** "8-10" → 8, "12" → 12: the reps the plan asks for (ExercisePage.tsx :160-165). */
export function repLowOf(reps: string): number | null {
  const range = reps.match(/(\d+)\s*(?:-|–|to)\s*(\d+)/);
  if (range) return Number(range[1]);
  const one = reps.match(/^\s*(\d+)\s*$/);
  return one ? Number(one[1]) : null;
}

/** The top of the reps asked (else last time's most), for the far-off check (ExercisePage.tsx :128-133). */
export function repTopOf(reps: string, lastHere: { sets: LastSet[] } | null, swapped: boolean): number | null {
  if (swapped) return null;
  const asked = (reps.match(/\d+/g) ?? []).map(Number);
  const top = asked.length ? Math.max(...asked) : Math.max(0, ...(lastHere?.sets ?? []).map((st) => st.reps ?? 0));
  return top > 0 ? top : null;
}

/** What a weight is checked against: the best last time, else the target (ExercisePage.tsx :125-127). */
export function refOf(lastHere: { sets: LastSet[] } | null, targetWeight: number | null, swapped: boolean): { refKg: number | null; refFrom: "last" | "target" } {
  const lastBestKg = swapped ? 0 : Math.max(0, ...(lastHere?.sets ?? []).map((st) => st.weight ?? 0));
  return { refKg: swapped ? null : lastBestKg > 0 ? lastBestKg : targetWeight, refFrom: lastBestKg > 0 ? "last" : "target" };
}

/**
 * A figure far off this exercise (27 Oct, Alex; ExercisePage.tsx :138-148): a weight over 40% (and 5 kg) above the
 * bar, reps over double the target's top. Lighter or fewer is never asked; a swap never; a figure said right
 * (`vouched`) not again this session. `todayKg` / `todayReps`: the most logged on the other sets today, which raise the bar.
 */
export function doubtCheck(
  v: Vals,
  todayKg: number,
  todayReps: number,
  ctx: { swapped: boolean; refKg: number | null; repTop: number | null },
  vouched: { weight: boolean; reps: boolean }
): { weight: boolean; reps: boolean } {
  if (ctx.swapped) return { weight: false, reps: false };
  const kgBar = Math.max(ctx.refKg ?? 0, todayKg);
  const repBar = Math.max(ctx.repTop ?? 0, todayReps);
  return {
    weight: !vouched.weight && v.weightKg != null && kgBar > 0 && v.weightKg > kgBar * 1.4 && v.weightKg - kgBar >= 5,
    reps: !vouched.reps && v.reps != null && repBar > 0 && v.reps > Math.max(repBar * 2, repBar + 8),
  };
}

/**
 * A set's plan (29 Oct, Alex; ExercisePage.tsx :193-204): the weight and reps this set was done at last time, met or
 * missed; a set with no last-time twin follows the latest set done before it this session, else the coach's figures.
 * Swapped, a naked sheet: the latest set done this session, else empty. On the sheet "done" is ticked (`isSaved` of a
 * logged set), never typed.
 */
export function planFor(
  n: number,
  o: { lastOf: (n: number) => LastSet | null; enteredOf: (n: number) => Vals; isSaved: (v: Vals) => boolean; planWeight: number | null; swapped: boolean; sets: number; repLow: number | null; targetRpe: number | null }
): Vals {
  const then = o.lastOf(n);
  let carried: Vals | null = null;
  for (let m = n - 1; m >= 1 && carried == null; m--) {
    const v = o.enteredOf(m);
    if (o.isSaved(v)) carried = v;
  }
  const weightKg = then?.weight ?? carried?.weightKg ?? o.planWeight;
  const reps = o.swapped ? (carried?.reps ?? null) : (then?.reps ?? (n > o.sets ? carried?.reps : null) ?? o.repLow);
  return { weightKg: weightKg ?? null, reps, rpe: then?.rpe ?? o.targetRpe };
}

/**
 * A plan's weight as shown (2 Nov; ExercisePage.tsx :605): one that was lifted shows as it was logged; only the coach's
 * own target is the clean lbs figure.
 */
export function planShownFigure(kg: number, o: { work: boolean; lastWeight: number | null | undefined; planWeight: number | null; unit: Unit }): number {
  return o.work && o.lastWeight == null && kg === o.planWeight ? planToDisplay(kg, o.unit) : kgToDisplay(kg, o.unit);
}

/**
 * Against last time (2 Nov, Alex; ExercisePage.tsx :622-631): a work set's weight and reps less the same set last time,
 * in the exercise's unit; nothing the same, nothing with no last time.
 */
export function deltaFor(v: Vals, then: LastSet | null, unit: Unit, askWeight: boolean): { weight: number | null; reps: number | null } {
  if (!then) return { weight: null, reps: null };
  const dw = askWeight && v.weightKg != null && then.weight != null ? Math.round((kgToDisplay(v.weightKg, unit) - kgToDisplay(then.weight, unit)) * 100) / 100 : null;
  const dr = v.reps != null && then.reps != null ? v.reps - then.reps : null;
  return { weight: dw ? dw : null, reps: dr ? dr : null };
}

/** An assisted lift reads the other way (more weight is more help): its weight going up is rust (ExercisePage.tsx :633-634). */
export const weightTone = (d: number, assisted: boolean): "up" | "down" => ((d > 0) !== assisted ? "up" : "down");

/** A warm-up from the server's (saved) or last time's (the plan) (ExercisePage.tsx :211-212). */
export type Warm = { key: string; plan: Vals; entered: Vals; saved: boolean; own?: boolean };
export function warmFrom(w: { weight: number | null; reps: number | null }, saved: boolean, key: string): Warm {
  return saved
    ? { key, plan: EMPTY, entered: { weightKg: w.weight, reps: w.reps, rpe: null }, saved: true }
    : { key, plan: { weightKg: w.weight, reps: w.reps, rpe: null }, entered: EMPTY, saved: false };
}

/**
 * The row's figures are a personal best (the server's personalBests rule, lib/repTarget.ts `isPbNow`): never on a swap
 * or a rogue session, never with no bar. The bar is the best on another row (another session) alone, as the server
 * counts it, so every set today that beats it is one; today's earlier sets never raise it.
 */
export function isPb(weightKg: number | null, reps: number | null, ex: SessionExercise, free: boolean): boolean {
  if (free || ex.swap || !ex.pbBar) return false;
  return isPbNow(weightKg, reps, ex.reps, ex.pbBar);
}
