"use client";

import { useEffect, useRef, useState } from "react";
import { useSignIn } from "@clerk/nextjs/legacy";
import { isClerkAPIResponseError } from "@clerk/nextjs/errors";
import { AuthShell } from "../../../login/SignInScreens";

// In the secure sheet: Clerk takes the person to Google (or Apple, from the Android app), back through
// /auth/native/callback to /auth/native/done. The sheet keeps nothing from before, so a session already here means this
// is not the app's sheet: it stops (review of 2e029fe: that path minted a ticket for a website session).
export function NativeStart({ nonce, provider }: { nonce: string; provider: "google" | "apple" }) {
  const name = provider === "google" ? "Google" : "Apple";
  const { isLoaded, signIn } = useSignIn();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (!isLoaded || started.current) return;
    started.current = true;
    signIn.authenticateWithRedirect({ strategy: provider === "google" ? "oauth_google" : "oauth_apple", redirectUrl: "/auth/native/callback", redirectUrlComplete: `/auth/native/done?n=${nonce}` }).catch((e) => {
      const already = isClerkAPIResponseError(e) && e.errors.some((x) => x.code === "session_exists");
      setError(already ? "Already signed in here. Close this and try again from the app." : isClerkAPIResponseError(e) ? (e.errors[0]?.longMessage ?? e.errors[0]?.message ?? `Couldn't open ${name}`) : `Couldn't open ${name}`);
    });
  }, [isLoaded, signIn, nonce, provider, name]);
  return (
    <AuthShell>
      <p className="auth-sub" style={{ textAlign: "center" }}>
        {error ?? `Opening ${name}`}
      </p>
    </AuthShell>
  );
}
