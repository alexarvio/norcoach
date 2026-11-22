import { redirect } from "next/navigation";
import { AuthenticateWithRedirectCallback } from "@clerk/nextjs";
import { clerkOn } from "../../lib/clerk";
import { inviteHref } from "../../invite/href";

// Back from Apple or Google on an invite (22 Nov): Clerk finishes the sign-in or the sign-up, then back to the invite
// itself, never /auth/continue: the invite checks the account is the invited address, and only then goes on into the
// app; another address is said there, never a stray account waiting on a coach's code. Under /sso-callback, which the
// iPhone app's universal links never claim, so the way back stays in the browser that went out (app/invite/href.ts).
//   /sso-callback/invite?c=12.ab34…&t=<ticket>
export const dynamic = "force-dynamic";

export default async function InviteCallbackPage({ searchParams }: { searchParams: Promise<{ c?: string; t?: string }> }) {
  if (!clerkOn()) redirect("/login");
  const { c, t } = await searchParams;
  const back = inviteHref(c, t);
  return <AuthenticateWithRedirectCallback signInForceRedirectUrl={back} signUpForceRedirectUrl={back} signInFallbackRedirectUrl={back} signUpFallbackRedirectUrl={back} />;
}
