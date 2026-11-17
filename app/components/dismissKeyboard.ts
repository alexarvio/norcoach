import type React from "react";

// A tap on a chat's messages puts the keyboard away (17 Nov, Alex: "if I am speaking with someone I can't leave the
// keyboard… tap on the chat and for it to go away"), as WhatsApp does. A tap on something that does a thing (a link, a
// button, a picture, a field, a message's menu) is that thing's, and leaves the keyboard as it is.
const ACTS = "a, button, input, textarea, select, label, video, audio, [role='button'], [role='menu'], [role='menuitem'], [contenteditable]";

export function dismissKeyboardOnTap(e: React.MouseEvent) {
  const target = e.target as Element | null;
  if (!target || target.closest(ACTS)) return;
  const el = document.activeElement as HTMLElement | null;
  if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable)) el.blur();
}
