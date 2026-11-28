"use client";

import { useEffect } from "react";
import { handleAndroidBack } from "../lib/androidBack";
import { nativePlatform, onNative, type NativeListener } from "../lib/native";

// Android's back button and back gesture (28 Nov, Alex): the pop-up on top, else the pushed screen, else Home, else the
// app minimised, never killed (app/lib/androidBack.ts). Once a page listens, Capacitor's own back (the WebView's
// history, which led back to the sign-in) is off. A full page load drops every native listener, so this is in the root
// layout, on every page. iOS has no back button and never hears it.

// One listener at a time: two would take two steps back for one press (a double mount in dev, a remount).
let listening: NativeListener | null = null;

export default function NativeBack() {
  useEffect(() => {
    if (nativePlatform() !== "android" || listening) return;
    const handle = onNative<{ canGoBack?: boolean }>("App", "backButton", (e) => handleAndroidBack(!!e?.canGoBack));
    if (!handle) return;
    listening = handle;
    return () => {
      if (listening === handle) listening = null;
      void handle.remove().catch(() => {});
    };
  }, []);
  return null;
}
