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
import { AccountEmail, pressSave, ThisDevice } from "./SettingsForms";
import { Fields, Line, OpenRow, Part, Pill, Row, State, Two, Word } from "./Rows";

// Settings, Account with the sign-in through Clerk (27 Oct, Alex: "only email, and that's it"; 23 Nov, Alex: rows, as
// docs/boards/settings-harmony-mockup.html): Email and password (the email, Change opening its line under its row;
// the password, Change or Add opening its fields there, once Clerk takes passwords) beside Linked logins (Google
// connected or Connect, Apple Soon while its button is off); then Devices (this one first, each other with Sign out on
// hover, Sign out everywhere else on the label). Each acts at once (lib/accountActions.ts), none on the Save bar.
// Two-step sign-in is left out: Clerk asks a paid plan for it.

const APPLE_ON = process.env.NEXT_PUBLIC_APPLE_SIGNIN !== "off";
const RETURN = "/settings#account";

/** When a device was last used, in the chat's words (`Active now`, `Active 2 h ago`, `Active 3/11`; lastActiveWords,
 *  16 Nov, Alex: the audit, no copy of its own). */
const lastSeen = (at: number) => lastActiveWords(new Date(at).toISOString());

export default function ClerkAccount({ email, security, passwordsHint = null }: { email: string; security: AccountSecurity | null; passwordsHint?: boolean | null }) {
  const [busy, start] = useTransition();
  const [gone, setGone] = useState<string[]>([]);
  const { user, isLoaded } = useUser();
  // The label says what the card holds (23 Nov, review): "Email and password" only while the Password row shows (Clerk
  // takes passwords and whether this account has one is known; the same test ClerkPassword draws by), else "Email".
  const passwords = usePasswordsOn(passwordsHint);
  const passwordKnown = user ? true : isLoaded ? false : (security?.hasPassword ?? null) !== null;
  const withPassword = passwords === true && passwordKnown;
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

  // Every Settings row one order (16 Nov, Alex: the audit): the hover words, then the state pill, then the resting action.
  const loginRow = (name: string, linked: { id: string; email: string } | null, can: boolean, strategy: "oauth_google" | "oauth_apple") => (
    <Row name={name} fact={linked?.email} hover={!!linked || can}>
      {linked ? (
        <>
          <Word tone="red" hoverOnly disabled={busy} onClick={() => act(() => disconnectLoginAction(linked.id), `${name} disconnected`)}>
            Disconnect
          </Word>
          <State tone="good">Connected</State>
        </>
      ) : can ? (
        <Word disabled={busy || !user} onClick={() => connect(strategy)}>
          Connect
        </Word>
      ) : (
        <State>Soon</State>
      )}
    </Row>
  );

  const deviceRow = (d: SignedInDevice) => (
    <Row key={d.id} name={d.device} fact={<SepJoin parts={[d.browser, d.place, d.current ? null : lastSeen(d.lastActive)]} />} hover>
      {d.current ? (
        <>
          <Word hoverOnly onClick={() => logoutAction()}>
            Sign out
          </Word>
          <State tone="good">This device</State>
        </>
      ) : (
        <Word hoverOnly disabled={busy} onClick={() => act(() => signOutDeviceAction(d.id), "Signed out", () => setGone((g) => [...g, d.id]))}>
          Sign out
        </Word>
      )}
    </Row>
  );

  const signIn = (
    <Part label={withPassword ? "Email and password" : "Email"}>
      <AccountEmail email={email} />
      <ClerkPassword email={email} passwordsHint={passwordsHint} hasPassword={security?.hasPassword ?? null} />
    </Part>
  );

  return (
    <>
      {security ? (
        <Two top>
          {signIn}
          <Part label="Linked logins">
            {loginRow("Google", google, true, "oauth_google")}
            {loginRow("Apple", apple, APPLE_ON, "oauth_apple")}
          </Part>
        </Two>
      ) : (
        signIn
      )}
      {security ? (
        <Part
          label="Devices"
          fact={String(devices.length)}
          action={
            others.length > 0 ? (
              <Pill disabled={busy} onClick={() => act(signOutOtherDevicesAction, "Signed out everywhere else", () => setGone((g) => [...g, ...others.map((d) => d.id)]))}>
                Sign out everywhere else
              </Pill>
            ) : undefined
          }
        >
          {devices.map(deviceRow)}
        </Part>
      ) : (
        <ThisDevice />
      )}
    </>
  );
}

/** Password (17 Nov, Alex: "Settings row"; 23 Nov: a row, its fields opening under it): a coach who signs in with an
 *  emailed code adds one here (`Not set`, Add) and can sign in with it after, the code still working; one who has one
 *  changes it (`Set`, Change), the current one checked first. Clerk gives no day it was set, so `Set` alone. Saved at
 *  once through Clerk's server (lib/accountActions.ts), not on the page's bar, as the email above. Drawn with the page
 *  (18 Nov, Alex: the password box came in a second late): whether Clerk takes passwords and whether this account has
 *  one are read by the server (`passwordsHint`, `hasPassword`), Clerk's own account in the browser winning once loaded. */
function ClerkPassword({ email, passwordsHint, hasPassword }: { email: string; passwordsHint: boolean | null; hasPassword: boolean | null }) {
  const passwords = usePasswordsOn(passwordsHint);
  const { isLoaded, user } = useUser();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState("");
  const has = user ? user.passwordEnabled : isLoaded ? null : hasPassword;
  if (passwords !== true || has === null) return null;
  const ready = !!next && (!has || !!current);
  const clear = () => (setCurrent(""), setNext(""), setError(""));
  const save = async () => {
    const r = await setPasswordAction(next, has ? current : null).catch(() => ({ ok: false, error: "Not saved. Try again." }));
    if (!r.ok) {
      setError(r.error ?? "Not saved. Try again.");
      return false;
    }
    await user?.reload().catch(() => {});
    clear();
    toast.success(has ? "Password changed" : "Password saved");
  };
  return (
    <OpenRow name="Password" fact={has ? "Set" : "Not set"} word={has ? "Change" : "Add"} onSave={save} onCancel={clear} canSave={ready} error={error}>
      {/* A form, so a password manager sees the account with it and Enter saves. */}
      <form onSubmit={(e) => (e.preventDefault(), ready && pressSave(e.currentTarget))}>
        <input className="sr-only" type="email" name="email" autoComplete="username" value={user?.primaryEmailAddress?.emailAddress ?? email} readOnly tabIndex={-1} aria-hidden="true" />
        <Fields cols={has ? 2 : 1}>
          {has && (
            <Line label="Current password">
              <input className="dlh-line" type="password" value={current} onChange={(e) => (setCurrent(e.target.value), setError(""))} autoComplete="current-password" />
            </Line>
          )}
          <Line label={has ? "New password" : "Password"}>
            <input className="dlh-line" type="password" value={next} onChange={(e) => (setNext(e.target.value), setError(""))} autoComplete="new-password" />
          </Line>
        </Fields>
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </OpenRow>
  );
}
