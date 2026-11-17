"use client";

import { useEffect } from "react";

// The room the iPhone app leaves under the clock (`--sat`, globals.css) held still (17 Nov, Alex: coming back to the app,
// Home's title, date and Today "shift a tiny bit and go back"). Back from the background, iOS gives the page a top inset
// a few pixels off for a moment, and everything sized from it moved with it. The inset is read once the app has been in
// front a moment and kept, so a passing wrong reading never moves the page. The app is upright only (17 Nov), so the
// inset doesn't change while it runs; a width change (a new phone size in the simulator) reads it again.

export default function StableInset() {
  useEffect(() => {
    const root = document.documentElement;
    if (!root.classList.contains("native-app")) return;
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;top:0;left:0;width:0;height:env(safe-area-inset-top,0px);visibility:hidden;pointer-events:none";
    document.body.appendChild(probe);
    let kept: number | null = null;
    let width = window.innerWidth;
    let timer = 0;
    const read = () => {
      timer = 0;
      if (document.visibilityState !== "visible") return;
      const h = Math.round(probe.getBoundingClientRect().height);
      if (h <= 0 || h === kept) return;
      kept = h;
      root.style.setProperty("--sat", `${h}px`);
    };
    read();
    // Back in front: let the phone settle before reading again, and keep what was there meanwhile.
    const back = () => {
      if (document.visibilityState !== "visible") return;
      window.clearTimeout(timer);
      timer = window.setTimeout(read, 800);
    };
    const resized = () => {
      if (window.innerWidth === width) return;
      width = window.innerWidth;
      kept = null;
      back();
    };
    document.addEventListener("visibilitychange", back);
    window.addEventListener("resize", resized);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", back);
      window.removeEventListener("resize", resized);
      probe.remove();
      root.style.removeProperty("--sat");
    };
  }, []);
  return null;
}
