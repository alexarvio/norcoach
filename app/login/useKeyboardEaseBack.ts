"use client";

import { useEffect, type RefObject } from "react";
import { isTextField, keyboardCovered, keyboardOpen, subscribeKeyboard } from "../client/keyboard";
import "./signin-keyboard.css";

/**
 * The sign-in and sign-up screens as the keyboard goes down (27 Nov, Alex: on Create your account in the app "the
 * textboxes for email and password… jump"). While it is up the page has the keyboard's room at its foot and may be
 * scrolled into it; the moment it goes, that room is held (data-kb-hold, signin-keyboard.css) and the page glides back to
 * where it can rest without it, then lets the room go, so nothing snaps down. Only with no text field in the focus: a
 * field that still has it means the keyboard is coming back (from field to field), and the room waits for it a moment.
 */
export function useKeyboardEaseBack(page: RefObject<HTMLElement | null>) {
  useEffect(() => {
    let wasOpen = keyboardOpen();
    let covered = wasOpen ? keyboardCovered() : 0;
    let raf = 0;
    let wait = 0;

    const release = () => {
      cancelAnimationFrame(raf);
      raf = 0;
      window.clearTimeout(wait);
      wait = 0;
      const p = page.current;
      if (p) {
        delete p.dataset.kbHold;
        p.style.removeProperty("--su-kb-hold");
      }
    };

    /** Scrolls back to where the page can rest without the keyboard's room, then lets the room go. */
    const glide = (room: number) => {
      const p = page.current;
      if (!p) return release();
      const r = p.getBoundingClientRect();
      // The page's own height without the room: at least the screen's (min-height), else its content's.
      const natural = Math.max(window.innerHeight, r.height - room);
      const rest = Math.max(0, Math.round(r.top + window.scrollY + natural - window.innerHeight));
      if (window.scrollY <= rest + 1) return release();
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      window.scrollTo({ top: rest, behavior: reduce ? "auto" : "smooth" });
      const until = performance.now() + 900;
      const watch = () => {
        if (Math.abs(window.scrollY - rest) <= 1 || performance.now() > until) return release();
        raf = requestAnimationFrame(watch);
      };
      raf = requestAnimationFrame(watch);
    };

    const changed = () => {
      const open = keyboardOpen();
      if (open) {
        // Up (again): its own room (kb-open) takes over from the one held.
        if (!wasOpen) release();
        wasOpen = true;
        covered = keyboardCovered() || covered;
        return;
      }
      if (!wasOpen) return;
      wasOpen = false;
      const room = covered;
      covered = 0;
      const p = page.current;
      if (!p || room <= 0) return;
      release();
      p.style.setProperty("--su-kb-hold", `${room}px`);
      // A data attribute, never a class: SiteShell's className is React's, and a re-render (JoinFlow's jn-sent as
      // Send request comes back) would wipe a class added by hand and drop the room in one frame.
      p.dataset.kbHold = "";
      if (!isTextField(document.activeElement)) return glide(room);
      wait = window.setTimeout(() => {
        wait = 0;
        if (keyboardOpen()) return release();
        if (!isTextField(document.activeElement)) glide(room);
        else release();
      }, 400);
    };

    const off = subscribeKeyboard(changed);
    return () => {
      off();
      release();
    };
  }, [page]);
}
