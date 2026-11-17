"use client";

import { useEffect } from "react";

// The faint logo behind Home and every chat sits at ONE spot on the screen (17 Nov, Alex and Finlay: going from Home to a
// chat it "clicks a little bit"): each box drew it 6px below its own top, and Home's content starts lower (under the
// Norcoach bar) than a chat's. Every box that draws it is told how far its top is from that spot (`--mark-y`, read by its
// background in globals.css), the spot being 6px under where Home's content starts. Mounted once in the client app.
//
// A box's own slide is left out (17 Nov, Alex: in the iPhone app the logo jumped as a message was sent): the chat's
// thread rides up with the keyboard by `translate` (keyboard.ts, `kb-moving`), and its background follows the slide back
// by itself in globals.css (`--mark-ride`), so the distance here is from where the box sits in the layout. Read while
// it slid, the logo was placed a keyboard's height too low once the slide ended, and stayed there until the next message
// was added and read it again.

const BOXES = ".app-content, .cm-body";

/** How far a box is moved by its own `translate` (px down), so its layout top can be read during a slide. */
function ownSlide(box: HTMLElement): number {
  const t = getComputedStyle(box).translate;
  if (!t || t === "none") return 0;
  const y = parseFloat(t.split(" ")[1] ?? "0");
  return Number.isFinite(y) ? y : 0;
}

export default function MarkAnchor() {
  useEffect(() => {
    // Where Home's content starts on screen, kept once seen (the chat covers Home, so it is read while Home shows).
    let homeTop: number | null = null;
    let raf = 0;
    const place = () => {
      raf = 0;
      const home = document.querySelector<HTMLElement>(".app-content");
      if (home && home.offsetParent !== null) homeTop = home.getBoundingClientRect().top - ownSlide(home);
      const spot = (homeTop ?? 0) + 6;
      document.querySelectorAll<HTMLElement>(BOXES).forEach((box) => {
        const y = `${Math.round(spot - (box.getBoundingClientRect().top - ownSlide(box)))}px`;
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
    // The keyboard's states and height on <html> (keyboard.ts: kb-open, kb-moving, kb-up…, --kb), which move boxes
    // without adding anything to the page.
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
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
