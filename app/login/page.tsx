import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { NATIVE_COOKIE } from "../lib/quietLoad";
import type { InApp } from "./SignInScreens";
import { resetsAvailable } from "../lib/passwordReset";
import { ensureCoachFromEnv, ensureOwnerFromEnv, getSessionUser, resetCoachFromEnv, resetWorkspaceFromEnv } from "../lib/auth";
import { LoginCard } from "./AuthCards";
import { clerkIdentity, clerkOn } from "../lib/clerk";
import { passwordsOnHint } from "../lib/clerkPasswords";
import { SignInFlow } from "./ClerkFlows";
import ForgetKept from "./ForgetKept";

/** The phone app this page is in, from the app's own cookie (set before anything draws, lib/quietLoad.ts) and the phone's
 *  name, so the sign-in is drawn as the app shows it from the first frame (18 Nov). */
async function inApp(): Promise<InApp> {
  if ((await cookies()).get(NATIVE_COOKIE)?.value !== "1") return null;
  return /iPhone|iPad|iPod/.test((await headers()).get("user-agent") ?? "") ? "ios" : "android";
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; deleted?: string; reset?: string }>;
}) {
  // A fresh deployment has no accounts and no signup, so the very first
  // request to the login page is where the bootstrap coach gets created
  // from the environment. No-op once any coach exists.
  ensureCoachFromEnv();
  // The owner's login, from OWNER_EMAIL / OWNER_PASSWORD, once; see auth.ts.
  ensureOwnerFromEnv();
  // Lockout recovery: fires once per new COACH_RESET_TOKEN value, see auth.ts.
  resetCoachFromEnv();
  // Blank-canvas wipe: fires once per new WORKSPACE_RESET_TOKEN value, see auth.ts.
  // The chat's DELETE awaited with CHAT_STORE=pg (Step 5); a failure is said and the page still draws (tried again next time).
  await resetWorkspaceFromEnv().catch((error) => console.error("[workspace-reset] failed; tried again on the next sign-in page:", error instanceof Error ? error.message : error));

  // Already signed in? Send them where they belong rather than showing a
  // login form they'd have no reason to fill in.
  const user = await getSessionUser();
  if (user && !user.must_change_password) {
    redirect(user.role === "coach" ? "/admin/redesign" : "/client");
  }

  const { error, deleted, reset } = await searchParams;
  // Sign-in through Clerk (lib/clerk.ts).
  // Signed in to Clerk with no account of ours behind it: /auth/continue says
  // so (and offers another email), where this form would only answer
  // "You're already signed in".
  if (clerkOn() && (await clerkIdentity())) redirect("/auth/continue");
  // Signed out (every Sign out lands here): what this device kept for the last account goes, the coach's phone's chats
  // and where the client app was, so signing in lands on Home (ForgetKept).
  if (clerkOn())
    return (
      <>
        <ForgetKept />
        <SignInFlow notice={deleted ? "Your account and everything in it has been deleted." : null} passwordsHint={await passwordsOnHint()} app={await inApp()} />
      </>
    );
  return (
    <>
      <ForgetKept />
      <LoginCard error={error} deleted={deleted} reset={reset} canReset={resetsAvailable()} />
    </>
  );
}
