"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { useWorkoutOutbox, type WorkoutEntry } from "../components/workoutOutbox";
import { liveActivityAvailable, liveStart, liveSync, liveUpdate, type LiveExercise, type LiveNext, type LiveNow } from "../lib/liveActivity";
import { liveSessionNowAction } from "../lib/liveSessionActions";
import { fmtWeight, planToDisplay, unitLabel, type Unit } from "../lib/units";
import { hintsVersion, readHints, subscribeHints, type LiveHint } from "./liveHints";

// The lock-screen pill follows the session going (19 Nov, Alex: "I forget to complete the workout and it runs"). There is
// no one place a session starts or ends, so it is worked out from three: what the server says (with the page, and read
// again as the app opens and comes back to the front: an end on another device, the 12 h end, the coach deleting it),
// laid over by what waits in the workout's outbox (a start, an end, a discard, a gym, the sets), laid over by the hints
// for what the outbox never sees (a rogue session, Reopen; liveHints.ts). Mounted once in the app's shell; never in the
// coach's phone preview, and nothing at all in a browser or an app without the plugin.

type Read = { now: LiveNow; t: number };
/** `next` undefined: the session's exercises aren't known here yet (started on this phone, the server not told). */
type Shown = { dayId: number; startedAt: number; name?: string; gym?: string | null; sets: number; next?: LiveNext };

const SETTLE_MS = 400;

/** The set planned as words (19 Nov, Alex: C): `60 kg × 10–12` in the exercise's unit, the band's dash in a range; the
    weight or the reps alone when the coach set only one; null with neither. */
export function targetWords(kg: number | null, reps: string, unit: Unit): string | null {
  const r = reps.trim().replace(/\s*(?:-|–|to)\s*/i, "–");
  const w = kg != null ? `${fmtWeight(planToDisplay(kg, unit))} ${unitLabel(unit)}` : null;
  if (w && r) return `${w} × ${r}`;
  if (w) return w;
  if (r) return /^\d+(–\d+)?\+?$/.test(r) ? `${r} reps` : r;
  return null;
}

/** The set next (19 Nov, Alex: C of docs/boards/live-activity-mockup.html): the server's exercises with what waits on the
    phone laid over them (a set, a set taken off, the unit, a swap; warm-ups are never sets). The exercise is where the
    last set was logged while it has sets left, else the next one in the session with sets left (round to the earlier
    ones skipped); before any set the first; every set in, none (`All sets done`). A swap names the substitute and has no
    target; a rogue session has no total and no targets, its set count the sets it has. */
export function nextSet(exercises: readonly LiveExercise[], rogue: boolean, overlay: readonly WorkoutEntry[], dayId: number, gymId: number | null | undefined): LiveNext & { done?: number } {
  type Ex = { name: string; swap: string | null; sets: number; coachSets: number; reps: string; kg: number | null; kgAt: Record<string, number | null>; unit: Unit | null; logs: Map<number, number> };
  const exs: Ex[] = exercises.map((x) => ({ ...x, logs: new Map(x.logs.map((l) => [l.n, l.at])) }));
  const byId = new Map(exercises.map((x, i) => [x.id, exs[i]]));
  for (const e of overlay) {
    if (e.dayId !== dayId) continue;
    if (e.kind === "discard") {
      for (const x of exs) x.logs.clear();
      continue;
    }
    if (e.kind !== "set" && e.kind !== "rows" && e.kind !== "unit" && e.kind !== "swap") continue;
    const x = byId.get(e.assignmentId);
    if (!x) continue;
    if (e.kind === "set") {
      x.logs.set(e.setNumber, Date.parse(e.at) || Date.now());
      x.unit = e.unit;
    } else if (e.kind === "rows") {
      // As the workout lays it over (applyWorkoutOutbox): the sets past it go.
      x.sets = Math.min(x.coachSets, e.rows);
      for (const n of [...x.logs.keys()]) if (n > e.rows) x.logs.delete(n);
    } else if (e.kind === "unit") x.unit = e.unit;
    else x.swap = e.libraryExerciseId == null && !e.customName ? null : e.name ?? e.customName ?? "Another exercise";
  }
  const total = rogue || !exs.length ? null : exs.reduce((t, x) => t + x.sets, 0);
  // The planned sets done, against the total (19 Nov, Alex: an extra set read "19 of 18 sets"; extras are past x.sets).
  const done = total == null ? undefined : exs.reduce((t, x) => t + [...x.logs.keys()].filter((n) => n <= x.sets).length, 0);
  const left = (x: Ex) => {
    for (let n = 1; n <= x.sets; n++) if (!x.logs.has(n)) return n;
    return null;
  };
  let last = -1;
  let lastAt = -Infinity;
  exs.forEach((x, i) => {
    for (const at of x.logs.values()) if (at >= lastAt) [last, lastAt] = [i, at];
  });
  let pick = last >= 0 && left(exs[last]) != null ? last : -1;
  for (let k = 0; pick < 0 && k < exs.length; k++) {
    const j = (last + 1 + k) % exs.length;
    if (left(exs[j]) != null) pick = j;
  }
  if (pick < 0) return { total, done, exercise: null, setNo: null, setOf: null, target: null };
  const x = exs[pick];
  const setNo = left(x)!;
  const setOf = rogue ? Math.max(x.sets, ...x.logs.keys()) : x.sets;
  const kg = gymId != null && String(gymId) in x.kgAt ? x.kgAt[gymId] : x.kg;
  const target = rogue || x.swap ? null : targetWords(kg, x.reps, x.unit ?? "kg");
  return { total, done, exercise: x.swap ?? x.name, setNo, setOf, target };
}

/** What the pill shows, or null for nothing going. `name` or `gym` undefined: not known here (the pill keeps its own). */
export function liveShown(read: Read | null, overlay: readonly WorkoutEntry[], h: ReturnType<typeof readHints>, endsSeen: ReadonlyMap<number, number> = new Map()): Shown | null {
  const s = read?.now.session ?? null;
  type Cur = { dayId: number; startedMs: number; name?: string; gymId?: number | null };
  let cur: Cur | null = s ? { dayId: s.id, startedMs: s.startedMs, name: s.label, gymId: s.gymId } : null;
  // A hint stands until the server's read from after it, or an end of that day seen here since (gone from the outbox
  // once sent, it must not bring the session back while no read has come in after it).
  const since = read?.t ?? 0;
  const events: { at: number; i: number; hint?: LiveHint; entry?: WorkoutEntry }[] = [];
  for (const hint of h.hints) {
    // A Reopen soon after the end (19 Nov, Alex: "ended by mistake"): the end stays in the overlay for 20 s once sent, so
    // the hint after it stands too, even past a newer read, or the pill would drop and come back.
    const endBefore = hint.live && overlay.some((e) => (e.kind === "end" || e.kind === "discard") && e.dayId === hint.dayId && (Date.parse(e.at) || 0) < hint.at);
    if ((hint.at > since || endBefore) && !((endsSeen.get(hint.dayId) ?? 0) > hint.at)) events.push({ at: hint.at, i: events.length, hint });
  }
  for (const entry of overlay) {
    if (entry.kind === "start" || entry.kind === "end" || entry.kind === "discard" || entry.kind === "gym") events.push({ at: Date.parse(entry.at) || 0, i: events.length, entry });
  }
  events.sort((a, b) => a.at - b.at || a.i - b.i);
  const gymOf = new Map<number, number>();
  for (const { hint, entry } of events) {
    if (hint) {
      if (hint.live) cur = { dayId: hint.dayId, startedMs: hint.startedMs, name: hint.name, gymId: hint.gymId };
      else if (cur?.dayId === hint.dayId) cur = null;
    } else if (entry) {
      if (entry.kind === "gym") {
        gymOf.set(entry.dayId, entry.gymId);
        if (cur?.dayId === entry.dayId) cur = { ...cur, gymId: entry.gymId };
      } else if (entry.kind === "start") {
        // A session the server has going keeps its own start (applyWorkoutOutbox).
        if (cur?.dayId !== entry.dayId) {
          const ms = Date.parse(entry.at);
          cur = Number.isFinite(ms) ? { dayId: entry.dayId, startedMs: ms, ...(gymOf.has(entry.dayId) ? { gymId: gymOf.get(entry.dayId) } : {}) } : cur;
        }
      } else if (cur?.dayId === entry.dayId) cur = null;
    }
  }
  if (!cur) return null;
  const dayId = cur.dayId;
  const named = h.names.get(dayId);
  const fromServer = s?.id === dayId ? s : null;
  const name = cur.name ?? named?.name ?? fromServer?.label;
  const gymId = cur.gymId !== undefined ? cur.gymId : named ? named.gymId : fromServer ? fromServer.gymId : undefined;
  const gym = gymId === undefined ? undefined : gymId === null ? null : h.gymNames.get(gymId) ?? read?.now.gyms[gymId];
  // The sets: the server's, then what waits for this day, each set once.
  const sets = new Set(fromServer?.sets ?? []);
  for (const e of overlay) {
    if (e.dayId !== dayId) continue;
    if (e.kind === "set") sets.add(`${e.assignmentId}:${e.setNumber}`);
    else if (e.kind === "discard") sets.clear();
    else if (e.kind === "rows") {
      for (const k of [...sets]) {
        if (k.startsWith(`${e.assignmentId}:`) && Number(k.slice(k.indexOf(":") + 1)) > e.rows) sets.delete(k);
      }
    }
  }
  // The set next, from the server's exercises of this session (19 Nov, Alex: C); not known before it has the session.
  // (A read from the build before C has no exercises: not known either.)
  const found = fromServer?.exercises ? nextSet(fromServer.exercises, !!fromServer.rogue, overlay, dayId, gymId === undefined ? fromServer.gymId : gymId) : undefined;
  const { done, ...next } = found ?? {};
  // With a total, the sets are the planned ones done, so an extra set never reads past it; without, every set logged.
  const count = found && next.total != null && done != null ? done : sets.size;
  return { dayId, startedAt: cur.startedMs, ...(name ? { name } : {}), ...(gym !== undefined ? { gym } : {}), sets: count, ...(found ? { next } : {}) };
}

export function useLiveActivitySync(clientId: number, enabled: boolean, fromPage: LiveNow | null) {
  const { overlay } = useWorkoutOutbox();
  const hintsAt = useSyncExternalStore(subscribeHints, hintsVersion, () => 0);
  const pageKey = fromPage ? JSON.stringify(fromPage) : "";
  const pageRead = useRef<Read | null>(null);
  const fetched = useRef<Read | null>(null);
  const overlayNow = useRef(overlay);
  const last = useRef<string | null>(null);
  const endsSeen = useRef(new Map<number, number>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const force = useRef(true);

  const act = () => {
    timer.current = null;
    if (!liveActivityAvailable()) return;
    const reads = [pageRead.current, fetched.current].filter((r): r is Read => r != null);
    const read = reads.sort((a, b) => b.t - a.t)[0] ?? null;
    for (const e of overlayNow.current) {
      const at = Date.parse(e.at);
      if ((e.kind === "end" || e.kind === "discard") && at > (endsSeen.current.get(e.dayId) ?? 0)) endsSeen.current.set(e.dayId, at);
    }
    const shown = liveShown(read, overlayNow.current, readHints(), endsSeen.current);
    const key = shown ? JSON.stringify(shown) : "none";
    if (!force.current && key === last.current) return;
    force.current = false;
    last.current = key;
    if (!shown) {
      liveSync(null);
      return;
    }
    const url = `${window.location.origin}/client?workout=${shown.dayId}`;
    // Finish on the pill opens the wrap-up (19 Nov, Alex: C); the coach's name and colour as the latest read has them.
    const finishUrl = `${url}&finish=1`;
    const coach = read?.now.coach ?? null;
    const brand = read?.now.brand ?? null;
    if (shown.name) liveStart({ dayId: shown.dayId, startedAt: shown.startedAt, name: shown.name, gym: shown.gym ?? null, sets: shown.sets, url, finishUrl, coach, brand, ...shown.next });
    else {
      // Started on this phone before a reload (its name only in the outbox's day): the pill showing is kept as it is.
      liveSync({ dayId: shown.dayId, startedAt: shown.startedAt });
      liveUpdate({ dayId: shown.dayId, sets: shown.sets, ...(shown.gym !== undefined ? { gym: shown.gym } : {}), ...shown.next });
    }
  };
  const schedule = (again = false) => {
    if (again) force.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(act, SETTLE_MS);
  };

  // The page's read, stamped when what it says changes (a read saying the same again is no newer news).
  useEffect(() => {
    if (!enabled) return;
    pageRead.current = fromPage ? { now: fromPage, t: Date.now() } : null;
    schedule();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- by what it says
  }, [pageKey, enabled]);

  useEffect(() => {
    overlayNow.current = overlay;
    if (!enabled) return;
    schedule();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on what waits and the hints
  }, [overlay, hintsAt, enabled]);

  // Read again on opening and back in front; stamped when it was asked, so a hint made while it was out still stands.
  useEffect(() => {
    if (!enabled) return;
    let gone = false;
    const read = () => {
      if (!liveActivityAvailable()) return;
      const asked = Date.now();
      // The pill is put back once the fresh read is in (19 Nov: from the old reads it could flash up for a session ended
      // elsewhere meanwhile); offline, from what is known.
      liveSessionNowAction(clientId)
        .then((now) => {
          if (gone) return;
          if (now) fetched.current = { now, t: asked };
          schedule(true);
        })
        .catch(() => {
          if (!gone) schedule(true);
        });
    };
    read();
    const back = () => {
      if (document.visibilityState !== "visible") return;
      read();
    };
    document.addEventListener("visibilitychange", back);
    return () => {
      gone = true;
      document.removeEventListener("visibilitychange", back);
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once a client
  }, [clientId, enabled]);
}
