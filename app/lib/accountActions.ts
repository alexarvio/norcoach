"use server";

import { revalidatePath } from "next/cache";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { getSessionUser, requireCoach } from "./auth";
import { clerkOn } from "./clerk";
import { clearLoginFailures, isLoginLocked, recordLoginFailure } from "./loginLockout";

// Settings, Account & security (27 Oct, Alex): sign a device out, sign out everywhere else, and take a linked login
// (Google) off the account. Each acts on the signed-in person's own Clerk account only, and at once (no Save): the
// email stays a way in, so taking Google off never locks anyone out.

type Done = { ok: boolean; error?: string };

async function who() {
  const coach = await requireCoach();
  if (!clerkOn()) return null;
  const { userId, sessionId } = await auth();
  return userId ? { userId, sessionId, email: String(coach.email ?? "").trim().toLowerCase() } : null;
}

/** One device signed out (never this one: Sign out on the page does that). */
export async function signOutDeviceAction(id: string): Promise<Done> {
  const me = await who();
  if (!me) return { ok: false, error: "Signed out. Sign in again." };
  if (id === me.sessionId) return { ok: false, error: "That's this device." };
  try {
    const clerk = await clerkClient();
    const s = await clerk.sessions.getSession(id);
    if (s.userId !== me.userId) return { ok: false, error: "Not your device." };
    await clerk.sessions.revokeSession(id);
  } catch {
    return { ok: false, error: "Couldn't sign it out. Try again." };
  }
  revalidatePath("/admin/redesign/settings");
  return { ok: true };
}

/** Every other device signed out; this one stays. */
export async function signOutOtherDevicesAction(): Promise<Done> {
  const me = await who();
  if (!me) return { ok: false, error: "Signed out. Sign in again." };
  try {
    const clerk = await clerkClient();
    const list = await clerk.sessions.getSessionList({ userId: me.userId, status: "active", limit: 50 });
    await Promise.all(list.data.filter((s) => s.id !== me.sessionId).map((s) => clerk.sessions.revokeSession(s.id)));
  } catch {
    return { ok: false, error: "Couldn't sign them out. Try again." };
  }
  revalidatePath("/admin/redesign/settings");
  return { ok: true };
}

/** A linked login (Google) taken off the account, and the address it brought with it (1 Nov, Alex: a coach's Google
 *  was their own client login's address; left on the account, that address kept signing them in as the coach). The one
 *  the coach signs in with here stays, and becomes the primary when the Google one was. */
export async function disconnectLoginAction(externalAccountId: string): Promise<Done> {
  const me = await who();
  if (!me) return { ok: false, error: "Signed out. Sign in again." };
  try {
    const clerk = await clerkClient();
    const user = await clerk.users.getUser(me.userId);
    const account = user.externalAccounts.find((a) => a.id === externalAccountId);
    if (!account) return { ok: false, error: "Not on your account." };
    await clerk.users.deleteUserExternalAccount({ userId: me.userId, externalAccountId });
    const brought = String(account.emailAddress ?? "").trim().toLowerCase();
    const address = user.emailAddresses.find((e) => e.emailAddress.trim().toLowerCase() === brought);
    if (address && brought !== me.email) {
      try {
        // The primary moves first to another verified address the account keeps (the one it signs in with here).
        const keep = user.emailAddresses.find((e) => e.id !== address.id && e.verification?.status === "verified" && e.emailAddress.trim().toLowerCase() === me.email) ?? user.emailAddresses.find((e) => e.id !== address.id && e.verification?.status === "verified");
        if (address.id === user.primaryEmailAddressId && keep) await clerk.users.updateUser(me.userId, { primaryEmailAddressID: keep.id });
        if (address.id !== user.primaryEmailAddressId || keep) await clerk.emailAddresses.deleteEmailAddress(address.id);
      } catch {}
    }
  } catch {
    return { ok: false, error: "Couldn't disconnect it. Try again." };
  }
  revalidatePath("/admin/redesign/settings");
  return { ok: true };
}

/** The Clerk account behind whoever is signed in here, coach or client. */
async function signedInAccount(): Promise<{ userId: string } | null> {
  if (!clerkOn() || !(await getSessionUser())) return null;
  const { userId } = await auth();
  return userId ? { userId } : null;
}

/** Clerk's own sentence for what it refused (a password too short, one found in a breach). */
const clerkSays = (error: unknown): string | null => {
  const e = (error as { errors?: { longMessage?: string; message?: string }[] })?.errors?.[0];
  return e?.longMessage || e?.message || null;
};

/**
 * Settings' Password, the client's and the coach's (17 Nov, Alex: "Settings row"; everyone who signs in with an emailed
 * code can add one, and the code keeps working): sets the first password, or changes it with the current one checked
 * first. Through Clerk's server, so it never asks the person to prove who they are again in Clerk's own pop-up.
 */
export async function setPasswordAction(newPassword: string, currentPassword: string | null): Promise<Done> {
  const me = await signedInAccount();
  if (!me) return { ok: false, error: "Signed out. Sign in again." };
  const next = String(newPassword ?? "");
  if (!next) return { ok: false, error: "Type a password." };
  try {
    const clerk = await clerkClient();
    const user = await clerk.users.getUser(me.userId);
    if (user.passwordEnabled) {
      if (!currentPassword) return { ok: false, error: "Type your current password." };
      // Three wrong tries lock it for 15 minutes, as signing in does (loginLockout.ts), so a borrowed phone can't guess it.
      const tries = `settings:${me.userId}`;
      if (isLoginLocked(tries, "settings")) return { ok: false, error: "Too many tries. Try again in 15 minutes." };
      try {
        await clerk.users.verifyPassword({ userId: me.userId, password: String(currentPassword) });
      } catch {
        recordLoginFailure(tries, "settings");
        return { ok: false, error: "Your current password isn't right." };
      }
      clearLoginFailures(tries, "settings");
    }
    await clerk.users.updateUser(me.userId, { password: next });
  } catch (error) {
    return { ok: false, error: clerkSays(error) ?? "Not saved. Try again." };
  }
  return { ok: true };
}
