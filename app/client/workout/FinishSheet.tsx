"use client";

import { Scale } from "../WorkoutScreen";
import SwipeToEnd from "../SwipeToEnd";
import { isDone, loggedCount, shownName, tidyDecimal, type SessionDay } from "../workoutShared";

// The workout sheet's finish (15 Nov, Alex: docs/boards/workout-sheet-a-mockup.html): a sheet from the foot in the shared
// voice, what is left if anything, the coach's questions and the note to them as the pager's wrap-up has them
// (WorkoutScreen.tsx :595-632), then the swipe to end, or Save changes when a finished session is being edited.

/** What is left, as facts: `Leg curl not done | 2 sets not ticked`; nothing when everything is in. */
export function leftParts(day: SessionDay): string[] {
  const free = !!day.free;
  const untouched = [
    ...day.exercises.filter((ex) => loggedCount(ex) === 0 && ex.logs.length === 0).map(shownName),
    ...day.cardio.filter((c) => !c.done).map((c) => c.swap ?? c.name),
  ];
  const named = untouched.slice(0, 2).map((n) => `${n} not done`);
  const more = untouched.length - named.length;
  const parts = more > 0 ? [...named, `${more} more not done`] : named;
  if (!free) {
    const sets = day.exercises.filter((ex) => loggedCount(ex) > 0 && !isDone(ex)).reduce((t, ex) => t + (ex.sets - loggedCount(ex)), 0);
    if (sets > 0) parts.push(`${sets} set${sets === 1 ? "" : "s"} not ticked`);
  }
  return parts;
}

export default function FinishSheet({
  day,
  editing,
  locked,
  ended,
  coachName,
  note,
  setNote,
  answers,
  setAnswers,
  ending,
  onEnd,
  onSaveEdit,
  onClose,
}: {
  day: SessionDay;
  editing: boolean;
  /** Ended and not being edited: the answers and the note read only. */
  locked: boolean;
  ended: boolean;
  coachName: string;
  note: string;
  setNote: (v: string) => void;
  answers: Record<string, number | string | null>;
  setAnswers: (f: (a: Record<string, number | string | null>) => Record<string, number | string | null>) => void;
  ending: boolean;
  onEnd: () => void;
  onSaveEdit: () => void;
  onClose: () => void;
}) {
  return (
    <div className="wo-sheet-scrim" onClick={onClose}>
      <div className="wo-sheet ws-finish" role="dialog" aria-label={editing ? "Save changes" : `Finish ${day.title}`} onClick={(e) => e.stopPropagation()}>
        <span className="wo-sheet-grab" aria-hidden="true" />
        <div className="ws-finish-head">
          <h2 className="wo-sheet-title">{editing ? "Save changes" : `Finish ${day.title}`}</h2>
          <button type="button" className="ws-x" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden="true" focusable="false">
              <path vectorEffect="non-scaling-stroke" d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
        {/* No word on what is left (15 Nov, Alex: "do not say what I haven't completed"): the questions, the note, the swipe. */}
        <div className="wo-page-inner wo-wrap ws-finish-body">
          {day.questions.length > 0 && (
            <div className="wo-ask">
              <div className="wo-ask-head">
                <span className="wo-note-label">How was it?</span>
              </div>
              {day.questions.map((q) => {
                const v = answers[q.id] ?? null;
                const set = (x: number | string | null) => setAnswers((a) => ({ ...a, [q.id]: x }));
                // A number with its unit, words in a box, or the ten pills.
                if (q.kind === "number")
                  return (
                    <label key={q.id} className="wo-scale wo-ask-field">
                      <span className="wo-scale-head">
                        <b>{q.label}</b>
                      </span>
                      <span className="wo-ask-num">
                        <input value={v == null ? "" : String(v)} onChange={(e) => set(e.target.value)} onInput={tidyDecimal} inputMode="decimal" placeholder="0" disabled={locked} aria-label={q.label} />
                        {q.unit && <small>{q.unit}</small>}
                      </span>
                    </label>
                  );
                if (q.kind === "text")
                  return (
                    <label key={q.id} className="wo-scale wo-ask-field">
                      <span className="wo-scale-head">
                        <b>{q.label}</b>
                      </span>
                      <textarea className="wo-note-input" rows={2} maxLength={500} value={typeof v === "string" ? v : ""} onChange={(e) => set(e.target.value)} disabled={locked} aria-label={q.label} />
                    </label>
                  );
                return <Scale key={q.id} label={q.label} value={typeof v === "number" ? v : null} onChange={set} disabled={locked} />;
              })}
            </div>
          )}
          <div className="wo-coach-note">
            <span className="wo-note-label">Anything to mention to {coachName}?</span>
            <textarea className="wo-note-input" rows={2} value={note} placeholder="How did it feel? Anything to flag?" onChange={(e) => setNote(e.target.value)} disabled={locked} />
          </div>
        </div>
        <div className="ws-finish-foot">
          {editing ? (
            <button type="button" className="wo-save-edit" onClick={onSaveEdit} disabled={ending}>
              {ending ? "Saving…" : "Save changes"}
            </button>
          ) : (
            <SwipeToEnd onEnd={onEnd} done={ended} />
          )}
        </div>
      </div>
    </div>
  );
}
