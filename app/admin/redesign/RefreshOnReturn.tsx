"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { onRefreshFree, refreshHeld } from "./holdRefresh";

// The coach coming back to the window (23 Oct, Alex): the page is read again, so a weight or a session the client
// logged on their phone meanwhile shows without a reload. At most once every 15 seconds, and only when it can't
// disturb: not while a text field has the keyboard, a pop-up, menu or list is open, a pending bar holds changes, a
// button is held down, or a save is on its way or changes wait (holdRefresh). A skipped read runs once that clears.
// Nothing shows for it. Mounted once, by the rail, on every redesign screen.

const GAP_MS = 15000;
const RETRY_MS = 2000;
const TYPED = /^(text|search|email|number|tel|url|password|date|datetime-local|month|time|week)$/;
const OPEN = "[role=dialog], [role=alertdialog], [role=menu], [role=listbox], [data-radix-popper-content-wrapper], [data-slot=dialog-overlay], .rd-pending";

function typing(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  return el.tagName === "INPUT" && TYPED.test((el as HTMLInputElement).type || "text");
}

// A button held down, kept by RefreshOnReturn's listeners (mounted by the rail on every redesign screen).
let pressed = false;

/** Nothing on the page a read could disturb: no button held, nothing holding refreshes (holdRefresh), no field with
 *  the keyboard, no pop-up, menu, list or pending bar open. The rail's after-landing read waits for it too. */
export function calm(): boolean {
  return !pressed && !refreshHeld() && !typing() && !document.querySelector(OPEN);
}

export default function RefreshOnReturn() {
  const router = useRouter();
  // The 15s gap counts from the page's last arrival too (22 Nov): mounted once with the rail now (RailFrame), so a page
  // just read on a move is never read again by a return within the gap, as when each page mounted its own.
  const last = useRef(Date.now());
  const path = usePathname();
  const search = useSearchParams().toString();
  useEffect(() => {
    last.current = Date.now();
  }, [path, search]);
  useEffect(() => {
    let owed = false;
    let poll: ReturnType<typeof setInterval> | null = null;
    let soon: ReturnType<typeof setTimeout> | null = null;
    const stopPoll = () => {
      if (poll) clearInterval(poll);
      poll = null;
    };
    const attempt = () => {
      if (!owed || document.visibilityState !== "visible") return;
      if (!calm()) {
        poll ??= setInterval(attempt, RETRY_MS);
        return;
      }
      owed = false;
      stopPoll();
      last.current = Date.now();
      void readAgain();
    };
    // Never across a deploy (16 Nov, Alex: "the admin reloads itself a lot"): a read from a newer build makes Next load
    // the whole page again. On a new build the page stays as it is; FreshBuild moves it on at the next click elsewhere.
    const page = document.documentElement.dataset.build;
    const readAgain = async () => {
      try {
        const now = page ? (await (await fetch("/api/version", { cache: "no-store" })).json())?.build : null;
        if (page && typeof now === "string" && now !== "unknown" && now !== page) return;
      } catch {
        return;
      }
      router.refresh();
    };
    // Soon, not now: a pop-up closing, a field left or a hold let go settles first.
    const later = () => {
      if (!owed) return;
      if (soon) clearTimeout(soon);
      soon = setTimeout(attempt, 250);
    };
    const back = () => {
      if (document.visibilityState !== "visible" || Date.now() - last.current < GAP_MS) return;
      owed = true;
      attempt();
    };
    const onVisible = () => (document.visibilityState === "visible" ? back() : stopPoll());
    const down = () => {
      pressed = true;
    };
    const up = () => {
      pressed = false;
      later();
    };
    // A press let go outside the window never comes back as a pointerup.
    const away = () => {
      pressed = false;
    };
    window.addEventListener("focus", back);
    window.addEventListener("blur", away);
    document.addEventListener("visibilitychange", onVisible);
    document.addEventListener("focusout", later, true);
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    const unfree = onRefreshFree(later);
    return () => {
      stopPoll();
      if (soon) clearTimeout(soon);
      unfree();
      window.removeEventListener("focus", back);
      window.removeEventListener("blur", away);
      document.removeEventListener("visibilitychange", onVisible);
      document.removeEventListener("focusout", later, true);
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
    };
  }, [router]);
  return null;
}
