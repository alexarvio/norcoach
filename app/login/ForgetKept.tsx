"use client";

import { useEffect } from "react";
import { forgetAllThreads } from "../coach/threadCache";
import { forgetWhereTheAppWas } from "../lib/appMemory";
import { OPENED_COOKIE } from "../lib/quietLoad";

// Every way out ends on the sign-in page (logoutAction, /auth/signout), so what this device kept for whoever was signed
// in goes here: the chats the coach's phone kept (threadCache.ts), so whoever signs in next never finds them in its
// storage, and where the client app was (lib/appMemory.ts), so signing in always lands on Home (18 Nov, Alex).
export default function ForgetKept() {
  useEffect(() => {
    forgetAllThreads();
    forgetWhereTheAppWas();
    // Signing in is an open too (19 Nov, Alex): the admin after it plays the opening, whatever played before.
    document.cookie = `${OPENED_COOKIE}=; path=/; max-age=0; samesite=lax`;
  }, []);
  return null;
}
