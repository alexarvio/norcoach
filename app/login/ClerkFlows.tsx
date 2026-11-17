"use client";

import { useEffect, useState } from "react";
import { useAuth, useClerk } from "@clerk/nextjs";
import { useSignIn, useSignUp } from "@clerk/nextjs/legacy";
import { isClerkAPIResponseError } from "@clerk/nextjs/errors";
import { AuthShell, CodeScreen, CoachSignUpScreen, InviteWelcomeScreen, ResetPasswordScreen, SignInScreen } from "./SignInScreens";
import { callNative, nativePlatform } from "../lib/native";
import { leaveWithDarkClock } from "../client/NativeStatusBar";
import { usePasswordsOn } from "./usePasswordsOn";
import { isReviewEmail } from "../lib/reviewAccount";

// Clerk behind the sign-in screens (26 Sep). One way in for everyone: an
// email code, or Apple or Google. An email Clerk doesn't know yet (anyone
// from before the switch, a newly invited client) is signed up on the spot
// with the same code, so the person never has to know which it was. Since
// 17 Nov (Alex) a coach signing up by email sets a password, and an account
// with a password is asked for it after the email; the emailed code then
// confirms the address and, through Clerk's Client Trust, a new device.
// Whatever happens, the last stop is /auth/continue, which looks up our own
// account for them and sends them on (lib/clerk.ts links the two).

// Where sign-in goes on to, with the page they were sent here from (?next=, set by proxy.ts), so the coach phone app
// (/coach) comes back to itself and not to the admin (26 Oct, Alex).
const CONTINUE_BASE = "/auth/continue";
function continueUrl(): string {
  if (typeof window === "undefined") return CONTINUE_BASE;
  const next = new URLSearchParams(window.location.search).get("next");
  return next ? `${CONTINUE_BASE}?next=${encodeURIComponent(next)}` : CONTINUE_BASE;
}
const INTENT = "ironline_intent";

/** Clerk's own message for what went wrong, in a sentence. */
function says(error: unknown, fallback = "Something went wrong. Try again."): string {
  if (isClerkAPIResponseError(error)) {
    const e = error.errors[0];
    if (e?.code === "form_code_incorrect") return "That code isn't right. Check the email and try again.";
    if (e?.code === "verification_expired") return "That code has expired. Send a new one.";
    return e?.longMessage || e?.message || fallback;
  }
  return fallback;
}
const notFound = (error: unknown) => isClerkAPIResponseError(error) && error.errors.some((e) => e.code === "form_identifier_not_found");
const exists = (error: unknown) => isClerkAPIResponseError(error) && error.errors.some((e) => e.code === "form_identifier_exists");
const signedIn = (error: unknown) => isClerkAPIResponseError(error) && error.errors.some((e) => e.code === "session_exists");
/** A password tried on an account that has none (it signs in with a code). */
const noPassword = (error: unknown) => isClerkAPIResponseError(error) && error.errors.some((e) => e.code === "strategy_for_user_invalid" || e.code === "no_password_set");
/** Clerk refused a password because passwords aren't on for the instance. */
const passwordOff = (error: unknown) =>
  isClerkAPIResponseError(error) && error.errors.some((e) => (e.code === "form_param_unknown" || e.code === "form_param_value_disabled") && /password/i.test(`${e.meta?.paramName ?? ""} ${e.longMessage ?? ""}`));
/** The person closed the app's sign-in sheet (NorcoachAuth rejects with the code "cancelled"): nothing to say. */
const cancelled = (error: unknown) => (error as { code?: string } | null)?.code === "cancelled";

/** After Clerk says yes: a full page load, so the server sees the new session. */
// eslint-disable-next-line @next/next/no-location-assign-relative-destination -- a full load on purpose: the server must read the new session cookie
const land = () => {
  // The dark sign-in set the iPhone app's clock white (SiteShell, NativeStatusBar): the light screen it hands over to (the
  // coach app, the client app's loading paper, Subscribe) starts with a dark one again; a full load runs no cleanup.
  leaveWithDarkClock();
  window.location.assign(continueUrl());
};

/** The code screen's title for each step: a new account confirms its email; a new device after a password is one more
 *  check (Clerk's Client Trust), said by the title, not as an error. */
const titleOf = (via: string) => (via === "up" ? "Confirm your email" : via === "in2" ? "One more check" : "Check your email");

type SignInResource = Awaited<ReturnType<NonNullable<ReturnType<typeof useSignIn>["signIn"]>["create"]>>;
type SignUpResource = Awaited<ReturnType<NonNullable<ReturnType<typeof useSignUp>["signUp"]>["create"]>>;

/**
 * The email steps, shared by sign-in and coach sign-up. `sendCode` is a code to the address (signing in if Clerk knows
 * it, signing up if not), how everyone signed in before passwords and still can. `signInWithPassword` is the email and
 * password together (17 Nov, Alex: "the email and password combo for signing in"): an account with no password yet gets
 * the code instead. `forgotFor` a code and a new password. `signUpWithPassword` is the coach's: email and password, the
 * address then confirmed by a code (17 Nov, Alex: "if they go with the email, I want them to be able to create a password").
 */
function useEmailCode() {
  const { isLoaded: inLoaded, signIn, setActive } = useSignIn();
  const { isLoaded: upLoaded, signUp } = useSignUp();
  // "in": a code to sign in; "up": a code to confirm a new account's email; "in2": Clerk asked for a second code after
  // the first or after the password (a new device, Client Trust); "review": the App Review address, whose code is the
  // fixed one on the server (app/auth/review), no email sent; "reset": a code and a new password for a forgotten one.
  const [step, setStep] = useState<{ email: string; via: "in" | "up" | "in2" | "review" | "reset" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A fact over the code's own line (a password tried on an account that has none yet).
  const [note, setNote] = useState<string | null>(null);
  const ready = inLoaded && upLoaded;

  /** Where a sign-in stands after a step: in, or one more code to the same email, or what Clerk still wants named. */
  const finish = async (done: SignInResource | SignUpResource, email: string) => {
    if (done.status === "complete" && done.createdSessionId) {
      await setActive?.({ session: done.createdSessionId });
      land();
      return true;
    }
    // One more check (a sign-in from a new device, Clerk's Client Trust): a second code to the same email.
    if ("supportedSecondFactors" in done && (done.status === "needs_second_factor" || done.status === "needs_client_trust")) {
      const second = done.supportedSecondFactors?.find((f) => f.strategy === "email_code");
      if (second && "emailAddressId" in second) {
        await signIn!.prepareSecondFactor({ strategy: "email_code", emailAddressId: second.emailAddressId });
        setStep({ email, via: "in2" });
        // No error line: the code screen's own title says it (titleOf).
        return false;
      }
    }
    // Name what Clerk still wants (26 Oct: a live setting asked for more than the test one), so it can be switched off.
    const missing = "missingFields" in done && Array.isArray(done.missingFields) && done.missingFields.length ? `: ${done.missingFields.join(", ")}` : ` (${done.status})`;
    setError(`Almost: Clerk wants one more step${missing}. Tell the coach.`);
    return false;
  };

  /** A code to the address for the sign-in under way. */
  const codeFor = async (attempt: SignInResource, email: string) => {
    const factor = attempt.supportedFirstFactors?.find((f) => f.strategy === "email_code");
    if (!factor || !("emailAddressId" in factor)) throw new Error("no email code");
    await attempt.prepareFirstFactor({ strategy: "email_code", emailAddressId: factor.emailAddressId });
    setStep({ email, via: "in" });
  };

  /** A code to the address: signing in if Clerk knows it, signing up if not. `why` a fact for the code screen. */
  const sendCode = async (email: string, why: string | null = null) => {
    if (!ready) return;
    setNote(why);
    if (isReviewEmail(email)) {
      setError(null);
      setStep({ email, via: "review" });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await codeFor(await signIn.create({ identifier: email }), email);
    } catch (e) {
      // A session from earlier is still open in this browser: on into the app.
      if (signedIn(e)) return land();
      if (!notFound(e)) {
        setError(says(e));
        setBusy(false);
        return;
      }
      // Not in Clerk yet: the same code signs them up.
      try {
        await signUp.create({ emailAddress: email });
        await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
        setStep({ email, via: "up" });
      } catch (e2) {
        setError(says(e2));
      }
    }
    setBusy(false);
  };

  /** The email and its password together. An account with no password yet, or an email Clerk doesn't know, gets the
   *  code instead, as before passwords; a wrong password says so. */
  const signInWithPassword = async (email: string, pw: string) => {
    if (!ready) return;
    setNote(null);
    if (isReviewEmail(email)) return sendCode(email);
    setBusy(true);
    setError(null);
    try {
      const done = await signIn.create({ strategy: "password", identifier: email, password: pw });
      if (await finish(done, email)) return;
    } catch (e) {
      if (signedIn(e)) return land();
      // Not in Clerk yet: the account is made with the password typed, its email then confirmed by a code.
      if (notFound(e)) {
        setBusy(false);
        return signUpWithPassword(email, pw);
      }
      if (noPassword(e)) {
        setBusy(false);
        return sendCode(email, "No password on this account yet.");
      }
      setError(says(e));
    }
    setBusy(false);
  };

  /** Forgot password: a code to the address, then the code and a new password (ResetPasswordScreen). */
  const forgotFor = async (email: string) => {
    if (!ready) return;
    setNote(null);
    setBusy(true);
    setError(null);
    try {
      await signIn.create({ strategy: "reset_password_email_code", identifier: email });
      setStep({ email, via: "reset" });
    } catch (e) {
      if (signedIn(e)) return land();
      setError(notFound(e) ? "No account with this email." : noPassword(e) ? "No password on this account yet. Email me a code instead." : says(e, "Couldn't send a reset code. Try again."));
    }
    setBusy(false);
  };

  /** A new code for the step on screen, the same kind as the first. */
  const resend = async () => {
    if (!ready || !step) return;
    setBusy(true);
    setError(null);
    try {
      if (step.via === "up") await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
      else if (step.via === "in") await codeFor(signIn, step.email);
      else if (step.via === "in2") {
        const second = signIn.supportedSecondFactors?.find((f) => f.strategy === "email_code");
        if (second && "emailAddressId" in second) await signIn.prepareSecondFactor({ strategy: "email_code", emailAddressId: second.emailAddressId });
      } else if (step.via === "reset") await signIn.create({ strategy: "reset_password_email_code", identifier: step.email });
      // "review": the fixed code, nothing to send.
    } catch (e) {
      setError(says(e));
    }
    setBusy(false);
  };

  /** The reset code and the new password: the password is changed and they are signed in. */
  const reset = async (code: string, pw: string) => {
    if (!ready || !step) return;
    setBusy(true);
    setError(null);
    try {
      const done = await signIn.attemptFirstFactor({ strategy: "reset_password_email_code", code, password: pw });
      if (await finish(done, step.email)) return;
    } catch (e) {
      if (signedIn(e)) return land();
      setError(says(e));
    }
    setBusy(false);
  };

  /** A coach signing up by email: the account with its password, then a code to confirm the address. An email that has
   *  an account already (a sign-up left before About you, say) signs in with the password given instead. */
  const signUpWithPassword = async (email: string, pw: string) => {
    if (!ready) return;
    setNote(null);
    setBusy(true);
    setError(null);
    try {
      await signUp.create({ emailAddress: email, password: pw });
      await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
      setStep({ email, via: "up" });
    } catch (e) {
      if (signedIn(e)) return land();
      // Clerk took no password after all (switched off since the page loaded): the code alone, as before.
      if (passwordOff(e)) {
        setBusy(false);
        return sendCode(email);
      }
      if (!exists(e)) {
        setError(says(e));
        setBusy(false);
        return;
      }
      try {
        const done = await signIn.create({ strategy: "password", identifier: email, password: pw });
        if (await finish(done, email)) return;
      } catch {
        setError("This email has an account already. Sign in with it instead.");
      }
    }
    setBusy(false);
  };

  const verify = async (code: string) => {
    if (!ready || !step) return;
    setBusy(true);
    setError(null);
    if (step.via === "review") {
      try {
        const res = await fetch("/auth/review", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: step.email, code }) });
        const { ticket } = (await res.json().catch(() => ({}))) as { ticket?: string };
        if (!res.ok || !ticket) throw new Error(res.status === 429 ? "Too many tries. Wait an hour." : "That code isn't right. Check the email and try again.");
        const done = await signIn.create({ strategy: "ticket", ticket });
        if (done.status !== "complete" || !done.createdSessionId) throw new Error("Sign-in didn't finish. Try again.");
        await setActive({ session: done.createdSessionId });
        land();
        return;
      } catch (e) {
        if (signedIn(e)) return land();
        setError(isClerkAPIResponseError(e) ? says(e) : e instanceof Error ? e.message : "Something went wrong. Try again.");
        setBusy(false);
        return;
      }
    }
    try {
      const done =
        step.via === "in"
          ? await signIn.attemptFirstFactor({ strategy: "email_code", code })
          : step.via === "in2"
            ? await signIn.attemptSecondFactor({ strategy: "email_code", code })
            : await signUp.attemptEmailAddressVerification({ code });
      if (await finish(done, step.email)) return;
    } catch (e) {
      setError(says(e));
    }
    setBusy(false);
  };

  const oauth = (strategy: "oauth_apple" | "oauth_google") => {
    if (!ready) return;
    setBusy(true);
    // In the iPhone app (11 Nov, Alex): Google in Apple's secure sheet and back with a one-time ticket, Apple through its
    // own sheet; a web redirect would leave the app (Google refuses app web views).
    if (nativePlatform() === "ios") {
      (strategy === "oauth_google" ? googleInApp() : appleInApp()).catch((e) => {
        if (signedIn(e)) return land();
        if (cancelled(e)) {
          setBusy(false);
          return;
        }
        const fallback = strategy === "oauth_google" ? "Google sign-in didn't finish. Try again." : "Apple sign-in didn't finish. Try again.";
        setError(isClerkAPIResponseError(e) ? says(e, fallback) : e instanceof Error && e.message ? e.message : fallback);
        setBusy(false);
      });
      return;
    }
    // A Google or Apple account Clerk doesn't know yet is signed up on the way back.
    signIn.authenticateWithRedirect({ strategy, redirectUrl: "/sso-callback", redirectUrlComplete: continueUrl() }).catch((e) => {
      if (signedIn(e)) return land();
      setError(says(e));
      setBusy(false);
    });
  };

  /** Google in the app's secure sheet, PKCE-shaped (app/lib/nativeAuth.ts): the site sees only the secret's SHA-256, the
   *  sheet comes back on norcoach://auth with a one-time code, and the code and the secret together buy the ticket. */
  const googleInApp = async () => {
    if (!signIn || !setActive) throw new Error("Sign-in isn't ready yet. Try again.");
    const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const state = b64url(crypto.getRandomValues(new Uint8Array(24)));
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    const { url } = await callNative<{ url: string }>("NorcoachAuth", "openSignIn", { url: `${window.location.origin}/auth/native/start?provider=google&state=${state}&challenge=${challenge}` });
    const back = new URL(url).searchParams;
    const code = back.get("code");
    if (!code || back.get("state") !== state) throw new Error("Google sign-in didn't finish. Try again.");
    const res = await fetch("/auth/native/exchange", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, verifier }) });
    const { ticket } = (await res.json().catch(() => ({}))) as { ticket?: string };
    if (!res.ok || !ticket) throw new Error("Google sign-in didn't finish. Try again.");
    const done = await signIn.create({ strategy: "ticket", ticket });
    if (done.status !== "complete" || !done.createdSessionId) throw new Error("Sign-in didn't finish. Try again.");
    await setActive({ session: done.createdSessionId });
    land();
  };

  /** Sign in with Apple, natively: its identity token to Clerk, signing up an Apple account Clerk doesn't know yet. */
  const appleInApp = async () => {
    if (!signIn || !signUp || !setActive) throw new Error("Sign-in isn't ready yet. Try again.");
    const apple = await callNative<{ token: string; firstName?: string; lastName?: string }>("NorcoachAuth", "signInWithApple");
    const attempt = await signIn.create({ strategy: "oauth_token_apple", token: apple.token });
    if (attempt.status === "complete" && attempt.createdSessionId) {
      await setActive({ session: attempt.createdSessionId });
      land();
      return;
    }
    if (attempt.firstFactorVerification?.status === "transferable") {
      const made = await signUp.create({ transfer: true, ...(apple.firstName ? { firstName: apple.firstName } : {}), ...(apple.lastName ? { lastName: apple.lastName } : {}) });
      if (made.status === "complete" && made.createdSessionId) {
        await setActive({ session: made.createdSessionId });
        land();
        return;
      }
      const missing = made.missingFields?.length ? `: ${made.missingFields.join(", ")}` : ` (${made.status})`;
      throw new Error(`Almost: Clerk wants one more step${missing}. Tell the coach.`);
    }
    throw new Error("Apple sign-in didn't finish. Try again.");
  };

  // Busy only while something is on its way; before Clerk has loaded a tap simply waits.
  return { step, busy, error, note, sendCode, signInWithPassword, forgotFor, resend, verify, reset, signUpWithPassword, oauth, back: () => (setStep(null), setError(null), setNote(null)) };
}

/** /login: Apple, Google, or the email and its password together, or a code to the email (17 Nov, Alex), in the coach
 *  sign-up's dark frame, its code and reset screens too. */
export function SignInFlow({ notice }: { notice?: string | null }) {
  const f = useEmailCode();
  const passwords = usePasswordsOn();
  if (f.step?.via === "reset") return <ResetPasswordScreen email={f.step.email} look="site" onSubmit={f.reset} onResend={f.resend} onBack={f.back} busy={f.busy} error={f.error} />;
  if (f.step) return <CodeScreen key={f.step.via} email={f.step.email} title={titleOf(f.step.via)} note={f.note} look="site" onVerify={f.verify} onResend={f.resend} onBack={f.back} busy={f.busy} error={f.error} />;
  return (
    <SignInScreen
      passwords={passwords === true}
      onEmail={(email) => f.sendCode(email)}
      onPassword={f.signInWithPassword}
      onForgot={f.forgotFor}
      onApple={() => f.oauth("oauth_apple")}
      onGoogle={() => f.oauth("oauth_google")}
      busy={f.busy}
      error={f.error}
      notice={notice}
    />
  );
}


/**
 * /signup: a coach makes their own account. First only how they sign in; a
 * short-lived cookie tells /auth/continue this was a coach sign-up, and it
 * asks who they are next (/auth/coach-details), whichever way they came. The
 * password field shows once Clerk takes passwords; until then an email gets
 * a code alone, as before.
 */
export function CoachSignUpFlow() {
  const f = useEmailCode();
  const passwords = usePasswordsOn();
  const remember = () => {
    document.cookie = `${INTENT}=${encodeURIComponent(JSON.stringify({ coach: true }))}; path=/; max-age=3600; samesite=lax`;
  };
  // The coach sign-up's frame on every step (17 Nov, Alex: B); a second code on a sign-in that took over keeps it too.
  if (f.step) return <CodeScreen key={f.step.via} email={f.step.email} title={titleOf(f.step.via)} look="site" onVerify={f.verify} onResend={f.resend} onBack={f.back} busy={f.busy} error={f.error} />;
  return (
    <CoachSignUpScreen
      busy={f.busy}
      error={f.error}
      askPassword={passwords === true}
      onEmail={(email, password) => {
        remember();
        if (password) f.signUpWithPassword(email, password);
        else f.sendCode(email);
      }}
      onApple={() => {
        remember();
        f.oauth("oauth_apple");
      }}
      onGoogle={() => {
        remember();
        f.oauth("oauth_google");
      }}
    />
  );
}

/**
 * /invite: where a client's invite link lands. "Continue with email" uses the
 * ticket in the link, which already proves the address: no code to type.
 * Apple or Google work too, when that account has the same email.
 */
export function InviteFlow({ ticket, firstName, email, coachName, coachPhoto }: { ticket: string | null; firstName: string; email: string | null; coachName: string; coachPhoto: string | null }) {
  const { isLoaded: inLoaded, signIn, setActive } = useSignIn();
  const { isLoaded: upLoaded, signUp } = useSignUp();
  const code = useEmailCode();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = inLoaded && upLoaded;

  const accept = async () => {
    if (!ready) return;
    // No ticket (an old link, or opened twice): the email code instead.
    if (!ticket) {
      if (email) code.sendCode(email);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const done = await signUp.create({ strategy: "ticket", ticket });
      if (done.status === "complete" && done.createdSessionId) {
        await setActive({ session: done.createdSessionId });
        return land();
      }
      setError("Almost: Clerk wants one more step we don't ask for yet. Tell your coach.");
    } catch (e) {
      // Already has a Clerk account: the ticket signs them in instead.
      if (exists(e)) {
        try {
          const done = await signIn.create({ strategy: "ticket", ticket });
          if (done.status === "complete" && done.createdSessionId) {
            await setActive({ session: done.createdSessionId });
            return land();
          }
        } catch (e2) {
          setError(says(e2));
        }
      } else if (email) {
        // A used or expired ticket: fall back to a code to the same address.
        code.sendCode(email);
      } else {
        setError(says(e, "This invite link has expired. Ask your coach to send a new one."));
      }
    }
    setBusy(false);
  };

  if (code.step) return <CodeScreen key={code.step.via} email={code.step.email} title={titleOf(code.step.via)} onVerify={code.verify} onResend={code.resend} onBack={code.back} busy={code.busy} error={code.error} />;
  return (
    <InviteWelcomeScreen
      firstName={firstName}
      email={email}
      coachName={coachName}
      coachPhoto={coachPhoto}
      busy={busy || code.busy}
      error={error ?? code.error}
      onAccept={accept}
      onApple={() => code.oauth("oauth_apple")}
      onGoogle={() => code.oauth("oauth_google")}
    />
  );
}

/** /auth/signout: Clerk signs out in the browser, then the sign-in screen. */
export function SignOutNow({ to = "/login" }: { to?: string }) {
  const { signOut } = useClerk();
  const { isLoaded, isSignedIn } = useAuth();
  useEffect(() => {
    // Once Clerk has loaded: sign out if signed in, else straight on.
    if (!isLoaded) return;
    // Our own leftover goes too: the coach sign-up note.
    document.cookie = `${INTENT}=; path=/; max-age=0`;
    if (isSignedIn) signOut({ redirectUrl: to });
    else window.location.replace(to);
  }, [isLoaded, isSignedIn, signOut, to]);
  return (
    <AuthShell>
      <p className="au-lead">Signing out…</p>
    </AuthShell>
  );
}
