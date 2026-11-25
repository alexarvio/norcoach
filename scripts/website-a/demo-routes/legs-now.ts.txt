import { NextResponse } from "next/server";
import { requireCoach } from "../../../lib/auth";
import { getData, persist } from "../../../lib/db";
import { logSet, startSession } from "../../../lib/queries";

// The website's demo (ironline-demo only): Emma half-way through today's Legs, for the workout picture.
export const dynamic = "force-dynamic";

export async function GET() {
  const coach = await requireCoach();
  const data = getData();
  const emma = data.clients.find((c) => c.coach_id === coach.id && c.name === "Emma Clarke")!;
  // This week: the programme's ninth (the demo is eight weeks in, lib/demoClient.ts TRAINED).
  const program = data.training_programs.find((p) => p.client_id === emma.id)!;
  const week = program.start_week + 8;
  const target = data.program_days.find((d) => d.client_id === emma.id && !d.free && d.week_number === week && d.label === "Legs");
  if (!target) return NextResponse.json({ error: "no Legs" }, { status: 404 });
  const started = new Date(Date.now() - 24 * 60_000).toISOString();
  startSession(target.id, started);
  const gym = data.client_gyms.find((g) => g.client_id === emma.id)?.id ?? null;
  target.gym_id = gym ?? undefined;
  const rows = data.workout_assignments.filter((a) => a.program_day_id === target.id).sort((a, b) => a.order_index - b.order_index);
  // The squat done, the Romanian deadlift two sets in.
  if (rows[0]) for (let n = 1; n <= rows[0].sets; n++) await logSet(rows[0].id, n, rows[0].target_weight_kg, Number(String(rows[0].reps).split("-")[0]) || 5, rows[0].rpe_target, gym);
  if (rows[1]) for (let n = 1; n <= 2; n++) await logSet(rows[1].id, n, rows[1].target_weight_kg, Number(String(rows[1].reps).split("-")[0]) || 8, rows[1].rpe_target, gym);
  persist();
  return NextResponse.json({ ok: true, day: target.id, week: target.week_number });
}
