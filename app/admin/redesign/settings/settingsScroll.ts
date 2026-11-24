"use client";

import { useSyncExternalStore } from "react";

// Settings is one page, one section showing at a time (23 Oct, Alex; the list on the left since 27 Oct). The page
// (SettingsBoard) says which section is showing (sayOpen) and takes clicks to a section while it is there
// (onGoToSetting); a link on the page hands its key over (goToSetting), which shows that section and brings it into
// view. Any address key goes: a section's, or an old one merged into another (#billing, #notifications, #data), which
// shows the section holding it at that part (settingsNav's resolveSetting). On any other page such a link is a plain
// /settings#<key>.

const GO = "rst:go";
const OPEN = "rst:open";
let listening = false;
let open: string | null = null;

/** Opens a section of the Settings page in place (the open one folds). False when the page isn't there. */
export function goToSetting(key: string): boolean {
  if (!listening) return false;
  window.dispatchEvent(new CustomEvent<string>(GO, { detail: key }));
  return true;
}

/** The page takes the rail's clicks while it is there. Returns the cleanup. */
export function onGoToSetting(go: (key: string) => void): () => void {
  const on = (e: Event) => go((e as CustomEvent<string>).detail);
  listening = true;
  window.addEventListener(GO, on);
  return () => {
    listening = false;
    window.removeEventListener(GO, on);
    sayOpen(null);
  };
}

/** The page says which section is open (null: all folded). */
export function sayOpen(key: string | null) {
  if (open === key) return;
  open = key;
  window.dispatchEvent(new Event(OPEN));
}

const subscribe = (changed: () => void) => {
  window.addEventListener(OPEN, changed);
  return () => window.removeEventListener(OPEN, changed);
};

/** The section open on the Settings page, for the rail to mark; null elsewhere or when all are folded. */
export function useOpenSetting(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => open,
    () => null,
  );
}
