// The weight rule worked out afresh (24 Nov, Alex: docs/boards/target-rule-mockup.html), on plain rows: no store, no
// server. Run: npx tsx scripts/check-target-rule.ts. Exits 1 on the first case that comes out wrong.
import { freshLane, lanesOf, moveHome, setLane, underSwap, type Dest, type Lane, type Occurrence, type RuleSet, type Source, type Weights } from "../app/lib/targetRule";

type Row = Weights & { reps: string; variation_id?: number | null; swap?: { at: string }; swap_set_ids?: number[] };
type LoggedSet = RuleSet & { id: number };

const TYPED = "2026-09-01T08:00:00.000Z";
let at = Date.parse("2026-09-07T08:00:00.000Z");
let ids = 0;
const later = () => new Date((at += 3600_000)).toISOString();
const set = (weight_kg: number, reps: number, lane: Lane = null, logged_at = later()): LoggedSet => ({ id: ++ids, weight_kg, reps, logged_at, lane });
const row = (kg: number | null, reps = "4-6", extra: Partial<Row> = {}): Row => ({ target_weight_kg: kg, target_set_at: TYPED, reps, ...extra });

/** Works the weeks after `sources` out as the server's pass does (progressExercise), and gives the home weights back. */
function work(dests: { week: number; row: Row; program?: number }[], sources: { week: number; row: Row; sets: LoggedSet[]; program?: number }[], assisted = false): (number | null)[] {
  const srcs: Source[] = sources.map((s) => ({
    slot: { week_number: s.week, day_of_week: 1 },
    row: s.row,
    program: s.program ?? 1,
    variation: s.row.variation_id ?? null,
    reps: s.row.reps,
    sets: s.row.swap ? [] : s.sets.filter((x) => !underSwap(s.row, x.id)),
  }));
  const rows: Occurrence[] = [...sources.map((s) => ({ slot: { week_number: s.week, day_of_week: 1 }, row: s.row })), ...dests.map((d) => ({ slot: { week_number: d.week, day_of_week: 1 }, row: d.row }))];
  for (const d of dests) {
    const dest: Dest = { slot: { week_number: d.week, day_of_week: 1 }, row: d.row, program: d.program ?? 1, variation: d.row.variation_id ?? null, reps: d.row.reps };
    for (const lane of lanesOf(d.row, srcs)) {
      const best = freshLane(dest, lane, srcs, rows, assisted);
      if (best !== undefined) setLane(d.row, lane, best);
    }
  }
  return dests.map((d) => d.row.target_weight_kg);
}

let failed = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(got)}${ok ? "" : ` (wanted ${JSON.stringify(want)})`}`);
  if (!ok) failed++;
}

// 1. A real heavier set inside the range raises the weeks after; the coach's own figure is kept beside it.
{
  const w8 = row(90);
  const got = work([{ week: 8, row: w8 }], [{ week: 5, row: row(115), sets: [set(120, 6)] }]);
  check("120 × 6 inside 4–6 raises 90 to 120", got, [120]);
  check("the coach's 90 is kept beside it", w8.coach_kg, 90);
}

// 2. A 150 set corrected to 120: worked out again, the raise goes back to what the sets still back.
{
  const w8 = row(90);
  const w5 = row(115);
  const typo = set(150, 6);
  work([{ week: 8, row: w8 }], [{ week: 5, row: w5, sets: [typo] }]);
  check("a 150 × 6 raises it to 150", w8.target_weight_kg, 150);
  typo.weight_kg = 120;
  const got = work([{ week: 8, row: w8 }], [{ week: 5, row: w5, sets: [typo] }]);
  check("corrected to 120, it reads 120", got, [120]);
  check("worked out again, nothing changes", work([{ week: 8, row: w8 }], [{ week: 5, row: w5, sets: [typo] }]), [120]);
  const gone = work([{ week: 8, row: w8 }], []);
  check("the set removed, it is the coach's 90 again", gone, [90]);
  check("and coach_kg goes", w8.coach_kg, undefined);
}

// 3. Another variation of the exercise never raises it.
{
  const got = work([{ week: 8, row: row(90, "4-6", { variation_id: 2 }) }], [{ week: 5, row: row(115, "4-6", { variation_id: 3 }), sets: [set(120, 6)] }]);
  check("another variation's 120 × 6 raises nothing", got, [90]);
  const same = work([{ week: 8, row: row(90, "4-6", { variation_id: null }) }], [{ week: 5, row: row(115, "4-6", { variation_id: null }), sets: [set(120, 6)] }]);
  check("no variation on either is the same lift", same, [120]);
}

// 4. A set inside 4–6 doesn't raise a 10–12 row: the range is the raised row's own.
{
  const got = work([{ week: 8, row: row(90, "10-12") }], [{ week: 5, row: row(115, "4-6"), sets: [set(120, 5)] }]);
  check("120 × 5 doesn't raise a 10–12 row", got, [90]);
  const inside = work([{ week: 8, row: row(90, "10-12") }], [{ week: 5, row: row(115, "4-6"), sets: [set(100, 11)] }]);
  check("100 × 11 does", inside, [100]);
  const single = work([{ week: 8, row: row(90, "12") }], [{ week: 5, row: row(90, "12"), sets: [set(95, 14)] }]);
  check("a single figure is that many or more: 95 × 14 against 12", single, [95]);
}

// 5. A swap's sets raise nothing: on a row swapped now, and those logged while a swap since undone was on it.
{
  const swapped = work([{ week: 8, row: row(90) }], [{ week: 5, row: row(115, "4-6", { swap: { at: TYPED } }), sets: [set(140, 6)] }]);
  check("a swapped row's 140 × 6 raises nothing", swapped, [90]);
  // Logged while the swap was on, so marked by the server as it took the set (logSet, swap_set_ids), whatever its stamp:
  // here the phone's clock, offline, put it before the coach even typed the weight's week.
  const smith = set(140, 6, null, "2026-09-07T06:00:00.000Z");
  const after = set(110, 6);
  const undone = work([{ week: 8, row: row(90) }], [{ week: 5, row: row(115, "4-6", { swap_set_ids: [smith.id] }), sets: [smith, after] }]);
  check("swap undone: the Smith 140 × 6 stays the substitute's, the 110 × 6 after counts", undone, [110]);
  const offlineLate = set(150, 6, null, "2027-03-01T00:00:00.000Z");
  check("an outbox set stamped long after the undo is still the substitute's", work([{ week: 8, row: row(90) }], [{ week: 5, row: row(115, "4-6", { swap_set_ids: [offlineLate.id] }), sets: [offlineLate, after] }]), [110]);
}

// 6. A home row the coach left blank stays blank (24 Nov, review): only one the rule filled before (coach_kg null beside
// it) follows the best set inside its range, and is blank again once none is left.
{
  const blanks = [row(null, "10-12"), row(null, "10-12"), row(null, "10-12")];
  const got = work(blanks.map((r, i) => ({ week: 6 + i, row: r })), [{ week: 5, row: row(null, "10-12"), sets: [set(60, 10)] }]);
  check("every row blank, 60 × 10 logged: the later rows stay blank", got, [null, null, null]);
  check("and carry no coach_kg", blanks.map((r) => "coach_kg" in r), [false, false, false]);
  const filled = row(75, "4-6", { coach_kg: null });
  check("a row the rule filled (coach_kg null) follows the best set, 80 × 5", work([{ week: 8, row: filled }], [{ week: 5, row: row(75), sets: [set(80, 5), set(78, 5)] }]), [80]);
  check("with coach_kg null beside it", filled.coach_kg, null);
  check("the set gone, blank again", work([{ week: 8, row: filled }], []), [null]);
  check("and coach_kg goes", filled.coach_kg, undefined);
  check("then a set no longer fills it", work([{ week: 8, row: filled }], [{ week: 5, row: row(75), sets: [set(80, 5)] }]), [null]);
  check("a filled row takes no set outside the range", work([{ week: 8, row: row(75, "4-6", { coach_kg: null }) }], [{ week: 5, row: row(75), sets: [set(80, 9)] }]), [null]);
  check("nor a set of no weight", work([{ week: 8, row: row(75, "4-6", { coach_kg: null }) }], [{ week: 5, row: row(null), sets: [set(0, 5)] }]), [null]);
}

// 7. A row with no range of its own reads the logged row's; with neither, nothing raises it (24 Nov).
{
  check("an AMRAP row is raised by a set inside the logged row's 4–6", work([{ week: 8, row: row(90, "AMRAP") }], [{ week: 5, row: row(115, "4-6"), sets: [set(120, 6)] }]), [120]);
  check("but not by one outside it", work([{ week: 8, row: row(90, "AMRAP") }], [{ week: 5, row: row(115, "4-6"), sets: [set(120, 9)] }]), [90]);
  check("with no range on either, nothing raises it", work([{ week: 8, row: row(90, "AMRAP") }], [{ week: 5, row: row(115, "AMRAP"), sets: [set(120, 9)] }]), [90]);
}

// 8. A new home gym's first visit there is its figure as the coach's own (24 Nov, setHomeGym's moveHome): the next pass
// only raises above it, never puts the old home's figure back.
{
  const w5 = row(100);
  moveHome(w5, 3, 7, 90);
  check("the new home takes what was lifted there", w5.target_weight_kg, 90);
  check("as the coach's own: no coach_kg", w5.coach_kg, undefined);
  check("the old home keeps its figure on its gym entry", w5.gym_targets?.["3"]?.kg, 100);
  check("a pass with nothing heavier leaves it at 90", work([{ week: 5, row: w5 }], []), [90]);
  check("a heavier set after it raises it", work([{ week: 5, row: w5 }], [{ week: 4, row: row(90), sets: [set(95, 5)] }]), [95]);
  check("taken away, it is 90 again, not the old home's 100", work([{ week: 5, row: w5 }], []), [90]);
  const typed = row(100, "4-6", { gym_targets: { "7": { kg: 85, set_at: TYPED } } });
  moveHome(typed, 3, 7, 90);
  check("a new home with a weight of its own keeps it", typed.target_weight_kg, 85);

  // The gym's weight the rule made from sets there (coach_kg null) comes in as the rule's, never the old home's figure
  // as the coach's (24 Nov, review): an unlogged later row, sets at the gym at 80, the old home 100.
  const atGym = row(100, "4-6", { gym_targets: { "7": { kg: 80, set_at: null, coach_kg: null } } });
  moveHome(atGym, 3, 7, null);
  check("Make home: the row takes the gym's 80", atGym.target_weight_kg, 80);
  check("as the rule's: coach_kg null", atGym.coach_kg, null);
  // After the switch the sets at the gym are home sets (laneOfGym with the new home).
  check("a pass leaves it at 80, not the old home's 100", work([{ week: 8, row: atGym }], [{ week: 5, row: row(100), sets: [set(80, 5)] }]), [80]);
  check("the old home keeps its 100 on its gym entry", atGym.gym_targets?.["3"]?.kg, 100);
}

// 9. What else holds as before.
{
  const typedLater = row(90, "4-6", { target_set_at: "2027-01-01T00:00:00.000Z" });
  check("a set before the coach typed the weight raises nothing", work([{ week: 8, row: typedLater }], [{ week: 5, row: row(115), sets: [set(120, 6)] }]), [90]);
  check("a set of another programme raises nothing", work([{ week: 8, row: row(90), program: 2 }], [{ week: 5, row: row(115), sets: [set(120, 6)], program: 1 }]), [90]);
  check("a lighter set raises nothing", work([{ week: 8, row: row(90) }], [{ week: 5, row: row(115), sets: [set(85, 6)] }]), [90]);
  check("the best of several sets", work([{ week: 8, row: row(90) }], [{ week: 4, row: row(110), sets: [set(115, 6)] }, { week: 5, row: row(115), sets: [set(120, 6), set(100, 6)] }]), [120]);
  check("an assisted lift: the least help", work([{ week: 8, row: row(40) }], [{ week: 5, row: row(40), sets: [set(30, 6), set(35, 5)] }], true), [30]);
  const pinned = row(90, "4-6", { target_pinned: true });
  check("a reset of the coach's stays", work([{ week: 8, row: pinned }], [{ week: 5, row: row(115), sets: [set(120, 6)] }]), [90]);
  const reset = row(100, "4-6", { target_pinned: true });
  const afterReset = row(100);
  work([{ week: 6, row: reset }, { week: 8, row: afterReset }], [{ week: 5, row: row(115), sets: [set(120, 6)] }]);
  check("a lift before a reset stops at it", afterReset.target_weight_kg, 100);
}

// 10. A gym's lane: what was lifted there, and back to following home when nothing backs it.
{
  const w8 = row(90);
  work([{ week: 8, row: w8 }], [{ week: 5, row: row(115), sets: [set(80, 6, 7)] }]);
  check("a gym with no weight takes what was lifted there", w8.gym_targets?.["7"]?.kg, 80);
  check("the home weight stays", w8.target_weight_kg, 90);
  work([{ week: 8, row: w8 }], []);
  check("the set gone, the gym follows home again", w8.gym_targets, undefined);
}

console.log(failed ? `\n${failed} wrong` : "\nall right");
process.exit(failed ? 1 : 0);
