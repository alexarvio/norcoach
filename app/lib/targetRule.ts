import { isAssisted } from "./progressRules";

// The weight goal that writes itself forward, in one place: the server that moves the weights (progressTargetFromLogs,
// queries.ts) and the Apply confirm that says what a copy will land as (applyPreviewData.ts) both read it, so the list
// and the button never disagree with what the server does.
//
// Each later row the client hasn't logged is worked out afresh (24 Nov, Alex: Flat Chest Press read 150 from week 7 on,
// though his best is 120 × 6 and Finlay never set it; docs/boards/target-rule-mockup.html): the coach's own figure,
// raised to the best set that still exists of the same lift (the exercise and its variation), in the same programme, in
// that row's own rep range, logged after the coach typed the weight (the least, on an assisted lift, whose kg is help).
// With no such set it is the coach's own figure again, so a set corrected, removed or discarded takes its raise with it
// (freshLane, setLane). Sets logged on a swapped row, or while a swap later undone was on it, are the substitute's and
// raise nothing (underSwap). A done week is never worked out again. Each gym is a lane of its own: the home gym's weight
// is target_weight_kg, another gym's its entry in gym_targets.
//
// A weight the coach sets while the client is logging the exercise is a reset point for its lane (23 Oct, Alex: "if I
// set a new one in week 4, I want that weight to override any count the system was taking into account from previous
// weights"). Lifts from before it never move a row after it (stopAfter); its number goes on to the rows after it
// (carryReset, queries.ts); from it on, what the client lifts moves them again.
//
// A weight moves up only on a set that is heavier and in the range (4 Nov, Alex: "it has to have a higher weight, but it
// also needs to be within the range"; 10 Nov, Alex: "keep it within rep range"): a set counts only when its reps sit
// inside the target reps (repWindow) of the row it would raise (24 Nov: the row's own, so 120 × 5 from a 4–6 day never
// raises a 10–12 one), so 70 kg × 8 and 70 kg × 15 against 10–12 move nothing, and a single figure is a goal to reach
// (12 or more against "12"). And the coach's own figure is kept beside a raised one (coach_kg, set at the first raise,
// cleared when the coach types the weight again or the raise goes), so the Apply confirm compares the coach's numbers
// alone (applyPreviewData.ts) and never reads the rule's raise as a change of theirs.

/** A gym lane: null is the home gym, a gym id that gym. */
export type Lane = number | null;

/**
 * `coach_kg`: the coach's own figure before the rule first raised this weight (null: none of theirs; on a gym, it
 * followed the home weight). Absent while the weight is the coach's own.
 */
type GymEntry = { kg: number | null; set_at?: string | null; pinned?: boolean; coach_kg?: number | null };
/** A row's weights, as stored. `coach_kg` as a gym entry's, for the home lane. */
export type Weights = { target_weight_kg: number | null; target_set_at?: string | null; target_pinned?: boolean; coach_kg?: number | null; gym_targets?: Record<string, GymEntry> };

/** The reps a set needs to count for the weight. `max` is Infinity when the target has no top. */
export type RepWindow = { min: number; max: number };

/**
 * The reps a set needs to count for the weight (4 Nov and 10 Nov, Alex): "10-12" and "10–12" 10 to 12, "8-10/side" 8
 * to 10, "3x8-10" 8 to 10. A single figure is a goal to reach, no top: "12" and "12+" 12 or more, "3x10" 10 or more.
 * Null asks nothing: AMRAP, empty, no number, or a time ("30s", "1 min", "0:45"), whose reps aren't reps.
 */
export function repWindow(reps: string | null | undefined): RepWindow | null {
  const t = (reps ?? "").trim();
  if (!t || /:\d|\d\s*(?:s|secs?|seconds?|m|mins?|minutes?)\b/i.test(t)) return null;
  // "3x10" is sets by reps: the reps.
  const rest = t.replace(/^\d+\s*[x×]\s*(?=\d)/i, "");
  const range = /(\d+)\s*(?:-|–|—|to)\s*(\d+)/i.exec(rest);
  const first = range ? Number(range[1]) : Number(/(\d+)/.exec(rest)?.[1] ?? 0);
  if (!(first > 0)) return null;
  const top = range ? Number(range[2]) : 0;
  return { min: first, max: top >= first ? top : Infinity };
}

/** The coach's own figure in a lane: the one kept beside a raise, else the lane's weight as it is. */
export function coachKg(row: Weights, lane: Lane): number | null {
  if (lane == null) return row.coach_kg !== undefined ? row.coach_kg : row.target_weight_kg;
  const e = row.gym_targets?.[lane];
  return e ? (e.coach_kg !== undefined ? e.coach_kg : e.kg) : null;
}
/** Where a row sits in the plan: its week and its session. */
export type Slot = { week_number: number; day_of_week: number };
/** A row of the exercise where it sits: every planned one, logged or not. */
export type Occurrence = { slot: Slot; row: Weights };
/** A set as the rule reads it: its weight, reps, when it went in, and the gym lane it went in. */
export type RuleSet = { weight_kg: number | null; reps?: number | null; logged_at: string; lane: Lane };
/**
 * A logged row that can raise later ones: where it sits, its weights (for a reset on it), the programme whose weeks hold
 * it, the variation done and its own reps (the range a later row with none of its own reads). `sets` leaves out those
 * logged under a swap (underSwap).
 */
export type Source = { slot: Slot; row: Weights; program: number | null; variation: number | null; reps?: string | null; sets: RuleSet[] };
/** A later row the client hasn't logged, as the rule works it out: its range is its own reps. */
export type Dest = { slot: Slot; row: Weights; program: number | null; variation: number | null; reps: string | null | undefined };

/**
 * The set went in while a swap was on the row, and the swap is since taken back (24 Nov, Alex: Smith machine sets raised
 * the chest press once the swap was undone). Marked on the set as the server takes it (`swap_set_ids`, logSet in
 * queries.ts), never by a window of time: a set kept offline arrives with the phone's clock and the swap with the
 * server's, so a window let sets through either side of it.
 */
export function swapSet(row: { swap_set_ids?: number[] }, setId: number): boolean {
  return !!row.swap_set_ids?.includes(setId);
}

/**
 * A set that is the substitute's, not the prescribed lift's: every set on a row swapped now (14 Oct), and one logged
 * while a swap later undone was on it (24 Nov, swapSet). The weight rule, last time and personal bests all leave them out.
 */
export function underSwap(row: { swap?: { at: string } | null; swap_set_ids?: number[] }, setId: number): boolean {
  return !!row.swap || swapSet(row, setId);
}

/** "YYYY-MM-DD HH:MM:SS" is server-local time (localStamp), anything else an ISO instant. As queries' stampMs. */
export function stampMs(at: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(at);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : new Date(at).getTime();
}

/** `a` comes after `b` in the plan: a later week, or a later session of the same week. */
export const laterSlot = (a: Slot, b: Slot) => a.week_number > b.week_number || (a.week_number === b.week_number && a.day_of_week > b.day_of_week);

/** The lane a set went in: no gym, or the home gym, is the home lane. */
export const laneOfGym = (gymId: number | null | undefined, home: number | null): Lane => (gymId == null || gymId === home ? null : gymId);

/** An assisted lift (23 Oct, Alex): the exercise or the variation asked for says so. */
export function assistedRow(ex: { name: string; variations?: { id: number; name: string }[] } | undefined, variationId: number | null | undefined): boolean {
  return isAssisted(ex?.name) || (variationId != null && isAssisted(ex?.variations?.find((v) => v.id === variationId)?.name));
}

/** The lane's own weight (a gym with none follows the home gym's). */
export const laneKg = (row: Weights, lane: Lane): number | null => (lane == null ? row.target_weight_kg : row.gym_targets?.[lane]?.kg ?? null);

/** When the coach typed the lane's weight, or a reset was carried to it. */
export const laneTypedAt = (row: Weights, lane: Lane): string | null => (lane == null ? row.target_set_at : row.gym_targets?.[lane]?.set_at) ?? null;

/** The coach set the lane's weight while the client was logging the exercise: a reset point. */
export const isReset = (row: Weights, lane: Lane): boolean => (lane == null ? !!row.target_pinned : !!row.gym_targets?.[lane]?.pinned);

/**
 * The sets of a logged row that count in a lane: on a reset, only those logged from the coach's weight on. What was
 * lifted on that row before it is what the reset overrides.
 */
export function setsSinceReset<S extends { logged_at: string }>(sets: S[], row: Weights, lane: Lane): S[] {
  const typed = isReset(row, lane) ? laneTypedAt(row, lane) : null;
  if (!typed) return sets;
  const from = stampMs(typed);
  return sets.filter((s) => stampMs(s.logged_at) >= from);
}

/**
 * Where lifts from `from` stop in a lane: the first reset of the coach's after it. Null: nothing stops them. A weight
 * the coach cleared is no reset: it has no number to go on, so the lifts before it still pass.
 */
export function stopAfter(from: Slot, rows: Occurrence[], lane: Lane): Slot | null {
  let stop: Slot | null = null;
  for (const o of rows) {
    if (laterSlot(o.slot, from) && isReset(o.row, lane) && laneKg(o.row, lane) != null && (!stop || laterSlot(stop, o.slot))) stop = o.slot;
  }
  return stop;
}

/** A lift stopped at `stop` still reaches `slot`: it comes before the stop. */
export const beforeStop = (slot: Slot, stop: Slot | null) => !stop || laterSlot(stop, slot);

/**
 * Where each source's lifts stop in a lane (stopAfter), worked out once for every row the rule visits: a pass changes no
 * reset and no reset's weight, so they hold while it runs.
 */
export function stopsOf(rows: Occurrence[]): (src: Source, lane: Lane) => Slot | null {
  const memo = new Map<Source, Map<Lane, Slot | null>>();
  return (src, lane) => {
    let byLane = memo.get(src);
    if (!byLane) memo.set(src, (byLane = new Map()));
    if (!byLane.has(lane)) byLane.set(lane, stopAfter(src.slot, rows, lane));
    return byLane.get(lane) ?? null;
  };
}

/**
 * A later, unlogged row's lane worked out afresh (24 Nov, Alex; docs/boards/target-rule-mockup.html): the heaviest set
 * that raises it (the least help, on an assisted lift), or null when none does and the lane is the coach's own figure
 * again. Undefined when the lane stays as it is: a reset, or, on another gym's lane, a row whose home weight is a reset
 * and the gym has a weight of its own (as it held before gyms had resets of their own).
 *
 * A set raises it when it is of an earlier row (`rows` holds the plan's rows, for the coach's resets between: stopAfter)
 * of the same lift (the exercise and the variation, null equal to null, as last time reads it) in the same programme,
 * went in that lane after the reset on its own row (setsSinceReset) and after the coach typed this lane's weight, has its
 * reps inside this row's range (repWindow; a row with none reads the logged row's, and with neither no set counts) and
 * is heavier than the coach's own figure here (coachKg). A lane with no figure of the coach's has nothing to beat and
 * takes what was lifted there (a gym with none of its own; a home row the coach left blank only once the rule filled it
 * before, coach_kg null beside it, 24 Nov review), blank again once no such set is left.
 */
export function freshLane(dest: Dest, lane: Lane, sources: Source[], rows: Occurrence[], assisted: boolean, stopOf: (src: Source, lane: Lane) => Slot | null = stopsOf(rows)): number | null | undefined {
  const row = dest.row;
  if (isReset(row, lane)) return undefined;
  if (lane != null && row.target_pinned && laneKg(row, lane) != null) return undefined;
  // A home weight the coach left blank stays blank (24 Nov, review): the rule filled one only where a raise reached it
  // before, and those carry coach_kg null beside the figure. Such a row goes on following the best set, and is blank
  // again once none is left; a blank row the rule never filled is the coach's to fill.
  if (lane == null && row.target_weight_kg == null && row.coach_kg === undefined) return undefined;
  let best: number | null = null;
  for (const { set } of raisingSets(dest, lane, sources, assisted, stopOf)) {
    const w = set.weight_kg!;
    if (best == null || (assisted ? w < best : w > best)) best = w;
  }
  return best;
}

/** Every set that raises a lane by freshLane's test, with the row it went in on. freshLane's own checks come first. */
function* raisingSets(dest: Dest, lane: Lane, sources: Source[], assisted: boolean, stopOf: (src: Source, lane: Lane) => Slot | null): Generator<{ src: Source; set: RuleSet }> {
  const own = coachKg(dest.row, lane);
  const typed = laneTypedAt(dest.row, lane);
  const typedMs = typed ? stampMs(typed) : NaN;
  const ownRange = repWindow(dest.reps);
  for (const src of sources) {
    if (!laterSlot(dest.slot, src.slot) || src.program !== dest.program || src.variation !== dest.variation) continue;
    if (!beforeStop(dest.slot, stopOf(src, lane))) continue;
    // A row with no range of its own (AMRAP, a time, none typed) reads the logged row's (24 Nov); with neither, a set
    // sits inside no range, so it raises nothing.
    const range = ownRange ?? repWindow(src.reps);
    if (!range) continue;
    for (const s of setsSinceReset(src.sets.filter((x) => x.lane === lane), src.row, lane)) {
      const w = s.weight_kg;
      if (w == null) continue;
      if (s.reps == null || s.reps < range.min || s.reps > range.max) continue;
      // Nothing to beat is no reason to take a set of no weight as the figure.
      if (own == null && !(w > 0)) continue;
      // Strictly after (4 Nov): a set in the same second the coach typed the weight is no lift that came after it.
      if (Number.isFinite(typedMs) && !(stampMs(s.logged_at) > typedMs)) continue;
      if (own != null && !(assisted ? w < own : w > own)) continue;
      yield { src, set: s };
    }
  }
}

/**
 * The set behind a raised weight (24 Nov, Alex: the green arrow's "Up from 115: Alex did 120 × 6 in week 5"): of the sets
 * that raise the lane by freshLane's own test, one at exactly `kg`, the most reps, then the latest. Null when none is,
 * so a figure the rule can't account for never claims a reason.
 */
export function raisedBy(dest: Dest, lane: Lane, kg: number, sources: Source[], rows: Occurrence[], assisted: boolean): { src: Source; set: RuleSet } | null {
  if (isReset(dest.row, lane)) return null;
  let pick: { src: Source; set: RuleSet } | null = null;
  for (const x of raisingSets(dest, lane, sources, assisted, stopsOf(rows))) {
    if (x.set.weight_kg !== kg) continue;
    const reps = x.set.reps ?? 0;
    const had = pick?.set.reps ?? 0;
    if (!pick || reps > had || (reps === had && stampMs(x.set.logged_at) > stampMs(pick.set.logged_at))) pick = x;
  }
  return pick;
}

/** The lanes worth working out on a row: the home gym, every gym with a weight on it, every gym a set went in. */
export function lanesOf(row: Weights, sources: Source[]): Lane[] {
  const out: Lane[] = [null];
  const add = (lane: Lane) => {
    if (!out.includes(lane)) out.push(lane);
  };
  for (const gym of Object.keys(row.gym_targets ?? {})) add(Number(gym));
  for (const src of sources) for (const s of src.sets) add(s.lane);
  return out;
}

/**
 * Writes what freshLane worked out: a raise keeps the coach's own figure beside it (coach_kg, 4 Nov, Alex; set at the
 * first raise, never by a later one), and no raise puts that figure back and drops it (24 Nov). When it was typed and
 * whether it is a reset stay as they were. A gym's entry the rule made (the gym had no weight of its own) goes again.
 * True when the row changed, so a pass that finds the rows as it left them persists nothing.
 */
export function setLane(row: Weights, lane: Lane, best: number | null): boolean {
  if (lane == null) {
    if (best != null) {
      if (row.target_weight_kg === best) return false;
      if (row.coach_kg === undefined) row.coach_kg = row.target_weight_kg;
      row.target_weight_kg = best;
      return true;
    }
    if (row.coach_kg === undefined) return false;
    row.target_weight_kg = row.coach_kg;
    delete row.coach_kg;
    return true;
  }
  const entry = row.gym_targets?.[lane];
  if (best != null) {
    if (entry && entry.kg === best) return false;
    const coach = entry ? (entry.coach_kg !== undefined ? entry.coach_kg : entry.kg) : null;
    row.gym_targets = { ...(row.gym_targets ?? {}), [lane]: { ...entry, kg: best, set_at: entry?.set_at ?? null, coach_kg: coach } };
    return true;
  }
  if (!entry || entry.coach_kg === undefined) return false;
  const next = { ...(row.gym_targets ?? {}) };
  if (entry.coach_kg === null && !entry.pinned && !entry.set_at) delete next[lane];
  else {
    const kept: GymEntry = { ...entry, kg: entry.coach_kg };
    delete kept.coach_kg;
    next[lane] = kept;
  }
  if (Object.keys(next).length) row.gym_targets = next;
  else delete row.gym_targets;
  return true;
}

/**
 * A row's weights once `gymId` is the home gym instead of `oldHome` (setHomeGym, queries.ts): the old home's weight,
 * when it was typed, its reset and the coach's own figure beside a raise go to its gym entry, and the new home's come
 * into target_weight_kg. A new home with no weight of its own that was trained at on this row (`firstVisitBest`, the
 * heaviest set there) takes what was lifted there, or the week would read as short of the old home's figure, and takes
 * it as the coach's own (24 Nov: no coach_kg beside it, so the next pass only raises above it and never puts the old
 * home's figure back).
 */
export function moveHome(row: Weights, oldHome: number, gymId: number, firstVisitBest: number | null): void {
  const targets = { ...(row.gym_targets ?? {}) };
  const incoming = targets[gymId];
  // The coach's own figure beside a raised weight goes with its gym's weight too (coach_kg, 4 Nov). A reset goes with
  // its gym's weight.
  targets[oldHome] = {
    kg: row.target_weight_kg,
    set_at: row.target_set_at ?? null,
    ...(row.target_pinned ? { pinned: true } : {}),
    ...(row.coach_kg !== undefined ? { coach_kg: row.coach_kg } : {}),
  };
  if (row.target_pinned || incoming?.pinned) row.target_pinned = !!incoming?.pinned && incoming.kg != null;
  if (incoming?.kg != null) {
    row.target_weight_kg = incoming.kg;
    row.target_set_at = incoming.set_at ?? null;
    // A gym weight the rule made (coach_kg null: the gym had none of its own) comes in as the rule's, coach_kg null, so
    // it goes on following the sets there (24 Nov, review): never the old home's figure as the coach's, which the next
    // pass would put back over what was lifted.
    if (incoming.coach_kg !== undefined) row.coach_kg = incoming.coach_kg;
    else delete row.coach_kg;
  } else if (row.target_weight_kg != null && firstVisitBest != null) {
    row.target_weight_kg = firstVisitBest;
    row.target_set_at = null;
    delete row.coach_kg;
  }
  delete targets[gymId];
  row.gym_targets = targets;
}

/**
 * A row as a copy lands (Apply to the rest, a session copied on): the coach's weights and when they were typed, never
 * the reset itself. The reset stays the one row the coach typed on, so the copies after it move with the client's
 * lifts from it on, as the rows its number was carried to do. The coach's own figure beside a raised one goes with it
 * (coach_kg, 4 Nov).
 */
export function copiedWeights<T extends Weights>(row: T): T {
  const gyms =
    row.gym_targets &&
    Object.fromEntries(Object.entries(row.gym_targets).map(([gym, e]) => [gym, { kg: e.kg, set_at: e.set_at ?? null, ...(e.coach_kg !== undefined ? { coach_kg: e.coach_kg } : {}) }]));
  return { ...row, target_pinned: undefined, gym_targets: gyms };
}
