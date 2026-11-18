"use client";

import { useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { nativePlatform } from "../lib/native";
import { NorCoachLogo } from "../components/NorCoachLogo";
import { Bars } from "../client/Bars";
import { useKeyboardReveal } from "../client/keyboard";
import PasswordInput from "./PasswordInput";
import { NativeStatusBar } from "../client/NativeStatusBar";
// The website's dark background, one file for the site and the coach sign-up (17 Nov, Alex): change it there.
import "../../website/site-bg.css";

// The sign-in screens for the switch to Clerk (26 Sep): an email code or Apple
// or Google, for coaches and clients alike; since 17 Nov (Alex) a coach who
// signs up by email sets a password too, and signs in with it, the emailed
// code then confirming the address and checking a new device. Each screen
// only draws and reports what was typed or pressed; ClerkFlows.tsx runs
// Clerk behind them, and the onboarding board shows them with nothing
// wired (every handler optional).

type Busy = { busy?: boolean; error?: string | null };
type Oauth = { onApple?: () => void; onGoogle?: () => void };

export function AuthShell({ children }: { children: ReactNode }) {
  // The field being typed in stays above the phone's keyboard (12 Nov; keyboard.ts).
  useKeyboardReveal();
  return (
    <div className="auth-page au-page">
      {/* The clock dark over the light card in the iPhone app, after the dark sign-in screens set it white. */}
      <NativeStatusBar />
      <div className="auth-card au-card">
        <div className="auth-brand">
          <NorCoachLogo />
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * The coach sign-up's frame (17 Nov, Alex: B of docs/boards/coach-signup-mockup.html, "I definitely like B"): the
 * website carries on. On a laptop the website's dark background (site-bg.css, shared with the site) with the logo and
 * its hero line beside the form on paper; on a phone the dark is a short head with the screen's title over the paper.
 * The title is drawn in the head on a phone and over the form on a laptop, one of the two hidden at a time.
 */
export function SiteShell({ title, children, aside }: { title: ReactNode; children?: ReactNode; aside?: ReactNode }) {
  useKeyboardReveal();
  return (
    <div className="su-page">
      {/* In the iPhone app the clock and battery turn white over the dark (they followed only the client app). */}
      <NativeStatusBar leaveDark />
      <div className="su-band site-bg site-bg-mark" data-clock="dark">
        <NorCoachLogo className="su-logo" />
        <p className="su-pitch" aria-hidden="true">
          Scale the quality <span>of your online coaching.</span>
        </p>
        <h1 className="su-head">{title}</h1>
      </div>
      <div className="su-paper">
        {aside && <p className="su-aside top">{aside}</p>}
        <div className="su-form au-card">
          <h1 className="su-title">{title}</h1>
          {children}
          {aside && <p className="su-aside foot">{aside}</p>}
        </div>
        <p className="su-legal">
          <Bars parts={[<a key="p" href="/privacy">Privacy policy</a>, <a key="s" href="/support">Support</a>]} />
        </p>
      </div>
    </div>
  );
}

const SignInLink = () => (
  <>
    Already have an account? <a href="/login">Sign in</a>
  </>
);

function ErrorLine({ error }: { error?: string | null }) {
  return error ? <p className="auth-error au-error">{error}</p> : null;
}

/** Sign in with Apple, off until it is set up for the live sign-in (26 Oct: NEXT_PUBLIC_APPLE_SIGNIN=off on the server
    until Apple approves the developer account); on everywhere else. */
const APPLE_ON = process.env.NEXT_PUBLIC_APPLE_SIGNIN !== "off";

const noSubscribe = () => () => {};

/** Which phone app the page is in, as the server tells it from the app's own cookie (NATIVE_COOKIE) and the phone's name
 *  (18 Nov: the sign-in drew "Coaching others?" and then took it away in the app); null in a browser or when it can't tell. */
export type InApp = "ios" | "android" | null;

/** Apple and Google, then "or", then the email box. */
function Providers({ verb = "Continue", onApple, onGoogle, busy, app = null }: Oauth & { verb?: string; busy?: boolean; app?: InApp }) {
  // In the iPhone app Sign in with Apple is Apple's own sheet (11 Nov, Alex), so it shows there even while the website's
  // is off: drawn with the page where the server can tell the app (`app`, from its cookie; 18 Nov), else once it has drawn.
  const iosApp = useSyncExternalStore(noSubscribe, () => nativePlatform() === "ios", () => app === "ios");
  return (
    <div className="au-providers">
      {(APPLE_ON || iosApp) && (
        <button type="button" className="au-provider apple" onClick={onApple} disabled={busy}>
          <AppleGlyph />
          {verb} with Apple
        </button>
      )}
      <button type="button" className="au-provider" onClick={onGoogle} disabled={busy}>
        <GoogleGlyph />
        {verb} with Google
      </button>
    </div>
  );
}

function Or() {
  return (
    <div className="au-or" role="separator">
      <span>or</span>
    </div>
  );
}

/**
 * Signing in, coach or client (17 Nov, Alex: "make the sign in have that dark look… the email and password combo"): the
 * coach sign-up's frame, Apple, Google, then the email and the password together. Sign in with a password goes in with
 * it; with the password left empty it emails a code, as everyone signs in today, and so does "Email me a code instead".
 * The password field shows once Clerk takes passwords (`passwords`); until then the email alone and Continue, a code.
 */
export function SignInScreen({
  onEmail,
  onPassword,
  onForgot,
  onApple,
  onGoogle,
  busy,
  error,
  notice,
  signupHref = "/signup",
  passwords = false,
  app = null,
}: Oauth &
  Busy & {
    /** A code to the email. */
    onEmail?: (email: string) => void;
    onPassword?: (email: string, password: string) => void;
    onForgot?: (email: string) => void;
    notice?: string | null;
    signupHref?: string;
    passwords?: boolean;
    /** The phone app the page is in, as the server can tell it (InApp). */
    app?: InApp;
  }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [needEmail, setNeedEmail] = useState(false);
  const emailBox = useRef<HTMLInputElement>(null);
  const inApp = useSyncExternalStore(noSubscribe, () => nativePlatform() != null, () => app != null);
  /** A link that needs the email: it asks for it first. */
  const withEmail = (go?: (email: string) => void) => {
    const e = email.trim();
    if (!e) {
      setNeedEmail(true);
      emailBox.current?.focus();
      return;
    }
    setNeedEmail(false);
    go?.(e);
  };
  return (
    <SiteShell
      title="Sign in"
      // Not inside the phone app (13 Nov): it is the clients' way in; coaches sign up on the website.
      aside={
        inApp ? undefined : (
          <>
            Coaching others? <a href={signupHref}>Create a coach account</a>
          </>
        )
      }
    >
      {notice && <p className="auth-ok">{notice}</p>}
      <ErrorLine error={needEmail ? "Add your email first." : error} />
      <Providers onApple={onApple && (() => (setNeedEmail(false), onApple()))} onGoogle={onGoogle && (() => (setNeedEmail(false), onGoogle()))} busy={busy} app={app} />
      <Or />
      {/* POST (18 Nov): a Sign in tapped before the page has taken over sends what was typed in the request's body, never
          in the address, where a password would show and be logged. */}
      <form
        className="auth-form"
        method="post"
        onSubmit={(e) => {
          e.preventDefault();
          const em = email.trim();
          if (!em) return;
          setNeedEmail(false);
          if (passwords && password) onPassword?.(em, password);
          else onEmail?.(em);
        }}
      >
        <label className="auth-field">
          <span>Email</span>
          {/* "username", so a password manager offers the saved login (17 Nov: passwords). */}
          <input
            ref={emailBox}
            name="email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setNeedEmail(false);
            }}
            required
          />
        </label>
        {passwords && (
          <label className="auth-field">
            <span>Password</span>
            <PasswordInput name="password" autoComplete="current-password" required={false} value={password} onChange={setPassword} />
          </label>
        )}
        {/* Where Clerk puts its bot check when a new account is made (sign-up protection). */}
        <div id="clerk-captcha" />
        <button className="btn auth-submit" type="submit" disabled={busy}>
          {busy ? "One moment…" : passwords ? "Sign in" : "Continue"}
        </button>
      </form>
      {passwords && (
        <p className="auth-note su-links">
          <Bars
            parts={[
              <button key="f" type="button" className="au-link" onClick={() => withEmail(onForgot)} disabled={busy}>
                Forgot password?
              </button>,
              <button key="c" type="button" className="au-link" onClick={() => withEmail(onEmail)} disabled={busy}>
                Email me a code instead
              </button>,
            ]}
          />
        </p>
      )}
    </SiteShell>
  );
}

/** The six boxes for an emailed code. Typing moves along; a pasted code fills them all; `onFull` with all six in. */
function CodeBoxes({ digits, setDigits, onFull, autoFocus = true }: { digits: string[]; setDigits: (d: string[]) => void; onFull?: (code: string) => void; autoFocus?: boolean }) {
  const boxes = useRef<(HTMLInputElement | null)[]>([]);
  const put = (i: number, value: string) => {
    const only = value.replace(/\D/g, "");
    const next = [...digits];
    if (only.length > 1) {
      only.slice(0, 6 - i).split("").forEach((d, k) => (next[i + k] = d));
      setDigits(next);
      boxes.current[Math.min(5, i + only.length)]?.focus();
      if (next.every((x) => x)) onFull?.(next.join(""));
      return;
    }
    next[i] = only;
    setDigits(next);
    if (only && i < 5) boxes.current[i + 1]?.focus();
    if (only && next.every((x) => x)) onFull?.(next.join(""));
  };
  return (
    <div className="au-code" role="group" aria-label="The code from the email">
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => {
            boxes.current[i] = el;
          }}
          value={d}
          inputMode="numeric"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          autoFocus={autoFocus && i === 0}
          maxLength={6}
          aria-label={`Digit ${i + 1}`}
          onChange={(e) => put(i, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Backspace" && !d && i > 0) boxes.current[i - 1]?.focus();
          }}
        />
      ))}
    </div>
  );
}

const SIX = ["", "", "", "", "", ""];

/** The six digits from the email; the last digit sends. In the coach sign-up's frame with `look="site"` (17 Nov). */
export function CodeScreen({ email, title = "Check your email", note, onVerify, onResend, onBack, busy, error, look = "card" }: Busy & { email: string; title?: string; /** A fact over the code's line: "No password on this account yet." */ note?: string | null; onVerify?: (code: string) => void; onResend?: () => void; onBack?: () => void; look?: "card" | "site" }) {
  const [digits, setDigits] = useState<string[]>(SIX);
  const body = (
    <>
      <p className="auth-note auth-note-top">
        {note && (
          <>
            {note}{" "}
          </>
        )}
        We sent a 6-digit code to <b>{email}</b>.
      </p>
      <ErrorLine error={error} />
      <form
        className="auth-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (digits.every((x) => x)) onVerify?.(digits.join(""));
        }}
      >
        <CodeBoxes digits={digits} setDigits={setDigits} onFull={onVerify} />
        <button className="btn auth-submit" type="submit" disabled={busy || digits.some((x) => !x)}>
          {busy ? "Checking…" : "Continue"}
        </button>
      </form>
      <p className="auth-note">
        Nothing there? Check spam, or{" "}
        <button type="button" className="au-link" onClick={onResend} disabled={busy}>
          send a new code
        </button>
      </p>
      <p className="auth-note">
        <button type="button" className="au-link" onClick={onBack}>
          Use a different email
        </button>
      </p>
    </>
  );
  if (look === "site") return <SiteShell title={title}>{body}</SiteShell>;
  return (
    <AuthShell>
      <h1 className="auth-title">{title}</h1>
      {body}
    </AuthShell>
  );
}

/** A new password (17 Nov): the code emailed to the account and the new password, then signed in with it. In the
 *  sign-in's frame with `look="site"`. */
export function ResetPasswordScreen({ email, onSubmit, onResend, onBack, busy, error, look = "card" }: Busy & { email: string; onSubmit?: (code: string, password: string) => void; onResend?: () => void; onBack?: () => void; look?: "card" | "site" }) {
  const [digits, setDigits] = useState<string[]>(SIX);
  const [password, setPassword] = useState("");
  const ready = digits.every((x) => x) && password.length > 0;
  const body = (
    <>
      <p className="auth-note auth-note-top">
        We sent a 6-digit code to <b>{email}</b>.
      </p>
      <ErrorLine error={error} />
      <form
        className="auth-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) onSubmit?.(digits.join(""), password);
        }}
      >
        <CodeBoxes digits={digits} setDigits={setDigits} />
        <input className="sr-only" type="email" name="email" autoComplete="username" value={email} readOnly tabIndex={-1} aria-hidden="true" />
        <label className="auth-field">
          <span>New password</span>
          <PasswordInput name="password" autoComplete="new-password" value={password} onChange={setPassword} />
        </label>
        <button className="btn auth-submit" type="submit" disabled={busy || !ready}>
          {busy ? "Saving…" : "Save and sign in"}
        </button>
      </form>
      <p className="auth-note">
        Nothing there? Check spam, or{" "}
        <button type="button" className="au-link" onClick={onResend} disabled={busy}>
          send a new code
        </button>
      </p>
      <p className="auth-note">
        <button type="button" className="au-link" onClick={onBack}>
          Back
        </button>
      </p>
    </>
  );
  if (look === "site") return <SiteShell title="Reset your password">{body}</SiteShell>;
  return (
    <AuthShell>
      <h1 className="auth-title">Reset your password</h1>
      {body}
    </AuthShell>
  );
}

/** A coach making their own account (17 Nov, Alex: B of docs/boards/coach-signup-mockup.html): Apple, Google, or an
 *  email and a password, the email then confirmed by a code. Who they are comes next (CoachDetailsScreen). */
export function CoachSignUpScreen({ onEmail, onApple, onGoogle, busy, error, askPassword = true }: Oauth & Busy & { onEmail?: (email: string, password: string) => void; askPassword?: boolean }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  return (
    <SiteShell title="Create your coach account" aside={<SignInLink />}>
      <ErrorLine error={error} />
      <Providers onApple={onApple} onGoogle={onGoogle} busy={busy} />
      <Or />
      {/* POST, as Sign in's (18 Nov): an early tap never puts the password in the address. */}
      <form
        className="auth-form"
        method="post"
        onSubmit={(e) => {
          e.preventDefault();
          if (email.trim() && (password || !askPassword)) onEmail?.(email.trim(), askPassword ? password : "");
        }}
      >
        <label className="auth-field">
          <span>Email</span>
          <input name="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
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
 * Right after signing up: who the coach is. The name comes filled in from
 * Apple or Google when they shared it. A plain form posting to the server
 * (finishCoachSignUpAction), which makes the account that waits for approval.
 */
export function CoachDetailsScreen({ action, name, email, error }: { action?: (formData: FormData) => void | Promise<void>; name: string; email: string; error?: string | null }) {
  return (
    <SiteShell title="About you">
      <p className="auth-note auth-note-top">
        Signed up as <b>{email}</b>. This is how you&rsquo;ll appear to your clients.
      </p>
      <ErrorLine error={error} />
      <form className="auth-form" action={action}>
        <label className="auth-field">
          <span>Your name</span>
          <input name="name" autoComplete="name" placeholder="Finlay Chedd" defaultValue={name} required maxLength={80} autoFocus={!name} />
        </label>
        <label className="auth-field">
          <span>Business name</span>
          <input name="business" autoComplete="organization" placeholder="Full Potential Coaching" maxLength={120} autoFocus={!!name} />
        </label>
        <button className="btn auth-submit" type="submit">
          Continue
        </button>
      </form>
    </SiteShell>
  );
}

/** Signed in, but this email has no Norcoach account. */
export function NoAccountScreen({ email, signOut }: { email: string; signOut?: ReactNode }) {
  return (
    <SiteShell title="No account yet">
      <p className="au-lead">
        There&rsquo;s no Norcoach account for <b>{email}</b>. If you train with a coach, ask them to invite you with this email. Coaching others yourself?{" "}
        <a href="/signup">Create a coach account</a>.
      </p>
      <p className="auth-note">{signOut ?? <a href="#">Use a different email</a>}</p>
    </SiteShell>
  );
}

/** Where the invite link lands: who invited them, then how they want to get in. */
export function InviteWelcomeScreen({
  firstName,
  email,
  coachName,
  coachPhoto,
  onAccept,
  onApple,
  onGoogle,
  busy,
  error,
}: Oauth & Busy & { firstName: string; email: string | null; coachName: string; coachPhoto: string | null; onAccept?: () => void }) {
  const coachFirst = coachName.split(" ")[0];
  return (
    <AuthShell>
      <div className="au-invite">
        <span className="au-coach" aria-hidden="true">
          {coachPhoto ? (
            // eslint-disable-next-line @next/next/no-img-element -- the coach's own upload, served by the app
            <img src={coachPhoto} alt="" />
          ) : (
            coachName.charAt(0).toUpperCase()
          )}
        </span>
        <h1 className="auth-title au-invite-title">
          {firstName}, {coachFirst} invited you
        </h1>
        <p className="au-lead">Your training, food and check-ins with {coachFirst}, in one app.</p>
      </div>
      <ErrorLine error={error} />
      <Providers onApple={onApple} onGoogle={onGoogle} busy={busy} />
      <Or />
      <form
        className="auth-form"
        onSubmit={(e) => {
          e.preventDefault();
          onAccept?.();
        }}
      >
        {email && (
          <label className="auth-field">
            <span>Email</span>
            <input name="email" type="email" value={email} readOnly />
          </label>
        )}
        <div id="clerk-captcha" />
        <button className="btn auth-submit" type="submit" disabled={busy}>
          {busy ? "One moment…" : "Continue with email"}
        </button>
      </form>
    </AuthShell>
  );
}

/** The client's invite email: from the coach by name, one button. */
export function InviteEmailScreen({ firstName, coachName, email }: { firstName: string; coachName: string; email: string }) {
  return (
    <div className="ob-mail">
      <div className="ob-mail-head">
        <span className="ob-mail-subject">{coachName} invited you to Norcoach</span>
        <span className="ob-mail-from">
          {coachName} &lt;hello@norcoach.app&gt; · to {email}
        </span>
      </div>
      <div className="ob-mail-body">
        <p>Hi {firstName},</p>
        <p>{coachName} has set you up on Norcoach, where your training, food and check-ins live.</p>
        <p>
          <a className="au-mail-btn" href="#">
            Accept the invite
          </a>
        </p>
        <p className="au-mail-small">The link works for 30 days. Questions? Just reply to this email and it goes to {coachName.split(" ")[0]}.</p>
      </div>
    </div>
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
