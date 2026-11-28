// Android's back button and back gesture in the phone app (28 Nov, Alex: "lets work on all fixes").
// No screen in the app is a page in the history (pushed screens, the workout and pop-ups are React state), so back
// is worked out from what is on screen, in this order:
//   1. the pop-up on top closes: its own [data-back] (✕, Cancel, a step back) is clicked, else an Escape goes to it,
//      so its own Escape path runs (CheckInDialog's "Discard changes?", NotifPopup's close-all);
//   2. else the pushed screen on top goes back by its own back button ([data-back]), so every leave keeps what its
//      button does (Back to chat, "Leave without sending 2 photos?", the workout's leave);
//   3. else a tab's own way back ([data-back-tab], Nutrition's Back to chat);
//   4. else on a tab that isn't the first, the first (Home; the coach phone's Chats);
//   5. else off the app (the invoice page, privacy, support) the page before, and in the app the app is minimised,
//      never killed, so it opens again where it was.
// The lock sheet never closes on back. DOM only, no React: NativeBack (app/components/NativeBack.tsx) calls it.

import { callNative } from "./native";

const POPUPS = '[aria-modal="true"], [data-back-layer]';

function usable(el: Element): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  if (el.getClientRects().length === 0) return false; // display:none, or not drawn
  if (el.closest('[inert], [aria-hidden="true"]')) return false; // a layer under a pushed screen, a hidden tab
  if (el.closest(".lk-sheet")) return false; // the locked app's sheet stays
  if (el instanceof HTMLButtonElement && el.disabled) return false;
  return true;
}

/** The one drawn on top: hit at its own middle; with none hit, the last in the page. */
function topOf<T extends HTMLElement>(list: T[]): T | null {
  if (list.length === 0) return null;
  let hit: T | null = null;
  for (const el of list) {
    const r = el.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (at && el.contains(at)) hit = el;
  }
  return hit ?? list[list.length - 1];
}

function all(selector: string, root: ParentNode = document): HTMLElement[] {
  return [...root.querySelectorAll(selector)].filter(usable);
}

function escapeTo(target: Element) {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true, cancelable: true }));
}

/** Off the app's own screens, back is the page before (never back into sign-in from a page after it). */
function offTheApp(path: string) {
  if (path.startsWith("/client") || path.startsWith("/coach")) return false;
  if (path === "/" || path.startsWith("/login") || path.startsWith("/auth") || path.startsWith("/sign")) return false;
  return true;
}

export function handleAndroidBack(canGoBack: boolean) {
  try {
    // 1. A pop-up.
    const modal = topOf(all(POPUPS));
    if (modal) {
      const own = modal.matches("[data-back]") ? modal : all("[data-back]", modal).pop();
      if (own) own.click();
      else escapeTo(document.activeElement && modal.contains(document.activeElement) ? document.activeElement : modal);
      return;
    }
    // 2. A pushed screen's back button.
    const back = topOf(all("[data-back]"));
    if (back) return back.click();
    // 3. A tab's own way back.
    const tabBack = topOf(all("[data-back-tab]"));
    if (tabBack) return tabBack.click();
    // 4. Home first.
    const home = all('[data-home-tab="off"]')[0];
    if (home) return home.click();
    // 5. The page before, or out of the app.
    if (canGoBack && offTheApp(window.location.pathname)) return window.history.back();
    void callNative("App", "minimizeApp").catch(() => {});
  } catch {
    void callNative("App", "minimizeApp").catch(() => {});
  }
}

// To try it from a desktop browser's console in dev: window.__ncBack()
if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
  (window as { __ncBack?: () => void }).__ncBack = () => handleAndroidBack(false);
}
