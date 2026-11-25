"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";

// A list that drops from its pill (25 Nov, Alex: docs/boards/todo-popover-mockup.html, "To do as a pop-over"): a client's
// To do under its pill (TodoStrip.tsx) and Join requests under theirs by Clients (JoinRequests.tsx). Fixed on the
// window, placed from the pill each time it opens and kept with it as the page scrolls or the window changes size, so
// nothing it is in clips it and the page never moves for it. Never past the window's left edge or 16px from it, never
// over the edge tabs on its right (60px kept clear), as tall as its rows up to the room left under the pill (16px from
// the window's foot), then it scrolls inside. Its nub (`--nub`) points at the pill's middle.

const AIR = 16;
/** The chat's and help's tabs on the window's right edge (60px, as a page keeps for them). */
const EDGE_TABS = 60;
const DROP = 10;

/** `align` (25 Nov, Alex: "the to do is on the right… a little bit of like centered right situation… join request… align it properly with the button"): "end" its right edge on the pill's, the list hanging to the left (the To do); "start" its left edge on the pill's, running on to the right (Join requests); "center" under the pill's middle. The nub points at the pill's middle whichever. */
export function usePopoverPlace(anchor: RefObject<HTMLElement | null>, open: boolean, width: number, align: "center" | "start" | "end" = "center"): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({});
  useLayoutEffect(() => {
    if (!open) return;
    let frame = 0;
    let last = "";
    const place = () => {
      const a = anchor.current;
      if (!a) return;
      const r = a.getBoundingClientRect();
      const vw = document.documentElement.clientWidth || window.innerWidth;
      const vh = window.innerHeight;
      // Only a move of the pill or the window draws it again.
      const at = `${r.left}|${r.bottom}|${r.width}|${vw}|${vh}`;
      if (at === last) return;
      last = at;
      const w = Math.max(240, Math.min(width, vw - AIR - EDGE_TABS));
      const mid = r.left + r.width / 2;
      const want = align === "start" ? r.left : align === "end" ? r.right - w : mid - w / 2;
      const left = Math.max(AIR, Math.min(want, vw - EDGE_TABS - w));
      const top = r.bottom + DROP;
      const nub = Math.max(18, Math.min(w - 18, mid - left));
      // The height its scroll box may take (`--pop-max`): the box itself never clips, so the nub can sit outside it.
      setStyle({ left, top, width: w, "--pop-max": `${Math.max(140, vh - top - AIR)}px`, "--nub": `${nub}px` } as CSSProperties);
    };
    place();
    // Read every frame while open (25 Nov, review): the pill moves without a scroll or a resize too, the tabs' row
    // unwrapping as the chat or help it shut eases its room away, so the list keeps to its pill throughout.
    const tick = () => {
      place();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [open, anchor, width, align]);
  return style;
}

/** Shut by a press outside it and its pill (the pill toggles it itself), and by Esc, unless a pop-up, a menu or a
 *  floating list has the keyboard (Esc closes that alone, 24 Nov, Alex). A press inside a dialog, a menu or a toast
 *  (its confirm, opened from it) is no press outside. `hold`: something of its own is up, leave it be. `refs`: the
 *  pop-over first, then its pill. The keyboard goes with it (25 Nov, review): opened from the keyboard, to its first
 *  control; shut by Esc from inside it, back to the pill, never dropped on the page. */
export function usePopoverClose(open: boolean, close: () => void, refs: RefObject<HTMLElement | null>[], hold = false) {
  const shut = useRef(close);
  const within = useRef(refs);
  useEffect(() => {
    shut.current = close;
    within.current = refs;
  });
  useEffect(() => {
    if (!open) return;
    const [pop, pill] = within.current;
    // Only when the pill has the keyboard's focus (a tap or a click leaves it where it is).
    if (!pill?.current || document.activeElement !== pill.current || !pill.current.matches(":focus-visible")) return;
    const frame = requestAnimationFrame(() => pop?.current?.querySelector<HTMLElement>("button, input, textarea, [tabindex]")?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [open]);
  useEffect(() => {
    if (!open || hold) return;
    const press = (e: PointerEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      if (!t || !document.contains(t)) return;
      if (within.current.some((r) => r.current?.contains(t))) return;
      if (t.closest("[role=dialog], [role=alertdialog], [role=menu], [role=listbox], [data-radix-popper-content-wrapper], [data-sonner-toaster]")) return;
      shut.current();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector("[role=dialog], [role=alertdialog], [role=menu], [role=listbox], [data-radix-popper-content-wrapper]")) return;
      const [pop, pill] = within.current;
      if (pop?.current?.contains(document.activeElement)) pill?.current?.focus({ preventScroll: true });
      shut.current();
    };
    document.addEventListener("pointerdown", press);
    window.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", press);
      window.removeEventListener("keydown", key);
    };
  }, [open, hold]);
}
