"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useDismiss } from "../useDismiss";
import { Bars } from "../Bars";
import RingEdge from "../../components/RingEdge";

// The small parts every block of the workout sheet shares (15 Nov, Alex: docs/boards/workout-sheet-a-mockup.html):
// the screen the menus drop into, a block's round tools and its ⋯ menu, the target line and the swap's row.

/** The workout sheet's screen: a block's ⋯ menu is drawn in it, placed from the button, as the pager's menu is. */
export const SheetHost = createContext<HTMLElement | null>(null);

type MenuAt = { top?: number; bottom?: number; right: number };

/** A block's ⋯: where its menu drops from (under the button, or over it near the foot of the screen). */
export function useBlockMenu() {
  const host = useContext(SheetHost);
  const [at, setAt] = useState<MenuAt | null>(null);
  useDismiss(!!at, () => setAt(null));
  const toggle = (e: React.MouseEvent<HTMLElement>, items: number) => {
    if (at) return setAt(null);
    const box = host?.getBoundingClientRect();
    const btn = e.currentTarget.getBoundingClientRect();
    if (!box) return;
    const tall = 12 + items * 44;
    const below = btn.bottom + 6 + tall < box.bottom - 96;
    setAt(below ? { top: btn.bottom - box.top + 6, right: box.right - btn.right } : { bottom: box.bottom - btn.top + 6, right: box.right - btn.right });
  };
  return { at, open: !!at, toggle, close: () => setAt(null), host };
}

/** The menu itself, in the workout's ⋯ look (`.wo-menu`), over a see-through scrim. */
export function BlockMenu({ menu, label, children }: { menu: ReturnType<typeof useBlockMenu>; label: string; children: ReactNode }) {
  if (!menu.at || !menu.host) return null;
  return createPortal(
    <>
      <button type="button" className="wo-menu-scrim" aria-label="Close menu" onClick={menu.close} />
      <div className="wo-menu ws-menu" role="menu" aria-label={label} style={{ top: menu.at.top ?? "auto", bottom: menu.at.bottom ?? "auto", right: menu.at.right }}>
        {children}
      </div>
    </>,
    menu.host
  );
}

/** A block's tool (15 Nov, Alex): the icon alone, 17px at 1.6, no ring, in a 30px tap; ink-filled round while open. */
export function ToolButton({ label, onClick, expanded, children }: { label: string; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void; expanded?: boolean; children: ReactNode }) {
  return (
    <button type="button" className={`ws-tool${expanded ? " on" : ""}`} onClick={onClick} aria-label={label} title={label} aria-expanded={expanded}>
      {children}
    </button>
  );
}

/**
 * A block's fold (15 Nov, Alex): a second after the client's tick of its last remaining set (or Mark as done), the block
 * folds to one line on the shared fold; nothing else ever folds it. `arm()` is that tick (or a new `armKey`, counted by
 * the set that tick logged); it folds once `complete` holds a second later, unless a field in the block can still be
 * typed in and has the keyboard, and a set opened again in that second calls it off. An arm the block never completes
 * on (the tick's log never landed) goes, so nothing else later folds it. A block complete on opening starts folded; a
 * tap on its line opens it, until another last tick. `easing` while it moves, so the fold clips only then.
 */
export function useBlockFold(complete: boolean, blockEl: () => HTMLElement | null, armKey = 0) {
  const [folded, setFolded] = useState(complete);
  const [armed, setArmed] = useState(false);
  const [easing, setEasing] = useState(false);
  // The set the last tick logged: armed by it alone.
  const [seenKey, setSeenKey] = useState(armKey);
  if (seenKey !== armKey) {
    setSeenKey(armKey);
    setArmed(true);
  }
  // Opened again within the second (a set unticked): called off.
  const [wasComplete, setWasComplete] = useState(complete);
  if (wasComplete !== complete) {
    setWasComplete(complete);
    if (armed && !complete) setArmed(false);
  }
  useEffect(() => {
    if (!armed) return;
    // Armed and not complete: the log is landing (a render away); if it never does, the arm goes.
    if (!complete) {
      const t = window.setTimeout(() => setArmed(false), 1500);
      return () => window.clearTimeout(t);
    }
    const t = window.setTimeout(() => {
      setArmed(false);
      const el = blockEl();
      const a = typeof document !== "undefined" ? (document.activeElement as HTMLInputElement | null) : null;
      if (el && a && el.contains(a)) {
        // A field still to type in has the keyboard: no fold. The one just logged is read-only now and keeps the focus
        // on an iPhone (a tap on the tick doesn't take it), so it lets go of it and the keyboard goes with the fold.
        if ((a.tagName === "INPUT" || a.tagName === "TEXTAREA") && !a.readOnly) return;
        a.blur?.();
      }
      setFolded(true);
      setEasing(true);
    }, 1000);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- blockEl reads the block when the second is up
  }, [armed, complete]);
  useEffect(() => {
    if (!easing) return;
    const t = window.setTimeout(() => setEasing(false), 620);
    return () => window.clearTimeout(t);
  }, [easing]);
  return {
    folded,
    easing,
    arm: () => setArmed(true),
    open: () => {
      setArmed(false);
      setFolded(false);
      setEasing(true);
    },
    /** Folded again by hand (16 Nov, Alex: opened to check the sets, "I cannot collapse it again"). */
    close: () => {
      setArmed(false);
      setFolded(true);
      setEasing(true);
    },
  };
}

/**
 * A block's ring and name. On a done block opened again, they are one button that folds it back (16 Nov, Alex), the
 * chevron after the name pointing down, as the folded line's points right.
 */
export function BlockTitle({ ring, name, onFold }: { ring: ReactNode; name: string; onFold?: () => void }) {
  if (!onFold)
    return (
      <>
        {ring}
        <h2 className="ws-bname">{name}</h2>
      </>
    );
  return (
    <button type="button" className="ws-bfold" onClick={onFold} aria-label={`${name}, done. Fold`}>
      {ring}
      <span className="ws-bname" role="heading" aria-level={2}>
        {name}
      </span>
      <span className="ws-bfold-chev" aria-hidden="true" />
    </button>
  );
}

/** The shared fold (the end of globals.css: rows 0fr → 1fr over 340ms), its inside clipped only while it eases. */
export function WsFold({ open, easing, className = "", children }: { open: boolean; easing: boolean; className?: string; children: ReactNode }) {
  return (
    <div className={`so-fold ws-fold${open ? " open" : ""}${easing ? " easing" : ""}${className ? ` ${className}` : ""}`} aria-hidden={!open} inert={!open}>
      <div className="so-fold-in">{children}</div>
    </div>
  );
}

/**
 * A folded block's one line, flat on the page: the done check, the name and a chevron pointing right, no facts (15 Nov, Alex:
 * "take out the 3 sets"). One
 * that stopped being complete while folded (a set the server refused) stays folded, as nothing moves by itself, but
 * never claims done: its number ring in place of the check (`check`, the caller's), `done` false, and `alert` (`1 set
 * not saved`) the line's one rust fact after the drawn bar.
 */
export function FoldedLine({ name, check, done = true, alert = null, onOpen }: { name: string; facts?: string[]; check: ReactNode; done?: boolean; alert?: string | null; onOpen: () => void }) {
  const said = alert ? [alert] : [];
  return (
    <button type="button" className="ws-foldline" onClick={onOpen} aria-label={`${name}${done ? ", done" : ""}${said.length ? `, ${said.join(", ")}` : ""}. Open`}>
      {check}
      <span className="ws-foldline-name">{name}</span>
      {said.length > 0 && (
        <span className="ws-foldline-facts">
          <span className="ws-foldline-alert">{alert}</span>
        </span>
      )}
      <span className="ws-foldline-chev" aria-hidden="true" />
    </button>
  );
}

const glyph = (paths: ReactNode) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {paths}
  </svg>
);
export const PlayGlyph = () => glyph(<path vectorEffect="non-scaling-stroke" d="M8 5.5v13l10.5-6.5z" />);
export const ChatGlyph = () => glyph(<path vectorEffect="non-scaling-stroke" d="M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5v8a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3.5V16A1.5 1.5 0 0 1 4 14.5z" />);
export const MoreGlyph = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <circle cx="5" cy="12" r="1.5" fill="currentColor" />
    <circle cx="12" cy="12" r="1.5" fill="currentColor" />
    <circle cx="19" cy="12" r="1.5" fill="currentColor" />
  </svg>
);
export const SwapGlyph = () => glyph(<path vectorEffect="non-scaling-stroke" d="M8 3 4 7l4 4M4 7h16M16 21l4-4-4-4M20 17H4" />);
export const CheckGlyph = () => glyph(<path vectorEffect="non-scaling-stroke" d="m5 12.5 4.5 4.5L19 7.5" />);
/** The ⋯'s kg / lbs row: a kettlebell, in the menu's line. */
export const UnitGlyph = () => (
  <svg className="wo-menu-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 9V7.5a3 3 0 0 1 6 0V9" />
    <path d="M7 9h10l1.4 10a1.2 1.2 0 0 1-1.2 1.4H6.8A1.2 1.2 0 0 1 5.6 19z" />
  </svg>
);

/**
 * The coach's targets as one line (15 Nov, Alex: docs/boards/workout-sheet-a-mockup.html), in place of the band on the
 * sheet: `TARGET` in training purple, then the figures parted by the drawn bar, `3 × 10–12 | 140 kg | Rest 2 min`.
 * From targetColumns, so the order and the words are the band's.
 */
export function targetParts(cols: [string, string][]): string[] {
  const get = (k: string) => cols.find((c) => c[0] === k)?.[1];
  const sets = get("Sets");
  const reps = get("Reps");
  const out: string[] = [];
  if (sets && reps) out.push(`${sets} × ${reps}`);
  else if (sets) out.push(`${sets} set${sets === "1" ? "" : "s"}`);
  else if (reps) out.push(`${reps} reps`);
  for (const [k, v] of cols) {
    if (k === "Sets" || k === "Reps") continue;
    out.push(k === "kg" || k === "lbs" ? `${v} ${k}` : `${k} ${v}`);
  }
  return out;
}

export function TargetLine({ parts, guide = false }: { parts: string[]; guide?: boolean }) {
  if (!parts.length) return null;
  return (
    <div className={`ws-tgt${guide ? " guide" : ""}`}>
      <b>Target</b>
      <span className="ws-tgt-v">
        <Bars parts={parts} />
      </span>
    </div>
  );
}

/** A swap's row: the swap mark in the coach's swap amber, `Instead of {name}`, Undo in words on the right. */
export function SwapRow({ name, onUndo }: { name: string; onUndo?: () => void }) {
  return (
    <div className="ws-swap">
      <span className="ws-swap-ring" aria-hidden="true">
        <SwapGlyph />
        <RingEdge size={22} stroke={1.5} />
      </span>
      <span className="ws-swap-words">
        Instead of <b>{name}</b>
      </span>
      {onUndo && (
        <button type="button" className="ws-swap-undo" onClick={onUndo}>
          Undo
        </button>
      )}
    </div>
  );
}

/** The block's number ring: the done check once every working set is in; ink while in view or started; else grey. */
export function BlockRing({ n, done, on, doneCheck }: { n: number; done: boolean; on: boolean; doneCheck: ReactNode }) {
  if (done) return <span className="ws-bn done">{doneCheck}</span>;
  return (
    <span className={`ws-bn${on ? " on" : ""}`} aria-hidden="true">
      {n}
      <RingEdge size={22} stroke={1.5} />
    </span>
  );
}
