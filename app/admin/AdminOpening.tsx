"use client";

// The admin's opening (7 Nov, Alex: "while it's loading, just the logo. And once it's loaded, just the name appears
// from behind and boom… everything centered"): the star alone in the middle of the paper while the admin loads; once it
// is ready the NORCOACH word shoots out from behind the star, the two staying centred as one, so it ends as the logo;
// then the paper fades off the admin (OpeningLogo, the client app's too). Once a page load: the layout it sits in stays
// mounted from screen to screen, and a reload plays it again.

import { useEffect, useState } from "react";
import OpeningLogo, { OPENING_HOLD_MS } from "../components/OpeningLogo";
import { OPENED_COOKIE, QUIET_COOKIE } from "../lib/quietLoad";

let played = false;

export default function AdminOpening({ quiet = false }: { quiet?: boolean }) {
  const [state, setState] = useState<"on" | "revealing" | "gone">(() => (played || quiet ? "gone" : "on"));
  // A quiet load (onto a new build): nothing played, and the cookie goes so the next real open plays it.
  useEffect(() => {
    if (!quiet) return;
    played = true;
    document.cookie = `${QUIET_COOKIE}=; path=/; max-age=0`;
  }, [quiet]);
  const [opening] = useState(state === "on");

  useEffect(() => {
    if (!opening) return;
    played = true;
    // Played: the rest of this browser session opens quietly (a session cookie, no max-age).
    document.cookie = `${OPENED_COOKIE}=1; path=/; samesite=lax`;
    // Hydrated: the admin can be clicked. The star alone for a moment at the least, then two frames so the admin is
    // painted under the paper before the word comes and the paper goes.
    const hold = Math.max(300, OPENING_HOLD_MS - performance.now());
    let raf = 0;
    const start = window.setTimeout(() => {
      raf = requestAnimationFrame(() => {
        raf = requestAnimationFrame(() => setState("revealing"));
      });
    }, hold);
    // Should an animation never end (a background tab, say), the admin still shows.
    const done = window.setTimeout(() => setState("gone"), hold + 4500);
    return () => {
      clearTimeout(start);
      cancelAnimationFrame(raf);
      clearTimeout(done);
    };
  }, [opening]);

  if (state === "gone") return null;
  return <OpeningLogo revealing={state === "revealing"} onEnd={() => setState("gone")} />;
}
