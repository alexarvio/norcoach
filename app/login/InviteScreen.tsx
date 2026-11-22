"use client";

import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { SiteShell, type InApp } from "./SignInScreens";
import PasswordInput from "./PasswordInput";
import { nativePlatform } from "../lib/native";
import "./invite.css";

// Where a coach's invite lands (22 Nov, Alex: "they could click the email link… that would lead them to creating an
// account with a password… and then because they clicked the link… we can already connect them automatically with the
// coach"): the client sign-up's `Create your account` in its dark frame (CoachSignUpScreen with `client`), the coach
// over the form as the join screens draw one, and the invited email filled in and fixed. Each screen only draws and
// reports what was typed or pressed; InviteFlow in ClerkFlows.tsx runs Clerk behind it.

/** The coach on the invite: their name, first name, business and picture (/invite/photo, read by the link's own token). */
export type InviteCoach = { name: string; first: string; business: string; photo: string | null };

/** Sign in with Apple, off on the website until it is set up (NEXT_PUBLIC_APPLE_SIGNIN=off), as SignInScreens.tsx. */
const APPLE_ON = process.env.NEXT_PUBLIC_APPLE_SIGNIN !== "off";
const noSubscribe = () => () => {};

/** The coach: their face, `Joining {first}` and the business under it. */
function CoachRow({ coach }: { coach: InviteCoach }) {
  return (
    <div className="iv-coach">
      <span className="jn-face" aria-hidden="true">
        {coach.photo ? (
          // eslint-disable-next-line @next/next/no-img-element -- the coach's own picture, served by /invite/photo
          <img src={coach.photo} alt="" decoding="async" />
        ) : (
          coach.first.charAt(0).toUpperCase()
        )}
      </span>
      <span>
        <b>Joining {coach.first}</b>
        {coach.business && <small>{coach.business}</small>}
      </span>
    </div>
  );
}

function ErrorLine({ error }: { error?: string | null }) {
  return error ? <p className="auth-error au-error">{error}</p> : null;
}

/** Apple and Google, then "or", drawn as the sign-in's (SignInScreens.tsx keeps these private; the same markup). */
function Providers({ onApple, onGoogle, busy, app }: { onApple?: () => void; onGoogle?: () => void; busy?: boolean; app: InApp }) {
  // In the iPhone app Sign in with Apple is Apple's own sheet, so it shows there even while the website's is off.
  const iosApp = useSyncExternalStore(noSubscribe, () => nativePlatform() === "ios", () => app === "ios");
  return (
    <>
      <div className="au-providers">
        {(APPLE_ON || iosApp) && (
          <button type="button" className="au-provider apple" onClick={onApple} disabled={busy}>
            <AppleGlyph />
            Continue with Apple
          </button>
        )}
        <button type="button" className="au-provider" onClick={onGoogle} disabled={busy}>
          <GoogleGlyph />
          Continue with Google
        </button>
      </div>
      <div className="au-or" role="separator">
        <span>or</span>
      </div>
    </>
  );
}

/**
 * The invite's `Create your account`: the coach, Apple, Google, or the invited email (fixed) and a password. Apple and
 * Google with that same address; the account is then this client of this coach, no code and no request. `email` null
 * when the link doesn't say whose it is: the email is typed then. `askPassword` false while Clerk takes no passwords.
 */
export function InviteSignUpScreen({
  coach,
  email,
  askPassword = true,
  onEmail,
  onApple,
  onGoogle,
  busy,
  error,
  app = null,
}: {
  coach: InviteCoach | null;
  email: string | null;
  askPassword?: boolean;
  onEmail?: (email: string, password: string) => void;
  onApple?: () => void;
  onGoogle?: () => void;
  busy?: boolean;
  error?: string | null;
  app?: InApp;
}) {
  const [typed, setTyped] = useState(email ?? "");
  const [password, setPassword] = useState("");
  return (
    <SiteShell
      title="Create your account"
      pitch={false}
      aside={
        <>
          Already have an account? <Link href="/login">Sign in</Link>
        </>
      }
    >
      {coach && <CoachRow coach={coach} />}
      <ErrorLine error={error} />
      <Providers onApple={onApple} onGoogle={onGoogle} busy={busy} app={app} />
      {/* POST, as Sign in's (18 Nov): an early tap never puts the password in the address. */}
      <form
        className="auth-form"
        method="post"
        onSubmit={(e) => {
          e.preventDefault();
          const em = (email ?? typed).trim();
          if (em && (password || !askPassword)) onEmail?.(em, askPassword ? password : "");
        }}
      >
        <label className="auth-field iv-email">
          <span>Email</span>
          {/* "username", so the phone saves the new password against this address. */}
          {email ? (
            <input name="email" type="email" autoComplete="username" value={email} readOnly />
          ) : (
            <input name="email" type="email" autoComplete="username" value={typed} onChange={(e) => setTyped(e.target.value)} required />
          )}
        </label>
        {askPassword && (
          <label className="auth-field">
            <span>Password</span>
            <PasswordInput name="password" autoComplete="new-password" value={password} onChange={setPassword} />
          </label>
        )}
        {/* Where Clerk puts its bot check when a new account is made (sign-up protection). */}
        <div id="clerk-captcha" />
        <button className="btn auth-submit" type="submit" disabled={busy}>
          {busy ? "One moment…" : "Continue"}
        </button>
      </form>
    </SiteShell>
  );
}

/**
 * Back from Apple or Google with another address than the invited one (22 Nov): no account of ours behind it, so the
 * invite says which address it is for, and `Use {email}` signs that one out (taking the account just made with it, which
 * holds nothing) and shows the invite again.
 */
export function InviteOtherAccountScreen({ coach, email, signedInAs, onUse, busy }: { coach: InviteCoach | null; email: string | null; signedInAs: string | null; onUse?: () => void; busy?: boolean }) {
  return (
    <SiteShell title="Create your account" pitch={false}>
      {coach && <CoachRow coach={coach} />}
      <p className="auth-error au-error">
        {signedInAs ? `Signed in as ${signedInAs}` : "Signed in with another account"}
        {email ? `, not ${email}.` : "."}
      </p>
      <button className="btn auth-submit" type="button" onClick={onUse} disabled={busy}>
        {busy ? "One moment…" : email ? `Use ${email}` : "Use another account"}
      </button>
    </SiteShell>
  );
}

function AppleGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
      <path d="M16.37 12.57c-.02-2.2 1.8-3.26 1.88-3.31-1.02-1.5-2.62-1.7-3.19-1.72-1.36-.14-2.65.8-3.34.8-.69 0-1.75-.78-2.88-.76-1.48.02-2.85.86-3.61 2.19-1.54 2.67-.39 6.62 1.11 8.79.73 1.06 1.6 2.25 2.75 2.2 1.1-.04 1.52-.71 2.85-.71 1.33 0 1.71.71 2.88.69 1.19-.02 1.94-1.08 2.67-2.14.84-1.23 1.19-2.42 1.21-2.48-.03-.01-2.32-.89-2.33-3.55zM14.18 6.1c.61-.74 1.02-1.76.91-2.78-.88.04-1.94.59-2.57 1.32-.56.65-1.06 1.69-.93 2.69.98.08 1.98-.5 2.59-1.23z" />
    </svg>
  );
}

function GoogleGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.56c2.08-1.92 3.28-4.74 3.28-8.09z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.56-2.76c-.98.66-2.23 1.06-3.72 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.11A6.6 6.6 0 0 1 5.5 12c0-.73.13-1.44.34-2.11V7.05H2.18A11 11 0 0 0 1 12c0 1.78.43 3.46 1.18 4.95l3.66-2.84z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.05l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z" />
    </svg>
  );
}
