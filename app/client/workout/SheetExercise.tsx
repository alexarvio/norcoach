"use client";

import { useRef, useState } from "react";
import { fmtWeight, kgToDisplay } from "../../lib/units";
import { askShown, VideoAskLine, VideoAskSheet } from "../VideoAskSheet";
import { shownName, targetColumns, type SessionExercise } from "../workoutShared";
import ExerciseCoachNote from "../ExerciseCoachNote";
import CoachSays from "../CoachSays";
import { MenuIcon } from "../WorkoutScreen";
import { useOpenMessages } from "../CheckInContext";
import SwapExerciseDialog from "./SwapExerciseDialog";
import RingEdge from "../../components/RingEdge";
import DoneCheck from "../../components/DoneCheck";
import { NoteIcon } from "../../components/icons";
import { useExerciseSets, type SheetRow } from "./useExerciseSets";
import { weightTone } from "./setRules";
import { BlockMenu, BlockRing, BlockTitle, ChatGlyph, CheckGlyph, FoldedLine, MoreGlyph, PlayGlyph, SwapRow, TargetLine, ToolButton, UnitGlyph, WsFold, targetParts, useBlockFold, useBlockMenu } from "./sheetParts";

// One exercise on the workout sheet (15 Nov, Alex: docs/boards/workout-sheet-a-mockup.html): its head (the number ring,
// the name, the demo, the chat and the ⋯), the ask's line, the swap, the target line, the coach's note and your note,
// then the sets as a grid, Set | Last | kg | Reps | PB | tick (no Last with nothing to compare). Typing changes what is
// typed, the tick logs the set; the one thing that moves is the block folding to one line a second after the client's
// tick of its last set.

/** A file the app can play itself (an upload, or a plain video file), as the pager's demo (ExercisePage.tsx :49). */
const playable = (url: string) => url.startsWith("/uploads/") || /\.(mp4|webm|mov|m4v)(\?|$)/i.test(url);
const signed = (d: number) => `${d > 0 ? "+" : "−"}${fmtWeight(Math.abs(d))}`;

export default function SheetExercise({
  exercise,
  index,
  dayId,
  dayTitle,
  session,
  gymId,
  coachName,
  coachPhoto = null,
  free,
  done,
  inView,
  blockRef,
}: {
  exercise: SessionExercise;
  /** Its number on the sheet, from 1. */
  index: number;
  dayId: number;
  dayTitle: string;
  session: { dayId: number; startedAt: string | null };
  gymId: number | null;
  coachName: string;
  coachPhoto?: string | null;
  /** A rogue session: no targets, no notes, no PB, the weight always asked. */
  free: boolean;
  /** Every working set in (a rogue session's: anything logged), as the screen's segments read it. */
  done: boolean;
  /** The block the screen is on (by scroll): its ring in ink, and the coach's note read. */
  inView: boolean;
  blockRef: (el: HTMLElement | null) => void;
}) {
  const s = useExerciseSets(exercise, { gymId, session, free });
  const menu = useBlockMenu();
  const own = useRef<HTMLElement | null>(null);
  const setRef = (el: HTMLElement | null) => {
    own.current = el;
    blockRef(el);
  };
  // The fold (15 Nov, Alex): a second after the tick that logs the last working set still to do, to one line. Never on a
  // rogue session, whose sets are added one at a time (each tick would be its last, hiding + Add a set).
  const fold = useBlockFold(s.allDone && !free, () => own.current, s.lastTicks);
  const openMessages = useOpenMessages();
  const name = shownName(exercise);
  const ask = exercise.videoRequest;
  const swapped = s.swapped;

  // The coach's note is read once its block has been in view (the pager read it on its page): never all on opening.
  const [seen, setSeen] = useState(inView);
  if (inView && !seen) setSeen(true);

  const [swapOpen, setSwapOpen] = useState(false);
  const [videoOpen, setVideoOpen] = useState(false);
  const [mediaAbout, setMediaAbout] = useState<"swap" | null>(null);
  const [demoOpen, setDemoOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [askWarm, setAskWarm] = useState<string | null>(null);

  const openDemo = () => {
    if (!exercise.videoUrl) return;
    if (playable(exercise.videoUrl)) setDemoOpen(true);
    else window.open(exercise.videoUrl, "_blank", "noopener");
  };
  const openAsk = () => {
    setMediaAbout(null);
    setVideoOpen(true);
  };

  // ---- The ⋯ (15 Nov, Alex: the mockup's menu): Warm-up, Substitute today, Your note, a photo or video unasked, kg | lbs.
  const canWarm = s.warmAddable;
  const canSwap = !free;
  const canNote = !swapped && !free;
  const canMedia = !askShown(ask, swapped) || !!ask?.fromClient;
  const canUnit = s.askWeight;
  const items = [canWarm, canSwap, canNote, canMedia, canUnit].filter(Boolean).length;
  const pick = (f: () => void) => () => {
    menu.close();
    f();
  };

  // ---- The target line: one line in place of the band; a swap keeps it faint, as a guide for what it replaced.
  const cols = targetColumns({ sets: exercise.coachSets ?? exercise.sets, reps: exercise.reps, weightKg: s.targetWeight, unit: s.unit, rpe: s.targetRpe, tempo: exercise.tempo, rest: exercise.rest, time: exercise.time, distance: exercise.distance });
  const guideCols = targetColumns({ sets: exercise.coachSets ?? exercise.sets, reps: exercise.reps });
  const showKg = s.askWeight || s.hasWarm;
  // No Last column with nothing to compare (15 Nov, Alex: the first week, or a swap): the slots take its room.
  const hasLast = s.workRows.some((r) => s.lastOf(r.n) != null) || s.rows.some((r) => r.kind === "warm" && !r.gone && r.warmLast != null);
  const targetLine = free ? null : swapped ? <TargetLine guide parts={[...targetParts(guideCols).slice(0, 1), `for ${exercise.name}`]} /> : <TargetLine parts={targetParts(cols)} />;

  // The folded line's facts: how many sets, then the heaviest working set and its reps (a lift with no weight, the count).
  const doneWork = s.workRows.filter((r) => r.done && r.logged);
  let best: { kg: number; reps: number | null } | null = null;
  for (const r of doneWork) {
    const kg = r.logged?.weightKg;
    if (kg == null) continue;
    const reps = r.logged?.reps ?? null;
    if (!best || kg > best.kg || (kg === best.kg && (reps ?? 0) > (best.reps ?? 0))) best = { kg, reps };
  }
  const foldFacts = [`${doneWork.length} set${doneWork.length === 1 ? "" : "s"}`, ...(s.askWeight && best ? [`${fmtWeight(kgToDisplay(best.kg, s.unit))} × ${best.reps ?? "–"}`] : [])];
  // Folded and then no longer complete (a set the server refused): the line says so in rust, never a done check.
  const notSaved = s.workRows.filter((r) => !r.done && r.refused != null).length;
  const foldAlert = notSaved ? `${notSaved} set${notSaved === 1 ? "" : "s"} not saved` : null;

  return (
    <section ref={setRef} className={`ws-block lw${fold.folded ? " folded" : ""}`} data-ex={exercise.id} aria-label={name}>
      <WsFold open={fold.folded} easing={fold.easing}>
        <FoldedLine
          name={name}
          facts={foldFacts}
          done={s.allDone}
          alert={s.allDone ? null : foldAlert}
          check={s.allDone ? <DoneCheck size={22} /> : <BlockRing n={index} done={false} on={false} doneCheck={null} />}
          onOpen={fold.open}
        />
      </WsFold>
      <WsFold open={!fold.folded} easing={fold.easing}>
      <div className="ws-bh">
        <BlockTitle
          ring={<BlockRing n={index} done={done} on={inView || s.started} doneCheck={<DoneCheck size={22} />} />}
          name={name}
          onFold={s.allDone && !free ? fold.close : undefined}
        />
        <div className="ws-tools">
          {/* Swapped, a naked sheet (4 Nov, Alex): the demo is the exercise it replaced, so none. */}
          {exercise.videoUrl && !swapped && (
            <ToolButton label={`Play the demo of ${name}`} onClick={openDemo}>
              <PlayGlyph />
            </ToolButton>
          )}
          {openMessages && (
            <ToolButton label={`Message ${coachName} about ${name}`} onClick={() => openMessages({ link: { kind: "exercise", dayId, assignmentId: exercise.id }, label: `${name} · ${dayTitle}` })}>
              <ChatGlyph />
            </ToolButton>
          )}
          {items > 0 && (
            <ToolButton label="More" expanded={menu.open} onClick={(e) => menu.toggle(e, items)}>
              <MoreGlyph />
            </ToolButton>
          )}
        </div>
      </div>

      <BlockMenu menu={menu} label={name}>
        {canWarm && (
          <button type="button" role="menuitem" className="wo-menu-row ico ws-mi-warm" onClick={pick(s.addWarm)}>
            <MenuIcon kind="warmup" />
            Warm-up
          </button>
        )}
        {canSwap && (
          <button type="button" role="menuitem" className="wo-menu-row ico" onClick={pick(() => setSwapOpen(true))}>
            <MenuIcon kind="swap" />
            {exercise.swap ? "Change today's substitute" : "Substitute today"}
          </button>
        )}
        {canNote && (
          <button type="button" role="menuitem" className="wo-menu-row ico" onClick={pick(() => setNoteOpen(true))}>
            <MenuIcon kind="note" />
            {s.myNote.trim() ? "Edit your note" : "Your note"}
          </button>
        )}
        {canMedia && (
          <button type="button" role="menuitem" className="wo-menu-row ico" onClick={pick(openAsk)}>
            <MenuIcon kind="media" />
            Send a photo or video
          </button>
        )}
        {canUnit && (
          <button type="button" role="menuitem" className="wo-menu-row ico" onClick={pick(() => s.setUnitTo(s.unit === "kg" ? "lb" : "kg"))}>
            <UnitGlyph />
            {s.unit === "kg" ? "Use lbs" : "Use kg"}
          </button>
        )}
      </BlockMenu>

      <div className="ws-bbody">
        {askShown(ask, swapped) && <VideoAskLine ask={ask} coachName={coachName} onOpen={openAsk} />}
        {exercise.swap && <SwapRow name={exercise.name} onUndo={() => s.saveSwap(null)} />}
        {targetLine}

        {/* Swapped (17 Oct, Alex): the coach's note was for the exercise it replaced; their note on a substitute they
            suggested shows instead. */}
        {!swapped && !free && (
          <ExerciseCoachNote
            assignmentId={exercise.id}
            dateLabel={exercise.note.dateLabel}
            text={exercise.note.text}
            unread={exercise.note.unread && seen}
            label={coachName}
          />
        )}
        {s.swapNote && (
          <div className="ts-coachnote">
            <CoachSays label={coachName}>{s.swapNote}</CoachSays>
          </div>
        )}

        {canNote && <SheetNote note={s.myNote} open={noteOpen} setOpen={setNoteOpen} onSave={s.saveNote} onDelete={s.deleteNote} />}

        {/* No kg column on a lift with no weight, unless a warm-up (which always has one) is on it. */}
        <div className={`ws-grid${showKg ? "" : " nokg"}${hasLast ? "" : " nolast"}`} aria-label={`${name} sets`}>
          <div className="ws-gh" aria-hidden="true">
            <span>Set</span>
            {hasLast && <span>Last</span>}
            {showKg && <span className="c">{s.unit === "kg" ? "kg" : "lbs"}</span>}
            <span className="c">Reps</span>
            <span />
            <span />
          </div>
          {s.rows.map((row) => {
            const set = (
              <SetRow
                key={row.id}
                row={row}
                s={s}
                showKg={showKg}
                hasLast={hasLast}
                free={free}
                askingWarm={askWarm === row.id}
                onAskWarm={(v) => setAskWarm(v ? row.id : null)}
              />
            );
            // A warm-up on the shared fold: an untouched one folds away once every set is in.
            return row.kind === "warm" ? (
              <WsFold key={row.id} open={!row.gone} easing>
                {set}
              </WsFold>
            ) : (
              set
            );
          })}
        </div>

        <div className="ws-setacts">
          {s.askRemove ? (
            <>
              <span className="ws-setask">Remove set {s.workCount}?</span>
              <button type="button" className="ws-word" onClick={() => s.setAskRemove(false)}>
                Cancel
              </button>
              <button type="button" className="ws-word rust" onClick={s.removeLast}>
                Remove
              </button>
            </>
          ) : (
            // On the right under the ticks, Add the outermost (16 Nov, Alex: "most people are using the phone with the right hand").
            <>
              {s.workCount > 1 && (
                <button type="button" className="ws-word" onClick={s.tapRemove}>
                  − Remove a set
                </button>
              )}
              <button type="button" className="ws-word" onClick={s.addSet}>
                + Add a set
              </button>
            </>
          )}
        </div>
      </div>
      </WsFold>

      {swapOpen && (
        <SwapExerciseDialog
          exercise={{ name: exercise.name, group: exercise.group }}
          targets={{ sets: exercise.sets, reps: exercise.reps, rpe: exercise.targetRpe, time: exercise.time }}
          suggestions={exercise.alternatives}
          current={exercise.swap}
          coach={{ firstName: coachName, photo: coachPhoto }}
          photoSent={!!exercise.videoRequest && exercise.videoRequest.about === "swap" && !!exercise.videoRequest.src}
          onSwap={(choice) => {
            setSwapOpen(false);
            s.saveSwap(choice);
          }}
          onPhoto={() => {
            setSwapOpen(false);
            setMediaAbout("swap");
            setVideoOpen(true);
          }}
          onClose={() => setSwapOpen(false)}
        />
      )}
      {videoOpen && <VideoAskSheet ask={ask} assignmentId={exercise.id} about={mediaAbout} exerciseName={name} coachName={coachName} onClose={() => setVideoOpen(false)} />}
      {demoOpen && exercise.videoUrl && !swapped && (
        <div className="lw-demo-modal" role="dialog" aria-label={`${name} demo`} onClick={() => setDemoOpen(false)}>
          <button type="button" className="lw-demo-close" onClick={() => setDemoOpen(false)} aria-label="Close the demo">
            ✕
          </button>
          <video className="lw-demo-video" src={exercise.videoUrl} controls autoPlay playsInline onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </section>
  );
}

type Sets = ReturnType<typeof useExerciseSets>;

/** One row of the grid, then its line under it when it has one (on its way, refused, or the far-off question). */
function SetRow({
  row,
  s,
  showKg,
  hasLast,
  free,
  askingWarm,
  onAskWarm,
}: {
  row: SheetRow;
  s: Sets;
  showKg: boolean;
  hasLast: boolean;
  free: boolean;
  askingWarm: boolean;
  onAskWarm: (v: boolean) => void;
}) {
  const repsRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const warm = row.kind === "warm";
  const asksWeight = s.askWeight || warm;
  const label = warm ? "Warm-up" : `Set ${row.n}`;
  const last = warm ? row.warmLast : s.swapped ? null : s.lastOf(row.n);
  const lastText = !last ? "–" : warm ? `${last.weight != null ? `${fmtWeight(kgToDisplay(last.weight, s.unit))} × ` : ""}${last.reps ?? "–"}`
    : last.weight != null && s.askWeight ? `${fmtWeight(kgToDisplay(last.weight, s.unit))} × ${last.reps ?? "–"}` : last.reps != null ? `${last.reps} reps` : "–";
  const doubt = !warm && s.doubt?.n === row.n ? s.doubt : null;
  const refused = !warm && !row.done && row.refused != null ? row.refused : null;
  const cantResend = refused === "gone" || refused === "stale";
  // A refusal that can't help by sending again waits for new figures: once something is typed, the tick logs it.
  const typedSince = row.draft.w !== undefined || row.draft.r !== undefined;
  const warmEmpty = warm && !row.done && !row.draft.w && !row.draft.r;

  // A refused set sends again as it went out by a tap; once something is typed over it, it is any row: ink only once
  // both figures are typed, and the tick logs what the slots show.
  const tickState = row.done ? "done" : refused && !typedSince ? "refused" : row.ready ? "ready" : "empty";
  const onTick = () => {
    if (tickState === "refused") {
      if (!cantResend) s.resend(row);
      return;
    }
    s.tick(row);
  };
  // It ticks itself (15 Nov, Alex: "I add the weights and it goes green by itself and onto the next"): once both figures
  // are typed, leaving the row logs it, by Next on the reps or a tap anywhere outside the row. Never while typing in it,
  // and never moving between its own two figures, so a half-typed 12 is never logged as 1.
  const leave = (e: React.FocusEvent<HTMLInputElement>) => {
    const to = e.relatedTarget as Node | null;
    if (to && wrapRef.current?.contains(to)) return;
    if (tickState === "ready") s.tick(row);
  };
  // Next on the reps: on to the next set still to do (its first figure), the keyboard staying up; the last one puts it
  // away. Either way the row is left, so it logs itself above.
  const onward = (from: HTMLInputElement) => {
    const wraps = [...(wrapRef.current?.closest(".ws-grid")?.querySelectorAll<HTMLElement>(".ws-rowwrap") ?? [])];
    const at = wrapRef.current ? wraps.indexOf(wrapRef.current) : -1;
    const next = wraps.slice(at + 1).find((w) => w.querySelector(".ws-gr:not(.done)"))?.querySelector<HTMLInputElement>("input.ws-num");
    if (next) next.focus();
    else from.blur();
  };
  // A tap on a logged figure opens the row straight away to type over it (15 Nov, Alex: "if I click on the green number it
  // unchecks itself"), the figure selected so typing replaces it.
  const reopen = (e: React.FocusEvent<HTMLInputElement>) => {
    if (!row.done) return;
    const input = e.currentTarget;
    s.tick(row);
    requestAnimationFrame(() => input.select());
  };
  const tickLabel =
    tickState === "done" ? `${label} logged. Change it` : tickState === "refused" ? `${label} not saved${cantResend ? "" : ". Send again"}` : tickState === "ready" ? `Log ${label.toLowerCase()}` : `${label}: nothing to log yet`;

  return (
    <div className="ws-rowwrap" ref={wrapRef}>
      <div className={`ws-gr${row.done ? " done" : ""}${warm ? " warm" : ""}`} role="group" aria-label={label}>
        <span className="ws-sn">
          {warmEmpty ? (
            <button type="button" className="ws-sn-w" onClick={() => onAskWarm(!askingWarm)} aria-label={`Remove warm-up ${row.n}`} aria-expanded={askingWarm}>
              W
            </button>
          ) : warm ? (
            "W"
          ) : (
            row.n
          )}
        </span>
        {hasLast && <span className="ws-last">{lastText}</span>}
        {showKg && !asksWeight && <span className="ws-cell none" aria-hidden="true" />}
        {asksWeight && (
          <NumBox
            row={row}
            field="w"
            value={row.weightText}
            label={`${label} weight, ${s.unit === "kg" ? "kilograms" : "pounds"}`}
            delta={doubt ? null : row.delta.weight}
            tone={(d) => weightTone(d, s.assisted)}
            onType={(t) => s.type(row, "w", t)}
            next={() => repsRef.current?.focus()}
            onLeave={leave}
            onReopen={reopen}
          />
        )}
        <NumBox
          row={row}
          field="r"
          inputRef={repsRef}
          value={row.repsText}
          label={`${label} reps`}
          delta={doubt ? null : row.delta.reps}
          tone={(d) => (d > 0 ? "up" : "down")}
          onType={(t) => s.type(row, "r", t)}
          onNext={onward}
          onLeave={leave}
          onReopen={reopen}
        />
        <span className="ws-pbcell">
          {row.pb && !warm && !free && (
            <span className={`ws-pb${row.done ? "" : " pop"}`} role="img" aria-label="Personal best">
              PB
              <RingEdge size={24} stroke={1.5} />
            </span>
          )}
        </span>
        <span className="ws-tickcell">
          <button
            type="button"
            className={`ws-tick ${tickState}${warm ? " warm" : ""}${row.extra && !warm && !free ? " extra" : ""}`}
            onClick={onTick}
            disabled={tickState === "empty" || (tickState === "refused" && cantResend)}
            aria-label={tickLabel}
            title={tickLabel}
          >
            {tickState === "done" ? (
              <DoneCheck size={28} />
            ) : (
              <>
                <CheckGlyph />
                <RingEdge size={28} stroke={1.5} />
              </>
            )}
          </button>
        </span>
      </div>

      {askingWarm && warmEmpty ? (
        <div className="ws-under ask">
          <span>Remove warm-up?</span>
          <button type="button" className="ws-word" onClick={() => onAskWarm(false)}>
            Cancel
          </button>
          <button
            type="button"
            className="ws-word rust"
            onClick={() => {
              onAskWarm(false);
              s.removeWarm(row.id);
            }}
          >
            Remove
          </button>
        </div>
      ) : doubt ? (
        <Doubt s={s} />
      ) : refused ? (
        <div className="ws-under rust" role="status">
          Not saved
        </div>
      ) : row.late ? (
        <div className="ws-under" role="status">
          Not sent yet
        </div>
      ) : null}
    </div>
  );
}

/** Far off what this exercise is (27 Oct, Alex): asked under the row, the set logged only once answered. The words as
 *  the pager builds them (ExercisePage.tsx :853-862). */
function Doubt({ s }: { s: Sets }) {
  const d = s.doubt;
  if (!d) return null;
  const v = d.v;
  const w = v.weightKg != null ? `${fmtWeight(kgToDisplay(v.weightKg, s.unit))} ${s.uLabel}` : "";
  const ref = s.refKg != null ? `${fmtWeight(kgToDisplay(s.refKg, s.unit))} ${s.uLabel}` : "";
  const line =
    d.weight && d.reps
      ? `${w} and ${v.reps} reps are far over ${s.refFrom === "last" ? "last time" : "the target"}.`
      : d.weight
        ? `${w} is far over ${s.refFrom === "last" ? "last time" : "the target"}, ${ref}.`
        : `${v.reps} reps is far over the ${s.repTop} asked.`;
  const yes = d.weight && d.reps ? "Yes, save it" : d.weight ? `Yes, ${w}` : `Yes, ${v.reps} reps`;
  return (
    <div className="ws-doubt" role="alert">
      <p>{line}</p>
      <div className="ws-doubt-btns">
        <button type="button" className="ws-doubt-yes" onClick={s.vouch}>
          {yes}
        </button>
        {d.weight && s.unit === "kg" && (
          <button type="button" className="ws-doubt-alt" onClick={s.meantLbs}>
            I meant lbs
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * A figure's slot (15 Nov, Alex): no box, a 1.5px underline (#C9CFD8, ink while typing), 16px so the phone never zooms.
 * Empty until typed, no grey figure and no placeholder; typing only changes what is typed (never saved by itself).
 * Enter on the weight goes to the reps; Enter on the reps puts the keyboard away. Done, no underline, in the tick's colour.
 */
function NumBox({
  row,
  field,
  value,
  label,
  delta,
  tone,
  onType,
  next,
  onNext,
  onLeave,
  onReopen,
  inputRef,
}: {
  row: SheetRow;
  field: "w" | "r";
  value: string;
  label: string;
  delta: number | null;
  tone: (d: number) => "up" | "down";
  onType: (text: string) => void;
  next?: () => void;
  /** Enter on the row's last figure: on to the next set. */
  onNext?: (from: HTMLInputElement) => void;
  onLeave?: (e: React.FocusEvent<HTMLInputElement>) => void;
  onReopen?: (e: React.FocusEvent<HTMLInputElement>) => void;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  const shown = delta != null && value !== "";
  return (
    <span className={`ws-cell${row.done ? " done" : ""}`}>
      <input
        ref={inputRef}
        className="ws-num"
        type="text"
        inputMode={field === "w" ? "decimal" : "numeric"}
        autoComplete="off"
        enterKeyHint="next"
        value={value}
        aria-label={label}
        onChange={(e) => onType(e.target.value)}
        onFocus={onReopen}
        onBlur={onLeave}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          if (next) next();
          else if (onNext) onNext(e.currentTarget);
          else e.currentTarget.blur();
        }}
      />
      {shown && (
        <span className={`ws-delta ${tone(delta)}`} aria-hidden="true">
          {field === "w" ? signed(delta) : `${delta > 0 ? "+" : "−"}${Math.abs(delta)}`}
        </span>
      )}
    </span>
  );
}

/**
 * Your note on the exercise (15 Nov, Alex: the mockup's third screen): the pen alone, no ring, YOUR NOTE, the words
 * in body grey, a tap to change it. Writing, the words on a hairline underline, no box; Delete in rust words on the
 * left (only with a note to delete), Cancel in words and the small ink Save on the right.
 */
function SheetNote({ note, open, setOpen, onSave, onDelete }: { note: string; open: boolean; setOpen: (v: boolean) => void; onSave: (text: string) => void; onDelete: () => void }) {
  const [draft, setDraft] = useState(note);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setDraft(note);
  }
  const has = note.trim() !== "";
  if (!open && !has) return null;
  const grow = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  return (
    <div className={`ws-yn${open ? " ws-noteedit" : ""}`}>
      <span className="ws-yn-pen" aria-hidden="true">
        <NoteIcon size={17} />
      </span>
      <span className="ws-yn-lbl">Your note</span>
      {open ? (
        <div className="ws-yn-edit">
          <textarea
            ref={grow}
            className="ws-yn-field"
            value={draft}
            rows={1}
            autoFocus
            maxLength={500}
            aria-label="Your note"
            onChange={(e) => {
              setDraft(e.target.value);
              grow(e.currentTarget);
            }}
          />
          <div className="ws-yn-acts">
            {has && (
              <button
                type="button"
                className="ws-word rust ws-yn-del"
                onClick={() => {
                  onDelete();
                  setOpen(false);
                }}
              >
                Delete
              </button>
            )}
            <button type="button" className="ws-word" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="ws-ink-pill"
              onClick={() => {
                onSave(draft);
                setOpen(false);
              }}
            >
              Save
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="ws-yn-words" onClick={() => setOpen(true)} aria-label={`Your note: ${note}. Change it`}>
          {note}
        </button>
      )}
    </div>
  );
}
