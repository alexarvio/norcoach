"use client";

import { useRef, useState } from "react";
import { enqueueWorkout } from "../../components/workoutOutbox";
import { cardioColumns, type SessionCardio } from "../workoutShared";
import ExerciseCoachNote from "../ExerciseCoachNote";
import { MenuIcon } from "../WorkoutScreen";
import { useOpenMessages } from "../CheckInContext";
import SwapExerciseDialog from "./SwapExerciseDialog";
import DoneCheck from "../../components/DoneCheck";
import { BlockMenu, BlockRing, BlockTitle, ChatGlyph, FoldedLine, MoreGlyph, SwapRow, TargetLine, ToolButton, WsFold, targetParts, useBlockFold, useBlockMenu } from "./sheetParts";

// One cardio on the workout sheet (15 Nov, Alex: docs/boards/workout-sheet-a-mockup.html): the block's head, the swap,
// the target line, the coach's note, and Mark as done. As the pager's CardioCard (workoutShared.tsx) with the same saves
// (`cardioDone`, `cardioSwap`, `cardioFigure`), without its move on to the next page: nothing moves by itself.

export default function SheetCardio({
  cardio,
  index,
  dayId,
  dayTitle,
  session,
  coachName,
  free,
  inView,
  blockRef,
}: {
  cardio: SessionCardio;
  /** Its number on the sheet, after the exercises. */
  index: number;
  dayId: number;
  dayTitle: string;
  session: { dayId: number; startedAt: string | null };
  coachName: string;
  /** A rogue session's cardio (not being edited): no targets; the client fills in what they did. */
  free: boolean;
  inView: boolean;
  blockRef: (el: HTMLElement | null) => void;
}) {
  const save = (c: { kind: "cardioDone"; done: boolean } | { kind: "cardioSwap"; name: string | null } | { kind: "cardioFigure"; field: "time" | "pace" | "incline" | "distance"; value: string }) =>
    enqueueWorkout({ ...c, cardioId: cardio.id, dayId: session.dayId, startedAt: session.startedAt });
  const [did, setDid] = useState({ time: cardio.time, distance: cardio.distance, pace: cardio.pace, incline: cardio.incline });
  const saveDid = (k: keyof typeof did) => {
    if (did[k] !== cardio[k]) save({ kind: "cardioFigure", field: k, value: did[k] });
  };
  const [swapOpen, setSwapOpen] = useState(false);
  const menu = useBlockMenu();
  const openMessages = useOpenMessages();
  const name = cardio.swap ?? cardio.name;
  const done = cardio.done;
  const own = useRef<HTMLElement | null>(null);
  const setRef = (el: HTMLElement | null) => {
    own.current = el;
    blockRef(el);
  };
  // The fold (15 Nov, Alex): a second after Mark as done, to one line, as an exercise after its last tick.
  const fold = useBlockFold(done, () => own.current);

  const parts = targetParts(cardioColumns(cardio));
  const target = free ? null : cardio.swap ? <TargetLine guide parts={[...parts.slice(0, 1), `for ${cardio.name}`]} /> : <TargetLine parts={parts} />;
  // The folded line's facts: what was filled in (a rogue session), else the planned figures it was done to; a swap none.
  const foldFacts = free ? [did.time, did.distance].map((v) => v.trim()).filter(Boolean) : cardio.swap ? [] : parts.slice(0, 2);
  // Swapped, the coach's note on the cardio it replaced goes, their note on the substitute shows (workoutShared.tsx :358).
  const note = (cardio.swap ? cardio.alternatives.find((a) => a.name === cardio.swap)?.note?.trim() : cardio.notes) || null;

  return (
    <section ref={setRef} className={`ws-block ws-cardio lw${done ? " done" : ""}${fold.folded ? " folded" : ""}`} data-cardio={cardio.id} aria-label={name}>
      <WsFold open={fold.folded} easing={fold.easing}>
        <FoldedLine name={name} facts={foldFacts} done={done} check={done ? <DoneCheck size={22} /> : <BlockRing n={index} done={false} on={false} doneCheck={null} />} onOpen={fold.open} />
      </WsFold>
      <WsFold open={!fold.folded} easing={fold.easing}>
      <div className="ws-bh">
        <BlockTitle ring={<BlockRing n={index} done={done} on={inView} doneCheck={<DoneCheck size={22} />} />} name={name} onFold={done && !free ? fold.close : undefined} />
        <div className="ws-tools">
          {openMessages && (
            <ToolButton label={`Message ${coachName} about ${dayTitle}`} onClick={() => openMessages({ link: { kind: "session", dayId }, label: dayTitle })}>
              <ChatGlyph />
            </ToolButton>
          )}
          {!free && (
            <ToolButton label="More" expanded={menu.open} onClick={(e) => menu.toggle(e, 1)}>
              <MoreGlyph />
            </ToolButton>
          )}
        </div>
      </div>
      <BlockMenu menu={menu} label={name}>
        <button
          type="button"
          role="menuitem"
          className="wo-menu-row ico"
          onClick={() => {
            menu.close();
            setSwapOpen(true);
          }}
        >
          <MenuIcon kind="swap" />
          {cardio.swap ? "Change today's substitute" : "Substitute today"}
        </button>
      </BlockMenu>

      <div className="ws-bbody">
        {cardio.swap && <SwapRow name={cardio.name} onUndo={() => save({ kind: "cardioSwap", name: null })} />}
        {target}
        {free && (
          <div className="ws-cardio-did">
            {(
              [
                ["time", "Minutes"],
                ["distance", "Km"],
                ["pace", "Km/h"],
                ["incline", "Incline %"],
              ] as const
            ).map(([k, label]) => (
              <label key={k} className="ws-cardio-field">
                <span>{label}</span>
                <input value={did[k]} onChange={(e) => setDid((d) => ({ ...d, [k]: e.target.value }))} onBlur={() => saveDid(k)} inputMode="decimal" placeholder="–" aria-label={label} autoComplete="off" />
              </label>
            ))}
          </div>
        )}
        <ExerciseCoachNote assignmentId={null} dateLabel="" text={note} unread={false} label={coachName} />
        <div className="ws-cardio-foot">
          <button
            type="button"
            className={`ws-cardio-done${done ? " is-done" : ""}`}
            onClick={() => {
              if (!done) fold.arm();
              save({ kind: "cardioDone", done: !done });
            }}
            aria-pressed={done}
          >
            {done ? (
              <>
                <DoneCheck size={22} />
                Done
              </>
            ) : (
              "Mark as done"
            )}
          </button>
        </div>
      </div>
      </WsFold>

      {swapOpen && (
        <SwapExerciseDialog
          exercise={{ name: cardio.name, group: "cardio" }}
          targets={{ sets: 1, reps: "", rpe: null, time: cardio.time || null }}
          suggestions={cardio.alternatives.map((a, i) => ({ id: i, name: a.name, note: a.note, video: null }))}
          current={
            cardio.swap
              ? {
                  libraryExerciseId: (() => {
                    const i = cardio.alternatives.findIndex((a) => a.name === cardio.swap);
                    return i >= 0 ? i : null;
                  })(),
                  name: cardio.swap,
                }
              : null
          }
          coach={{ firstName: coachName, photo: null }}
          onSwap={(choice) => {
            setSwapOpen(false);
            // A library pick names itself; a suggestion is its place in the alternatives.
            const picked = choice.customName ?? (choice.libraryExerciseId != null ? cardio.alternatives[choice.libraryExerciseId]?.name : null);
            if (picked) save({ kind: "cardioSwap", name: picked });
          }}
          onClose={() => setSwapOpen(false)}
        />
      )}
    </section>
  );
}
