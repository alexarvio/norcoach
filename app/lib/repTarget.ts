// A rep target and the personal-best bar, pure and client-safe: the server's personalBests (homeBoardData.ts) and the
// workout sheet's PB ring on the phone (15 Nov, Alex) read one rule from here.

import { liftedKg } from "./progressRules";

/** The reps a target asks for: "8-10" → 8 to 10, "10+" or "12" → that many or more; nothing to read (AMRAP, a time): null. */
export function repTarget(reps: string | null | undefined): { lo: number; hi: number } | null {
  const s = (reps ?? "").trim();
  const range = /^(\d+)\s*(?:-|–|—|to)\s*(\d+)$/i.exec(s);
  if (range) {
    const [a, b] = [Number(range[1]), Number(range[2])];
    return a > 0 && b >= a ? { lo: a, hi: b } : null;
  }
  const one = /^(\d+)\s*\+?$/.exec(s);
  return one && Number(one[1]) > 0 ? { lo: Number(one[1]), hi: Infinity } : null;
}

/** Reps inside a target (repTarget): from its low to its high, both counted. */
export const insideTarget = (reps: number, t: { lo: number; hi: number }) => reps >= t.lo && reps <= t.hi;

/**
 * What a set has to beat to be a personal best (trainingBests in homeBoardData.ts): the heaviest earlier set of the
 * lift inside its rep target in another session, as lifted kg (an assisted lift's body weight less the help), and for
 * an assisted lift the body weight to weigh today's help by.
 */
export type PbBar = { kg: number; assisted: boolean; bodyKg: number | null };

/**
 * A row's figures are a personal best (the server's personalBests rule): the reps inside the exercise's rep target and
 * the weight, as lifted, strictly heavier than the bar. False with no bar (a first time, a rogue session, a swap, no
 * rep target), or figures missing.
 */
export function isPbNow(weightKg: number | null | undefined, reps: number | null | undefined, targetReps: string | null | undefined, bar: PbBar | null | undefined): boolean {
  if (!bar || weightKg == null || !Number.isFinite(weightKg) || reps == null || !(reps > 0)) return false;
  const t = repTarget(targetReps);
  if (!t || !insideTarget(reps, t)) return false;
  const lifted = liftedKg(weightKg, bar.assisted, bar.bodyKg);
  return lifted != null && lifted > 0 && lifted > bar.kg;
}
