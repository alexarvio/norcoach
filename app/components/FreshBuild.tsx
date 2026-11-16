"use client";

import { useEffect } from "react";
import { QUIET_COOKIE } from "../lib/quietLoad";

// A page left open across a deploy calls saves the new server no longer has, and every save fails until the app is
// opened afresh (30 Oct, Alex: a client couldn't save his check-in; the server answered "not found" seven times in a
// minute). So the page reloads itself onto the new build: when the app comes back to the screen and the server runs
// another build, and at once when a save comes back unknown, since nothing on that page can be saved any more.
const CHECK_EVERY_MS = 60_000;
// The admin (16 Nov, Alex: "the admin panel keeps reloading itself"): a new build never reloads it under the coach as
// they come back to the window. It waits for their next click to another screen, which then loads in full, and that
// load, as one after a save the server no longer knows, skips the opening (the quiet cookie, read by app/admin/layout.tsx).
const quiet = () => {
  document.cookie = `${QUIET_COOKIE}=1; path=/; max-age=60; samesite=lax`;
};
const onAdmin = () => window.location.pathname.startsWith("/admin");

export default function FreshBuild({ build }: { build: string }) {
  useEffect(() => {
    let reloading = false;
    const reload = () => {
      if (reloading) return;
      reloading = true;
      quiet();
      window.location.reload();
    };
    // The admin on an older build: the next click on a link to another of its screens is a full load onto the new one.
    let stale = false;
    const onClick = (e: MouseEvent) => {
      if (!stale || reloading || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
      const to = new URL(a.href, window.location.href);
      if (to.origin !== window.location.origin || (to.pathname === window.location.pathname && to.search === window.location.search)) return;
      e.preventDefault();
      reloading = true;
      quiet();
      window.location.assign(to.toString());
    };
    document.addEventListener("click", onClick, true);

    // A save the server doesn't know (Next marks it with this header): the page is from an older build.
    const original = window.fetch;
    const patched: typeof fetch = async (input, init) => {
      const res = await original(input, init);
      try {
        const h = init?.headers;
        const action = h instanceof Headers ? h.has("next-action") : !!h && !Array.isArray(h) && "next-action" in h;
        if (action && res.headers.get("x-nextjs-action-not-found") === "1") setTimeout(reload, 400);
      } catch {}
      return res;
    };
    window.fetch = patched;

    // Back on the screen: is the server still on this page's build?
    let last = Date.now();
    const check = async () => {
      if (document.visibilityState !== "visible" || Date.now() - last < CHECK_EVERY_MS) return;
      last = Date.now();
      try {
        const res = await original("/api/version", { cache: "no-store" });
        if (!res.ok) return;
        const now = (await res.json())?.build;
        if (typeof now === "string" && now !== "unknown" && build !== "unknown" && now !== build) {
          if (onAdmin()) stale = true;
          else reload();
        }
      } catch {}
    };
    document.addEventListener("visibilitychange", check);
    window.addEventListener("pageshow", check);
    window.addEventListener("focus", check);
    window.addEventListener("online", check);
    return () => {
      if (window.fetch === patched) window.fetch = original;
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("pageshow", check);
      window.removeEventListener("focus", check);
      window.removeEventListener("online", check);
    };
  }, [build]);
  return null;
}
