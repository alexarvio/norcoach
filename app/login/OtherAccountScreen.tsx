"use client";

import { useState } from "react";
import { SiteShell } from "./SignInScreens";

/**
 * A sign-up that came back with an account of the other kind (27 Nov, Alex: Client on Sign in "logs me into a coach
 * account"): the client's Create your account with a coach's email, Apple or Google, or the coach sign-up with a
 * client's. One email is one account, so it says whose this is: `Use another email` signs it out and opens that sign-up
 * again (with the coach's code from their link), and Open Norcoach in words goes into the account as a sign-in does.
 */
export function OtherAccountScreen({ as, email, code = "" }: { as: "client" | "coach"; email: string | null; code?: string }) {
  const [busy, setBusy] = useState(false);
  const kind = as === "client" ? "coach" : "client";
  const back = as === "client" ? `/auth/signout?to=join${code ? `&code=${encodeURIComponent(code)}` : ""}` : "/auth/signout?to=signup";
  return (
    <SiteShell title={as === "coach" ? "Create your coach account" : "Create your account"} pitch={as === "coach"}>
      <p className="auth-error au-error">{email ? `${email} is a ${kind} account.` : `This is a ${kind} account.`}</p>
      <button
        className="btn auth-submit"
        type="button"
        onClick={() => {
          setBusy(true);
          window.location.assign(back);
        }}
        disabled={busy}
      >
        {busy ? "One moment…" : "Use another email"}
      </button>
      <p className="auth-note">
        <a href="/auth/continue" onClick={() => setBusy(true)}>
          Open Norcoach
        </a>
      </p>
    </SiteShell>
  );
}
