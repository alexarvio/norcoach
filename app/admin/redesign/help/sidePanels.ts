"use client";

import { useEffect, useRef } from "react";

// One panel on the right at a time (24 Nov, Alex: docs/boards/help-docked-mockup.html): the chat (RedesignShell's on a
// client's screens, ChatDock's on the views over every client), help (HelpButton, mounted once by RailFrame) and a
// client's To do (RedesignShell). They live in different parts of the tree, so each says on the window when it opens,
// and the others close as they hear it. A panel may also mark the frame while it is open (`data-help`, `data-todo`),
// so the edge tabs and the page can follow it in CSS, as `data-chat` does for the chat (messages.css).

export type SidePanel = "chat" | "help" | "todo" | "joins";

const EVENT = "norcoach:side-panel";

/** `who` is open or not; `close` shuts it when another panel opens. `frameAttr`: an attribute set to "open" on
 *  `.rd-frame` while it is open. */
export function useSidePanel(who: SidePanel, open: boolean, close: () => void, frameAttr?: string) {
  const shut = useRef(close);
  const isOpen = useRef(open);
  useEffect(() => {
    shut.current = close;
    isOpen.current = open;
  });
  // Said once each time it opens (a panel put back open on a new screen too).
  useEffect(() => {
    if (!open) return;
    window.dispatchEvent(new CustomEvent<SidePanel>(EVENT, { detail: who }));
  }, [open, who]);
  useEffect(() => {
    const heard = (e: Event) => {
      const other = (e as CustomEvent<SidePanel>).detail;
      if (other !== who && isOpen.current) shut.current();
    };
    window.addEventListener(EVENT, heard);
    return () => window.removeEventListener(EVENT, heard);
  }, [who]);
  useEffect(() => {
    if (!frameAttr) return;
    const frame = document.querySelector(".rd-frame");
    if (!frame) return;
    if (open) frame.setAttribute(frameAttr, "open");
    else frame.removeAttribute(frameAttr);
    // The frame is the layout's and outlives the page: never leave the mark behind on leaving.
    return () => {
      if (open) frame.removeAttribute(frameAttr);
    };
  }, [open, frameAttr]);
}
