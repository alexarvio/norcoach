// A lived-in client, built from nothing: a 12-week programme eight weeks
// in with the sets logged, two gyms, a lifestyle phase whose check-ins hold
// two weeks of readings, a nutrition phase with targets, supplements and a
// few days of meals in the food diary, a trip on the Plan, a few messages
// from the coach and meetings (one done with a recap, one coming up). Used
// by the dev seed (to look at the coach screens with something on them), by
// the App Review account (a login Apple's reviewers can try every screen
// with) and, with `example`, for the example client every new coach finds
// (25 Nov, Alex: docs/boards/coach-onboarding-mockup.html; lib/exampleClient.ts).
//
// Rebuilding removes any client of the same name first, so it can be run
// again for a fresh one; an example removes only the coach's earlier example
// (by its flag, never by a name: a real client may share it).

import { getData, persist, allocId } from "./db";
import { writeFood } from "./food/rows";
import { writeCheckIns } from "./checkins/rows";
import { fetchClientSets, writeSets } from "./sets/rows";
import { deleteClientNotes } from "./notes/rows";
import {
  addExerciseToDay,
  addClientEvent,
  addClientGym,
  addClientPhase,
  addFoodEntry,
  addMetricDefinition,
  addMeeting,
  addSession,
  applySupplementChanges,
  completeMeeting,
  createClient,
  deployProgram,
  syncProgramPhase,
  exerciseGroup,
  getWeek,
  listExercises,
  localDateStr,
  logSet,
  removeClient,
  requestExerciseVideo,
  setCalorieLog,
  setCardioDone,
  setDayLabel,
  setFoodDayType,
  setMetricEntry,
  setNutritionDayTargets,
  setPhaseObjectives,
  sendChatMessage,
  updateMeeting,
} from "./queries";

const day = (offset: number) => {
  const d = new Date(`${localDateStr()}T00:00:00`);
  d.setDate(d.getDate() + offset);
  return localDateStr(d);
};
// Monday of the week `n` weeks from this one.
const monday = (n: number) => {
  const d = new Date(`${localDateStr()}T00:00:00`);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + n * 7);
  return localDateStr(d);
};
const rnd = (seed: number) => {
  let s = seed;
  return () => ((s = (s * 9301 + 49297) % 233280) / 233280);
};

type Row = { names: string[]; sets: number; reps: string; kg: number; rpe: number | null; tempo: string | null; note: string | null };

/** A food of the shared catalog (app/lib/foods/common.json's ids), an amount, and its portion's words when it has one. */
type Food = { id: string; grams: number; serving?: string };
const OATS: Food = { id: "usda:2346397", grams: 80 };
const WHEY: Food = { id: "usda:173180", grams: 30, serving: "1 scoop" };
const BANANA: Food = { id: "usda:173944", grams: 118, serving: "1 banana" };
const BLUEBERRIES: Food = { id: "usda:2263889", grams: 75 };
const PEANUT_BUTTER: Food = { id: "usda:324860", grams: 16, serving: "1 tbsp" };
const EGGS: Food = { id: "usda:172187", grams: 120, serving: "2 eggs" };
// Two slices in the app's own multi-portion form, so the diary's amount editor finds the catalog's "1 slice".
const BREAD: Food = { id: "usda:335240", grams: 64, serving: "2 × slice" };
const CHICKEN: Food = { id: "usda:171477", grams: 150 };
const RICE: Food = { id: "usda:168878", grams: 200 };
const BROCCOLI: Food = { id: "usda:169967", grams: 100 };
const PASTA: Food = { id: "usda:169737", grams: 180 };
const SALMON: Food = { id: "usda:175168", grams: 110, serving: "1 fillet" };
const POTATO: Food = { id: "usda:170440", grams: 250 };
const AVOCADO: Food = { id: "usda:171705", grams: 68, serving: "0.5 avocado" };
const STEAK: Food = { id: "usda:168635", grams: 170, serving: "1 steak" };
const SWEET_POTATO: Food = { id: "usda:168483", grams: 200 };
const YOGHURT: Food = { id: "usda:330137", grams: 170, serving: "1 pot" };
const ALMONDS: Food = { id: "usda:170567", grams: 30 };
const APPLE: Food = { id: "usda:171688", grams: 182, serving: "1 apple" };
const COTTAGE: Food = { id: "usda:172179", grams: 150 };

/** A day's meals, three days that take turns, so the week reads as someone eating, not one day copied. */
const MENUS: Record<"breakfast" | "lunch" | "dinner" | "snacks", Food[]>[] = [
  { breakfast: [OATS, WHEY, BANANA], lunch: [CHICKEN, RICE, BROCCOLI], dinner: [SALMON, POTATO, AVOCADO], snacks: [YOGHURT, ALMONDS] },
  { breakfast: [EGGS, BREAD, BLUEBERRIES], lunch: [CHICKEN, PASTA, BROCCOLI], dinner: [STEAK, SWEET_POTATO], snacks: [COTTAGE, APPLE] },
  { breakfast: [OATS, WHEY, PEANUT_BUTTER, BLUEBERRIES], lunch: [SALMON, RICE, AVOCADO], dinner: [CHICKEN, POTATO, BROCCOLI], snacks: [YOGHURT, BANANA] },
];
/** When each meal of a day was logged, for the stamps a real day has. */
const MEAL_HOUR: Record<keyof (typeof MENUS)[number], number> = { breakfast: 8, lunch: 13, dinner: 19, snacks: 16 };

/** Moves done with the body alone, or for the core: never what a row with a weight on it falls back to. */
const NOT_A_LIFT = /push-?up|pull-?up|chin-?up|\bdips?\b|plank|crunch|sit-?up|bridge|mountain|dead bug|twist|leg raise|knee raise|rollout|lunge|step-?up/i;

export async function buildDemoClient(coachId: number, name: string, opts: { example?: boolean } = {}): Promise<number> {
  const data = getData();
  const example = !!opts.example;
  // An example replaces only the coach's earlier example (its flag, never a name); else only this coach's client of
  // that name, never anyone else's, and never their example.
  const earlier = example ? data.clients.filter((c) => c.coach_id === coachId && c.example) : data.clients.filter((c) => c.name === name && c.coach_id === coachId && !c.example);
  for (const c of earlier) await removeClient(c.id);
  const client = createClient(name, coachId);
  const id = client.id;
  if (example) {
    const row = data.clients.find((c) => c.id === id);
    if (row) {
      // Marked before anything else is written, so no reader ever counts a half-built example as a person. Its app
      // open, so no lock, no Open Sam's app and no "Your app is ready" (he has no login to be told anyway).
      row.example = true;
      row.app_opened_at = new Date().toISOString();
      row.app_opened_by = "phase";
    }
    persist();
  }
  const rand = rnd(id * 7 + 3);

  // The library, by name; whatever this coach has. The preset library's spellings first in each list (lib/presets.ts),
  // so a new coach's example uses their own exercises; a library without any of them falls back to a weighted lift,
  // never a cardio, core or bodyweight move.
  const lib = listExercises(coachId).filter((e) => !e.archived);
  const ex = (...names: string[]) => {
    for (const n of names) {
      const hit = lib.find((e) => e.name.toLowerCase() === n.toLowerCase());
      if (hit) return hit.id;
    }
    const lift = (e: (typeof lib)[number]) => !["abs", "cardio", "other"].includes(exerciseGroup(e)) && !NOT_A_LIFT.test(e.name) && !/cardio|run|bike|walk|swim|elliptical|stair|rope|rowing machine/i.test(e.name);
    return lib.find(lift)?.id ?? lib.find((e) => !/cardio|run|bike|walk/i.test(e.name))?.id ?? lib[0]?.id;
  };

  // Gyms: two, so the per-gym weight columns show.
  // The client's sets through their door (quest 10): none yet, a view for the readers below.
  const sr = await fetchClientSets("action.training", id);
  addClientGym(sr, id, "Muscle Factory");
  addClientGym(sr, id, "TrainMore");
  const gyms = data.client_gyms.filter((g) => g.client_id === id).map((g) => g.id);

  // A 12-week programme that started 8 weeks ago: weeks 1-8 trained, week 9
  // (this week) half done, 10-12 ahead, so a month of trend has something
  // behind it. Phase first, which makes the programme.
  const TRAINED = 8;
  const phase = addClientPhase(sr, id, "training", "Hypertrophy Block", monday(-TRAINED), monday(12 - TRAINED - 1));
  const programId = phase.program_id!;
  const program = data.training_programs.find((p) => p.id === programId)!;
  const startWeek = program.start_week;

  const push: Row[] = [
    { names: ["Incline Chest Press Machine", "Incline Bench Press", "Bench Press"], sets: 3, reps: "6-8", kg: 60, rpe: 8, tempo: null, note: "Do not lock out the elbows" },
    { names: ["Flat Chest Press Machine", "Dumbbell Bench Press"], sets: 3, reps: "8-10", kg: 50, rpe: 8, tempo: "2-0-2", note: null },
    { names: ["Overhead Press", "Shoulder Press", "Seated Dumbbell Shoulder Press", "Dumbbell Shoulder Press"], sets: 3, reps: "8-10", kg: 40, rpe: 8, tempo: null, note: "Keep the ribs down" },
    { names: ["Cable Lateral Raise", "Dumbbell Lateral Raise", "Lateral Raise"], sets: 3, reps: "12-15", kg: 10, rpe: 9, tempo: null, note: null },
    { names: ["Bar Tricep Pushdown", "Rope Tricep Pushdown", "Triceps Pushdown", "Tricep Pushdown", "Cable Triceps Extension"], sets: 3, reps: "10-12", kg: 25, rpe: 9, tempo: null, note: null },
  ];
  const pull: Row[] = [
    { names: ["Lat Pulldown", "Pull-Up", "Pull Up"], sets: 3, reps: "8-10", kg: 65, rpe: 8, tempo: null, note: "Full stretch at the top" },
    { names: ["Seated Cable Row", "Cable Row", "Seated Row"], sets: 3, reps: "8-10", kg: 60, rpe: 8, tempo: "2-1-2", note: null },
    { names: ["Face Pull"], sets: 3, reps: "15", kg: 15, rpe: null, tempo: null, note: null },
    { names: ["Barbell Curl", "Dumbbell Curl", "Bicep Curl", "Biceps Curl"], sets: 3, reps: "10-12", kg: 25, rpe: 9, tempo: null, note: null },
  ];
  const legs: Row[] = [
    { names: ["Back Squat", "Squat", "Barbell Squat"], sets: 4, reps: "5", kg: 100, rpe: 8, tempo: null, note: "Brace before every rep" },
    { names: ["Romanian Deadlift", "RDL"], sets: 3, reps: "8", kg: 90, rpe: 8, tempo: "3-0-1", note: null },
    { names: ["Leg Press"], sets: 3, reps: "10-12", kg: 180, rpe: 8, tempo: null, note: "Do not lock out the legs" },
    { names: ["Leg Extension"], sets: 3, reps: "12-15", kg: 50, rpe: 9, tempo: null, note: null },
    { names: ["Seated Leg Curl", "Leg Curl"], sets: 3, reps: "12-15", kg: 45, rpe: 9, tempo: null, note: null },
    { names: ["Calf Press", "Standing Calf Raise", "Calf Raise"], sets: 4, reps: "12-15", kg: 80, rpe: null, tempo: null, note: "Pause at the bottom" },
  ];
  const upper: Row[] = [
    { names: ["Barbell Bench Press", "Bench Press"], sets: 4, reps: "6", kg: 75, rpe: 8, tempo: null, note: null },
    { names: ["Barbell Row", "Pendlay Row", "Bent Over Row"], sets: 4, reps: "6", kg: 70, rpe: 8, tempo: null, note: "Flat back" },
    { names: ["Seated Dumbbell Shoulder Press", "Dumbbell Shoulder Press", "Shoulder Press"], sets: 3, reps: "10", kg: 22, rpe: 8, tempo: null, note: null },
    { names: ["Chest-Supported Row", "Chest Supported Row", "Dumbbell Row"], sets: 3, reps: "10-12", kg: 24, rpe: 9, tempo: null, note: null },
  ];
  const sessions: { label: string; rows: Row[]; cardio?: { name: string; time: string; pace: string; incline: string; notes: string } }[] = [
    { label: "Push", rows: push },
    { label: "Pull", rows: pull },
    { label: "Legs", rows: legs, cardio: { name: "Incline walk", time: "15 min", pace: "6 km/h", incline: "8%", notes: "Cool-down, easy" } },
    { label: "Upper", rows: upper },
  ];

  // Build every week the same, weights stepping up 2.5% a week.
  for (let w = 0; w < program.total_weeks; w++) {
    const week = startWeek + w;
    while (getWeek(id, week).length < sessions.length) addSession(id, week);
    const days = getWeek(id, week);
    sessions.forEach((s, si) => {
      const d = days[si];
      setDayLabel(d.id, s.label);
      s.rows.forEach((r, ri) => {
        // Most exercises climb 2.5% a week; every fourth stalls for a fortnight
        // mid-block, and one in the session dips a step back at week 6, so the
        // trends read as a real client, not a ramp.
        const stall = ri % 4 === 1 && w >= 4 && w <= 5 ? 4 : w;
        const dip = ri % 5 === 3 && w === 6 ? -0.035 : 0;
        const kg = Math.round((r.kg * (1 + 0.025 * stall + dip)) / 2.5) * 2.5;
        addExerciseToDay(d.id, ex(...r.names), r.sets, r.reps, kg, r.rpe, r.tempo, r.note);
      });
      if (s.cardio) {
        data.cardio_entries.push({ id: allocId("cardio_entries"), program_day_id: d.id, name: s.cardio.name, time: s.cardio.time, pace: s.cardio.pace, incline: s.cardio.incline, distance: "", notes: s.cardio.notes, order_index: 0 });
      }
    });
  }
  persist();
  deployProgram(sr, programId);
  // Deployed when it started, so "started" reads back then.
  program.deployed_at = new Date(`${monday(-TRAINED)}T09:00:00`).toISOString();
  phase.draft = false;
  // Deploying anchored the phase to today (syncProgramPhase reads deployed_at); anchored again to when it really began,
  // or the programme's weeks would run from this week with its logged weeks in the future.
  syncProgramPhase(sr, programId);
  persist();

  // Logs: the trained weeks every session (one week skipped entirely, one
  // session missed in another, so gaps show), this week the first two
  // sessions. The set's date is that week's Mon / Wed / Fri / Sat, at
  // alternating gyms.
  const dayOffsets = [0, 2, 4, 5];
  for (let w = 0; w <= TRAINED; w++) {
    if (w === 3) continue; // a week away
    const week = startWeek + w;
    const days = getWeek(id, week);
    const sessionsDone = w < TRAINED ? (w === 5 ? sessions.length - 1 : sessions.length) : 2;
    for (let si = 0; si < sessionsDone; si++) {
      const d = days[si];
      const when = new Date(`${monday(w - TRAINED)}T00:00:00`);
      when.setDate(when.getDate() + dayOffsets[si]);
      const stamp = `${localDateStr(when)}T${String(7 + Math.floor(rand() * 11)).padStart(2, "0")}:${String(Math.floor(rand() * 60)).padStart(2, "0")}:00`;
      const gym = gyms[(w + si) % gyms.length];
      for (const a of data.workout_assignments.filter((x) => x.program_day_id === d.id)) {
        const target = a.target_weight_kg ?? 0;
        const low = Number(String(a.reps).split("-")[0]) || 8;
        for (let n = 1; n <= a.sets; n++) {
          // Mostly on target, a wobble now and then; the last set a rep short sometimes.
          const kg = rand() < 0.15 ? target - 2.5 : target;
          const reps = n === a.sets && rand() < 0.35 ? low - 1 : low + Math.floor(rand() * 2);
          await logSet(a.id, n, kg, reps, a.rpe_target ? Math.min(10, a.rpe_target + (rand() < 0.3 ? 1 : 0)) : null, gym);
          // The set's time rewritten in place, through the door (memory: the store's row, as before).
          await writeSets("w.set.demo", id, () => [a.id], (box) => {
            const row = box.logs.find((l) => l.workout_assignment_id === a.id && l.set_number === n);
            if (row) row.logged_at = stamp;
          });
        }
      }
      // Ticked when the session was, not now: a session counts as completed at its last set or tick (Activity's time).
      for (const c of data.cardio_entries.filter((c) => c.program_day_id === d.id)) await setCardioDone(c.id, true, stamp);
    }
  }
  persist();

  // A video asked for on this week's first Push exercise: waiting on the client.
  const thisWeekPush = getWeek(id, startWeek + TRAINED)[0];
  const first = data.workout_assignments.find((a) => a.program_day_id === thisWeekPush.id);
  if (first) requestExerciseVideo(first.id, "Film the top set from the side, please.");

  // A lifestyle phase and a nutrition phase over today, two weeks in (week 3 of 8), so their tabs hold something: a
  // metric belongs to its phase, and a check-in asks only the live lifestyle phase's (2 Nov, Alex: phase by phase).
  const lifestyle = addClientPhase(sr, id, "lifestyle", "Daily habits", monday(-2), monday(5));
  lifestyle.draft = false;
  const nutrition = addClientPhase(sr, id, "nutrition", "Lean gain", monday(-2), monday(5));
  nutrition.draft = false;
  persist();
  // The day's targets as the Nutrition tab saves them (macros, the kcal worked out from them): 2,595 kcal on a training
  // day, 2,275 on a rest day.
  setNutritionDayTargets(id, { protein: 180, carbs: 300, fats: 75 }, { protein: 180, carbs: 220, fats: 75 }, nutrition.id);
  const stored = data.client_phases.find((p) => p.id === nutrition.id);
  if (stored?.nutrition) stored.nutrition.coach_notes = "Protein at every meal. Most of the carbs around training.";
  // Two supplements as Nutrition's + Item saves a preset (lib/supplementPresets.ts): a dose and a time each.
  applySupplementChanges(id, {
    added: [
      { name: "Creatine monohydrate", quantity: "5 g", timing: "Any time", notes: "" },
      { name: "Vitamin D3", quantity: "2000 IU", timing: "With breakfast", notes: "" },
    ],
    updated: [],
    removedIds: [],
  });
  persist();

  // Check-in: three daily metrics of the lifestyle phase with two weeks of readings; the food diary's days with them.
  addMetricDefinition(id, "body", "Weight", "kg", "daily", lifestyle.id);
  addMetricDefinition(id, "sleep", "Hours of sleep", "h", "daily", lifestyle.id);
  addMetricDefinition(id, "activity", "Steps", "steps", "daily", lifestyle.id);
  const metric = (name: string) => data.metric_definitions.find((m) => m.client_id === id && m.name === name);
  const weight = metric("Weight");
  const sleep = metric("Hours of sleep");
  const steps = metric("Steps");
  let kg = 88.4;
  for (let i = 14; i >= 0; i--) {
    const date = day(-i);
    kg = Math.round((kg - 0.05 + (rand() - 0.5) * 0.6) * 10) / 10;
    // Through the check-ins' door (quest 9), each figure drawn in the order it always was before it is written.
    const figure = (defId: number, value: number) => writeCheckIns("w.entry.demo", id, () => ({ defIds: [defId], span: { periods: [date] } }), (b) => setMetricEntry(b, defId, date, value));
    if (rand() < 0.9 && weight) await figure(weight.id, kg);
    if (rand() < 0.85 && sleep) await figure(sleep.id, Math.round((6 + rand() * 2.5) * 2) / 2);
    if (rand() < 0.85 && steps) await figure(steps.id, 5000 + Math.floor(rand() * 7000));
    // A rest day where no session falls (the sessions are Mon, Wed, Fri and Sat).
    const weekday = new Date(`${date}T00:00:00`).getDay();
    const dayType = weekday === 2 || weekday === 4 || weekday === 0 ? "rest" : "training";
    if (i <= 5) {
      // The last few days in the food diary itself, meal by meal (its door, quest 8 part 1); today its breakfast alone.
      const menu = MENUS[i % MENUS.length];
      const meals = (Object.keys(menu) as (keyof typeof menu)[]).filter((m) => i > 0 || m === "breakfast");
      await writeFood("w.entry.add", id, { span: { dates: [date] } }, (box) => {
        for (const meal of meals) {
          const at = new Date(`${date}T${String(MEAL_HOUR[meal]).padStart(2, "0")}:${String(Math.floor(rand() * 50) + 5).padStart(2, "0")}:00`).toISOString();
          for (const f of menu[meal]) {
            // A portion as typed most days, a little more or less now and then, as a real diary has it.
            const grams = f.serving ? f.grams : Math.round((f.grams * (0.9 + rand() * 0.25)) / 5) * 5;
            const entry = addFoodEntry(box, id, date, meal, f.id, grams, f.serving ?? null);
            if (entry) entry.logged_at = at;
          }
        }
      });
      if (dayType === "rest") await writeFood("w.day.type", id, { span: { dates: [date] } }, (box) => setFoodDayType(box, id, date, "rest"));
    } else if (rand() < 0.8) {
      // Before them the day's calories alone, as typed (its figures drawn in the order they always were).
      const kcal = 2400 + Math.floor((rand() - 0.5) * 700);
      await writeFood("w.calories.demo", id, { span: { dates: [date] } }, (box) => {
        setCalorieLog(box, id, date, kcal, null, dayType);
        // Typed that evening, not the moment the example was built: Activity dates a row by it.
        const row = box.calories.find((c) => c.client_id === id && c.date === date);
        if (row) row.logged_at = new Date(`${date}T21:${String(Math.floor(rand() * 50) + 5).padStart(2, "0")}:00`).toISOString();
      });
    }
  }
  persist();

  // One event on the Plan: a trip next month, a long weekend away.
  const now = new Date(`${localDateStr()}T00:00:00`);
  const trip = new Date(now.getFullYear(), now.getMonth() + 1, 11);
  const tripEnd = new Date(trip);
  tripEnd.setDate(tripEnd.getDate() + 4);
  addClientEvent(id, { kind: "trip", title: "Lisbon", start: localDateStr(trip), end: localDateStr(tripEnd), note: "Hotel gym, dumbbells up to 30 kg" });

  // The coach's goals for the phase, on the client's Home.
  setPhaseObjectives(phase.id, ["Add 5–10% to the main lifts", "Train four times a week", "Keep bodyweight within a kilo"]);

  // A few messages, the coach's first.
  const msgs: { from: "coach" | "client"; text: string; daysAgo: number }[] = [
    { from: "coach", text: "Welcome in! Your programme is live: four sessions a week. Log every set as you go and I'll check in after each session.", daysAgo: 55 },
    { from: "client", text: "Thanks! Just did Push, felt strong.", daysAgo: 55 },
    // The latest a little over two weeks back: a client's message inside 14 days counts as unread for the coach (chat/
    // pick.ts dockLineOf), and the example owes nothing (25 Nov).
    { from: "coach", text: "Great numbers on the incline press this week. We'll add a little weight next week.", daysAgo: 18 },
    { from: "client", text: "Sounds good. The leg press was taken on Friday, I did hack squats instead.", daysAgo: 16 },
    { from: "coach", text: "Perfect, that's exactly what the swap is for.", daysAgo: 16 },
  ];
  for (const m of msgs) {
    // Dated back as it is made (it was made now and its stamp changed after).
    const at = new Date();
    at.setDate(at.getDate() - m.daysAgo);
    await sendChatMessage(id, m.from, m.text, undefined, null, null, { createdAt: at.toISOString(), path: "w.insert.demo" });
  }
  persist();

  // Meetings: last one done, with its recap for the client; the next in four days.
  addMeeting(id, day(-12), "18:00", "Mid-block check-in", 30, "https://meet.google.com/demo-review-call");
  const past = data.meetings[data.meetings.length - 1];
  updateMeeting(past.id, { summary_title: "Keep the calories, push the lifts", summary: "Calories stay where they are: bodyweight is steady and the lifts keep moving. From next week the top sets go up 2.5 kg where the last set was at RPE 8 or below." });
  completeMeeting(past.id);
  addMeeting(id, day(4), "18:00", "End of block review", 30, "https://meet.google.com/demo-review-call");

  // An example tells nobody anything (25 Nov, Alex: "no bell notifications"): the notes the steps above wrote as a real
  // client's would (the programme going live, the video ask, the messages, the calls) taken off again. No push went:
  // he has no login for one to go to. The App Review client keeps them, so the reviewer finds a bell with something in.
  if (example) await deleteClientNotes(id, "w.client.delete");
  persist();

  return id;
}
