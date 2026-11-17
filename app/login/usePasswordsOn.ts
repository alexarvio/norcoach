"use client";

import { useEffect } from "react";
import { useAuth, useClerk } from "@clerk/nextjs";

type PasswordSetting = { userSettings?: { attributes?: { password?: { enabled?: boolean; required?: boolean } } } };

/**
 * Whether Clerk takes passwords: Dashboard, User & authentication, Password, "Sign-up with password" ON and "Require a
 * password at sign-up" OFF (17 Nov; off on the live instance until switched on). It must stay optional: required, every
 * client sign-up by invite or code stops at "Clerk wants one more step: password". Read from Clerk's own settings once
 * it has loaded; null while it can't tell, so a password field waits for a yes and never shows and then goes. Used by
 * sign-in, the coach sign-up and both Settings' Password (17 Nov, Alex: "Settings row").
 */
export function usePasswordsOn(): boolean | null {
  const clerk = useClerk();
  const { isLoaded } = useAuth();
  const env = (clerk as unknown as { __internal_environment?: PasswordSetting | null }).__internal_environment ?? (clerk as unknown as { environment?: PasswordSetting | null }).environment;
  const setting = isLoaded ? env?.userSettings?.attributes?.password : undefined;
  useEffect(() => {
    if (setting?.enabled && setting.required) console.error("Clerk requires a password at sign-up: client invites and code sign-ups can't finish. Turn off \"Require a password at sign-up\" in the Clerk Dashboard.");
  }, [setting?.enabled, setting?.required]);
  return typeof setting?.enabled === "boolean" ? setting.enabled : null;
}
