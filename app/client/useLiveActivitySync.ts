"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { useWorkoutOutbox, type WorkoutEntry } from "../components/workoutOutbox";
import { liveActivityAvailable, liveStart, liveSync, liveUpdate, type LiveNow } from "../lib/liveActivity";
import { liveSessionNowAction } from "../lib/liveSessionActions";
import { hintsVersion, readHints, subscribeHints, type LiveHint } from "./liveHints";

// The lock-screen pill follows the session going (19 Nov, Alex: "I forget to complete the workout and it runs"). There is
// no one place a session starts or ends, so it is worked out from three: what the server says (with the page, and read
// again as the app opens and comes back to the front: an end on another device, the 12 h end, the coach deleting it),
// laid over by what waits in the workout's outbox (a start, an end, a discard, a gym, the sets), laid over by the hints
// for what the outbox never sees (a rogue session, Reopen; liveHints.ts). Mounted once in the app's shell; never in the
// coach's phone preview, and nothing at all in a browser or an app without the plugin.

type Read = { now: LiveNow; t: number };
type Shown = { dayId: number; startedAt: number; name?: string; gym?: string | null; sets: number };

const SETTLE_MS = 400;

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
  return { dayId, startedAt: cur.startedMs, ...(name ? { name } : {}), ...(gym !== undefined ? { gym } : {}), sets: sets.size };
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
    if (shown.name) liveStart({ dayId: shown.dayId, startedAt: shown.startedAt, name: shown.name, gym: shown.gym ?? null, sets: shown.sets, url });
    else {
      // Started on this phone before a reload (its name only in the outbox's day): the pill showing is kept as it is.
      liveSync({ dayId: shown.dayId, startedAt: shown.startedAt });
      liveUpdate({ dayId: shown.dayId, sets: shown.sets, ...(shown.gym !== undefined ? { gym: shown.gym } : {}) });
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
