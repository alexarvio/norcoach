"use client";

import { useEffect } from "react";

// The faint logo behind Home and every chat sits at ONE spot on the screen (17 Nov, Alex and Finlay: going from Home to a
// chat it "clicks a little bit"): each box drew it 6px below its own top, and Home's content starts lower (under the
// Norcoach bar) than a chat's. Every box that draws it is told how far its top is from that spot (`--mark-y`, read by its
// background in globals.css), the spot being 6px under where Home's content starts. Mounted once in the client app.

const BOXES = ".app-content, .cm-body";

export default function MarkAnchor() {
  useEffect(() => {
    // Where Home's content starts on screen, kept once seen (the chat covers Home, so it is read while Home shows).
    let homeTop: number | null = null;
    let raf = 0;
    const place = () => {
      raf = 0;
      const home = document.querySelector<HTMLElement>(".app-content");
      if (home && home.offsetParent !== null) homeTop = home.getBoundingClientRect().top;
      const spot = (homeTop ?? 0) + 6;
      document.querySelectorAll<HTMLElement>(BOXES).forEach((box) => {
        const y = `${Math.round(spot - box.getBoundingClientRect().top)}px`;
        if (box.style.getPropertyValue("--mark-y") !== y) box.style.setProperty("--mark-y", y);
      });
    };
    const soon = () => {
      if (!raf) raf = requestAnimationFrame(place);
    };
    place();
    // A chat opening (its box appearing), the phone turning, the keyboard: placed again on the next frame.
    const mo = new MutationObserver(soon);
    mo.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", soon);
    // A screen sliding in is read again once it has landed (mid-slide its top is elsewhere).
    document.addEventListener("transitionend", soon, true);
    document.addEventListener("animationend", soon, true);
    return () => {
      mo.disconnect();
      window.removeEventListener("resize", soon);
      document.removeEventListener("transitionend", soon, true);
      document.removeEventListener("animationend", soon, true);
      cancelAnimationFrame(raf);
    };
  }, []);
  return null;
}
