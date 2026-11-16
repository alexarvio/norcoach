"use client";

import { useEffect, useState, type ReactNode } from "react";

// A row's body on the shared fold (16 Nov, Alex: the audit; docs/DESIGN-RULES.md §7, as Training's sessions): its rows
// 0fr -> 1fr over 340ms on the fold's curve, what is in it fading in over 220ms and settling 4px down; shutting, the same
// back before it leaves the page. Mounted only while open (and the 340ms it takes to shut), so a closed row costs nothing.
// Styles: `.rd-rowfold` in training/draft.css. Meetings' calls and past calls, the Support inbox, Nutrition's days,
// Shape update's past updates.
export function RowFold({ open, className, children }: { open: boolean; className?: string; children: ReactNode }) {
  const [shown, setShown] = useState(open);
  // Drawn as it was left on load (docs/DESIGN-RULES.md §7): a row open from the start doesn't ease in; only a click does.
  const [still, setStill] = useState(open);
  // Shutting, it keeps what it held, so the body fading out is its own, never the next row's.
  const [kept, setKept] = useState<ReactNode>(children);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setShown(true);
    else setStill(false);
  }
  if (open && kept !== children) setKept(children);
  useEffect(() => {
    if (open) return;
    const timer = setTimeout(() => setShown(false), 360);
    return () => clearTimeout(timer);
  }, [open]);
  if (!open && !shown) return null;
  const body = open ? children : kept;
  return (
    <div className={`rd-rowfold${open ? "" : " shut"}${still ? " still" : ""}`} inert={!open}>
      {/* The body's own padding sits inside the clip, so the fold shuts to nothing. */}
      <div className="rd-rowfold-in">{className ? <div className={className}>{body}</div> : body}</div>
    </div>
  );
}
