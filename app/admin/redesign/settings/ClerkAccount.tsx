"use client";

import { useState, useTransition } from "react";
import { useUser } from "@clerk/nextjs";
import { toast } from "sonner";
import { disconnectLoginAction, setPasswordAction, signOutDeviceAction, signOutOtherDevicesAction } from "../../../lib/accountActions";
import { usePasswordsOn } from "../../../login/usePasswordsOn";
import { logoutAction } from "../../../lib/auth-actions";
import type { AccountSecurity, SignedInDevice } from "../../../lib/accountSecurity";
import { lastActiveWords } from "../../../lib/lastActive";
import { SepJoin } from "../Sep";
import { AccountEmail, Field, Section } from "./SettingsForms";

// Settings, Account & security with the sign-in through Clerk (27 Oct, Alex: mockup B; "only email, and that's it"):
// Sign-in (the email, changed in place, then each login linked to it: Google connected or Connect, Apple Soon while its
// button is off) and Devices (where the account is signed in, this one first with Sign out, the others each with
// Sign out, and Sign out everywhere else in the head). Each acts at once (lib/accountActions.ts), none on the Save bar.
// Two-step sign-in is left out: Clerk asks a paid plan for it. Password (17 Nov, Alex: "Settings row") between them,
// once Clerk takes passwords: set one, or change it with the current one.

const APPLE_ON = process.env.NEXT_PUBLIC_APPLE_SIGNIN !== "off";
const RETURN = "/admin/redesign/settings#account";

/** When a device was last used, in the chat's words (`Active now`, `Active 2 h ago`, `Active 3/11`; lastActiveWords,
 *  16 Nov, Alex: the audit, no copy of its own). */
const lastSeen = (at: number) => lastActiveWords(new Date(at).toISOString());

export default function ClerkAccount({ email, security }: { email: string; security: AccountSecurity | null }) {
  const [busy, start] = useTransition();
  const [gone, setGone] = useState<string[]>([]);
  const { user } = useUser();
  const google = security?.logins.find((l) => l.provider === "google") ?? null;
  const apple = security?.logins.find((l) => l.provider === "apple") ?? null;
  const devices = (security?.devices ?? []).filter((d) => !gone.includes(d.id));
  const others = devices.filter((d) => !d.current);

  const act = (run: () => Promise<{ ok: boolean; error?: string }>, done: string, after?: () => void) =>
    start(async () => {
      const r = await run().catch(() => ({ ok: false, error: "Check your connection and try again." }));
      if (!r.ok) return void toast.error(r.error ?? "Didn't work");
      after?.();
      toast.success(done);
    });

  // Google linked from here: Clerk's own page, then back to this section.
  const connect = (strategy: "oauth_google" | "oauth_apple") =>
    start(async () => {
      try {
        const account = await user?.createExternalAccount({ strategy, redirectUrl: `${window.location.origin}${RETURN}` });
        const to = account?.verification?.externalVerificationRedirectURL;
        if (to) window.location.assign(to.toString());
        else toast.error("Couldn't start it. Try again.");
      } catch (e) {
        const said = (e as { errors?: { longMessage?: string; message?: string }[] })?.errors?.[0];
        toast.error(said?.longMessage ?? said?.message ?? "Couldn't start it. Try again.");
      }
    });

  const loginRow = (name: string, linked: { id: string; email: string } | null, can: boolean, strategy: "oauth_google" | "oauth_apple") => (
    <div className="rst-row">
      <span className="rst-row-main">
        <b>{name}</b>
        {linked?.email && <small>{linked.email}</small>}
      </span>
      {/* Every Settings row one order (16 Nov, Alex: the audit): the hover words, then the state pill, then the resting action. */}
      {linked ? (
        <>
          <button type="button" className="rst-danger rst-hover" disabled={busy} onClick={() => act(() => disconnectLoginAction(linked.id), `${name} disconnected`)}>
            Disconnect
          </button>
          <span className="trn-state good rst-state">Connected</span>
        </>
      ) : can ? (
        <button type="button" className="rst-act" disabled={busy || !user} onClick={() => connect(strategy)}>
          Connect
        </button>
      ) : (
        <span className="trn-state rst-state">Soon</span>
      )}
    </div>
  );

  const deviceRow = (d: SignedInDevice) => (
    <div className="rst-row" key={d.id}>
      <span className="rst-row-main">
        <b>{d.device}</b>
        <small>
          <SepJoin parts={[d.browser, d.place, d.current ? null : lastSeen(d.lastActive)]} />
        </small>
      </span>
      {d.current ? (
        <>
          <button type="button" className="rst-act rst-hover" onClick={() => logoutAction()}>
            Sign out
          </button>
          <span className="trn-state good rst-state">This device</span>
        </>
      ) : (
        <button type="button" className="rst-act rst-hover" disabled={busy} onClick={() => act(() => signOutDeviceAction(d.id), "Signed out", () => setGone((g) => [...g, d.id]))}>
          Sign out
        </button>
      )}
    </div>
  );

  return (
    <>
      <Section title="Sign-in">
        <div className="rls-card rst-card">
          <AccountEmail email={email} bare />
          {security && (
            <div className="rst-rows rst-rows-after">
              {loginRow("Google", google, true, "oauth_google")}
              {loginRow("Apple", apple, APPLE_ON, "oauth_apple")}
            </div>
          )}
        </div>
      </Section>
      <ClerkPassword />
      {security ? (
        <Section
          title="Devices"
          fact={String(devices.length)}
          actions={
            others.length > 0 ? (
              <button type="button" className="trn-pill rst-pill" disabled={busy} onClick={() => act(signOutOtherDevicesAction, "Signed out everywhere else", () => setGone((g) => [...g, ...others.map((d) => d.id)]))}>
                Sign out everywhere else
              </button>
            ) : undefined
          }
        >
          <div className="rls-card rst-card">
            <div className="rst-rows">{devices.map(deviceRow)}</div>
          </div>
        </Section>
      ) : (
        <Section
          title="This device"
          actions={
            <button type="button" className="trn-pill rst-pill" onClick={() => logoutAction()}>
              Sign out
            </button>
          }
        />
      )}
    </>
  );
}

/** Password (17 Nov, Alex: "Settings row"): a coach who signs in with an emailed code sets one here and can sign in
 *  with it after, the code still working; one who has one changes it, the current one checked first. Saved at once
 *  through Clerk's server (lib/accountActions.ts), not on the page's bar, as the email above. */
function ClerkPassword() {
  const passwords = usePasswordsOn();
  const { isLoaded, user } = useUser();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState("");
  const [busy, start] = useTransition();
  if (passwords !== true || !isLoaded || !user) return null;
  const has = user.passwordEnabled;
  const ready = !!next && (!has || !!current);
  const save = () =>
    start(async () => {
      const r = await setPasswordAction(next, has ? current : null).catch(() => ({ ok: false, error: "Not saved. Try again." }));
      if (!r.ok) return setError(r.error ?? "Not saved. Try again.");
      await user.reload().catch(() => {});
      setCurrent("");
      setNext("");
      setError("");
      toast.success(has ? "Password changed" : "Password saved");
    });
  return (
    <Section title="Password">
      <div className="rls-card rst-card">
        <form
          className="rst-grid"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready && !busy) save();
          }}
        >
          <input className="sr-only" type="email" name="email" autoComplete="username" value={user.primaryEmailAddress?.emailAddress ?? ""} readOnly tabIndex={-1} aria-hidden="true" />
          {has && (
            <Field label="Current password">
              <input className="dlh-line" type="password" value={current} onChange={(e) => (setCurrent(e.target.value), setError(""))} autoComplete="current-password" />
            </Field>
          )}
          <Field label={has ? "New password" : "Password"} wide={!has}>
            <input className="dlh-line" type="password" value={next} onChange={(e) => (setNext(e.target.value), setError(""))} autoComplete="new-password" />
          </Field>
          {(next || current) && (
            <div className="rst-foot wide">
              <span className="rst-err">{error}</span>
              <button type="submit" className="dlh-go" disabled={!ready || busy}>
                {busy ? "Saving…" : "Save"}
              </button>
            </div>
          )}
        </form>
      </div>
    </Section>
  );
}
