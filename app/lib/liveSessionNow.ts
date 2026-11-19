import { getData } from "./db";
import { dayGymId, isRogue, listClientGyms, liveSessionFor } from "./queries";
import { stampMs } from "./targetRule";
import type { LiveNow } from "./liveActivity";

/** The client's session going, as the lock-screen pill shows it (19 Nov, Alex): its name as the resume pill's, its start,
    its gym as the session's row draws it (a rogue session with none picked, none) and its logged sets. */
export function liveNowFor(clientId: number): LiveNow {
  const gyms: Record<string, string> = {};
  for (const g of listClientGyms(clientId, true)) gyms[g.id] = g.name;
  const live = liveSessionFor(clientId);
  const data = getData();
  const day = live ? data.program_days.find((pd) => pd.id === live.id) : undefined;
  const startedMs = live ? stampMs(live.startedAt) : NaN;
  if (!live || !day || !Number.isFinite(startedMs)) return { session: null, gyms };
  const ids = new Set(data.workout_assignments.filter((wa) => wa.program_day_id === day.id).map((wa) => wa.id));
  const sets = data.set_logs.filter((sl) => ids.has(sl.workout_assignment_id)).map((sl) => `${sl.workout_assignment_id}:${sl.set_number}`);
  const gymId = isRogue(day) && day.gym_id == null ? null : dayGymId(day.id);
  return { session: { id: live.id, label: live.label, startedMs, gymId, sets: [...new Set(sets)] }, gyms };
}
