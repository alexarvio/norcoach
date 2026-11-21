"use client";

import { useEffect, useRef, useState } from "react";
import { useSteadyOffline } from "./useSteadyOffline";
import { enqueueWorkout, forgetRefused, useWorkoutOutbox } from "../../components/workoutOutbox";
import { displayToKg, fmtWeight, kgToDisplay, unitLabel, type Unit } from "../../lib/units";
import { isAssisted } from "../../lib/progressRules";
import { MAX_WARMUPS } from "../ExercisePage";
import { lastSetsHere, shownName, type SessionExercise } from "../workoutShared";
import { EMPTY, deltaFor, doubtCheck, isPb, planFor, refOf, repLowOf, repTopOf, warmFrom, type Vals, type Warm } from "./setRules";

// One exercise's sets on the workout sheet (15 Nov, Alex: docs/boards/workout-sheet-a-mockup.html): the pager's set
// logic (ExercisePage.tsx) without anything that moves by itself. Typing only changes what is typed; a set is logged
// by its tick alone, at once, through the same outbox calls as the pager. No fold, no advance, no timer that changes
// the open set or the page; a blur never takes the plan.

/** What is typed in a row's boxes, as typed, in the exercise's unit. A field not typed is undefined. */
export type Draft = { w?: string; r?: string };

export type SheetRow = {
  /** `s{n}` for a working set, the warm-up's own key for a warm-up. */
  id: string;
  kind: "warm" | "work";
  /** The set's number, or the warm-up's place from 1. */
  n: number;
  extra: boolean;
  /** What is saved: a working set's log, a warm-up's figures once ticked. */
  logged: Vals | null;
  /** Ticked, saved, and not unlocked to fix. */
  done: boolean;
  unlocked: boolean;
  plan: Vals;
  /** What a tick logs: what is typed, else what is saved (15 Nov, Alex: never the plan or last time). */
  figures: Vals;
  /** Both figures are typed (or saved, on a row opened to fix or refused): the tick can log it. */
  ready: boolean;
  draft: Draft;
  /** What the server refused for it ("gone", "stale" or a reason), while it is not saved again. */
  refused: string | null;
  /** On its way for 3s or more, or with no signal: `Not sent yet`. */
  late: boolean;
  /** Its figures beat the PB bar (the server's personalBests rule), or a logged set the server marked one. */
  pb: boolean;
  /** Against the same set last time, on what was typed or saved alone (never the plan). */
  delta: { weight: number | null; reps: number | null };
  /** Shown in the weight slot: typed or saved, else "" (15 Nov, Alex: an empty slot, no grey figure in it). */
  weightText: string;
  repsText: string;
  /** A warm-up: last time's warm-up in its place, the Last column's figures. */
  warmLast: { weight: number | null; reps: number | null } | null;
  /** A warm-up left untouched once every set is in (16 Nov, Alex): it folds away. */
  gone: boolean;
};

export type Doubt = { n: number; weight: boolean; reps: boolean; v: Vals };

/**
 * What an exercise's rows hold on the phone for the session, so a trip to the overview and back (a remount) comes back
 * exactly as it was left: what is typed (in `unit`), the rows opened again to fix, what each set last went out as (so a
 * refused one is shown and sent again as it was typed), the unit picked, the sets added, the warm-up rows by their own
 * keys, and how many fixed rows wait for their tick (`p`, read by the finish).
 */
type Kept = { d: Record<string, Draft>; s: Record<number, Vals>; u: string[]; unit: Unit; extra: number; warm: Warm[] | null; p: number };
const keptKey = (dayId: number, assignmentId: number) => `ironline.client.ws-rows.${dayId}.${assignmentId}`;
/** Everything kept of one session, gone once it is ended or thrown away. */
export const DRAFT_PREFIX = (dayId: number) => `ironline.client.ws-rows.${dayId}.`;

function readKept(key: string): Partial<Kept> | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    const v = raw ? (JSON.parse(raw) as Partial<Kept>) : null;
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

/** A warm-up added here: a key unique across visits (a remount never hands out one a kept draft still sits on). */
function freshWarmKey(): string {
  return `wa${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

/** Rows opened again to fix and changed, still to be ticked, across the session's exercises (the finish says so). */
export function unTickedChanges(dayId: number): number {
  let n = 0;
  try {
    const prefix = DRAFT_PREFIX(dayId);
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const k = window.sessionStorage.key(i);
      if (k && k.startsWith(prefix)) n += Number(readKept(k)?.p) || 0;
    }
  } catch {}
  return n;
}

/**
 * Typed weights moved to another unit: a figure that is a row's saved weight is dropped, so the row shows (and a tick
 * compares) the saved kg exactly; anything else typed is turned into the same weight in the new unit.
 */
function draftsIn(d: Record<string, Draft>, from: Unit, to: Unit, savedKgOf: (id: string) => number | null): Record<string, Draft> {
  if (from === to) return d;
  const out: Record<string, Draft> = {};
  for (const [id, dr] of Object.entries(d)) {
    const fig = figureOf(dr.w);
    if (fig === undefined) {
      out[id] = dr;
      continue;
    }
    const kg = displayToKg(fig, from);
    if (kg === savedKgOf(id)) {
      const rest = { ...dr };
      delete rest.w;
      out[id] = rest;
    } else out[id] = { ...dr, w: fmtWeight(kgToDisplay(kg, to)) };
  }
  return out;
}

/** Digits and one dot, a comma read as the dot (as tidyDecimal); whole numbers for reps. */
export function tidyTyped(text: string, whole: boolean): string {
  let out = "";
  let dot = false;
  for (const ch of text) {
    if (ch >= "0" && ch <= "9") out += ch;
    else if (!whole && (ch === "." || ch === ",") && !dot) {
      out += ".";
      dot = true;
    }
  }
  return out.slice(0, 7);
}
const figureOf = (t: string | undefined): number | undefined => {
  if (t == null || t.trim() === "" || t === ".") return undefined;
  const v = Number(t);
  return Number.isFinite(v) && v >= 0 && v <= 9999 ? v : undefined;
};

export function useExerciseSets(exercise: SessionExercise, { gymId, session, free }: { gymId: number | null; session: { dayId: number; startedAt: string | null }; free: boolean }) {
  // ---- What this exercise kept on the phone (a remount comes back as it was left), read once.
  const storeKey = keptKey(session.dayId, exercise.id);
  const [kept0] = useState<Partial<Kept> | null>(() => (typeof window === "undefined" ? null : readKept(storeKey)));

  // ---- The unit, this exercise alone (ExercisePage.tsx :98-105): from the sets logged, else the one picked here (kept
  // with the typed figures, so they are never read in another), else kg; the server's word wins.
  const [unit, setUnit] = useState<Unit>(() => exercise.unit ?? kept0?.unit ?? "kg");
  const [unitSeen, setUnitSeen] = useState<Unit | null>(exercise.unit ?? null);
  if ((exercise.unit ?? null) !== unitSeen) {
    setUnitSeen(exercise.unit ?? null);
    if (exercise.unit) setUnit(exercise.unit);
  }
  const uLabel = unitLabel(unit);
  // The unit a save goes out in, read when it goes (a switch to lbs from the question lands before its save).
  const unitNow = useRef(unit);
  useEffect(() => {
    unitNow.current = unit;
  }, [unit]);

  // ---- What the pager reads (ExercisePage.tsx :109-127).
  const gymWeight = (gymId != null ? exercise.gymTargets?.[gymId] : null) ?? exercise.targetWeight;
  const lastHere = lastSetsHere(exercise, gymId);
  const askWeight = exercise.targetWeight != null || free;
  const swapped = exercise.swap != null;
  const swapNote = exercise.swap?.libraryExerciseId != null ? exercise.alternatives.find((a) => a.id === exercise.swap!.libraryExerciseId)?.note?.trim() || null : null;
  const targetWeight = swapped ? null : gymWeight;
  const targetRpe = swapped ? null : exercise.targetRpe;
  const { refKg, refFrom } = refOf(lastHere, targetWeight, swapped);
  const repTop = repTopOf(exercise.reps, lastHere, swapped);
  const last = swapped ? null : lastHere;
  const lastOf = (n: number) => last?.sets.find((s) => s.setNumber === n) ?? null;
  const repLow = repLowOf(exercise.reps);
  const planWeight = targetWeight;
  const assisted = exercise.assisted ?? isAssisted(shownName(exercise));

  // ---- Working sets (ExercisePage.tsx :174-177).
  const [extraAdded, setExtraAdded] = useState(() => Math.max(0, Number(kept0?.extra) || 0));
  const maxLogged = exercise.logs.reduce((m, l) => Math.max(m, l.setNumber), 0);
  const workCount = Math.max(exercise.sets + extraAdded, maxLogged);
  const logOf = (n: number) => exercise.logs.find((l) => l.setNumber === n) ?? null;
  const loggedOf = (n: number): Vals | null => {
    const l = logOf(n);
    return l ? { weightKg: l.weight, reps: l.reps, rpe: l.rpe } : null;
  };
  const isSaved = (v: Vals) => (!askWeight || v.weightKg != null) && v.reps != null;
  // On the sheet a set "done before it" is one ticked: what is only typed never carries.
  const planOf = (n: number): Vals => planFor(n, { lastOf, enteredOf: (m) => loggedOf(m) ?? EMPTY, isSaved, planWeight, swapped, sets: exercise.sets, repLow, targetRpe });

  // ---- Warm-ups (ExercisePage.tsx :210-245): this week's saved ones, else last time's as the plan. The rows as they
  // were left come back with their own keys while the saved ones are still what the server has; else the server's list
  // with the ones not ticked after it, as the pager does. A key is never made again for another row.
  const savedSig = (rows: Warm[]) => JSON.stringify(rows.filter((r) => r.saved).map((r) => ({ weight: r.entered.weightKg, reps: r.entered.reps })));
  const serverSig = (list: SessionExercise["warmups"]) => JSON.stringify(list.map((w) => ({ weight: w.weight, reps: w.reps })));
  const savedKey = (w: { weight: number | null; reps: number | null }, i: number) => `ws${i}:${w.weight ?? ""}x${w.reps ?? ""}`;
  const [warm, setWarm] = useState<Warm[]>(() => {
    const keptWarm = Array.isArray(kept0?.warm) ? kept0.warm : null;
    if (keptWarm && savedSig(keptWarm) === serverSig(exercise.warmups)) return keptWarm;
    const server = exercise.warmups.length
      ? exercise.warmups.map((w, i) => warmFrom(w, true, savedKey(w, i)))
      : exercise.lastWarmups.slice(0, MAX_WARMUPS).map((w, i) => warmFrom(w, false, `wp${i}`));
    return keptWarm && exercise.warmups.length ? [...server, ...keptWarm.filter((r) => !r.saved)].slice(0, MAX_WARMUPS) : server;
  });
  // By content: a refresh hands in the same sets again. Ticked here and come back the same, nothing moves.
  const warmKey = serverSig(exercise.warmups);
  const [seenWarm, setSeenWarm] = useState(warmKey);
  if (seenWarm !== warmKey) {
    setSeenWarm(warmKey);
    if (savedSig(warm) !== warmKey) setWarm([...exercise.warmups.map((w, i) => warmFrom(w, true, savedKey(w, i))), ...warm.filter((r) => !r.saved)]);
  }

  // ---- What is typed, by row, in the unit it was typed in; the rows opened again to fix; what each set last went out
  // as. Only the rows there are now come back: a draft never lands on a row it wasn't typed in.
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => {
    const d = kept0?.d && typeof kept0.d === "object" ? kept0.d : {};
    const count = Math.max(exercise.sets + extraAdded, maxLogged);
    const ids = new Set([...Array.from({ length: count }, (_, i) => `s${i + 1}`), ...warm.map((w) => w.key)]);
    const mine = Object.fromEntries(Object.entries(d).filter(([id]) => ids.has(id)));
    // Typed in a unit the exercise is no longer in (the server's word came in meanwhile): the same weights in this one.
    const savedKgOf = (id: string) => (/^s\d+$/.test(id) ? logOf(Number(id.slice(1)))?.weight ?? null : warm.find((w) => w.key === id && w.saved)?.entered.weightKg ?? null);
    return kept0?.unit && kept0.unit !== unit ? draftsIn(mine, kept0.unit, unit, savedKgOf) : mine;
  });
  const dropDraft = (id: string) =>
    setDrafts((d) => {
      if (!(id in d)) return d;
      const next = { ...d };
      delete next[id];
      return next;
    });
  // Rows opened again to fix (a tap on their green tick), and what each set last went out as.
  const [unlocked, setUnlocked] = useState<Set<string>>(() => new Set((Array.isArray(kept0?.u) ? kept0.u : []).filter((id) => id in drafts)));
  const relock = (id: string) =>
    setUnlocked((u) => {
      if (!u.has(id)) return u;
      const next = new Set(u);
      next.delete(id);
      return next;
    });
  const [sent, setSent] = useState<Record<number, Vals>>(() => (kept0?.s && typeof kept0.s === "object" ? kept0.s : {}));

  const persistWarm = (rows: Warm[]) => {
    const sets = rows.filter((r) => r.saved).map((r) => ({ weight_kg: r.entered.weightKg, reps: r.entered.reps }));
    enqueueWorkout({ kind: "warmups", assignmentId: exercise.id, sets, ...session });
  };
  const addWarm = () => {
    if (warm.length >= MAX_WARMUPS) return;
    const hint = exercise.lastWarmups[warm.length];
    // A key no row has had, this visit or another: a draft left on a warm-up that went never lands on a new one.
    setWarm([...warm, { key: freshWarmKey(), plan: { weightKg: hint?.weight ?? planOf(1).weightKg, reps: hint?.reps ?? null, rpe: null }, entered: EMPTY, saved: false, own: true }]);
  };
  const removeWarm = (key: string) => {
    const rows = warm.filter((w) => w.key !== key);
    setWarm(rows);
    persistWarm(rows);
    dropDraft(key);
    relock(key);
  };

  // ---- The outbox (ExercisePage.tsx :248-311): what waits, what the server refused.
  const { entries: waiting, overlay, refused: refusedSlots } = useWorkoutOutbox();
  const refusedOf = (n: number): string | null => refusedSlots[`set:${exercise.id}:${n}`] ?? null;
  const offline = useSteadyOffline();
  const waitingSince = (n: number) => {
    const slot = `set:${exercise.id}:${n}`;
    for (let i = waiting.length - 1; i >= 0; i--) if (waiting[i].slot === slot) return Date.parse(waiting[i].at);
    return null;
  };
  // When 3s have passed for a set on its way: read once they have, never every render.
  const [lateSeen, setLateSeen] = useState(0);
  const sinces = waiting.filter((e) => e.kind === "set" && e.assignmentId === exercise.id).map((e) => Date.parse(e.at));
  const nextLate = sinces.filter((s) => s + 3000 > lateSeen).reduce<number | null>((m, s) => (m == null || s < m ? s : m), null);
  useEffect(() => {
    if (nextLate == null) return;
    const t = setTimeout(() => setLateSeen(Date.now()), Math.max(0, nextLate + 3000 - Date.now()));
    return () => clearTimeout(t);
  }, [nextLate]);

  // ---- A figure far off this exercise (27 Oct, Alex; ExercisePage.tsx :134-148), asked on the tick alone.
  const [doubt, setDoubt] = useState<Doubt | null>(null);
  const vouched = useRef({ weight: false, reps: false });

  // ---- The rows.
  const weightText = (kg: number | null) => (kg == null ? "" : fmtWeight(kgToDisplay(kg, unit)));
  const buildRow = (o: { id: string; kind: "warm" | "work"; n: number; extra: boolean; logged: Vals | null; plan: Vals; refused: string | null; since: number | null; warmLast?: SheetRow["warmLast"]; gone?: boolean }): SheetRow => {
    const isUnlocked = unlocked.has(o.id);
    const warmRow = o.kind === "warm";
    const asksWeight = askWeight || warmRow;
    // A set held on the far-off question is not done (27 Oct, Alex), nor one the server refused; a warm-up is never asked.
    const held = doubt?.n === o.n && !warmRow;
    const done = !!o.logged && !isUnlocked && o.refused == null && !held;
    // A done row shows what was saved, never a draft left on it.
    const draft = done ? {} : drafts[o.id] ?? {};
    // What went out last, for a set the server refused (it never landed): shown in ink as it was typed, whatever was
    // saved before it, and logged again by a tap.
    const kept = o.kind === "work" && o.refused ? sent[o.n] ?? null : null;
    const base = kept ?? o.logged;
    const typedW = figureOf(draft.w);
    const typedR = figureOf(draft.r);
    // A slot in the draft decides its figure: one emptied (a row opened to fix, a refused one) is empty, never the
    // saved or sent figure behind it, so the tick logs only what the slots show.
    const enteredW = draft.w !== undefined ? (typedW !== undefined ? displayToKg(typedW, unit) : null) : base?.weightKg ?? null;
    const enteredR = draft.r !== undefined ? (typedR !== undefined ? Math.round(typedR) : null) : base?.reps ?? null;
    // What is typed alone (15 Nov, Alex: the slots start empty, last time only in the Last column): never the plan.
    const figures: Vals = {
      weightKg: asksWeight ? enteredW : null,
      reps: enteredR,
      // As the pager's typed path: the RPE a set already had, else none (RPE is off the rows since 14 Oct).
      rpe: base?.rpe ?? null,
    };
    const ready = figures.reps != null && (!asksWeight || figures.weightKg != null);
    const delta = warmRow || held ? { weight: null, reps: null } : deltaFor({ weightKg: enteredW, reps: enteredR, rpe: null }, lastOf(o.n), unit, askWeight);
    // The server's rule alone (personalBests): heavier than the best on another row inside the target, so every set of
    // today's that beats it is one, as the coach's marks read them.
    const pb = !warmRow && ((done && !!exercise.pbSets?.includes(o.n) && !swapped && !free) || (ready && isPb(figures.weightKg, figures.reps, exercise, free)));
    const plan = o.plan;
    return {
      id: o.id,
      kind: o.kind,
      n: o.n,
      extra: o.extra,
      logged: o.logged,
      done,
      unlocked: isUnlocked,
      plan,
      figures,
      ready,
      draft,
      refused: o.refused,
      late: o.since != null && (offline || lateSeen >= o.since + 3000),
      pb,
      delta,
      weightText: draft.w !== undefined ? draft.w : asksWeight ? weightText(base?.weightKg ?? null) : "",
      repsText: draft.r !== undefined ? draft.r : base?.reps != null ? String(base.reps) : "",
      warmLast: o.warmLast ?? null,
      gone: !!o.gone,
    };
  };
  const workRows = Array.from({ length: workCount }, (_, i) => i + 1).map((n) =>
    buildRow({ id: `s${n}`, kind: "work", n, extra: n > exercise.sets, logged: loggedOf(n), plan: planOf(n), refused: refusedOf(n), since: waitingSince(n) })
  );
  const allDone = workRows.length > 0 && workRows.every((r) => r.done);
  const started = exercise.logs.length > 0;
  // A warm-up left untouched goes once every set is in (28 Oct, Alex; 16 Nov, Alex: "there's nothing to show"), folding
  // away on the shared fold as the last set is ticked, so nothing under it jumps; one logged stays, done in amber. A set
  // opened again brings it back. Its Last is last time's warm-up in its place.
  const untouched = (w: Warm) => !w.saved && (drafts[w.key]?.w ?? "") === "" && (drafts[w.key]?.r ?? "") === "";
  const warmRows = warm.map((w, i) =>
    buildRow({ id: w.key, kind: "warm", n: i + 1, extra: true, logged: w.saved ? w.entered : null, plan: w.plan, refused: null, since: null, warmLast: exercise.lastWarmups[i] ?? null, gone: allDone && untouched(w) })
  );
  const rows = [...warmRows, ...workRows];
  const warmAddable = !allDone && warm.length < MAX_WARMUPS;
  const same = (a: Vals, b: Vals) => a.weightKg === b.weightKg && a.reps === b.reps;
  // Rows opened to fix and changed, waiting for their tick: the finish names them, never drops them unsaid.
  const pending = rows.filter((r) => r.unlocked && r.logged && !same(r.figures, r.logged)).length;

  // ---- Kept on the phone as it changes; nothing to keep, nothing stored.
  const unlockedList = [...unlocked].join(",");
  useEffect(() => {
    try {
      const u = unlockedList ? unlockedList.split(",") : [];
      const keepWarm = warm.length > 0;
      const k: Kept = { d: drafts, s: sent, u, unit, extra: extraAdded, warm: keepWarm ? warm : null, p: pending };
      const empty = !Object.keys(drafts).length && !Object.keys(sent).length && !u.length && !extraAdded && !keepWarm && unit === (exercise.unit ?? "kg");
      if (empty) window.sessionStorage.removeItem(storeKey);
      else window.sessionStorage.setItem(storeKey, JSON.stringify(k));
    } catch {}
  }, [drafts, sent, unlockedList, unit, extraAdded, warm, pending, storeKey, exercise.unit]);

  // ---- Typing: the draft alone, never a save.
  const type = (row: SheetRow, field: "w" | "r", text: string) => {
    const clean = tidyTyped(text, field === "r");
    setDrafts((d) => {
      // Emptied, the slot is empty again; a row opened to fix keeps its place in the drafts, so what was
      // logged never springs back into a box being cleared to type over.
      const cur = { ...(d[row.id] ?? {}), [field]: clean };
      const next = { ...d };
      if (!cur.w && !cur.r && !row.unlocked) delete next[row.id];
      else next[row.id] = cur;
      return next;
    });
    if (doubt?.n === row.n && row.kind === "work") setDoubt(null);
  };

  // ---- Logging: the tick, and only the tick (ExercisePage.tsx :289-294's call, unchanged).
  // Counted each time the client's own tick (or their Yes to the far-off question) logs the last working set still to
  // do: the block's fold is armed by it, never by a tick that only raised the question (15 Nov, Alex). A rogue session
  // builds its sets one at a time, so none there.
  const [lastTicks, setLastTicks] = useState(0);
  const countLast = (n: number) => {
    if (!free && workRows.every((r) => r.n === n || r.done)) setLastTicks((c) => c + 1);
  };
  const sendSet = (n: number, v: Vals) => {
    countLast(n);
    enqueueWorkout({ kind: "set", assignmentId: exercise.id, setNumber: n, gymId, weight: v.weightKg, reps: v.reps, rpe: v.rpe, unit: unitNow.current, ...session });
    setSent((s) => ({ ...s, [n]: v }));
    dropDraft(`s${n}`);
    relock(`s${n}`);
    setDoubt((d) => (d?.n === n ? null : d));
  };
  const othersMax = (n: number) => {
    const others = workRows.filter((r) => r.n !== n && r.done && r.logged);
    return { kg: Math.max(0, ...others.map((r) => r.logged!.weightKg ?? 0)), reps: Math.max(0, ...others.map((r) => r.logged!.reps ?? 0)) };
  };
  const checkAndSend = (n: number, v: Vals) => {
    const m = othersMax(n);
    const d = doubtCheck(v, m.kg, m.reps, { swapped, refKg, repTop }, vouched.current);
    if (d.weight || d.reps) {
      setDoubt({ n, weight: d.weight, reps: d.reps, v });
      return;
    }
    sendSet(n, v);
  };
  const tick = (row: SheetRow) => {
    if (row.done) return unlock(row);
    if (!row.ready) return;
    if (row.kind === "warm") {
      const v = row.figures;
      const rows = warm.map((w) => (w.key === row.id ? { ...w, entered: { weightKg: v.weightKg, reps: v.reps, rpe: null }, saved: true } : w));
      setWarm(rows);
      if (!(row.unlocked && row.logged && same(v, row.logged))) persistWarm(rows);
      dropDraft(row.id);
      relock(row.id);
      return;
    }
    // Opened to fix and put back as it was: shut again, nothing sent.
    if (row.unlocked && row.logged && same(row.figures, row.logged)) {
      countLast(row.n);
      dropDraft(row.id);
      relock(row.id);
      return;
    }
    checkAndSend(row.n, row.figures);
  };
  /** A tap on a green tick: the row's boxes come back with what was logged, to fix. */
  const unlock = (row: SheetRow) => {
    if (!row.logged) return;
    const v = row.logged;
    setUnlocked((u) => new Set(u).add(row.id));
    setDrafts((d) => ({ ...d, [row.id]: { w: askWeight || row.kind === "warm" ? weightText(v.weightKg) : undefined, r: v.reps != null ? String(v.reps) : "" } }));
  };
  /** A set the server refused, sent again by a tap (ExercisePage.tsx :827); one gone or stale waits for new figures. */
  const resend = (row: SheetRow) => {
    if (row.refused === "gone" || row.refused === "stale" || !row.ready) return;
    sendSet(row.n, row.figures);
  };
  // "Yes": the figures as they are, saved, and not asked again this session (ExercisePage.tsx :426-434).
  const vouch = () => {
    if (!doubt) return;
    if (doubt.weight) vouched.current.weight = true;
    if (doubt.reps) vouched.current.reps = true;
    const { n, v } = doubt;
    setDoubt(null);
    sendSet(n, v);
  };
  // "I meant lbs": the figure as typed, read in lbs; the exercise goes to lbs, and the set is checked again (:436-444).
  const meantLbs = () => {
    if (!doubt || doubt.v.weightKg == null) return;
    const figure = kgToDisplay(doubt.v.weightKg, "kg");
    unitNow.current = "lb";
    setUnit("lb");
    const v = { ...doubt.v, weightKg: displayToKg(figure, "lb") };
    const n = doubt.n;
    setDoubt(null);
    // The other rows' typed weights stay the weights they were (the pager kept them in kg); this one is the lbs figure.
    setDrafts((d) => ({ ...draftsIn(d, unit, "lb", savedKgOf), [`s${n}`]: { ...(d[`s${n}`] ?? {}), w: fmtWeight(figure) } }));
    checkAndSend(n, v);
  };
  /** What a row has saved (a refused set: what it went out as), in kg: a typed figure equal to it is that weight exactly. */
  const savedKgOf = (id: string) => {
    const r = rows.find((x) => x.id === id);
    const b = r ? ((r.kind === "work" && r.refused ? sent[r.n] : null) ?? r.logged) : null;
    return b?.weightKg ?? null;
  };
  /** Kg or lbs from the ⋯ (as the finish list's CheckUnit): the sets already logged follow it, and so does what is typed
   *  (the same weights in the new unit), kept with the unit so a remount reads them in it. */
  const setUnitTo = (u: Unit) => {
    if (u === unit) return;
    setDrafts((d) => draftsIn(d, unit, u, savedKgOf));
    unitNow.current = u;
    setUnit(u);
    if (exercise.logs.length > 0) enqueueWorkout({ kind: "unit", assignmentId: exercise.id, unit: u, ...session });
  };

  // ---- + Add a set / − Remove a set (ExercisePage.tsx :479-522), without the pager's timers.
  const [askRemove, setAskRemove] = useState(false);
  const addSet = () => {
    const n = workCount + 1;
    // One taken off earlier comes back before anything counts as extra (10 Nov, Alex).
    if (exercise.sets < (exercise.coachSets ?? exercise.sets)) enqueueWorkout({ kind: "rows", assignmentId: exercise.id, rows: n, ...session });
    else setExtraAdded((e) => Math.max(e, maxLogged - exercise.sets) + 1);
    setAskRemove(false);
  };
  const removeLast = () => {
    const lastN = workCount;
    if (lastN <= 1) return;
    forgetRefused(`set:${exercise.id}:${lastN}`);
    if (doubt?.n === lastN) setDoubt(null);
    dropDraft(`s${lastN}`);
    relock(`s${lastN}`);
    setSent((s) => {
      if (!(lastN in s)) return s;
      const next = { ...s };
      delete next[lastN];
      return next;
    });
    const extra = lastN > exercise.sets;
    if (extra) setExtraAdded((e) => Math.max(0, Math.max(e, maxLogged - exercise.sets) - 1));
    if (!extra || logOf(lastN)) enqueueWorkout({ kind: "rows", assignmentId: exercise.id, rows: lastN - 1, ...session });
    setAskRemove(false);
  };
  const tapRemove = () => {
    const row = workRows[workRows.length - 1];
    if (row && (row.logged || row.draft.w || row.draft.r)) setAskRemove(true);
    else removeLast();
  };

  // ---- Your note (ExercisePage.tsx :526-544): the one for the gym trained at, else the home gym's or the latest.
  // A change still on its way (or just answered) is the note for this gym as it stands, a Delete's "" too: never the
  // fallback, which is the note it took away.
  const noteSlot = `note:${exercise.id}:${gymId ?? ""}`;
  let goingNote: string | null = null;
  for (let i = overlay.length - 1; i >= 0 && goingNote == null; i--) {
    const e = overlay[i];
    if (e.kind === "note" && e.slot === noteSlot) goingNote = e.text;
  }
  const storedNote = goingNote ?? ((gymId != null ? exercise.gymNotes?.[gymId] : "") || exercise.myNote);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [seenStored, setSeenStored] = useState(storedNote);
  if (seenStored !== storedNote) {
    setSeenStored(storedNote);
    setSavedNote(null);
  }
  const myNote = savedNote ?? storedNote;
  const saveNote = (text: string) => {
    const next = text.trim();
    if (next === myNote.trim()) return;
    setSavedNote(next);
    enqueueWorkout({ kind: "note", assignmentId: exercise.id, gymId, text: next, ...session });
  };
  /** Delete (15 Nov, Alex: the mockup's red words): the note saved empty. */
  const deleteNote = () => {
    setSavedNote("");
    enqueueWorkout({ kind: "note", assignmentId: exercise.id, gymId, text: "", ...session });
  };
  // Swapped for the day, or taken back (ExercisePage.tsx :546-554).
  const saveSwap = (choice: { libraryExerciseId: number | null; customName: string | null } | null) =>
    enqueueWorkout({
      kind: "swap",
      assignmentId: exercise.id,
      libraryExerciseId: choice?.libraryExerciseId ?? null,
      customName: choice?.customName ?? null,
      name: choice ? (choice.libraryExerciseId != null ? exercise.alternatives.find((a) => a.id === choice.libraryExerciseId)?.name ?? choice.customName ?? null : choice.customName) : null,
      ...session,
    });

  return {
    unit,
    uLabel,
    setUnitTo,
    askWeight,
    swapped,
    swapNote,
    targetWeight,
    targetRpe,
    assisted,
    refKg,
    refFrom,
    repTop,
    rows,
    workRows,
    workCount,
    allDone,
    lastTicks,
    started,
    warmAddable,
    hasWarm: warmRows.some((r) => !r.gone),
    addWarm,
    removeWarm,
    type,
    tick,
    resend,
    doubt,
    vouch,
    meantLbs,
    addSet,
    removeLast,
    tapRemove,
    askRemove,
    setAskRemove,
    myNote,
    saveNote,
    deleteNote,
    saveSwap,
    lastOf,
  };
}
