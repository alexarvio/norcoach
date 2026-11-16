"use client";

import { useEffect, useState } from "react";
import { enqueueWorkout } from "../../components/workoutOutbox";
import { useKeptDraft } from "../../components/chatOutbox";
import type { SessionDay } from "../workoutShared";
import { DRAFT_PREFIX } from "./useExerciseSets";

// Ending, discarding and saving an edit, with the note to the coach and the answers, for the workout sheet. Copied from
// WorkoutScreen.tsx (:223-273) until the pager goes; the same outbox calls (`end`, `discard`), the same kept note.

/** The sheet's typed figures for the session, gone with it. */
function dropDrafts(dayId: number) {
  try {
    const prefix = DRAFT_PREFIX(dayId);
    for (let i = window.sessionStorage.length - 1; i >= 0; i--) {
      const k = window.sessionStorage.key(i);
      if (k && k.startsWith(prefix)) window.sessionStorage.removeItem(k);
    }
    // And its place on the sheet: the next start opens at the top.
    window.sessionStorage.removeItem("ironline.client.ws-scroll");
  } catch {}
}

export function useSessionEnd(day: SessionDay, cb: { onEnded: () => void; onDiscarded: () => void; onEdited?: () => void }) {
  const session = { dayId: day.key, startedAt: day.startedAt };
  // The note to the coach is kept on the phone as it is typed (7 Nov), so a closed app or a reload never loses it.
  const noteKey = `session-note.${day.key}`;
  const [note, setNote] = useKeptDraft(noteKey);
  useEffect(() => {
    const t = setTimeout(() => setNote((cur) => cur || day.sessionNote, false), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on opening
  }, []);
  const dropKeptNote = () => {
    try {
      window.localStorage.removeItem(`norcoach.draft.${noteKey}`);
    } catch {}
  };
  const [answers, setAnswers] = useState<Record<string, number | string | null>>(day.answers);
  const [ending, setEnding] = useState(false);
  const answerList = () => day.questions.map((q) => ({ id: q.id, value: answers[q.id] ?? null }));
  const end = () => {
    if (ending) return;
    setEnding(true);
    dropDrafts(day.key);
    // A rogue session ended with nothing in it is not kept (19 Oct): it goes, as when left empty.
    if (day.free && day.exercises.length === 0 && day.cardio.length === 0) {
      enqueueWorkout({ kind: "discard", ...session });
      dropKeptNote();
      cb.onDiscarded();
      return;
    }
    enqueueWorkout({ kind: "end", note, answers: answerList(), endAt: new Date().toISOString(), edit: false, ...session });
    dropKeptNote();
    setTimeout(cb.onEnded, 900);
  };
  const saveEdit = () => {
    if (ending) return;
    setEnding(true);
    dropDrafts(day.key);
    enqueueWorkout({ kind: "end", note, answers: answerList(), endAt: day.endedAt ?? new Date().toISOString(), edit: true, ...session });
    dropKeptNote();
    cb.onEdited?.();
  };
  /** Asked first by the screen, in its menu (never the browser's alert). */
  const discard = () => {
    enqueueWorkout({ kind: "discard", ...session });
    dropDrafts(day.key);
    dropKeptNote();
    cb.onDiscarded();
    return true;
  };
  return { note, setNote, answers, setAnswers, ending, end, saveEdit, discard };
}
