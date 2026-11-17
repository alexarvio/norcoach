"use client";

import { useEffect } from "react";
import { forgetAllThreads } from "../coach/threadCache";

// Every way out ends on the sign-in page (logoutAction, /auth/signout), so the chats the coach's phone kept on this
// device (threadCache.ts) go here: whoever signs in next on this browser never finds them in its storage.
export default function ForgetKeptChats() {
  useEffect(() => forgetAllThreads(), []);
  return null;
}
