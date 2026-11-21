"use client";

import { useEffect, useState } from "react";
import { useOffline } from "next/offline";

// Offline only once it holds (21 Nov, Alex: logging a set, "for like an instant… a little pop-up… below the set… and then
// it goes away"). Next's useOffline turns true the moment any navigation, prefetch or server action fetch fails, and back
// once its background check passes, so a blip (a prefetch dropped while a set is on its way) flashed `Not sent yet` under
// the set for a frame. A set's `Not sent yet` takes the phone as offline only after it has stayed so for HOLD_MS; a real
// loss of signal still shows it at once after that, and a set waiting 3 s shows it whatever the signal says.

const HOLD_MS = 1500;

export function useSteadyOffline(): boolean {
  const offline = useOffline();
  const [steady, setSteady] = useState(false);
  useEffect(() => {
    if (!offline) {
      const t = setTimeout(() => setSteady(false), 0);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setSteady(true), HOLD_MS);
    return () => clearTimeout(t);
  }, [offline]);
  return offline && steady;
}
