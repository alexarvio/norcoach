"use client";

import { useEffect } from "react";
import { useAuth, useClerk } from "@clerk/nextjs";

type PasswordSetting = { userSettings?: { attributes?: { password?: { enabled?: boolean; required?: boolean } } } };

/**
 * Whether Clerk takes passwords: Dashboard, User & authentication, Password, "Add password to account" ON and
 * "Sign-up with password" (its line: "Require users to sign up with a password") OFF (on the live instance since
 * 18 Nov). It must stay optional: required, every client sign-up by invite or code stops at "Clerk wants one more step:
 * password". `hint` is what the server read with the page (lib/clerkPasswords.ts, 18 Nov, Alex: the box came in a second
 * late), so the field is drawn with it; Clerk's own settings win once it has loaded. Null while neither can tell, so a
 * password field waits for a yes and never shows and then goes. Used by sign-in, the coach sign-up and both Settings'
 * Password (17 Nov, Alex: "Settings row").
 */
export function usePasswordsOn(hint: boolean | null = null): boolean | null {
  const clerk = useClerk();
  const { isLoaded } = useAuth();
  const env = (clerk as unknown as { __internal_environment?: PasswordSetting | null }).__internal_environment ?? (clerk as unknown as { environment?: PasswordSetting | null }).environment;
  const setting = isLoaded ? env?.userSettings?.attributes?.password : undefined;
  useEffect(() => {
    if (setting?.enabled && setting.required) console.error("Clerk requires a password at sign-up: client invites and code sign-ups can't finish. Turn off \"Sign-up with password\" in the Clerk Dashboard.");
  }, [setting?.enabled, setting?.required]);
  return typeof setting?.enabled === "boolean" ? setting.enabled : hint;
}
