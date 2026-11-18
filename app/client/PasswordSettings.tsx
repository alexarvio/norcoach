"use client";

import { useState, useTransition } from "react";
import { useUser } from "@clerk/nextjs";
import { setPasswordAction } from "../lib/accountActions";
import PasswordInput from "../login/PasswordInput";
import { usePasswordsOn } from "../login/usePasswordsOn";
import { offerToSavePassword } from "../lib/savePassword";
import SettingsFold from "./SettingsFold";

// Settings' Password (17 Nov, Alex: "Settings row"): everyone who signs in with an emailed code can add a password and
// sign in with it after, the code still working. One row after Your details, there only once Clerk takes passwords.
// Opened: the password (the current one first when there is one already), Cancel in words and Save, as Your details.
// The row is drawn with the page (`passwordsHint`, read by the server; 18 Nov, Alex: it came in a second late and the
// rows under it moved); a tap before Clerk's account is in opens it the moment it is (`wait`), never onto an empty fold.
export default function PasswordSettings({ passwordsHint = null }: { passwordsHint?: boolean | null }) {
  const passwords = usePasswordsOn(passwordsHint);
  const { isLoaded, user } = useUser();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (passwords !== true || (isLoaded && !user)) return null;

  const clear = () => {
    setCurrent("");
    setNext("");
    setError(null);
  };

  return (
    <SettingsFold title="Password" wait={!user}>
      {(close) => {
        if (!user) return null;
        const has = user.passwordEnabled;
        const email = user.primaryEmailAddress?.emailAddress ?? "";
        const ready = !!next && (!has || !!current);
        const save = () =>
          start(async () => {
            const r = await setPasswordAction(next, has ? current : null).catch(() => ({ ok: false, error: "Not saved. Try again." }));
            if (!r.ok) return setError(r.error ?? "Not saved. Try again.");
            await user.reload().catch(() => {});
            // The iPhone's own "Save password?" for the new one (18 Nov), so Face ID fills it at the next sign-in.
            await offerToSavePassword(email, next, { always: true });
            clear();
            close();
          });
        return (
          <form
            className="st-details-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (ready && !pending) save();
            }}
          >
            {/* The email for the phone's password manager, so it keeps the password under the right login. */}
            <input className="sr-only" type="email" name="email" autoComplete="username" value={email} readOnly tabIndex={-1} aria-hidden="true" />
            {has && (
              <label className="st-details-field">
                <span className="st-details-label">Current password</span>
                <PasswordInput name="current" autoComplete="current-password" inputClassName="st-details-input" value={current} onChange={(v) => (setCurrent(v), setError(null))} />
              </label>
            )}
            <label className="st-details-field">
              <span className="st-details-label">{has ? "New password" : "Password"}</span>
              <PasswordInput name="password" autoComplete="new-password" inputClassName="st-details-input" value={next} onChange={(v) => (setNext(v), setError(null))} />
            </label>
            {error && <p className="st-pass-error">{error}</p>}
            <div className="st-details-actions">
              <button
                type="button"
                className="st-details-cancel"
                onClick={() => {
                  clear();
                  close();
                }}
                disabled={pending}
              >
                Cancel
              </button>
              <button type="submit" className="st-details-save" disabled={!ready || pending}>
                {pending ? "Saving…" : "Save"}
              </button>
            </div>
          </form>
        );
      }}
    </SettingsFold>
  );
}
