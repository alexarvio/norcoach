"use client";

import { useEffect, useSyncExternalStore } from "react";
import { ChatIcon } from "../../components/icons";

// The chat's tab and panel in a view's outline (22 Nov, docs/rail-layout-plan.md; PageSkeleton): every framed page has
// the chat's tab on the window's right edge (ChatDock, RedesignShell), and the page keeps 60px for it
// (`.rd-frame:has(.rd-chattab) > .rd-page`, messages.css), so the outline wears the tab too and its cards end where the
// page's will. A chat kept open (the shell's and the dock's one key in sessionStorage) is held open in place, still and
// empty, so the room beside it is the panel's and nothing vanishes while the next page is read; that page puts the real
// one back in the same place (its own restore, no slide). Inert: nothing here does anything.

const KEPT_KEY = "norcoach:chat-dock";
const keptOpen = () => {
  try {
    return JSON.parse(window.sessionStorage.getItem(KEPT_KEY) ?? "null")?.open === true;
  } catch {
    return false;
  }
};
const never = () => () => {};

export default function PageSkeletonChat() {
  // Closed on the server (no sessionStorage there), read on the client.
  const open = useSyncExternalStore(never, keptOpen, () => false);
  useEffect(() => {
    const frame = document.querySelector(".rd-frame");
    if (!frame) return;
    if (open) {
      frame.setAttribute("data-chat-still", "");
      frame.setAttribute("data-chat", "open");
    } else frame.removeAttribute("data-chat");
    // The frame outlives the outline: never left still for the page after it (it sets its own).
    return () => frame.removeAttribute("data-chat-still");
  }, [open]);
  return (
    <>
      <span className={`rd-chattab still${open ? " open" : ""}`} aria-hidden="true">
        <ChatIcon />
      </span>
      {open && <aside className="rd-chatpanel rd-chatdock open still" aria-hidden="true" />}
    </>
  );
}
