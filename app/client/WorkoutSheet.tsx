"use client";

import "./workout-sheet.css";
import { useEffect, useRef, useState } from "react";
import { useDismiss } from "./useDismiss";
import { ChatIcon, ChevronLeftIcon } from "../components/icons";
import { useOpenMessages } from "./CheckInContext";
import type { GymOption } from "./GymPickerDialog";
import GymPickerDialog, { BadgeFace } from "./GymPickerDialog";
import { gymColor } from "../lib/gymColors";
import RestTimerPill, { useRestTimer } from "./RestTimer";
import FreeAddPage from "./FreeAddPage";
import { SwapLibrary } from "./workout/SwapExerciseDialog";
import { Bars } from "./Bars";
import { MenuIcon } from "./WorkoutScreen";
import { landOnSoon } from "../lib/landOn";
import { clock, elapsedMs, isDone, loggedCount, shownName, useTicker, type LibraryPick, type SessionDay, type SessionExercise } from "./workoutShared";
import SheetExercise from "./workout/SheetExercise";
import SheetCardio from "./workout/SheetCardio";
import FinishSheet from "./workout/FinishSheet";
import { SheetHost } from "./workout/sheetParts";
import { useSessionEnd } from "./workout/useSessionEnd";

// The workout as one sheet (15 Nov, Alex: docs/boards/workout-sheet-a-mockup.html; on test behind WORKOUT_SHEET,
// lib/workoutSheet.ts): every exercise open as a block, in order, then the cardio, then (a rogue session) Add an
// exercise, scrolled by the finger alone. Nothing moves by itself: no advance, no timer that changes the page; the one
// move is a block folding to one line a second after the client's tick of its last set (or Mark as done). A set is
// logged by its tick. The dock holds the rest timer and Finish, which opens the wrap-up as a sheet. The same
// props as the pager (WorkoutScreen), which stays as it is for everyone the switch is off for.

const SCROLL_KEY = "ironline.client.ws-scroll";
const NO_LIBRARY: LibraryPick[] = [];

// The place is this start's alone (16 Nov, Alex: a session discarded halfway and started again opened on exercise 4):
// a new start, a new startedAt, always opens at the top.
function readScroll(dayId: number, startedAt: string | null, editing: boolean): number | null {
  try {
    const raw = window.sessionStorage.getItem(SCROLL_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { dayId: number; startedAt?: string | null; top: number; editing?: boolean };
    return v.dayId === dayId && (v.startedAt ?? null) === startedAt && !!v.editing === editing && typeof v.top === "number" ? v.top : null;
  } catch {
    return null;
  }
}
function writeScroll(dayId: number, startedAt: string | null, editing: boolean, top: number) {
  try {
    window.sessionStorage.setItem(SCROLL_KEY, JSON.stringify({ dayId, startedAt, editing, top: Math.round(top) }));
  } catch {}
}
const stillMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export default function WorkoutSheet({
  day,
  editing = false,
  gymId,
  onPickGym,
  coachName,
  coachPhoto = null,
  focusExercise,
  onBack,
  onEnded,
  onDiscarded,
  onEdited,
  library,
  onAddExercise,
}: {
  library?: LibraryPick[];
  onAddExercise?: (pick: { exerciseId: number | null; name: string; group: string }) => Promise<number | null>;
  day: SessionDay;
  editing?: boolean;
  gymId: number | null;
  onPickGym: (gym: GymOption) => void;
  coachName: string;
  coachPhoto?: string | null;
  /** The client's first name (the pager's wrap-up); the sheet's finish says the session's name instead. */
  clientName?: string;
  focusExercise: number | null;
  onBack: () => void;
  onEnded: () => void;
  onDiscarded: () => void;
  onEdited?: () => void;
}) {
  const session = { dayId: day.key, startedAt: day.startedAt };
  const free = !!day.free;
  const ended = day.endedAt != null;
  const locked = ended && !editing;
  const now = useTicker(!ended);
  const ms = elapsedMs(day.startedAt, day.endedAt, now);
  const rest = useRestTimer();
  const openMessages = useOpenMessages();
  const gym = day.gyms.find((g) => g.id === gymId) ?? null;
  const gymName = gym?.name ?? null;
  const fin = useSessionEnd(day, { onEnded, onDiscarded, onEdited });
  const [finishOpen, setFinishOpen] = useState(false);

  // ---- The blocks, in order: the exercises, then the cardio. A rogue exercise is done once anything is logged.
  const exDone = (ex: SessionExercise) => (free ? loggedCount(ex) > 0 || ex.logs.length > 0 : isDone(ex));
  const blocks = [
    ...day.exercises.map((ex) => ({ key: `e${ex.id}`, name: shownName(ex), done: exDone(ex), part: ex.logs.length > 0 })),
    ...day.cardio.map((c) => ({ key: `c${c.id}`, name: c.swap ?? c.name, done: c.done, part: false })),
  ];
  const order = blocks.map((b) => b.key).join(",");

  // ---- The screen, for the menus that drop into it.
  const [screenEl, setScreenEl] = useState<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const els = useRef(new Map<string, HTMLElement>());
  const refFor = (key: string) => (el: HTMLElement | null) => {
    if (el) {
      el.dataset.block = key;
      els.current.set(key, el);
    } else els.current.delete(key);
  };

  // ---- Which block is in view: the topmost one crossing a band a third down the box. It lights the segment and the
  // block's ring, and reads its coach's note; it never scrolls anything.
  // None until the opening scroll has settled (a link landing, the place kept, the first block not done): the observer
  // reads at the top before that scroll and the blocks the smooth scroll passes, so a block the client was only carried
  // past never has its coach's note marked read.
  const [inView, setInView] = useState<string | null>(null);
  const settled = useRef(false);
  const latest = useRef<string | null>(null);
  const settle = () => {
    settled.current = true;
    if (latest.current) setInView(latest.current);
  };
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const keys = order ? order.split(",") : [];
    const crossing = new Set<string>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const k = (e.target as HTMLElement).dataset.block;
          if (!k) continue;
          if (e.isIntersecting) crossing.add(k);
          else crossing.delete(k);
        }
        const top = keys.find((k) => crossing.has(k));
        if (!top) return;
        latest.current = top;
        if (settled.current) setInView(top);
      },
      { root, rootMargin: "-30% 0px -60% 0px" }
    );
    for (const k of keys) {
      const el = els.current.get(k);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, [order]);

  // ---- The scroll, kept per session (a trip to the overview and back lands where it was), and the last block in view
  // at the very foot, where it may never reach the band.
  const frame = useRef(0);
  const onScroll = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const box = scrollRef.current;
      if (!box) return;
      writeScroll(day.key, day.startedAt ?? null, editing, box.scrollTop);
      const keys = order ? order.split(",") : [];
      if (keys.length && box.scrollTop > 0 && box.scrollTop + box.clientHeight >= box.scrollHeight - 2) {
        latest.current = keys[keys.length - 1];
        if (settled.current) setInView(latest.current);
      }
    });
  };
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  // ---- Opening: a link lands on its exercise (top, lit); else the place left; else, with something logged already,
  // the first block not done at the top, at once. Once, never again after.
  // The blocks in view are read only once this has settled (above).
  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    let settleT = 0;
    const settleAfter = (ms: number) => {
      window.clearTimeout(settleT);
      settleT = window.setTimeout(settle, ms);
    };
    if (focusExercise != null && day.exercises.some((e) => e.id === focusExercise)) {
      const stop = landOnSoon(() => els.current.get(`e${focusExercise}`), "start", 120);
      // Settled once the landing's smooth scroll ends; a landing with nowhere to go (or no scrollend) a moment after.
      const onEnd = () => settleAfter(0);
      box.addEventListener("scrollend", onEnd, { once: true });
      settleAfter(1200);
      return () => {
        stop();
        window.clearTimeout(settleT);
        box.removeEventListener("scrollend", onEnd);
      };
    }
    const kept = readScroll(day.key, day.startedAt ?? null, editing);
    const t = window.setTimeout(() => {
      settleAfter(150);
      if (kept != null) {
        box.scrollTop = kept;
        return;
      }
      const started = day.exercises.some((e) => e.logs.length > 0) || day.cardio.some((c) => c.done);
      if (!started || editing) return;
      const first = blocks.find((b) => !b.done);
      const el = first ? els.current.get(first.key) : null;
      if (el) box.scrollTop = Math.max(0, el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 8);
    }, 0);
    return () => {
      window.clearTimeout(t);
      window.clearTimeout(settleT);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on opening
  }, []);

  /** A segment's tap: that block's top at the box's top. */
  const goTo = (key: string) => {
    const box = scrollRef.current;
    const el = els.current.get(key);
    if (!box || !el) return;
    const top = Math.max(0, el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 8);
    box.scrollTo({ top, behavior: stillMotion() ? "auto" : "smooth" });
  };

  // ---- The head's ⋯ (Change gym, Discard) and the gym capsule's drop: copied from WorkoutScreen.tsx (:184-207) until
  // the pager goes. The exercise's and the cardio's items are on each block's own ⋯.
  const [menuOpen, setMenuOpen] = useState(false);
  // Discard asks in the menu itself (docs/DESIGN-RULES.md §6, never the browser's alert), as Reopen does.
  const [discardAsk, setDiscardAsk] = useState(false);
  useDismiss(menuOpen, () => {
    setMenuOpen(false);
    setDiscardAsk(false);
  });
  const [menuAt, setMenuAt] = useState<{ top: number; right: number } | null>(null);
  const toggleMenu = (e: React.MouseEvent<HTMLElement>) => {
    const box = screenEl?.getBoundingClientRect();
    const btn = e.currentTarget.getBoundingClientRect();
    setMenuAt(box ? { top: btn.bottom - box.top + 6, right: box.right - btn.right } : null);
    setMenuOpen((o) => !o);
    setDiscardAsk(false);
  };
  const [gymOpen, setGymOpen] = useState(false);
  const [gymDrop, setGymDrop] = useState<{ top: number; left: number } | null>(null);
  useDismiss(!!gymDrop, () => setGymDrop(null));
  const toggleGymDrop = (e: React.MouseEvent<HTMLElement>) => {
    if (gymDrop) return setGymDrop(null);
    const box = screenEl?.getBoundingClientRect();
    const pill = e.currentTarget.getBoundingClientRect();
    setGymDrop(box ? { top: pill.bottom - box.top + 8, left: pill.left + pill.width / 2 - box.left } : null);
  };
  const closeMenu = () => {
    setMenuOpen(false);
    setDiscardAsk(false);
  };
  const discard = () => {
    closeMenu();
    fin.discard();
  };
  const hasMenu = day.gyms.length > 0 || !editing;
  const sessionLabel = editing ? <Bars parts={["Editing", day.title]} /> : day.title;

  return (
    <SwapLibrary.Provider value={library ?? NO_LIBRARY}>
      <div ref={setScreenEl} className="app-layer app-layer-push wo-screen ws-screen" role="dialog" aria-label={`${day.title} workout`}>
        <SheetHost.Provider value={screenEl}>
          <header className="wo-head">
            <div className="wo-head-row">
              {/* Leaving loses nothing (every tick is saved, and what is typed is kept for the session and back on
                  Resume), so there is nothing to ask. */}
              <button type="button" className="wo-head-btn" onClick={onBack} aria-label="Back">
                <ChevronLeftIcon />
              </button>
              <button
                type="button"
                className={`wo-pill${ended ? " ended" : ""}${gym ? " has-gym" : ""}`}
                onClick={(e) => day.gyms.length > 0 && (gymId == null ? setGymOpen(true) : toggleGymDrop(e))}
                aria-expanded={gymDrop ? true : undefined}
                disabled={day.gyms.length === 0}
                aria-label={`${gymName ?? (editing ? `Editing ${day.title}` : day.title)},${clock(ms)} elapsed${day.gyms.length > 0 ? ". Switch gym" : ""}`}
              >
                {gym && (
                  <span className="wo-pill-face" style={{ background: gymColor(gym.color).hex }} aria-hidden="true">
                    <BadgeFace name={gym.name} logo={gym.logo} />
                  </span>
                )}
                <span className="wo-pill-gym">{gymName ?? (editing ? sessionLabel : day.gyms.length > 0 ? "Pick a gym" : day.title)}</span>
                {day.gyms.length > 0 && (
                  <svg className="wo-pill-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                    <path vectorEffect="non-scaling-stroke" d="m6 9 6 6 6-6" />
                  </svg>
                )}
                <span className="wo-pill-clock">
                  <i className="wo-pill-dot" aria-hidden="true" />
                  {clock(ms)}
                </span>
              </button>
              <div className="wo-head-right">
                {openMessages && (
                  <button type="button" className="wo-head-btn" onClick={() => openMessages({ link: { kind: "session", dayId: day.key }, label: day.title })} aria-label={`Message ${coachName} about ${day.title}`}>
                    <ChatIcon />
                  </button>
                )}
                {hasMenu && (
                  <button type="button" className="wo-head-btn" onClick={toggleMenu} aria-label="More" aria-expanded={menuOpen}>
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <circle cx="5" cy="12" r="1.8" fill="currentColor" stroke="none" />
                      <circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none" />
                      <circle cx="19" cy="12" r="1.8" fill="currentColor" stroke="none" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
            {blocks.length > 0 && (
              <div className={`wo-segments${blocks.length > 10 ? " many" : ""}`} role="tablist" aria-label="Exercises">
                {blocks.map((b) => (
                  <button
                    key={b.key}
                    type="button"
                    role="tab"
                    aria-selected={b.key === inView}
                    aria-label={b.name}
                    className={`wo-seg ws-seg${b.key === inView ? " now" : ""}${b.done ? " done" : b.part ? " part" : ""}`}
                    onClick={() => goTo(b.key)}
                  >
                    <span />
                  </button>
                ))}
              </div>
            )}
            {gymDrop && (
              <>
                <button type="button" className="wo-menu-scrim" aria-label="Close" onClick={() => setGymDrop(null)} />
                <div className="wo-menu wo-gymdrop" role="menu" aria-label="Switch gym" style={{ top: gymDrop.top, left: gymDrop.left }}>
                  {day.gyms
                    .filter((g) => !g.once || g.id === gymId)
                    .sort((a, b) => Number(b.id === gymId) - Number(a.id === gymId) || b.sessions - a.sessions)
                    .map((g) => (
                      <button
                        key={g.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={g.id === gymId}
                        className={`wo-menu-row wo-gymdrop-row${g.id === gymId ? " on" : ""}`}
                        onClick={() => {
                          setGymDrop(null);
                          if (g.id !== gymId) onPickGym(g);
                        }}
                      >
                        <span className="wo-gymdrop-face" style={{ background: gymColor(g.color).hex }} aria-hidden="true">
                          <BadgeFace name={g.name} logo={g.logo} />
                        </span>
                        <span className="wo-gymdrop-name">{g.name}</span>
                        {g.id === gymId && (
                          <svg className="wo-gymdrop-check" viewBox="0 0 24 24" aria-hidden="true">
                            <path d="m5 12.5 4.5 4.5L19 7.5" />
                          </svg>
                        )}
                      </button>
                    ))}
                </div>
              </>
            )}
            {menuOpen && (
              <>
                <button type="button" className="wo-menu-scrim" aria-label="Close menu" onClick={closeMenu} />
                <div className="wo-menu" role="menu" style={menuAt ? { top: menuAt.top, right: menuAt.right } : undefined}>
                  {discardAsk ? (
                    <div className="so-ask" role="alertdialog" aria-label={`Discard ${day.title}?`}>
                      <b>Discard {day.title}?</b>
                      <p>Every set logged in it is deleted.</p>
                      <span className="so-ask-acts">
                        <button type="button" className="so-ask-cancel" onClick={closeMenu}>
                          Cancel
                        </button>
                        <button type="button" className="so-ask-go ws-ask-rust" onClick={discard}>
                          Discard
                        </button>
                      </span>
                    </div>
                  ) : (
                  <>
                  {day.gyms.length > 0 && (
                    <button
                      type="button"
                      role="menuitem"
                      className="wo-menu-row ico"
                      onClick={() => {
                        setMenuOpen(false);
                        setGymOpen(true);
                      }}
                    >
                      <MenuIcon kind="gym" />
                      Change gym
                    </button>
                  )}
                  {!editing && (
                    <>
                      {day.gyms.length > 0 && <div className="wo-menu-divider" />}
                      <button type="button" role="menuitem" className="wo-menu-row ico danger" onClick={() => setDiscardAsk(true)}>
                        <MenuIcon kind="discard" />
                        Discard session
                      </button>
                    </>
                  )}
                  </>
                  )}
                </div>
              </>
            )}
          </header>

          <div ref={scrollRef} className="ws-scroll" onScroll={onScroll}>
            {day.exercises.map((ex, i) => (
              <SheetExercise
                key={ex.id}
                exercise={ex}
                index={i + 1}
                dayId={day.key}
                dayTitle={day.title}
                session={session}
                gymId={gymId}
                coachName={coachName}
                coachPhoto={coachPhoto}
                free={free}
                done={exDone(ex)}
                inView={inView === `e${ex.id}`}
                blockRef={refFor(`e${ex.id}`)}
              />
            ))}
            {day.cardio.map((c, i) => (
              <SheetCardio
                key={c.id}
                cardio={c}
                index={day.exercises.length + i + 1}
                dayId={day.key}
                dayTitle={day.title}
                session={session}
                coachName={coachName}
                free={free && !editing}
                inView={inView === `c${c.id}`}
                blockRef={refFor(`c${c.id}`)}
              />
            ))}
            {/* A rogue session (19 Oct): Add an exercise after what it has; the new block comes in, nothing scrolls. */}
            {free && !editing && onAddExercise && (
              <div className="ws-add">
                <FreeAddPage
                  library={library ?? []}
                  count={day.exercises.length + day.cardio.length}
                  onAdd={async (pick) => {
                    const id = await onAddExercise(pick);
                    return id != null;
                  }}
                />
              </div>
            )}
          </div>

          {/* The dock: the rest timer and Finish (Save changes when editing), no line over it. */}
          <div className="wo-dock ws-dock">
            <RestTimerPill timer={rest} />
            <button type="button" className="ws-finish-pill" onClick={() => setFinishOpen(true)}>
              {editing ? "Save changes" : "Finish"}
            </button>
          </div>

          {finishOpen && (
            <FinishSheet
              day={day}
              editing={editing}
              locked={locked}
              ended={ended}
              coachName={coachName}
              note={fin.note}
              setNote={fin.setNote}
              answers={fin.answers}
              setAnswers={fin.setAnswers}
              ending={fin.ending}
              onEnd={fin.end}
              onSaveEdit={fin.saveEdit}
              onClose={() => setFinishOpen(false)}
            />
          )}

          {gymOpen && (
            <GymPickerDialog
              gyms={day.gyms}
              gymId={gymId}
              mode="switch"
              dayId={day.key}
              onPick={(g) => {
                setGymOpen(false);
                if (g.id !== gymId) onPickGym(g);
              }}
              onClose={() => setGymOpen(false)}
            />
          )}
        </SheetHost.Provider>
      </div>
    </SwapLibrary.Provider>
  );
}
