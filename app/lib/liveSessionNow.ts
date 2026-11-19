import { getData } from "./db";
import { dayGymId, getAssignmentsForDay, getExerciseUnit, homeGymId, isRogue, listClientGyms, liveSessionFor, targetAtGym } from "./queries";
import { stampMs } from "./targetRule";
import { setsDue } from "./setsDue";
import { coachBrand } from "./brandMark";
import type { LiveExercise, LiveNow } from "./liveActivity";

/** The client's session going, as the lock-screen pill shows it (19 Nov, Alex): its name as the resume pill's, its start,
    its gym as the session's row draws it (a rogue session with none picked, none) and its logged sets. Since C (19 Nov,
    Alex: docs/boards/live-activity-mockup.html) its exercises too, for the set next, and the coach's name and colour,
    only while the coach has a brand colour. */
export function liveNowFor(clientId: number): LiveNow {
  const gyms: Record<string, string> = {};
  const allGyms = listClientGyms(clientId, true);
  for (const g of allGyms) gyms[g.id] = g.name;
  const data = getData();
  const coachId = data.clients.find((c) => c.id === clientId)?.coach_id ?? null;
  const brand = coachId == null ? {} : coachBrand(coachId);
  const look = { coach: brand.color ? brand.businessName ?? null : null, brand: brand.color ?? null };
  const live = liveSessionFor(clientId);
  const day = live ? data.program_days.find((pd) => pd.id === live.id) : undefined;
  const startedMs = live ? stampMs(live.startedAt) : NaN;
  if (!live || !day || !Number.isFinite(startedMs)) return { session: null, gyms, ...look };
  const ids = new Set(data.workout_assignments.filter((wa) => wa.program_day_id === day.id).map((wa) => wa.id));
  const sets = data.set_logs.filter((sl) => ids.has(sl.workout_assignment_id)).map((sl) => `${sl.workout_assignment_id}:${sl.set_number}`);
  const rogue = isRogue(day);
  const gymId = rogue && day.gym_id == null ? null : dayGymId(day.id);
  const home = homeGymId(clientId);
  const exercises: LiveExercise[] = getAssignmentsForDay(day.id).map((a) => {
    const lib = a.swap?.library_exercise_id;
    const swap = a.swap ? (lib != null ? data.exercises.find((e) => e.id === lib)?.name : null) ?? a.swap.custom_name ?? "Another exercise" : null;
    const logs = new Map<number, number>();
    for (const sl of data.set_logs) if (sl.workout_assignment_id === a.id) logs.set(sl.set_number, Math.max(logs.get(sl.set_number) ?? 0, stampMs(sl.logged_at) || 0));
    return {
      id: a.id,
      name: a.exercise_name ?? "Exercise",
      swap,
      sets: setsDue(a),
      coachSets: a.sets,
      // A rogue session has no plan (19 Nov, Alex: C: no target there).
      reps: rogue ? "" : (a.reps ?? "").trim(),
      kg: rogue ? null : targetAtGym(a, gymId, home),
      kgAt: rogue ? {} : Object.fromEntries(allGyms.map((g) => [g.id, targetAtGym(a, g.id, home)])),
      unit: getExerciseUnit(a.id),
      logs: [...logs].map(([n, at]) => ({ n, at })),
    };
  });
  return { session: { id: live.id, label: live.label, startedMs, gymId, sets: [...new Set(sets)], rogue, exercises }, gyms, ...look };
}
